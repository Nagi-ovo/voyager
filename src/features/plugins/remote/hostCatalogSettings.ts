/**
 * User settings for the remote plugin catalog channel (chrome.storage.sync,
 * backed up through SettingsBackupService):
 *   - the master switch "plugin online updates" (D5 / C4);
 *   - the minimum spacing between automatic checks (D5).
 *
 * Read by the background refresher on every check and by the popup card that
 * exposes the two controls.
 */
import { StorageKeys } from '@/core/types/common';

import {
  DEFAULT_PLUGIN_CATALOG_CHECK_INTERVAL,
  type PluginCatalogCheckInterval,
  normalizeCheckInterval,
} from './hostCatalogPolicy';

export interface PluginCatalogSettings {
  readonly onlineUpdatesEnabled: boolean;
  readonly checkInterval: PluginCatalogCheckInterval;
}

export const DEFAULT_PLUGIN_CATALOG_SETTINGS: PluginCatalogSettings = {
  onlineUpdatesEnabled: true,
  checkInterval: DEFAULT_PLUGIN_CATALOG_CHECK_INTERVAL,
};

function syncArea(): chrome.storage.SyncStorageArea | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.sync;
}

export function normalizePluginCatalogSettings(
  raw: Record<string, unknown> | null | undefined,
): PluginCatalogSettings {
  return {
    onlineUpdatesEnabled: raw?.[StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED] !== false,
    checkInterval: normalizeCheckInterval(raw?.[StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]),
  };
}

export async function loadPluginCatalogSettings(): Promise<PluginCatalogSettings> {
  const sync = syncArea();
  if (!sync) return DEFAULT_PLUGIN_CATALOG_SETTINGS;
  try {
    const result = await sync.get({
      [StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED]: true,
      [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: DEFAULT_PLUGIN_CATALOG_CHECK_INTERVAL,
    });
    return normalizePluginCatalogSettings(result);
  } catch {
    return DEFAULT_PLUGIN_CATALOG_SETTINGS;
  }
}

export async function savePluginCatalogSettings(
  patch: Partial<PluginCatalogSettings>,
): Promise<void> {
  const sync = syncArea();
  if (!sync) return;
  const payload: Record<string, unknown> = {};
  if (typeof patch.onlineUpdatesEnabled === 'boolean') {
    payload[StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED] = patch.onlineUpdatesEnabled;
  }
  if (patch.checkInterval) {
    payload[StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL] = normalizeCheckInterval(
      patch.checkInterval,
    );
  }
  if (Object.keys(payload).length === 0) return;
  await sync.set(payload);
}

/** Re-read the settings whenever either key changes in sync storage. */
export function subscribePluginCatalogSettings(
  callback: (settings: PluginCatalogSettings) => void,
): () => void {
  const onChanged = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.onChanged;
  if (!onChanged) return () => {};
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'sync') return;
    if (
      !(StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED in changes) &&
      !(StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL in changes)
    ) {
      return;
    }
    void loadPluginCatalogSettings().then(callback);
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
