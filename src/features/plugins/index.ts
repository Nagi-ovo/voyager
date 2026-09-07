/**
 * Plugin ecosystem — public entry point.
 *
 * `startPluginHost()` is the single integration call for the content script. It
 * is safe to call on any injected site: it self-detects the site adapter and
 * only mounts plugins that match the current URL, are enabled, and are entitled.
 * It is INERT by default because all builtin plugins ship disabled.
 */
import { logger } from '@/core/services/LoggerService';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { PluginHost } from './runtime/PluginHost';
import { PLUGIN_STATUS_MESSAGE } from './runtime/messages';

export { PluginHost } from './runtime/PluginHost';
export type { PluginHostOptions } from './runtime/PluginHost';
export { DeclarativeEngine } from './runtime/declarativeEngine';
export { SiteRegistry, DEFAULT_ADAPTERS } from './sites/registry';
export { matchesUrl, matchesAnyPattern } from './sites/matchPattern';
export { validateManifest } from './manifest/validate';
export type { ManifestIssue } from './manifest/validate';
export type { PluginStatus, PluginStatusKind } from './runtime/pluginStatus';
export { PRIMITIVE_CONTRACTS, getPrimitiveContract } from './verbs/contracts';
export type { PrimitiveContract } from './verbs/contracts';
export { loadPluginState, setPluginEnabled, subscribePluginState } from './storage/pluginState';
export { HostCatalogSource, HOST_CATALOG_SOURCE_ID } from './remote/HostCatalogSource';
export {
  loadHostCatalogCache,
  subscribeHostCatalog,
  hostCatalogStorageKey,
} from './remote/hostCatalogCache';
export type { HostCatalogCacheEntry, HostCatalogStatus } from './remote/hostCatalogCache';
export {
  loadPluginCatalogSettings,
  savePluginCatalogSettings,
  subscribePluginCatalogSettings,
} from './remote/hostCatalogSettings';
export type { PluginCatalogSettings } from './remote/hostCatalogSettings';
export {
  PLUGIN_CATALOG_CHECK_INTERVALS,
  catalogHostFromUrl,
  hasEnabledPluginForUrl,
} from './remote/hostCatalogPolicy';
export type { PluginCatalogCheckInterval } from './remote/hostCatalogPolicy';
export { BUILTIN_PLUGINS } from './builtin';
export {
  createDefaultPluginSources,
  dedupeManifestsById,
  listPluginManifests,
  listPluginManifestsWithSources,
  refreshPluginManifests,
  refreshPluginManifestsWithSources,
} from './sources/defaultSources';
export type { BlockedPluginUpdate, SourcedPluginManifest } from './sources/defaultSources';
export * from './types';

let host: PluginHost | null = null;

/**
 * Debug: dump every scope-based plugin's live side-effect ledger. From the
 * page console (extension context in DevTools):
 *   document.dispatchEvent(new Event('gv:debug:pluginScopes'))
 */
export const PLUGIN_SCOPES_DEBUG_EVENT = 'gv:debug:pluginScopes';

const dumpScopeLedgers = (): void => {
  logger.info('Plugin scope ledgers', host?.getScopeLedgers() ?? {});
};

/** Popup asks the page for plugin statuses (plan §4.2); answered synchronously. */
const onStatusRequest = (
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): void => {
  if ((message as { type?: string } | null)?.type !== PLUGIN_STATUS_MESSAGE) return;
  sendResponse({ ok: true, statuses: host?.getStatuses() ?? [] });
};

export function startPluginHost(): () => void {
  if (host) return () => {};
  try {
    host = new PluginHost();
    void host.start();
    document.addEventListener(PLUGIN_SCOPES_DEBUG_EVENT, dumpScopeLedgers);
    chrome.runtime?.onMessage?.addListener(onStatusRequest);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.error('startPluginHost failed', { error: String(error) });
    }
  }
  return () => {
    document.removeEventListener(PLUGIN_SCOPES_DEBUG_EVENT, dumpScopeLedgers);
    try {
      chrome.runtime?.onMessage?.removeListener(onStatusRequest);
    } catch {
      // context may be gone
    }
    host?.stop();
    host = null;
  };
}
