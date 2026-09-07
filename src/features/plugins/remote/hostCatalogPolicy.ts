/**
 * Pure decision rules for the per-host remote plugin catalog.
 *
 * Everything the background and content script need to agree on lives here
 * without touching storage or the network, so each rule has a direct test:
 *   - which hosts may ever be looked up (no wildcards, no ports, plain hostnames);
 *   - when a page is allowed to trigger a check (an enabled plugin targets it);
 *   - when a check is due (interval since the last ATTEMPT, plus failure backoff);
 *   - when a cached catalog may be used at all (successful fetch by this
 *     extension version).
 */
import { matchesAnyPattern } from '../sites/matchPattern';
import type { PluginStateMap } from '../storage/pluginState';
import type { PluginManifest } from '../types';
import type { HostCatalogCacheEntry } from './hostCatalogCache';

export const PLUGIN_CATALOG_CHECK_INTERVALS = ['1h', '6h', '24h', 'manual'] as const;
export type PluginCatalogCheckInterval = (typeof PLUGIN_CATALOG_CHECK_INTERVALS)[number];
export const DEFAULT_PLUGIN_CATALOG_CHECK_INTERVAL: PluginCatalogCheckInterval = '6h';

const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS: Readonly<Record<PluginCatalogCheckInterval, number | null>> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  manual: null,
};

/** Same curve as the announcement feed: 30 min, doubling, capped at 24 h. */
export const HOST_CATALOG_BACKOFF_BASE_MS = 30 * 60 * 1000;
export const HOST_CATALOG_BACKOFF_MAX_MS = 24 * HOUR_MS;

export function normalizeCheckInterval(value: unknown): PluginCatalogCheckInterval {
  return typeof value === 'string' &&
    (PLUGIN_CATALOG_CHECK_INTERVALS as readonly string[]).includes(value)
    ? (value as PluginCatalogCheckInterval)
    : DEFAULT_PLUGIN_CATALOG_CHECK_INTERVAL;
}

/** Milliseconds between automatic checks, or null for manual-only. */
export function checkIntervalMs(interval: PluginCatalogCheckInterval): number | null {
  return CHECK_INTERVAL_MS[interval];
}

export function hostCatalogBackoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return Math.min(
    HOST_CATALOG_BACKOFF_MAX_MS,
    HOST_CATALOG_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
  );
}

/**
 * A host we can name a catalog file for: lowercase DNS labels only. Wildcard
 * frame origins (`*.frame.claudeusercontent.com`), ports, IPs in brackets and
 * anything with a path are rejected so the file name is a plain
 * `<host>.json` and per-artifact frame subdomains never cause a lookup each.
 */
export function isEligibleCatalogHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  )
    return false;
  return true;
}

/** `location.host` of a page URL when it is a catalog-eligible https host. */
export function catalogHostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.port) return undefined;
    const host = parsed.hostname.toLowerCase();
    return isEligibleCatalogHost(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Path of the per-host file below the catalog base URL. */
export function hostCatalogFileUrl(baseUrl: string, host: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/hosts/${encodeURIComponent(host)}.json`;
}

/**
 * D4 trigger: a page may ask for a catalog check only when at least one
 * ENABLED plugin targets it. Gemini / AI Studio have no plugins, so they never
 * qualify and never produce a request.
 */
export function hasEnabledPluginForUrl(
  manifests: readonly PluginManifest[],
  state: PluginStateMap,
  url: string,
): boolean {
  return manifests.some(
    (manifest) => state[manifest.id]?.enabled === true && matchesAnyPattern(url, manifest.matches),
  );
}

/** A cached catalog may replace the bundled snapshot only when this holds (D6). */
export function isHostCatalogEntryUsable(
  entry: HostCatalogCacheEntry | null | undefined,
  extensionVersion: string,
): entry is HostCatalogCacheEntry {
  return !!entry && entry.status === 'ok' && entry.extensionVersion === extensionVersion;
}

export type HostCatalogRefreshSkipReason = 'disabled' | 'manual-only' | 'fresh' | 'backoff';

export interface HostCatalogRefreshDecisionInput {
  readonly entry: HostCatalogCacheEntry | null | undefined;
  readonly now: number;
  readonly onlineUpdatesEnabled: boolean;
  readonly interval: PluginCatalogCheckInterval;
  readonly extensionVersion: string;
}

export type HostCatalogRefreshDecision =
  | { readonly refresh: true }
  | { readonly refresh: false; readonly reason: HostCatalogRefreshSkipReason };

/**
 * Whether an AUTOMATIC check is due. The interval counts from the last
 * attempt, successful or not (D4); consecutive failures add exponential
 * backoff (D19); an entry written by another extension version is stale
 * regardless of age (D6). Manual checks bypass this entirely.
 */
export function decideHostCatalogRefresh(
  input: HostCatalogRefreshDecisionInput,
): HostCatalogRefreshDecision {
  if (!input.onlineUpdatesEnabled) return { refresh: false, reason: 'disabled' };
  const intervalMs = checkIntervalMs(input.interval);
  if (intervalMs === null) return { refresh: false, reason: 'manual-only' };

  const entry = input.entry;
  if (!entry) return { refresh: true };

  const backoff = hostCatalogBackoffMs(entry.failureCount);
  if (backoff > 0 && input.now < entry.lastAttemptAt + backoff) {
    return { refresh: false, reason: 'backoff' };
  }
  if (entry.extensionVersion !== input.extensionVersion) return { refresh: true };
  if (input.now - entry.lastAttemptAt < intervalMs) return { refresh: false, reason: 'fresh' };
  return { refresh: true };
}
