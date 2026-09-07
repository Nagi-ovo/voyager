/**
 * HostCatalogRefresher — the ONLY network writer for the remote plugin catalog.
 *
 * Runs in the background. A content script or the popup sends
 * `PLUGIN_CATALOG_REFRESH_MESSAGE { host, force }`; this class decides whether
 * a request is due and, if so, fetches `<base>/hosts/<host>.json` at most once
 * per host at a time (single flight across every open tab), validates it and
 * writes the per-host cache entry.
 *
 * Gates, in order (a manual `force` skips all but the first):
 *   1. build flag          — a build compiled without the remote channel never fetches;
 *   2. host shape          — only plain hostnames get a file name;
 *   3. user settings       — online-update switch, check interval, failure backoff,
 *                            writer-version staleness (hostCatalogPolicy);
 *   4. page eligibility    — at least one ENABLED plugin (bundled or already
 *                            cached remote) targets the host. Gemini / AI Studio
 *                            never pass this gate, so they produce zero requests.
 *
 * Privacy: the request carries no cookies, no extension identifier and no
 * page content — only the host name in the path.
 */
import { logger } from '@/core/services/LoggerService';
import { EXTENSION_VERSION } from '@/core/utils/version';

import { listPluginManifests } from '../sources/defaultSources';
import { loadPluginState } from '../storage/pluginState';
import { isRemotePluginCatalogEnabledAtBuild, resolvePluginCatalogBaseUrl } from './config';
import {
  type HostCatalogCacheEntry,
  hostCatalogSignature,
  loadHostCatalogCache,
  saveHostCatalogCache,
} from './hostCatalogCache';
import { validateHostCatalogFile } from './hostCatalogFile';
import {
  decideHostCatalogRefresh,
  hasEnabledPluginForHost,
  hostCatalogFileUrl,
  isEligibleCatalogHost,
} from './hostCatalogPolicy';
import { type PluginCatalogSettings, loadPluginCatalogSettings } from './hostCatalogSettings';

export type HostCatalogRefreshStatus =
  | 'updated'
  | 'unchanged'
  | 'missing'
  | 'failed'
  | 'skipped'
  | 'ineligible'
  | 'invalid-host'
  | 'disabled';

export interface HostCatalogRefreshResult {
  readonly ok: true;
  readonly status: HostCatalogRefreshStatus;
  /** Skip reason or error text; diagnostic only. */
  readonly reason?: string;
  readonly checkedAt?: number;
}

export interface HostCatalogRefreshOptions {
  readonly force?: boolean;
}

export interface HostCatalogRefresherOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly extensionVersion?: string;
  readonly enabled?: boolean;
  readonly loadSettings?: () => Promise<PluginCatalogSettings>;
  readonly loadEntry?: (host: string) => Promise<HostCatalogCacheEntry | null>;
  readonly saveEntry?: (entry: HostCatalogCacheEntry) => Promise<void>;
  readonly isHostEligible?: (host: string, entry: HostCatalogCacheEntry | null) => Promise<boolean>;
  /** Bound on one fetch including body parsing; defaults to 15 s. */
  readonly timeoutMs?: number;
}

/**
 * Default page-eligibility check: an enabled plugin from the bundled snapshot
 * or from the host's own cached remote catalog targets `https://<host>/`.
 */
export async function defaultIsHostEligible(
  host: string,
  entry: HostCatalogCacheEntry | null,
): Promise<boolean> {
  const [snapshot, state] = await Promise.all([listPluginManifests(), loadPluginState()]);
  const manifests = entry?.status === 'ok' ? [...snapshot, ...entry.manifests] : snapshot;
  return hasEnabledPluginForHost(manifests, state, host);
}

/** A request that neither settles nor aborts would pin its host in `inFlight` forever. */
export const DEFAULT_HOST_CATALOG_TIMEOUT_MS = 15_000;

export class HostCatalogRefresher {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly extensionVersion: string;
  private readonly enabled: boolean;
  private readonly loadSettings: () => Promise<PluginCatalogSettings>;
  private readonly loadEntry: (host: string) => Promise<HostCatalogCacheEntry | null>;
  private readonly saveEntry: (entry: HostCatalogCacheEntry) => Promise<void>;
  private readonly isHostEligible: (
    host: string,
    entry: HostCatalogCacheEntry | null,
  ) => Promise<boolean>;
  private readonly inFlight = new Map<string, Promise<HostCatalogRefreshResult>>();
  private readonly timeoutMs: number;

  constructor(options: HostCatalogRefresherOptions = {}) {
    this.baseUrl = options.baseUrl ?? resolvePluginCatalogBaseUrl();
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.extensionVersion = options.extensionVersion ?? EXTENSION_VERSION;
    this.enabled = options.enabled ?? isRemotePluginCatalogEnabledAtBuild();
    this.loadSettings = options.loadSettings ?? loadPluginCatalogSettings;
    this.loadEntry = options.loadEntry ?? loadHostCatalogCache;
    this.saveEntry = options.saveEntry ?? saveHostCatalogCache;
    this.isHostEligible = options.isHostEligible ?? defaultIsHostEligible;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HOST_CATALOG_TIMEOUT_MS;
  }

  /** Single flight per host: concurrent callers share one network pass. */
  refresh(
    host: string,
    options: HostCatalogRefreshOptions = {},
  ): Promise<HostCatalogRefreshResult> {
    const normalized = typeof host === 'string' ? host.trim().toLowerCase() : '';
    if (!this.enabled) return Promise.resolve({ ok: true, status: 'disabled' });
    if (!isEligibleCatalogHost(normalized))
      return Promise.resolve({ ok: true, status: 'invalid-host' });

    const existing = this.inFlight.get(normalized);
    if (existing) return existing;
    const pass = this.perform(normalized, options.force === true).finally(() => {
      this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, pass);
    return pass;
  }

  private async perform(host: string, force: boolean): Promise<HostCatalogRefreshResult> {
    const entry = await this.loadEntry(host);
    if (!force) {
      const settings = await this.loadSettings();
      const decision = decideHostCatalogRefresh({
        entry,
        now: this.now(),
        onlineUpdatesEnabled: settings.onlineUpdatesEnabled,
        interval: settings.checkInterval,
        extensionVersion: this.extensionVersion,
      });
      if (!decision.refresh) return { ok: true, status: 'skipped', reason: decision.reason };
      if (!(await this.isHostEligible(host, entry))) return { ok: true, status: 'ineligible' };
    }

    const now = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.fetchAndStore(host, entry, now, controller.signal), timeout]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Host catalog refresh failed', { host, error: reason });
      // Keep whatever the previous entry contributed; only record the attempt.
      await this.saveEntry({
        host,
        status: entry?.status ?? 'unknown',
        manifests: entry?.status === 'ok' ? entry.manifests : [],
        fetchedAt: entry?.fetchedAt ?? 0,
        lastAttemptAt: now,
        failureCount: (entry?.failureCount ?? 0) + 1,
        extensionVersion: entry?.extensionVersion || this.extensionVersion,
        ...(entry?.generatedAt ? { generatedAt: entry.generatedAt } : {}),
      });
      return { ok: true, status: 'failed', reason, checkedAt: now };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The network half of a pass; `signal` lets the timeout abort the request. */
  private async fetchAndStore(
    host: string,
    entry: HostCatalogCacheEntry | null,
    now: number,
    signal: AbortSignal,
  ): Promise<HostCatalogRefreshResult> {
    const response = await this.fetchImpl(hostCatalogFileUrl(this.baseUrl, host), {
      cache: 'no-cache',
      credentials: 'omit',
      redirect: 'follow',
      signal,
    });
    if (response.status === 404) {
      await this.saveEntry({
        host,
        status: 'missing',
        manifests: [],
        fetchedAt: now,
        lastAttemptAt: now,
        failureCount: 0,
        extensionVersion: this.extensionVersion,
      });
      return { ok: true, status: 'missing', checkedAt: now };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const validation = validateHostCatalogFile(await response.json(), host);
    if (!validation) throw new Error('Unrecognized host catalog file');
    if (validation.issues.length > 0) {
      logger.warn('Host catalog: skipped invalid plugin entries', {
        host,
        issues: validation.issues,
      });
    }
    const next: HostCatalogCacheEntry = {
      host,
      status: 'ok',
      manifests: validation.manifests,
      fetchedAt: now,
      lastAttemptAt: now,
      failureCount: 0,
      extensionVersion: this.extensionVersion,
      ...(validation.generatedAt ? { generatedAt: validation.generatedAt } : {}),
    };
    const changed = hostCatalogSignature(entry) !== hostCatalogSignature(next);
    await this.saveEntry(next);
    return { ok: true, status: changed ? 'updated' : 'unchanged', checkedAt: now };
  }
}

/** Parse the runtime message payload; rejects anything but a plain host string. */
export function parseHostCatalogRefreshPayload(
  payload: unknown,
): { host: string; force: boolean } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const host = (payload as { host?: unknown }).host;
  if (typeof host !== 'string') return null;
  return { host, force: (payload as { force?: unknown }).force === true };
}
