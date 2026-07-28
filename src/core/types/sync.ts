/**
 * Sync-related type definitions for Google Drive sync feature
 * Provides type safety for sync state management and data transfer
 */
import type { PluginStateMap } from '@/features/plugins/storage/pluginState';
import type { StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import type { FolderData } from './folder';
import type { HighlightExportPayloadV1 } from './highlight';

/**
 * Sync mode configuration
 * - disabled: Sync feature is off
 * - manual: User must click "Sync Now" to trigger sync
 * - auto: Sync happens automatically on startup and periodically
 */
export type SyncMode = 'disabled' | 'manual' | 'auto';

export type SyncProvider = 'googleDrive' | 'icloud';

/**
 * Platform identifier for sync operations
 * - gemini: Main Gemini website (gemini.google.com)
 * - aistudio: AI Studio website (aistudio.google.com, aistudio.google.cn)
 */
export type SyncPlatform = 'gemini' | 'aistudio';

export interface SyncAccountScope {
  accountKey: string;
  accountId: number;
  routeUserId: string | null;
}

/**
 * Current sync state for UI display
 */
export interface SyncState {
  /** Cloud storage provider. iCloud is available only in the Safari build. */
  provider: SyncProvider;
  /** Current sync mode setting */
  mode: SyncMode;
  /** Timestamp of last successful sync/download (null if never synced) - Gemini */
  lastSyncTime: number | null;
  /** Timestamp of last successful upload (null if never uploaded) - Gemini */
  lastUploadTime: number | null;
  /** Timestamp of last successful sync/download for AI Studio */
  lastSyncTimeAIStudio: number | null;
  /** Timestamp of last successful upload for AI Studio */
  lastUploadTimeAIStudio: number | null;
  /** Whether a sync operation is currently in progress */
  isSyncing: boolean;
  /** Last error message (null if no error) */
  error: string | null;
  /** Whether user is authenticated with Google */
  isAuthenticated: boolean;
}

/**
 * Prompt item structure (mirrored from prompt manager for type safety)
 */
export interface PromptItem {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  /** Optional only for prompts created before names became required. */
  name?: string;
}

/**
 * Folder export payload format (matches existing export format)
 */
export interface FolderExportPayload {
  format: 'gemini-voyager.folders.v1';
  exportedAt: string;
  version: string;
  data: FolderData;
}

/**
 * Prompt export payload format (matches existing export format)
 */
export interface PromptExportPayload {
  format: 'gemini-voyager.prompts.v1';
  exportedAt: string;
  version?: string;
  items: PromptItem[];
}

/**
 * Settings export payload format
 */
export interface SettingsExportPayload {
  format: 'gemini-voyager.settings.v1';
  exportedAt: string;
  version?: string;
  data: Record<string, unknown>;
}

/** Plugin installation, enablement, and declared plugin-setting values. */
export interface PluginStateExportPayload {
  format: 'gemini-voyager.plugins.v1';
  exportedAt: string;
  version?: string;
  data: PluginStateMap;
}
/**
 * Re-export starred message types from their canonical source
 * These are used for Google Drive sync
 */
export type {
  StarredMessage as StarredMessageSync,
  StarredMessagesData as StarredMessagesDataSync,
} from '@/pages/content/timeline/starredTypes';

/**
 * Starred messages export payload format
 */
export interface StarredExportPayload {
  format: 'gemini-voyager.starred.v1';
  exportedAt: string;
  version?: string;
  data: StarredMessagesData;
}

/**
 * Re-export fork node types from their canonical source
 */
export type {
  ForkNode as ForkNodeSync,
  ForkNodesData as ForkNodesDataSync,
} from '@/pages/content/fork/forkTypes';
export type {
  TimelineHierarchyConversationData as TimelineHierarchyConversationDataSync,
  TimelineHierarchyData as TimelineHierarchyDataSync,
} from '@/pages/content/timeline/hierarchyTypes';

/**
 * Fork nodes export payload format
 */
export interface ForkExportPayload {
  format: 'gemini-voyager.forks.v1';
  exportedAt: string;
  version?: string;
  data: import('@/pages/content/fork/forkTypes').ForkNodesData;
}

/**
 * Timeline hierarchy export payload format
 */
export interface TimelineHierarchyExportPayload {
  format: 'gemini-voyager.timeline-hierarchy.v1';
  exportedAt: string;
  version?: string;
  data: import('@/pages/content/timeline/hierarchyTypes').TimelineHierarchyData;
}

/**
 * Highlight export payload format.
 *
 * Kept as an alias to the canonical annotation contract rather than embedding
 * highlights in SyncData. Older Voyager versions therefore ignore the separate
 * Drive file without trying to deserialize an unknown aggregate field.
 */
export type HighlightExportPayload = HighlightExportPayloadV1;

/**
 * Data payload synced to Google Drive
 * Uses embedded export formats for compatibility with import/export feature
 */
export interface SyncData {
  /** Extension version that created this sync data */
  version: string;
  /** Format identifier for backward compatibility */
  format: 'gemini-voyager.sync.v1';
  /** Folder data in export format */
  folders: FolderExportPayload;
  /** Prompt data in export format */
  prompts: PromptExportPayload;
  /** UI settings/preferences in export format */
  settings?: SettingsExportPayload;
  /** Plugin installation/enablement/settings in a separate Drive file */
  plugins?: PluginStateExportPayload;
  /** Starred messages in export format */
  starred?: StarredExportPayload;
  /** Fork metadata in export format */
  forks?: ForkExportPayload;
  /** Timeline hierarchy data in export format */
  timelineHierarchy?: TimelineHierarchyExportPayload;
  /** Timestamp when this data was synced */
  syncedAt: number;
}

/**
 * Storage keys for sync-related settings
 */
export const SyncStorageKeys = {
  MODE: 'gvSyncMode',
  LAST_SYNC_TIME: 'gvLastSyncTime',
  SYNC_ERROR: 'gvSyncError',
} as const;

/**
 * Default sync state for initial load
 */
export const DEFAULT_SYNC_STATE: SyncState = {
  provider: 'googleDrive',
  mode: 'disabled',
  lastSyncTime: null,
  lastUploadTime: null,
  lastSyncTimeAIStudio: null,
  lastUploadTimeAIStudio: null,
  isSyncing: false,
  error: null,
  isAuthenticated: false,
};

/**
 * Sync message types for background script communication
 */
export type SyncMessageType =
  | 'gv.sync.authenticate'
  | 'gv.sync.signOut'
  | 'gv.sync.upload'
  | 'gv.sync.download'
  | 'gv.sync.getState'
  | 'gv.sync.setMode'
  | 'gv.sync.setProvider';

/**
 * Message payload for sync operations
 */
export interface SyncMessage {
  type: SyncMessageType;
  payload?: {
    mode?: SyncMode;
    provider?: SyncProvider;
    data?: SyncData;
    interactive?: boolean;
    platform?: SyncPlatform;
    accountScope?: SyncAccountScope;
    timelineHierarchyAccountScope?: SyncAccountScope;
  };
}

/**
 * Response from sync operations
 */
export interface SyncResponse {
  ok: boolean;
  error?: string;
  state?: SyncState;
  data?: SyncData;
}
