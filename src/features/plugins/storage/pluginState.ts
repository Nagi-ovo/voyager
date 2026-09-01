/**
 * Per-plugin install/enable state, persisted in `chrome.storage.local`.
 *
 * Stored under `StorageKeys.PLUGINS_STATE` as `Record<pluginId, PluginStateEntry>`.
 * Local (not sync) because the set of installed plugins can be sizeable and sync
 * quota is precious — same reasoning as the gems list cache. Entitlement
 * (purchased/locked) is intentionally NOT stored here; that comes from the
 * `EntitlementProvider` so it can be server-driven later.
 *
 * Content scripts use `chrome.storage` directly per the content-script rules.
 */
import { logger } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import type { PluginSettingValue, PluginSettings } from '../types';

export interface PluginStateEntry {
  readonly enabled: boolean;
  readonly installedAt: number;
  /** User-chosen values for the plugin's declared settings (if any). */
  readonly settings?: PluginSettings;
}
export type PluginStateMap = Readonly<Record<string, PluginStateEntry>>;
export type PluginStateRestoreMode = 'merge' | 'overwrite';

const KEY = StorageKeys.PLUGINS_STATE;

function localArea(): chrome.storage.LocalStorageArea | undefined {
  const g = globalThis as { chrome?: typeof chrome };
  return g.chrome?.storage?.local;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRecordKey(value: string): boolean {
  return value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function sanitizeSettings(value: unknown): PluginSettings | undefined {
  if (!isRecord(value)) return undefined;

  const settings: Record<string, PluginSettingValue> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!isSafeRecordKey(key)) continue;
    if (
      typeof setting === 'string' ||
      typeof setting === 'boolean' ||
      (typeof setting === 'number' && Number.isFinite(setting))
    ) {
      settings[key] = setting;
    }
  }

  return settings;
}

/**
 * Treat Drive payloads as untrusted input. Keep valid plugin entries/settings,
 * drop malformed fields, and never allow prototype-mutating record keys.
 */
export function sanitizePluginState(value: unknown): PluginStateMap {
  if (!isRecord(value)) return {};

  const state: Record<string, PluginStateEntry> = {};
  for (const [id, rawEntry] of Object.entries(value)) {
    if (!id || !isSafeRecordKey(id) || !isRecord(rawEntry)) continue;
    if (typeof rawEntry.enabled !== 'boolean') continue;

    const installedAt =
      typeof rawEntry.installedAt === 'number' && Number.isFinite(rawEntry.installedAt)
        ? rawEntry.installedAt
        : 0;
    const settings = sanitizeSettings(rawEntry.settings);
    state[id] = {
      enabled: rawEntry.enabled,
      installedAt,
      ...(settings && Object.keys(settings).length > 0 ? { settings } : {}),
    };
  }

  return state;
}

export async function loadPluginState(): Promise<PluginStateMap> {
  const local = localArea();
  if (!local) return {};
  try {
    const result = await local.get({ [KEY]: {} });
    return sanitizePluginState(result?.[KEY]);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('loadPluginState failed', { error: String(error) });
    }
    return {};
  }
}

/** Restore plugin state downloaded from Drive. Cloud entries win on merge. */
export async function restorePluginState(
  value: unknown,
  mode: PluginStateRestoreMode = 'merge',
): Promise<PluginStateMap> {
  const local = localArea();
  if (!local) return {};

  if (!isRecord(value)) {
    return loadPluginState();
  }
  const cloudState = sanitizePluginState(value);
  if (Object.keys(value).length > 0 && Object.keys(cloudState).length === 0) {
    return loadPluginState();
  }
  const next =
    mode === 'overwrite'
      ? cloudState
      : {
          ...(await loadPluginState()),
          ...cloudState,
        };
  await local.set({ [KEY]: next });
  return next;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const local = localArea();
  if (!local) return;
  try {
    const current = await loadPluginState();
    const previous = current[id];
    const next: PluginStateMap = {
      ...current,
      [id]: { ...previous, enabled, installedAt: previous?.installedAt ?? Date.now() },
    };
    await local.set({ [KEY]: next });
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('setPluginEnabled failed', { id, error: String(error) });
    }
  }
}

/** Persist a single setting value for a plugin (preserving enabled state + other settings). */
export async function setPluginSetting(
  id: string,
  key: string,
  value: PluginSettingValue,
): Promise<void> {
  const local = localArea();
  if (!local) return;
  try {
    const current = await loadPluginState();
    const previous = current[id];
    const next: PluginStateMap = {
      ...current,
      [id]: {
        enabled: previous?.enabled ?? false,
        installedAt: previous?.installedAt ?? Date.now(),
        settings: { ...previous?.settings, [key]: value },
      },
    };
    await local.set({ [KEY]: next });
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('setPluginSetting failed', { id, key, error: String(error) });
    }
  }
}

const COLLAPSED_KEY = StorageKeys.PLUGIN_UI_COLLAPSED;

/** Load the set of plugin ids the user has collapsed in the popup list. */
export async function loadCollapsedPlugins(): Promise<string[]> {
  const local = localArea();
  if (!local) return [];
  try {
    const result = await local.get({ [COLLAPSED_KEY]: [] });
    const raw = result?.[COLLAPSED_KEY];
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('loadCollapsedPlugins failed', { error: String(error) });
    }
    return [];
  }
}

/** Persist whether a plugin card is collapsed (so it stays that way next time). */
export async function setPluginCollapsed(id: string, collapsed: boolean): Promise<void> {
  const local = localArea();
  if (!local) return;
  try {
    const next = new Set(await loadCollapsedPlugins());
    if (collapsed) next.add(id);
    else next.delete(id);
    await local.set({ [COLLAPSED_KEY]: Array.from(next) });
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('setPluginCollapsed failed', { id, error: String(error) });
    }
  }
}

/** Subscribe to plugin-state changes (e.g. user toggles a plugin in the store UI). */
export function subscribePluginState(callback: (state: PluginStateMap) => void): () => void {
  const g = globalThis as { chrome?: typeof chrome };
  const onChanged = g.chrome?.storage?.onChanged;
  if (!onChanged) return () => {};

  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[KEY]) return;
    callback(sanitizePluginState(changes[KEY].newValue));
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
