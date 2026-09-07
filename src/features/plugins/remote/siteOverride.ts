/**
 * Remote site override (plan §3): the `site` section of a published per-host
 * catalog file can replace the bundled adapter for that host, so a selector
 * or brand-colour fix reaches users without a release.
 *
 * Precedence is decided here, once, for every consumer (PluginHost, the brand
 * theme, the popup): a cached, valid, same-version site whose `matches` cover
 * the page wins; otherwise the registry's bundled adapter.
 */
import { logger } from '@/core/services/LoggerService';
import { EXTENSION_VERSION } from '@/core/utils/version';

import { matchesAnyPattern } from '../sites/matchPattern';
import type { SiteRegistry } from '../sites/registry';
import type { PluginSource, PluginSourceContext, SiteAdapter } from '../types';
import { isRemotePluginCatalogEnabledAtBuild } from './config';
import { loadHostCatalogCache, siteAdapterFromEntry } from './hostCatalogCache';

/** First site override any source offers for this context, or null. */
export async function resolveSiteOverride(
  sources: readonly PluginSource[],
  context: PluginSourceContext | undefined,
): Promise<SiteAdapter | null> {
  for (const source of sources) {
    if (!source.siteOverride) continue;
    try {
      const adapter = await source.siteOverride(context);
      if (adapter) return adapter;
    } catch (error) {
      logger.warn('Plugin source site override failed', {
        source: source.id,
        error: String(error),
      });
    }
  }
  return null;
}

/** The adapter for `url`: the override when it covers the page, else the bundled one. */
export function resolveSiteAdapterForUrl(
  url: string,
  registry: SiteRegistry,
  override: SiteAdapter | null,
): SiteAdapter | null {
  if (override && matchesAnyPattern(url, override.matches)) return override;
  return registry.resolveByUrl(url);
}

/**
 * Read the cached override for a host directly from storage (for consumers
 * that do not go through plugin sources, such as the brand theme and popup).
 */
export async function loadSiteOverrideForHost(
  host: string | undefined,
  extensionVersion: string = EXTENSION_VERSION,
): Promise<SiteAdapter | null> {
  if (!host || !isRemotePluginCatalogEnabledAtBuild()) return null;
  return siteAdapterFromEntry(await loadHostCatalogCache(host), extensionVersion);
}

/** Two adapters describe the same site when their data is identical. */
export function isSameSiteAdapter(a: SiteAdapter | null, b: SiteAdapter | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.brandColor === b.brandColor &&
    a.conversationIdPattern === b.conversationIdPattern &&
    JSON.stringify(a.matches) === JSON.stringify(b.matches) &&
    JSON.stringify(a.selectors) === JSON.stringify(b.selectors) &&
    JSON.stringify(a.theme) === JSON.stringify(b.theme) &&
    JSON.stringify([...a.capabilities].sort()) === JSON.stringify([...b.capabilities].sort())
  );
}
