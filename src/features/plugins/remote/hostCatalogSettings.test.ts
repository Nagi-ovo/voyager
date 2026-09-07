import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  loadPluginCatalogSettings,
  normalizePluginCatalogSettings,
  savePluginCatalogSettings,
  subscribePluginCatalogSettings,
} from './hostCatalogSettings';

afterEach(() => {
  (chrome.storage.sync.get as unknown as Mock).mockReset?.();
  (chrome.storage.sync.set as unknown as Mock).mockReset?.();
  (chrome.storage.onChanged.addListener as unknown as Mock).mockClear?.();
});

describe('plugin catalog settings', () => {
  it('defaults to online updates on every 6 hours', () => {
    expect(normalizePluginCatalogSettings(undefined)).toEqual({
      onlineUpdatesEnabled: true,
      checkInterval: '6h',
    });
    expect(
      normalizePluginCatalogSettings({
        [StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED]: false,
        [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: '24h',
      }),
    ).toEqual({ onlineUpdatesEnabled: false, checkInterval: '24h' });
    expect(
      normalizePluginCatalogSettings({ [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: 'nope' }),
    ).toEqual({ onlineUpdatesEnabled: true, checkInterval: '6h' });
  });

  it('reads from sync storage with defaults and falls back when storage throws', async () => {
    (chrome.storage.sync.get as unknown as Mock).mockResolvedValue({
      [StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED]: false,
      [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: '1h',
    });
    expect(await loadPluginCatalogSettings()).toEqual({
      onlineUpdatesEnabled: false,
      checkInterval: '1h',
    });

    (chrome.storage.sync.get as unknown as Mock).mockRejectedValue(new Error('quota'));
    expect(await loadPluginCatalogSettings()).toEqual({
      onlineUpdatesEnabled: true,
      checkInterval: '6h',
    });
  });

  it('writes only the fields given and normalises the interval', async () => {
    (chrome.storage.sync.set as unknown as Mock).mockResolvedValue(undefined);
    await savePluginCatalogSettings({ checkInterval: '24h' });
    expect(chrome.storage.sync.set).toHaveBeenLastCalledWith({
      [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: '24h',
    });
    await savePluginCatalogSettings({ onlineUpdatesEnabled: false });
    expect(chrome.storage.sync.set).toHaveBeenLastCalledWith({
      [StorageKeys.PLUGIN_ONLINE_UPDATES_ENABLED]: false,
    });
    await savePluginCatalogSettings({});
    expect(chrome.storage.sync.set).toHaveBeenCalledTimes(2);
  });

  it('re-reads on a sync change of either key only', async () => {
    (chrome.storage.sync.get as unknown as Mock).mockResolvedValue({
      [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: '1h',
    });
    const callback = vi.fn();
    subscribePluginCatalogSettings(callback);
    const addListener = chrome.storage.onChanged.addListener as unknown as Mock;
    const listener = addListener.mock.calls[addListener.mock.calls.length - 1][0];

    listener({ [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: { newValue: '1h' } }, 'local');
    listener({ [StorageKeys.ACCENT_COLORS]: { newValue: {} } }, 'sync');
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    listener({ [StorageKeys.PLUGIN_CATALOG_CHECK_INTERVAL]: { newValue: '1h' } }, 'sync');
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith({ onlineUpdatesEnabled: true, checkInterval: '1h' }),
    );
  });
});
