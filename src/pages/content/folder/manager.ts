import browser, { type Runtime } from 'webextension-polyfill';

import { type AccountScope } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { SyncAccountScope } from '@/core/types/sync';
import { isSafari } from '@/core/utils/browser';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { initI18n } from '@/utils/i18n';

import { FolderFeedback } from './FolderFeedback';
import { FolderNavigation } from './FolderNavigation';
import { FolderSelection } from './FolderSelection';
import { FolderSidebarRuntime } from './FolderSidebarRuntime';
import { FolderStore, type FolderStoreChange } from './FolderStore';
import { FolderTransferController } from './FolderTransferController';
import { FolderTreeView } from './FolderTreeView';
import { NativeConversationMenus } from './NativeConversationMenus';
import { NativeSidebarObserver } from './NativeSidebarObserver';
import { type FloatingFabPos, mountFloatingFab, unmountFloatingFab } from './floatingModeFab';
import { unmountFloatingModeNudge } from './floatingModeNudge';
import {
  type FloatingPanelHandle,
  type FloatingPanelPos,
  type FloatingPanelSize,
  mountFloatingPanel,
} from './floatingPanel';
import { createFolderDialogs } from './folderDialogs';
import { createFolderHeaderMenus } from './headerMenus';
import {
  mountHideArchivedNudge,
  shouldShowHideArchivedNudge,
  unmountHideArchivedNudge,
} from './hideArchivedNudge';
import {
  collectAllSidebarConversations,
  extractConversationId,
  extractNativeConversationTitle,
  findNativeConversationElement,
  getNativeConversationElements,
  getNativeConversationRoot,
  resolveConversationRouteId,
} from './nativeSidebarDom';
import type { ConversationReference, Folder } from './types';
const IS_DEBUG = false;
const ARCHIVED_CONVERSATION_ACTIONS_CLASS = 'gv-conversation-archived-actions';
const LEGACY_ACTIONS_PROBE_TTL_MS = 1000;

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
  private readonly store: FolderStore = new FolderStore({
    getContext: () => ({
      sidebar: this.sidebarRuntime.sidebar,
      sortMode: this.treeView.sortMode,
      enabled: this.folderEnabled,
    }),
    onChange: (reason) => this.handleStoreChange(reason),
    onArchive: () => this.maybeShowHideArchivedNudge(),
    onRecovery: (result) => {
      if (result === 'recovered')
        this.feedback.showNotificationByLevel(
          'Folder data has been recovered from a backup.',
          'warning',
        );
      else this.feedback.showDataLossNotification();
    },
  });
  private readonly transfer = new FolderTransferController({
    getContext: () => ({
      session: this.store.session,
      activation: this.store.activation,
      data: this.store.data,
    }),
    applyData: (data) => {
      if (!this.store.canEdit) return Promise.resolve(false);
      this.store.data = data;
      return this.store.saveData();
    },
    refresh: () => this.refresh(),
    notify: (message, type) => this.feedback.showNotification(message, type),
  });
  private readonly dialogs = createFolderDialogs();
  private readonly feedback = new FolderFeedback();
  private readonly navigation = new FolderNavigation({
    getContext: () => ({
      container: this.sidebarRuntime.panel,
      sidebar: this.sidebarRuntime.sidebar,
      isDestroyed: this.isDestroyed,
      accountIsolationEnabled: this.store.accountIsolationEnabled,
    }),
    onRouteChange: () => {
      void this.store.reloadScopedDataOnAccountRouteChange();
    },
    onOpened: (id) => this.store.markConversationAsRecentlyOpened(id),
    onTitleChange: (id, title) => this.store.updateConversationTitle(id, title),
    onGemDetected: (id, gemId) => this.store.updateConversationGem(id, gemId),
  });
  private folderEnabled: boolean = true;
  private hideArchivedConversations: boolean = false; // Whether to hide conversations in folders
  private hideArchivedNudgeShown: boolean = false;
  // Cached result of the legacy `.conversation-actions-container` layout
  // probe — see `hasLegacyActionsContainer` (issue #753).
  private legacyActionsProbe: { present: boolean; at: number } | null = null;
  private isDestroyed: boolean = false;
  private readonly lifetimeCleanup: Array<() => void> = [];
  private readonly headerMenus = createFolderHeaderMenus();
  private readonly nativeSidebarObserver = new NativeSidebarObserver({
    isDestroyed: () => this.isDestroyed,
    enhanceConversation: (row) => {
      this.selection.makeConversationDraggable(row);
      this.applyHideArchivedToConversation(row);
    },
    hasStoredConversations: () => this.store.hasStoredConversations(),
    onTitlesChanged: () => this.store.syncConversationTitlesFromNative(),
  });
  private readonly nativeConversationMenus: NativeConversationMenus = new NativeConversationMenus({
    getContext: () => ({
      sidebar: this.sidebarRuntime.sidebar,
      storageKey: this.store.storageKey,
      accountIsolationEnabled: this.store.accountIsolationEnabled,
      isDestroyed: this.isDestroyed,
    }),
    onMoveToFolder: ({ id, title, url }) => {
      if (!this.store.canEdit) return;
      this.dialogs.openMove(this.store.data.folders, (folderId) => {
        this.addConversationToFolderFromNative(folderId, id, title, url);
      });
    },
    onConfirmedDelete: (id) => this.store.removeConversationFromAllFolders(id),
  });

  private readonly sidebarRuntime: FolderSidebarRuntime = new FolderSidebarRuntime({
    createPanel: () => this.treeView.createPanel(),
    onPanelMount: () => {
      this.treeView.mount();
      this.selection.mount();
      this.navigation.highlightActiveConversation();
      this.navigation.bind();
    },
    onPanelUnmount: () => {
      this.selection.unmount();
      this.treeView.unmount();
      this.navigation.unbind();
      this.feedback.hideTooltip();
      this.headerMenus.close();
      this.transfer.closeImportDialog();
      this.dialogs.closeAll();
    },
    nativeSidebar: this.nativeSidebarObserver,
    nativeMenus: this.nativeConversationMenus,
    floating: {
      isOpen: () => this.floatingPanelHandle !== null,
      open: async (openPanel) => {
        this.navigation.bind();
        if (openPanel) await this.openFloatingPanel();
        else await this.showFloatingFab();
      },
      close: () => this.closeFloatingUI(),
    },
  });

  private readonly selection: FolderSelection = new FolderSelection({
    store: this.store,
    runtime: this.sidebarRuntime,
    navigation: this.navigation,
    feedback: this.feedback,
    nativeMenus: this.nativeConversationMenus,
    getContext: () => ({
      sortMode: this.treeView.sortMode,
      accountIsolationEnabled: this.store.accountIsolationEnabled,
      isDestroyed: this.isDestroyed,
    }),
  });
  private readonly treeView: FolderTreeView = new FolderTreeView({
    store: this.store,
    runtime: this.sidebarRuntime,
    selection: this.selection,
    navigation: this.navigation,
    feedback: this.feedback,
    dialogs: this.dialogs,
    transfer: this.transfer,
    headerMenus: this.headerMenus,
    getContext: () => ({
      enabled: this.folderEnabled,
      hideArchivedConversations: this.hideArchivedConversations,
      isDestroyed: this.isDestroyed,
    }),
    onRefresh: () => this.refresh(),
    onRenameNative: (conversation) => this.openNativeRenameForFolderConversation(conversation),
    onSortModeChange: (mode) => this.floatingPanelHandle?.update(this.store.data, mode),
  });

  // Floating-mode state — an opt-in "always use a floating window for folders"
  // switch exposed in the popup. When on, we never attempt to inject the
  // folder panel into Gemini's sidebar; we mount the body-level floating
  // panel (or its FAB) + native ⋮ menu observer and call it a day. When off, normal
  // sidebar injection; a failure is a silent no-op.
  private floatingPanelHandle: FloatingPanelHandle | null = null;
  private floatingModeEnabled: boolean = false;
  private floatingOpenOnStart: boolean = true;

  constructor() {
    // Initialize i18n system
    initI18n().catch((e) => {
      this.debugWarn('Failed to initialize i18n:', e);
    });
  }

  async init(): Promise<void> {
    try {
      // Initialize storage adapter (handles migration for Safari automatically)
      await this.store.init();
      if (this.isDestroyed) return;

      // Load folder enabled setting
      await this.loadFolderEnabledSetting();

      if (this.folderEnabled) {
        await this.store.initializeConversationActivityTracking();
      }

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
      await this.sidebarRuntime.loadAnchor();
      await this.treeView.loadSettings();
      if (this.isDestroyed) return;

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
        await this.sidebarRuntime.start('floating', this.floatingOpenOnStart);
      } else {
        await this.sidebarRuntime.start('sidebar');
      }

      this.debug('Initialized successfully');
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        return;
      }
      console.error('[FolderManager] Initialization error:', error);
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    for (const cleanup of this.lifetimeCleanup.splice(0)) cleanup();
    this.selection.reset();
    this.treeView.unmount();
    this.navigation.destroy();
    this.sidebarRuntime.stop();
    this.store.destroy();
    this.feedback.destroy();
  }

  private teardownMountedFolderRuntime(): void {
    this.selection.reset();
    this.treeView.unmount();
    this.navigation.destroy();
    this.store.flushPendingSaveData();
    this.store.teardownConversationActivityTracking();
    this.sidebarRuntime.stop();
  }

  /**
   * Leave floating mode — tear down the body-level UI. Safe to call when
   * floating mode was never entered.
   */
  private closeFloatingUI(): void {
    unmountFloatingModeNudge();
    unmountFloatingFab();
    if (this.floatingPanelHandle) {
      this.floatingPanelHandle.destroy();
      this.floatingPanelHandle = null;
    }
    this.selection.removeFloatingHost();
  }

  /**
   * Mounts the small persistent FAB button in the corner. Safe to call multiple
   * times — the module is idempotent. Hydrates and persists position via
   * chrome.storage.sync so the user's chosen spot sticks across reloads.
   */
  private showFloatingFab(): Promise<void> {
    return browser.storage.sync
      .get({ [StorageKeys.FOLDER_FLOATING_FAB_POS]: null })
      .then((raw) => {
        if (this.isDestroyed || !this.folderEnabled || !this.sidebarRuntime.isFloatingMode) return;
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
        if (this.isDestroyed || !this.folderEnabled || !this.sidebarRuntime.isFloatingMode) return;
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

    this.floatingPanelHandle = mountFloatingPanel({
      data: this.store.data,
      dataReady: this.store.canEdit,
      conversationSortMode: this.treeView.sortMode,
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
        // Only explicit floating mode owns a persistent FAB. A temporary
        // recovery fallback stays dismissed until the sidebar returns, which
        // avoids turning an internal recovery state into a sticky user mode.
        if (this.sidebarRuntime.isFloatingMode) {
          void this.showFloatingFab();
        }
      },
      onNavigate: (conv) => {
        if (conv.url) {
          this.navigation.navigate(conv);
        }
      },
      onCreateFolder: (name, parentId) => {
        this.store.createFolder(name, parentId);
      },
      onRenameFolder: (folderId, name) => this.store.renameFolder(folderId, name),
      onDeleteFolder: (folderId) => this.store.removeFolder(folderId),
      // These delegate to the shared data paths, which persist via saveData —
      // and saveData's centralised hook already pushes the fresh snapshot into
      // the floating panel, so no explicit update calls are needed here.
      onRemoveConversation: (folderId, conversationId) => {
        // Reuse the existing data-only removal path; it already calls saveData
        // + refresh (sidebar refresh is a no-op when the sidebar isn't mounted).
        this.store.removeConversationFromFolder(folderId, conversationId);
      },
      onToggleStar: (folderId, conversationId) => {
        this.store.toggleConversationStar(folderId, conversationId);
      },
      onToggleFolderPinned: (folderId) => {
        this.store.togglePinFolder(folderId);
      },
      // Intra-panel conversation move: user dragged a conversation row from
      // folder A to folder B inside the floating panel. Cross-document drag
      // (native Gemini row → panel) is intentionally NOT wired — that path
      // proved unreliable; the user files new conversations via the native
      // ⋮ → "Move to folder" menu instead.
      onMoveConversation: (conversationId, fromFolderId, toFolderId) => {
        const conv = this.store.data.folderContents[fromFolderId]?.find(
          (c) => c.conversationId === conversationId,
        );
        if (!conv) return;
        this.store.moveConversationToFolder(fromFolderId, toFolderId, conv);
      },
      onSetFolderColor: (folderId, color) => {
        this.store.changeFolderColor(folderId, color);
      },
      // Cloud sync / upload — mirror what the sidebar's header buttons do.
      // Only wire on non-Safari; the floating panel hides these buttons on
      // Safari because our Drive OAuth2 flow is not supported there yet. The
      // panel reads `isSafari()` itself, but we still guard here so callbacks
      // stay undefined on Safari and nothing fires by accident.
      //
      // onCloudSync can mutate this.store.data (merges Drive payload locally); it
      // persists via saveData, whose centralised hook pushes the merged
      // snapshot into the floating panel. onCloudUpload is read-only locally.
      ...(isSafari()
        ? {}
        : {
            onCloudUpload: () => {
              void this.transfer.upload();
            },
            onCloudSync: () => {
              void this.transfer.sync();
            },
            getCloudUploadTooltip: () => this.transfer.getUploadTooltip(),
            getCloudSyncTooltip: () => this.transfer.getSyncTooltip(),
          }),
    });
  }

  private async openNativeRenameForFolderConversation(
    conversation: ConversationReference,
  ): Promise<boolean> {
    const conversationId = resolveConversationRouteId(
      conversation.url,
      conversation.conversationId,
    );
    if (!conversationId) return false;

    const conversationEl = findNativeConversationElement(
      this.sidebarRuntime.sidebar,
      conversationId,
    );
    if (!conversationEl) {
      this.debugWarn('Could not find native conversation element for rename:', conversationId);
      return false;
    }

    const restoreArchivedVisibility = this.temporarilyRevealNativeConversation(conversationEl);
    const nativeTitle = extractNativeConversationTitle(conversationEl);
    let moreButton: HTMLElement | null = null;

    try {
      moreButton = await this.nativeConversationMenus.findAndClickMoreButton(conversationEl);
      if (!moreButton) {
        this.debugWarn('Could not find native more button for rename:', conversationId);
        return false;
      }

      const renamed = await this.nativeConversationMenus.waitForRenameButtonAndClick();
      if (!renamed) {
        this.debugWarn('Could not find native rename button:', conversationId);
      } else {
        await this.store.restoreNativeTitleSync(conversationId, nativeTitle);
      }
      return renamed;
    } finally {
      if (moreButton) {
        this.nativeConversationMenus.resetNativeConversationMenuTrigger(moreButton);
      }
      restoreArchivedVisibility();
    }
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

  addConversationToFolderFromNative(
    folderId: string,
    conversationId: string,
    title: string,
    url: string,
    isGem?: boolean,
    gemId?: string,
    lastTurnAt?: number,
  ): void {
    this.store.addConversationToFolderFromNative(
      folderId,
      conversationId,
      title,
      url,
      isGem,
      gemId,
      lastTurnAt,
    );
  }

  getFolders(): Folder[] {
    return this.store.data.folders;
  }

  async ensureDataLoaded(): Promise<void> {
    await this.store.ensureDataLoaded();
  }

  private handleStoreChange(reason: FolderStoreChange): void {
    if (this.isDestroyed) return;
    this.treeView.updateAvailability();
    this.floatingPanelHandle?.setDataReady(this.store.canEdit);
    if (reason === 'account') {
      this.nativeSidebarObserver.clearTitleSync();
      this.treeView.clearRenderContext();
      this.navigation.cancel();
      this.dialogs.closeAll();
      this.headerMenus.close();
      this.transfer.closeImportDialog();
      this.selection.reset();
      this.treeView.render();
      this.floatingPanelHandle?.reset(this.store.data, this.treeView.sortMode);
      this.applyHideArchivedSetting();
    } else if (reason === 'data') {
      this.refresh();
    } else if (reason === 'title') {
      this.treeView.render();
    } else if (reason === 'activity') {
      if (this.treeView.viewMode === 'activity') this.refresh();
    } else {
      this.floatingPanelHandle?.update(this.store.data, this.treeView.sortMode);
    }
  }

  private refresh(): void {
    if (!this.sidebarRuntime.panel) return;
    this.treeView.render();
    this.applyHideArchivedSetting();
    this.store.flushTitleUpdates();
  }

  private async loadFolderEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        geminiFolderEnabled: true,
      });
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

  private toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
    if (!scope) return undefined;
    return {
      accountKey: scope.accountKey,
      accountId: scope.accountId,
      routeUserId: scope.routeUserId,
    };
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
    if (!this.sidebarRuntime.panel || !document.body.contains(this.sidebarRuntime.panel)) return;

    mountHideArchivedNudge({
      container: this.sidebarRuntime.panel,
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

  private setupStorageListener(): void {
    // Listen for sync settings changes
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      areaName: string,
    ): void => {
      if (this.isDestroyed) return;
      this.treeView.applySettings(changes, areaName);
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
            } else {
              void this.sidebarRuntime.start(
                next ? 'floating' : 'sidebar',
                this.floatingOpenOnStart,
              );
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
          if (this.hideArchivedConversations && this.sidebarRuntime.panel) {
            unmountHideArchivedNudge(this.sidebarRuntime.panel);
          }
          // Persist that the user knows this feature, so turning it off later
          // won't cause the nudge to reappear on the next archive.
          this.markNudgeShownIfUserKnowsFeature();
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]) {
          this.hideArchivedNudgeShown =
            !!changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN].newValue;
          if (this.hideArchivedNudgeShown && this.sidebarRuntime.panel) {
            unmountHideArchivedNudge(this.sidebarRuntime.panel);
          }
        }
      }
      // Folder anchor preference (local-only) — re-anchor the panel without
      // a full reinit. Mirrors `toggleFolderAnchor` for the cross-tab case.
      if (areaName === 'local' && changes[StorageKeys.FOLDERS_ANCHOR]) {
        this.sidebarRuntime.setAnchor(changes[StorageKeys.FOLDERS_ANCHOR].newValue);
      }
    };
    browser.storage.onChanged.addListener(listener);
    this.lifetimeCleanup.push(() => browser.storage.onChanged.removeListener(listener));

    // NOTE: the popup's 'gv.folders.reload' message is handled in
    // setupMessageListener. A second chrome.runtime.onMessage listener here
    // used to double-handle it (double loadData + double render per sync) and
    // its unconditional `return true` left responder-less broadcasts pending
    // forever on the sender side.

    // Perform migration from legacy settings
    this.performMigration();
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

  private applyFolderEnabledSetting(): void {
    if (this.folderEnabled) {
      this.debug('Folder feature enabled');
      void this.store.initializeConversationActivityTracking();

      if (this.floatingModeEnabled) {
        void this.sidebarRuntime.start('floating', this.floatingOpenOnStart).catch((error) => {
          console.error('[FolderManager] Failed to initialize floating folder UI:', error);
        });
        return;
      }

      if (!this.sidebarRuntime.panel) {
        this.debug('Folder feature enabled, initializing sidebar UI');
        void this.sidebarRuntime.start('sidebar').catch((error) => {
          console.error('[FolderManager] Failed to initialize folder UI:', error);
        });
      } else {
        this.sidebarRuntime.panel.style.display = '';
      }
    } else {
      this.debug('Folder feature disabled, tearing down mounted runtime');
      this.teardownMountedFolderRuntime();
    }
  }

  private applyHideArchivedSetting(): void {
    const conversations = getNativeConversationElements(this.sidebarRuntime.sidebar);
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

    const convId = extractConversationId(conv);
    const isArchived = this.store.isConversationInFolders(convId);

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
      getNativeConversationRoot(this.sidebarRuntime.sidebar).querySelector(
        '.conversation-actions-container',
      ) !== null;
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
          data: this.store.data,
          accountScope: this.toSyncAccountScope(this.store.accountScope),
        });
        return true;
      }

      // Handle reload request from the popup after a cloud sync. This is the
      // single handler for this message (a duplicate listener used to live in
      // setupStorageListener and double-processed every sync).
      if (msg.type === 'gv.folders.reload') {
        this.debug('Received reload request');
        this.store.loadData().then(() => {
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
        collectAllSidebarConversations(() => ({
          sidebar: this.sidebarRuntime.sidebar,
          accountIsolationEnabled: this.store.accountIsolationEnabled,
          isDestroyed: this.isDestroyed,
        }))
          .then((sidebarConversations) => {
            sendResponse({
              ok: true,
              sidebarConversations,
              folderData: this.store.data,
            });
          })
          .catch((error) => {
            this.debugWarn('getStructureForAI collection failed:', error);
            sendResponse({
              ok: true,
              sidebarConversations: [],
              folderData: this.store.data,
            });
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
    const callback = listener as Runtime.OnMessageListenerCallback;
    browser.runtime.onMessage.addListener(callback);
    this.lifetimeCleanup.push(() => browser.runtime.onMessage.removeListener(callback));
  }
}
