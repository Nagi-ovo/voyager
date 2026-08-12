import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  BACKUPABLE_SYNC_SETTINGS_DEFAULTS,
  BACKUPABLE_SYNC_SETTINGS_KEYS,
  NON_SETTINGS_BACKUP_POLICIES,
  exportBackupableSyncSettings,
  restoreBackupableSyncSettings,
} from '../SettingsBackupService';

describe('SettingsBackupService', () => {
  it('classifies every centralized storage key exactly once', () => {
    const settingsKeys = new Set(BACKUPABLE_SYNC_SETTINGS_KEYS);
    const excludedKeys = new Set(Object.keys(NON_SETTINGS_BACKUP_POLICIES));
    const allKeys = Object.values(StorageKeys);

    expect(allKeys.filter((key) => settingsKeys.has(key) && excludedKeys.has(key))).toEqual([]);
    expect(new Set([...settingsKeys, ...excludedKeys])).toEqual(new Set(allKeys));
  });

  it('backs up recently added user preferences and onboarding state', () => {
    expect(BACKUPABLE_SYNC_SETTINGS_DEFAULTS).toEqual(
      expect.objectContaining({
        [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'manual',
        [StorageKeys.GV_FOLDER_ITEM_FONT_SIZE]: 13,
        [StorageKeys.TIMELINE_STYLE]: 'dots',
        [StorageKeys.DEFAULT_THINKING_LEVEL]: null,
        [StorageKeys.COACHMARKS_SEEN]: [],
        [StorageKeys.EXPORT_IMAGE_WIDTH]: 620,
        [StorageKeys.SLASH_PROMPT_ENABLED]: true,
        [StorageKeys.FORMULA_COPY_ENABLED]: true,
        [StorageKeys.EXPORT_SPEAKER_LABELS]: {},
      }),
    );
    expect(BACKUPABLE_SYNC_SETTINGS_DEFAULTS).not.toHaveProperty(StorageKeys.PLUGINS_STATE);
    expect(NON_SETTINGS_BACKUP_POLICIES[StorageKeys.PLUGINS_STATE].disposition).toBe(
      'separate-file',
    );
  });

  it('keeps popup scroll position device-local and outside settings backup', () => {
    const popupScrollKey = 'gvPopupScrollTop';

    expect(BACKUPABLE_SYNC_SETTINGS_DEFAULTS).not.toHaveProperty(popupScrollKey);
    expect(NON_SETTINGS_BACKUP_POLICIES).toHaveProperty(popupScrollKey, {
      storage: 'local',
      disposition: 'device-local',
      reason: 'Popup scroll position is specific to this device and viewport.',
    });
  });

  it('keeps the popup settings search query device-local', () => {
    expect(BACKUPABLE_SYNC_SETTINGS_DEFAULTS).not.toHaveProperty(
      StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY,
    );
    expect(NON_SETTINGS_BACKUP_POLICIES[StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]).toEqual({
      storage: 'local',
      disposition: 'device-local',
      reason: 'Popup settings search query is device-local UI state.',
    });
  });

  it('exports only backupable sync settings with defaults applied', async () => {
    const storageArea = {
      get: vi.fn().mockResolvedValue({
        ...BACKUPABLE_SYNC_SETTINGS_DEFAULTS,
        [StorageKeys.CHAT_WIDTH]: 88,
        unknownKey: 'ignore-me',
      }),
      set: vi.fn(),
    };

    const payload = await exportBackupableSyncSettings(storageArea);

    expect(storageArea.get).toHaveBeenCalledWith(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);
    expect(payload).toEqual({
      format: 'gemini-voyager.settings.v1',
      exportedAt: expect.any(String),
      version: expect.any(String),
      data: expect.objectContaining({
        [StorageKeys.CHAT_WIDTH]: 88,
        [StorageKeys.CHAT_FONT_SIZE]: 100,
        [StorageKeys.CHAT_LINE_HEIGHT]: 160,
        [StorageKeys.CHAT_PARAGRAPH_SPACING]: 12,
        [StorageKeys.GV_GEMS_PINNED]: [],
      }),
    });
    expect(payload.data).not.toHaveProperty('unknownKey');
  });

  it('restores only whitelisted settings keys', async () => {
    const storageArea = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(
      {
        [StorageKeys.CHAT_WIDTH]: 92,
        [StorageKeys.CONTEXT_SYNC_PORT]: 4040,
        unknownKey: 'ignore-me',
      },
      storageArea,
    );

    expect(restored).toEqual({
      [StorageKeys.CHAT_WIDTH]: 92,
      [StorageKeys.CONTEXT_SYNC_PORT]: 4040,
    });
    expect(storageArea.set).toHaveBeenCalledWith({
      [StorageKeys.CHAT_WIDTH]: 92,
      [StorageKeys.CONTEXT_SYNC_PORT]: 4040,
    });
  });

  it('backs up and restores an explicitly disabled formula-copy preference', async () => {
    const storageArea = {
      get: vi.fn().mockResolvedValue({
        ...BACKUPABLE_SYNC_SETTINGS_DEFAULTS,
        [StorageKeys.FORMULA_COPY_ENABLED]: false,
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const payload = await exportBackupableSyncSettings(storageArea);
    expect(payload.data[StorageKeys.FORMULA_COPY_ENABLED]).toBe(false);

    const restored = await restoreBackupableSyncSettings(
      { [StorageKeys.FORMULA_COPY_ENABLED]: false },
      storageArea,
    );
    expect(restored).toEqual({ [StorageKeys.FORMULA_COPY_ENABLED]: false });
    expect(storageArea.set).toHaveBeenCalledWith({
      [StorageKeys.FORMULA_COPY_ENABLED]: false,
    });
  });

  it('does not restore retired tab title sync as enabled', async () => {
    const storageArea = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(
      { [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: true },
      storageArea,
    );

    expect(restored).toEqual({ [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false });
    expect(storageArea.set).toHaveBeenCalledWith({
      [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false,
    });
  });

  it('keeps monotonic onboarding progress when merging cloud settings', async () => {
    const storageArea = {
      get: vi.fn().mockResolvedValue({
        [StorageKeys.COACHMARKS_SEEN]: ['local-seen', 'shared'],
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true,
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: false,
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(
      {
        [StorageKeys.COACHMARKS_SEEN]: ['shared', 'cloud-seen'],
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: false,
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: true,
      },
      storageArea,
      'merge',
    );

    expect(restored).toEqual({
      [StorageKeys.COACHMARKS_SEEN]: ['local-seen', 'shared', 'cloud-seen'],
      [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true,
      [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: true,
    });
    expect(storageArea.set).toHaveBeenCalledWith(restored);
  });

  it('skips storage writes for invalid settings payloads', async () => {
    const storageArea = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(null, storageArea);

    expect(restored).toEqual({});
    expect(storageArea.set).not.toHaveBeenCalled();
  });
});
