/**
 * Storage-backed cache of the remote plugin catalog, ONE ENTRY PER HOST.
 *
 * Key: `StorageKeys.PLUGIN_HOST_CATALOG_PREFIX + host` in `chrome.storage.local`.
 * The background refresher is the only writer; content scripts and the popup
 * read it and subscribe to content changes. Bookkeeping writes (an attempt
 * that failed, or succeeded with identical content) must NOT wake subscribers:
 * a content-script reload on every attempt would remount plugin CSS for
 * nothing, and — as the retired marketplace cache once did — could feed back
 * into another refresh.
 *
 * Content scripts use `chrome.storage` directly per the content-script rules.
 */
import { logger } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { validateManifest } from '../manifest/validate';
import type { PluginManifest } from '../types';

/**
 * `ok`      a valid catalog file was fetched; `manifests` is the truth for the host.
 * `missing` the server answered 404: no catalog exists for this host. Treated
 *           like "no remote information" — the bundled snapshot stays in force.
 * `unknown` no successful fetch yet (only failed attempts recorded).
 */
export type HostCatalogStatus = 'ok' | 'missing' | 'unknown';

export interface HostCatalogCacheEntry {
  readonly host: string;
  readonly status: HostCatalogStatus;
  readonly manifests: readonly PluginManifest[];
  /** Time of the last successful fetch (ok or missing); 0 when none yet. */
  readonly fetchedAt: number;
  /** Time of the last attempt, successful or not; drives the check interval. */
  readonly lastAttemptAt: number;
  /** Consecutive failed attempts; 0 after any success. Drives backoff. */
  readonly failureCount: number;
  /** Extension version that wrote the entry. A mismatch expires the entry. */
  readonly extensionVersion: string;
  /** `generatedAt` reported by the server for the cached content, when known. */
  readonly generatedAt?: string;
}

const PREFIX = StorageKeys.PLUGIN_HOST_CATALOG_PREFIX;

export function hostCatalogStorageKey(host: string): string {
  return `${PREFIX}${host}`;
}

export function isHostCatalogStorageKey(key: string): boolean {
  return key.startsWith(PREFIX) && key.length > PREFIX.length;
}

function localArea(): chrome.storage.LocalStorageArea | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Re-validate a stored entry. Storage can hold anything (older shapes, a
 * corrupted write, a Drive restore that was never meant to carry it), so a
 * manifest that no longer passes the validator is dropped rather than trusted.
 */
export function normalizeHostCatalogCacheEntry(
  raw: unknown,
  host: string,
): HostCatalogCacheEntry | null {
  if (!isRecord(raw)) return null;
  if (raw.host !== host) return null;
  const status: HostCatalogStatus =
    raw.status === 'ok' || raw.status === 'missing' ? raw.status : 'unknown';
  const manifests: PluginManifest[] = [];
  if (Array.isArray(raw.manifests)) {
    for (const entry of raw.manifests) {
      const result = validateManifest(entry);
      if (result.success) manifests.push(result.data);
    }
  }
  return {
    host,
    status,
    manifests: status === 'ok' ? manifests : [],
    fetchedAt: finiteNumber(raw.fetchedAt),
    lastAttemptAt: finiteNumber(raw.lastAttemptAt),
    failureCount: Math.max(0, Math.floor(finiteNumber(raw.failureCount))),
    extensionVersion: typeof raw.extensionVersion === 'string' ? raw.extensionVersion : '',
    ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
  };
}

export async function loadHostCatalogCache(host: string): Promise<HostCatalogCacheEntry | null> {
  const local = localArea();
  if (!local) return null;
  const key = hostCatalogStorageKey(host);
  try {
    const result = await local.get({ [key]: null });
    return normalizeHostCatalogCacheEntry(result?.[key], host);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('loadHostCatalogCache failed', { host, error: String(error) });
    }
    return null;
  }
}

export async function saveHostCatalogCache(entry: HostCatalogCacheEntry): Promise<void> {
  const local = localArea();
  if (!local) return;
  try {
    await local.set({ [hostCatalogStorageKey(entry.host)]: entry });
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('saveHostCatalogCache failed', { host: entry.host, error: String(error) });
    }
  }
}

/**
 * Stable signature of what a cached entry CONTRIBUTES to the plugin list:
 * status, writer version and manifests. Attempt timestamps and failure counts
 * are excluded on purpose (see the module comment).
 */
export function hostCatalogSignature(raw: unknown): string {
  if (!isRecord(raw)) return '';
  try {
    return JSON.stringify({
      status: raw.status,
      extensionVersion: raw.extensionVersion,
      manifests: raw.status === 'ok' ? raw.manifests : [],
    });
  } catch {
    return '';
  }
}

/**
 * Fire `callback` when the cached catalog for `host` changes CONTENT (a
 * different plugin set, a status flip, or a rewrite by a new extension
 * version). Bookkeeping-only writes are ignored.
 */
export interface SubscribeHostCatalogOptions {
  /**
   * Also fire for attempt bookkeeping (lastAttemptAt / failureCount) writes.
   * The host runtime wants content changes only; the popup's "last checked"
   * line needs every write.
   */
  readonly includeBookkeeping?: boolean;
}

export function subscribeHostCatalog(
  host: string,
  callback: () => void,
  options: SubscribeHostCatalogOptions = {},
): () => void {
  const onChanged = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.onChanged;
  if (!onChanged) return () => {};
  const key = hostCatalogStorageKey(host);
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[key]) return;
    const change = changes[key];
    if (
      options.includeBookkeeping ||
      hostCatalogSignature(change.oldValue) !== hostCatalogSignature(change.newValue)
    )
      callback();
  };
  onChanged.addListener(listener);
  return () => {
    try {
      onChanged.removeListener(listener);
    } catch {
      // ignore — context may be gone
    }
  };
}
