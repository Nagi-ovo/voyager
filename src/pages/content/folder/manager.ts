import browser, { type Runtime } from 'webextension-polyfill';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
  detectAccountContextFromDocument,
  extractRouteUserIdFromPath,
} from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';
import { StorageKeys } from '@/core/types/common';
import type { PromptItem, SyncAccountScope } from '@/core/types/sync';
import { isSafari } from '@/core/utils/browser';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { ImportStrategy } from '@/features/folder/types/import-export';
import { getTranslationSync, getTranslationSyncUnsafe, initI18n } from '@/utils/i18n';
import {
  mergeFolderData,
  mergePrompts as mergeSyncedPrompts,
  mergeTimelineHierarchy,
} from '@/utils/merge';

import { hasSeenCoachmark, markCoachmarkSeen } from '../coachmark';
import {
  MENU_PANEL_SELECTOR as CONVERSATION_MENU_PANEL_SELECTOR,
  type ConversationMenuContext,
  getConversationMenuContext,
  injectConversationMenuMoveToFolderButton,
} from '../export/conversationMenuInjection';
import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '../timeline/hierarchyStorage';
import type { TimelineHierarchyData } from '../timeline/hierarchyTypes';
import { watchRouteChanges } from '../utils/routeWatcher';
import { type ConversationSortMode, sortConversationsByPriority } from './conversationSort';
import { type FloatingFabPos, mountFloatingFab, unmountFloatingFab } from './floatingModeFab';
import { unmountFloatingModeNudge } from './floatingModeNudge';
import {
  type FloatingPanelHandle,
  type FloatingPanelPos,
  type FloatingPanelSize,
  mountFloatingPanel,
} from './floatingPanel';
import { FOLDER_COLORS, getFolderColor, isDarkMode } from './folderColors';
import { DEFAULT_CONVERSATION_ICON, GEM_CONFIG, getGemIcon } from './gemConfig';
import {
  mountHideArchivedNudge,
  shouldShowHideArchivedNudge,
  unmountHideArchivedNudge,
} from './hideArchivedNudge';
import {
  type IFolderStorageAdapter,
  createFolderStorageAdapter,
} from './storage/FolderStorageAdapter';
import type { ConversationReference, DragData, Folder, FolderData } from './types';

const STORAGE_KEY = 'gvFolderData';
const IS_DEBUG = false; // Set to true to enable debug logging
// Native ⋮ menu content (the action items) renders asynchronously after the
// panel element appears, so injection is retried a few times before giving up.
const MOVE_MENU_INJECTION_RETRY_LIMIT = 8;
const MOVE_MENU_INJECTION_RETRY_DELAY_MS = 80;
const CONVERSATION_MENU_TRIGGER_SELECTOR =
  '[data-test-id="actions-menu-button"], [data-test-id="conversation-actions-menu-icon-button"]';
// AI Organize: the lr26 sidebar populates conversation rows lazily, so wait
// briefly for at least one row to gain its link before collecting (see #725).
const AI_ORG_COLLECT_TIMEOUT_MS = 3000;
const AI_ORG_COLLECT_POLL_MS = 150;
const ROOT_CONVERSATIONS_ID = '__root_conversations__'; // Special ID for root-level conversations
const NOTIFICATION_TIMEOUT_MS = 10000; // Duration to show data loss notification
const FOLDER_TREE_INDENT_MIN = -8;
const FOLDER_TREE_INDENT_MAX = 32;
const FOLDER_TREE_INDENT_DEFAULT = -8;
const NATIVE_TITLE_SYNC_DEBOUNCE_MS = 300;
const ARCHIVED_CONVERSATION_ACTIONS_CLASS = 'gv-conversation-archived-actions';
// Issue #753: idle-slice budget for draining queued per-row enhancement work,
// and how long the legacy actions-container layout probe stays cached.
const ENHANCEMENT_IDLE_BUDGET_MS = 8;
const ENHANCEMENT_IDLE_TIMEOUT_MS = 500;
const LEGACY_ACTIONS_PROBE_TTL_MS = 1000;
const SIDEBAR_ANCHOR_FALLBACK_GRACE_MS = 6000;
// Grace before treating an attached-but-invisible folder as broken. Long enough
// that the sidebar's open/close width animation (momentary zero height) can't
// flicker the floating fallback, short enough to recover quickly from a real
// fault (e.g. Gemini moving DOM so our hide logic mis-fires).
const FOLDER_HIDDEN_ANOMALY_GRACE_MS = 1500;
// Max folder nesting depth — matches the floating panel's MAX_FOLDER_DEPTH.
// root = 0, subfolder = 1, and that's the limit. Pre-existing data deeper
// than this stays intact (we never destroy user data); the cap only gates
// *new* creation. Moves remain unconstrained for the same reason.
const MAX_FOLDER_DEPTH = 1;
const FOLDER_NAME_SINGLE_CLICK_DELAY_MS = 220;
const FOLDER_NAVIGATION_CONFIRM_DELAY_MS = 1200;
// A native delete menu can remain open while the user reads the confirmation
// dialog. Keep only the conversation ID (never the title/content), and expire
// it so an abandoned dialog cannot affect a later unrelated action.
const NATIVE_DELETE_CANDIDATE_TIMEOUT_MS = 60_000;
// Trailing debounce for persisting pure-UI state changes (expand/collapse,
// recently-opened marks). Data mutations still save immediately.
const SAVE_DEBOUNCE_MS = 300;
// How long an armed self-write echo stays valid. If the mirror write's
// onChanged echo never arrives (e.g. the chrome.storage mirror failed), the
// stale counter expires so external writes can't be swallowed forever.
const STORAGE_ECHO_SUPPRESS_WINDOW_MS = 2000;
// Debounce for the folder search box so each keystroke doesn't rebuild the tree.
const FOLDER_SEARCH_DEBOUNCE_MS = 200;
export const FOLDER_ONLY_SEARCH_HINT_ID = 'folder-only-search-prefix-hint';

// Export session backup keys for use by FolderImportExportService (deprecated, kept for compatibility)
export const SESSION_BACKUP_KEY = 'gvFolderBackup';
export const SESSION_BACKUP_TIMESTAMP_KEY = 'gvFolderBackupTimestamp';

export function clampFolderTreeIndent(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return FOLDER_TREE_INDENT_DEFAULT;
  return Math.min(FOLDER_TREE_INDENT_MAX, Math.max(FOLDER_TREE_INDENT_MIN, Math.round(numeric)));
}

export function calculateFolderHeaderPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 8);
}

export function calculateFolderConversationPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 24);
}

// Move-to-folder dialog renders a flat list (no DOM nesting), so it needs its
// own positive per-level indent. The sidebar's `folderTreeIndent` (which can
// be negative to compact the nested tree view) doesn't apply here — using it
// directly inverts the hierarchy in the dialog.
const FOLDER_DIALOG_INDENT_PER_LEVEL = 16;
export function calculateFolderDialogPaddingLeft(level: number): number {
  return level * FOLDER_DIALOG_INDENT_PER_LEVEL + 12;
}

interface FolderDialogOption {
  folder: Folder;
  level: number;
  path: string;
}

type ConversationReorderPlacement = 'above' | 'below';

interface ConversationReorderTarget {
  element: HTMLElement;
  placement: ConversationReorderPlacement;
}

function normalizeFolderDialogSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, '/');
}

function normalizeFolderSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

type FolderSearchMode = 'all' | 'folder';

interface FolderSearchCriteria {
  mode: FolderSearchMode;
  query: string;
}

function parseFolderSearchCriteria(value: string): FolderSearchCriteria {
  const normalized = normalizeFolderSearchText(value);
  const folderOnlyMatch = normalized.match(/^(?:f|folder)\s*:\s*(.*)$/);

  return folderOnlyMatch
    ? { mode: 'folder', query: folderOnlyMatch[1] ?? '' }
    : { mode: 'all', query: normalized };
}

/**
 * Validate folder data structure
 */
function validateFolderData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.folders) && typeof d.folderContents === 'object';
}

export class FolderManager {
  private debug(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.log('[FolderManager]', ...args);
    }
  }

  private debugWarn(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.warn('[FolderManager]', ...args);
    }
  }
  private isDebugEnabled(): boolean {
    try {
      // Enable by setting localStorage.gvFolderDebug = '1'
      return IS_DEBUG || localStorage.getItem('gvFolderDebug') === '1';
    } catch {
      // Ignore - localStorage may not be available in some contexts (e.g. incognito mode)
      return IS_DEBUG;
    }
  }
  private storage: IFolderStorageAdapter; // Storage adapter (Strategy Pattern)
  private backupService: DataBackupService<FolderData>; // Multi-layer backup system
  private data: FolderData = { folders: [], folderContents: {} };
  private containerElement: HTMLElement | null = null;
  private multiSelectHostElement: HTMLElement | null = null;
  private sidebarContainer: HTMLElement | null = null;
  private recentSection: HTMLElement | null = null;
  private tooltipElement: HTMLElement | null = null;
  private tooltipTimeout: number | null = null;
  private sideNavObserver: MutationObserver | null = null;
  private conversationObserver: MutationObserver | null = null; // Observer for conversation additions/removals
  // Watches the sidebar for re-renders that would leave the folder container in
  // the wrong slot relative to the Recents section. Gemini occasionally replaces
  // the `expandable-section[data-test-id="chats-expandable-section"]` element
  // wholesale, which leaves our folder container stranded below the new section
  // even though it was inserted above the old one. The position enforcer below
  // (`enforceFolderAboveRecents`) watches the anchor section's direct parent,
  // batched via requestAnimationFrame, and is a no-op once the container is
  // already correctly placed.
  private positionObserver: MutationObserver | null = null;
  private positionEnforceRafId: number | null = null;
  // User-controlled placement of the folder panel within Gemini's sidebar.
  // 'above-recents' (default) keeps the historical behavior of anchoring just
  // above the Recents expandable-section. 'above-notebooks' anchors above the
  // Notebooks section instead, which collapses the visual gap when the user
  // wants Folders to be the topmost section. Persisted via
  // `StorageKeys.FOLDERS_ANCHOR` in chrome.storage.local.
  private folderAnchor: 'above-recents' | 'above-notebooks' = 'above-recents';
  private foldersCollapsed: boolean = false;
  // The small hover-reveal swap button we paint over Notebooks' top-right
  // corner (the same spot the section-hider's "eye" button used to live in).
  // Click flips `folderAnchor`. Tracked so we can detect a stale element when
  // Gemini swaps the Notebooks section wholesale and re-paint on the new one.
  private notebooksAnchorButton: HTMLElement | null = null;
  private importInProgress: boolean = false; // Lock to prevent concurrent imports
  private exportInProgress: boolean = false; // Lock to prevent concurrent exports
  private selectedConversations: Set<string> = new Set(); // For multi-select support
  private activeFolderConversationKey: string | null = null; // Last clicked folder row for duplicate conversation IDs
  private isMultiSelectMode: boolean = false; // Multi-select mode state
  private multiSelectSource: 'folder' | 'native' | null = null; // Track where multi-select was initiated
  private multiSelectFolderId: string | null = null; // Track which folder multi-select was initiated from
  private longPressTimeout: number | null = null; // For long-press detection
  private folderNameClickTimeout: number | null = null; // Distinguish single-click toggle from double-click rename
  private folderNavigationConfirmTimer: number | null = null;
  private longPressThreshold: number = 500; // Long-press duration in ms
  private folderEnabled: boolean = true; // Whether folder feature is enabled
  private folderProjectEnabled: boolean = false; // Whether Folder-as-Project feature is enabled
  private hideArchivedConversations: boolean = false; // Whether to hide conversations in folders
  private hideArchivedNudgeShown: boolean = false; // Whether the first-archive nudge has been shown/dismissed
  private folderTreeIndent: number = FOLDER_TREE_INDENT_DEFAULT; // Tree indentation width (px)
  private filterCurrentUserOnly: boolean = false; // Whether to show only current user's conversations
  private folderSearchEnabled: boolean = true; // Whether to show the folder title search box
  private folderSearchQuery: string = ''; // Filter the folder tree by folder/conversation title
  private folderOnlySearchHintSeen: boolean = false;
  private conversationSortMode: ConversationSortMode = 'manual';
  private accountIsolationEnabled: boolean = false; // Whether hard account isolation is enabled
  private accountScope: AccountScope | null = null; // Resolved account scope for current page
  private activeStorageKey: string = STORAGE_KEY; // Storage key currently used for folder data
  private lastPathname: string | null = null;
  private saveInProgress: boolean = false; // Lock to prevent concurrent saves
  private savePending: boolean = false; // Run one trailing save when data changes mid-write
  private nativeTitleSyncTimer: number | null = null;
  private nativeTitleSyncInProgress: boolean = false;
  private pendingTitleUpdates: Map<string, string> = new Map(); // Buffer title updates during render
  private pendingRemovals: Map<string, number> = new Map(); // Pending conversation removals with timer IDs
  private removalCheckDelay: number = 300; // Delay (ms) before confirming conversation deletion
  // Batched mutation processing for the sidebar observer. Gemini emits a
  // burst of mutations every time the user clicks a conversation row (it
  // re-renders rows to update active state). Doing per-element setup work
  // synchronously inside the observer callback caused noticeable click
  // jank — issue #678. We now coalesce mutations to the next animation frame
  // and dedupe by element/conversationId before doing any work.
  private mutationBatchQueue: MutationRecord[] = [];
  private mutationFlushScheduled: boolean = false;
  private mutationFlushRafId: number | null = null;
  // Per-row enhancement work (drag listeners, hide-archived state) for added
  // conversations is drained from this queue during idle time instead of the
  // sidebar-open animation frame — a burst can add every Recents row at once
  // and this work is allowed to lag behind paint (issue #753). Removal
  // *cancellation* stays synchronous in `flushMutationBatch`: it must beat
  // the `removalCheckDelay` timer.
  private enhancementQueue: Set<HTMLElement> = new Set();
  private enhancementDrainIdleId: number | null = null;
  // Cached result of the legacy `.conversation-actions-container` layout
  // probe — see `hasLegacyActionsContainer` (issue #753).
  private legacyActionsProbe: { present: boolean; at: number } | null = null;
  private isDestroyed: boolean = false; // Flag to prevent callbacks after destruction
  private reinitializePromise: Promise<void> | null = null; // Prevent duplicate reinitialization cascades
  private activeColorPicker: HTMLElement | null = null; // Currently open color picker dialog
  private activeColorPickerFolderId: string | null = null; // Folder ID of currently open color picker
  private activeColorPickerCloseHandler: ((e: MouseEvent) => void) | null = null; // Event handler for closing color picker
  private pendingConversationReorderTarget: ConversationReorderTarget | null = null;
  private activeConversationReorderTarget: ConversationReorderTarget | null = null;
  private conversationReorderRafId: number | null = null;
  // Echo suppression for our own chrome.storage.local mirror writes.
  // FolderStorageAdapter.saveData mirrors folder data into chrome.storage.local
  // and chrome fires storage.onChanged in the SAME context that initiated the
  // write. Without suppression every local save triggered a redundant full
  // reload + re-render (and a slightly stale snapshot could briefly overwrite
  // this.data). A counter bounds concurrent saves; the time window prevents a
  // stale counter (echo lost, e.g. mirror write failed) from swallowing a
  // genuine external change forever.
  private pendingStorageEchoes = 0;
  private lastStorageEchoArmedAt = 0;
  // Debounced persistence for high-frequency pure-UI state changes
  // (expand/collapse, recently-opened marks). Data-shape mutations
  // (create/delete/rename/import/move) still save immediately.
  private saveDebounceTimer: number | null = null;
  private beforeUnloadFlushHandler: (() => void) | null = null;
  // Debounce for the folder search box so each keystroke doesn't rebuild the tree.
  private folderSearchDebounceTimer: number | null = null;
  // Per-render native-title lookup table (built once per createFoldersList pass
  // instead of scanning the whole sidebar for every stored conversation).
  private nativeTitleLookup: Map<string, string> | null = null;

  // Track active UI elements to prevent duplicate creation
  private activeFolderInput: HTMLElement | null = null; // Currently open folder name input
  private activeImportExportMenu: HTMLElement | null = null; // Currently open import/export menu
  private activeImportDialog: HTMLElement | null = null; // Currently open import dialog
  private activeImportExportMenuCloseHandler: ((e: MouseEvent) => void) | null = null;
  private activeImportExportMenuListenerTimeout: number | null = null;

  // Cleanup references
  private routeChangeCleanup: (() => void) | null = null;
  private sidebarClickListener: ((e: Event) => void) | null = null;
  private nativeMenuObserver: MutationObserver | null = null;
  // Capture-phase listener that injects "Move to folder" when a conversation ⋮
  // menu trigger is clicked (belt-and-suspenders alongside nativeMenuObserver).
  private moveMenuTriggerHandler: ((event: Event) => void) | null = null;
  private moveMenuKeydownHandler: ((event: Event) => void) | null = null;
  private activeNativeMenuConversationId: string | null = null;
  private nativeDeleteCandidateId: string | null = null;
  private nativeDeleteCandidateTimer: number | null = null;
  // Tracks the last input modality so menu-close focus handling stays a11y-safe:
  // pointer dismissals drop trigger focus, keyboard dismissals preserve it.
  private lastInputModality: 'pointer' | 'keyboard' = 'pointer';
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null; // For exiting multi-select on outside click

  // Batch delete related properties
  private readonly MAX_BATCH_DELETE_COUNT = 50; // Maximum number of conversations to delete at once
  private batchDeleteInProgress = false; // Lock to prevent concurrent batch deletes
  private batchDeleteProgressElement: HTMLElement | null = null; // Progress indicator element

  // Batch delete timing configuration (in milliseconds)
  private readonly BATCH_DELETE_CONFIG = {
    DELAY_BETWEEN_DELETIONS: 500, // Delay between each deletion to avoid rate limiting
    MENU_APPEAR_DELAY: 300, // Wait for context menu to appear after clicking "more" button
    DIALOG_APPEAR_DELAY: 300, // Wait for confirmation dialog to appear
    DELETION_COMPLETE_DELAY: 500, // Wait for deletion animation/API call to complete
    MAX_BUTTON_WAIT_TIME: 3000, // Maximum time to wait for delete/confirm button to appear
    BUTTON_CHECK_INTERVAL: 100, // Interval for polling button appearance
    PAGE_REFRESH_DELAY: 1500, // Delay before refreshing page after batch delete
  } as const;

  private cleanupTasks: (() => void)[] = [];

  // Floating-mode state — an opt-in "always use a floating window for folders"
  // switch exposed in the popup. When on, we never attempt to inject the
  // folder panel into Gemini's sidebar; we mount the body-level floating
  // panel (or its FAB) + native ⋮ menu observer and call it a day. When off, normal
  // sidebar injection; a failure is a silent no-op.
  private floatingPanelHandle: FloatingPanelHandle | null = null;
  private floatingModeEnabled: boolean = false;
  private floatingOpenOnStart: boolean = true;
  private floatingModeActive: boolean = false;
  // When Gemini swaps its sidebar DOM for an unsupported layout (e.g. mobile
  // breakpoint at narrow viewport widths), our sidebar folder is removed and
  // we can't reinject. Instead of leaving the user stranded, we mount the
  // floating panel as a *temporary* fallback. This flag tracks that mode so
  // the recovery loop knows to retire the floating panel once the sidebar
  // anchor returns. It is distinct from `floatingModeActive`, which reflects
  // the user's *explicit* floating-mode toggle in the popup.
  private floatingFallbackActive: boolean = false;
  private sidebarAnchorMissingSince: number | null = null;
  // When the sidebar folder is attached but not actually usable (hidden while
  // the sidebar is open and not user-collapsed). Drives the visibility-aware
  // safety net so a broken-but-present folder still falls back to floating.
  private folderHiddenAnomalySince: number | null = null;
  private folderRecoveryTimer: number | null = null;
  private folderRecoveryInFlight: boolean = false;
  // Long-lived DOM-recovery watchers. Deliberately NOT registered via
  // `addCleanupTask`, so `reinitializeFolderUI`'s `runCleanupTasks()` cannot tear
  // them down: a reinit that bails mid-transition (sidebar/anchor not present yet)
  // must still leave the self-heal machinery running. Cleared only on full
  // teardown (`destroy` / `teardownMountedFolderRuntime`).
  private domRecoveryHandler: (() => void) | null = null;
  private domRecoveryDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Create storage adapter based on browser (Factory Pattern)
    this.storage = createFolderStorageAdapter();
    this.debug(`Using storage backend: ${this.storage.getBackendName()}`);

    // Initialize backup service with localStorage
    this.backupService = new DataBackupService<FolderData>('gemini-folders', validateFolderData);

    // Note: Data loading moved to init() for async support
    // This allows Safari to use async browser.storage API
    this.createTooltip();

    // Initialize i18n system
    initI18n().catch((e) => {
      this.debugWarn('Failed to initialize i18n:', e);
    });
  }

  async init(): Promise<void> {
    try {
      // Initialize storage adapter (handles migration for Safari automatically)
      await this.storage.init(STORAGE_KEY);

      // Setup automatic backup before page unload
      this.backupService.setupBeforeUnloadBackup(() => this.data);

      // Flush any pending debounced save on unload. The localStorage half of
      // the save is synchronous, so the data itself is safe; the
      // chrome.storage mirror is best-effort during unload.
      this.beforeUnloadFlushHandler = () => this.flushPendingSaveData();
      window.addEventListener('beforeunload', this.beforeUnloadFlushHandler);

      // Load account isolation setting/scope before reading folder data.
      await this.loadAccountIsolationSetting();
      await this.refreshAccountScope();

      // Load folder data (async, works for both Safari and non-Safari)
      await this.loadData();

      // Load folder enabled setting
      await this.loadFolderEnabledSetting();

      // Load the opt-in "always use floating window" mode. Off by default —
      // users flip it from the popup when they want to skip sidebar injection
      // entirely and work with folders in a floating panel.
      await this.loadFloatingModeSetting();

      // Load hide-archived onboarding nudge flag first, so loadHideArchivedSetting
      // can mark it "shown" if the user already has the feature enabled.
      await this.loadHideArchivedNudgeShownSetting();

      // Load hide archived setting
      await this.loadHideArchivedSetting();

      // Load folder anchor preference (which native section to sit above)
      await this.loadFolderAnchorSetting();
      await this.loadFoldersCollapsedSetting();

      // Load filter user setting
      await this.loadFilterUserSetting();
      await this.loadFolderSearchEnabledSetting();
      await this.loadFolderOnlySearchHintState();
      await this.loadFolderTreeIndentSetting();
      await this.loadFolderProjectEnabledSetting();
      await this.loadConversationSortModeSetting();

      // Set up storage change listener (always needed to respond to setting changes)
      this.setupStorageListener();

      // Set up message listener (for popup communication)
      this.setupMessageListener();

      // If folder feature is disabled, skip initialization
      if (!this.folderEnabled) {
        this.debug('Folder feature is disabled, skipping initialization');
        return;
      }

      // Two mounting strategies:
      //  - Floating mode (opt-in): body-level floating panel, skip sidebar.
      //  - Default: inject the folder panel into Gemini's sidebar.
      if (this.floatingModeEnabled) {
        await this.startFloatingMode();
      } else {
        await this.initializeFolderUI();
      }

      this.debug('Initialized successfully');
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        return;
      }
      console.error('[FolderManager] Initialization error:', error);
    }
  }

  /**
   * Cleanup method to prevent memory leaks
   * Clears all pending deletion timers and observers
   */
  destroy(): void {
    this.debug('Destroying FolderManager - cleaning up resources');
    this.isDestroyed = true;

    // Clear all pending removal timers
    let clearedCount = 0;
    this.pendingRemovals.forEach((timerId, conversationId) => {
      clearTimeout(timerId);
      clearedCount++;
      this.debug(`Cleared pending removal timer for ${conversationId}`);
    });
    this.pendingRemovals.clear();

    if (clearedCount > 0) {
      this.debug(`Cleared ${clearedCount} pending removal timer(s)`);
    }

    // Clear other timers
    if (this.longPressTimeout) {
      clearTimeout(this.longPressTimeout);
      this.longPressTimeout = null;
    }

    if (this.folderNameClickTimeout !== null) {
      clearTimeout(this.folderNameClickTimeout);
      this.folderNameClickTimeout = null;
    }

    this.clearFolderNavigationConfirmation();

    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }

    this.clearNativeTitleSyncTimer();
    this.clearConversationReorderIndicator();

    this.teardownDomRecoveryWatchers();
    this.folderRecoveryInFlight = false;

    // Flush a pending debounced save so a recent expand/collapse isn't lost,
    // then drop the unload flush hook.
    this.flushPendingSaveData();
    if (this.beforeUnloadFlushHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadFlushHandler);
      this.beforeUnloadFlushHandler = null;
    }
    this.clearFolderSearchDebounceTimer();

    // Disconnect mutation observers
    if (this.sideNavObserver) {
      this.sideNavObserver.disconnect();
      this.sideNavObserver = null;
    }

    if (this.conversationObserver) {
      this.conversationObserver.disconnect();
      this.conversationObserver = null;
    }
    this.cancelMutationBatchFlush();
    this.mutationBatchQueue.length = 0;
    this.cancelEnhancementDrain();

    if (this.nativeMenuObserver) {
      this.nativeMenuObserver.disconnect();
      this.nativeMenuObserver = null;
    }
    this.teardownMoveMenuTriggerListener();

    this.teardownPositionEnforcer();
    this.cleanupNotebooksAnchorButton();

    // Tear down floating-mode UI if it was surfaced.
    unmountFloatingModeNudge();
    unmountFloatingFab();
    if (this.floatingPanelHandle) {
      this.floatingPanelHandle.destroy();
      this.floatingPanelHandle = null;
    }

    // Remove event listeners
    if (this.routeChangeCleanup) {
      this.routeChangeCleanup();
      this.routeChangeCleanup = null;
    }

    if (this.sidebarClickListener && this.sidebarContainer) {
      try {
        this.sidebarContainer.removeEventListener('click', this.sidebarClickListener, true);
      } catch {
        // Ignore
      }
      this.sidebarClickListener = null;
    }

    // Remove outside click handler for multi-select
    this.removeOutsideClickHandler();

    // Remove tooltip
    if (this.tooltipElement) {
      this.tooltipElement.remove();
      this.tooltipElement = null;
    }

    // Remove active color picker
    if (this.activeColorPicker) {
      this.activeColorPicker.remove();
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
    }

    this.closeActiveImportExportMenu();
    this.closeActiveImportDialog();
    this.closeFolderConversationMenus();
    this.clearActiveFolderInput();

    // Remove container
    if (this.containerElement) {
      this.containerElement.remove();
      this.containerElement = null;
    }
    if (this.multiSelectHostElement) {
      this.multiSelectHostElement.remove();
      this.multiSelectHostElement = null;
    }

    // Execute custom cleanup tasks
    this.runCleanupTasks();

    this.debug('Cleanup complete');
  }

  private addCleanupTask(task: () => void): void {
    this.cleanupTasks.push(task);
  }

  private runCleanupTasks(): void {
    const tasks = this.cleanupTasks;
    this.cleanupTasks = [];

    tasks.forEach((task) => {
      try {
        task();
      } catch (error) {
        this.debugWarn('Folder runtime cleanup task failed:', error);
      }
    });
  }

  private teardownMountedFolderRuntime(): void {
    this.runCleanupTasks();

    this.pendingRemovals.forEach((timerId) => clearTimeout(timerId));
    this.pendingRemovals.clear();

    if (this.longPressTimeout) {
      clearTimeout(this.longPressTimeout);
      this.longPressTimeout = null;
    }

    if (this.folderNameClickTimeout !== null) {
      clearTimeout(this.folderNameClickTimeout);
      this.folderNameClickTimeout = null;
    }

    this.clearNativeTitleSyncTimer();

    this.teardownDomRecoveryWatchers();
    this.folderRecoveryInFlight = false;
    this.floatingFallbackActive = false;

    if (this.sideNavObserver) {
      this.sideNavObserver.disconnect();
      this.sideNavObserver = null;
    }

    if (this.conversationObserver) {
      this.conversationObserver.disconnect();
      this.conversationObserver = null;
    }
    this.cancelMutationBatchFlush();
    this.mutationBatchQueue.length = 0;
    this.cancelEnhancementDrain();

    if (this.nativeMenuObserver) {
      this.nativeMenuObserver.disconnect();
      this.nativeMenuObserver = null;
    }
    this.teardownMoveMenuTriggerListener();

    this.teardownPositionEnforcer();
    this.cleanupNotebooksAnchorButton();
    this.clearConversationReorderIndicator();
    this.flushPendingSaveData();
    this.clearFolderSearchDebounceTimer();
    this.stopFloatingMode();

    if (this.routeChangeCleanup) {
      try {
        this.routeChangeCleanup();
      } catch (error) {
        this.debugWarn('Route change cleanup failed:', error);
      }
      this.routeChangeCleanup = null;
    }

    if (this.sidebarClickListener && this.sidebarContainer) {
      try {
        this.sidebarContainer.removeEventListener('click', this.sidebarClickListener, true);
      } catch (error) {
        this.debugWarn('Sidebar click listener cleanup failed:', error);
      }
      this.sidebarClickListener = null;
    }

    this.removeOutsideClickHandler();
    this.closeActiveImportExportMenu();
    this.closeActiveImportDialog();
    this.closeFolderConversationMenus();
    this.clearActiveFolderInput();

    if (this.activeColorPicker) {
      this.activeColorPicker.remove();
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
    }

    if (this.containerElement) {
      this.containerElement.remove();
      this.containerElement = null;
    }
    if (this.multiSelectHostElement) {
      this.multiSelectHostElement.remove();
      this.multiSelectHostElement = null;
    }

    this.selectedConversations.clear();
    this.isMultiSelectMode = false;
    this.multiSelectSource = null;
    this.multiSelectFolderId = null;
    this.sidebarContainer = null;
    this.recentSection = null;
  }

  private clearActiveFolderInput(): void {
    this.activeFolderInput = null;
  }

  private closeActiveImportDialog(): void {
    if (this.activeImportDialog) {
      this.activeImportDialog.remove();
      this.activeImportDialog = null;
    }
  }

  private removeActiveImportExportMenuCloseHandler(): void {
    if (this.activeImportExportMenuListenerTimeout !== null) {
      clearTimeout(this.activeImportExportMenuListenerTimeout);
      this.activeImportExportMenuListenerTimeout = null;
    }

    if (this.activeImportExportMenuCloseHandler) {
      document.removeEventListener('click', this.activeImportExportMenuCloseHandler);
      this.activeImportExportMenuCloseHandler = null;
    }
  }

  private closeActiveImportExportMenu(): void {
    if (this.activeImportExportMenu) {
      this.activeImportExportMenu.remove();
      this.activeImportExportMenu = null;
    }

    this.removeActiveImportExportMenuCloseHandler();
  }

  private async initializeFolderUI(): Promise<void> {
    // Recovery and native-menu tracking must exist before waiting for Gemini's
    // lazily rendered sidebar. If that initial wait times out, these lifetime
    // watchers are what notice the sidebar later and finish initialization.
    this.ensureDomRecoveryWatchers();
    this.setupConversationClickTracking();
    this.setupNativeConversationMenuObserver();

    // Wait for sidebar to be available (with a hard timeout so a DOM change on
    // Gemini's side doesn't silently hang the folder feature forever).
    const sidebarFound = await this.waitForSidebar();
    if (!sidebarFound) {
      this.debugWarn('Sidebar anchor never appeared — folder panel unavailable');
      return;
    }

    if (!this.findRecentSection()) {
      this.debugWarn('Could not find Recent section — folder panel unavailable');
      return;
    }

    // Create and inject folder UI
    this.createFolderUI();

    this.setupNativeSidebarConversationEnhancements();

    // Set up sidebar visibility observer
    this.setupSideNavObserver();

    // Initial visibility check
    this.updateVisibilityBasedOnSideNav();
  }

  /**
   * Arm the long-lived DOM-recovery watchers: a debounced resize/print listener
   * plus the watchdog interval.
   *
   * Why these are lifetime-scoped and idempotent (NOT per-init cleanup tasks):
   * Gemini re-renders the sidebar DOM during window resize / window.print() /
   * the narrow-viewport mobile breakpoint, detaching the folder container. The
   * `sideNavObserver` (watching `side-nav-open` on #app-root) can't catch every
   * case — when the sidebar closes AND the DOM is rebuilt at once it fires with
   * isSideNavOpen=false and skips reinit.
   *
   *  - The debounced resize/print listener is a single-shot fallback for the
   *    common resize / split-screen / print cases.
   *  - The 2s watchdog interval *pulls*: it inspects what Gemini currently
   *    offers and decides whether the sidebar folder is recoverable now, or
   *    whether to surface the floating panel as a temporary fallback.
   *
   * Both are re-armed at the TOP of `initializeFolderUI` so that a reinit which
   * bails mid-transition (anchor not present yet) still leaves self-heal alive.
   * If they were torn down by `reinitializeFolderUI`'s `runCleanupTasks()` and
   * not re-armed before the bail, the folder would stay gone until a full page
   * reload.
   */
  private ensureDomRecoveryWatchers(): void {
    if (!this.domRecoveryHandler) {
      const domRecoveryCheck = () => {
        if (this.domRecoveryDebounceTimer !== null) clearTimeout(this.domRecoveryDebounceTimer);
        this.domRecoveryDebounceTimer = setTimeout(() => {
          this.domRecoveryDebounceTimer = null;
          if (this.isDestroyed) return;
          if (this.isSidebarFolderMountedInCurrentSidebar()) {
            return; // Everything still attached – nothing to do.
          }
          // Only reinitialize if the sidebar is currently visible (open).
          // If it is closed, the sideNavObserver will trigger reinitialization
          // when it reopens.
          if (!this.isSideNavOpen()) {
            this.debug('DOM recovery: container lost but sidebar closed, deferring');
            return;
          }
          this.debug('DOM recovery: folder UI lost from DOM, reinitializing');
          this.reinitializeFolderUI();
        }, 800);
      };
      this.domRecoveryHandler = domRecoveryCheck;
      window.addEventListener('resize', domRecoveryCheck);
      window.addEventListener('gv-print-cleanup', domRecoveryCheck);
      window.addEventListener('afterprint', domRecoveryCheck);
    }

    if (this.folderRecoveryTimer === null) {
      this.folderRecoveryTimer = window.setInterval(() => {
        void this.runFolderRecoveryTick();
      }, 2000);
    }
  }

  /**
   * Tear down the lifetime-scoped DOM-recovery watchers. Called only from full
   * teardown paths (`destroy`, `teardownMountedFolderRuntime`) — never from
   * `reinitializeFolderUI`, which relies on these surviving.
   */
  private teardownDomRecoveryWatchers(): void {
    if (this.domRecoveryDebounceTimer !== null) {
      clearTimeout(this.domRecoveryDebounceTimer);
      this.domRecoveryDebounceTimer = null;
    }
    if (this.domRecoveryHandler) {
      window.removeEventListener('resize', this.domRecoveryHandler);
      window.removeEventListener('gv-print-cleanup', this.domRecoveryHandler);
      window.removeEventListener('afterprint', this.domRecoveryHandler);
      this.domRecoveryHandler = null;
    }
    if (this.folderRecoveryTimer !== null) {
      clearInterval(this.folderRecoveryTimer);
      this.folderRecoveryTimer = null;
    }
  }

  /**
   * Decide each tick whether the folder UI is in the right place for what
   * Gemini's sidebar currently looks like. Three states matter:
   *
   *   1. Sidebar folder is alive in DOM → if a floating fallback is up from a
   *      previous narrow-viewport detour, tear it down. The sidebar is the
   *      preferred home.
   *   2. Folder is missing AND Gemini's sidebar anchor (overflow-container +
   *      chats-expandable-section) is present → reinject the sidebar folder.
   *      `reinitializeFolderUI` already handles the teardown / re-find dance.
   *   3. Folder is missing AND the anchor is also missing → Gemini probably
   *      swapped to a layout we can't host in (e.g. mobile). Mount the
   *      floating panel so the user doesn't lose access to their folders.
   *
   * We skip the whole loop when the user has explicitly opted into floating
   * mode (then the popup-controlled `floatingModeActive` owns the panel) or
   * when a reinit is already mid-flight. The `folderRecoveryInFlight` flag
   * guards against overlapping ticks while we await the async openFloatingPanel.
   */
  private async runFolderRecoveryTick(): Promise<void> {
    if (this.isDestroyed) return;
    if (!this.folderEnabled) return;
    // User explicitly picked floating in the popup — don't mess with their UI.
    if (this.floatingModeEnabled || this.floatingModeActive) return;
    if (this.reinitializePromise) return;
    if (this.folderRecoveryInFlight) return;

    const currentSidebar = this.findCurrentSidebarContainer();
    const sidebarAnchor = currentSidebar ? this.findFolderAnchorCandidateIn(currentSidebar) : null;
    const sidebarFolderAlive = this.isSidebarFolderMountedInCurrentSidebar(currentSidebar);

    if (sidebarFolderAlive) {
      this.sidebarAnchorMissingSince = null;
      if (currentSidebar && this.sidebarContainer !== currentSidebar) {
        this.sidebarContainer = currentSidebar;
        this.setupNativeSidebarConversationEnhancements();
        this.setupPositionEnforcer();
      }

      // Visibility-aware safety net: "attached" ≠ "usable". A folder that is
      // mounted but invisible while the sidebar is open (and not user-collapsed)
      // is broken — historically this slipped through because recovery only
      // checked presence, so a stale display:none made folders vanish with no
      // floating fallback. Treat it as a fault, after a short grace so sidebar
      // open/close animations don't flicker the fallback.
      if (!this.isSidebarFolderUsable()) {
        const now = Date.now();
        if (this.folderHiddenAnomalySince === null) this.folderHiddenAnomalySince = now;
        if (now - this.folderHiddenAnomalySince < FOLDER_HIDDEN_ANOMALY_GRACE_MS) {
          this.debug('Recovery: folder attached but hidden while sidebar open — within grace');
          return;
        }
        this.folderHiddenAnomalySince = null;
        // Cheap repair first: drop a stale inline hide and re-evaluate. Covers
        // the common case (a detection miss left display:none on the container).
        this.containerElement?.style.removeProperty('display');
        this.updateVisibilityBasedOnSideNav();
        if (this.isSidebarFolderUsable()) {
          this.debug('Recovery: cleared stale hide — sidebar folder usable again');
          return;
        }
        // Still hidden by something outside our control → surface the floating
        // panel so folders stay reachable (the whole reason floating mode exists).
        if (this.floatingFallbackActive || this.floatingPanelHandle) return;
        this.debug('Recovery: sidebar folder unusable — surfacing floating fallback');
        this.folderRecoveryInFlight = true;
        try {
          this.floatingFallbackActive = true;
          await this.openFloatingPanel();
        } catch (error) {
          this.floatingFallbackActive = false;
          this.debugWarn('Recovery: failed to mount floating fallback (hidden folder):', error);
        } finally {
          this.folderRecoveryInFlight = false;
        }
        return;
      }
      this.folderHiddenAnomalySince = null;

      // The sidebar is hosting the folder right now. If we left a floating
      // fallback up from a previous transition, retire it.
      if (this.floatingFallbackActive) {
        this.debug('Recovery: sidebar folder restored — retiring floating fallback');
        this.floatingFallbackActive = false;
        if (this.floatingPanelHandle) {
          this.floatingPanelHandle.destroy();
          this.floatingPanelHandle = null;
        }
      }
      // Belt-and-suspenders: if the position observer ever misses a mutation
      // (e.g. it was torn down across a reinit and not yet re-attached), the
      // recovery tick repairs the ordering here. No-op when already correct.
      this.enforceFolderAboveRecents();
      return;
    }
    this.folderHiddenAnomalySince = null;

    if (sidebarAnchor) {
      this.sidebarAnchorMissingSince = null;
      // The sidebar is back to a layout we can inject into but the folder
      // isn't there. This usually means a previous reinit ran mid-transition
      // and lost the race against Gemini's render. Retry now.
      this.debug('Recovery: sidebar anchor present but folder missing — reinit');
      // If a floating fallback is up, retire it before reinjecting the sidebar
      // version so we don't briefly have both visible.
      if (this.floatingFallbackActive) {
        this.floatingFallbackActive = false;
        if (this.floatingPanelHandle) {
          this.floatingPanelHandle.destroy();
          this.floatingPanelHandle = null;
        }
      }
      this.reinitializeFolderUI();
      return;
    }

    if (currentSidebar) {
      const now = Date.now();
      if (this.sidebarAnchorMissingSince === null) {
        this.sidebarAnchorMissingSince = now;
      }
      const missingDuration = now - this.sidebarAnchorMissingSince;
      if (missingDuration < SIDEBAR_ANCHOR_FALLBACK_GRACE_MS) {
        this.debug('Recovery: sidebar anchor missing temporarily — waiting');
        return;
      }
    } else {
      this.sidebarAnchorMissingSince = null;
    }

    // Anchor is gone — Gemini moved the goalposts. Surface the floating panel
    // so folders stay reachable, but mark it as a fallback so we can tear it
    // back down once the sidebar returns. Only mount once per detour.
    if (this.floatingFallbackActive || this.floatingPanelHandle) return;
    this.debug('Recovery: sidebar anchor missing — mounting floating fallback');
    this.folderRecoveryInFlight = true;
    try {
      this.floatingFallbackActive = true;
      await this.openFloatingPanel();
    } catch (error) {
      this.floatingFallbackActive = false;
      this.debugWarn('Recovery: failed to mount floating fallback:', error);
    } finally {
      this.folderRecoveryInFlight = false;
    }
  }

  /**
   * Polls for the Gemini sidebar anchor. Resolves true when found, false if the
   * configurable timeout elapses first. The timeout path lets the caller surface
   * a floating-mode fallback UI instead of spinning forever when Google changes
   * the sidebar DOM.
   *
   * Users can force the failure path for testing by setting
   * `localStorage['gv-force-folder-fail'] = '1'` in the Gemini page and
   * reloading.
   */
  private async waitForSidebar(timeoutMs: number = 10000): Promise<boolean> {
    try {
      if (localStorage.getItem('gv-force-folder-fail') === '1') {
        console.warn('[FolderManager] gv-force-folder-fail is set — simulating sidebar failure');
        return false;
      }
    } catch {}
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const checkSidebar = () => {
        const container = this.findCurrentSidebarContainer();
        if (container) {
          this.sidebarContainer = container as HTMLElement;
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(checkSidebar, 500);
      };
      checkSidebar();
    });
  }

  private setupNativeSidebarConversationEnhancements(): void {
    this.makeConversationsDraggable();
    this.setupMutationObserver();
  }

  private setupFloatingModeSidebarInteractions(): void {
    const existingSidebar = this.findCurrentSidebarContainer();
    if (existingSidebar instanceof HTMLElement) {
      this.sidebarContainer = existingSidebar;
      this.setupNativeSidebarConversationEnhancements();
      return;
    }

    void this.waitForSidebar()
      .then((sidebarFound) => {
        if (!sidebarFound) {
          this.debugWarn('Sidebar anchor never appeared — native batch actions unavailable');
          return;
        }
        if (this.isDestroyed || !this.folderEnabled || !this.floatingModeActive) return;
        this.setupNativeSidebarConversationEnhancements();
      })
      .catch((error) => {
        this.debugWarn('Failed to initialize native sidebar interactions in floating mode:', error);
      });
  }

  /**
   * Sidebar injection failed — surface a one-time nudge letting the user pop
   * the folder panel out as a floating window. If they've already dismissed the
   * nudge or already have the floating panel open, skip straight to mounting it.
   *
   * @param reason free-form debug label (anchor-missing, recent-section-missing, etc.)
   */
  /**
   * Enter "always floating" mode. User has explicitly flipped the popup
   * toggle, so we skip the onboarding nudge entirely and drop the panel
   * or the persistent FAB onto the page based on their startup preference.
   * The native ⋮ → "Move to folder" observers are wired up here too so users
   * can file conversations without the panel being open.
   */
  private async startFloatingMode(openPanel = this.floatingOpenOnStart): Promise<void> {
    if (this.isDestroyed || !this.folderEnabled) return;
    if (this.floatingModeActive) return;
    this.floatingModeActive = true;
    this.debug('Entering floating mode');

    this.setupConversationClickTracking();
    this.setupNativeConversationMenuObserver();
    this.setupFloatingModeSidebarInteractions();

    if (openPanel) {
      await this.openFloatingPanel();
    } else {
      this.showFloatingFab();
    }
  }

  /**
   * Leave floating mode — tear down the body-level UI. Safe to call when
   * floating mode was never entered.
   */
  private stopFloatingMode(): void {
    this.floatingModeActive = false;
    unmountFloatingModeNudge();
    unmountFloatingFab();
    if (this.floatingPanelHandle) {
      this.floatingPanelHandle.destroy();
      this.floatingPanelHandle = null;
    }
    if (this.multiSelectHostElement) {
      this.multiSelectHostElement.remove();
      this.multiSelectHostElement = null;
    }
  }

  /**
   * Mounts the small persistent FAB button in the corner. Safe to call multiple
   * times — the module is idempotent. Hydrates and persists position via
   * chrome.storage.sync so the user's chosen spot sticks across reloads.
   */
  private showFloatingFab(): void {
    // Fire-and-forget position read — worst case the FAB lands in its default
    // bottom-right spot for a frame before we re-place it.
    void browser.storage.sync
      .get({ [StorageKeys.FOLDER_FLOATING_FAB_POS]: null })
      .then((raw) => {
        const candidate = raw[StorageKeys.FOLDER_FLOATING_FAB_POS] as unknown;
        let storedPos: FloatingFabPos | null = null;
        if (
          candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as FloatingFabPos).x === 'number' &&
          typeof (candidate as FloatingFabPos).y === 'number'
        ) {
          storedPos = candidate as FloatingFabPos;
        }
        mountFloatingFab({
          storedPos,
          onClick: () => {
            void this.openFloatingPanel();
          },
          onPosChange: (pos) => {
            void browser.storage.sync
              .set({ [StorageKeys.FOLDER_FLOATING_FAB_POS]: pos })
              .catch((error) => {
                if (!isExtensionContextInvalidatedError(error)) {
                  this.debugWarn('Failed to persist floating FAB position:', error);
                }
              });
          },
        });
      })
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) return;
        this.debugWarn('Failed to read floating FAB position:', error);
        // Still mount at default position so feature degrades gracefully.
        mountFloatingFab({
          onClick: () => {
            void this.openFloatingPanel();
          },
        });
      });
  }

  private async openFloatingPanel(): Promise<void> {
    if (this.isDestroyed || !this.folderEnabled) return;
    if (this.floatingPanelHandle) return;
    unmountFloatingModeNudge();
    // Only one entry point visible at a time — FAB hides when the panel is up.
    unmountFloatingFab();

    let storedPos: FloatingPanelPos | null = null;
    let storedSize: FloatingPanelSize | null = null;
    try {
      const raw = await browser.storage.sync.get({
        [StorageKeys.FOLDER_FLOATING_POS]: null,
        [StorageKeys.FOLDER_FLOATING_SIZE]: null,
      });
      const posCandidate = raw[StorageKeys.FOLDER_FLOATING_POS] as unknown;
      if (
        posCandidate &&
        typeof posCandidate === 'object' &&
        typeof (posCandidate as FloatingPanelPos).x === 'number' &&
        typeof (posCandidate as FloatingPanelPos).y === 'number'
      ) {
        storedPos = posCandidate as FloatingPanelPos;
      }
      const sizeCandidate = raw[StorageKeys.FOLDER_FLOATING_SIZE] as unknown;
      if (
        sizeCandidate &&
        typeof sizeCandidate === 'object' &&
        typeof (sizeCandidate as FloatingPanelSize).w === 'number' &&
        typeof (sizeCandidate as FloatingPanelSize).h === 'number'
      ) {
        storedSize = sizeCandidate as FloatingPanelSize;
      }
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      this.debugWarn('Failed to read floating-mode position/size:', error);
    }

    if (this.isDestroyed || !this.folderEnabled) return;

    // All mutation callbacks share the same tail: persist to storage, which
    // itself pushes a fresh snapshot into the floating panel (saveData's
    // centralised `floatingPanelHandle?.update` hook). Calling update here
    // too rendered the panel twice per mutation.
    const afterMutation = (): void => {
      void this.saveData();
    };

    this.floatingPanelHandle = mountFloatingPanel({
      data: this.data,
      conversationSortMode: this.conversationSortMode,
      storedPos,
      storedSize,
      onPosChange: (pos) => {
        void browser.storage.sync.set({ [StorageKeys.FOLDER_FLOATING_POS]: pos }).catch((error) => {
          if (!isExtensionContextInvalidatedError(error)) {
            this.debugWarn('Failed to persist floating-mode position:', error);
          }
        });
      },
      // Fires once, 300ms after the last resize observed by the panel, so
      // storage.sync isn't spammed with every intermediate size during a drag.
      onSizeChange: (size) => {
        void browser.storage.sync
          .set({ [StorageKeys.FOLDER_FLOATING_SIZE]: size })
          .catch((error) => {
            if (!isExtensionContextInvalidatedError(error)) {
              this.debugWarn('Failed to persist floating-mode size:', error);
            }
          });
      },
      onClose: () => {
        this.floatingPanelHandle = null;
        // Panel is gone — bring the FAB back so the user can re-open later.
        this.showFloatingFab();
      },
      onNavigate: (conv) => {
        if (conv.url) {
          this.navigateToConversation(conv.url, conv);
        }
      },
      onCreateFolder: (name, parentId) => {
        const maxSortIndex = this.data.folders
          .filter((f) => f.parentId === parentId)
          .reduce((max, f) => Math.max(max, f.sortIndex ?? -1), -1);
        const folder: Folder = {
          id: this.generateId(),
          name,
          parentId,
          isExpanded: true,
          sortIndex: maxSortIndex + 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.data.folders.push(folder);
        this.data.folderContents[folder.id] = [];
        afterMutation();
      },
      onRenameFolder: (folderId, newName) => {
        const folder = this.data.folders.find((f) => f.id === folderId);
        if (!folder) return;
        folder.name = newName;
        folder.updatedAt = Date.now();
        afterMutation();
      },
      onDeleteFolder: (folderId) => {
        const foldersToDelete = this.getFolderAndDescendants(folderId);
        this.data.folders = this.data.folders.filter((f) => !foldersToDelete.includes(f.id));
        foldersToDelete.forEach((id) => {
          delete this.data.folderContents[id];
        });
        afterMutation();
      },
      // These delegate to the shared data paths, which persist via saveData —
      // and saveData's centralised hook already pushes the fresh snapshot into
      // the floating panel, so no explicit update calls are needed here.
      onRemoveConversation: (folderId, conversationId) => {
        // Reuse the existing data-only removal path; it already calls saveData
        // + refresh (sidebar refresh is a no-op when the sidebar isn't mounted).
        this.removeConversationFromFolder(folderId, conversationId);
      },
      onToggleStar: (folderId, conversationId) => {
        this.toggleConversationStar(folderId, conversationId);
      },
      onToggleFolderPinned: (folderId) => {
        this.togglePinFolder(folderId);
      },
      // Intra-panel conversation move: user dragged a conversation row from
      // folder A to folder B inside the floating panel. Cross-document drag
      // (native Gemini row → panel) is intentionally NOT wired — that path
      // proved unreliable; the user files new conversations via the native
      // ⋮ → "Move to folder" menu instead.
      onMoveConversation: (conversationId, fromFolderId, toFolderId) => {
        const conv = this.data.folderContents[fromFolderId]?.find(
          (c) => c.conversationId === conversationId,
        );
        if (!conv) return;
        this.moveConversationToFolder(fromFolderId, toFolderId, conv);
      },
      onSetFolderColor: (folderId, color) => {
        this.changeFolderColor(folderId, color);
      },
      // Cloud sync / upload — mirror what the sidebar's header buttons do.
      // Only wire on non-Safari; the floating panel hides these buttons on
      // Safari because our Drive OAuth2 flow is not supported there yet. The
      // panel reads `isSafari()` itself, but we still guard here so callbacks
      // stay undefined on Safari and nothing fires by accident.
      //
      // onCloudSync can mutate this.data (merges Drive payload locally); it
      // persists via saveData, whose centralised hook pushes the merged
      // snapshot into the floating panel. onCloudUpload is read-only locally.
      ...(isSafari()
        ? {}
        : {
            onCloudUpload: () => {
              void this.handleCloudUpload();
            },
            onCloudSync: () => {
              void this.handleCloudSync();
            },
            getCloudUploadTooltip: () => this.getCloudUploadTooltip(),
            getCloudSyncTooltip: () => this.getCloudSyncTooltip(),
          }),
    });
  }

  /**
   * Re-query the current Notebooks section element. Only the 2026 layout
   * exposes this — older layouts return null and the caller falls back to the
   * Recents anchor. Pure (no instance state touched).
   */
  private findNotebooksSectionCandidate(): HTMLElement | null {
    if (!this.sidebarContainer) return null;
    return this.findNotebooksSectionCandidateIn(this.sidebarContainer);
  }

  private findNotebooksSectionCandidateIn(sidebar: HTMLElement): HTMLElement | null {
    const notebooks = sidebar.querySelector(
      'expandable-section[data-test-id="notebooks-expandable-section"]',
    );
    return notebooks instanceof HTMLElement ? notebooks : null;
  }

  /**
   * Resolve the section element the folder panel should anchor immediately
   * above, honoring the user's `folderAnchor` preference. Falls back to the
   * Recents section when 'above-notebooks' is requested but the Notebooks
   * section isn't present (e.g. legacy layout, not signed in to Notebooks).
   */
  private findFolderAnchorCandidate(): HTMLElement | null {
    if (!this.sidebarContainer) return null;
    return this.findFolderAnchorCandidateIn(this.sidebarContainer);
  }

  private findFolderAnchorCandidateIn(sidebar: HTMLElement): HTMLElement | null {
    if (this.folderAnchor === 'above-notebooks') {
      const notebooks = this.findNotebooksSectionCandidateIn(sidebar);
      if (notebooks) return notebooks;
    }
    return this.findRecentSectionCandidateIn(sidebar);
  }

  /**
   * Pure re-query for the current Recents section element. Returns the
   * `expandable-section[data-test-id="chats-expandable-section"]` wrapper when
   * Gemini's new layout is in effect, or one of the legacy containers as a
   * fallback. Does NOT touch instance state — callers decide whether to update
   * `this.recentSection`. This is the single place the lookup logic lives so
   * `findRecentSection` and `enforceFolderAboveRecents` can't drift apart.
   */
  private findRecentSectionCandidate(): HTMLElement | null {
    if (!this.sidebarContainer) return null;
    return this.findRecentSectionCandidateIn(this.sidebarContainer);
  }

  private findRecentSectionCandidateIn(sidebar: HTMLElement): HTMLElement | null {
    const promoteToSection = (el: Element | null): Element | null =>
      el ? (el.closest('expandable-section') ?? el) : null;

    let conversationsList: Element | null = sidebar.querySelector(
      'expandable-section[data-test-id="chats-expandable-section"]',
    );

    if (!conversationsList) {
      conversationsList = promoteToSection(
        sidebar.querySelector('[data-test-id="all-conversations"]'),
      );
    }

    if (!conversationsList) {
      conversationsList = promoteToSection(sidebar.querySelector('.chat-history'));
    }

    if (!conversationsList) {
      const conversationItems = sidebar.querySelectorAll('[data-test-id="conversation"]');
      if (conversationItems.length > 0) {
        conversationsList =
          conversationItems[0].closest('expandable-section') ??
          conversationItems[0].closest('.chat-history, [class*="conversation"]');
      }
    }

    return conversationsList instanceof HTMLElement ? conversationsList : null;
  }

  private findCurrentSidebarContainer(): HTMLElement | null {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-test-id="overflow-container"]'),
    );
    if (candidates.length === 0) return null;

    const visible = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    return visible ?? candidates[0];
  }

  private isSidebarFolderMountedInCurrentSidebar(
    currentSidebar: HTMLElement | null = this.findCurrentSidebarContainer(),
  ): boolean {
    if (!this.containerElement || !document.body.contains(this.containerElement)) return false;
    if (!currentSidebar || !document.body.contains(currentSidebar)) return false;
    if (!currentSidebar.contains(this.containerElement)) return false;
    return !!this.findFolderAnchorCandidateIn(currentSidebar);
  }

  private findRecentSection(): boolean {
    if (!this.sidebarContainer) return false;

    // Honor folderAnchor on first injection so the panel lands in the right
    // slot without needing a follow-up enforcer pass. Falls through to the
    // Recents candidate when the requested anchor isn't present.
    const candidate = this.findFolderAnchorCandidate();
    if (candidate) {
      this.recentSection = candidate;
      return true;
    }

    this.recentSection = null;
    this.debugWarn('Could not find Recent section - waiting for recovery tick');
    return false;
  }

  /**
   * Ensure the folder container is positioned immediately before whichever
   * section element matches the current `folderAnchor` preference. Gemini
   * periodically replaces section elements wholesale during the 2026 redesign,
   * which would leave our folder container stranded below the new anchor.
   * This is the recovery hook.
   *
   * Returns `true` when a move occurred. No-ops (and returns `false`) once the
   * container is already correctly placed, so it's safe to call from
   * MutationObserver callbacks without creating an infinite reorder loop.
   *
   * Kept under the old name (`...AboveRecents`) because Recents is the default
   * anchor; semantically it now means "above the current anchor section".
   */
  private enforceFolderAboveRecents(): boolean {
    if (this.isDestroyed) return false;
    if (!this.folderEnabled || this.floatingModeActive) return false;
    if (!this.containerElement || !document.body.contains(this.containerElement)) {
      return false;
    }

    const anchorSection = this.findFolderAnchorCandidate();
    if (!anchorSection || !anchorSection.parentElement) return false;

    // Refresh stale reference whenever Gemini replaced the section element.
    if (this.recentSection !== anchorSection) {
      this.recentSection = anchorSection;
    }

    // Piggyback on every enforcer tick to re-attach the Notebooks corner
    // toggle if Gemini swapped the Notebooks section element. Cheap no-op
    // when it's already correctly mounted.
    this.ensureNotebooksAnchorButton();

    const parent = anchorSection.parentElement;
    const inRightParent = this.containerElement.parentElement === parent;
    const immediatelyBefore = this.containerElement.nextElementSibling === anchorSection;

    if (inRightParent && immediatelyBefore) return false;

    this.debug('Re-anchoring folder container above', this.folderAnchor);
    parent.insertBefore(this.containerElement, anchorSection);
    return true;
  }

  private scheduleEnforceFolderAboveRecents(): void {
    if (this.positionEnforceRafId !== null) return;
    this.positionEnforceRafId = window.requestAnimationFrame(() => {
      this.positionEnforceRafId = null;
      this.enforceFolderAboveRecents();
    });
  }

  private getPositionObserverTarget(): HTMLElement | null {
    const anchorSection = this.findFolderAnchorCandidate();
    if (anchorSection?.parentElement instanceof HTMLElement) {
      return anchorSection.parentElement;
    }
    return this.sidebarContainer;
  }

  /**
   * Watch the section list for anchor swaps and re-enforce position on the next
   * animation frame. Keep this scoped to the anchor's direct parent: Gemini can
   * add hundreds of nested nodes while expanding Recents, and those should not
   * wake the position enforcer.
   */
  private setupPositionEnforcer(): void {
    if (!this.sidebarContainer) return;
    if (this.positionObserver) {
      this.positionObserver.disconnect();
      this.positionObserver = null;
    }
    const observeTarget = this.getPositionObserverTarget();
    if (!observeTarget) return;

    this.positionObserver = new MutationObserver(() => {
      this.scheduleEnforceFolderAboveRecents();
    });
    this.positionObserver.observe(observeTarget, {
      childList: true,
    });
  }

  private teardownPositionEnforcer(): void {
    if (this.positionObserver) {
      this.positionObserver.disconnect();
      this.positionObserver = null;
    }
    if (this.positionEnforceRafId !== null) {
      window.cancelAnimationFrame(this.positionEnforceRafId);
      this.positionEnforceRafId = null;
    }
  }

  private createFolderUI(): void {
    if (!this.recentSection) return;

    // Idempotency guard. Gemini can clone the sidebar subtree during
    // virtualization, leaving behind a folder container that this manager did
    // not create (and therefore does not track via `containerElement`). Remove
    // both the tracked container and any untracked direct sibling before
    // mounting the current panel.
    if (this.containerElement) {
      this.containerElement.remove();
      this.containerElement = null;
    }
    const sectionParent = this.recentSection.parentElement;
    if (sectionParent) {
      Array.from(sectionParent.children).forEach((child) => {
        if (
          child instanceof HTMLElement &&
          child.classList.contains('gv-folder-container') &&
          !child.classList.contains('gv-aistudio') &&
          !child.classList.contains('gv-multi-select-floating-host')
        ) {
          child.remove();
        }
      });
    }

    // Create folder container
    this.containerElement = document.createElement('div');
    this.containerElement.className = 'gv-folder-container';

    // Create multi-select mode indicator
    const indicator = this.createMultiSelectIndicator();
    this.containerElement.appendChild(indicator);

    // Create header
    const header = this.createHeader();
    this.containerElement.appendChild(header);

    if (this.folderSearchEnabled) {
      const search = this.createFolderSearch();
      this.containerElement.appendChild(search);
    }

    // Create folders list
    const foldersList = this.createFoldersList();
    this.containerElement.appendChild(foldersList);
    this.applyFoldersCollapsedState();

    // Insert before Recent section
    this.recentSection.parentElement?.insertBefore(this.containerElement, this.recentSection);

    // Initial active conversation highlight and route listeners
    this.highlightActiveConversationInFolders();
    this.installRouteChangeListener();
    this.installSidebarClickListener();

    // Apply initial folder enabled setting
    this.applyFolderEnabledSetting();

    // Wire up the position enforcer so future Gemini re-renders that swap the
    // Recents section element can't strand our folder container below it.
    this.setupPositionEnforcer();

    // Paint the Notebooks corner swap toggle in its initial state (mounts on
    // the current Notebooks section, syncs tooltip + active class). The
    // enforcer keeps it up to date when Gemini re-renders that section.
    this.ensureNotebooksAnchorButton();
  }

  private createMultiSelectIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'gv-multi-select-indicator';
    indicator.dataset.multiSelectIndicator = 'true';

    // Apply floating styles
    Object.assign(indicator.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '9999', // Ensure it's above everything
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      cursor: 'move', // Indicate it's draggable
      transition: 'opacity 0.2s ease, transform 0.1s ease', // Only animate non-position props for performance
      // Prevent text selection while dragging
      userSelect: 'none',
      // Ensure it has a background so IT covers content behind it
      backgroundColor: 'var(--gem-sys-color-surface-container, #f0f4f9)', // Fallback color
      borderRadius: '24px',
      padding: '8px 16px',
      alignItems: 'center',
      gap: '12px',
      border: '1px solid var(--gem-sys-color-outline-variant, rgba(0,0,0,0.1))',
    });

    // --- Draggable Logic Start ---
    let isDragging = false;
    let currentX: number;
    let currentY: number;
    let initialX: number;
    let initialY: number;
    let xOffset = 0;
    let yOffset = 0;

    // Document-level mousemove/mouseup are attached only while a drag is in
    // progress (mousedown → mouseup). Attaching them permanently leaked one
    // listener pair per floating-mode/sidebar-mode switch, because that switch
    // path rebuilds the indicator without running the cleanup task list.
    const drag = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, indicator);
      }
    };

    const dragEnd = () => {
      isDragging = false;
      indicator.style.cursor = 'move';
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    };

    const dragStart = (e: MouseEvent) => {
      // Ignore if clicking buttons inside the indicator
      if ((e.target as HTMLElement).closest('button')) return;

      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (e.target === indicator || indicator.contains(e.target as Node)) {
        isDragging = true;
        indicator.style.cursor = 'grabbing';
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
      }
    };

    const setTranslate = (xPos: number, yPos: number, el: HTMLElement) => {
      el.style.transform = `translate3d(calc(-50% + ${xPos}px), ${yPos}px, 0)`;
    };

    indicator.addEventListener('mousedown', dragStart);

    // Belt-and-suspenders: if the indicator is torn down mid-drag, make sure
    // the document-level listeners can't outlive it. removeEventListener is
    // idempotent, so this is safe even when no drag is active.
    this.addCleanupTask(() => {
      indicator.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    });
    // --- Draggable Logic End ---

    const content = document.createElement('div');
    content.className = 'gv-multi-select-indicator-content';
    // Ensure content (text/icon) doesn't capture drag events aggressively
    content.style.pointerEvents = 'none';

    const icon = document.createElement('mat-icon');
    icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'check_circle';

    const text = document.createElement('span');
    text.className = 'gv-multi-select-indicator-text';
    text.textContent = '0 selected';
    text.dataset.selectionCount = 'true';

    content.appendChild(icon);
    content.appendChild(text);
    indicator.appendChild(content);

    // Actions container (will be populated dynamically)
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-multi-select-actions';
    actionsContainer.dataset.multiSelectActions = 'true';
    // Re-enable pointer events for buttons
    actionsContainer.style.pointerEvents = 'auto';
    indicator.appendChild(actionsContainer);

    return indicator;
  }

  private getMultiSelectHost(): HTMLElement | null {
    if (this.containerElement?.isConnected) {
      return this.containerElement;
    }

    if (!this.multiSelectHostElement?.isConnected) {
      const host = document.createElement('div');
      host.className = 'gv-folder-container gv-multi-select-floating-host';
      host.dataset.multiSelectFloatingHost = 'true';
      host.appendChild(this.createMultiSelectIndicator());
      document.body.appendChild(host);
      this.multiSelectHostElement = host;
    }

    return this.multiSelectHostElement;
  }

  private getExistingMultiSelectHost(): HTMLElement | null {
    if (this.containerElement?.isConnected) {
      return this.containerElement;
    }

    return this.multiSelectHostElement?.isConnected ? this.multiSelectHostElement : null;
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'gv-folder-header';

    // Match the style of Recent section title
    const titleContainer = document.createElement('div');
    titleContainer.className = 'title-container';

    const title = document.createElement('h1');
    title.className = 'title gds-label-l'; // Match Recent section style
    title.textContent = this.t('folder_title');
    title.style.visibility = 'visible';

    const collapseButton = document.createElement('button');
    collapseButton.className = 'gv-folder-section-toggle';
    collapseButton.type = 'button';
    collapseButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void this.toggleFoldersCollapsed();
    });
    collapseButton.innerHTML = '<span class="google-symbols" aria-hidden="true"></span>';

    titleContainer.appendChild(collapseButton);
    titleContainer.appendChild(title);

    // Actions container for buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-folder-header-actions';

    // Filter current user button
    const filterUserButton = document.createElement('button');
    filterUserButton.className = 'gv-folder-action-btn';
    filterUserButton.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">person</mat-icon>`;
    filterUserButton.title = this.t('folder_filter_current_user');
    // Apply active state if filter is enabled
    if (this.filterCurrentUserOnly) {
      filterUserButton.classList.add('gv-filter-active');
    }
    filterUserButton.addEventListener('click', () => this.toggleFilterCurrentUser());

    // Import/Export combined button (shows dropdown menu)
    const importExportButton = document.createElement('button');
    importExportButton.className = 'gv-folder-action-btn';
    importExportButton.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">folder_managed</mat-icon>`;
    importExportButton.title = this.t('folder_import_export');
    importExportButton.addEventListener('click', (e) => this.showImportExportMenu(e));

    actionsContainer.appendChild(filterUserButton);
    actionsContainer.appendChild(importExportButton);

    // Cloud popover (single button → menu with Upload + Sync). Skipped on Safari.
    if (!isSafari()) {
      const cloudButton = document.createElement('button');
      cloudButton.className = 'gv-folder-action-btn';
      cloudButton.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">cloud</mat-icon>`;
      cloudButton.title = this.t('folder_cloud');
      cloudButton.addEventListener('click', (e) => this.showCloudMenu(e));
      actionsContainer.appendChild(cloudButton);
    }

    // Folder settings (conversation order, font size, spacing, and indentation).
    const settingsButton = document.createElement('button');
    settingsButton.className = 'gv-folder-action-btn gv-folder-settings-btn';
    settingsButton.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">settings</mat-icon>`;
    settingsButton.title = this.t('folder_settings');
    settingsButton.addEventListener('click', (e) => this.showFolderSettingsMenu(e));
    actionsContainer.appendChild(settingsButton);

    // Add folder button
    const addButton = document.createElement('button');
    addButton.className = 'gv-folder-add-btn';
    addButton.innerHTML = `<mat-icon role="img" class="mat-icon notranslate gds-icon-l google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">add</mat-icon>`;
    addButton.title = this.t('folder_create');
    addButton.addEventListener('click', () => this.createFolder());

    actionsContainer.appendChild(addButton);

    header.appendChild(titleContainer);
    header.appendChild(actionsContainer);

    // Setup root drop zone on header
    this.setupRootDropZone(header);

    return header;
  }

  private createFolderSearch(): HTMLElement {
    const searchContainer = document.createElement('div');
    searchContainer.className = 'gv-folder-search';

    const input = document.createElement('input');
    input.className = 'gv-folder-search-input';
    input.type = 'search';
    input.value = this.folderSearchQuery;

    const modeBadge = document.createElement('span');
    modeBadge.className = 'gv-folder-search-mode-badge';
    modeBadge.setAttribute('aria-hidden', 'true');

    input.addEventListener('input', () => {
      this.folderSearchQuery = input.value;
      this.updateFolderSearchInputState(searchContainer, input, modeBadge);
      if (this.isFolderOnlySearchActive()) {
        this.markFolderOnlySearchHintSeen(input);
      }
      // Debounce the full tree rebuild — rebuilding on every keystroke made
      // fast typing feel laggy on large trees. The query itself is applied
      // immediately so a pending refresh from any source uses the latest text.
      this.clearFolderSearchDebounceTimer();
      this.folderSearchDebounceTimer = window.setTimeout(() => {
        this.folderSearchDebounceTimer = null;
        this.refresh();
      }, FOLDER_SEARCH_DEBOUNCE_MS);
    });

    searchContainer.append(input, modeBadge);
    this.updateFolderSearchInputState(searchContainer, input, modeBadge);
    return searchContainer;
  }

  private updateFolderSearchInputState(
    searchContainer: HTMLElement,
    input: HTMLInputElement,
    modeBadge: HTMLElement,
  ): void {
    const folderOnlyMode = this.isFolderOnlySearchActive();
    const baseLabel = this.t('folder_search_placeholder');
    const modeLabel = this.t('folder_search_mode_folder');

    searchContainer.classList.toggle('gv-folder-search-folder-mode', folderOnlyMode);
    modeBadge.hidden = !folderOnlyMode;
    modeBadge.textContent = modeLabel;
    input.placeholder = this.folderOnlySearchHintSeen
      ? baseLabel
      : `${baseLabel} · f: ${modeLabel}`;
    input.setAttribute('aria-label', folderOnlyMode ? `${baseLabel}: ${modeLabel}` : baseLabel);
  }

  private markFolderOnlySearchHintSeen(input: HTMLInputElement): void {
    if (this.folderOnlySearchHintSeen) return;

    this.folderOnlySearchHintSeen = true;
    input.placeholder = this.t('folder_search_placeholder');
    void markCoachmarkSeen(FOLDER_ONLY_SEARCH_HINT_ID);
  }

  private clearFolderSearchDebounceTimer(): void {
    if (this.folderSearchDebounceTimer === null) return;
    window.clearTimeout(this.folderSearchDebounceTimer);
    this.folderSearchDebounceTimer = null;
  }

  private createFoldersList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'gv-folder-list';
    const isSearchActive = this.isFolderSearchActive();

    // Native-title sync used to scan the whole sidebar once PER stored
    // conversation (O(M×N) per render). Build one lookup table per render
    // pass instead; `createConversationElement` consults it while this field
    // is non-null. Search-triggered renders (and hide-archived mode, where the
    // per-conversation guard skips syncing anyway) use an empty table so they
    // skip the sidebar scan entirely.
    this.nativeTitleLookup =
      !this.hideArchivedConversations && !isSearchActive
        ? this.buildNativeConversationTitleMap()
        : new Map();
    try {
      return this.populateFoldersList(list, isSearchActive);
    } finally {
      this.nativeTitleLookup = null;
    }
  }

  private populateFoldersList(list: HTMLElement, isSearchActive: boolean): HTMLElement {
    let renderedItems = 0;

    // Setup root-level drop zone for dragging folders and conversations to root
    this.setupRootDropZone(list);

    // Render root-level conversations (favorites/pinned conversations)
    const rootConversations = this.data.folderContents[ROOT_CONVERSATIONS_ID] || [];
    const filteredRootConversations = this.filterVisibleConversations(rootConversations);
    if (filteredRootConversations.length > 0) {
      const sortedRootConversations = this.sortConversations(filteredRootConversations);
      const groupIndices = { starred: 0, normal: 0 };
      sortedRootConversations.forEach((conv) => {
        const convEl = this.createConversationElement(conv, ROOT_CONVERSATIONS_ID, 0);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          const group = conv.starred ? 'starred' : 'normal';
          this.setupConversationReorderZone(convEl, ROOT_CONVERSATIONS_ID, groupIndices[group]++);
        }
        list.appendChild(convEl);
        renderedItems++;
      });
    }

    // Render root level folders (sorted)
    const rootFolders = this.data.folders.filter((f) => f.parentId === null);
    const sortedRootFolders = this.sortFolders(rootFolders);
    let rootFolderIndex = 0;
    if (!isSearchActive) {
      list.appendChild(this.createReorderGap('__root__', 'folder', 0));
    }
    sortedRootFolders.forEach((folder) => {
      // Filter out empty folders if "Show current user only" is enabled
      if (
        isSearchActive
          ? !this.matchesFolderSearchTree(folder.id)
          : !this.hasVisibleContent(folder.id)
      ) {
        return;
      }

      const folderElement = this.createFolderElement(folder);
      list.appendChild(folderElement);
      renderedItems++;
      rootFolderIndex++;
      if (!isSearchActive) {
        list.appendChild(this.createReorderGap('__root__', 'folder', rootFolderIndex));
      }
    });

    // If no folders and no root conversations, show empty state placeholder
    if (renderedItems === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'gv-folder-empty';
      emptyState.textContent = this.t(isSearchActive ? 'folder_search_empty' : 'folder_empty');
      list.appendChild(emptyState);
    }

    return list;
  }

  private createFolderElement(
    folder: Folder,
    level = 0,
    includeEntireSubtree = false,
  ): HTMLElement {
    const isSearchActive = this.isFolderSearchActive();
    const includeFolderSubtree =
      includeEntireSubtree ||
      (this.isFolderOnlySearchActive() && this.matchesFolderSearchText(folder.name));
    const isExpanded = folder.isExpanded || isSearchActive;
    const folderEl = document.createElement('div');
    folderEl.className = 'gv-folder-item';
    folderEl.dataset.folderId = folder.id;
    folderEl.dataset.level = level.toString();

    // Folder header
    const folderHeader = document.createElement('div');
    folderHeader.className = 'gv-folder-item-header';
    folderHeader.style.paddingLeft = `${calculateFolderHeaderPaddingLeft(level, this.folderTreeIndent)}px`;

    // Expand/collapse button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'gv-folder-expand-btn';
    expandBtn.innerHTML = isExpanded
      ? '<span class="google-symbols">expand_more</span>'
      : '<span class="google-symbols">chevron_right</span>';
    expandBtn.addEventListener('click', () => this.toggleFolder(folder.id));

    // Folder icon
    const folderIcon = document.createElement('span');
    folderIcon.className = 'gv-folder-icon google-symbols';
    folderIcon.textContent = 'folder';
    folderIcon.style.cursor = 'pointer';
    folderIcon.style.userSelect = 'none';

    // Apply folder color if set
    if (folder.color && folder.color !== 'default') {
      const colorValue = getFolderColor(folder.color, isDarkMode());
      folderIcon.style.color = colorValue;
    }

    folderIcon.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent bubbling issues
      this.showColorPicker(folder.id, e, true); // Allow toggle behavior
    });

    // Folder name
    const folderName = document.createElement('span');
    folderName.className = 'gv-folder-name gds-label-l';
    folderName.textContent = folder.name;
    folderName.style.cursor = 'pointer';
    folderName.addEventListener('click', (event) => this.handleFolderNameClick(folder.id, event));
    folderName.addEventListener('dblclick', () => this.handleFolderNameDoubleClick(folder.id));

    // Add tooltip event listeners
    folderName.addEventListener('mouseenter', () => this.showTooltip(folderName, folder.name));
    folderName.addEventListener('mouseleave', () => this.hideTooltip());

    // Pin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'gv-folder-pin-btn';
    const pinIcon = document.createElement('span');
    pinIcon.className = 'google-symbols';
    pinIcon.textContent = 'push_pin';
    // Add filled style for pinned folders
    if (folder.pinned) {
      pinIcon.style.fontVariationSettings = "'FILL' 1";
    }
    pinBtn.appendChild(pinIcon);
    pinBtn.title = folder.pinned ? this.t('folder_unpin') : this.t('folder_pin');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePinFolder(folder.id);
    });

    // Actions menu
    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'gv-folder-actions-btn';
    actionsBtn.innerHTML = '<span class="google-symbols">more_vert</span>';
    actionsBtn.addEventListener('click', (e) => this.showFolderMenu(e, folder.id));

    folderHeader.appendChild(expandBtn);
    folderHeader.appendChild(folderIcon);
    folderHeader.appendChild(folderName);
    folderHeader.appendChild(pinBtn);
    folderHeader.appendChild(actionsBtn);

    // Setup drop zone for conversations and folders
    this.setupDropZone(folderHeader, folder.id);

    folderEl.appendChild(folderHeader);

    // Apply draggable behavior dynamically based on current state
    // This ensures draggability is always in sync with folder structure
    this.applyFolderDraggableBehavior(folderHeader, folder);

    // Folder content (conversations and subfolders)
    if (isExpanded) {
      const content = document.createElement('div');
      content.className = 'gv-folder-content';
      // Fix: Allow dropping into the content area of the folder (not just the header)
      this.setupDropZone(content, folder.id);

      // Render conversations in this folder (sorted: starred first)
      const conversations = this.data.folderContents[folder.id] || [];
      const filteredConversations = this.filterVisibleConversations(
        conversations,
        includeFolderSubtree,
      );
      const sortedConversations = this.sortConversations(filteredConversations);
      const groupIndices = { starred: 0, normal: 0 };
      sortedConversations.forEach((conv) => {
        const convEl = this.createConversationElement(conv, folder.id, level + 1);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          const group = conv.starred ? 'starred' : 'normal';
          this.setupConversationReorderZone(convEl, folder.id, groupIndices[group]++);
        }
        content.appendChild(convEl);
      });

      // Render subfolders (sorted)
      const subfolders = this.data.folders.filter((f) => f.parentId === folder.id);
      const sortedSubfolders = this.sortFolders(subfolders);
      let subfolderIndex = 0;
      const visibleSubfolders = sortedSubfolders.filter((subfolder) =>
        isSearchActive
          ? includeFolderSubtree
            ? this.hasVisibleContent(subfolder.id)
            : this.matchesFolderSearchTree(subfolder.id)
          : this.hasVisibleContent(subfolder.id),
      );
      if (!isSearchActive && visibleSubfolders.length > 0) {
        content.appendChild(this.createReorderGap(folder.id, 'folder', 0));
      }
      visibleSubfolders.forEach((subfolder) => {
        const subfolderEl = this.createFolderElement(subfolder, level + 1, includeFolderSubtree);
        content.appendChild(subfolderEl);
        subfolderIndex++;
        if (!isSearchActive) {
          content.appendChild(this.createReorderGap(folder.id, 'folder', subfolderIndex));
        }
      });

      folderEl.appendChild(content);
    }

    return folderEl;
  }

  private clearPendingFolderNameClick(): void {
    if (this.folderNameClickTimeout === null) return;
    clearTimeout(this.folderNameClickTimeout);
    this.folderNameClickTimeout = null;
  }

  private handleFolderNameClick(folderId: string, event: MouseEvent): void {
    // Double-click dispatches a second click with detail > 1; skip toggle for that sequence.
    if (event.detail > 1) {
      this.clearPendingFolderNameClick();
      return;
    }

    this.clearPendingFolderNameClick();
    this.folderNameClickTimeout = window.setTimeout(() => {
      this.folderNameClickTimeout = null;
      this.toggleFolder(folderId);
    }, FOLDER_NAME_SINGLE_CLICK_DELAY_MS);
  }

  private handleFolderNameDoubleClick(folderId: string): void {
    this.clearPendingFolderNameClick();
    this.renameFolder(folderId);
  }

  private createConversationElement(
    conv: ConversationReference,
    folderId: string,
    level: number,
  ): HTMLElement {
    const convEl = document.createElement('div');
    convEl.className = conv.starred
      ? 'gv-folder-conversation gv-starred'
      : 'gv-folder-conversation';
    convEl.dataset.conversationId = conv.conversationId;
    convEl.dataset.folderId = folderId;
    // Increase indentation for conversations under folders
    convEl.style.paddingLeft = `${calculateFolderConversationPaddingLeft(level, this.folderTreeIndent)}px`; // More indentation for tree structure

    // Try to sync title from native conversation
    // Decide what title to display, respecting manual renames and hidden native list
    let displayTitle = conv.title;
    if (!conv.customTitle && !this.hideArchivedConversations) {
      // Render passes populate `nativeTitleLookup` once up front (see
      // createFoldersList); outside a render pass fall back to the direct scan.
      const syncedTitle = this.nativeTitleLookup
        ? this.lookupNativeConversationTitle(conv.conversationId)
        : this.syncConversationTitleFromNative(conv.conversationId);
      if (syncedTitle && syncedTitle !== conv.title) {
        conv.title = syncedTitle;
        displayTitle = syncedTitle;
        // Buffer title updates during render to avoid multiple rapid saves
        this.pendingTitleUpdates.set(conv.conversationId, syncedTitle);
        this.debug('Buffered title update for:', conv.conversationId);
      }
    }

    // Make conversation draggable within folders
    convEl.draggable = true;
    convEl.addEventListener('dragstart', (e) => {
      e.stopPropagation();

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conv.conversationId)) {
        this.clearSelection();
        this.selectConversation(conv.conversationId);
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }

      // Include all selected conversations in the drag data
      const selectedConvs = this.getSelectedConversationsData(folderId);
      const dragData = {
        type: 'conversation',
        conversations: selectedConvs,
        sourceFolderId: folderId, // Track where they're being dragged from
      };
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/json', JSON.stringify(dragData));
      this.setLightweightDragImage(
        e,
        selectedConvs.length > 1 ? `${selectedConvs.length} conversations` : displayTitle,
      );

      // Apply opacity to all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.containerElement?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '0.5';
      });
    });

    convEl.addEventListener('dragend', () => {
      // Restore opacity for all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.containerElement?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '1';
      });

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
      this.clearConversationReorderIndicator();
    });

    const link = document.createElement('a');
    link.className = 'gv-folder-conversation-link';
    link.href = this.getFolderConversationHref(conv);
    link.draggable = false;
    try {
      (link.style as CSSStyleDeclaration & { webkitUserDrag?: string }).webkitUserDrag = 'none';
    } catch {}

    // Conversation icon - use Gem-specific icons
    const icon = document.createElement('mat-icon');
    icon.className =
      'mat-icon notranslate gv-conversation-icon google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');

    // Set icon based on conversation type
    let iconName = DEFAULT_CONVERSATION_ICON;
    if (conv.isGem && conv.gemId) {
      iconName = getGemIcon(conv.gemId);
    }
    icon.setAttribute('fonticon', iconName);
    icon.textContent = iconName;

    // Conversation title
    const title = document.createElement('span');
    title.className = 'gv-conversation-title gds-label-l';
    title.textContent = displayTitle;

    // Add tooltip event listeners
    title.addEventListener('mouseenter', () => this.showTooltip(title, displayTitle));
    title.addEventListener('mouseleave', () => this.hideTooltip());

    // Actions container for buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-conversation-actions';

    // Star button
    const starBtn = document.createElement('button');
    starBtn.className = conv.starred
      ? 'gv-conversation-star-btn starred'
      : 'gv-conversation-star-btn';
    const starIcon = conv.starred ? 'star' : 'star_outline';
    starBtn.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">${starIcon}</mat-icon>`;
    starBtn.title = conv.starred ? this.t('conversation_unstar') : this.t('conversation_star');
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleConversationStar(folderId, conv.conversationId);
    });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'gv-conversation-remove-btn';
    removeBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
    removeBtn.title = this.t('folder_remove_conversation');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.confirmRemoveConversation(folderId, conv.conversationId, displayTitle, e);
    });

    actionsContainer.appendChild(starBtn);
    actionsContainer.appendChild(removeBtn);

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;

    convEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      this.longPressTimeout = window.setTimeout(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conv.conversationId, 'folder', folderId);
      }, this.longPressThreshold);
    });

    convEl.addEventListener('mouseup', () => {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    convEl.addEventListener('mouseleave', () => {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    // Plain left clicks keep the existing SPA navigation path. Modified clicks,
    // middle clicks, and context-menu actions stay native because the row
    // contains a real anchor.
    link.addEventListener('click', (e) => {
      // Prevent navigation if long-press was triggered
      if (longPressTriggered) {
        e.preventDefault();
        longPressTriggered = false;
        return;
      }

      if (this.isMultiSelectMode) {
        // Multi-select mode: validate folder before toggling selection
        e.preventDefault();
        e.stopPropagation();

        // Prevent cross-folder selection
        if (
          this.multiSelectSource === 'folder' &&
          this.multiSelectFolderId &&
          this.multiSelectFolderId !== folderId
        ) {
          // Provide visual feedback for invalid selection attempt
          this.showInvalidSelectionFeedback(convEl);
          return;
        }

        this.toggleConversationSelection(conv.conversationId);
        this.updateConversationSelectionUI();
      } else {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Normal mode: navigate to conversation
        this.navigateToConversationById(folderId, conv.conversationId);
      }
    });

    // Double-click to rename
    title.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openNativeRenameForFolderConversation(conv);
    });

    convEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFolderConversationMenu(e, conv);
    });

    link.appendChild(icon);
    link.appendChild(title);
    convEl.appendChild(link);
    convEl.appendChild(actionsContainer);

    return convEl;
  }

  private getFolderConversationHref(conversation: ConversationReference): string {
    const normalizedId = this.normalizeConversationId(conversation.conversationId);

    try {
      const storedUrl = new URL(conversation.url, window.location.origin);

      if (this.accountIsolationEnabled && normalizedId) {
        const currentUserMatch = window.location.pathname.match(/\/u\/(\d+)\//);
        const accountPrefix = currentUserMatch ? `/u/${currentUserMatch[1]}` : '';
        return `${storedUrl.origin}${accountPrefix}/app/${normalizedId}${storedUrl.search}`;
      }

      return storedUrl.toString();
    } catch (error) {
      this.debug('Failed to build folder conversation href:', error);
    }

    return normalizedId ? this.buildConversationUrlFromId(normalizedId) : window.location.href;
  }

  private setupDropZone(element: HTMLElement, folderId: string): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent root drop zone from also highlighting
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Only remove highlight when cursor truly leaves the element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // CRITICAL: Prevent event bubbling to root drop zone
      element.classList.remove('gv-folder-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        if (
          this.conversationSortMode === 'recent' &&
          dragData.type !== 'folder' &&
          dragData.sourceFolderId === folderId
        ) {
          this.showNotification(this.t('folder_sort_recent_drag_hint'), 'info');
          this.exitMultiSelectMode();
          return;
        }

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types
        if (dragData.type === 'folder') {
          // Handle folder drop
          this.debug('Dropping folder into folder:', dragData.title, '→', folderId);
          this.addFolderToFolder(folderId, dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            this.debug('Dropping multiple conversations:', dragData.conversations.length);
            this.addConversationsToFolder(
              folderId,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            this.addConversationToFolder(folderId, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Drop error:', error);
      }
    });
  }

  private setupRootDropZone(element: HTMLElement): void {
    element.addEventListener('dragover', (e) => {
      // Allow both folder and conversation drops on the root zone
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-list-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Check if we're leaving this element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-list-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      element.classList.remove('gv-folder-list-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        if (
          this.conversationSortMode === 'recent' &&
          dragData.type !== 'folder' &&
          dragData.sourceFolderId === ROOT_CONVERSATIONS_ID
        ) {
          this.showNotification(this.t('folder_sort_recent_drag_hint'), 'info');
          this.exitMultiSelectMode();
          return;
        }

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types at root level
        if (dragData.type === 'folder') {
          this.moveFolderToRoot(dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            this.debug(
              'Adding multiple conversations to root level:',
              dragData.conversations.length,
            );
            this.addConversationsToFolder(
              ROOT_CONVERSATIONS_ID,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            this.debug('Adding conversation to root level:', dragData.title);
            this.addConversationToFolder(ROOT_CONVERSATIONS_ID, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Root drop error:', error);
      }
    });
  }

  private getNativeConversationRoot(): ParentNode {
    return this.sidebarContainer?.isConnected ? this.sidebarContainer : document;
  }

  private getNativeConversationElements(): NodeListOf<Element> {
    return this.getNativeConversationRoot().querySelectorAll('[data-test-id="conversation"]');
  }

  private makeConversationsDraggable(): void {
    // Full sweeps (init, reinit, recovery) go through the same budgeted
    // drain as observer bursts so a large Recents list never blocks one
    // frame for the whole sweep (issue #753).
    const conversations = this.getNativeConversationElements();
    conversations.forEach((conv) => {
      this.enhancementQueue.add(conv as HTMLElement);
    });
    this.scheduleEnhancementDrain();
  }

  /**
   * Pinned folders are fixed in place and cannot be dragged.
   * Non-pinned folders can be moved even when they have descendants.
   */
  private canFolderBeDragged(folder: Folder): boolean {
    return !folder.pinned;
  }

  /**
   * Strategy Pattern: Apply or remove draggable behavior based on folder state
   * Open/Closed Principle: Easy to extend with new draggable conditions
   *
   * This method ensures that folder draggability is always in sync with the current state.
   * It will enable dragging if conditions are met, or disable it if not.
   *
   * @param element - The folder header element
   * @param folder - The folder data object
   */
  private applyFolderDraggableBehavior(element: HTMLElement, folder: Folder): void {
    if (this.canFolderBeDragged(folder)) {
      this.enableFolderDragging(element, folder);
    } else {
      this.disableFolderDragging(element);
    }
  }

  /**
   * Enable dragging for a folder element
   * Encapsulates all logic needed to make a folder draggable
   *
   * Uses a data attribute to track drag listeners and prevent duplicates.
   * This ensures event listeners are only added once per element lifecycle.
   *
   * @param element - The folder header element
   * @param folder - The folder data object
   */
  private enableFolderDragging(element: HTMLElement, folder: Folder): void {
    // Mark element as draggable
    element.draggable = true;
    element.style.cursor = 'grab';

    // Check if drag listeners are already attached
    if (element.dataset.dragListenersAttached === 'true') {
      this.debug('Drag listeners already attached for folder:', folder.name);
      return;
    }

    // Create named event handler functions for proper cleanup
    const handleDragStart = (e: Event) => {
      e.stopPropagation(); // Prevent parent folder from being dragged

      const dragData: DragData = {
        type: 'folder',
        folderId: folder.id,
        title: folder.name,
      };

      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.effectAllowed = 'move';
      dt?.setData('application/json', JSON.stringify(dragData));
      element.style.opacity = '0.5';

      this.debug(
        'Folder drag start:',
        folder.name,
        'canBeDragged:',
        this.canFolderBeDragged(folder),
      );
    };

    const handleDragEnd = () => {
      element.style.opacity = '1';
    };

    // Store references for potential cleanup
    type DragEl = Element & {
      _dragStartHandler?: (e: Event) => void;
      _dragEndHandler?: () => void;
    };
    (element as DragEl)._dragStartHandler = handleDragStart;
    (element as DragEl)._dragEndHandler = handleDragEnd;

    // Add drag event listeners
    element.addEventListener('dragstart', handleDragStart);
    element.addEventListener('dragend', handleDragEnd);

    // Mark that listeners are attached
    element.dataset.dragListenersAttached = 'true';
  }

  /**
   * Disable dragging for a folder element
   * Ensures folder cannot be dragged when it has subfolders
   *
   * Properly removes event listeners to prevent memory leaks.
   *
   * @param element - The folder header element
   */
  private disableFolderDragging(element: HTMLElement): void {
    element.draggable = false;
    element.style.cursor = '';

    // Remove drag event listeners if they exist
    if (element.dataset.dragListenersAttached === 'true') {
      type DragEl = Element & {
        _dragStartHandler?: (e: Event) => void;
        _dragEndHandler?: () => void;
      };
      const dragStartHandler = (element as DragEl)._dragStartHandler;
      const dragEndHandler = (element as DragEl)._dragEndHandler;

      if (dragStartHandler) {
        element.removeEventListener('dragstart', dragStartHandler);
        delete (element as DragEl)._dragStartHandler;
      }

      if (dragEndHandler) {
        element.removeEventListener('dragend', dragEndHandler);
        delete (element as DragEl)._dragEndHandler;
      }

      delete element.dataset.dragListenersAttached;
    }
  }

  private makeConversationDraggable(element: HTMLElement): void {
    // Idempotency guard — the method can legitimately be called more than once
    // per element (e.g. sidebar success path + document sweep on fallback,
    // MutationObserver re-entry, route change re-scans). Without this guard
    // we'd stack duplicate mousedown / dragstart listeners on every call.
    if (element.dataset.gvConvDragAttached === 'true') return;
    element.dataset.gvConvDragAttached = 'true';

    element.draggable = true;
    element.style.cursor = 'grab';

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;
    let longPressTimeoutId: number | null = null;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      const conversationId = this.extractConversationId(element);

      longPressTimeoutId = window.setTimeout(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conversationId, 'native');
        // Add visual feedback to this element
        element.classList.add('gv-conversation-selected');
      }, this.longPressThreshold);
    };

    const handleMouseUp = () => {
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    const handleMouseLeave = () => {
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    // Add event listeners
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseup', handleMouseUp);
    element.addEventListener('mouseleave', handleMouseLeave);

    // Click handler for multi-select mode
    element.addEventListener(
      'click',
      (e) => {
        // Never swallow clicks on the trailing ⋮ menu button — those need to
        // open the per-row actions menu (rename / delete / move / etc.).
        // Without this guard, our capture-phase stopPropagation below silently
        // kills the menu trigger during programmatic batch-delete (the
        // moreButton.click() never reaches Material's menu, so the menu never
        // opens and waitForDeleteButtonAndClick times out at 3s every row).
        if (
          e.target instanceof Element &&
          e.target.closest(
            '[data-test-id="actions-menu-button"], [data-test-id="conversation-actions-menu-icon-button"]',
          )
        ) {
          return;
        }

        // Programmatic batch delete drives Gemini's own menu via .click() — let
        // every click through unimpeded for the duration of the batch.
        if (this.batchDeleteInProgress) {
          return;
        }

        // Prevent navigation if long-press was triggered
        if (longPressTriggered) {
          e.preventDefault();
          e.stopPropagation();
          longPressTriggered = false;
          return;
        }

        if (this.isMultiSelectMode) {
          // Multi-select mode: toggle selection
          e.preventDefault();
          e.stopPropagation();
          const conversationId = this.extractConversationId(element);
          this.toggleConversationSelection(conversationId);

          // Update visual state
          if (this.selectedConversations.has(conversationId)) {
            element.classList.add('gv-conversation-selected');
          } else {
            element.classList.remove('gv-conversation-selected');
          }

          this.updateConversationSelectionUI();
          return;
        }
      },
      true,
    ); // Use capture phase to intercept before navigation

    element.addEventListener('dragstart', (e) => {
      const conversationId = this.extractConversationId(element);
      const title = this.extractNativeDragTitle(element, conversationId);

      // Extract URL and conversation metadata together
      const conversationData = this.extractConversationData(element);

      // Restrict to move-only to prevent Chrome from triggering split-screen/tab tiling
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conversationId)) {
        this.clearSelection();
        this.selectConversation(conversationId);
        element.classList.add('gv-conversation-selected');
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }

      // Check if we have multiple selections
      if (this.selectedConversations.size > 1) {
        // Multi-select drag - collect all selected conversations
        const selectedConvs: ConversationReference[] = [];

        this.selectedConversations.forEach((id) => {
          const convEl = this.findConversationElement(id);
          if (convEl) {
            const convTitle = this.extractNativeDragTitle(convEl, id);
            const convData = this.extractConversationData(convEl);

            selectedConvs.push({
              conversationId: id,
              title: convTitle,
              url: convData.url,
              addedAt: Date.now(),
              isGem: convData.isGem,
              gemId: convData.gemId,
            });
          }
        });

        const dragData: DragData = {
          type: 'conversation',
          title: `${selectedConvs.length} conversations`,
          conversations: selectedConvs,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, `${selectedConvs.length} conversations`);

        // Apply opacity to all selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '0.5';
        });
      } else {
        // Single conversation drag (legacy behavior)
        this.debug('Drag start:', {
          title,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
          url: conversationData.url,
        });

        const dragData: DragData = {
          type: 'conversation',
          conversationId,
          title,
          url: conversationData.url,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, title);
        element.style.opacity = '0.5';
      }
    });

    element.addEventListener('dragend', () => {
      // Restore opacity for all selected conversations
      if (this.selectedConversations.size > 1) {
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });
      } else {
        element.style.opacity = '1';
      }

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
      this.clearConversationReorderIndicator();
    });
  }

  // Helper method to find conversation element by ID
  private findConversationElement(conversationId: string): HTMLElement | null {
    // Check in folder conversations
    const folderConv = this.containerElement?.querySelector(
      `[data-conversation-id="${conversationId}"]`,
    ) as HTMLElement;
    if (folderConv) return folderConv;

    // Check in native conversations (Recent section)
    const nativeConvs = this.getNativeConversationElements();
    for (const conv of Array.from(nativeConvs)) {
      const id = this.extractConversationId(conv as HTMLElement);
      if (id === conversationId) {
        return conv as HTMLElement;
      }
    }

    return null;
  }

  private extractNativeDragTitle(element: HTMLElement, conversationId?: string): string {
    const title =
      this.extractNativeConversationTitle(element) ||
      (conversationId ? this.syncConversationTitleFromNative(conversationId) : null);

    return title || 'Untitled';
  }

  private extractConversationId(element: HTMLElement): string {
    // Strategy 1: Extract from jslog attribute
    // This is the preferred method as it follows the internal ID format
    const jslog = element.getAttribute('jslog');
    if (jslog) {
      // Match conversation ID - it appears in quotes like ["c_3456c77162722c1a",...]
      const match = jslog.match(/[",\[]c_([a-f0-9]+)[",\]]/);
      if (match) {
        const conversationId = `c_${match[1]}`;
        this.debug('Extracted conversation ID:', conversationId, 'from jslog:', jslog);
        return conversationId;
      }
      // Fallback: match without surrounding characters
      const simpleMatch = jslog.match(/c_[a-f0-9]+/);
      if (simpleMatch) {
        this.debug('Extracted conversation ID (simple):', simpleMatch[0]);
        return simpleMatch[0];
      }
    }

    // Strategy 2: Extract from href (fallback when jslog is missing/broken)
    // This ensures we can still identify conversations even if Gemini UI changes traits
    const link = element.querySelector(
      'a[href*="/app/"], a[href*="/gem/"]',
    ) as HTMLAnchorElement | null;
    if (link) {
      const href = link.href;
      // Try /app/<hexId>
      let match = href.match(/\/app\/([^\/?#]+)/);
      if (match && match[1]) {
        // Enforce c_ prefix to match jslog format standard
        return `c_${match[1]}`;
      }
      // Try /gem/<gemId>/<hexId>
      match = href.match(/\/gem\/[^/]+\/([^\/?#]+)/);
      if (match && match[1]) {
        return `c_${match[1]}`;
      }
    }

    // Fallback: generate unique ID from element attributes
    // Use multiple attributes to ensure uniqueness
    const title = this.extractNativeConversationTitle(element) || '';
    const index = Array.from(element.parentElement?.children || []).indexOf(element);

    // Generate unique ID combining title, index, random, and timestamp
    const uniqueString = `${title}_${index}_${Math.random()}_${Date.now()}`;
    const fallbackId = `conv_${this.hashString(uniqueString)}`;
    this.debugWarn('Could not extract ID from jslog or href, using fallback:', fallbackId);
    return fallbackId;
  }

  private extractConversationData(element: HTMLElement): {
    url: string;
    isGem: boolean;
    gemId?: string;
  } {
    // Try to extract from jslog first
    const jslog = element.getAttribute('jslog');
    let hexId: string | null = null;

    if (jslog) {
      const match = jslog.match(/[",\[]c_([a-f0-9]+)[",\]]/);
      if (match) {
        hexId = match[1];
        this.debug('Extracted hex ID from jslog:', hexId);
      }
    }

    // Try to extract from href if jslog failed
    if (!hexId) {
      const link = element.querySelector(
        'a[href*="/app/"], a[href*="/gem/"]',
      ) as HTMLAnchorElement | null;
      if (link) {
        const href = link.href;
        // Try /app/<hexId>
        let match = href.match(/\/app\/([^\/?#]+)/);
        if (match && match[1]) {
          hexId = match[1];
        } else {
          // Try /gem/<gemId>/<hexId>
          match = href.match(/\/gem\/[^/]+\/([^\/?#]+)/);
          if (match && match[1]) {
            hexId = match[1];
          }
        }
      }
    }

    if (!hexId) {
      return { url: window.location.href, isGem: false };
    }

    const origin = window.location.origin;
    const currentUrl = new URL(window.location.href);
    const searchParams = currentUrl.searchParams.toString();

    let url: string;

    if (this.accountIsolationEnabled) {
      // In hard isolation mode, intentionally do not persist the /u/{num} account index;
      // only store the path that is intrinsic to the conversation itself.
      // At navigation time we rebuild the correct /u/{num} segment based on the
      // current window/account context, so that URLs stay valid even if the
      // account index changes (e.g. saved with /u/1, later browsing under /u/2).
      url = `${origin}/app/${hexId}`;
    } else {
      // Backward-compatible behavior: preserve the current /u/{num} segment
      // when hard isolation is disabled, matching legacy URL structure.
      const currentPath = window.location.pathname;
      const userMatch = currentPath.match(/\/u\/(\d+)\//);

      if (userMatch) {
        url = `${origin}/u/${userMatch[1]}/app/${hexId}`;
      } else {
        url = `${origin}/app/${hexId}`;
      }
    }

    if (searchParams) {
      url += `?${searchParams}`;
    }

    this.debug('Built conversation URL:', url);
    return { url, isGem: false, gemId: undefined };
  }

  /**
   * Extract conversation ID from a DOM element
   * Used for handling removed/added conversations in MutationObserver
   *
   * @param element - The conversation element to extract ID from
   * @returns The conversation ID (hex only, without 'c_' prefix) or undefined if not found
   *
   * @remarks
   * This method attempts two extraction strategies:
   * 1. From jslog attribute (e.g., jslog="c_abc123def456")
   * 2. From href in anchor tags (e.g., /app/abc123def456 or /gem/xxx/abc123def456)
   */
  private extractConversationIdFromElement(element: Element): string | undefined {
    // Strategy 1: Extract from jslog attribute
    const jslog = element.getAttribute('jslog');
    if (jslog) {
      const match = jslog.match(/c_([a-f0-9]{8,})/i);
      if (match && match[1]) {
        return match[1];
      }
    }

    // Strategy 2: Extract from href
    const link = element.querySelector(
      'a[href*="/app/"], a[href*="/gem/"]',
    ) as HTMLAnchorElement | null;
    if (link) {
      const href = link.href;
      const appMatch = href.match(/\/app\/([^\/?#]+)/);
      const gemMatch = href.match(/\/gem\/[^/]+\/([^\/?#]+)/);
      return appMatch?.[1] || gemMatch?.[1];
    }

    return undefined;
  }

  private setupMutationObserver(): void {
    if (!this.sidebarContainer) return;

    // Disconnect existing observer to prevent duplicates
    if (this.conversationObserver) {
      this.conversationObserver.disconnect();
      this.conversationObserver = null;
    }

    this.conversationObserver = new MutationObserver((mutations) => {
      // Coalesce mutations to the next animation frame instead of processing
      // them synchronously. Synchronous processing caused sidebar-click
      // jank — see issue #678. Flush is implemented in `flushMutationBatch`.
      for (const mutation of mutations) this.mutationBatchQueue.push(mutation);
      this.scheduleMutationBatchFlush();
    });

    this.conversationObserver.observe(this.sidebarContainer, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'href', 'title'],
    });
  }

  private scheduleMutationBatchFlush(): void {
    if (this.mutationFlushScheduled) return;
    this.mutationFlushScheduled = true;
    this.mutationFlushRafId = window.requestAnimationFrame(() => {
      this.mutationFlushRafId = null;
      this.mutationFlushScheduled = false;
      if (this.isDestroyed) {
        this.mutationBatchQueue.length = 0;
        return;
      }
      this.flushMutationBatch();
    });
  }

  private cancelMutationBatchFlush(): void {
    if (this.mutationFlushRafId !== null) {
      window.cancelAnimationFrame(this.mutationFlushRafId);
      this.mutationFlushRafId = null;
    }
    this.mutationFlushScheduled = false;
  }

  private scheduleEnhancementDrain(): void {
    if (this.enhancementQueue.size === 0) return;
    if (this.enhancementDrainIdleId !== null) return;

    const drain = (deadline?: IdleDeadline) => {
      this.enhancementDrainIdleId = null;
      if (this.isDestroyed) {
        this.enhancementQueue.clear();
        return;
      }
      this.drainEnhancementQueue(deadline);
    };

    if (typeof window.requestIdleCallback === 'function') {
      this.enhancementDrainIdleId = window.requestIdleCallback(drain, {
        timeout: ENHANCEMENT_IDLE_TIMEOUT_MS,
      });
    } else {
      this.enhancementDrainIdleId = window.setTimeout(() => drain(), 0);
    }
  }

  private cancelEnhancementDrain(): void {
    if (this.enhancementDrainIdleId !== null) {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this.enhancementDrainIdleId);
      } else {
        window.clearTimeout(this.enhancementDrainIdleId);
      }
      this.enhancementDrainIdleId = null;
    }
    this.enhancementQueue.clear();
  }

  // Exposed via the private surface so tests can drive draining
  // deterministically without depending on idle-callback timing in jsdom.
  private drainEnhancementQueue(deadline?: IdleDeadline): void {
    const fallbackDeadline = performance.now() + ENHANCEMENT_IDLE_BUDGET_MS;
    let processed = 0;

    for (const convEl of this.enhancementQueue) {
      this.enhancementQueue.delete(convEl);
      if (!convEl.isConnected) continue; // removed while queued
      this.makeConversationDraggable(convEl);
      this.applyHideArchivedToConversation(convEl);
      processed += 1;

      const outOfIdleTime =
        deadline && !deadline.didTimeout
          ? deadline.timeRemaining() <= 0
          : performance.now() >= fallbackDeadline;
      if (processed > 0 && outOfIdleTime) break;
    }
    this.scheduleEnhancementDrain();
  }

  // Exposed via the private surface so tests can drive flushing
  // deterministically without depending on animation-frame timing in jsdom.
  private flushMutationBatch(): void {
    if (this.mutationBatchQueue.length === 0) return;
    const mutations = this.mutationBatchQueue;
    this.mutationBatchQueue = [];

    // Title-sync detection: short-circuits, debounced downstream.
    if (this.mutationsMayAffectNativeConversationTitles(mutations)) {
      this.scheduleNativeConversationTitleSync();
    }

    // Dedupe added conversation elements. Multiple mutations in a single
    // tick frequently touch the same row; the per-element work
    // (makeConversationDraggable, applyHideArchivedToConversation) is
    // idempotent but the upfront DOM queries are not free.
    const addedConversations = new Set<HTMLElement>();
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('[data-test-id="conversation"]')) {
          addedConversations.add(node);
        }
        const nested = node.querySelectorAll('[data-test-id="conversation"]');
        nested.forEach((conv) => addedConversations.add(conv as HTMLElement));
      });
    }

    addedConversations.forEach((convEl) => {
      if (!convEl.isConnected) return; // re-removed within the same batch
      // Drag listeners + hide-archived state are deferred to the budgeted
      // drain — both are idempotent and tolerate a few frames of latency
      // (issue #753).
      this.enhancementQueue.add(convEl);
    });
    this.scheduleEnhancementDrain();

    // Deliberately ignore removed conversation rows. Gemini virtualizes the
    // sidebar, so scrolling or re-rendering can detach one real conversation
    // row at a time. A detached DOM node is therefore not deletion evidence.
    // Native deletion is tracked from the explicit Delete action in
    // `setupConversationClickTracking` and confirmed after the UI settles.
  }

  private mutationsMayAffectNativeConversationTitles(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        if (mutation.target.parentElement?.closest('[data-test-id="conversation"]')) return true;
        continue;
      }

      if (mutation.type === 'attributes') {
        if (
          mutation.target instanceof Element &&
          mutation.target.closest('[data-test-id="conversation"]')
        ) {
          return true;
        }
        continue;
      }

      if (mutation.type !== 'childList') continue;

      if (
        mutation.target instanceof Element &&
        mutation.target.closest('[data-test-id="conversation"]')
      ) {
        return true;
      }

      for (const node of Array.from(mutation.addedNodes)) {
        if (this.nodeTouchesNativeConversation(node)) return true;
      }
    }

    return false;
  }

  private nodeTouchesNativeConversation(node: Node): boolean {
    if (!(node instanceof Element)) return false;
    if (node.matches('[data-test-id="conversation"]')) return true;
    if (node.closest('[data-test-id="conversation"]')) return true;
    return !!node.querySelector('[data-test-id="conversation"]');
  }

  private clearNativeTitleSyncTimer(): void {
    if (this.nativeTitleSyncTimer === null) return;
    clearTimeout(this.nativeTitleSyncTimer);
    this.nativeTitleSyncTimer = null;
  }

  private scheduleNativeConversationTitleSync(): void {
    if (!this.hasStoredConversations()) return;
    if (this.nativeTitleSyncTimer !== null) return;

    this.nativeTitleSyncTimer = window.setTimeout(() => {
      this.nativeTitleSyncTimer = null;
      void this.syncConversationTitlesFromNative();
    }, NATIVE_TITLE_SYNC_DEBOUNCE_MS);
  }

  private hasStoredConversations(): boolean {
    return Object.values(this.data.folderContents).some(
      (conversations) => conversations.length > 0,
    );
  }

  /**
   * Setup observer to monitor sidebar open/close state
   * Hides folder container when sidebar is collapsed for better UX
   */
  private setupSideNavObserver(): void {
    // lr26 moved the `side-nav-open` class from #app-root to the <chat-app>
    // shell; observe whichever currently carries it (legacy fallback included).
    const sideNavHost = document.querySelector('chat-app') ?? document.querySelector('#app-root');
    if (!sideNavHost) {
      this.debugWarn('Could not find sidebar host element for monitoring');
      return;
    }

    this.sideNavObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          this.updateVisibilityBasedOnSideNav();
        }
      });
    });

    this.sideNavObserver.observe(sideNavHost, {
      attributes: true,
      attributeFilter: ['class'],
    });

    this.debug('Side nav observer setup complete');
  }

  /**
   * Whether Gemini's sidebar is currently open.
   *
   * The `side-nav-open` class used to live on `#app-root`, but the lr26 UI
   * refresh moved it to the `<chat-app>` shell (`#app-root` became a class-less
   * `<chat-app-orchestrator>`, so the old check was always false and the folder
   * container got hidden even with the sidebar open). Match either element, then
   * fall back to the rendered width of the sidenav so a future class rename
   * still degrades sanely.
   */
  private isSideNavOpen(): boolean {
    if (document.querySelector('chat-app.side-nav-open, #app-root.side-nav-open')) return true;
    const sideNav = document.querySelector('bard-sidenav, side-nav');
    return sideNav instanceof HTMLElement && sideNav.offsetWidth > 120;
  }

  /**
   * Whether the sidebar folder is not just attached but actually *usable*.
   *
   * "Mounted in the DOM" is not the same as "the user can see/use it": a Gemini
   * DOM change can leave the container attached yet invisible (e.g. a stale
   * display:none from a mis-fired open/closed detection). This predicate is the
   * basis of the visibility-aware safety net — it returns false ONLY for a
   * genuine fault, excluding the legitimate hidden states:
   *   - sidebar collapsed → folder is meant to be hidden;
   *   - user collapsed the Folders section via the section-hider (peek bar).
   */
  private isSidebarFolderUsable(): boolean {
    const container = this.containerElement;
    if (!container || !container.isConnected) return false;
    // Sidebar closed → the folder is supposed to be hidden. Not a fault.
    if (!this.isSideNavOpen()) return true;
    // Collapsed by the user via the section-hider (a peek bar stands in). Fine.
    if (container.classList.contains('gv-sidebar-section-hidden')) return true;
    // Sidebar open and not user-collapsed: the container must render a real box.
    return container.offsetParent !== null && container.getBoundingClientRect().height > 0;
  }

  /**
   * Check if sidebar is open and update folder container visibility.
   */
  private updateVisibilityBasedOnSideNav(): void {
    const isSideNavOpen = this.isSideNavOpen();

    // During resize Gemini can keep the old sidebar attached while mounting a
    // new visible sidebar. Treat the folder as healthy only when it lives under
    // the current sidebar and that sidebar still exposes an anchor section.
    if (!this.isSidebarFolderMountedInCurrentSidebar()) {
      if (isSideNavOpen) {
        this.debug('Folder UI is not mounted in the current sidebar, reinitializing');
        this.reinitializeFolderUI();
      }
      return;
    }

    const containerElement = this.containerElement;
    if (!containerElement) return;

    if (isSideNavOpen) {
      containerElement.style.display = '';
      this.debug('Sidebar open - showing folder container');
    } else {
      containerElement.style.display = 'none';
      this.debug('Sidebar closed - hiding folder container');
    }
  }

  /**
   * Reinitialize folder UI when DOM elements become detached
   * This can happen during window resize or split-screen operations
   */
  private reinitializeFolderUI(): void {
    if (this.reinitializePromise) {
      this.debug('Reinitialization already in progress, skipping duplicate request');
      return;
    }

    this.reinitializePromise = (async () => {
      this.debug('Reinitializing folder UI...');

      // Execute general cleanup tasks first (including event listeners)
      this.runCleanupTasks();

      // Clean up observers/listeners tied to stale DOM nodes
      if (this.sideNavObserver) {
        this.sideNavObserver.disconnect();
        this.sideNavObserver = null;
      }

      if (this.conversationObserver) {
        this.conversationObserver.disconnect();
        this.conversationObserver = null;
      }

      if (this.nativeMenuObserver) {
        this.nativeMenuObserver.disconnect();
        this.nativeMenuObserver = null;
      }
      this.teardownMoveMenuTriggerListener();

      this.teardownPositionEnforcer();
      this.cleanupNotebooksAnchorButton();

      if (this.routeChangeCleanup) {
        try {
          this.routeChangeCleanup();
        } catch (error) {
          this.debugWarn('Route change cleanup during reinit failed:', error);
        }
        this.routeChangeCleanup = null;
      }

      if (this.sidebarClickListener && this.sidebarContainer) {
        try {
          this.sidebarContainer.removeEventListener('click', this.sidebarClickListener, true);
        } catch (error) {
          this.debugWarn('Sidebar click listener cleanup failed:', error);
        }
        this.sidebarClickListener = null;
      }

      if (this.containerElement?.isConnected) {
        try {
          this.containerElement.remove();
        } catch (error) {
          this.debugWarn('Failed to remove existing folder container during reinit:', error);
        }
      }

      this.closeActiveImportExportMenu();
      this.closeActiveImportDialog();
      this.closeFolderConversationMenus();
      this.clearActiveFolderInput();

      // Clear existing references so initialization starts from a clean slate
      this.containerElement = null;
      this.sidebarContainer = null;
      this.recentSection = null;

      await this.initializeFolderUI();
    })()
      .catch((error) => {
        this.debugWarn('Failed to reinitialize folder UI:', error);
      })
      .finally(() => {
        this.reinitializePromise = null;
      });
  }

  private createFolder(parentId: string | null = null): void {
    // Depth cap: subfolder creation stops once the parent is already as deep
    // as MAX_FOLDER_DEPTH allows. The sidebar context menu hides the affordance
    // at this depth, but guard here too so any other caller (imports, cross-
    // module wiring, drag shortcuts) can't silently exceed the cap. Root
    // creation (parentId === null) is always allowed.
    if (parentId !== null && this.getFolderDepth(parentId) >= MAX_FOLDER_DEPTH) {
      this.debugWarn('createFolder refused: parent is already at MAX_FOLDER_DEPTH', parentId);
      return;
    }

    if (this.activeFolderInput && !this.activeFolderInput.isConnected) {
      this.clearActiveFolderInput();
    }

    // Prevent creating multiple folder inputs simultaneously
    if (this.activeFolderInput) {
      // Focus existing input instead of creating a new one
      const existingInput = this.activeFolderInput.querySelector('input') as HTMLInputElement;
      if (existingInput) {
        existingInput.focus();
        return;
      }

      this.clearActiveFolderInput();
    }

    // Create inline input for folder name
    const inputContainer = document.createElement('div');
    inputContainer.className = 'gv-folder-inline-input';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gv-folder-name-input';
    input.placeholder = this.t('folder_name_prompt');
    input.maxLength = 50;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
    saveBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">check</mat-icon>';
    saveBtn.title = this.t('pm_save');

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancelBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
    cancelBtn.title = this.t('pm_cancel');

    inputContainer.appendChild(input);
    inputContainer.appendChild(saveBtn);
    inputContainer.appendChild(cancelBtn);

    const save = () => {
      const name = input.value.trim();
      if (!name) {
        inputContainer.remove();
        this.clearActiveFolderInput();
        return;
      }

      const maxSortIndex = this.data.folders
        .filter((f) => f.parentId === parentId)
        .reduce((max, f) => Math.max(max, f.sortIndex ?? -1), -1);
      const folder: Folder = {
        id: this.generateId(),
        name,
        parentId,
        isExpanded: true,
        sortIndex: maxSortIndex + 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.data.folders.push(folder);
      this.data.folderContents[folder.id] = [];
      this.saveData();
      this.refresh();
    };

    const cancel = () => {
      inputContainer.remove();
      this.clearActiveFolderInput();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });

    // Insert input into the folder list
    const folderList = this.containerElement?.querySelector('.gv-folder-list');
    if (folderList) {
      if (parentId) {
        // Insert after the parent folder
        const parentFolder = folderList.querySelector(`[data-folder-id="${parentId}"]`);
        if (parentFolder) {
          const parentContent = parentFolder.querySelector('.gv-folder-content');
          if (parentContent) {
            parentContent.insertBefore(inputContainer, parentContent.firstChild);
          } else {
            parentFolder.insertAdjacentElement('afterend', inputContainer);
          }
        } else {
          folderList.appendChild(inputContainer);
        }
      } else {
        folderList.insertBefore(inputContainer, folderList.firstChild);
      }

      input.focus();

      // Track this input as the active one
      this.activeFolderInput = inputContainer;
    }
  }

  private renameFolder(folderId: string): void {
    this.clearPendingFolderNameClick();

    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // Find the folder element
    const folderEl = this.containerElement?.querySelector(`[data-folder-id="${folderId}"]`);
    if (!folderEl) return;

    const folderNameEl = folderEl.querySelector('.gv-folder-name');
    if (!folderNameEl) return;

    // Create inline input for renaming
    const inputContainer = document.createElement('span');
    inputContainer.className = 'gv-folder-rename-inline';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gv-folder-rename-input';
    input.value = folder.name;
    input.maxLength = 50;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
    saveBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">check</mat-icon>';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancelBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';

    inputContainer.appendChild(input);
    inputContainer.appendChild(saveBtn);
    inputContainer.appendChild(cancelBtn);

    const save = () => {
      const newName = input.value.trim();
      if (!newName) {
        restore();
        return;
      }

      folder.name = newName;
      folder.updatedAt = Date.now();
      this.saveData();
      this.refresh();
    };

    const restore = () => {
      folderNameEl.textContent = folder.name;
      inputContainer.remove();
      folderNameEl.classList.remove('gv-hidden');
    };

    const cancel = () => {
      restore();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });

    // Hide original name and show input
    folderNameEl.classList.add('gv-hidden');
    folderNameEl.parentElement?.insertBefore(inputContainer, folderNameEl.nextSibling);
    input.focus();
    input.select();
  }

  private deleteFolder(folderId: string, _event?: MouseEvent): void {
    // Create inline confirmation using safe DOM API
    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'gv-folder-confirm-dialog';

    // Create message element safely
    const message = document.createElement('div');
    message.className = 'gv-folder-confirm-message';
    message.textContent = this.t('folder_delete_confirm'); // Safe: uses textContent

    // Create actions container
    const actions = document.createElement('div');
    actions.className = 'gv-folder-confirm-actions';

    // Create buttons safely
    const yesBtn = document.createElement('button');
    yesBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
    yesBtn.textContent = this.t('folder_remove_conversation_action'); // Safe: uses textContent

    const noBtn = document.createElement('button');
    noBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
    noBtn.textContent = this.t('pm_cancel'); // Safe: uses textContent

    // Assemble the dialog
    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    confirmDialog.appendChild(message);
    confirmDialog.appendChild(actions);

    // Position near the folder
    // Position near the folder header
    const folderEl = this.containerElement?.querySelector(`[data-folder-id="${folderId}"]`);
    const headerEl = folderEl?.querySelector('.gv-folder-item-header');

    if (headerEl) {
      const rect = headerEl.getBoundingClientRect();
      confirmDialog.style.position = 'fixed';
      confirmDialog.style.top = `${rect.bottom + 4}px`;
      confirmDialog.style.left = `${rect.left + 24}px`; // Align with folder name
      confirmDialog.style.zIndex = '10002'; // Ensure it's on top
    } else if (folderEl) {
      const rect = folderEl.getBoundingClientRect();
      confirmDialog.style.position = 'fixed';
      confirmDialog.style.top = `${rect.top + 32}px`; // Fallback approximate height
      confirmDialog.style.left = `${rect.left}px`;
      confirmDialog.style.zIndex = '10002';
    }

    document.body.appendChild(confirmDialog);

    // Cleanup function
    const cleanup = () => {
      confirmDialog.remove();
    };

    yesBtn?.addEventListener('click', () => {
      // Remove folder and all subfolders recursively
      const foldersToDelete = this.getFolderAndDescendants(folderId);
      this.data.folders = this.data.folders.filter((f) => !foldersToDelete.includes(f.id));

      // Remove folder contents
      foldersToDelete.forEach((id) => {
        delete this.data.folderContents[id];
      });

      this.saveData();
      this.refresh();
      cleanup();
    });

    noBtn?.addEventListener('click', cleanup);

    // Close on click outside
    setTimeout(() => {
      const closeOnOutside = (e: MouseEvent) => {
        if (!confirmDialog.contains(e.target as Node)) {
          cleanup();
          document.removeEventListener('click', closeOnOutside);
        }
      };
      document.addEventListener('click', closeOnOutside);
    }, 0);
  }

  private getFolderAndDescendants(folderId: string): string[] {
    const result = [folderId];
    const children = this.data.folders.filter((f) => f.parentId === folderId);
    children.forEach((child) => {
      result.push(...this.getFolderAndDescendants(child.id));
    });
    return result;
  }

  private toggleFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.isExpanded = !folder.isExpanded;
    folder.updatedAt = Date.now();
    // Pure UI state — debounce the full persistence pipeline instead of
    // running stringify/verify/mirror/backup on every expand/collapse click.
    this.scheduleSaveData();
    this.refresh();
  }

  private togglePinFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.pinned = !folder.pinned;
    folder.updatedAt = Date.now();
    this.saveData();
    this.refresh();
  }

  /**
   * Sort folders with pinned folders first, then by name using localized collation
   */
  private sortFolders(folders: Folder[]): Folder[] {
    return [...folders].sort((a, b) => {
      // Pinned folders always come first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // Within the same pinned state, use sortIndex if both have one
      const aIdx = a.sortIndex ?? -1;
      const bIdx = b.sortIndex ?? -1;
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;

      // Fall back to name-based sort
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }

  private sortConversations(conversations: ConversationReference[]): ConversationReference[] {
    return sortConversationsByPriority(conversations, this.conversationSortMode);
  }

  /**
   * Move a folder to a parent/position while preserving descendant structure.
   * Only the moved folder's parent/sibling order changes; the subtree beneath it stays intact.
   */
  private moveFolder(
    folderId: string,
    targetParentId: string | null,
    insertIndex?: number,
  ): boolean {
    const folder = this.data.folders.find((candidate) => candidate.id === folderId);
    if (!folder || folder.pinned) return false;

    if (folderId === targetParentId) return false;
    if (targetParentId && this.isFolderDescendant(targetParentId, folderId)) return false;

    const sourceParentId = folder.parentId;
    if (insertIndex == null && sourceParentId === targetParentId) return false;

    const pinned = !!folder.pinned;
    const originalSiblings = this.sortFolders(
      this.data.folders.filter(
        (candidate) =>
          candidate.parentId === sourceParentId &&
          candidate.id !== folderId &&
          !!candidate.pinned === pinned,
      ),
    );
    const targetSiblings = this.sortFolders(
      this.data.folders.filter(
        (candidate) =>
          candidate.parentId === targetParentId &&
          candidate.id !== folderId &&
          !!candidate.pinned === pinned,
      ),
    );

    let normalizedInsertIndex = insertIndex ?? targetSiblings.length;
    if (sourceParentId === targetParentId) {
      const originalIndex = this.sortFolders(
        this.data.folders.filter(
          (candidate) => candidate.parentId === sourceParentId && !!candidate.pinned === pinned,
        ),
      ).findIndex((candidate) => candidate.id === folderId);

      if (originalIndex >= 0 && originalIndex < normalizedInsertIndex) {
        normalizedInsertIndex -= 1;
      }
    }

    const clampedInsertIndex = Math.max(0, Math.min(normalizedInsertIndex, targetSiblings.length));
    const nextOrder = [...targetSiblings];
    nextOrder.splice(clampedInsertIndex, 0, folder);

    folder.parentId = targetParentId;
    folder.updatedAt = Date.now();

    nextOrder.forEach((sibling, index) => {
      sibling.sortIndex = index;
    });

    if (sourceParentId !== targetParentId) {
      originalSiblings.forEach((sibling, index) => {
        sibling.sortIndex = index;
      });
    }

    return true;
  }

  /** Add manual reorder capability to a conversation row. */
  private setupConversationReorderZone(
    convEl: HTMLElement,
    folderId: string,
    groupIndex: number,
  ): void {
    convEl.addEventListener('dragover', (event) => {
      if (this.conversationSortMode !== 'manual') return;
      if (!event.dataTransfer?.types.includes('application/json')) return;

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      this.scheduleConversationReorderIndicator(
        convEl,
        this.getConversationReorderPlacement(convEl, event.clientY),
      );
    });

    convEl.addEventListener('dragleave', (event) => {
      const related = event.relatedTarget as Node | null;
      if (!related || !convEl.contains(related)) {
        this.clearConversationReorderIndicator(convEl);
      }
    });

    convEl.addEventListener('drop', (event) => {
      if (this.conversationSortMode !== 'manual') return;

      event.preventDefault();
      event.stopPropagation();

      const placement = this.getConversationReorderDropPlacement(
        convEl,
        this.getConversationReorderPlacement(convEl, event.clientY),
      );
      this.clearConversationReorderIndicator();

      const rawData = event.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);
        if (dragData.type !== 'conversation') return;

        this.selectedConversations.forEach((id) => {
          const element = this.findConversationElement(id);
          if (element) element.style.opacity = '1';
        });

        const insertIndex = placement === 'above' ? groupIndex : groupIndex + 1;
        const conversations = dragData.conversations ?? [];
        const sourceFolderId = dragData.sourceFolderId;

        if (!sourceFolderId) {
          this.ensureConversationsInFolder(folderId, dragData);
        }

        const effectiveSource = sourceFolderId ?? folderId;
        if (conversations.length > 0) {
          this.reorderOrMoveConversations(
            conversations.map((conversation) => conversation.conversationId),
            effectiveSource,
            folderId,
            insertIndex,
          );
        } else if (dragData.conversationId) {
          this.reorderOrMoveConversations(
            [dragData.conversationId],
            effectiveSource,
            folderId,
            insertIndex,
          );
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Conversation reorder drop error:', error);
      }
    });
  }

  private getConversationReorderPlacement(
    convEl: HTMLElement,
    clientY: number,
  ): ConversationReorderPlacement {
    const rect = convEl.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? 'above' : 'below';
  }

  private getConversationReorderDropPlacement(
    convEl: HTMLElement,
    fallback: ConversationReorderPlacement,
  ): ConversationReorderPlacement {
    if (this.pendingConversationReorderTarget?.element === convEl) {
      return this.pendingConversationReorderTarget.placement;
    }
    if (this.activeConversationReorderTarget?.element === convEl) {
      return this.activeConversationReorderTarget.placement;
    }
    return fallback;
  }

  private scheduleConversationReorderIndicator(
    element: HTMLElement,
    placement: ConversationReorderPlacement,
  ): void {
    this.pendingConversationReorderTarget = { element, placement };
    if (this.conversationReorderRafId !== null) return;

    this.conversationReorderRafId = window.requestAnimationFrame(() => {
      this.conversationReorderRafId = null;
      const target = this.pendingConversationReorderTarget;
      this.pendingConversationReorderTarget = null;
      if (target) this.applyConversationReorderIndicator(target);
    });
  }

  private applyConversationReorderIndicator(target: ConversationReorderTarget): void {
    if (!target.element.isConnected) {
      this.clearConversationReorderIndicator(target.element);
      return;
    }

    const active = this.activeConversationReorderTarget;
    if (active && (active.element !== target.element || active.placement !== target.placement)) {
      active.element.classList.remove('gv-reorder-above', 'gv-reorder-below');
    }

    target.element.classList.toggle('gv-reorder-above', target.placement === 'above');
    target.element.classList.toggle('gv-reorder-below', target.placement === 'below');
    this.activeConversationReorderTarget = target;
  }

  private clearConversationReorderIndicator(element?: HTMLElement): void {
    if (!element) {
      if (this.conversationReorderRafId !== null) {
        window.cancelAnimationFrame(this.conversationReorderRafId);
        this.conversationReorderRafId = null;
      }
      this.pendingConversationReorderTarget = null;
    } else if (this.pendingConversationReorderTarget?.element === element) {
      this.pendingConversationReorderTarget = null;
      if (this.conversationReorderRafId !== null) {
        window.cancelAnimationFrame(this.conversationReorderRafId);
        this.conversationReorderRafId = null;
      }
    }

    if (!element || this.activeConversationReorderTarget?.element === element) {
      this.activeConversationReorderTarget?.element.classList.remove(
        'gv-reorder-above',
        'gv-reorder-below',
      );
      this.activeConversationReorderTarget = null;
    }
  }

  private setLightweightDragImage(event: DragEvent, label: string): void {
    const transfer = event.dataTransfer;
    if (!transfer || typeof transfer.setDragImage !== 'function') return;

    const dragImage = document.createElement('div');
    dragImage.className = 'gv-folder-drag-image';
    dragImage.textContent = label;
    document.body.appendChild(dragImage);

    try {
      transfer.setDragImage(dragImage, 12, 12);
    } catch {
      dragImage.remove();
      return;
    }

    window.setTimeout(() => dragImage.remove(), 0);
  }

  /**
   * Create a thin drop zone between items for drag-and-drop reordering.
   * When an item is dragged over the gap, it expands and shows a blue indicator line.
   * On drop, it reorders the item to the target position.
   */
  private createReorderGap(
    parentId: string,
    itemType: 'folder' | 'conversation',
    insertIndex: number,
  ): HTMLElement {
    const gap = document.createElement('div');
    gap.className = 'gv-reorder-gap';
    gap.dataset.parentId = parentId;
    gap.dataset.itemType = itemType;
    gap.dataset.insertIndex = insertIndex.toString();

    gap.addEventListener('dragover', (e) => {
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      gap.classList.add('gv-reorder-gap-active');
    });

    gap.addEventListener('dragleave', () => {
      gap.classList.remove('gv-reorder-gap-active');
    });

    gap.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gap.classList.remove('gv-reorder-gap-active');

      const rawData = e.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);

        // Restore opacity for selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        if (itemType === 'folder' && dragData.type === 'folder' && dragData.folderId) {
          this.reorderFolder(dragData.folderId, parentId, insertIndex);
        } else if (itemType === 'conversation' && dragData.type === 'conversation') {
          const convs = dragData.conversations ?? [];
          const singleId = dragData.conversationId;
          const sourceFolderId = dragData.sourceFolderId;

          // If from outside any folder, add to folder data first
          if (!sourceFolderId) {
            this.ensureConversationsInFolder(parentId, dragData);
          }

          const effectiveSource = sourceFolderId ?? parentId;

          if (convs.length > 0) {
            this.reorderOrMoveConversations(
              convs.map((c) => c.conversationId),
              effectiveSource,
              parentId,
              insertIndex,
            );
          } else if (singleId) {
            this.reorderOrMoveConversations([singleId], effectiveSource, parentId, insertIndex);
          }
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Reorder drop error:', error);
      }
    });

    return gap;
  }

  /**
   * Reorder a folder within its parent (or move to a new parent at a specific position).
   */
  private reorderFolder(folderId: string, targetParentId: string, insertIndex: number): void {
    const targetParent = targetParentId === '__root__' ? null : targetParentId;
    const moved = this.moveFolder(folderId, targetParent, insertIndex);
    if (!moved) return;
    this.saveData();
    this.refresh();
  }

  /**
   * Silently add conversation(s) from dragData into a folder's data (no save/refresh).
   * Used before reorderOrMoveConversations so the conversations exist in the folder.
   */
  private ensureConversationsInFolder(folderId: string, dragData: DragData): void {
    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    const convs = dragData.conversations ?? [];
    const items: { id: string; title: string; url?: string; isGem?: boolean; gemId?: string }[] =
      convs.length > 0
        ? convs.map((c) => ({
            id: c.conversationId,
            title: c.title,
            url: c.url,
            isGem: c.isGem,
            gemId: c.gemId,
          }))
        : dragData.conversationId
          ? [
              {
                id: dragData.conversationId,
                title: dragData.title,
                url: dragData.url,
                isGem: dragData.isGem,
                gemId: dragData.gemId,
              },
            ]
          : [];

    let maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );

    for (const item of items) {
      const exists = this.data.folderContents[folderId].some((c) => c.conversationId === item.id);
      if (exists) continue;

      this.data.folderContents[folderId].push({
        conversationId: item.id,
        title: this.resolveDraggedConversationTitleForStorage(item.id, item.title),
        url: item.url ?? '',
        addedAt: Date.now(),
        isGem: item.isGem,
        gemId: item.gemId,
        sortIndex: ++maxSortIndex,
      });
    }
  }

  private resolveDraggedConversationTitleForStorage(conversationId: string, title: string): string {
    const normalizedTitle = title.trim();
    if (normalizedTitle && normalizedTitle !== 'Untitled') return normalizedTitle;

    return this.syncConversationTitleFromNative(conversationId) || normalizedTitle || 'Untitled';
  }

  /**
   * Reorder conversations within a folder, or move from one folder to another at a specific position.
   */
  private reorderOrMoveConversations(
    conversationIds: string[],
    sourceParentId: string,
    targetParentId: string,
    insertIndex: number,
  ): void {
    if (!this.data.folderContents[targetParentId]) {
      this.data.folderContents[targetParentId] = [];
    }

    const movingConvs: ConversationReference[] = [];

    // Deduplicate conversation IDs to prevent duplicates from cross-folder selection
    const uniqueIds = [...new Set(conversationIds)];

    // Collect conversation references
    for (const convId of uniqueIds) {
      const sourceList = this.data.folderContents[sourceParentId];
      if (!sourceList) continue;
      const conv = sourceList.find((c) => c.conversationId === convId);
      if (conv) movingConvs.push(conv);
    }

    if (movingConvs.length === 0) return;

    // When reordering within the same folder, insertIndex is based on the original
    // sorted list (which includes the dragged items). After removal, indices shift.
    // Adjust by subtracting the count of dragged items that were before insertIndex.
    if (sourceParentId === targetParentId) {
      const isStarredGroup = movingConvs[0].starred ?? false;
      const originalSorted = this.sortConversations(
        (this.data.folderContents[targetParentId] ?? []).filter(
          (c) => !!c.starred === isStarredGroup,
        ),
      );
      let adjustment = 0;
      for (const convId of conversationIds) {
        const origIdx = originalSorted.findIndex((c) => c.conversationId === convId);
        if (origIdx >= 0 && origIdx < insertIndex) {
          adjustment++;
        }
      }
      insertIndex -= adjustment;
    }

    // Remove from source
    if (this.data.folderContents[sourceParentId]) {
      const removeSet = new Set(conversationIds);
      this.data.folderContents[sourceParentId] = this.data.folderContents[sourceParentId].filter(
        (c) => !removeSet.has(c.conversationId),
      );
      // Reassign sortIndex in source if it changed
      if (sourceParentId !== targetParentId) {
        const sourceConvs = this.sortConversations(this.data.folderContents[sourceParentId]);
        sourceConvs.forEach((c, i) => {
          c.sortIndex = i;
        });
      }
    }

    // Get target starred group info for proper insertion
    const isStarred = movingConvs[0].starred ?? false;
    const targetList = this.data.folderContents[targetParentId].filter(
      (c) => !conversationIds.includes(c.conversationId),
    );
    this.data.folderContents[targetParentId] = targetList;

    // Get sorted siblings in the same starred group (dragged items already excluded)
    const sameGroupSiblings = this.sortConversations(
      targetList.filter((c) => !!c.starred === isStarred),
    );
    const otherGroup = targetList.filter((c) => !!c.starred !== isStarred);

    // Clamp insertIndex to valid range after removal
    const clampedIndex = Math.min(insertIndex, sameGroupSiblings.length);

    // Insert at position
    sameGroupSiblings.splice(clampedIndex, 0, ...movingConvs);

    // Reassign sortIndex
    sameGroupSiblings.forEach((c, i) => {
      c.sortIndex = i;
    });
    otherGroup.forEach((c, i) => {
      if (c.sortIndex == null) c.sortIndex = i;
    });

    // Recombine
    this.data.folderContents[targetParentId] = [...sameGroupSiblings, ...otherGroup];

    this.saveData();
    this.refresh();
  }

  private addConversationToFolder(
    folderId: string,
    dragData: DragData & { sourceFolderId?: string },
  ): void {
    this.debug('Adding conversation to folder:', {
      folderId,
      dragData,
    });

    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    // Check if conversation is already in this folder
    const exists = this.data.folderContents[folderId].some(
      (c) => c.conversationId === dragData.conversationId,
    );

    if (exists) {
      this.debug('Conversation already in folder:', dragData.conversationId);
      this.debug('Existing conversations:', this.data.folderContents[folderId]);
      return;
    }

    const maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );
    const conversationId = dragData.conversationId!;
    const conv: ConversationReference = {
      conversationId,
      title: this.resolveDraggedConversationTitleForStorage(conversationId, dragData.title),
      url: dragData.url!,
      addedAt: Date.now(),
      isGem: dragData.isGem,
      gemId: dragData.gemId,
      sortIndex: maxSortIndex + 1,
    };

    this.data.folderContents[folderId].push(conv);
    this.debug('Conversation added. Total in folder:', this.data.folderContents[folderId].length);

    // If this was dragged from another folder, remove it from the source
    if (dragData.sourceFolderId && dragData.sourceFolderId !== folderId) {
      this.debug('Moving from folder:', dragData.sourceFolderId);
      this.removeConversationFromFolder(dragData.sourceFolderId, dragData.conversationId!);
      // Note: removeConversationFromFolder calls saveData() and refresh(), so we don't need to call them again
      // Folder→folder move is not a "first archive"; skip the nudge.
      return;
    }

    // Save immediately before refresh to persist data
    this.saveData();
    this.refresh();
    this.maybeShowHideArchivedNudge();
  }

  // Batch add conversations to folder (for multi-select support)
  private addConversationsToFolder(
    folderId: string,
    conversations: ConversationReference[],
    sourceFolderId?: string,
  ): void {
    this.debug('Adding multiple conversations to folder:', {
      folderId,
      count: conversations.length,
      sourceFolderId,
    });

    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    let addedCount = 0;
    const conversationsToRemove: string[] = [];
    let maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );

    conversations.forEach((conv) => {
      // Check if conversation is already in this folder
      const exists = this.data.folderContents[folderId].some(
        (c) => c.conversationId === conv.conversationId,
      );

      if (!exists) {
        maxSortIndex++;
        // Create a copy with updated timestamp
        const newConv: ConversationReference = {
          ...conv,
          title: sourceFolderId
            ? conv.title
            : this.resolveDraggedConversationTitleForStorage(conv.conversationId, conv.title),
          addedAt: Date.now(),
          sortIndex: maxSortIndex,
        };

        this.data.folderContents[folderId].push(newConv);
        addedCount++;

        // Track conversations to remove from source folder
        if (sourceFolderId && sourceFolderId !== folderId) {
          conversationsToRemove.push(conv.conversationId);
        }
      }
    });

    this.debug(
      `Added ${addedCount} conversations. Total in folder:`,
      this.data.folderContents[folderId].length,
    );

    // Remove from source folder if moving
    if (sourceFolderId && sourceFolderId !== folderId && conversationsToRemove.length > 0) {
      this.debug('Removing conversations from source folder:', sourceFolderId);
      conversationsToRemove.forEach((convId) => {
        this.data.folderContents[sourceFolderId] = this.data.folderContents[sourceFolderId].filter(
          (c) => c.conversationId !== convId,
        );
      });
    }

    // Save immediately before refresh to persist data
    this.saveData();
    this.refresh();
    // Trigger nudge only if at least one conversation was actually added from
    // outside. If the whole batch came from another folder (sourceFolderId set),
    // it's a folder→folder move and not a "first archive" event.
    if (addedCount > 0 && !sourceFolderId) {
      this.maybeShowHideArchivedNudge();
    }
  }

  private addFolderToFolder(targetFolderId: string, dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to folder:', {
      draggedFolderId,
      targetFolderId,
    });

    const moved = this.moveFolder(draggedFolderId, targetFolderId);
    if (!moved) {
      this.debug('Folder move rejected');
      return;
    }
    this.saveData();
    this.refresh();
  }

  private moveFolderToRoot(dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to root level:', draggedFolderId);

    const moved = this.moveFolder(draggedFolderId, null);
    if (!moved) {
      this.debug('Folder move to root rejected');
      return;
    }
    this.saveData();
    this.refresh();
  }

  private isFolderDescendant(folderId: string, potentialAncestorId: string): boolean {
    // Check if potentialAncestorId is an ancestor of folderId
    let currentId: string | null = folderId;
    while (currentId) {
      if (currentId === potentialAncestorId) {
        return true;
      }
      const folder = this.data.folders.find((f) => f.id === currentId);
      currentId = folder?.parentId || null;
    }
    return false;
  }

  /**
   * Distance from a folder to the root — 0 for a top-level folder, 1 for a
   * subfolder, etc. Returns 0 for unknown ids so callers can treat "not found"
   * the same as "at root" for gating purposes (they'll also fail their own
   * existence check before mutating).
   */
  private getFolderDepth(folderId: string): number {
    let depth = 0;
    let current = this.data.folders.find((f) => f.id === folderId);
    while (current?.parentId) {
      depth += 1;
      current = this.data.folders.find((f) => f.id === current?.parentId);
    }
    return depth;
  }

  private toggleConversationStar(folderId: string, conversationId: string): void {
    const conversations = this.data.folderContents[folderId];
    if (!conversations) return;

    const conv = conversations.find((c) => c.conversationId === conversationId);
    if (!conv) return;

    // Toggle starred state
    conv.starred = !conv.starred;

    // Save data
    this.saveData();

    // Refresh the folder UI to update the star icon and re-sort
    this.refresh();

    this.debug('Toggled star for conversation:', conversationId, 'starred:', conv.starred);
  }

  private confirmRemoveConversation(
    folderId: string,
    conversationId: string,
    title: string,
    event: MouseEvent,
  ): void {
    // Create inline confirmation dialog using safe DOM API
    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'gv-folder-confirm-dialog';

    // Create message element safely with user-provided title
    const message = document.createElement('div');
    message.className = 'gv-folder-confirm-message';
    // Safe: textContent prevents XSS even with user-controlled title
    message.textContent = this.t('folder_remove_conversation_confirm').replace('{title}', title);

    // Create actions container
    const actions = document.createElement('div');
    actions.className = 'gv-folder-confirm-actions';

    // Create buttons safely
    const yesBtn = document.createElement('button');
    yesBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
    yesBtn.textContent = this.t('pm_delete'); // Safe: uses textContent

    const noBtn = document.createElement('button');
    noBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
    noBtn.textContent = this.t('pm_cancel'); // Safe: uses textContent

    // Assemble the dialog
    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    confirmDialog.appendChild(message);
    confirmDialog.appendChild(actions);

    // Position near the clicked element
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    confirmDialog.style.position = 'fixed';
    confirmDialog.style.top = `${rect.bottom + 4}px`;
    confirmDialog.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;

    document.body.appendChild(confirmDialog);

    // Cleanup function
    const cleanup = () => {
      confirmDialog.remove();
    };

    yesBtn?.addEventListener('click', () => {
      this.removeConversationFromFolder(folderId, conversationId);
      cleanup();
    });

    noBtn?.addEventListener('click', cleanup);

    // Close on click outside
    setTimeout(() => {
      const closeOnOutside = (e: MouseEvent) => {
        if (!confirmDialog.contains(e.target as Node)) {
          cleanup();
          document.removeEventListener('click', closeOnOutside);
        }
      };
      document.addEventListener('click', closeOnOutside);
    }, 0);
  }

  private removeConversationFromFolder(folderId: string, conversationId: string): void {
    if (!this.data.folderContents[folderId]) return;

    this.data.folderContents[folderId] = this.data.folderContents[folderId].filter(
      (c) => c.conversationId !== conversationId,
    );

    this.saveData();
    this.refresh();
  }

  private batchDeleteConversations(): void {
    if (!this.multiSelectFolderId || this.selectedConversations.size === 0) return;

    const count = this.selectedConversations.size;
    const confirmed = confirm(
      `Delete ${count} selected conversation${count > 1 ? 's' : ''} from this folder?`,
    );

    if (!confirmed) return;

    // Remove all selected conversations from the folder
    const folderId = this.multiSelectFolderId;
    if (!this.data.folderContents[folderId]) return;

    this.data.folderContents[folderId] = this.data.folderContents[folderId].filter(
      (c) => !this.selectedConversations.has(c.conversationId),
    );

    this.saveData();

    // Exit multi-select mode and refresh
    this.exitMultiSelectMode();
    this.refresh();

    this.debug(`Batch deleted ${count} conversations from folder ${folderId}`);
  }

  /**
   * Batch delete native Gemini conversations by simulating user clicks
   * This triggers the actual deletion on Gemini's servers
   */
  private async batchDeleteNativeConversations(): Promise<void> {
    if (this.batchDeleteInProgress) {
      this.debug('Batch delete already in progress');
      return;
    }

    const count = this.selectedConversations.size;
    if (count === 0) return;

    // Show confirmation dialog
    const confirmMessage = this.t('batch_delete_confirm').replace('{count}', String(count));
    const confirmed = confirm(confirmMessage);
    if (!confirmed) return;

    this.batchDeleteInProgress = true;
    const conversationIds = Array.from(this.selectedConversations);
    let successCount = 0;
    let failedCount = 0;

    try {
      // Show progress indicator
      this.showBatchDeleteProgress(0, count);

      for (let i = 0; i < conversationIds.length; i++) {
        const conversationId = conversationIds[i];
        this.debug(`Deleting conversation ${i + 1}/${count}: ${conversationId}`);

        // Update progress
        this.updateBatchDeleteProgress(i + 1, count);

        try {
          const success = await this.triggerNativeDeleteForConversation(conversationId);
          if (success) {
            successCount++;
          } else {
            failedCount++;
            this.debugWarn(`Failed to delete conversation: ${conversationId}`);
          }
        } catch (error) {
          failedCount++;
          console.error(`[FolderManager] Error deleting conversation ${conversationId}:`, error);
        }

        // Add delay between deletions to avoid rate limiting
        if (i < conversationIds.length - 1) {
          await this.delay(this.BATCH_DELETE_CONFIG.DELAY_BETWEEN_DELETIONS);
        }
      }

      // Hide progress indicator
      this.hideBatchDeleteProgress();

      // Show result summary
      if (failedCount === 0) {
        const successMessage = this.t('batch_delete_success').replace(
          '{count}',
          String(successCount),
        );
        this.showNotification(successMessage, 'success');
      } else {
        const partialMessage = this.t('batch_delete_partial')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(failedCount));
        this.showNotification(partialMessage, 'info');
      }

      // Exit multi-select mode
      this.exitMultiSelectMode();

      // Refresh page after deletion
      if (successCount > 0) {
        this.debug('Refreshing page after batch delete');
        setTimeout(() => {
          window.location.reload();
        }, this.BATCH_DELETE_CONFIG.PAGE_REFRESH_DELAY);
      }
    } finally {
      this.batchDeleteInProgress = false;
    }
  }

  /**
   * Trigger native delete for a single conversation by simulating UI interactions
   */
  private async triggerNativeDeleteForConversation(conversationId: string): Promise<boolean> {
    try {
      // Step 1: Find the conversation element in the sidebar.
      // The lr26 sidebar virtualizes rows — if the user has scrolled the list
      // since selecting, the target row may be unmounted entirely.
      const conversationEl = this.findNativeConversationElement(conversationId);
      if (!conversationEl) {
        console.warn(
          `[FolderManager] Batch delete: conversation row not in DOM (likely virtualized out): ${conversationId}. ` +
            'Scroll the sidebar to bring it back into view, or split the batch into smaller chunks.',
        );
        return false;
      }

      const moreButton = await this.findAndClickMoreButton(conversationEl);
      if (!moreButton) {
        console.warn(
          `[FolderManager] Batch delete: actions menu button not found for ${conversationId}`,
        );
        return false;
      }

      await this.delay(this.BATCH_DELETE_CONFIG.MENU_APPEAR_DELAY);

      const deleteSuccess = await this.waitForDeleteButtonAndClick();
      if (!deleteSuccess) {
        console.warn(
          `[FolderManager] Batch delete: Delete menu item not found after ${this.BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME}ms for ${conversationId}`,
        );
        this.clickBackdropToCloseMenu();
        return false;
      }

      await this.delay(this.BATCH_DELETE_CONFIG.DIALOG_APPEAR_DELAY);
      await this.confirmDeleteIfNeeded();
      await this.delay(this.BATCH_DELETE_CONFIG.DELETION_COMPLETE_DELAY);

      return true;
    } catch (error) {
      console.error(`[FolderManager] Error in triggerNativeDeleteForConversation:`, error);
      return false;
    }
  }

  /**
   * Find native conversation element by conversation ID
   */
  private findNativeConversationElement(conversationId: string): HTMLElement | null {
    const targetId = this.normalizeConversationId(conversationId);
    if (!targetId) return null;

    // Try multiple strategies to find the conversation
    const allConversations = this.getNativeConversationElements();

    for (const conv of allConversations) {
      const id =
        this.extractConversationIdFromElement(conv) ||
        this.extractConversationId(conv as HTMLElement);
      if (this.normalizeConversationId(id) === targetId) {
        return conv as HTMLElement;
      }
    }

    return null;
  }

  /**
   * Find and click the more options button for a conversation.
   *
   * In Gemini's current sidebar layout the actions-menu-button is rendered
   * INSIDE the conversation host (<gem-nav-list-item data-test-id="conversation">),
   * so we look there first. The legacy sibling-container and ancestor-<li>
   * strategies are kept as fallbacks for older layouts but are no-ops in the
   * lr26 sidebar.
   *
   * The host is also virtualized — a row scrolled far off-screen may exist
   * only as an empty stub or be missing entirely. Scroll the host into view
   * before clicking so the trailing actions actually mount.
   */
  private async findAndClickMoreButton(conversationEl: HTMLElement): Promise<HTMLElement | null> {
    const locate = (): HTMLElement | null => {
      // Primary: button is inside the conversation host (current lr26 layout).
      const inside = conversationEl.querySelector<HTMLElement>(
        '[data-test-id="actions-menu-button"]',
      );
      if (inside) return inside;

      // Fallback: legacy sibling .conversation-actions-container layout.
      const actionsContainer = conversationEl.parentElement?.querySelector(
        '.conversation-actions-container',
      );
      const sibling = actionsContainer?.querySelector<HTMLElement>(
        '[data-test-id="actions-menu-button"]',
      );
      if (sibling) return sibling;

      // Fallback: nearest <li> ancestor (very old layout).
      return (
        conversationEl
          .closest('li')
          ?.querySelector<HTMLElement>('[data-test-id="actions-menu-button"]') ?? null
      );
    };

    let moreButton = locate();

    // If the row was virtualized away from the viewport its trailing actions
    // may not have mounted yet. Scroll it back into view and poll briefly.
    if (!moreButton) {
      try {
        conversationEl.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      } catch {
        /* scrollIntoView may throw in some embedded contexts — ignore */
      }
      const maxWait = this.BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
      const step = this.BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
      let waited = 0;
      while (waited < maxWait && !moreButton) {
        await this.delay(step);
        waited += step;
        moreButton = locate();
      }
    }

    if (moreButton) {
      moreButton.click();
      this.debug('Clicked more button');
      return moreButton;
    }

    console.warn(
      '[FolderManager] Could not locate actions-menu-button inside conversation host. ' +
        'Gemini sidebar DOM may have changed.',
      conversationEl,
    );
    return null;
  }

  private async openNativeRenameForFolderConversation(
    conversation: ConversationReference,
  ): Promise<boolean> {
    const conversationId =
      this.normalizeConversationId(conversation.conversationId) ||
      this.extractConversationIdFromHref(conversation.url);
    if (!conversationId) return false;

    const conversationEl = this.findNativeConversationElement(conversationId);
    if (!conversationEl) {
      this.debugWarn('Could not find native conversation element for rename:', conversationId);
      return false;
    }

    const restoreArchivedVisibility = this.temporarilyRevealNativeConversation(conversationEl);
    const nativeTitle = this.extractNativeConversationTitle(conversationEl);
    let moreButton: HTMLElement | null = null;

    try {
      moreButton = await this.findAndClickMoreButton(conversationEl);
      if (!moreButton) {
        this.debugWarn('Could not find native more button for rename:', conversationId);
        return false;
      }

      const renamed = await this.waitForRenameButtonAndClick();
      if (!renamed) {
        this.debugWarn('Could not find native rename button:', conversationId);
      } else {
        await this.restoreNativeTitleSync(conversationId, nativeTitle);
      }
      return renamed;
    } finally {
      if (moreButton) {
        this.resetNativeConversationMenuTrigger(moreButton);
      }
      restoreArchivedVisibility();
    }
  }

  private async restoreNativeTitleSync(
    conversationId: string,
    nativeTitle: string | null,
  ): Promise<void> {
    const title = nativeTitle?.trim() || null;
    const updatedAt = Date.now();
    let updated = false;

    for (const folderId in this.data.folderContents) {
      for (const conversation of this.data.folderContents[folderId]) {
        if (!this.isSameConversation(conversationId, conversation)) continue;

        if (conversation.customTitle) {
          delete conversation.customTitle;
          updated = true;
        }

        if (title && conversation.title !== title) {
          conversation.title = title;
          conversation.updatedAt = updatedAt;
          updated = true;
        }
      }
    }

    if (!updated) return;

    await this.saveData();
    this.renderAllFolders();
  }

  private temporarilyRevealNativeConversation(conversationEl: HTMLElement): () => void {
    const wasArchived = conversationEl.classList.contains('gv-conversation-archived');
    const actionsContainer = this.getNativeConversationActionsContainer(conversationEl);
    const wereActionsArchived =
      actionsContainer?.classList.contains(ARCHIVED_CONVERSATION_ACTIONS_CLASS) ?? false;
    if (!wasArchived && !wereActionsArchived) return () => {};

    conversationEl.classList.remove('gv-conversation-archived');
    actionsContainer?.classList.remove(ARCHIVED_CONVERSATION_ACTIONS_CLASS);
    return () => {
      if (this.hideArchivedConversations) {
        this.setNativeConversationArchivedState(conversationEl, true);
      }
    };
  }

  private resetNativeConversationMenuTrigger(moreButton: HTMLElement): void {
    moreButton.blur();
    const actionsContainer = moreButton.closest('.conversation-actions-container');
    if (actionsContainer instanceof HTMLElement) {
      actionsContainer.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
  }

  private async waitForRenameButtonAndClick(): Promise<boolean> {
    const maxWaitTime = this.BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
    const checkInterval = this.BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const renameByTestId = document.querySelector(
        '[data-test-id="rename-button"]',
      ) as HTMLElement | null;
      if (renameByTestId && this.isVisibleElement(renameByTestId)) {
        renameByTestId.click();
        this.debug('Clicked rename button (by test-id)');
        return true;
      }

      const renameIcons = document.querySelectorAll(
        '.cdk-overlay-container mat-icon, .cdk-overlay-container .material-icons',
      );

      for (const icon of renameIcons) {
        const iconText = icon.textContent?.toLowerCase().trim() || '';
        if (iconText !== 'edit' && iconText !== 'edit_square') continue;

        const parentButton = icon.closest('button, [role="menuitem"]') as HTMLElement | null;
        if (parentButton && this.isVisibleElement(parentButton)) {
          parentButton.click();
          this.debug('Clicked rename button (by icon)');
          return true;
        }
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    return false;
  }

  /**
   * Wait for delete button to appear in the menu and click it
   * Uses multiple strategies to find the delete button for resilience to UI changes
   */
  private async waitForDeleteButtonAndClick(): Promise<boolean> {
    const maxWaitTime = this.BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
    const checkInterval = this.BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    const keywords = this.getDeleteKeywords();

    // Track per-poll state so we can emit one summary diagnostic on timeout.
    let lastTestIdCount = 0;
    let lastVisibleTestIdCount = 0;
    let lastOverlayPanes = 0;
    let lastMenuPanels = 0;
    let lastMenuItemTexts: string[] = [];

    while (elapsed < maxWaitTime) {
      // Strategy 1: data-test-id (primary). Use querySelectorAll because some
      // layouts render hidden template copies that querySelector would lock
      // onto, never advancing past an invisible match.
      const deleteCandidates = Array.from(
        document.querySelectorAll<HTMLElement>('[data-test-id="delete-button"]'),
      );
      lastTestIdCount = deleteCandidates.length;
      const visibleByTestId = deleteCandidates.filter((el) => this.isVisibleElement(el));
      lastVisibleTestIdCount = visibleByTestId.length;
      // Prefer one that lives inside an open menu / overlay panel.
      const targetByTestId =
        visibleByTestId.find((el) => el.closest('.mat-mdc-menu-panel, .cdk-overlay-pane')) ??
        visibleByTestId[0];
      if (targetByTestId) {
        targetByTestId.click();
        this.debug('Clicked delete button (by test-id)');
        return true;
      }

      // Strategy 2: scan menu items for matching text (i18n-friendly).
      const menuItems = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container button[role="menuitem"], ' +
            '.cdk-overlay-container [role="menuitem"], ' +
            '.mat-mdc-menu-content button, ' +
            '.mat-menu-content button',
        ),
      );
      lastMenuItemTexts = menuItems.map((el) => el.textContent?.trim().slice(0, 20) || '');

      for (const item of menuItems) {
        if (!this.isVisibleElement(item)) continue;
        const text = item.textContent?.toLowerCase().trim() || '';
        if (
          text &&
          keywords.some(
            (keyword: string) => text === keyword || (text.includes(keyword) && text.length < 20),
          )
        ) {
          item.click();
          this.debug('Clicked delete button (by text):', text);
          return true;
        }
      }

      // Strategy 3: by icon (mat-icon delete / delete_forever / delete_outline).
      const deleteIcons = document.querySelectorAll(
        '.cdk-overlay-container mat-icon, .cdk-overlay-container .material-icons',
      );
      for (const icon of deleteIcons) {
        const iconText = icon.textContent?.toLowerCase().trim() || '';
        const iconAttr = icon.getAttribute('fonticon') || '';
        if (
          iconText === 'delete' ||
          iconText === 'delete_forever' ||
          iconText === 'delete_outline' ||
          iconAttr === 'delete' ||
          iconAttr === 'delete_forever' ||
          iconAttr === 'delete_outline'
        ) {
          const parentButton = icon.closest('button, [role="menuitem"]') as HTMLElement | null;
          if (parentButton && this.isVisibleElement(parentButton)) {
            parentButton.click();
            this.debug('Clicked delete button (by icon)');
            return true;
          }
        }
      }

      lastOverlayPanes = document.querySelectorAll('.cdk-overlay-pane').length;
      lastMenuPanels = document.querySelectorAll('.mat-mdc-menu-panel').length;

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    // Emit a SINGLE compact diagnostic on timeout so users can paste it
    // verbatim when reporting batch-delete failures.
    console.warn(
      '[FolderManager] Batch delete diagnostics on timeout: ' +
        JSON.stringify({
          deleteButtonsFound: lastTestIdCount,
          deleteButtonsVisible: lastVisibleTestIdCount,
          overlayPanes: lastOverlayPanes,
          menuPanels: lastMenuPanels,
          menuItemTexts: lastMenuItemTexts.slice(0, 10),
          keywordsTried: keywords,
        }),
    );
    return false;
  }

  /**
   * Check for and confirm the delete confirmation dialog if it appears
   */
  private async confirmDeleteIfNeeded(): Promise<void> {
    // Look for confirmation dialog buttons
    // Gemini typically uses a dialog with confirm/cancel buttons
    const maxWaitTime = this.BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
    const checkInterval = this.BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
    let elapsed = 0;

    const keywords = this.getDeleteKeywords();

    while (elapsed < maxWaitTime) {
      // Strategy 1: Look for button with data-test-id containing "confirm" or "delete"
      const confirmByTestId = document.querySelector(
        '[data-test-id*="confirm"], [data-test-id*="delete"]:not([data-test-id="delete-button"])',
      ) as HTMLElement;
      if (confirmByTestId && this.isVisibleElement(confirmByTestId)) {
        confirmByTestId.click();
        this.debug('Clicked confirmation button (by test-id)');
        return;
      }

      // Strategy 2: Look for primary/action buttons in dialogs
      const primaryButtons = document.querySelectorAll(`
        .mat-mdc-dialog-container button.mat-primary,
        .mat-mdc-dialog-container button.mat-accent,
        .mat-mdc-dialog-container .mat-mdc-dialog-actions button:last-child,
        .cdk-overlay-container .mat-mdc-dialog-actions button:last-child,
        .cdk-overlay-container button[color="primary"],
        .cdk-overlay-container button[color="warn"]
      `);

      for (const btn of primaryButtons) {
        if (this.isVisibleElement(btn as HTMLElement)) {
          const text = btn.textContent?.toLowerCase().trim() || '';
          // Match keywords from i18n
          if (
            text &&
            keywords.some((keyword: string) => text.includes(keyword) || text === keyword)
          ) {
            (btn as HTMLElement).click();
            this.debug('Clicked confirmation button (primary button):', text);
            return;
          }
        }
      }

      // Strategy 3: Look for any button in overlay with delete/confirm text
      const allOverlayButtons = document.querySelectorAll(
        '.cdk-overlay-container button, .mat-mdc-dialog-container button',
      );

      for (const btn of allOverlayButtons) {
        if (!this.isVisibleElement(btn as HTMLElement)) continue;

        const text = btn.textContent?.toLowerCase().trim() || '';
        // Be more specific - look for exact match or simple inclusion for keywords
        if (text && keywords.some((keyword: string) => text === keyword)) {
          (btn as HTMLElement).click();
          this.debug('Clicked confirmation button (overlay button):', text);
          return;
        }
      }

      // Strategy 4: Look for the second/right button in a two-button dialog (usually the confirm button)
      const dialogActions = document.querySelector(
        '.mat-mdc-dialog-actions, .cdk-overlay-container .mat-dialog-actions',
      );
      if (dialogActions) {
        const buttons = dialogActions.querySelectorAll('button');
        if (buttons.length >= 2) {
          // The last button is typically the confirm/destructive action
          const confirmBtn = buttons[buttons.length - 1] as HTMLElement;
          if (this.isVisibleElement(confirmBtn)) {
            confirmBtn.click();
            this.debug('Clicked last button in dialog actions');
            return;
          }
        }
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    // No confirmation dialog found, which is fine
    this.debug('No confirmation dialog detected after', maxWaitTime, 'ms');
  }

  /**
   * Get delete/confirm keywords from i18n settings to avoid hardcoding
   */
  private getDeleteKeywords(): string[] {
    const rawPatterns = this.t('batch_delete_match_patterns') || '';
    // Split on both ASCII and CJK fullwidth commas (and a couple of common
    // separators) so locales authored with `，` / `、` / `；` don't end up as
    // one giant unsplittable string.
    return rawPatterns
      .split(/[,，、；;]+/)
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => s.length > 0);
  }

  /**
   * Check if an element is visible
   */
  private isVisibleElement(el: HTMLElement): boolean {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    );
  }

  /**
   * Click backdrop to close any open menu
   */
  private clickBackdropToCloseMenu(): void {
    const backdrop = document.querySelector('.cdk-overlay-backdrop') as HTMLElement;
    if (backdrop) {
      backdrop.click();
      this.debug('Clicked backdrop to close menu');
    }
  }

  /**
   * Show batch delete progress indicator
   */
  private showBatchDeleteProgress(current: number, total: number): void {
    // Remove existing progress element if any
    this.hideBatchDeleteProgress();

    const progress = document.createElement('div');
    progress.className = 'gv-batch-delete-progress';
    progress.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(32, 33, 36, 0.95);
      color: #e8eaed;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      font-size: 14px;
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width: 20px;
      height: 20px;
      border: 2px solid #8ab4f8;
      border-top-color: transparent;
      border-radius: 50%;
      animation: gv-spin 1s linear infinite;
    `;

    // Add spinner animation if not already present
    if (!document.querySelector('#gv-batch-delete-styles')) {
      const style = document.createElement('style');
      style.id = 'gv-batch-delete-styles';
      style.textContent = `
        @keyframes gv-spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    const text = document.createElement('span');
    text.className = 'gv-batch-delete-progress-text';
    text.textContent = this.t('batch_delete_in_progress')
      .replace('{current}', String(current))
      .replace('{total}', String(total));

    progress.appendChild(spinner);
    progress.appendChild(text);
    document.body.appendChild(progress);

    this.batchDeleteProgressElement = progress;
  }

  /**
   * Update batch delete progress indicator
   */
  private updateBatchDeleteProgress(current: number, total: number): void {
    if (this.batchDeleteProgressElement) {
      const textEl = this.batchDeleteProgressElement.querySelector(
        '.gv-batch-delete-progress-text',
      );
      if (textEl) {
        textEl.textContent = this.t('batch_delete_in_progress')
          .replace('{current}', String(current))
          .replace('{total}', String(total));
      }
    }
  }

  /**
   * Hide batch delete progress indicator
   */
  private hideBatchDeleteProgress(): void {
    if (this.batchDeleteProgressElement) {
      this.batchDeleteProgressElement.remove();
      this.batchDeleteProgressElement = null;
    }
  }

  /**
   * Helper function to create a delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Multi-select helper methods
  private clearSelection(): void {
    this.selectedConversations.clear();
  }

  private selectConversation(conversationId: string): void {
    this.selectedConversations.add(conversationId);
  }

  private toggleConversationSelection(conversationId: string): void {
    if (this.selectedConversations.has(conversationId)) {
      this.selectedConversations.delete(conversationId);

      // Auto-exit multi-select mode when all selections are cleared
      if (this.selectedConversations.size === 0 && this.isMultiSelectMode) {
        this.exitMultiSelectMode();
        return;
      }
    } else {
      // Check if we've reached the maximum selection limit
      if (this.selectedConversations.size >= this.MAX_BATCH_DELETE_COUNT) {
        const message = this.t('batch_delete_limit_reached').replace(
          '{max}',
          String(this.MAX_BATCH_DELETE_COUNT),
        );
        this.showNotification(message, 'info');
        return;
      }
      this.selectedConversations.add(conversationId);
    }
  }

  private updateConversationSelectionUI(): void {
    // Only update UI for the source where multi-select was initiated
    if (this.multiSelectSource === 'folder') {
      // Only update folder conversation elements
      const allConvEls = this.containerElement?.querySelectorAll('.gv-folder-conversation');
      allConvEls?.forEach((el) => {
        const convId = (el as HTMLElement).dataset.conversationId;
        const elFolderId = (el as HTMLElement).dataset.folderId;

        // Only update conversations in the same folder where multi-select started
        if (convId && (!this.multiSelectFolderId || elFolderId === this.multiSelectFolderId)) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-folder-conversation-selected');
          } else {
            el.classList.remove('gv-folder-conversation-selected');
          }
        }
      });
    } else if (this.multiSelectSource === 'native') {
      // Only update native conversation elements (Recent section)
      const nativeConvs = this.getNativeConversationElements();
      nativeConvs.forEach((el) => {
        const convId = this.extractConversationId(el as HTMLElement);
        if (convId) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-conversation-selected');
          } else {
            el.classList.remove('gv-conversation-selected');
          }
        }
      });
    }

    // Update the selection count
    this.updateMultiSelectModeUI();
  }

  private enterMultiSelectMode(
    initialConversationId?: string,
    source: 'folder' | 'native' = 'native',
    folderId?: string,
  ): void {
    this.debug('Entering multi-select mode', { source, folderId });
    this.isMultiSelectMode = true;
    this.multiSelectSource = source;
    this.multiSelectFolderId = folderId || null;

    // Select the conversation that triggered the long-press
    if (initialConversationId) {
      this.selectConversation(initialConversationId);
    }

    this.updateMultiSelectModeUI();
    this.updateConversationSelectionUI();

    // Add visual feedback (vibration on mobile)
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    // Add click-outside listener to exit multi-select mode
    this.setupOutsideClickHandler();
  }

  private exitMultiSelectMode(): void {
    this.debug('Exiting multi-select mode');
    this.isMultiSelectMode = false;
    this.multiSelectSource = null;
    this.multiSelectFolderId = null;

    // Remove click-outside listener
    this.removeOutsideClickHandler();

    // First update UI to remove selection styles
    this.updateConversationSelectionUI();

    // Then clear the selection set
    this.clearSelection();

    // Update mode UI
    this.updateMultiSelectModeUI();

    // Force cleanup of any remaining visual artifacts
    this.cleanupSelectionArtifacts();
  }

  /**
   * Setup a document-level click handler to exit multi-select mode when clicking outside the sidebar
   */
  private setupOutsideClickHandler(): void {
    // Remove any existing handler first
    this.removeOutsideClickHandler();

    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if click is inside the sidebar or folder container
      const isInsideSidebar =
        this.sidebarContainer?.contains(target) ||
        !!target.closest('[data-test-id="overflow-container"]');
      const isInsideFolderContainer = this.containerElement?.contains(target);
      const isInsideMultiSelectHost = this.multiSelectHostElement?.contains(target);

      // Check if click is on an overlay (menus, dialogs, etc.)
      const isOnOverlay = target.closest('.cdk-overlay-container, .mat-mdc-dialog-container');

      // If click is outside all relevant areas, exit multi-select mode
      if (
        !isInsideSidebar &&
        !isInsideFolderContainer &&
        !isInsideMultiSelectHost &&
        !isOnOverlay
      ) {
        this.debug('Click outside sidebar detected, exiting multi-select mode');
        this.exitMultiSelectMode();
      }
    };

    // Use setTimeout to avoid the current click event from triggering the handler
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler!, true);
    }, 0);
  }

  /**
   * Remove the outside click handler
   */
  private removeOutsideClickHandler(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
  }

  private cleanupSelectionArtifacts(): void {
    // Remove selection classes from all native conversations
    const nativeConvs = this.getNativeConversationElements();
    nativeConvs.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });
    // Remove selection classes from all folder conversations
    const folderConvs = this.containerElement?.querySelectorAll('.gv-folder-conversation');
    folderConvs?.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-folder-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });

    // Restore active conversation highlight in folders
    // This ensures that the currently active conversation remains highlighted
    // after drag-and-drop or multi-select operations
    this.highlightActiveConversationInFolders();
  }

  /**
   * Provides visual feedback when user attempts to select conversations from different folders.
   * Uses a subtle shake animation to indicate invalid selection.
   *
   * @param element - The conversation element to apply feedback to
   *
   * Note: Uses animationend event instead of setTimeout to ensure cleanup happens
   * exactly when the CSS animation finishes, making it resilient to animation timing changes.
   */
  private showInvalidSelectionFeedback(element: HTMLElement): void {
    // Remove existing class (if any) to allow animation restart on rapid clicks
    element.classList.remove('gv-invalid-selection');

    // Force reflow to ensure animation restarts (see: CSS Triggers)
    void element.offsetWidth;

    // Add invalid selection class to trigger animation
    element.classList.add('gv-invalid-selection');

    // Listen for animation end to clean up the class automatically
    // Using { once: true } ensures the listener is removed after first invocation
    element.addEventListener(
      'animationend',
      () => {
        element.classList.remove('gv-invalid-selection');
      },
      { once: true },
    );

    // Optional: Haptic feedback on mobile devices
    if ('vibrate' in navigator) {
      navigator.vibrate([30, 20, 30]); // Two short vibrations
    }
  }

  private updateMultiSelectModeUI(): void {
    const multiSelectHost = this.isMultiSelectMode
      ? this.getMultiSelectHost()
      : this.getExistingMultiSelectHost();

    // Add or remove multi-select mode class from container
    if (this.isMultiSelectMode) {
      multiSelectHost?.classList.add('gv-multi-select-mode');
    } else {
      multiSelectHost?.classList.remove('gv-multi-select-mode');
    }

    // Update selection count in indicator
    const countElement = multiSelectHost?.querySelector('[data-selection-count="true"]');
    if (countElement) {
      const count = this.selectedConversations.size;
      countElement.textContent = `${count} selected`;
    }

    // Update action buttons based on source
    const actionsContainer = multiSelectHost?.querySelector('[data-multi-select-actions="true"]');
    if (actionsContainer && this.isMultiSelectMode) {
      actionsContainer.innerHTML = ''; // Clear existing buttons

      if (this.multiSelectSource === 'folder') {
        // Delete button for folder multi-select (removes from folder only)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = this.t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteConversations());
        actionsContainer.appendChild(deleteBtn);
      } else if (this.multiSelectSource === 'native') {
        // Delete button for native multi-select (deletes from Gemini)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = this.t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteNativeConversations());
        actionsContainer.appendChild(deleteBtn);
      }

      // Exit button (always present)
      const exitBtn = document.createElement('button');
      exitBtn.className = 'gv-multi-select-action-btn gv-multi-select-exit-btn';
      exitBtn.innerHTML =
        '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
      exitBtn.title = 'Exit multi-select mode';
      exitBtn.addEventListener('click', () => this.exitMultiSelectMode());
      actionsContainer.appendChild(exitBtn);
    } else if (actionsContainer) {
      actionsContainer.innerHTML = ''; // Clear buttons when exiting
    }
  }

  private getSelectedConversationsData(_folderId: string): ConversationReference[] {
    const result: ConversationReference[] = [];
    const seen = new Set<string>();

    // Collect from all folders since selection can span folders
    for (const fId in this.data.folderContents) {
      const conversations = this.data.folderContents[fId];
      conversations.forEach((conv) => {
        if (this.selectedConversations.has(conv.conversationId) && !seen.has(conv.conversationId)) {
          seen.add(conv.conversationId);
          result.push(conv);
        }
      });
    }

    return result;
  }

  private showFolderMenu(event: MouseEvent, folderId: string): void {
    event.stopPropagation();

    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // Create context menu
    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const menuItems: Array<{ label: string; action: () => void }> = [
      {
        label: folder.pinned ? this.t('folder_unpin') : this.t('folder_pin'),
        action: () => this.togglePinFolder(folderId),
      },
    ];

    // "Create subfolder" only appears when the parent isn't already at the
    // floor of the depth cap. Pre-existing deeper data still renders; we just
    // don't offer a UI path to grow it further.
    if (this.getFolderDepth(folderId) < MAX_FOLDER_DEPTH) {
      menuItems.push({
        label: this.t('folder_create_subfolder'),
        action: () => this.createFolder(folderId),
      });
    }

    menuItems.push(
      { label: this.t('folder_rename'), action: () => this.renameFolder(folderId) },
      { label: this.t('folder_change_color'), action: () => this.showColorPicker(folderId, event) },
    );

    // Only show instructions editor when Folder-as-Project is enabled
    if (this.folderProjectEnabled) {
      menuItems.push({
        label: this.t('folder_new_chat_in_folder'),
        action: () => this.createNewChatInFolder(folderId),
      });
      menuItems.push({
        label: folder.instructions
          ? this.t('folderAsProject_editInstructions')
          : this.t('folderAsProject_setInstructions'),
        action: () => this.showInstructionsEditor(folderId),
      });
    }

    menuItems.push({ label: this.t('folder_delete'), action: () => this.deleteFolder(folderId) });

    menuItems.forEach((item) => {
      const menuItem = document.createElement('button');
      menuItem.className = 'gv-folder-menu-item';
      menuItem.textContent = item.label;
      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });
      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // Close menu on click outside
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  private closeFolderConversationMenus(): void {
    document.querySelectorAll('.gv-folder-conversation-menu').forEach((menu) => menu.remove());
  }

  private showFolderConversationMenu(event: MouseEvent, conversation: ConversationReference): void {
    this.closeFolderConversationMenus();

    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu gv-folder-conversation-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const renameItem = document.createElement('button');
    renameItem.className = 'gv-folder-menu-item';
    renameItem.textContent = this.t('folder_rename');
    renameItem.addEventListener('click', () => {
      menu.remove();
      void this.openNativeRenameForFolderConversation(conversation);
    });

    menu.appendChild(renameItem);
    document.body.appendChild(menu);

    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  /**
   * Navigate to a new chat page and pre-select this folder via the
   * Folder-as-Project picker. Stores the folder ID in local storage so the
   * picker can auto-select it after the page loads.
   */
  private createNewChatInFolder(folderId: string): void {
    const navigate = () => {
      const userPrefix = window.location.pathname.match(/^\/u\/\d+/)?.[0] ?? '';
      const targetPath = `${userPrefix}/app`;
      if (
        window.location.pathname === targetPath ||
        window.location.pathname === `${targetPath}/`
      ) {
        // Already on the new-chat page. The Folder-as-Project picker only
        // consumes the pending folder id when it (re)injects, and its URL
        // watcher cannot observe a same-URL pushState, so an SPA "navigation"
        // here would be a silent no-op. A full reload is the only way to
        // re-run picker injection — accepted as the explicit reload exception
        // to the no-full-refresh navigation rule.
        window.location.reload();
        return;
      }
      // Preferred path: SPA route change (History API + popstate), same helper
      // the folder conversation navigation uses. folderProject's URL watcher
      // picks this up, re-injects the picker, and applies the pending folder.
      if (this.navigateWithSpaRoute(`${window.location.origin}${targetPath}`)) {
        return;
      }
      // Last-resort fallback: the History API path failed (pushState threw).
      // A full page load is acceptable here because the alternative is a dead
      // menu item — this mirrors the rule's History-API-then-fallback order.
      window.location.href = `${window.location.origin}${targetPath}`;
    };

    browser.storage.local
      .set({ [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: folderId })
      .then(navigate)
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) return;
        // storage failed — still navigate so the user isn't stranded; they can pick the folder manually
        console.warn('[folder] failed to set pending folder ID', error);
        navigate();
      });
  }

  /**
   * Show color picker dialog for a folder
   * @param folderId The folder ID to change color
   * @param sourceEvent The source mouse event (for positioning)
   */
  private showColorPicker(
    folderId: string,
    sourceEvent: MouseEvent,
    allowToggle: boolean = true,
  ): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // If a color picker is already open, close it first
    if (this.activeColorPicker) {
      const wasSameFolder = this.activeColorPickerFolderId === folderId;
      this.activeColorPicker.remove();
      // Clean up the old event listener to prevent memory leak
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
      // If clicking the same folder icon again and toggle is allowed, just close the picker
      if (allowToggle && wasSameFolder) {
        return;
      }
    }

    // Create color picker dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-color-picker-dialog';

    // Position near the menu click (slightly offset to avoid overlap)
    dialog.style.position = 'fixed';
    dialog.style.left = `${sourceEvent.clientX + 10}px`;
    dialog.style.top = `${sourceEvent.clientY}px`;
    dialog.style.zIndex = '10001';

    // Create color options
    FOLDER_COLORS.forEach((colorConfig) => {
      const colorBtn = document.createElement('button');
      colorBtn.className = 'gv-color-picker-item';
      colorBtn.title = this.t(colorConfig.nameKey);

      // Apply color based on current theme
      const colorValue = getFolderColor(colorConfig.id, isDarkMode());
      colorBtn.style.backgroundColor = colorValue;

      // Mark current color as selected
      if (folder.color === colorConfig.id || (!folder.color && colorConfig.id === 'default')) {
        colorBtn.classList.add('selected');
      }

      colorBtn.addEventListener('click', () => {
        this.changeFolderColor(folderId, colorConfig.id);
        dialog.remove();
        if (this.activeColorPickerCloseHandler) {
          document.removeEventListener('click', this.activeColorPickerCloseHandler);
          this.activeColorPickerCloseHandler = null;
        }
        this.activeColorPicker = null;
        this.activeColorPickerFolderId = null;
      });

      dialog.appendChild(colorBtn);
    });

    // Add Custom Color Picker Button
    const customBtn = document.createElement('button');
    customBtn.className = 'gv-color-picker-item gv-color-picker-custom';
    customBtn.title = this.t('folder_color_custom');

    // Create hidden color input
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    // Style to be invisible but functional
    Object.assign(colorInput.style, {
      position: 'absolute',
      opacity: '0',
      width: '100%',
      height: '100%',
      top: '0',
      left: '0',
      cursor: 'pointer',
    });

    // Set initial state
    if (folder.color && folder.color.startsWith('#')) {
      colorInput.value = folder.color;
      customBtn.classList.add('selected');
      customBtn.style.background = folder.color;
    } else {
      // Rainbow gradient to indicate color picker
      customBtn.style.background =
        'conic-gradient(from 180deg at 50% 50%, #D9231E 0deg, #F06800 66.47deg, #E6A300 125.68deg, #2D9CDB 195.91deg, #9B51E0 262.24deg, #D9231E 360deg)';
    }

    // Handle color change
    colorInput.addEventListener('change', (e) => {
      const hex = (e.target as HTMLInputElement).value;
      this.changeFolderColor(folderId, hex);
      dialog.remove(); // Close picker dialog
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
    });

    // Prevent button click from closing the dialog immediately (if bubbling)
    customBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Trigger the input (if not clicked directly via the overlay input)
      // Since input covers the button, this might not be strictly needed, but good for safety
      if (e.target === customBtn) {
        colorInput.click();
      }
    });

    customBtn.appendChild(colorInput);
    dialog.appendChild(customBtn);

    document.body.appendChild(dialog);
    this.activeColorPicker = dialog;
    this.activeColorPickerFolderId = folderId;

    // Close dialog on click outside
    const closeDialog = (e: MouseEvent) => {
      if (!dialog.contains(e.target as Node)) {
        dialog.remove();
        this.activeColorPicker = null;
        this.activeColorPickerFolderId = null;
        if (this.activeColorPickerCloseHandler) {
          document.removeEventListener('click', this.activeColorPickerCloseHandler);
          this.activeColorPickerCloseHandler = null;
        }
      }
    };
    this.activeColorPickerCloseHandler = closeDialog;
    setTimeout(() => document.addEventListener('click', closeDialog), 0);
  }

  /**
   * Change folder color
   * @param folderId The folder ID to change
   * @param colorId The new color ID
   */
  private changeFolderColor(folderId: string, colorId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.color = colorId;
    folder.updatedAt = Date.now();

    this.saveData();
    this.refresh();
  }

  private showMoveToFolderDialog(
    conversationId: string,
    conversationTitle: string,
    url: string,
    isGem?: boolean,
    gemId?: string,
  ): void {
    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.className = 'gv-folder-dialog-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-dialog';

    // Dialog title
    const dialogTitle = document.createElement('div');
    dialogTitle.className = 'gv-folder-dialog-title';
    dialogTitle.textContent = this.t('conversation_move_to_folder_title');

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'gv-folder-dialog-search';
    searchInput.placeholder = this.t('timelinePreviewSearch');
    searchInput.setAttribute('aria-label', this.t('timelinePreviewSearch'));

    // Folder list
    const folderList = document.createElement('div');
    folderList.className = 'gv-folder-dialog-list';

    const emptyState = document.createElement('div');
    emptyState.className = 'gv-folder-dialog-empty';
    emptyState.textContent = this.t('timelinePreviewNoResults');

    const folderOptions: FolderDialogOption[] = [];

    const collectFolderOptions = (
      parentId: string | null,
      level: number = 0,
      parentPath: string = '',
    ) => {
      const folders = this.data.folders.filter((f) => f.parentId === parentId);
      const sortedFolders = this.sortFolders(folders); // Apply same sorting as sidebar
      sortedFolders.forEach((folder) => {
        const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
        folderOptions.push({ folder, level, path });
        collectFolderOptions(folder.id, level + 1, path);
      });
    };

    const renderFolderOptions = (query: string = '') => {
      folderList.innerHTML = '';
      const normalizedQuery = normalizeFolderDialogSearchText(query);
      const visibleOptions = normalizedQuery
        ? folderOptions.filter((option) =>
            normalizeFolderDialogSearchText(option.path).includes(normalizedQuery),
          )
        : folderOptions;

      visibleOptions.forEach(({ folder, level, path }) => {
        const folderItem = document.createElement('button');
        folderItem.className = 'gv-folder-dialog-item';
        folderItem.style.paddingLeft = `${calculateFolderDialogPaddingLeft(level)}px`;
        folderItem.dataset.folderId = folder.id;
        folderItem.dataset.folderPath = path;
        folderItem.setAttribute('aria-label', path);

        // Folder icon
        const icon = document.createElement('mat-icon');
        icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'folder';

        // Folder name
        const name = document.createElement('span');
        name.className = 'gv-folder-dialog-item-text';
        name.textContent = folder.name;

        const pathLabel = document.createElement('span');
        pathLabel.className = 'gv-folder-dialog-item-path';
        pathLabel.textContent = `/${normalizeFolderDialogSearchText(path)}`;

        folderItem.appendChild(icon);
        folderItem.appendChild(name);
        folderItem.appendChild(pathLabel);

        folderItem.addEventListener('click', () => {
          this.addConversationToFolderFromNative(
            folder.id,
            conversationId,
            conversationTitle,
            url,
            isGem,
            gemId,
          );
          overlay.remove();
        });

        folderList.appendChild(folderItem);
      });

      if (visibleOptions.length === 0) {
        folderList.appendChild(emptyState);
      }
    };

    collectFolderOptions(null);
    renderFolderOptions();

    searchInput.addEventListener('input', () => {
      renderFolderOptions(searchInput.value);
    });

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-dialog-cancel';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());

    // Assemble dialog
    dialog.appendChild(dialogTitle);
    dialog.appendChild(searchInput);
    dialog.appendChild(folderList);
    dialog.appendChild(cancelBtn);
    overlay.appendChild(dialog);

    // Add to body
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });
  }

  private moveConversationToFolder(
    sourceFolderId: string,
    targetFolderId: string,
    conv: ConversationReference,
  ): void {
    // Remove from source folder
    if (this.data.folderContents[sourceFolderId]) {
      this.data.folderContents[sourceFolderId] = this.data.folderContents[sourceFolderId].filter(
        (c) => c.conversationId !== conv.conversationId,
      );
    }

    // Add to target folder
    if (!this.data.folderContents[targetFolderId]) {
      this.data.folderContents[targetFolderId] = [];
    }

    // Check if conversation already exists in target folder
    const existingIndex = this.data.folderContents[targetFolderId].findIndex(
      (c) => c.conversationId === conv.conversationId,
    );

    if (existingIndex === -1) {
      // Add with updated timestamp
      this.data.folderContents[targetFolderId].push({
        ...conv,
        addedAt: Date.now(),
      });
    }

    this.saveData();
    this.refresh();
  }

  public addConversationToFolderFromNative(
    folderId: string,
    conversationId: string,
    title: string,
    url: string,
    isGem?: boolean,
    gemId?: string,
  ): void {
    // Guard: ensure the target folder still exists (it may have been deleted
    // from the sidebar or another tab between selection and message send)
    const folderExists = this.data.folders.some((f) => f.id === folderId);
    if (!folderExists) return;

    // Add to folder
    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    // Check if conversation already exists in folder
    const existingIndex = this.data.folderContents[folderId].findIndex(
      (c) => c.conversationId === conversationId,
    );

    let addedNewConversation = false;
    if (existingIndex === -1) {
      // Insert at the top by claiming sortIndex 0 and shifting existing entries
      // up by one. Time-based fallback alone is not enough — ensureDataIntegrity
      // (called from saveData) will assign sortIndex 0 to the newest entry by
      // time and collide with any pre-existing sortIndex 0, after which JS's
      // stable sort drops the new entry below the old one.
      //
      // Run ensureDataIntegrity first so any nullish sortIndex on existing
      // entries gets a numeric value before the shift. Otherwise (sortIndex ?? 0)
      // would map both null entries and the existing 0 entry to 1.
      this.ensureDataIntegrity();
      const now = Date.now();
      for (const c of this.data.folderContents[folderId]) {
        c.sortIndex = (c.sortIndex ?? 0) + 1;
      }
      this.data.folderContents[folderId].push({
        conversationId,
        title,
        url,
        addedAt: now,
        lastOpenedAt: now,
        isGem,
        gemId,
        sortIndex: 0,
      });
      addedNewConversation = true;
    }

    this.saveData();
    this.refresh();
    if (addedNewConversation) {
      this.maybeShowHideArchivedNudge();
    }
  }

  /**
   * Returns the current folder list (read-only snapshot for external callers).
   */
  public getFolders(): readonly Folder[] {
    return this.data.folders;
  }

  /**
   * Ensures folder data is loaded. Re-reads from storage if the folder list
   * is empty, which can happen after extension context invalidation or async
   * storage listener resets.
   */
  public async ensureDataLoaded(): Promise<void> {
    if (this.data.folders.length === 0) {
      await this.loadData();
    }
  }

  /**
   * Open a modal that lets the user write or edit text instructions for a
   * folder. Instructions are saved to `folder.instructions` and persisted
   * via `saveData()`.
   *
   * @param folderId - The folder to edit instructions for
   */
  private showInstructionsEditor(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const MAX_CHARS = 10000;

    // ── Overlay ───────────────────────────────────────────────────────────

    const overlay = document.createElement('div');
    overlay.className = 'gv-fi-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'gv-fi-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'gv-fi-dialog-title');

    // ── Title ─────────────────────────────────────────────────────────────

    const titleEl = document.createElement('h2');
    titleEl.className = 'gv-fi-title';
    titleEl.id = 'gv-fi-dialog-title';
    titleEl.textContent = folder.instructions
      ? this.t('folderAsProject_editInstructions')
      : this.t('folderAsProject_setInstructions');

    // ── Instructions textarea ─────────────────────────────────────────────

    const textarea = document.createElement('textarea');
    textarea.className = 'gv-fi-textarea';
    textarea.maxLength = MAX_CHARS;
    textarea.rows = 7;
    textarea.placeholder = this.t('folderAsProject_setInstructions');
    textarea.value = folder.instructions ?? '';

    const charCount = document.createElement('div');
    charCount.className = 'gv-fi-char-count';
    charCount.textContent = `${textarea.value.length} / ${MAX_CHARS}`;
    textarea.addEventListener('input', () => {
      charCount.textContent = `${textarea.value.length} / ${MAX_CHARS}`;
    });

    // ── Actions ──────────────────────────────────────────────────────────

    const actions = document.createElement('div');
    actions.className = 'gv-fi-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-fi-btn gv-fi-btn-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-fi-btn gv-fi-btn-save';
    saveBtn.type = 'button';
    saveBtn.textContent = this.t('pm_save');
    saveBtn.addEventListener('click', async () => {
      const trimmed = textarea.value.trim();
      folder.instructions = trimmed || undefined;
      folder.updatedAt = Date.now();
      await this.saveData();
      overlay.remove();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    // ── Assembly ──────────────────────────────────────────────────────────

    dialog.appendChild(titleEl);
    dialog.appendChild(textarea);
    dialog.appendChild(charCount);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
    });

    setTimeout(() => textarea.focus(), 50);
  }

  // Detect a freshly-opened conversation ⋮ menu and inject our "Move to folder"
  // item. Google's "lr26" UI overhaul replaced the old `.mat-mdc-menu-panel`
  // (rendered into `.cdk-overlay-container`) with a `<gem-menu>` element and
  // re-creates the overlay container, which silently broke the previous
  // observer. This mirrors the proven, robust export-button observer: it
  // watches `document.body`, matches both panel variants, and retries while
  // the menu items stream in asynchronously.
  private setupNativeConversationMenuObserver(): void {
    if (this.nativeMenuObserver) {
      this.nativeMenuObserver.disconnect();
      this.nativeMenuObserver = null;
    }

    const observer = new MutationObserver((mutations) => {
      if (this.isDestroyed) return;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          // Cheap gate before the matches/querySelectorAll/closest triple:
          // menu panels only ever live inside a CDK overlay (or are a
          // <gem-menu> themselves), while the overwhelming majority of body
          // mutations are sidebar/chat re-renders that can't contain one.
          // Missed edge cases are covered by the click-tracking fallback in
          // setupConversationClickTracking.
          const className = typeof node.className === 'string' ? node.className : '';
          const mayHostMenuPanel =
            node.tagName === 'GEM-MENU' ||
            className.includes('mat-mdc-menu-panel') ||
            className.includes('cdk-overlay') ||
            node.parentElement?.closest('.cdk-overlay-container') != null;
          if (!mayHostMenuPanel) return;
          const panels = new Set<HTMLElement>();
          if (node.matches(CONVERSATION_MENU_PANEL_SELECTOR)) panels.add(node);
          node
            .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
            .forEach((panel) => panels.add(panel));
          const closest = node.closest(CONVERSATION_MENU_PANEL_SELECTOR) as HTMLElement | null;
          if (closest) panels.add(closest);
          panels.forEach((panel) =>
            window.setTimeout(() => this.tryInjectMoveToFolderOnPanel(panel), 30),
          );
        });

        // When a conversation menu we injected into closes, mat-menu restores
        // focus to the ⋮ trigger, which keeps the row visually selected via
        // :focus-within. Drop that focus on pointer-driven dismissals so the
        // row reverts. See releaseTriggerFocusAfterPointerClose for guards.
        mutation.removedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const wasInjectedConversationMenu =
            (node.matches?.(CONVERSATION_MENU_PANEL_SELECTOR) &&
              node.querySelector('.gv-move-to-folder-btn')) ||
            node.querySelector?.(`${CONVERSATION_MENU_PANEL_SELECTOR} .gv-move-to-folder-btn`) ||
            (node.querySelector?.(CONVERSATION_MENU_PANEL_SELECTOR) &&
              node.querySelector('.gv-move-to-folder-btn'));
          if (wasInjectedConversationMenu) {
            this.releaseTriggerFocusAfterPointerClose();
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    this.nativeMenuObserver = observer;

    // Catch any menu already open at setup time.
    document
      .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
      .forEach((panel) => window.setTimeout(() => this.tryInjectMoveToFolderOnPanel(panel), 30));
  }

  // Inject the "Move to folder" item into a native conversation menu panel,
  // retrying while the menu content renders. Conversation info is resolved
  // lazily on click (from the menu trigger or the open page) so a transient
  // extraction miss never prevents the item from appearing.
  private tryInjectMoveToFolderOnPanel(
    panel: HTMLElement,
    retriesLeft: number = MOVE_MENU_INJECTION_RETRY_LIMIT,
  ): void {
    if (this.isDestroyed || !panel.isConnected) return;

    const context = getConversationMenuContext(panel);
    if (!context) return; // not a conversation menu (e.g. model picker / response menu)

    const label = this.t('conversation_move_to_folder');
    const injected = injectConversationMenuMoveToFolderButton(panel, {
      label,
      tooltip: label,
      onClick: () => {
        const info = this.resolveConversationInfoForMenu(context);
        if (info) {
          this.showMoveToFolderDialog(info.id, info.title, info.url);
        } else {
          this.debugWarn('Move to folder: could not resolve conversation info on click');
        }
      },
    });

    if (!injected && retriesLeft > 0) {
      window.setTimeout(
        () => this.tryInjectMoveToFolderOnPanel(panel, retriesLeft - 1),
        MOVE_MENU_INJECTION_RETRY_DELAY_MS,
      );
    }
  }

  // Resolve the conversation a menu belongs to. Sidebar menus map back to their
  // list item via the trigger; the top-bar ⋮ menu maps to the open page.
  private resolveConversationInfoForMenu(
    context: ConversationMenuContext,
  ): { id: string; title: string; url: string } | null {
    const trigger = context.trigger;
    if (trigger) {
      const conversationEl = this.findConversationElementForTrigger(trigger);
      if (conversationEl) {
        const id = this.extractNativeConversationId(conversationEl);
        if (id) {
          const url =
            this.extractNativeConversationUrl(conversationEl) ||
            this.buildConversationUrlFromId(id);
          const title =
            this.extractNativeConversationTitle(conversationEl) ||
            this.extractFallbackTitle(conversationEl) ||
            'Untitled';
          if (url) {
            this.debug('resolveConversationInfoForMenu(sidebar):', { id, title, url });
            return { id, title, url };
          }
        }
      }
    }

    // Top-bar menu (or sidebar resolution miss): derive from the current page.
    const pageInfo = this.extractConversationInfoFromPage();
    if (pageInfo) {
      this.debug('resolveConversationInfoForMenu(page):', pageInfo);
      return pageInfo;
    }
    return null;
  }

  // Map a ⋮ trigger button to its conversation list item. Handles the current
  // UI (trigger nested inside `[data-test-id="conversation"]`) and the older
  // sibling layout (`.conversation-actions-container` next to the item).
  private findConversationElementForTrigger(trigger: HTMLElement): HTMLElement | null {
    const direct = trigger.closest('[data-test-id="conversation"]') as HTMLElement | null;
    if (direct) return direct;

    const actionsContainer = trigger.closest('.conversation-actions-container');
    if (actionsContainer) {
      let sibling = actionsContainer.previousElementSibling;
      while (sibling) {
        if (sibling.getAttribute('data-test-id') === 'conversation') {
          return sibling as HTMLElement;
        }
        sibling = sibling.previousElementSibling;
      }
    }

    const historyItem = trigger.closest('[data-test-id^="history-item"]') as HTMLElement | null;
    if (historyItem) return historyItem;

    return null;
  }

  // Belt-and-suspenders alongside nativeMenuObserver: when a conversation ⋮
  // trigger is clicked, resolve the panel it controls (via aria-controls/owns)
  // and retry injection while the menu renders. This covers cases where the
  // panel is re-used / re-rendered without a fresh childList mutation.
  private setupConversationClickTracking(): void {
    if (this.moveMenuTriggerHandler) return; // already wired (idempotent across reinit)

    const handler = (event: Event) => {
      if (this.isDestroyed) return;
      // Any pointerdown/click marks the modality; used to decide whether to drop
      // trigger focus on menu close (pointer) vs preserve it (keyboard a11y).
      this.lastInputModality = 'pointer';
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (event.type === 'click' && this.isNativeDeleteConfirmationTarget(target)) {
        const conversationId = this.nativeDeleteCandidateId;
        if (conversationId) {
          this.clearNativeDeleteCandidate();
          this.scheduleConversationRemovalCheck(conversationId);
        }
        return;
      }

      if (event.type === 'click' && this.isNativeDeleteMenuAction(target)) {
        const conversationId = this.activeNativeMenuConversationId;
        if (conversationId) {
          this.rememberNativeDeleteCandidate(conversationId);
        }
        return;
      }

      const trigger = target.closest(CONVERSATION_MENU_TRIGGER_SELECTOR) as HTMLElement | null;
      if (!trigger) return;

      this.clearNativeDeleteCandidate();
      const conversationEl = this.findConversationElementForTrigger(trigger);
      const rawConversationId =
        (conversationEl && this.extractNativeConversationId(conversationEl)) ||
        this.extractConversationInfoFromPage()?.id ||
        null;
      this.activeNativeMenuConversationId = this.normalizeConversationId(rawConversationId);

      const panelIds = this.parseMenuTriggerPanelIds(trigger);
      for (let attempt = 0; attempt <= MOVE_MENU_INJECTION_RETRY_LIMIT; attempt++) {
        window.setTimeout(() => {
          if (this.isDestroyed) return;
          if (panelIds.length > 0) {
            panelIds.forEach((id) => {
              const panel = document.getElementById(id);
              if (panel instanceof HTMLElement && panel.matches(CONVERSATION_MENU_PANEL_SELECTOR)) {
                this.tryInjectMoveToFolderOnPanel(panel);
              }
            });
          } else {
            document
              .querySelectorAll<HTMLElement>(CONVERSATION_MENU_PANEL_SELECTOR)
              .forEach((panel) => this.tryInjectMoveToFolderOnPanel(panel));
          }
        }, attempt * MOVE_MENU_INJECTION_RETRY_DELAY_MS);
      }
    };

    document.addEventListener('click', handler, true);
    document.addEventListener('pointerdown', handler, true);
    this.moveMenuTriggerHandler = handler;

    const keyHandler = () => {
      if (!this.isDestroyed) this.lastInputModality = 'keyboard';
    };
    document.addEventListener('keydown', keyHandler, true);
    this.moveMenuKeydownHandler = keyHandler;
  }

  private isNativeDeleteMenuAction(target: HTMLElement): boolean {
    const action = target.closest(
      '[data-test-id="delete-button"], button[role="menuitem"], [role="menuitem"], gem-menu-item',
    ) as HTMLElement | null;
    if (!action || action.closest('[class*="gv-"]')) return false;

    const panel = action.closest(CONVERSATION_MENU_PANEL_SELECTOR) as HTMLElement | null;
    if (!panel || !getConversationMenuContext(panel)) return false;
    if (action.getAttribute('data-test-id') === 'delete-button') return true;

    const icon = action.querySelector('mat-icon, .material-icons');
    const iconName =
      icon?.getAttribute('fonticon') ||
      icon?.getAttribute('data-mat-icon-name') ||
      icon?.textContent?.trim().toLowerCase();
    if (iconName === 'delete' || iconName === 'delete_forever' || iconName === 'delete_outline') {
      return true;
    }

    const text = action.textContent?.trim().toLowerCase() || '';
    return this.getDeleteKeywords().some(
      (keyword) => text === keyword || (text.includes(keyword) && text.length < 20),
    );
  }

  private isNativeDeleteConfirmationTarget(target: HTMLElement): boolean {
    if (!this.nativeDeleteCandidateId) return false;
    const button = target.closest('button, [role="button"]') as HTMLElement | null;
    if (!button) return false;
    const dialog = button.closest('[role="dialog"], .mat-mdc-dialog-container');
    if (!dialog) return false;

    const testId = button.getAttribute('data-test-id')?.toLowerCase() || '';
    if (testId.includes('cancel')) return false;
    if (testId.includes('confirm') || testId.includes('delete')) return true;

    const text = button.textContent?.trim().toLowerCase() || '';
    return this.getDeleteKeywords().some(
      (keyword) => text === keyword || (text.includes(keyword) && text.length < 20),
    );
  }

  private rememberNativeDeleteCandidate(conversationId: string): void {
    const normalized = this.normalizeConversationId(conversationId);
    if (!normalized) return;
    this.clearNativeDeleteCandidate();
    this.nativeDeleteCandidateId = normalized;
    this.nativeDeleteCandidateTimer = window.setTimeout(
      () => this.clearNativeDeleteCandidate(),
      NATIVE_DELETE_CANDIDATE_TIMEOUT_MS,
    );
  }

  private clearNativeDeleteCandidate(): void {
    if (this.nativeDeleteCandidateTimer !== null) {
      window.clearTimeout(this.nativeDeleteCandidateTimer);
      this.nativeDeleteCandidateTimer = null;
    }
    this.nativeDeleteCandidateId = null;
  }

  // After a conversation ⋮ menu we injected into closes, mat-menu restores DOM
  // focus to the trigger (Angular default), leaving the row highlighted via
  // :focus-within. Drop that focus — but ONLY for plain pointer dismissals, so
  // we never disturb keyboard navigation, the rename/delete flows, our
  // move-to-folder dialog, or any confirm dialog that takes focus.
  private releaseTriggerFocusAfterPointerClose(): void {
    if (this.lastInputModality !== 'pointer') return;
    window.setTimeout(() => {
      if (this.isDestroyed) return;
      // Skip if another overlay/dialog grabbed the stage (delete confirm, our
      // move-to-folder dialog, any CDK dialog) — those manage their own focus.
      if (
        document.querySelector(
          '.cdk-overlay-backdrop, .mat-mdc-dialog-container, .gv-folder-dialog-overlay',
        )
      ) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches?.(CONVERSATION_MENU_TRIGGER_SELECTOR)) {
        active.blur();
      }
    }, 0);
  }

  private parseMenuTriggerPanelIds(trigger: HTMLElement): string[] {
    const raw = `${trigger.getAttribute('aria-controls') || ''} ${
      trigger.getAttribute('aria-owns') || ''
    }`;
    return raw
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }

  private teardownMoveMenuTriggerListener(): void {
    if (this.moveMenuTriggerHandler) {
      document.removeEventListener('click', this.moveMenuTriggerHandler, true);
      document.removeEventListener('pointerdown', this.moveMenuTriggerHandler, true);
      this.moveMenuTriggerHandler = null;
    }
    if (this.moveMenuKeydownHandler) {
      document.removeEventListener('keydown', this.moveMenuKeydownHandler, true);
      this.moveMenuKeydownHandler = null;
    }
    this.activeNativeMenuConversationId = null;
    this.clearNativeDeleteCandidate();
  }

  private extractNativeConversationId(conversationEl: HTMLElement): string | null {
    // Support both /app/<hexId> and /gem/<gemId>/<hexId>
    const scope =
      (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;

    // Get all conversation links
    const links = scope.querySelectorAll('a[href*="/app/"], a[href*="/gem/"]');

    if (links.length === 0) {
      this.debugWarn('extractId: no conversation link found under scope');
      // Fallback to jslog parsing on the conversation element tree
      const hex = this.extractHexIdFromJslog(scope);
      if (hex) return hex;
      return null;
    }

    // If there are multiple links, try to find the most specific one
    let link: Element;
    if (links.length > 1) {
      this.debugWarn(
        `extractId: found ${links.length} links, attempting to select the most appropriate one`,
      );

      // Strategy 1: Find the link with the smallest bounding box (most likely the actual conversation item)
      let minArea = Infinity;
      let bestLink = links[0];

      for (const l of Array.from(links)) {
        const rect = l.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > 0 && area < minArea) {
          minArea = area;
          bestLink = l;
        }
      }

      // If all links have the same size, fall back to the first one
      link = minArea < Infinity ? bestLink : links[0];
      this.debug('extractId: selected link with area', minArea);
    } else {
      link = links[0];
    }

    const href = link.getAttribute('href') || '';
    this.debug('extractId: found link href', href);

    // Try /app/<hexId>
    let match = href.match(/\/app\/([^\/?#]+)/);
    if (match && match[1]) {
      this.debug('extractId: extracted from /app/', match[1]);
      return match[1];
    }
    // Try /gem/<gemId>/<hexId>
    match = href.match(/\/gem\/[^/]+\/([^\/?#]+)/);
    if (match && match[1]) {
      this.debug('extractId: extracted from /gem/', match[1]);
      return match[1];
    }
    this.debugWarn('extractId: failed to extract id from href');
    return null;
  }

  private extractNativeConversationTitle(conversationEl: HTMLElement): string | null {
    const scope =
      (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
    // 1) Known title selectors
    const titleEl = scope.querySelector(
      '.title-text, .gds-label-l, .conversation-title-text, [data-test-id="conversation-title"], h3',
    );
    let title = titleEl?.textContent?.trim() || null;
    if (title && !this.isGemLabel(title)) {
      this.debug('extractTitle(selectors):', title);
      return title;
    }

    // 2) Link attributes
    const link = scope.querySelector(
      'a[href*="/app/"], a[href*="/gem/"]',
    ) as HTMLAnchorElement | null;
    const aria = link?.getAttribute('aria-label')?.trim();
    if (aria && !this.isGemLabel(aria)) {
      this.debug('extractTitle(link aria-label):', aria);
      return aria;
    }
    const linkTitle = link?.getAttribute('title')?.trim();
    if (linkTitle && !this.isGemLabel(linkTitle)) {
      this.debug('extractTitle(link title attr):', linkTitle);
      return linkTitle;
    }

    // 3) Parse visible text from link (ignore icons and gem labels)
    const fromLinkText = this.extractTitleFromLinkText(link || undefined);
    if (fromLinkText) {
      this.debug('extractTitle(link text):', fromLinkText);
      return fromLinkText;
    }

    // 4) Fallbacks on common labels
    title = this.extractFallbackTitle(scope);
    if (title && !this.isGemLabel(title)) {
      this.debug('extractTitle(fallback):', title);
      return title;
    }

    this.debug('extractTitle: null');
    return null;
  }

  /**
   * Build a conversationId → native title lookup table with ONE sidebar scan.
   *
   * Mirrors the per-row matching semantics of `syncConversationTitleFromNative`
   * (`jslog.includes(id)` and `link.href.includes(id)`): every `c_<hex>` id a
   * row's jslog mentions and the id extracted from the row's link href are all
   * registered, in both prefixed (`c_<hex>`) and bare (`<hex>`) forms, so
   * callers can look up either id shape. First title-bearing row wins — same
   * as the old first-match-in-DOM-order behavior.
   */
  private buildNativeConversationTitleMap(): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const conversations = document.querySelectorAll('[data-test-id="conversation"]');
      for (const convEl of Array.from(conversations)) {
        const element = convEl as HTMLElement;
        const title = this.extractNativeConversationTitle(element);
        if (!title) continue;

        const register = (rawId: string | null | undefined): void => {
          const hex = this.normalizeConversationId(rawId);
          if (!hex) return;
          if (!map.has(hex)) map.set(hex, title);
          const prefixed = `c_${hex}`;
          if (!map.has(prefixed)) map.set(prefixed, title);
        };

        const jslog = element.getAttribute('jslog');
        if (jslog) {
          for (const match of jslog.matchAll(/c_([a-f0-9]{8,})/gi)) {
            register(match[1]);
          }
        }

        const link = element.querySelector(
          'a[href*="/app/"], a[href*="/gem/"]',
        ) as HTMLAnchorElement | null;
        if (link) {
          register(this.extractConversationIdFromHref(link.href));
        }
      }
    } catch (e) {
      this.debug('Error building native title map:', e);
    }
    return map;
  }

  private lookupNativeConversationTitle(conversationId: string): string | null {
    const map = this.nativeTitleLookup;
    if (!map) return null;

    const direct = map.get(conversationId);
    if (direct) return direct;

    const normalized = this.normalizeConversationId(conversationId);
    if (normalized) {
      const byHex = map.get(normalized);
      if (byHex) return byHex;
    }
    return null;
  }

  private syncConversationTitleFromNative(conversationId: string): string | null {
    try {
      // Try to find the conversation in the native sidebar by its ID
      const conversations = document.querySelectorAll('[data-test-id="conversation"]');
      for (const convEl of Array.from(conversations)) {
        // Check if this conversation matches the ID
        const jslog = convEl.getAttribute('jslog');
        if (jslog && jslog.includes(conversationId)) {
          // Found the matching conversation, extract its current title
          const currentTitle = this.extractNativeConversationTitle(convEl as HTMLElement);
          if (currentTitle) {
            this.debug('Synced title from native:', currentTitle);
            return currentTitle;
          }
        }

        // Also check by href
        const link = convEl.querySelector(
          'a[href*="/app/"], a[href*="/gem/"]',
        ) as HTMLAnchorElement | null;
        if (link && link.href.includes(conversationId)) {
          const currentTitle = this.extractNativeConversationTitle(convEl as HTMLElement);
          if (currentTitle) {
            this.debug('Synced title from native (by href):', currentTitle);
            return currentTitle;
          }
        }
      }
    } catch (e) {
      this.debug('Error syncing title from native:', e);
    }
    return null;
  }

  private applyConversationTitleUpdate(conversationId: string, newTitle: string): boolean {
    const title = newTitle.trim();
    if (!title) return false;

    let updated = false;
    const updatedAt = Date.now();

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      for (const conv of conversations) {
        if (conv.customTitle) continue;
        if (!this.isSameConversation(conversationId, conv)) continue;
        if (conv.title === title) continue;

        conv.title = title;
        conv.updatedAt = updatedAt;
        updated = true;
        this.debug(`Updated title for conversation ${conversationId} in folder ${folderId}`);
      }
    }

    return updated;
  }

  private async syncConversationTitlesFromNative(): Promise<void> {
    if (this.nativeTitleSyncInProgress) return;
    if (!this.hasStoredConversations()) return;

    this.nativeTitleSyncInProgress = true;
    try {
      let updated = false;
      const conversations = this.getNativeConversationElements();

      for (const convEl of Array.from(conversations)) {
        const element = convEl as HTMLElement;
        const conversationId =
          this.extractNativeConversationId(element) ||
          this.extractConversationIdFromElement(element);
        const title = this.extractNativeConversationTitle(element);
        if (!conversationId || !title) continue;

        updated = this.applyConversationTitleUpdate(conversationId, title) || updated;
      }

      if (!updated) return;

      await this.saveData();
      this.renderAllFolders();
    } finally {
      this.nativeTitleSyncInProgress = false;
    }
  }

  private updateConversationTitle(conversationId: string, newTitle: string): void {
    if (!this.applyConversationTitleUpdate(conversationId, newTitle)) return;

    void this.saveData();
    // Re-render folders to show updated title
    this.renderAllFolders();
  }

  /**
   * Schedule a delayed check after an explicit native Delete action. DOM
   * disappearance alone never calls this method because the sidebar virtualizes
   * rows during normal scrolling.
   */
  private scheduleConversationRemovalCheck(conversationId: string): void {
    // Cancel any existing timer for this conversation
    const existingTimer = this.pendingRemovals.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debug(`Cancelled previous removal timer for ${conversationId}`);
    }

    // Schedule a new check after delay
    const timerId = window.setTimeout(() => {
      this.confirmConversationRemoval(conversationId);
    }, this.removalCheckDelay);

    this.pendingRemovals.set(conversationId, timerId);
    this.debug(
      `Scheduled removal check for ${conversationId} (delay: ${this.removalCheckDelay}ms)`,
    );
  }

  /**
   * Check if conversation still exists in DOM
   * Returns true if conversation found, false if definitely deleted
   * In case of errors, conservatively returns true to avoid false deletions
   */
  private isConversationInDOM(conversationId: string): boolean {
    if (!this.sidebarContainer) {
      this.debugWarn('Sidebar container not available for DOM check');
      return true; // Conservative: assume conversation exists if we can't check
    }

    try {
      // Check by jslog attribute
      const byJslog = this.sidebarContainer.querySelector(
        `[data-test-id="conversation"][jslog*="c_${conversationId}"]`,
      );
      if (byJslog) {
        this.debug(`Found conversation ${conversationId} in DOM by jslog`);
        return true;
      }

      // Check by href
      const byHref = this.sidebarContainer.querySelector(
        `[data-test-id="conversation"] a[href*="${conversationId}"]`,
      );
      if (byHref) {
        this.debug(`Found conversation ${conversationId} in DOM by href`);
        return true;
      }

      // Not found in DOM
      this.debug(`Conversation ${conversationId} not found in DOM`);
      return false;
    } catch (error) {
      this.debugWarn(`DOM check failed for ${conversationId}:`, error);
      // Conservative approach: if we can't check, assume it still exists
      // This prevents accidental deletion during DOM reconstruction
      return true;
    }
  }

  /**
   * Get the conversation ID from current URL
   */
  private getCurrentConversationId(): string | null {
    const url = window.location.href;
    const appMatch = url.match(/\/app\/([^\/?#]+)/);
    const gemMatch = url.match(/\/gem\/[^/]+\/([^\/?#]+)/);
    return appMatch?.[1] || gemMatch?.[1] || null;
  }

  /**
   * Confirm an explicit native deletion after the UI has settled. The current
   * URL / visible-row checks keep the folder entry if Gemini rejected or
   * cancelled the operation.
   */
  private confirmConversationRemoval(conversationId: string): void {
    // Remove from pending list
    this.pendingRemovals.delete(conversationId);

    this.debug(`\n═══ Confirming removal for conversation ${conversationId} ═══`);
    this.debug(`  Delay elapsed: ${this.removalCheckDelay}ms`);

    // Check 1: Is this the currently active conversation?
    const currentConvId = this.getCurrentConversationId();
    const currentUrl = window.location.href;

    if (currentConvId === conversationId) {
      this.debug(`  ✓ SKIPPED: Currently active conversation`);
      this.debug(`    Current URL: ${currentUrl}`);
      this.debug(`    Matched ID: ${currentConvId}`);
      this.debug(`════════════════════════════════════════════════\n`);
      return;
    }

    // Check 2: Is conversation still in DOM?
    if (this.isConversationInDOM(conversationId)) {
      this.debug(`  ✓ SKIPPED: Conversation still exists in DOM`);
      this.debug(`    Likely a UI refresh, not a deletion`);
      this.debug(`════════════════════════════════════════════════\n`);
      return;
    }

    // Conversation is truly deleted - remove from folders
    this.debug(`  ✗ CONFIRMED DELETION: Removing from all folders`);
    this.debug(`    Reason: Not in current URL and not found in DOM`);
    this.debug(`    Current URL: ${currentUrl}`);
    this.debug(`════════════════════════════════════════════════\n`);

    this.removeConversationFromAllFolders(conversationId);
  }

  private removeConversationFromAllFolders(conversationId: string): void {
    // Remove this conversation from all folders when the original conversation is deleted
    let removed = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      const initialLength = conversations.length;

      // Filter out the deleted conversation
      this.data.folderContents[folderId] = conversations.filter(
        (conv) => conv.conversationId !== conversationId && !conv.url.includes(conversationId),
      );

      if (this.data.folderContents[folderId].length < initialLength) {
        removed = true;
        this.debug(`Removed deleted conversation ${conversationId} from folder ${folderId}`);
      }
    }

    if (removed) {
      this.saveData();
      // Re-render folders to reflect the removal
      this.renderAllFolders();
    }
  }

  private extractHexIdFromJslog(scope: HTMLElement): string | null {
    try {
      const tryParse = (val: string | null | undefined): string | null => {
        if (!val) return null;
        // Typical pattern inside jslog: c_<hex>
        const m = val.match(/c_([a-f0-9]{8,})/i);
        return m?.[1] || null;
      };

      // Check on scope itself
      const fromSelf = tryParse(scope.getAttribute('jslog'));
      if (fromSelf) {
        this.debug('extractId(jslog self):', fromSelf);
        return fromSelf;
      }

      // Search descendants with jslog
      const nodes = scope.querySelectorAll('[jslog]');
      for (const n of Array.from(nodes)) {
        const found = tryParse(n.getAttribute('jslog'));
        if (found) {
          this.debug('extractId(jslog descendant):', found);
          return found;
        }
      }
    } catch (e) {
      this.debugWarn('extractHexIdFromJslog error:', e);
    }
    this.debugWarn('extractId(jslog): not found');
    return null;
  }

  private buildConversationUrlFromId(hexId: string): string {
    // Mirror extractConversationData's account-scope semantics: preserve the
    // current /u/<index>/ segment for multi-account users so jslog-fallback
    // URLs don't open in the wrong account. Under hard account isolation the
    // /u/<index> segment is intentionally NOT persisted (navigation rebuilds
    // it from the live page context).
    let accountPrefix = '';
    try {
      if (!this.accountIsolationEnabled) {
        const userMatch = window.location.pathname.match(/\/u\/(\d+)\//);
        if (userMatch) {
          accountPrefix = `/u/${userMatch[1]}`;
        }
      }
    } catch (e) {
      this.debug('Failed to extract account prefix:', e);
    }

    try {
      const path = window.location.pathname;
      const gemMatch = path.match(/\/gem\/([^\/]+)/);
      if (gemMatch && gemMatch[1]) {
        const gemId = gemMatch[1];
        return `https://gemini.google.com${accountPrefix}/gem/${gemId}/${hexId}`;
      }
    } catch (e) {
      this.debug('Failed to extract gem URL:', e);
    }
    return `https://gemini.google.com${accountPrefix}/app/${hexId}`;
  }

  private extractFallbackTitle(conversationEl: HTMLElement): string | null {
    try {
      const scope =
        (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
      // Prefer explicit attributes if present
      const aria = scope.getAttribute('aria-label');
      if (aria && aria.trim()) {
        this.debug('fallbackTitle(aria-label):', aria.trim());
        return aria.trim();
      }
      const titleAttr = scope.getAttribute('title');
      if (titleAttr && titleAttr.trim()) {
        this.debug('fallbackTitle(title attr):', titleAttr.trim());
        return titleAttr.trim();
      }
      // Try a common inner label
      const label = scope.querySelector('.gds-body-m, .gds-label-m, .subtitle');
      const labelText = label?.textContent?.trim();
      if (labelText && !this.isGemLabel(labelText)) {
        this.debug('fallbackTitle(label-ish):', labelText);
        return labelText;
      }
      // Fall back to trimmed text content (first line, clipped)
      const raw = scope.textContent?.trim() || '';
      if (raw) {
        const firstLine =
          raw
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0] || raw;
        const clipped = firstLine.slice(0, 80);
        this.debug('fallbackTitle(textContent):', clipped);
        return clipped;
      }
    } catch (e) {
      this.debugWarn('extractFallbackTitle error:', e);
    }
    return null;
  }

  private isGemLabel(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    const simple = t.toLowerCase();
    // Generic labels we want to ignore
    if (simple === 'gem' || simple === 'gems') return true;
    // Known Gem names (English)
    for (const g of GEM_CONFIG) {
      if (simple === g.name.toLowerCase()) return true;
    }
    return false;
  }

  private extractTitleFromLinkText(link?: HTMLAnchorElement | null): string | null {
    if (!link) return null;
    // Get visible textual lines from the link
    const text = (link.innerText || '').trim();
    if (!text) return null;
    const parts = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !this.isGemLabel(s))
      .filter((s) => s.length >= 2);
    this.debug('extractTitleFromLinkText parts:', parts);
    if (parts.length === 0) return null;
    // Heuristic: pick the longest part
    const best = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]);
    return best || null;
  }

  private extractNativeConversationUrl(conversationEl: HTMLElement): string | null {
    const scope =
      (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
    const link = scope.querySelector('a[href*="/app/"], a[href*="/gem/"]');
    if (!link) {
      this.debugWarn('extractUrl: no conversation link found under scope');
      // Fallback: construct from extracted id (via jslog) if possible
      const hex = this.extractHexIdFromJslog(scope);
      if (hex) {
        const fullFromJslog = this.buildConversationUrlFromId(hex);
        this.debug('extractUrl(jslog fallback):', fullFromJslog);
        return fullFromJslog;
      }
      return null;
    }
    const href = link.getAttribute('href');
    if (!href) {
      this.debugWarn('extractUrl: link has no href');
      return null;
    }
    const full = href.startsWith('http') ? href : `https://gemini.google.com${href}`;
    this.debug('extractUrl:', full);
    return full;
  }

  private refresh(): void {
    if (!this.containerElement) return;

    // Clear active folder input reference since the DOM will be replaced
    this.clearActiveFolderInput();

    // Find and update the folders list
    const oldList = this.containerElement.querySelector('.gv-folder-list');
    if (oldList) {
      const newList = this.createFoldersList();
      oldList.replaceWith(newList);
    }

    // Re-apply hide archived setting after refresh
    this.applyHideArchivedSetting();

    // Update active highlight after re-render
    this.highlightActiveConversationInFolders();

    // Flush any pending title updates collected during rendering
    if (this.pendingTitleUpdates.size > 0) {
      this.debug(`Flushing ${this.pendingTitleUpdates.size} pending title updates`);
      // Save once after all title updates are applied (async, fire-and-forget)
      this.saveData()
        .then((saved) => {
          // Only clear after confirmed successful save to avoid losing updates
          if (saved) {
            this.pendingTitleUpdates.clear();
          } else {
            this.debugWarn('Save failed, retaining pending title updates for next attempt');
          }
        })
        .catch((error) => {
          console.error('[FolderManager] Failed to save pending title updates:', error);
        });
    }
  }

  private getCurrentHexIdFromLocation(): string | null {
    try {
      const path = window.location.pathname || '';
      // Match /app/<hex> or /gem/<gemId>/<hex>
      const m = path.match(/\/(?:app|gem\/[^/]+)\/([a-f0-9]+)/i);
      return m ? m[1] : null;
    } catch (e) {
      this.debug('Failed to get current hex ID from location:', e);
      return null;
    }
  }

  private getFolderConversationInstanceKey(folderId: string, conversationId: string): string {
    return `${folderId}:${conversationId}`;
  }

  private highlightActiveConversationInFolders(): void {
    if (!this.containerElement) return;
    const hex = this.getCurrentHexIdFromLocation();
    const currentId = hex ? `c_${hex}` : null;
    const rows = Array.from(
      this.containerElement.querySelectorAll<HTMLElement>('.gv-folder-conversation'),
    );

    rows.forEach((row) => row.classList.remove('gv-folder-conversation-selected'));
    if (!currentId) return;

    const matches = rows.filter((row) => row.dataset.conversationId === currentId);
    const activeRow =
      matches.find(
        (row) =>
          row.dataset.folderId &&
          this.getFolderConversationInstanceKey(row.dataset.folderId, currentId) ===
            this.activeFolderConversationKey,
      ) ?? matches[0];

    activeRow?.classList.add('gv-folder-conversation-selected');
  }

  /**
   * Ensures data integrity by validating and repairing the folder data structure.
   * This method is called by both loadData() and saveData() to maintain consistency.
   */
  private ensureDataIntegrity(): void {
    // Ensure folderContents object exists
    if (!this.data.folderContents) {
      this.data.folderContents = {};
      this.debugWarn('folderContents was missing, initialized');
    }

    // Ensure folders array exists
    if (!this.data.folders) {
      this.data.folders = [];
      this.debugWarn('folders was missing, initialized');
    }

    // Ensure all folders have a folderContents entry (even if empty)
    // This is critical for empty folders to persist correctly
    this.data.folders.forEach((folder) => {
      if (!this.data.folderContents[folder.id]) {
        this.data.folderContents[folder.id] = [];
        this.debugWarn(`Initialized missing folderContents for folder: ${folder.name}`);
      }
    });

    // Deduplicate conversations within each folder
    for (const folderId of Object.keys(this.data.folderContents)) {
      const convs = this.data.folderContents[folderId];
      const seen = new Set<string>();
      const deduped = convs.filter((c) => {
        if (seen.has(c.conversationId)) return false;
        seen.add(c.conversationId);
        return true;
      });
      if (deduped.length < convs.length) {
        this.debugWarn(
          `Removed ${convs.length - deduped.length} duplicate conversations in folder: ${folderId}`,
        );
        this.data.folderContents[folderId] = deduped;
      }
    }

    // Ensure all items have sortIndex for manual ordering
    this.ensureSortIndices();
  }

  /**
   * Assign sortIndex to folders and conversations that don't have one yet.
   * Uses current sort order so existing users see no change on upgrade.
   */
  private ensureSortIndices(): void {
    // Group folders by parent
    const foldersByParent = new Map<string, Folder[]>();
    for (const folder of this.data.folders) {
      const parentKey = folder.parentId ?? '__root__';
      if (!foldersByParent.has(parentKey)) foldersByParent.set(parentKey, []);
      foldersByParent.get(parentKey)!.push(folder);
    }

    // Assign sortIndex to folders missing it, preserving current name-based order
    for (const siblings of foldersByParent.values()) {
      const needsIndex = siblings.some((f) => f.sortIndex == null);
      if (!needsIndex) continue;

      // Sort by current logic (pinned state ignored here — sortIndex is within same pinned group)
      const sorted = [...siblings].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
      sorted.forEach((folder, i) => {
        if (folder.sortIndex == null) folder.sortIndex = i;
      });
    }

    // Assign sortIndex to conversations missing it, preserving current time-based order
    for (const [, conversations] of Object.entries(this.data.folderContents)) {
      const needsIndex = conversations.some((c) => c.sortIndex == null);
      if (!needsIndex) continue;

      const sorted = [...conversations].sort((a, b) => {
        const aTime = a.lastOpenedAt ?? a.addedAt ?? 0;
        const bTime = b.lastOpenedAt ?? b.addedAt ?? 0;
        return bTime - aTime;
      });
      sorted.forEach((conv, i) => {
        const original = conversations.find((c) => c.conversationId === conv.conversationId);
        if (original && original.sortIndex == null) original.sortIndex = i;
      });
    }
  }

  /**
   * Load folder data from storage (async, browser-agnostic)
   * Uses storage adapter for automatic Safari/non-Safari handling
   */
  private async loadData(): Promise<void> {
    try {
      // On Safari, restore recovery backups from the durable mirror before any
      // recoverFromBackup() can run (localStorage may have been ITP-evicted).
      await this.backupService.ensureHydrated();

      let loadedData = await this.storage.loadData(this.activeStorageKey);

      if (!loadedData && this.accountIsolationEnabled && this.activeStorageKey !== STORAGE_KEY) {
        loadedData = await this.migrateLegacyFolderDataToScopedStorage();
      }

      if (loadedData && validateFolderData(loadedData)) {
        this.data = loadedData;

        // Validate and repair data integrity
        this.ensureDataIntegrity();

        // Clean up orphaned folderContents (folders that no longer exist)
        const validFolderIds = new Set(this.data.folders.map((f) => f.id));
        validFolderIds.add(ROOT_CONVERSATIONS_ID); // Keep root conversations
        Object.keys(this.data.folderContents).forEach((folderId) => {
          if (!validFolderIds.has(folderId)) {
            this.debugWarn(`Removing orphaned folderContents for: ${folderId}`);
            delete this.data.folderContents[folderId];
          }
        });

        // Create primary backup on successful load
        this.backupService.createPrimaryBackup(this.data);

        this.debug('Data loaded and validated successfully');
      } else if (loadedData) {
        // Data exists but validation failed - this is a real corruption case
        console.warn(
          '[FolderManager] Storage returned invalid data structure, attempting recovery from backup',
        );
        this.attemptDataRecovery({ reason: 'corrupted', originalData: loadedData });
      } else {
        // No data found - likely a first-time user
        console.log(
          '[FolderManager] No folder data found, initializing empty state (likely first-time user)',
        );
        this.data = { folders: [], folderContents: {} };
        // No notification needed - this is expected for new users
      }
    } catch (error) {
      console.error('[FolderManager] Load data error:', error);

      // CRITICAL: Do NOT clear data on error - this causes data loss!
      // Instead, try to recover from backup or keep existing data
      this.attemptDataRecovery(error);
    }
  }

  private cloneFolderData(data: FolderData): FolderData {
    const folders = data.folders.map((folder) => ({ ...folder }));
    const folderContents = Object.fromEntries(
      Object.entries(data.folderContents || {}).map(([folderId, conversations]) => [
        folderId,
        conversations.map((conversation) => ({ ...conversation })),
      ]),
    );
    return { folders, folderContents };
  }

  private filterLegacyFolderDataByCurrentAccount(data: FolderData): FolderData {
    const routeUserId = this.accountScope?.routeUserId;
    if (!routeUserId) {
      return this.cloneFolderData(data);
    }

    const folderById = new Map(data.folders.map((folder) => [folder.id, folder]));
    const visibleFolderIds = new Set<string>();
    const nextContents: Record<string, ConversationReference[]> = {};

    for (const [folderId, conversations] of Object.entries(data.folderContents || {})) {
      const filtered = conversations.filter((conversation) => {
        const conversationUserId = this.getUserIdFromUrl(conversation.url);
        return conversationUserId === null || conversationUserId === routeUserId;
      });
      if (filtered.length === 0) continue;

      nextContents[folderId] = filtered.map((conversation) => ({ ...conversation }));
      if (folderId !== ROOT_CONVERSATIONS_ID) {
        visibleFolderIds.add(folderId);
      }
    }

    const stack = [...visibleFolderIds];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (!currentId) continue;

      const folder = folderById.get(currentId);
      if (!folder?.parentId) continue;
      if (visibleFolderIds.has(folder.parentId)) continue;
      visibleFolderIds.add(folder.parentId);
      stack.push(folder.parentId);
    }

    const folders = data.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({ ...folder }));

    for (const folder of folders) {
      if (!nextContents[folder.id]) {
        nextContents[folder.id] = [];
      }
    }

    if (!nextContents[ROOT_CONVERSATIONS_ID]) {
      nextContents[ROOT_CONVERSATIONS_ID] = [];
    }

    return {
      folders,
      folderContents: nextContents,
    };
  }

  private async migrateLegacyFolderDataToScopedStorage(): Promise<FolderData | null> {
    try {
      const legacyData = await this.storage.loadData(STORAGE_KEY);
      if (!legacyData || !validateFolderData(legacyData)) {
        return null;
      }

      const migratedData = this.filterLegacyFolderDataByCurrentAccount(legacyData);
      this.armStorageEchoSuppression();
      const saved = await this.storage.saveData(this.activeStorageKey, migratedData);
      if (!saved) {
        console.warn('[FolderManager] Failed to persist scoped migration data');
      }
      this.debug(
        'Migrated legacy folder data to scoped storage:',
        this.activeStorageKey,
        migratedData.folders.length,
      );
      return migratedData;
    } catch (error) {
      console.error('[FolderManager] Failed to migrate legacy folder data:', error);
      return null;
    }
  }

  /**
   * Attempt to recover data when loadData() encounters corrupted data or errors.
   * This method is only called when there's an actual problem (not for first-time users).
   * Priority: localStorage backup (primary/emergency/beforeUnload) > keep existing data > initialize empty
   */
  private attemptDataRecovery(error: unknown): void {
    console.warn('[FolderManager] Attempting data recovery after load failure');

    // Step 1: Try to restore from localStorage backups (primary, emergency, beforeUnload)
    const recovered = this.backupService.recoverFromBackup();
    if (recovered && validateFolderData(recovered)) {
      this.data = recovered;
      this.ensureDataIntegrity();
      console.warn('[FolderManager] Data recovered from localStorage backup');
      this.showNotificationByLevel('Folder data has been recovered from a backup.', 'warning');
      // Save recovered data to persistent storage
      this.saveData();
      return; // Successfully recovered, no need to continue
    }

    // Step 2: If current this.data already has valid structure, keep it
    if (validateFolderData(this.data) && this.data.folders.length > 0) {
      console.warn('[FolderManager] Keeping existing in-memory data after load error');
      this.ensureDataIntegrity();
      return;
    }

    // Step 3: Last resort - initialize empty data and log critical error
    console.error('[FolderManager] CRITICAL: Unable to recover data, initializing empty state');
    console.error('[FolderManager] Original error:', error);
    this.data = { folders: [], folderContents: {} };

    // Show user notification about data loss
    this.showDataLossNotification();
  }

  /**
   * Show notification to user about potential data loss
   */
  private showDataLossNotification(): void {
    this.showNotificationByLevel(
      getTranslationSync('folderManager_dataLossWarning') ||
        'Warning: Failed to load folder data. Please check your browser console for details.',
      'error',
    );
  }

  /**
   * Show a notification to the user with customizable level
   */
  private showNotificationByLevel(
    message: string,
    level: 'info' | 'warning' | 'error' = 'error',
  ): void {
    try {
      // Color based on level
      const colors = {
        info: '#2196F3',
        warning: '#FF9800',
        error: '#f44336',
      };

      // Create a visible notification
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[level]};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        max-width: 400px;
        line-height: 1.4;
      `;
      notification.textContent = message;
      document.body.appendChild(notification);

      // Auto-remove after timeout (longer for errors/warnings)
      const timeout =
        level === 'info' ? 3000 : level === 'warning' ? 7000 : NOTIFICATION_TIMEOUT_MS;
      setTimeout(() => {
        try {
          document.body.removeChild(notification);
        } catch {
          // Ignore - notification may have already been removed
        }
      }, timeout);
    } catch (notificationError) {
      console.error('[FolderManager] Failed to show notification:', notificationError);
    }
  }

  /**
   * Trailing-debounced save for high-frequency pure-UI state changes
   * (expand/collapse, recently-opened marks). Coalesces a burst of calls into
   * one `saveData()` run. Data-shape mutations (create/delete/rename/import/
   * move) must keep calling `saveData()` directly.
   */
  private scheduleSaveData(): void {
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.saveData();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Run a pending debounced save immediately. Called on beforeunload and
   * teardown so a recent UI-state change isn't lost. The localStorage half of
   * `saveData` is synchronous, so the data survives unload; the chrome.storage
   * mirror is best-effort.
   */
  private flushPendingSaveData(): void {
    if (this.saveDebounceTimer === null) return;
    window.clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = null;
    void this.saveData();
  }

  /**
   * Arm suppression of the chrome.storage.onChanged echo produced by our own
   * mirror write. Must be called immediately before every
   * `this.storage.saveData(...)` invocation. See `pendingStorageEchoes`.
   */
  private armStorageEchoSuppression(): void {
    this.pendingStorageEchoes += 1;
    this.lastStorageEchoArmedAt = Date.now();
  }

  /**
   * Consume one armed echo. Returns true when the incoming onChanged event is
   * our own mirror-write echo and should NOT trigger a reload. A stale counter
   * (echo never delivered) expires after STORAGE_ECHO_SUPPRESS_WINDOW_MS so
   * genuine external writes can never be swallowed indefinitely.
   */
  private consumeStorageEchoSuppression(): boolean {
    if (this.pendingStorageEchoes <= 0) return false;
    if (Date.now() - this.lastStorageEchoArmedAt > STORAGE_ECHO_SUPPRESS_WINDOW_MS) {
      this.pendingStorageEchoes = 0;
      return false;
    }
    this.pendingStorageEchoes -= 1;
    return true;
  }

  /**
   * Save folder data to storage (async, browser-agnostic)
   * Uses storage adapter for automatic Safari/non-Safari handling
   */
  private async saveData(): Promise<boolean> {
    // Prevent concurrent saves to avoid race conditions
    if (this.saveInProgress) {
      this.savePending = true;
      this.debug('Save already in progress, queueing one trailing save');
      return false;
    }

    this.saveInProgress = true;
    let success = false;

    try {
      // Validate data integrity before saving
      this.ensureDataIntegrity();

      // CRITICAL: Create emergency backup BEFORE saving (snapshot of previous state)
      this.backupService.createEmergencyBackup(this.data);

      // Additional safety check: warn if saving empty data
      if (this.data.folders.length === 0 && Object.keys(this.data.folderContents).length === 0) {
        // Check if we're about to overwrite non-empty data
        const existingData = await this.storage.loadData(this.activeStorageKey);
        if (
          existingData &&
          (existingData.folders.length > 0 || Object.keys(existingData.folderContents).length > 0)
        ) {
          console.warn(
            '[FolderManager] WARNING: Attempting to save empty data over existing non-empty data',
          );
          console.warn('[FolderManager] This may indicate a bug.');
          // Still proceed, but log it prominently
        }
      }

      // Save via storage adapter (handles both Safari and non-Safari).
      // Each write mirrors into chrome.storage.local and echoes back through
      // storage.onChanged in this same context — arm suppression so the echo
      // doesn't trigger a redundant full reload (see setupStorageListener).
      this.armStorageEchoSuppression();
      success = await this.storage.saveData(this.activeStorageKey, this.data);

      // Retry once if the first attempt fails (for transient errors)
      if (!success) {
        console.warn('[FolderManager] Save failed, retrying once...');
        this.armStorageEchoSuppression();
        success = await this.storage.saveData(this.activeStorageKey, this.data);
      }

      if (success) {
        // Create primary backup AFTER successful save
        this.backupService.createPrimaryBackup(this.data);
        this.debug('Data saved successfully');
        // Centralised floating-panel sync. Any code path that persists folder
        // data (sidebar actions, cloud download, native menu → "Move to
        // folder", etc.) ends up here, so one hook keeps the floating view
        // live without every call site having to remember.
        this.floatingPanelHandle?.update(this.data, this.conversationSortMode);
      } else {
        console.error('[FolderManager] Save failed after retry');
      }
    } catch (error) {
      console.error('[FolderManager] Save data error:', error);
      success = false;
    } finally {
      this.saveInProgress = false;
      const shouldRunTrailingSave = this.savePending;
      this.savePending = false;
      if (shouldRunTrailingSave && !this.isDestroyed) {
        void this.saveData();
      }
    }

    return success;
  }

  private async loadFolderEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({ geminiFolderEnabled: true });
      this.folderEnabled = result.geminiFolderEnabled !== false;
      this.debug('Loaded folder enabled setting:', this.folderEnabled);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder enabled setting:', error);
      this.folderEnabled = true;
    }
  }

  /**
   * Opt-in toggle that puts the folder feature into "floating window" mode.
   * When on, the sidebar-injection path is skipped entirely and folders live
   * in a body-level floating panel/FAB instead. Off by default — users opt in
   * from the popup's Folder options.
   */
  private async loadFloatingModeSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
        [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: true,
      });
      this.floatingModeEnabled = result[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] === true;
      this.floatingOpenOnStart = result[StorageKeys.FOLDER_FLOATING_OPEN_ON_START] !== false;
      this.debug('Loaded floating-mode setting:', {
        enabled: this.floatingModeEnabled,
        openOnStart: this.floatingOpenOnStart,
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      console.error('[FolderManager] Failed to load floating-mode setting:', error);
      this.floatingModeEnabled = false;
      this.floatingOpenOnStart = true;
    }
  }

  private async loadAccountIsolationSetting(): Promise<void> {
    try {
      this.accountIsolationEnabled = await accountIsolationService.isIsolationEnabled({
        platform: 'gemini',
        pageUrl: window.location.href,
      });
      this.debug('Loaded account isolation setting:', this.accountIsolationEnabled);
    } catch (error) {
      console.error('[FolderManager] Failed to load account isolation setting:', error);
      this.accountIsolationEnabled = false;
    }
  }

  private async refreshAccountScope(): Promise<void> {
    if (!this.accountIsolationEnabled) {
      this.accountScope = null;
      this.activeStorageKey = STORAGE_KEY;
      return;
    }

    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      const resolvedScope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });
      this.accountScope = resolvedScope;
      this.activeStorageKey = buildScopedFolderStorageKey(resolvedScope.accountKey);
      await this.storage.init(this.activeStorageKey);
    } catch (error) {
      console.error('[FolderManager] Failed to resolve account scope:', error);
      this.accountScope = null;
      this.activeStorageKey = STORAGE_KEY;
    }
  }

  private toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
    if (!scope) return undefined;
    return {
      accountKey: scope.accountKey,
      accountId: scope.accountId,
      routeUserId: scope.routeUserId,
    };
  }

  private async resolveTimelineHierarchySyncScope(): Promise<SyncAccountScope | undefined> {
    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      if (!context.routeUserId && !context.email) {
        return undefined;
      }

      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      return this.toSyncAccountScope(scope);
    } catch (error) {
      console.warn('[FolderManager] Failed to resolve timeline hierarchy sync scope:', error);
      return undefined;
    }
  }

  private async loadFolderAnchorSetting(): Promise<void> {
    try {
      const result = await browser.storage.local.get({
        [StorageKeys.FOLDERS_ANCHOR]: 'above-recents',
      });
      const raw = result[StorageKeys.FOLDERS_ANCHOR];
      this.folderAnchor = raw === 'above-notebooks' ? 'above-notebooks' : 'above-recents';
      this.debug('Loaded folder anchor preference:', this.folderAnchor);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder anchor preference:', error);
      this.folderAnchor = 'above-recents';
    }
  }

  private async loadFoldersCollapsedSetting(): Promise<void> {
    try {
      const result = await browser.storage.local.get({
        [StorageKeys.FOLDERS_COLLAPSED]: false,
      });
      this.foldersCollapsed = result[StorageKeys.FOLDERS_COLLAPSED] === true;
      this.debug('Loaded folder collapsed preference:', this.foldersCollapsed);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder collapsed preference:', error);
      this.foldersCollapsed = false;
    }
  }

  private applyFoldersCollapsedState(): void {
    const container = this.containerElement;
    if (!container) return;

    container.classList.toggle('gv-folder-collapsed', this.foldersCollapsed);

    const button = container.querySelector<HTMLButtonElement>('.gv-folder-section-toggle');
    if (!button) return;

    const label = this.t(this.foldersCollapsed ? 'pm_expand' : 'pm_collapse');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!this.foldersCollapsed));

    const icon = button.querySelector<HTMLElement>('.google-symbols');
    if (icon) {
      icon.textContent = this.foldersCollapsed ? 'chevron_right' : 'expand_more';
    }
  }

  private async toggleFoldersCollapsed(): Promise<void> {
    this.foldersCollapsed = !this.foldersCollapsed;
    this.applyFoldersCollapsedState();

    try {
      await browser.storage.local.set({ [StorageKeys.FOLDERS_COLLAPSED]: this.foldersCollapsed });
    } catch (error) {
      console.error('[FolderManager] Failed to persist folder collapsed preference:', error);
    }
  }

  /**
   * Flip the folder anchor between 'above-recents' and 'above-notebooks',
   * persist it, and re-anchor the panel immediately. Persistence triggers the
   * storage listener too, but we eagerly call the enforcer here so the user
   * sees the panel jump instantly instead of waiting for the storage echo.
   */
  private async toggleFolderAnchor(): Promise<void> {
    const next: 'above-recents' | 'above-notebooks' =
      this.folderAnchor === 'above-notebooks' ? 'above-recents' : 'above-notebooks';
    this.folderAnchor = next;
    this.refreshNotebooksAnchorButtonState();
    this.enforceFolderAboveRecents();
    try {
      await browser.storage.local.set({ [StorageKeys.FOLDERS_ANCHOR]: next });
    } catch (error) {
      console.error('[FolderManager] Failed to persist folder anchor preference:', error);
    }
  }

  /**
   * Build the small hover-reveal swap toggle that paints over the Notebooks
   * section's top-right corner (taking the slot where the section-hider's eye
   * used to live). Uses an inline SVG — not a `mat-icon` ligature — because
   * Gemini ships its own `Luminous Symbols` font that doesn't include
   * `swap_vert`; the public `Google Symbols` font does, but it's not loaded on
   * gemini.google.com, so the ligature would render as the literal letter "S".
   *
   * Built as `<span role="button">` rather than `<button>` so it can sit
   * inside Gemini's expandable-section without producing a nested button.
   */
  private createNotebooksAnchorButton(): HTMLElement {
    const btn = document.createElement('span');
    btn.className = 'gv-folders-anchor-toggle';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    // Material Symbols `swap_vert` path data. Inline so font availability is
    // a non-issue. viewBox matches the Material Symbols sheet.
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
      <path d="M320-440v-287L217-624l-57-56 200-200 200 200-57 56-103-103v287h-80Zm320 280L440-360l57-56 103 103v-287h80v287l103-103 57 56-200 200Z"/>
    </svg>`;
    btn.addEventListener('click', (e) => {
      // Stop the click from bubbling to the expandable-section's header
      // <button> (which would toggle the section open/closed).
      e.stopPropagation();
      e.preventDefault();
      void this.toggleFolderAnchor();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.stopPropagation();
      e.preventDefault();
      void this.toggleFolderAnchor();
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    return btn;
  }

  /**
   * Make sure exactly one swap toggle is mounted on the *current* Notebooks
   * section. Safe to call on every position-enforcer tick: re-mounts after
   * Gemini replaces the Notebooks element, no-ops once correctly attached.
   */
  private ensureNotebooksAnchorButton(): void {
    if (this.isDestroyed) return;
    if (!this.folderEnabled || this.floatingModeActive) {
      this.cleanupNotebooksAnchorButton();
      return;
    }

    const notebooks = this.findNotebooksSectionCandidate();
    if (!notebooks) {
      // Legacy layout or signed-out — nothing to paint on.
      if (this.notebooksAnchorButton && !this.notebooksAnchorButton.isConnected) {
        this.notebooksAnchorButton = null;
      }
      return;
    }

    const existing = this.notebooksAnchorButton;
    if (existing && existing.parentElement === notebooks) {
      this.refreshNotebooksAnchorButtonState();
      return;
    }

    // Either no button yet, or the prior section element was replaced.
    if (existing && existing.isConnected) existing.remove();
    notebooks.classList.add('gv-folders-anchor-host');
    const btn = this.createNotebooksAnchorButton();
    notebooks.appendChild(btn);
    this.notebooksAnchorButton = btn;
    this.refreshNotebooksAnchorButtonState();
  }

  private cleanupNotebooksAnchorButton(): void {
    if (this.notebooksAnchorButton) {
      this.notebooksAnchorButton.remove();
      this.notebooksAnchorButton = null;
    }
    // Strip the host class from any lingering Notebooks section so we don't
    // leave it `position: relative` after the feature shuts down.
    document
      .querySelectorAll('expandable-section.gv-folders-anchor-host')
      .forEach((el) => el.classList.remove('gv-folders-anchor-host'));
  }

  /**
   * Sync the swap button's tooltip + active-state class with the current
   * anchor preference. Tooltip describes the action a click will take (not
   * the current state) so it stays useful no matter which side folders are on.
   */
  private refreshNotebooksAnchorButtonState(): void {
    const btn = this.notebooksAnchorButton;
    if (!btn) return;
    const showsAboveNotebooks = this.folderAnchor === 'above-notebooks';
    const label = showsAboveNotebooks
      ? this.t('folder_anchor_move_above_recents')
      : this.t('folder_anchor_move_above_notebooks');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('gv-anchor-above-notebooks', showsAboveNotebooks);
  }

  private async loadHideArchivedSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        geminiFolderHideArchivedConversations: false,
      });
      this.hideArchivedConversations = !!result.geminiFolderHideArchivedConversations;
      this.debug('Loaded hide archived setting:', this.hideArchivedConversations);
    } catch (error) {
      console.error('[FolderManager] Failed to load hide archived setting:', error);
      this.hideArchivedConversations = false;
    }
    // If the user has (or ever had) hide-archived turned on, they already know
    // the feature exists. Mark the nudge as shown so we never surface it again
    // even if they later turn the feature off.
    this.markNudgeShownIfUserKnowsFeature();
  }

  private markNudgeShownIfUserKnowsFeature(): void {
    if (!this.hideArchivedConversations) return;
    if (this.hideArchivedNudgeShown) return;
    this.hideArchivedNudgeShown = true;
    browser.storage.sync
      .set({ [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true })
      .catch((error) => {
        console.error(
          '[FolderManager] Failed to persist nudge-shown flag after observing hide-archived=true:',
          error,
        );
      });
  }

  private async loadHideArchivedNudgeShownSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: false,
      });
      this.hideArchivedNudgeShown = !!result[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN];
      this.debug('Loaded hide-archived nudge shown flag:', this.hideArchivedNudgeShown);
    } catch (error) {
      console.error('[FolderManager] Failed to load hide-archived nudge flag:', error);
      this.hideArchivedNudgeShown = false;
    }
  }

  private maybeShowHideArchivedNudge(): void {
    if (
      !shouldShowHideArchivedNudge({
        nudgeShown: this.hideArchivedNudgeShown,
        hideArchivedAlreadyOn: this.hideArchivedConversations,
      })
    ) {
      return;
    }
    if (!this.containerElement || !document.body.contains(this.containerElement)) return;

    mountHideArchivedNudge({
      container: this.containerElement,
      onEnable: () => {
        this.hideArchivedNudgeShown = true;
        browser.storage.sync
          .set({
            [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: true,
            [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true,
          })
          .catch((error) => {
            console.error('[FolderManager] Failed to enable hide-archived from nudge:', error);
          });
      },
      onDismiss: () => {
        this.hideArchivedNudgeShown = true;
        browser.storage.sync
          .set({ [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true })
          .catch((error) => {
            console.error('[FolderManager] Failed to persist nudge-dismissed flag:', error);
          });
      },
    });
  }

  private async loadFilterUserSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: false,
      });
      this.filterCurrentUserOnly = !!result[StorageKeys.GV_FOLDER_FILTER_USER_ONLY];
      this.debug('Loaded filter user setting:', this.filterCurrentUserOnly);
    } catch (error) {
      console.error('[FolderManager] Failed to load filter user setting:', error);
      this.filterCurrentUserOnly = false;
    }
  }

  private async loadFolderSearchEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_SEARCH_ENABLED]: true,
      });
      this.folderSearchEnabled = result[StorageKeys.FOLDER_SEARCH_ENABLED] !== false;
    } catch {
      this.folderSearchEnabled = true;
    }
  }

  private async loadFolderOnlySearchHintState(): Promise<void> {
    this.folderOnlySearchHintSeen = await hasSeenCoachmark(FOLDER_ONLY_SEARCH_HINT_ID);
  }

  private applyFolderSearchEnabledSetting(value: unknown): void {
    const next = value !== false;
    if (next === this.folderSearchEnabled) return;

    this.folderSearchEnabled = next;
    if (!next) this.folderSearchQuery = '';
    if (!this.containerElement) return;

    this.containerElement.querySelector('.gv-folder-search')?.remove();

    if (next) {
      const list = this.containerElement.querySelector('.gv-folder-list');
      this.containerElement.insertBefore(this.createFolderSearch(), list);
    }

    this.refresh();
  }

  private async loadFolderTreeIndentSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_TREE_INDENT]: FOLDER_TREE_INDENT_DEFAULT,
      });
      this.folderTreeIndent = clampFolderTreeIndent(result[StorageKeys.GV_FOLDER_TREE_INDENT]);
      this.debug('Loaded folder tree indent setting:', this.folderTreeIndent);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder tree indent setting:', error);
      this.folderTreeIndent = FOLDER_TREE_INDENT_DEFAULT;
    }
  }

  private async loadFolderProjectEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
      });
      this.folderProjectEnabled = result[StorageKeys.FOLDER_PROJECT_ENABLED] === true;
    } catch {
      this.folderProjectEnabled = false;
    }
  }

  private async loadConversationSortModeSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'manual',
      });
      this.conversationSortMode =
        result[StorageKeys.FOLDER_CONVERSATION_SORT_MODE] === 'recent' ? 'recent' : 'manual';
    } catch (error) {
      console.error('[FolderManager] Failed to load conversation sort mode:', error);
      this.conversationSortMode = 'manual';
    }
  }

  private applyConversationSortMode(value: unknown): void {
    const next: ConversationSortMode = value === 'recent' ? 'recent' : 'manual';
    if (next === this.conversationSortMode) return;

    this.conversationSortMode = next;
    this.clearConversationReorderIndicator();
    this.refresh();
    this.floatingPanelHandle?.update(this.data, next);
  }

  private setConversationSortMode(mode: ConversationSortMode): void {
    this.applyConversationSortMode(mode);
    void browser.storage.sync
      .set({ [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: mode })
      .catch((error) => {
        console.error('[FolderManager] Failed to persist conversation sort mode:', error);
      });
  }

  private applyFolderTreeIndentSetting(value: unknown): void {
    const nextIndent = clampFolderTreeIndent(value);
    if (nextIndent === this.folderTreeIndent) return;

    this.folderTreeIndent = nextIndent;
    this.debug('Folder tree indent changed:', this.folderTreeIndent);

    if (this.folderEnabled && this.containerElement) {
      this.renderAllFolders();
    }
  }

  private async handleAccountIsolationToggle(enabled: boolean): Promise<void> {
    if (enabled === this.accountIsolationEnabled) return;

    this.accountIsolationEnabled = enabled;
    await this.refreshAccountScope();
    await this.loadData();

    if (this.folderEnabled) {
      this.refresh();
    }
  }

  private setupStorageListener(): void {
    // Listen for sync settings changes
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        if (changes.geminiFolderEnabled) {
          this.folderEnabled = changes.geminiFolderEnabled.newValue !== false;
          this.debug('Folder enabled setting changed:', this.folderEnabled);
          // Apply the change to folder visibility
          this.applyFolderEnabledSetting();
        }
        if (changes[StorageKeys.FOLDER_FLOATING_OPEN_ON_START]) {
          this.floatingOpenOnStart =
            changes[StorageKeys.FOLDER_FLOATING_OPEN_ON_START].newValue !== false;
          this.debug('Floating-mode startup panel setting changed:', this.floatingOpenOnStart);
        }
        if (changes[StorageKeys.FOLDER_FLOATING_MODE_ENABLED]) {
          const next = changes[StorageKeys.FOLDER_FLOATING_MODE_ENABLED].newValue === true;
          if (next !== this.floatingModeEnabled) {
            this.floatingModeEnabled = next;
            this.debug('Floating-mode toggle changed:', next);

            if (!this.folderEnabled) {
              // Folder feature itself is off — nothing to swap in or out, just
              // remember the setting for when the user turns folders back on.
            } else if (next) {
              // Switch to floating: drop any sidebar-mode UI and mount the
              // floating panel. `reinitializeFolderUI` would normally tear down
              // the sidebar bits but also re-run sidebar init; we want the
              // teardown without the re-init, so do it inline.
              if (this.containerElement) {
                this.containerElement.remove();
                this.containerElement = null;
              }
              if (this.multiSelectHostElement) {
                this.multiSelectHostElement.remove();
                this.multiSelectHostElement = null;
              }
              if (this.conversationObserver) {
                this.conversationObserver.disconnect();
                this.conversationObserver = null;
              }
              if (this.sideNavObserver) {
                this.sideNavObserver.disconnect();
                this.sideNavObserver = null;
              }
              this.teardownPositionEnforcer();
              this.cleanupNotebooksAnchorButton();
              void this.startFloatingMode();
            } else {
              // Switch to sidebar: tear down floating, then ask the existing
              // re-init pipeline to rebuild the sidebar panel.
              this.stopFloatingMode();
              this.reinitializeFolderUI();
            }
          }
        }
        if (changes.geminiFolderHideArchivedConversations) {
          this.hideArchivedConversations = !!changes.geminiFolderHideArchivedConversations.newValue;
          this.debug('Hide archived setting changed:', this.hideArchivedConversations);
          // Apply the change to all conversations
          this.applyHideArchivedSetting();
          // If user enabled hide-archived from the popup while the nudge is
          // still visible, remove it — the nudge's purpose is already served.
          if (this.hideArchivedConversations && this.containerElement) {
            unmountHideArchivedNudge(this.containerElement);
          }
          // Persist that the user knows this feature, so turning it off later
          // won't cause the nudge to reappear on the next archive.
          this.markNudgeShownIfUserKnowsFeature();
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]) {
          this.hideArchivedNudgeShown =
            !!changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN].newValue;
          if (this.hideArchivedNudgeShown && this.containerElement) {
            unmountHideArchivedNudge(this.containerElement);
          }
        }
        if (changes[StorageKeys.GV_FOLDER_TREE_INDENT]) {
          this.applyFolderTreeIndentSetting(changes[StorageKeys.GV_FOLDER_TREE_INDENT].newValue);
        }
        if (changes[StorageKeys.FOLDER_SEARCH_ENABLED]) {
          this.applyFolderSearchEnabledSetting(changes[StorageKeys.FOLDER_SEARCH_ENABLED].newValue);
        }
        if (changes[StorageKeys.FOLDER_PROJECT_ENABLED]) {
          this.folderProjectEnabled = changes[StorageKeys.FOLDER_PROJECT_ENABLED].newValue === true;
        }
        if (changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE]) {
          this.applyConversationSortMode(
            changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE].newValue,
          );
        }
        if (
          changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] ||
          changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]
        ) {
          void (async () => {
            const nextEnabled = await accountIsolationService.isIsolationEnabled({
              platform: 'gemini',
              pageUrl: window.location.href,
            });
            await this.handleAccountIsolationToggle(nextEnabled);
          })();
        }
        // Listen for language changes and update UI text
        if (changes[StorageKeys.LANGUAGE]) {
          this.debug('Language changed, updating UI text...');
          this.updateHeaderLanguageText();
        }
      }
      // Also listen for language changes from local storage (fallback)
      if (areaName === 'local' && changes[StorageKeys.LANGUAGE]) {
        this.debug('Language changed (local), updating UI text...');
        this.updateHeaderLanguageText();
      }
      // Listen for folder data changes from cloud sync / other tabs. Our own
      // saveData mirror writes echo back here in the same context — skip
      // those (each save arms one suppression token), otherwise every local
      // save triggered a redundant reload + full re-render and a stale
      // snapshot could briefly overwrite this.data mid-interaction.
      if (areaName === 'local' && changes[this.activeStorageKey]) {
        if (this.consumeStorageEchoSuppression()) {
          this.debug('Ignoring self-write storage echo for folder data');
        } else {
          this.debug('Folder data changed in chrome.storage.local, reloading...');
          this.reloadFoldersFromStorage();
        }
      }
      // Folder anchor preference (local-only) — re-anchor the panel without
      // a full reinit. Mirrors `toggleFolderAnchor` for the cross-tab case.
      if (areaName === 'local' && changes[StorageKeys.FOLDERS_ANCHOR]) {
        const raw = changes[StorageKeys.FOLDERS_ANCHOR].newValue;
        const next: 'above-recents' | 'above-notebooks' =
          raw === 'above-notebooks' ? 'above-notebooks' : 'above-recents';
        if (next !== this.folderAnchor) {
          this.folderAnchor = next;
          this.debug('Folder anchor changed via storage event:', next);
          this.refreshNotebooksAnchorButtonState();
          this.enforceFolderAboveRecents();
        }
      }
      if (areaName === 'local' && changes[StorageKeys.FOLDERS_COLLAPSED]) {
        const next = changes[StorageKeys.FOLDERS_COLLAPSED].newValue === true;
        if (next !== this.foldersCollapsed) {
          this.foldersCollapsed = next;
          this.applyFoldersCollapsedState();
        }
      }
    });

    // NOTE: the popup's 'gv.folders.reload' message is handled in
    // setupMessageListener. A second chrome.runtime.onMessage listener here
    // used to double-handle it (double loadData + double render per sync) and
    // its unconditional `return true` left responder-less broadcasts pending
    // forever on the sender side.

    // Perform migration from legacy settings
    this.performMigration();
  }

  /**
   * Reload folder data from chrome.storage.local and refresh UI
   */
  private async reloadFoldersFromStorage(): Promise<void> {
    try {
      await this.loadData();
      this.renderAllFolders();
      this.debug('Folders reloaded from storage');
    } catch (error) {
      console.error('[FolderManager] Failed to reload folders:', error);
    }
  }

  /**
   * Migrate legacy settings
   */
  private async performMigration(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('gvSyncMode');
      // Migration: Auto sync is deprecated, switch to manual
      if (result.gvSyncMode === 'auto') {
        console.log('[FolderManager] Migrating legacy "auto" sync mode to "manual"');
        await chrome.storage.local.set({ gvSyncMode: 'manual' });
      }
    } catch (error) {
      console.error('[FolderManager] Migration failed:', error);
    }
  }

  /**
   * Merge folder data for auto-sync (same logic as popup's mergeFolderData)
   */
  private mergeFolderDataForAutoSync(local: FolderData, cloud: FolderData): FolderData {
    // Merge folders list
    const folderMap = new Map<string, Folder>();

    // Add all local folders first
    local.folders.forEach((folder) => {
      folderMap.set(folder.id, folder);
    });

    // Merge cloud folders
    cloud.folders.forEach((cloudFolder) => {
      const localFolder = folderMap.get(cloudFolder.id);
      if (!localFolder) {
        // New folder from cloud
        folderMap.set(cloudFolder.id, cloudFolder);
      } else {
        // Conflict: compare timestamps
        const cloudTime = cloudFolder.updatedAt || cloudFolder.createdAt || 0;
        const localTime = localFolder.updatedAt || localFolder.createdAt || 0;
        if (cloudTime > localTime) {
          folderMap.set(cloudFolder.id, cloudFolder);
        }
        // If local is newer or equal, keep local
      }
    });

    // Merge folder contents
    const mergedContents: Record<string, ConversationReference[]> = { ...local.folderContents };

    const allFolderIds = new Set([
      ...Object.keys(local.folderContents),
      ...Object.keys(cloud.folderContents),
    ]);

    allFolderIds.forEach((folderId) => {
      const localConvos = local.folderContents[folderId] || [];
      const cloudConvos = cloud.folderContents[folderId] || [];

      const convoMap = new Map<string, ConversationReference>();
      // Add cloud first, then local overwrites (local preferred)
      cloudConvos.forEach((c) => convoMap.set(c.conversationId, c));
      localConvos.forEach((c) => convoMap.set(c.conversationId, c));

      mergedContents[folderId] = Array.from(convoMap.values());
    });

    return {
      folders: Array.from(folderMap.values()),
      folderContents: mergedContents,
    };
  }

  private applyFolderEnabledSetting(): void {
    if (this.folderEnabled) {
      this.debug('Folder feature enabled');

      if (this.floatingModeEnabled) {
        void this.startFloatingMode().catch((error) => {
          console.error('[FolderManager] Failed to initialize floating folder UI:', error);
        });
        return;
      }

      if (!this.containerElement) {
        this.debug('Folder feature enabled, initializing sidebar UI');
        void this.initializeFolderUI().catch((error) => {
          console.error('[FolderManager] Failed to initialize folder UI:', error);
        });
      } else {
        this.containerElement.style.display = '';
      }
    } else {
      this.debug('Folder feature disabled, tearing down mounted runtime');
      this.teardownMountedFolderRuntime();
    }
  }

  private applyHideArchivedSetting(): void {
    const conversations = this.getNativeConversationElements();
    conversations.forEach((conv) => {
      this.applyHideArchivedToConversation(conv as HTMLElement);
    });
  }

  /**
   * Apply hide archived setting to a single conversation element
   */
  private applyHideArchivedToConversation(conv: HTMLElement): void {
    if (!this.hideArchivedConversations) {
      if (
        conv.classList.contains('gv-conversation-archived') ||
        this.getNativeConversationActionsContainer(conv)?.classList.contains(
          ARCHIVED_CONVERSATION_ACTIONS_CLASS,
        )
      ) {
        this.setNativeConversationArchivedState(conv, false);
      }
      return;
    }

    const convId = this.extractConversationId(conv);
    const isArchived = this.isConversationInFolders(convId);

    this.setNativeConversationArchivedState(conv, isArchived);
  }

  private setNativeConversationArchivedState(conv: HTMLElement, isArchived: boolean): void {
    conv.classList.toggle('gv-conversation-archived', isArchived);
    this.getNativeConversationActionsContainer(conv)?.classList.toggle(
      ARCHIVED_CONVERSATION_ACTIONS_CLASS,
      isArchived,
    );
  }

  /**
   * `.conversation-actions-container` only exists in Gemini's legacy sidebar
   * layout (lr26 renders the actions button INSIDE the conversation host).
   * Probing per row turned every sidebar-open burst into an O(N²) scan —
   * issue #753 — so probe the root once and cache the answer briefly.
   */
  private hasLegacyActionsContainer(): boolean {
    const now = performance.now();
    if (this.legacyActionsProbe && now - this.legacyActionsProbe.at < LEGACY_ACTIONS_PROBE_TTL_MS) {
      return this.legacyActionsProbe.present;
    }
    const present =
      this.getNativeConversationRoot().querySelector('.conversation-actions-container') !== null;
    this.legacyActionsProbe = { present, at: now };
    return present;
  }

  private getNativeConversationActionsContainer(conversationEl: HTMLElement): HTMLElement | null {
    // When no legacy actions container exists anywhere under the conversation
    // root, neither the sibling walk nor the parent querySelector below can
    // match — skip both (issue #753).
    if (!this.hasLegacyActionsContainer()) return null;

    const parent = conversationEl.parentElement;
    if (!parent) return null;

    let sibling = conversationEl.nextElementSibling;
    while (sibling) {
      if (
        sibling instanceof HTMLElement &&
        sibling.classList.contains('conversation-actions-container')
      ) {
        return sibling;
      }
      sibling = sibling.nextElementSibling;
    }

    return parent.querySelector<HTMLElement>('.conversation-actions-container');
  }

  private isConversationInFolders(conversationId: string): boolean {
    // Check if conversation exists in any folder
    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      if (
        conversations.some((c) => {
          // Direct ID match
          if (c.conversationId === conversationId) return true;

          // Robustness fallback: check if one ID contains the other (e.g. c_ prefix mismatch)
          // or if URL contains the ID (common if one is hex and other is full ID)
          const cleanId = conversationId.replace(/^c_/, '');
          const cleanStoredId = c.conversationId.replace(/^c_/, '');

          if (cleanId && cleanId === cleanStoredId) return true;

          // Check if URL contains the hex ID
          if (cleanId && cleanId.length > 8 && c.url.includes(cleanId)) return true;

          return false;
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private generateId(): string {
    return `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private navigateToConversationById(folderId: string, conversationId: string): void {
    // Look up the latest conversation data from storage
    const conv = this.data.folderContents[folderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (!conv) {
      console.error('[FolderManager] Conversation not found:', conversationId);
      return;
    }

    this.debug('Navigating to conversation:', {
      title: conv.title,
      url: conv.url,
      isGem: conv.isGem,
      gemId: conv.gemId,
    });

    this.activeFolderConversationKey = this.getFolderConversationInstanceKey(
      folderId,
      conv.conversationId,
    );
    this.navigateToConversation(conv.url, conv);
  }

  private isSameConversation(targetId: string, conversation: ConversationReference): boolean {
    if (conversation.conversationId === targetId) return true;

    const cleanId = targetId.replace(/^c_/, '');
    const cleanStoredId = conversation.conversationId.replace(/^c_/, '');

    if (cleanId && cleanId === cleanStoredId) return true;

    if (cleanId && cleanId.length > 8 && conversation.url.includes(cleanId)) return true;

    return false;
  }

  private markConversationAsRecentlyOpened(conversationId: string): void {
    const now = Date.now();
    let changed = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      conversations.forEach((conversation) => {
        if (!this.isSameConversation(conversationId, conversation)) return;

        // De-duplicate near-simultaneous route/listener updates.
        if (conversation.lastOpenedAt && now - conversation.lastOpenedAt < 1000) return;

        conversation.lastOpenedAt = now;
        conversation.updatedAt = now;
        changed = true;
      });
    }

    if (!changed) return;

    // Keep the visible row stable during navigation; the saved time affects
    // the next natural render. Debounced: rapid navigation shouldn't run the
    // full save pipeline per click.
    this.scheduleSaveData();
  }

  private normalizeConversationId(value: string | null | undefined): string | null {
    const normalized = String(value || '')
      .trim()
      .replace(/^c_/i, '');
    return normalized || null;
  }

  private extractConversationIdFromHref(href: string | null | undefined): string | null {
    if (!href) return null;

    try {
      const parsed = new URL(href, window.location.origin);
      const appMatch = parsed.pathname.match(/\/app\/([^/?#]+)/);
      if (appMatch?.[1]) {
        return this.normalizeConversationId(appMatch[1]);
      }

      const gemMatch = parsed.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
      if (gemMatch?.[1]) {
        return this.normalizeConversationId(gemMatch[1]);
      }
    } catch (error) {
      this.debug('Failed to extract conversation id from href:', error);
    }

    return null;
  }

  /**
   * Extract conversation info from the current page URL and top-bar title.
   * Used exclusively for the top-right conversation header menu (not sidebar).
   *
   * Returns null ONLY when the URL does not contain a valid conversation ID,
   * in which case injection is skipped entirely.
   * Title always has a fallback — never returns null for title.
   */
  private extractConversationInfoFromPage(): { id: string; title: string; url: string } | null {
    // --- Robust URL parsing ---
    let path: string;
    try {
      path = window.location.pathname;
    } catch {
      this.debugWarn('extractConversationInfoFromPage: failed to read location.pathname');
      return null;
    }

    // Support multi-user prefix /u/<n>/, /app/<hexId>, and /gem/<gemId>/<hexId>
    const hexMatch = path.match(/\/(?:app|gem\/[^/?#]+)\/([a-f0-9]{8,})/i);
    if (!hexMatch?.[1]) {
      this.debug('extractConversationInfoFromPage: no valid conversation ID in URL');
      return null;
    }
    const id = hexMatch[1];
    const url = window.location.href;

    // --- Defensive title extraction ---
    // Gemini generates titles asynchronously; the DOM element may not be ready yet.
    // Try multiple selectors, then fallback to document.title, then to a default string.
    const titleSelectors = [
      '.conversation-title-container [data-test-id="conversation-title"]',
      'top-bar-actions [data-test-id="conversation-title"]',
      '.top-bar-actions [data-test-id="conversation-title"]',
      '.conversation-title-container .conversation-title.gds-title-m',
      'top-bar-actions .conversation-title.gds-title-m',
    ];

    // Placeholder strings Gemini shows before the chat is auto-titled.
    // Must cover every locale Gemini supports — the DOM text is localized
    // even though the brand name "Gemini" is not.
    const DISALLOWED_TITLES = new Set([
      '',
      'Gemini',
      'Google Gemini',
      'New chat', // en
      '新对话', // zh-CN
      '新對話', // zh-TW
      '新しいチャット', // ja
      '새 채팅', // ko
      'Nuevo chat', // es
      'Nouveau chat', // fr
      'Novo chat', // pt
      'Новый чат', // ru
      'محادثة جديدة', // ar
    ]);

    let title: string | null = null;
    for (const sel of titleSelectors) {
      try {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && !DISALLOWED_TITLES.has(text)) {
          title = text;
          break;
        }
      } catch {
        // Continue to next selector
      }
    }

    // Fallback 1: document.title (Gemini sets "Title - Gemini" format)
    if (!title) {
      try {
        const docTitle = document.title?.trim();
        if (docTitle) {
          const cleaned = docTitle.replace(/\s*[-–—]\s*Gemini\s*$/i, '').trim();
          if (cleaned && !DISALLOWED_TITLES.has(cleaned)) {
            title = cleaned;
          }
        }
      } catch {
        // Continue to default
      }
    }

    // Fallback 2: safe default — never return empty/null title
    if (!title) {
      title = 'Untitled';
    }

    this.debug('extractConversationInfoFromPage:', { id, title, url });
    return { id, title, url };
  }

  private findNativeConversationLinkById(conversationId: string): HTMLAnchorElement | null {
    const normalizedId = this.normalizeConversationId(conversationId);
    if (!normalizedId) return null;

    const byJslog = document.querySelector(
      `[data-test-id="conversation"][jslog*="c_${normalizedId}"] a[href]`,
    ) as HTMLAnchorElement | null;
    if (byJslog && this.extractConversationIdFromHref(byJslog.href) === normalizedId) {
      return byJslog;
    }

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        '[data-test-id="conversation"] a[href], a[data-test-id="conversation"][href]',
      ),
    );

    for (const link of links) {
      if (this.extractConversationIdFromHref(link.href) === normalizedId) {
        return link;
      }
    }

    return null;
  }

  private triggerNativeConversationClick(target: HTMLElement): void {
    const options = { bubbles: true, cancelable: true };
    target.dispatchEvent(new MouseEvent('pointerdown', options));
    target.dispatchEvent(new MouseEvent('mousedown', options));
    target.dispatchEvent(new MouseEvent('mouseup', options));
    target.dispatchEvent(new MouseEvent('click', options));
  }

  private navigateWithSpaRoute(url: string): boolean {
    try {
      const targetUrl = new URL(url, window.location.origin);
      window.history.pushState({}, '', `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
      const event =
        typeof PopStateEvent === 'function'
          ? new PopStateEvent('popstate', { state: window.history.state })
          : new Event('popstate');
      window.dispatchEvent(event);
      return true;
    } catch (error) {
      this.debug('SPA route navigation failed:', error);
      return false;
    }
  }

  private clearFolderNavigationConfirmation(): void {
    if (this.folderNavigationConfirmTimer === null) return;
    window.clearTimeout(this.folderNavigationConfirmTimer);
    this.folderNavigationConfirmTimer = null;
  }

  private navigateToConversation(url: string, conversation?: ConversationReference): void {
    // A newer folder click supersedes any delayed fallback from an older one.
    this.clearFolderNavigationConfirmation();

    // Use History API to navigate without page reload (SPA-style)
    // This mimics how Gemini's original conversation links work
    try {
      const targetUrl = new URL(url);
      const hexId =
        this.normalizeConversationId(conversation?.conversationId) ||
        this.extractConversationIdFromHref(targetUrl.toString());
      const currentConversationId = this.getCurrentConversationId();

      let effectivePath: string | null = null;
      let effectiveUrl: string | null = null;

      if (this.accountIsolationEnabled && hexId) {
        // In hard isolation mode, build a navigation URL that matches the
        // current account context:
        // - If the current path contains /u/{num}/, reuse that {num}
        // - Otherwise navigate to /app/{hexId} directly
        // This prevents us from reusing stale /u/{num} segments from previously
        // saved URLs when the active account index has changed.
        const currentPath = window.location.pathname;
        const currentUserMatch = currentPath.match(/\/u\/(\d+)\//);
        if (currentUserMatch) {
          effectivePath = `/u/${currentUserMatch[1]}/app/${hexId}`;
        } else {
          effectivePath = `/app/${hexId}`;
        }
        effectiveUrl = `${window.location.origin}${effectivePath}${targetUrl.search}`;
      }

      const navigationUrl = this.accountIsolationEnabled && effectiveUrl ? effectiveUrl : url;
      const finishNavigation = () => {
        this.highlightActiveConversationInFolders();

        // After navigation, sync title and check for gem updates
        setTimeout(() => {
          if (conversation && hexId) {
            const syncedTitle = this.syncConversationTitleFromNative(hexId);
            if (syncedTitle && syncedTitle !== conversation.title) {
              this.updateConversationTitle(hexId, syncedTitle);
              this.debug('Updated conversation title after navigation:', syncedTitle);
            }
          }

          if (conversation && hexId && !conversation.gemId) {
            this.checkAndUpdateGemId(hexId);
          } else if (conversation?.gemId) {
            this.debug('Known gem conversation:', conversation.gemId);
          }
        }, 300);
      };
      const spaNavigate = () => {
        if (hexId) {
          this.markConversationAsRecentlyOpened(hexId);
        }

        if (this.navigateWithSpaRoute(navigationUrl)) {
          finishNavigation();
        }
      };

      if (hexId && currentConversationId === hexId) {
        this.highlightActiveConversationInFolders();
        return;
      }

      const sidebarLink = hexId ? this.findNativeConversationLinkById(hexId) : null;
      if (!sidebarLink) {
        this.debug('Sidebar link not found, falling back to SPA route navigation');
        spaNavigate();
        return;
      }

      this.triggerNativeConversationClick(sidebarLink);
      this.debug('Triggered native sidebar link click');

      this.folderNavigationConfirmTimer = window.setTimeout(() => {
        this.folderNavigationConfirmTimer = null;
        if (!hexId || this.getCurrentConversationId() === hexId) {
          finishNavigation();
          return;
        }

        this.debug('Native sidebar click did not navigate, falling back to SPA route navigation');
        spaNavigate();
      }, FOLDER_NAVIGATION_CONFIRM_DELAY_MS);
    } catch (error) {
      console.error('[FolderManager] Navigation error:', error);
    }
  }

  private checkAndUpdateGemId(hexId: string): void {
    // Wait for navigation to complete and check if URL changed
    setTimeout(() => {
      const currentPath = window.location.pathname;
      this.debug('Checking URL after navigation:', currentPath);

      // If URL changed from /app/ to /gem/, update the stored gemId
      if (currentPath.includes('/gem/')) {
        const gemMatch = currentPath.match(/\/gem\/([^\/]+)/);
        if (gemMatch) {
          const gemId = gemMatch[1];
          this.debug('Detected Gem after navigation:', gemId);

          // Update all instances of this conversation in folders
          let updated = false;

          for (const folderId in this.data.folderContents) {
            const conversations = this.data.folderContents[folderId];
            for (const conv of conversations) {
              // Match by hex ID in URL
              if (conv.url.includes(hexId)) {
                const oldUrl = conv.url;
                conv.isGem = true;
                conv.gemId = gemId;
                // Update URL to use /gem/ instead of /app/
                conv.url = conv.url.replace(/\/app\/([^/?]+)/, `/gem/${gemId}/$1`);
                updated = true;
                this.debug('Updated conversation:', conv.title);
                this.debug('Old URL:', oldUrl);
                this.debug('New URL:', conv.url);
                this.debug('Gem ID:', gemId);
              }
            }
          }

          if (updated) {
            this.saveData();
            // Re-render folders to show correct icon
            this.renderAllFolders();
          }
        }
      }
    }, 500); // Wait 500ms for navigation to complete
  }

  private renderAllFolders(): void {
    if (!this.containerElement) return;

    // Find the existing folders list
    const existingList = this.containerElement.querySelector('.gv-folder-list');
    if (!existingList) return;

    // Create a new folders list
    const newList = this.createFoldersList();

    // Replace the old list with the new one
    existingList.replaceWith(newList);

    this.debug('Re-rendered all folders');

    // Ensure active conversation remains highlighted after full re-render
    this.highlightActiveConversationInFolders();
  }

  private async reloadScopedDataOnAccountRouteChange(): Promise<void> {
    if (!this.accountIsolationEnabled) return;

    const routeUserId = extractRouteUserIdFromPath(window.location.pathname);
    if (routeUserId === this.accountScope?.routeUserId) return;

    const previousStorageKey = this.activeStorageKey;
    await this.refreshAccountScope();
    if (this.activeStorageKey === previousStorageKey) return;

    await this.loadData();
    this.renderAllFolders();
    this.debug('Switched account-scoped folder storage:', this.activeStorageKey);
  }

  private installRouteChangeListener(): void {
    const update = () => {
      if (this.isDestroyed) return;
      setTimeout(() => {
        void this.reloadScopedDataOnAccountRouteChange();
        this.highlightActiveConversationInFolders();
        const currentConversationId = this.getCurrentConversationId();
        if (currentConversationId) {
          this.markConversationAsRecentlyOpened(currentConversationId);
        }
      }, 0);
    };

    const cleanupFns: (() => void)[] = [];

    try {
      window.addEventListener('popstate', update);
      cleanupFns.push(() => window.removeEventListener('popstate', update));
    } catch (e) {
      this.debug('Failed to add popstate listener:', e);
    }

    try {
      const hist = history as History & Record<string, unknown>;
      const originalPushState = hist.pushState;
      const originalReplaceState = hist.replaceState;

      const wrap = (
        method: 'pushState' | 'replaceState',
        original: (...args: unknown[]) => unknown,
      ) => {
        hist[method] = function (...args: unknown[]) {
          const ret = original.apply(this, args);
          try {
            update();
          } catch {
            /* Ignore - update is non-critical */
          }
          return ret;
        };
      };
      wrap('pushState', originalPushState as (...args: unknown[]) => unknown);
      wrap('replaceState', originalReplaceState as (...args: unknown[]) => unknown);

      cleanupFns.push(() => {
        hist.pushState = originalPushState;
        hist.replaceState = originalReplaceState;
      });
    } catch (e) {
      this.debug('Failed to wrap history methods:', e);
    }

    // Shared fallback for routers/flows that don't emit events.
    try {
      this.lastPathname = window.location.pathname;
      cleanupFns.push(
        watchRouteChanges(() => {
          if (this.isDestroyed) return;
          const now = window.location.pathname;
          if (now !== this.lastPathname) {
            this.lastPathname = now;
            update();
          }
        }),
      );
    } catch (e) {
      this.debug('Failed to setup navigation watcher:', e);
    }

    this.routeChangeCleanup = () => {
      cleanupFns.forEach((fn) => fn());
    };
  }

  private installSidebarClickListener(): void {
    // Capture clicks in Gemini's native sidebar and update highlight after navigation happens
    const root = this.sidebarContainer;
    if (!root) return;

    this.sidebarClickListener = (e: Event) => {
      if (this.isDestroyed) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest('a[href*="/app/"], a[href*="/gem/"]') as HTMLAnchorElement | null;
      if (a) {
        setTimeout(() => this.highlightActiveConversationInFolders(), 0);
      }
    };

    try {
      root.addEventListener('click', this.sidebarClickListener, true);
    } catch (e) {
      this.debug('Failed to add sidebar click listener:', e);
    }
  }

  private t(key: string): string {
    // Use the centralized i18n system that respects user's language preference
    return getTranslationSyncUnsafe(key);
  }

  /**
   * Update all translatable text in the folder header when language changes
   */
  private updateHeaderLanguageText(): void {
    if (!this.containerElement) return;

    // Update folder title
    const title = this.containerElement.querySelector('.gv-folder-header .title');
    if (title) {
      title.textContent = this.t('folder_title');
    }
    this.applyFoldersCollapsedState();

    // Update button tooltips in header actions
    const actionsContainer = this.containerElement.querySelector('.gv-folder-header-actions');
    if (actionsContainer) {
      const buttons = actionsContainer.querySelectorAll('button');
      buttons.forEach((btn) => {
        // Identify buttons by their class or icon content
        if (btn.classList.contains('gv-folder-add-btn')) {
          btn.title = this.t('folder_create');
        } else if (btn.classList.contains('gv-folder-action-btn')) {
          // Check icon to identify button type
          const icon = btn.querySelector('mat-icon');
          if (icon?.textContent === 'person') {
            btn.title = this.t('folder_filter_current_user');
          } else if (icon?.textContent === 'folder_managed') {
            btn.title = this.t('folder_import_export');
          } else if (icon?.textContent === 'settings') {
            btn.title = this.t('folder_settings');
          }
          // Cloud buttons use SVG, check for SVG content
          const svg = btn.querySelector('svg');
          if (svg) {
            const path = svg.querySelector('path')?.getAttribute('d') || '';
            // Cloud upload icon contains specific path pattern
            if (path.includes('520q-33 0-56.5-23.5')) {
              btn.title = this.t('folder_cloud_upload');
            } else if (path.includes('520-716v242')) {
              btn.title = this.t('folder_cloud_sync');
            }
          }
        }
      });
    }

    const searchInput =
      this.containerElement.querySelector<HTMLInputElement>('.gv-folder-search-input');
    if (searchInput) {
      const searchContainer = searchInput.closest<HTMLElement>('.gv-folder-search');
      const modeBadge = searchContainer?.querySelector<HTMLElement>('.gv-folder-search-mode-badge');
      if (searchContainer && modeBadge) {
        this.updateFolderSearchInputState(searchContainer, searchInput, modeBadge);
      }
    }

    // Update empty state text if present
    const emptyState = this.containerElement.querySelector('.gv-folder-empty');
    if (emptyState) {
      emptyState.textContent = this.t(
        this.isFolderSearchActive() ? 'folder_search_empty' : 'folder_empty',
      );
    }

    // Notebooks corner swap toggle is mounted on the Notebooks section, not
    // inside our container — refresh its tooltip in the now-current locale.
    this.refreshNotebooksAnchorButtonState();

    this.debug('Header language text updated');
  }

  private setupMessageListener(): void {
    const listener = (
      message: unknown,
      _sender: Runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): true | undefined => {
      const msg = message as Record<string, unknown>;
      // Handle request for current folder data
      if (msg.type === 'gv.sync.requestData') {
        this.debug('Received request for folder data from popup');
        sendResponse({
          ok: true,
          data: this.data,
          accountScope: this.toSyncAccountScope(this.accountScope),
        });
        return true;
      }

      // Handle reload request from the popup after a cloud sync. This is the
      // single handler for this message (a duplicate listener used to live in
      // setupStorageListener and double-processed every sync).
      if (msg.type === 'gv.folders.reload') {
        this.debug('Received reload request');
        this.loadData().then(() => {
          this.refresh();
          try {
            sendResponse({ ok: true });
          } catch {
            /* ignore */
          }
        });
        return true;
      }

      // Handle request to collect all conversations and folder structure for AI organization
      if (msg.type === 'gv.folders.getStructureForAI') {
        this.debug('Received AI structure request');
        this.collectAllSidebarConversations()
          .then((sidebarConversations) => {
            sendResponse({ ok: true, sidebarConversations, folderData: this.data });
          })
          .catch((error) => {
            this.debugWarn('getStructureForAI collection failed:', error);
            sendResponse({ ok: true, sidebarConversations: [], folderData: this.data });
          });
        return true; // respond asynchronously after rows populate
      }

      // Not a message we handle. Returning `true` here would claim "I will
      // respond asynchronously" and never do so, leaving the sender's promise
      // pending forever (e.g. a background broadcast awaiting Promise.all over
      // every tab). Return undefined so the channel closes normally.
      return undefined;
    };
    // The polyfill's OnMessageListener typing cannot express "sync-respond to
    // some messages, ignore the rest" (its callback variant requires a constant
    // `true` return). Runtime behavior is well-defined for both values, so
    // cast: `true` keeps the channel open for handled messages, `undefined`
    // closes it for unknown ones.
    browser.runtime.onMessage.addListener(listener as Runtime.OnMessageListenerCallback);
  }

  /**
   * A conversation row is "populated" once Gemini fills in its link. The lr26
   * sidebar virtualizes rows: `[data-test-id="conversation"]` elements exist as
   * empty stubs (no link, no title) while collapsed or mid-render, and only gain
   * an `<a href>` once actually rendered. We use the link as the populated signal.
   */
  private isPopulatedConversationEl(el: HTMLElement): boolean {
    return !!el.querySelector('a[href*="/app/"], a[href*="/gem/"]');
  }

  /**
   * Collect all conversation titles and URLs from the native sidebar DOM.
   * Waits for the virtualized rows to populate before reading them — otherwise
   * the list comes back empty and the AI-organize prompt has nothing to work
   * with (see #725).
   */
  private async collectAllSidebarConversations(): Promise<
    Array<{ id: string; title: string; url: string }>
  > {
    await this.waitForPopulatedSidebarConversations();
    return this.collectPopulatedConversations();
  }

  /** Synchronous extraction over the currently-populated sidebar rows. */
  private collectPopulatedConversations(): Array<{ id: string; title: string; url: string }> {
    const results: Array<{ id: string; title: string; url: string }> = [];
    const seen = new Set<string>();
    const conversationEls = this.getNativeConversationElements();

    for (const el of Array.from(conversationEls)) {
      const htmlEl = el as HTMLElement;
      if (!this.isPopulatedConversationEl(htmlEl)) continue; // skip virtualized stub
      const id = this.extractNativeConversationId(htmlEl);
      const url = this.extractNativeConversationUrl(htmlEl);
      if (!id || !url) continue;
      if (seen.has(id)) continue; // collapsed rail can emit duplicate rows
      seen.add(id);
      const title = this.extractNativeConversationTitle(htmlEl) || 'Untitled';
      results.push({ id, title, url });
    }

    return results;
  }

  /**
   * Poll until at least one sidebar conversation row is populated, or timeout.
   * Returns true if a populated row was found.
   */
  private async waitForPopulatedSidebarConversations(): Promise<boolean> {
    const hasPopulated = () =>
      Array.from(this.getNativeConversationElements()).some((el) =>
        this.isPopulatedConversationEl(el as HTMLElement),
      );

    if (hasPopulated()) return true;

    const deadline = Date.now() + AI_ORG_COLLECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.delay(AI_ORG_COLLECT_POLL_MS);
      if (this.isDestroyed) return false;
      if (hasPopulated()) return true;
    }
    return false;
  }

  // Tooltip methods
  private createTooltip(): void {
    this.tooltipElement = document.createElement('div');
    this.tooltipElement.className = 'gv-tooltip';
    document.body.appendChild(this.tooltipElement);
  }

  private showTooltip(element: HTMLElement, text: string): void {
    if (!this.tooltipElement) return;

    // Clear any existing timeout
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
    }

    // Check if text is truncated
    const isTruncated = element.scrollWidth > element.clientWidth;
    if (!isTruncated) return;

    // Show tooltip after a short delay (200ms)
    this.tooltipTimeout = window.setTimeout(() => {
      if (!this.tooltipElement) return;

      this.tooltipElement.textContent = text;

      // Position tooltip
      const rect = element.getBoundingClientRect();
      const tooltipRect = this.tooltipElement.getBoundingClientRect();

      let left = rect.left;
      let top = rect.bottom + 8;

      // Adjust if tooltip goes off screen
      if (left + tooltipRect.width > window.innerWidth) {
        left = window.innerWidth - tooltipRect.width - 10;
      }
      if (top + tooltipRect.height > window.innerHeight) {
        top = rect.top - tooltipRect.height - 8;
      }

      this.tooltipElement.style.left = `${left}px`;
      this.tooltipElement.style.top = `${top}px`;

      // Trigger reflow for animation
      this.tooltipElement.offsetHeight;
      this.tooltipElement.classList.add('show');
    }, 200);
  }

  private hideTooltip(): void {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    if (this.tooltipElement) {
      this.tooltipElement.classList.remove('show');
    }
  }

  // Export/Import methods
  private exportFolders(): void {
    // Prevent concurrent exports
    if (this.exportInProgress) {
      this.showNotification(
        this.t('folder_export_in_progress') || 'Export already in progress',
        'info',
      );
      return;
    }

    this.exportInProgress = true;

    try {
      // Type assertion to match the service's expected type
      const payload = FolderImportExportService.exportToPayload(
        this.data as unknown as Parameters<typeof FolderImportExportService.exportToPayload>[0],
      );
      FolderImportExportService.downloadJSON(payload);
      this.showNotification(this.t('folder_export_success'), 'success');
      this.debug('Folders exported successfully');
    } catch (error) {
      console.error('[FolderManager] Export error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      // Always release the lock
      this.exportInProgress = false;
    }
  }

  private showImportDialog(): void {
    if (this.activeImportDialog && !this.activeImportDialog.isConnected) {
      this.activeImportDialog = null;
    }

    // Prevent creating multiple import dialogs simultaneously
    if (this.activeImportDialog) return;

    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.className = 'gv-folder-dialog-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-import-dialog';

    // Dialog title
    const dialogTitle = document.createElement('div');
    dialogTitle.className = 'gv-folder-dialog-title';
    dialogTitle.textContent = this.t('folder_import_title');

    // Strategy selection
    const strategyContainer = document.createElement('div');
    strategyContainer.className = 'gv-folder-import-strategy';

    const strategyLabel = document.createElement('div');
    strategyLabel.className = 'gv-folder-import-strategy-label';
    strategyLabel.textContent = this.t('folder_import_strategy');

    const strategyOptions = document.createElement('div');
    strategyOptions.className = 'gv-folder-import-strategy-options';

    const mergeOption = this.createRadioOption('merge', this.t('folder_import_merge'), true);
    const overwriteOption = this.createRadioOption(
      'overwrite',
      this.t('folder_import_overwrite'),
      false,
    );

    strategyOptions.appendChild(mergeOption);
    strategyOptions.appendChild(overwriteOption);

    strategyContainer.appendChild(strategyLabel);
    strategyContainer.appendChild(strategyOptions);

    // File input
    const fileInputContainer = document.createElement('div');
    fileInputContainer.className = 'gv-folder-import-file-input';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';

    const fileButton = document.createElement('button');
    fileButton.className = 'gv-folder-import-file-button';
    fileButton.textContent = this.t('folder_import_select_file');
    fileButton.addEventListener('click', () => fileInput.click());

    const fileName = document.createElement('div');
    fileName.className = 'gv-folder-import-file-name';
    fileName.textContent = '';

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        fileName.textContent = fileInput.files[0].name;
      }
    });

    fileInputContainer.appendChild(fileInput);
    fileInputContainer.appendChild(fileButton);
    fileInputContainer.appendChild(fileName);

    // Paste JSON section
    const pasteContainer = document.createElement('div');
    pasteContainer.className = 'gv-folder-import-paste-container';

    const pasteToggleBtn = document.createElement('button');
    pasteToggleBtn.className = 'gv-folder-import-paste-toggle';
    pasteToggleBtn.textContent = this.t('folder_import_paste_json');
    let pasteExpanded = false;

    const pasteArea = document.createElement('textarea');
    pasteArea.className = 'gv-folder-import-paste-area';
    pasteArea.placeholder = this.t('folder_import_paste_placeholder');
    pasteArea.style.display = 'none';

    pasteToggleBtn.addEventListener('click', () => {
      pasteExpanded = !pasteExpanded;
      pasteArea.style.display = pasteExpanded ? 'block' : 'none';
      pasteToggleBtn.classList.toggle('gv-folder-import-paste-toggle-active', pasteExpanded);
    });

    pasteContainer.appendChild(pasteToggleBtn);
    pasteContainer.appendChild(pasteArea);

    // Buttons
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'gv-folder-dialog-buttons';

    const importBtn = document.createElement('button');
    importBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-primary';
    importBtn.textContent = this.t('pm_import');
    importBtn.addEventListener('click', async () => {
      const strategy = (mergeOption.querySelector('input') as HTMLInputElement).checked
        ? 'merge'
        : 'overwrite';
      const pasteText = pasteArea.value.trim();
      if (pasteText) {
        await this.handleImportFromText(pasteText, strategy);
      } else {
        await this.handleImport(fileInput, strategy);
      }
      this.closeActiveImportDialog();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-secondary';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => {
      this.closeActiveImportDialog();
    });

    buttonsContainer.appendChild(cancelBtn);
    buttonsContainer.appendChild(importBtn);

    // Assemble dialog
    dialog.appendChild(dialogTitle);
    dialog.appendChild(strategyContainer);
    dialog.appendChild(fileInputContainer);
    dialog.appendChild(pasteContainer);
    dialog.appendChild(buttonsContainer);
    overlay.appendChild(dialog);

    // Add to body
    document.body.appendChild(overlay);

    // Track this dialog as the active one
    this.activeImportDialog = overlay;

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeActiveImportDialog();
      }
    });
  }

  private createRadioOption(value: string, label: string, checked: boolean): HTMLElement {
    const container = document.createElement('label');
    container.className = 'gv-folder-import-radio-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'import-strategy';
    radio.value = value;
    radio.checked = checked;

    const labelText = document.createElement('span');
    labelText.textContent = label;

    container.appendChild(radio);
    container.appendChild(labelText);

    return container;
  }

  private async handleImport(fileInput: HTMLInputElement, strategy: ImportStrategy): Promise<void> {
    // Prevent concurrent imports to avoid data corruption
    if (this.importInProgress) {
      this.showNotification(
        this.t('folder_import_in_progress') || 'Import already in progress',
        'info',
      );
      return;
    }

    this.importInProgress = true;

    try {
      if (!fileInput.files || fileInput.files.length === 0) {
        this.showNotification(this.t('folder_import_select_file'), 'error');
        return;
      }

      const file = fileInput.files[0];

      // Confirm overwrite if strategy is overwrite
      if (strategy === 'overwrite') {
        const confirmed = confirm(this.t('folder_import_confirm_overwrite'));
        if (!confirmed) {
          return;
        }
      }

      // Read and parse file
      const readResult = await FolderImportExportService.readJSONFile(file);
      if (!readResult.success) {
        this.showNotification(this.t('folder_import_invalid_format'), 'error');
        return;
      }

      // Validate payload
      const validationResult = FolderImportExportService.validatePayload(readResult.data);
      if (!validationResult.success) {
        this.showNotification(
          this.t('folder_import_invalid_format') + ': ' + validationResult.error.message,
          'error',
        );
        return;
      }

      // Import data (now async with concurrency protection)
      const importResult = await FolderImportExportService.importFromPayload(
        validationResult.data,
        this.data as unknown as Parameters<typeof FolderImportExportService.importFromPayload>[1],
        { strategy, createBackup: true },
      );

      if (!importResult.success) {
        this.showNotification(
          this.t('folder_import_error').replace('{error}', String(importResult.error)),
          'error',
        );
        return;
      }

      // Update data and save
      this.data = importResult.data.data;
      this.saveData();
      this.refresh();

      // Show success message
      const stats = importResult.data.stats;
      let message = this.t('folder_import_success')
        .replace('{folders}', String(stats.foldersImported))
        .replace('{conversations}', String(stats.conversationsImported));

      if (
        strategy === 'merge' &&
        (stats.duplicatesFoldersSkipped || stats.duplicatesConversationsSkipped)
      ) {
        const totalSkipped =
          (stats.duplicatesFoldersSkipped || 0) + (stats.duplicatesConversationsSkipped || 0);
        message = this.t('folder_import_success_skipped')
          .replace('{folders}', String(stats.foldersImported))
          .replace('{conversations}', String(stats.conversationsImported))
          .replace('{skipped}', String(totalSkipped));
      }

      this.showNotification(message, 'success');
      this.debug('Import successful:', stats);
    } catch (error) {
      console.error('[FolderManager] Import error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      // Always release the lock, even if an error occurred
      this.importInProgress = false;
    }
  }

  /**
   * Import folder data from pasted JSON text
   */
  private async handleImportFromText(jsonText: string, strategy: ImportStrategy): Promise<void> {
    if (this.importInProgress) {
      this.showNotification(
        this.t('folder_import_in_progress') || 'Import already in progress',
        'info',
      );
      return;
    }

    this.importInProgress = true;

    try {
      const parseResult = FolderImportExportService.parseJSONText(jsonText);
      if (!parseResult.success) {
        this.showNotification(this.t('folder_import_invalid_format'), 'error');
        return;
      }

      if (strategy === 'overwrite') {
        const confirmed = confirm(this.t('folder_import_confirm_overwrite'));
        if (!confirmed) return;
      }

      const validationResult = FolderImportExportService.validatePayload(parseResult.data);
      if (!validationResult.success) {
        this.showNotification(
          this.t('folder_import_invalid_format') + ': ' + validationResult.error.message,
          'error',
        );
        return;
      }

      const importResult = await FolderImportExportService.importFromPayload(
        validationResult.data,
        this.data as unknown as Parameters<typeof FolderImportExportService.importFromPayload>[1],
        { strategy, createBackup: true },
      );

      if (!importResult.success) {
        this.showNotification(
          this.t('folder_import_error').replace('{error}', String(importResult.error)),
          'error',
        );
        return;
      }

      this.data = importResult.data.data;
      this.saveData();
      this.refresh();

      const stats = importResult.data.stats;
      let message = this.t('folder_import_success')
        .replace('{folders}', String(stats.foldersImported))
        .replace('{conversations}', String(stats.conversationsImported));

      if (
        strategy === 'merge' &&
        (stats.duplicatesFoldersSkipped || stats.duplicatesConversationsSkipped)
      ) {
        const totalSkipped =
          (stats.duplicatesFoldersSkipped || 0) + (stats.duplicatesConversationsSkipped || 0);
        message = this.t('folder_import_success_skipped')
          .replace('{folders}', String(stats.foldersImported))
          .replace('{conversations}', String(stats.conversationsImported))
          .replace('{skipped}', String(totalSkipped));
      }

      this.showNotification(message, 'success');
      this.debug('Import from text successful:', stats);
    } catch (error) {
      console.error('[FolderManager] Import from text error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      this.importInProgress = false;
    }
  }

  private isFolderSearchActive(): boolean {
    return this.folderSearchEnabled && normalizeFolderSearchText(this.folderSearchQuery).length > 0;
  }

  private isFolderOnlySearchActive(): boolean {
    return this.isFolderSearchActive() && this.getFolderSearchCriteria().mode === 'folder';
  }

  private getFolderSearchCriteria(): FolderSearchCriteria {
    return parseFolderSearchCriteria(this.folderSearchQuery);
  }

  private matchesFolderSearchText(value: string): boolean {
    const { query } = this.getFolderSearchCriteria();
    return query.length === 0 || normalizeFolderSearchText(value).includes(query);
  }

  private filterVisibleConversations(
    conversations: ConversationReference[],
    includeForFolderOnlySearch = false,
  ): ConversationReference[] {
    const userConversations = this.filterConversationsByCurrentUser(conversations);
    if (!this.isFolderSearchActive()) return userConversations;
    if (this.isFolderOnlySearchActive()) {
      return includeForFolderOnlySearch ? userConversations : [];
    }

    return userConversations.filter((conversation) =>
      this.matchesFolderSearchText(conversation.title),
    );
  }

  private matchesFolderSearchTree(folderId: string): boolean {
    if (!this.isFolderSearchActive()) return this.hasVisibleContent(folderId);

    const folder = this.data.folders.find((item) => item.id === folderId);
    if (!folder) return false;
    if (this.matchesFolderSearchText(folder.name) && this.hasVisibleContent(folder.id)) return true;

    const conversations = this.data.folderContents[folderId] || [];
    if (this.filterVisibleConversations(conversations).length > 0) return true;

    const subfolders = this.data.folders.filter((item) => item.parentId === folderId);
    return subfolders.some((subfolder) => this.matchesFolderSearchTree(subfolder.id));
  }

  /**
   * Check if a folder has any visible content for the current user.
   * - If filter is disabled, always returns true (show everything).
   * - If filter is enabled:
   *   - Returns true if folder has any conversations matching current user.
   *   - Returns true if any subfolder has visible content.
   *   - Returns false otherwise.
   */
  private hasVisibleContent(folderId: string): boolean {
    if (!this.filterCurrentUserOnly) return true;

    // Check direct conversations
    const conversations = this.data.folderContents[folderId] || [];
    const userConversations = this.filterConversationsByCurrentUser(conversations);
    if (userConversations.length > 0) return true;

    // Check subfolders recursively
    const subfolders = this.data.folders.filter((f) => f.parentId === folderId);
    for (const subfolder of subfolders) {
      if (this.hasVisibleContent(subfolder.id)) return true;
    }

    // Always show empty folders (no conversations, no subfolders) —
    // the filter hides folders with only other users' content, not empty ones
    if (conversations.length === 0 && subfolders.length === 0) return true;

    return false;
  }

  /**
   * Filter conversations to show only those belonging to the current user.
   * If filterCurrentUserOnly is false, returns all conversations.
   */
  private filterConversationsByCurrentUser(
    conversations: ConversationReference[],
  ): ConversationReference[] {
    if (!this.filterCurrentUserOnly) {
      return conversations;
    }
    const currentUserId = this.getCurrentUserId();
    return conversations.filter((conv) => {
      const convUserId = this.getUserIdFromUrl(conv.url);
      // Always show conversations with unspecified user (e.g. /app/...) as they might redirect to current user
      if (convUserId === null) return true;
      return convUserId === currentUserId;
    });
  }

  /**
   * Get the current user ID from the URL.
   * URL patterns:
   * - /u/0/app/xxx → user "0"
   * - /u/1/app/xxx → user "1"
   * - /app?hl=zh&pageId=none → user "0" (default)
   */
  private getCurrentUserId(): string {
    try {
      const path = window.location.pathname;
      const match = path.match(/^\/u\/(\d+)\//);
      return match ? match[1] : '0';
    } catch {
      return '0';
    }
  }

  /**
   * Extract user ID from a conversation URL.
   * @param url The conversation URL
   * @returns User ID string, or null if unspecified (e.g. /app/...)
   */
  private getUserIdFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/^\/u\/(\d+)\//);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Toggle the "show only current user" filter and refresh the UI.
   */
  private toggleFilterCurrentUser(): void {
    this.filterCurrentUserOnly = !this.filterCurrentUserOnly;
    this.debug('Filter current user only:', this.filterCurrentUserOnly);

    // Save setting to storage
    browser.storage.sync
      .set({
        [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: this.filterCurrentUserOnly,
      })
      .catch((e) => console.error('Failed to save filter user setting:', e));

    // Refresh the entire folder container to update button state and list
    if (this.containerElement) {
      // Update the filter button state
      const filterBtn = this.containerElement.querySelector(
        '.gv-folder-header-actions button:first-child',
      );
      if (filterBtn) {
        if (this.filterCurrentUserOnly) {
          filterBtn.classList.add('gv-filter-active');
        } else {
          filterBtn.classList.remove('gv-filter-active');
        }
      }
    }

    // Refresh the folders list to apply the filter
    this.refresh();
  }

  private showNotification(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `gv-notification gv-notification-${type}`;
    notification.textContent = message;

    // Add to body
    document.body.appendChild(notification);

    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 10);

    // Remove after 3 seconds
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  /**
   * Generic header dropdown menu opener. Used by import/export, cloud, and any
   * other header action that wants a "click button → click an item" popover.
   * Reuses the activeImportExportMenu slot so only one header menu is open at
   * a time across the entire header.
   */
  private openHeaderMenu(
    event: MouseEvent,
    items: Array<{ label: string; icon?: string; iconHtml?: string; action: () => void }>,
  ): void {
    event.stopPropagation();

    if (this.activeImportExportMenu && !this.activeImportExportMenu.isConnected) {
      this.activeImportExportMenu = null;
      this.removeActiveImportExportMenuCloseHandler();
    }

    if (this.activeImportExportMenu) {
      this.closeActiveImportExportMenu();
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    items.forEach((item) => {
      const menuItem = document.createElement('button');
      menuItem.className = 'gv-folder-menu-item';
      const iconMarkup = item.iconHtml
        ? `<span class="gv-folder-menu-icon" aria-hidden="true">${item.iconHtml}</span>`
        : `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true" style="font-size: 18px; line-height: 1; margin-right: 8px;">${item.icon ?? ''}</mat-icon>`;
      menuItem.innerHTML = `${iconMarkup}${item.label}`;
      menuItem.addEventListener('click', () => {
        this.closeActiveImportExportMenu();
        item.action();
      });
      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);
    this.activeImportExportMenu = menu;

    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.closeActiveImportExportMenu();
      }
    };
    this.activeImportExportMenuCloseHandler = closeMenu;
    this.activeImportExportMenuListenerTimeout = window.setTimeout(() => {
      document.addEventListener('click', closeMenu);
      this.activeImportExportMenuListenerTimeout = null;
    }, 0);
  }

  /**
   * Show import/export dropdown menu
   */
  private showImportExportMenu(event: MouseEvent): void {
    this.openHeaderMenu(event, [
      {
        label: this.t('folder_import'),
        icon: 'upload',
        action: () => this.showImportDialog(),
      },
      {
        label: this.t('folder_export'),
        icon: 'download',
        action: () => this.exportFolders(),
      },
    ]);
  }

  /**
   * Cloud popover — replaces the previous two-button Upload/Sync split.
   * Uses the original inline SVG glyphs because Gemini's bundled Material
   * Symbols font does not include `cloud_upload` / `cloud_download` ligatures.
   */
  private showCloudMenu(event: MouseEvent): void {
    const uploadSvg = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H520q-33 0-56.5-23.5T440-240v-206l-64 62-56-56 160-160 160 160-56 56-64-62v206h220q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h100v80H260Zm220-280Z"/></svg>`;
    const syncSvg = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q17-72 85-137t145-65q33 0 56.5 23.5T520-716v242l64-62 56 56-160 160-160-160 56-56 64 62v-242q-76 14-118 73.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-48-22-89.5T600-680v-93q74 35 117 103.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm220-358Z"/></svg>`;

    this.openHeaderMenu(event, [
      {
        label: this.t('folder_cloud_upload'),
        iconHtml: uploadSvg,
        action: () => {
          void this.handleCloudUpload();
        },
      },
      {
        label: this.t('folder_cloud_sync'),
        iconHtml: syncSvg,
        action: () => {
          void this.handleCloudSync();
        },
      },
    ]);
  }

  /**
   * Folder settings popover. Hosts folder-scoped settings (conversation order,
   * font size, spacing, and subfolder indent). Settings live next to the feature
   * they control so users don't have to dig into the popup to tune them.
   */
  private showFolderSettingsMenu(event: MouseEvent): void {
    event.stopPropagation();

    if (this.activeImportExportMenu && !this.activeImportExportMenu.isConnected) {
      this.activeImportExportMenu = null;
      this.removeActiveImportExportMenuCloseHandler();
    }

    if (this.activeImportExportMenu) {
      this.closeActiveImportExportMenu();
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu gv-folder-settings-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    menu.appendChild(this.createConversationSortSettingsRow());

    const steppers: Array<{
      labelKey: string;
      storageKey: string;
      min: number;
      max: number;
      defaultValue: number;
      unit?: string;
    }> = [
      {
        labelKey: 'folder_item_font_size',
        storageKey: StorageKeys.GV_FOLDER_ITEM_FONT_SIZE,
        min: 12,
        max: 18,
        defaultValue: 13,
        unit: 'px',
      },
      {
        labelKey: 'folderSpacing',
        storageKey: StorageKeys.GV_FOLDER_SPACING,
        min: 0,
        max: 16,
        defaultValue: 2,
      },
      {
        labelKey: 'folderTreeIndent',
        storageKey: StorageKeys.GV_FOLDER_TREE_INDENT,
        min: -8,
        max: 32,
        defaultValue: -8,
      },
    ];

    steppers.forEach((config) => {
      menu.appendChild(this.createSettingsStepperRow(config));
    });

    // Swallow clicks that originated inside the settings menu so a stepper press
    // can't bubble up to the document-level "click outside → close" handler. This
    // is a belt-and-suspenders layer on top of per-button stopPropagation, since
    // some browsers re-target clicks when the focused element becomes disabled
    // mid-event.
    menu.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(menu);
    this.activeImportExportMenu = menu;

    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.closeActiveImportExportMenu();
      }
    };
    this.activeImportExportMenuCloseHandler = closeMenu;
    this.activeImportExportMenuListenerTimeout = window.setTimeout(() => {
      document.addEventListener('click', closeMenu);
      this.activeImportExportMenuListenerTimeout = null;
    }, 0);
  }

  private createConversationSortSettingsRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gv-folder-settings-row gv-folder-sort-settings-row';

    const label = document.createElement('span');
    label.className = 'gv-folder-settings-label';
    label.textContent = this.t('folder_sort');

    const options = document.createElement('div');
    options.className = 'gv-folder-sort-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', this.t('folder_sort'));

    const buttons = new Map<ConversationSortMode, HTMLButtonElement>();
    const render = () => {
      buttons.forEach((button, mode) => {
        const active = this.conversationSortMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    };

    (['manual', 'recent'] as const).forEach((mode) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gv-folder-sort-option';
      button.textContent = this.t(mode === 'manual' ? 'folder_sort_manual' : 'folder_sort_recent');
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setConversationSortMode(mode);
        render();
      });
      buttons.set(mode, button);
      options.appendChild(button);
    });

    render();
    row.append(label, options);
    return row;
  }

  private createSettingsStepperRow(config: {
    labelKey: string;
    storageKey: string;
    min: number;
    max: number;
    defaultValue: number;
    unit?: string;
  }): HTMLElement {
    const { labelKey, storageKey, min, max, defaultValue, unit } = config;
    const clamp = (n: number) =>
      Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : defaultValue)));

    const row = document.createElement('div');
    row.className = 'gv-folder-settings-row';

    const label = document.createElement('span');
    label.className = 'gv-folder-settings-label';
    label.textContent = this.t(labelKey);

    const stepper = document.createElement('div');
    stepper.className = 'gv-folder-stepper';

    const minus = document.createElement('button');
    minus.className = 'gv-folder-stepper-btn';
    minus.type = 'button';
    minus.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">remove</mat-icon>`;
    minus.title = this.t('folder_item_font_size_decrease');

    const value = document.createElement('span');
    value.className = 'gv-folder-stepper-value';

    const plus = document.createElement('button');
    plus.className = 'gv-folder-stepper-btn';
    plus.type = 'button';
    plus.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">add</mat-icon>`;
    plus.title = this.t('folder_item_font_size_increase');

    let current = defaultValue;

    const render = () => {
      value.textContent = unit ? `${current}${unit}` : `${current}`;
      minus.disabled = current <= min;
      plus.disabled = current >= max;
    };

    const persist = (next: number) => {
      current = clamp(next);
      render();
      try {
        void chrome.storage.sync.set({ [storageKey]: current });
      } catch (err) {
        console.warn(`[FolderManager] Failed to save ${storageKey}:`, err);
      }
    };

    minus.addEventListener('click', (e) => {
      e.stopPropagation();
      persist(current - 1);
    });
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      persist(current + 1);
    });

    try {
      void chrome.storage.sync.get({ [storageKey]: defaultValue }).then((res) => {
        const raw = (res as Record<string, unknown>)?.[storageKey];
        const n = typeof raw === 'number' ? raw : Number(raw);
        current = Number.isFinite(n) ? clamp(n) : defaultValue;
        render();
      });
    } catch {
      // Fall through to default render below.
    }
    render();

    stepper.appendChild(minus);
    stepper.appendChild(value);
    stepper.appendChild(plus);

    row.appendChild(label);
    row.appendChild(stepper);
    return row;
  }

  /**
   * Handle cloud upload - upload folder data, prompts, and starred messages to Google Drive
   * This mirrors the logic in CloudSyncSettings.tsx handleSyncNow()
   */
  private async handleCloudUpload(): Promise<void> {
    try {
      this.showNotification(this.t('uploadInProgress'), 'info');
      const timelineHierarchyAccountScope = await this.resolveTimelineHierarchySyncScope();

      // Get current folder data
      const folders = this.data;

      // Get prompts from storage
      let prompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          prompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[FolderManager] Could not get prompts for upload:', err);
      }

      this.debug(
        `Uploading - folders: ${folders.folders?.length || 0}, prompts: ${prompts.length}`,
      );

      // Send upload request to background script
      // Background script will also fetch starred messages for Gemini platform
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.upload',
        payload: {
          folders,
          prompts,
          platform: 'gemini',
          accountScope: this.toSyncAccountScope(this.accountScope),
          timelineHierarchyAccountScope,
        },
      })) as { ok?: boolean; error?: string } | undefined;

      if (response?.ok) {
        this.showNotification(this.t('uploadSuccess'), 'success');
      } else {
        const errorMsg = response?.error || 'Unknown error';
        this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FolderManager] Cloud upload failed:', error);
      this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
    }
  }

  /**
   * Handle cloud sync - download and merge folder data, prompts, and starred messages from Google Drive
   * This mirrors the logic in CloudSyncSettings.tsx handleDownloadFromDrive()
   */
  private async handleCloudSync(): Promise<void> {
    try {
      this.showNotification(this.t('downloadInProgress'), 'info');
      const timelineHierarchyAccountScope = await this.resolveTimelineHierarchySyncScope();
      const timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(
        timelineHierarchyAccountScope?.accountKey,
      );

      // Send download request to background script
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.download',
        payload: {
          platform: 'gemini',
          accountScope: this.toSyncAccountScope(this.accountScope),
          timelineHierarchyAccountScope,
        },
      })) as
        | {
            ok?: boolean;
            error?: string;
            highlights?: { synced?: boolean; count?: number; empty?: boolean };
            data?: {
              folders?: { data?: FolderData };
              prompts?: { items?: PromptItem[] };
              starred?: { data?: { messages: Record<string, unknown[]> } };
              timelineHierarchy?: { data?: TimelineHierarchyData };
            };
          }
        | undefined;

      if (!response?.ok) {
        const errorMsg = response?.error || 'Download failed';
        this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
        return;
      }

      if (!response.data) {
        if (response.highlights?.synced) {
          this.showNotification(this.t('syncSuccess'), 'success');
          return;
        }
        this.showNotification(this.t('syncNoData') || 'No data in cloud', 'info');
        return;
      }

      // Extract cloud data
      const cloudFoldersPayload = response.data?.folders;
      const cloudPromptsPayload = response.data?.prompts;
      const cloudStarredPayload = response.data?.starred;
      const cloudTimelineHierarchyPayload = response.data?.timelineHierarchy;
      const cloudFolderData = cloudFoldersPayload?.data || { folders: [], folderContents: {} };
      const cloudPromptItems = cloudPromptsPayload?.items || [];
      const cloudStarredData = cloudStarredPayload?.data || { messages: {} };
      const cloudTimelineHierarchyData = cloudTimelineHierarchyPayload?.data || {
        conversations: {},
      };

      this.debug(
        `Downloaded - folders: ${cloudFolderData.folders?.length || 0}, prompts: ${cloudPromptItems.length}, starred conversations: ${Object.keys(cloudStarredData.messages || {}).length}`,
      );

      // Get local prompts for merge
      let localPrompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          localPrompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[FolderManager] Could not get local prompts for merge:', err);
      }

      // Get local starred messages for merge
      let localStarred = { messages: {} as Record<string, unknown[]> };
      try {
        const starredResult = await chrome.storage.local.get(['geminiTimelineStarredMessages']);
        const starredData = starredResult.geminiTimelineStarredMessages;
        if (
          typeof starredData === 'object' &&
          starredData !== null &&
          'messages' in starredData &&
          typeof starredData.messages === 'object' &&
          starredData.messages !== null
        ) {
          localStarred = { messages: starredData.messages as Record<string, unknown[]> };
        }
      } catch (err) {
        console.warn('[FolderManager] Could not get local starred messages for merge:', err);
      }

      let localTimelineHierarchy: TimelineHierarchyData = { conversations: {} };
      try {
        const hierarchyResult = (await chrome.storage.local.get(
          getTimelineHierarchyStorageKeysToRead(timelineHierarchyAccountScope?.accountKey),
        )) as Record<string, unknown>;
        localTimelineHierarchy = resolveTimelineHierarchyDataForStorageScope(
          hierarchyResult,
          timelineHierarchyAccountScope?.accountKey,
          timelineHierarchyAccountScope?.routeUserId ?? null,
        );
      } catch (err) {
        console.warn('[FolderManager] Could not get local timeline hierarchy for merge:', err);
      }

      // Merge folder data
      const localFolders = this.data;
      const mergedFolders = mergeFolderData(localFolders, cloudFolderData);

      // Merge prompts (simple ID-based merge)
      const mergedPrompts = this.mergePrompts(localPrompts, cloudPromptItems);

      // Merge starred messages
      const mergedStarred = this.mergeStarredMessages(localStarred, cloudStarredData);
      const mergedTimelineHierarchy = mergeTimelineHierarchy(
        localTimelineHierarchy,
        cloudTimelineHierarchyData,
      );

      this.debug(
        `Merged - folders: ${mergedFolders.folders?.length || 0}, prompts: ${mergedPrompts.length}, starred conversations: ${Object.keys(mergedStarred.messages || {}).length}, hierarchy conversations: ${Object.keys(mergedTimelineHierarchy.conversations || {}).length}`,
      );

      // Apply merged folder data
      this.data = mergedFolders;
      await this.saveData();

      // Save merged prompts and starred to storage
      try {
        await chrome.storage.local.set({
          gvPromptItems: mergedPrompts,
          geminiTimelineStarredMessages: mergedStarred,
          [timelineHierarchyStorageKey]: mergedTimelineHierarchy,
        });
      } catch (err) {
        console.error('[FolderManager] Failed to save merged prompts/starred/hierarchy:', err);
      }

      this.refresh();
      this.showNotification(this.t('downloadMergeSuccess'), 'success');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[FolderManager] Cloud sync failed:', error);
      this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
    }
  }

  /**
   * Merge prompts through the shared sync policy so legacy cloud records
   * cannot erase names that exist only in local storage.
   */
  private mergePrompts(local: PromptItem[], cloud: PromptItem[]): PromptItem[] {
    return mergeSyncedPrompts(local, cloud);
  }

  /**
   * Merge starred messages by conversationId and turnId
   */
  private mergeStarredMessages(
    local: { messages: Record<string, unknown[]> },
    cloud: { messages: Record<string, unknown[]> },
  ): { messages: Record<string, unknown[]> } {
    const localMessages = local?.messages || {};
    const cloudMessages = cloud?.messages || {};

    const allConversationIds = new Set([
      ...Object.keys(localMessages),
      ...Object.keys(cloudMessages),
    ]);

    const mergedMessages: Record<string, unknown[]> = {};

    allConversationIds.forEach((conversationId) => {
      const localConvoMessages = localMessages[conversationId] || [];
      const cloudConvoMessages = cloudMessages[conversationId] || [];

      type StarredMsg = { turnId?: string; starredAt?: number };
      const messageMap = new Map<string, unknown>();

      // Add cloud messages first
      cloudConvoMessages.forEach((m) => {
        const msg = m as StarredMsg;
        if (msg?.turnId) messageMap.set(msg.turnId, m);
      });

      // Merge local messages - prefer newer starredAt
      localConvoMessages.forEach((m) => {
        const localMsg = m as StarredMsg;
        if (!localMsg?.turnId) return;
        const existingMsg = messageMap.get(localMsg.turnId) as StarredMsg | undefined;
        if (!existingMsg) {
          messageMap.set(localMsg.turnId, m);
        } else if ((localMsg.starredAt || 0) >= (existingMsg.starredAt || 0)) {
          messageMap.set(localMsg.turnId, m);
        }
      });

      const mergedArray = Array.from(messageMap.values());
      if (mergedArray.length > 0) {
        mergedMessages[conversationId] = mergedArray;
      }
    });

    return { messages: mergedMessages };
  }

  /**
   * Get dynamic tooltip for cloud upload button showing last upload time
   */
  private async getCloudUploadTooltip(): Promise<string> {
    try {
      const response = (await browser.runtime.sendMessage({ type: 'gv.sync.getState' })) as
        | { ok?: boolean; state?: { lastUploadTime?: number | null } }
        | undefined;
      if (response?.ok && response.state) {
        const lastUploadTime = response.state.lastUploadTime;
        const timeStr = this.formatRelativeTime(lastUploadTime ?? null);
        const baseTooltip = this.t('folder_cloud_upload');
        return lastUploadTime
          ? `${baseTooltip}\n${this.t('lastUploaded').replace('{time}', timeStr)}`
          : `${baseTooltip}\n${this.t('neverUploaded')}`;
      }
    } catch (e) {
      console.warn('[FolderManager] Failed to get sync state for tooltip:', e);
    }
    return this.t('folder_cloud_upload');
  }

  /**
   * Get dynamic tooltip for cloud sync button showing last sync time
   */
  private async getCloudSyncTooltip(): Promise<string> {
    try {
      const response = (await browser.runtime.sendMessage({ type: 'gv.sync.getState' })) as
        | { ok?: boolean; state?: { lastSyncTime?: number | null } }
        | undefined;
      if (response?.ok && response.state) {
        const lastSyncTime = response.state.lastSyncTime;
        const timeStr = this.formatRelativeTime(lastSyncTime ?? null);
        const baseTooltip = this.t('folder_cloud_sync');
        return lastSyncTime
          ? `${baseTooltip}\n${this.t('lastSynced').replace('{time}', timeStr)}`
          : `${baseTooltip}\n${this.t('neverSynced')}`;
      }
    } catch (e) {
      console.warn('[FolderManager] Failed to get sync state for tooltip:', e);
    }
    return this.t('folder_cloud_sync');
  }

  /**
   * Format a timestamp as relative time (e.g. "5 minutes ago")
   */
  private formatRelativeTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return this.t('justNow');
    } else if (diffMins < 60) {
      return `${diffMins} ${this.t('minutesAgo')}`;
    } else if (diffHours < 24) {
      return `${diffHours} ${this.t('hoursAgo')}`;
    } else if (diffDays === 1) {
      return this.t('yesterday');
    } else {
      return new Date(timestamp).toLocaleDateString();
    }
  }
}
