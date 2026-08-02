import { type StorageKey, StorageKeys } from '@/core/types/common';
import { DEFAULT_HIGHLIGHT_COLOR_PALETTE } from '@/core/types/highlight';
import type { SettingsExportPayload } from '@/core/types/sync';
import { EXTENSION_VERSION } from '@/core/utils/version';

export type BackupableSyncSettings = Record<string, unknown>;
export type SettingsRestoreMode = 'merge' | 'overwrite';

type StorageAreaLike = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

const DEFAULT_TIMELINE_SHORTCUTS = {
  shortcuts: {
    previous: {
      action: 'timeline:previous',
      modifiers: [],
      key: 'k',
    },
    next: {
      action: 'timeline:next',
      modifiers: [],
      key: 'j',
    },
    first: {
      action: 'timeline:first',
      modifiers: [],
      key: 'g',
      sequenceLength: 2,
    },
    last: {
      action: 'timeline:last',
      modifiers: ['Shift'],
      key: 'G',
      sequenceLength: 2,
    },
  },
  enabled: true,
} as const;

export const BACKUPABLE_SYNC_SETTINGS_DEFAULTS = {
  [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: false,
  [StorageKeys.FOLDER_SEARCH_ENABLED]: true,
  [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
  [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: true,
  [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'manual',
  [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO]: false,
  [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: false,
  [StorageKeys.TIMELINE_SCROLL_MODE]: 'flow',
  [StorageKeys.TIMELINE_STYLE]: 'dots',
  [StorageKeys.TIMELINE_HIDE_CONTAINER]: false,
  [StorageKeys.TIMELINE_BAR_WIDTH]: null,
  [StorageKeys.TIMELINE_DRAGGABLE]: false,
  [StorageKeys.TIMELINE_POSITION]: null,
  [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
  [StorageKeys.TIMELINE_MARKER_LEVEL]: false,
  [StorageKeys.TIMELINE_SHORTCUTS]: DEFAULT_TIMELINE_SHORTCUTS,
  [StorageKeys.CHAT_WIDTH]: 70,
  [StorageKeys.CHAT_WIDTH_ENABLED]: false,
  [StorageKeys.CHAT_FONT_SIZE]: 100,
  [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
  [StorageKeys.CHAT_LINE_HEIGHT]: 160,
  [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: false,
  [StorageKeys.CHAT_PARAGRAPH_SPACING]: 12,
  [StorageKeys.GV_GEMS_PINNED]: [],
  [StorageKeys.EDIT_INPUT_WIDTH]: 60,
  [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false,
  [StorageKeys.SIDEBAR_WIDTH]: 312,
  [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
  [StorageKeys.AISTUDIO_SIDEBAR_WIDTH]: 280,
  [StorageKeys.PROMPT_PANEL_LOCKED]: false,
  [StorageKeys.PROMPT_PANEL_POSITION]: null,
  [StorageKeys.PROMPT_TRIGGER_POSITION]: null,
  [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [],
  [StorageKeys.PROMPT_THEME]: null,
  [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
  [StorageKeys.PROMPT_VIEW_MODE]: 'compact',
  [StorageKeys.PROMPT_PANEL_VIEW]: 'prompts',
  [StorageKeys.SLASH_PROMPT_ENABLED]: true,
  [StorageKeys.LANGUAGE]: null,
  [StorageKeys.FORMULA_COPY_FORMAT]: 'latex',
  [StorageKeys.WATERMARK_REMOVER_ENABLED]: true,
  [StorageKeys.WATERMARK_DOWNLOAD_ENABLED]: true,
  [StorageKeys.WATERMARK_PREVIEW_ENABLED]: true,
  [StorageKeys.HIDE_PROMPT_MANAGER]: false,
  [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false,
  [StorageKeys.MERMAID_ENABLED]: true,
  [StorageKeys.QUOTE_REPLY_ENABLED]: true,
  [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
  [StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED]: true,
  [StorageKeys.HIGHLIGHT_ENABLED]: true,
  [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: 'yellow',
  [StorageKeys.HIGHLIGHT_COLOR_PALETTE]: [...DEFAULT_HIGHLIGHT_COLOR_PALETTE],
  [StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED]: true,
  [StorageKeys.CTRL_ENTER_SEND]: false,
  [StorageKeys.AISTUDIO_ENTER_SEND]: false,
  [StorageKeys.SAFARI_ENTER_FIX]: false,
  [StorageKeys.INPUT_COLLAPSE_ENABLED]: false,
  [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
  [StorageKeys.INPUT_VIM_MODE]: false,
  [StorageKeys.DRAFT_AUTO_SAVE]: false,
  [StorageKeys.PREVENT_AUTO_SCROLL_ENABLED]: false,
  [StorageKeys.DEFAULT_MODEL]: null,
  [StorageKeys.DEFAULT_THINKING_LEVEL]: null,
  [StorageKeys.DEFAULT_MODEL_AUTO_APPLY]: true,
  [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: false,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: false,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: null,
  [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]: null,
  [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: false,
  [StorageKeys.GV_SIDEBAR_FULL_HIDE]: false,
  [StorageKeys.GV_GEMS_SIDEBAR_COUNT]: 3,
  [StorageKeys.USAGE_STATUS_ENABLED]: false,
  [StorageKeys.COACHMARKS_SEEN]: [],
  [StorageKeys.GV_FOLDER_SPACING]: 2,
  [StorageKeys.GV_AISTUDIO_FOLDER_SPACING]: 2,
  [StorageKeys.GV_FOLDER_TREE_INDENT]: -8,
  [StorageKeys.GV_FOLDER_ITEM_FONT_SIZE]: 13,
  [StorageKeys.INPUT_HALO_HIDDEN]: false,
  [StorageKeys.GV_SNOW_EFFECT]: false,
  [StorageKeys.GV_VISUAL_EFFECT]: 'off',
  [StorageKeys.FORK_ENABLED]: false,
  [StorageKeys.EXPORT_IMAGE_WIDTH]: 620,
  [StorageKeys.EXPORT_SPEAKER_LABELS]: {},
  [StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED]: true,
  [StorageKeys.GV_AISTUDIO_ENABLED]: true,
  [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: false,
  [StorageKeys.GV_POPUP_SECTION_ORDER]: null,
  [StorageKeys.FOLDER_ENABLED]: true,
  [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: false,
  [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
  [StorageKeys.CONTEXT_SYNC_ENABLED]: false,
  [StorageKeys.CONTEXT_SYNC_PORT]: 3030,
  [StorageKeys.ACCENT_COLORS]: {},
} as const satisfies Partial<Record<StorageKey, unknown>>;

export type NonSettingsBackupDisposition =
  | 'separate-file'
  | 'device-local'
  | 'local-data'
  | 'cache'
  | 'operational'
  | 'transient'
  | 'deprecated';

export interface NonSettingsBackupPolicy {
  storage: 'sync' | 'local';
  disposition: NonSettingsBackupDisposition;
  reason: string;
}

type BackupableSettingsKey = keyof typeof BACKUPABLE_SYNC_SETTINGS_DEFAULTS;
type NonSettingsStorageKey = Exclude<StorageKey, BackupableSettingsKey>;

/**
 * Every StorageKey that does not belong in the personalization settings file
 * must be classified here. The exhaustive type plus the runtime coverage test
 * make a new key fail fast until its sync/backup behavior is an explicit choice.
 */
export const NON_SETTINGS_BACKUP_POLICIES = {
  [StorageKeys.FOLDER_DATA]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Folder content has its own account-scoped Drive file.',
  },
  [StorageKeys.FOLDER_DATA_AISTUDIO]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'AI Studio folder content has its own Drive file.',
  },
  [StorageKeys.FOLDER_FLOATING_NUDGE_SHOWN]: {
    storage: 'sync',
    disposition: 'deprecated',
    reason: 'Reserved key with no active reader or writer.',
  },
  [StorageKeys.FOLDER_FLOATING_POS]: {
    storage: 'sync',
    disposition: 'device-local',
    reason: 'Viewport coordinates should not be restored across different screens.',
  },
  [StorageKeys.FOLDER_FLOATING_FAB_POS]: {
    storage: 'sync',
    disposition: 'device-local',
    reason: 'Viewport coordinates should not be restored across different screens.',
  },
  [StorageKeys.FOLDER_FLOATING_SIZE]: {
    storage: 'sync',
    disposition: 'device-local',
    reason: 'Viewport dimensions should not be restored across different screens.',
  },
  [StorageKeys.TIMELINE_STARRED_MESSAGES]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Starred messages have their own account-scoped Drive file.',
  },
  [StorageKeys.TIMELINE_HIERARCHY]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Timeline hierarchy has its own account-scoped Drive file.',
  },
  [StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Cloud authorization and opt-in are device-specific.',
  },
  [StorageKeys.HIGHLIGHT_DEVICE_ID]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Conflict-resolution device identity must remain unique per installation.',
  },
  [StorageKeys.PROMPT_ITEMS]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Prompt content has its own Drive file.',
  },
  [StorageKeys.PROMPT_SELECTED_TAGS]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Selected tags are a local view over the current device prompt set.',
  },
  [StorageKeys.REMOTE_ANNOUNCEMENTS_STATE]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Fetched announcement delivery state is not a user preference.',
  },
  [StorageKeys.REMOTE_ANNOUNCEMENTS_PENDING]: {
    storage: 'local',
    disposition: 'transient',
    reason: 'Pending announcement work is installation-specific.',
  },
  [StorageKeys.STORAGE_QUOTA_WARNING_LEVEL]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Quota warning state depends on this installation storage usage.',
  },
  [StorageKeys.GENERATED_UI_CAPTURE_PERMISSION_CLEANUP_DONE]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'One-time permission migration marker is installation-specific.',
  },
  [StorageKeys.GV_ACCOUNT_PROFILE_MAP]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Account routing metadata is discovered independently on each device.',
  },
  [StorageKeys.GEMS_HIDDEN]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Sidebar visibility is a per-device layout preference.',
  },
  [StorageKeys.NOTEBOOKS_HIDDEN]: {
    storage: 'local',
    disposition: 'deprecated',
    reason: 'Notebook hiding is no longer active in the current sidebar.',
  },
  [StorageKeys.FOLDERS_HIDDEN]: {
    storage: 'local',
    disposition: 'deprecated',
    reason: 'Folder hiding was replaced by the built-in collapse and Activity controls.',
  },
  [StorageKeys.FOLDERS_COLLAPSED]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Expanded folder UI state is intentionally local.',
  },
  [StorageKeys.FOLDERS_VIEW_MODE]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'The folder tree or Activity projection is a per-device layout preference.',
  },
  [StorageKeys.GV_GEMS_LIST_CACHE]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'The Gems catalog is rebuilt from Gemini.',
  },
  [StorageKeys.GV_GEMS_MRU]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'Recent Gems history is bounded, device-local, and rebuildable.',
  },
  [StorageKeys.GV_USAGE_CACHE]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'Usage data is account-specific and frequently refreshed.',
  },
  [StorageKeys.GV_USAGE_RECIPE]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'The usage refresh recipe is self-calibrated per installation.',
  },
  [StorageKeys.GV_USAGE_POS]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Viewport coordinates are device-specific.',
  },
  [StorageKeys.GV_CLAUDE_USAGE_CACHE]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'Claude usage data is account-specific and frequently refreshed.',
  },
  [StorageKeys.GV_CLAUDE_USAGE_REFRESH_LOCK]: {
    storage: 'local',
    disposition: 'transient',
    reason: 'Refresh locks are valid only within one installation.',
  },
  [StorageKeys.GV_CLAUDE_USAGE_POS]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Viewport coordinates are device-specific.',
  },
  [StorageKeys.FOLDERS_ANCHOR]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Sidebar anchoring follows the layout available on each device.',
  },
  [StorageKeys.SIDEBAR_COLLAPSE_NUDGE_SHOWN]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'This legacy hint belongs to the local sidebar layout.',
  },
  [StorageKeys.CHANGELOG_DISMISSED_VERSION]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Changelog delivery follows the installed extension version.',
  },
  [StorageKeys.CHANGELOG_NOTIFY_MODE]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Changelog notification mode is runtime delivery state.',
  },
  [StorageKeys.EDGE_FINAL_VERSION_NOTICE_FIRST_SEEN_AT]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Browser-specific migration notice state stays local.',
  },
  [StorageKeys.EDGE_FINAL_VERSION_NOTICE_SHOWN]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Browser-specific migration notice state stays local.',
  },
  [StorageKeys.EDGE_CONTINUED_SUPPORT_NOTICE_FIRST_SEEN_AT]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Browser-specific migration notice state stays local.',
  },
  [StorageKeys.EDGE_CONTINUED_SUPPORT_NOTICE_SHOWN]: {
    storage: 'local',
    disposition: 'operational',
    reason: 'Browser-specific migration notice state stays local.',
  },
  [StorageKeys.FORK_NODES]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Fork metadata has its own account-scoped Drive file.',
  },
  [StorageKeys.GV_MESSAGE_TIMESTAMPS]: {
    storage: 'local',
    disposition: 'local-data',
    reason: 'Message timestamp history is local data, not a setting.',
  },
  [StorageKeys.GV_TURN_IDENTITY_CACHE]: {
    storage: 'local',
    disposition: 'cache',
    reason:
      'Gemini response-id aliases are bounded, device-local, and rebuilt from conversation history.',
  },
  [StorageKeys.GV_POPUP_SCROLL_TOP]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Popup scroll position is specific to this device and viewport.',
  },
  [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: {
    storage: 'local',
    disposition: 'transient',
    reason: 'Pending navigation state is valid only for the current browser flow.',
  },
  [StorageKeys.PLUGINS_STATE]: {
    storage: 'local',
    disposition: 'separate-file',
    reason: 'Plugin install, enable, and setting state uses its own Drive file.',
  },
  [StorageKeys.PLUGIN_MARKETPLACE_SOURCES]: {
    storage: 'local',
    disposition: 'deprecated',
    reason: 'Reserved for a future registry and currently unused.',
  },
  [StorageKeys.PLUGIN_CATALOG_CACHE]: {
    storage: 'local',
    disposition: 'cache',
    reason: 'The plugin catalog is bundled or fetched and can be rebuilt.',
  },
  [StorageKeys.PLUGIN_UI_COLLAPSED]: {
    storage: 'local',
    disposition: 'device-local',
    reason: 'Collapsed plugin cards are a per-device popup layout choice.',
  },
} as const satisfies Record<NonSettingsStorageKey, NonSettingsBackupPolicy>;

export const BACKUPABLE_SYNC_SETTINGS_KEYS = Object.keys(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);

function getStorageArea(storageArea?: StorageAreaLike): StorageAreaLike {
  if (storageArea) {
    return storageArea;
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
    return chrome.storage.sync;
  }

  return {
    get: async (keys?: unknown) =>
      typeof keys === 'object' && keys !== null ? (keys as Record<string, unknown>) : {},
    set: async () => undefined,
  } as StorageAreaLike;
}

export function filterBackupableSyncSettings(value: unknown): BackupableSyncSettings {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const settings = BACKUPABLE_SYNC_SETTINGS_KEYS.reduce<BackupableSyncSettings>((acc, key) => {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      acc[key] = record[key];
    }
    return acc;
  }, {});

  if (Object.prototype.hasOwnProperty.call(settings, StorageKeys.TAB_TITLE_UPDATE_ENABLED)) {
    settings[StorageKeys.TAB_TITLE_UPDATE_ENABLED] = false;
  }

  return settings;
}

export async function loadBackupableSyncSettings(
  storageArea?: StorageAreaLike,
): Promise<BackupableSyncSettings> {
  const area = getStorageArea(storageArea);
  const result = await area.get(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);
  return filterBackupableSyncSettings(result);
}

export async function exportBackupableSyncSettings(
  storageArea?: StorageAreaLike,
): Promise<SettingsExportPayload> {
  return {
    format: 'gemini-voyager.settings.v1',
    exportedAt: new Date().toISOString(),
    version: EXTENSION_VERSION,
    data: await loadBackupableSyncSettings(storageArea),
  };
}

export async function restoreBackupableSyncSettings(
  settings: unknown,
  storageArea?: StorageAreaLike,
  mode: SettingsRestoreMode = 'overwrite',
): Promise<BackupableSyncSettings> {
  const filtered = filterBackupableSyncSettings(settings);
  if (Object.keys(filtered).length === 0) {
    return filtered;
  }

  const area = getStorageArea(storageArea);
  if (mode === 'merge') {
    const current = await area.get({
      [StorageKeys.COACHMARKS_SEEN]: [],
      [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: false,
      [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: false,
    });
    if (Object.prototype.hasOwnProperty.call(filtered, StorageKeys.COACHMARKS_SEEN)) {
      const cloudSeenRaw = filtered[StorageKeys.COACHMARKS_SEEN];
      const localSeenRaw = current[StorageKeys.COACHMARKS_SEEN];
      const cloudSeen = Array.isArray(cloudSeenRaw)
        ? cloudSeenRaw.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const localSeen = Array.isArray(localSeenRaw)
        ? localSeenRaw.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      filtered[StorageKeys.COACHMARKS_SEEN] = [...new Set([...localSeen, ...cloudSeen])];
    }
    if (
      Object.prototype.hasOwnProperty.call(filtered, StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN)
    ) {
      filtered[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN] =
        current[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN] === true ||
        filtered[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN] === true;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        filtered,
        StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO,
      )
    ) {
      filtered[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO] =
        current[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO] === true ||
        filtered[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO] === true;
    }
  }
  await area.set(filtered);
  return filtered;
}
