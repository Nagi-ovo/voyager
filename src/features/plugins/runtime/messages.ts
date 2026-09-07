export const PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE = 'gv.plugins.syncContentScripts';

/**
 * Ask the background to refresh the remote plugin catalog for one host.
 * Payload: `{ host: string; force?: boolean }`. The background applies the
 * online-update switch, check interval and failure backoff unless `force`
 * (popup manual check) is set, fetches at most once per host at a time, and
 * writes the result to `StorageKeys.PLUGIN_HOST_CATALOG_PREFIX + host`.
 */
export const PLUGIN_CATALOG_REFRESH_MESSAGE = 'gv.pluginCatalog.refresh';

/**
 * Popup → content script of the active tab: report every plugin's status as
 * computed by that page's PluginHost (plan §4.2). Response:
 * `{ ok: true, statuses: PluginStatus[] }`.
 */
export const PLUGIN_STATUS_MESSAGE = 'gv.plugins.status';
