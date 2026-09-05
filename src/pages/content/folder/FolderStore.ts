import browser, { type Storage } from 'webextension-polyfill';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
  detectAccountContextFromDocument,
  extractRouteUserIdFromPath,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { buildConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import {
  type ConversationSortMode,
  getFolderDepth,
  moveFolder,
  normalizeFolderData,
  removeFolder,
  reorderConversations,
} from '@/features/folder/model/folderData';

import { TimestampService } from '../timestamp/TimestampService';
import { historyTimestampStore } from '../timestamp/historyTimestamps';
import { FolderDataSession, cloneFolderData } from './FolderDataSession';
import {
  extractConversationIdFromElement,
  extractNativeConversationId,
  extractNativeConversationTitle,
  getCurrentConversationId,
  getNativeConversationElements,
  normalizeConversationId,
  resolveConversationRouteId,
  syncConversationTitleFromNative,
} from './nativeSidebarDom';
import {
  type IFolderStorageAdapter,
  createFolderStorageAdapter,
} from './storage/FolderStorageAdapter';
import type { ConversationReference, DragData, Folder, FolderData } from './types';

const STORAGE_KEY = 'gvFolderData';
const ROOT_CONVERSATIONS_ID = '__root_conversations__';
const MAX_FOLDER_DEPTH = 1;
const IS_DEBUG = false;
const SAVE_DEBOUNCE_MS = 300;
const STORAGE_ECHO_SUPPRESS_WINDOW_MS = 2000;
const ACTIVITY_SEND_BUTTON_SELECTOR = [
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[data-tooltip*="Send"]',
  'button[data-tooltip*="send"]',
  '[data-send-button]',
  '.send-button',
].join(', ');
const ACTIVITY_COMPOSER_INPUT_SELECTOR = [
  'rich-textarea [contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  '.input-area textarea',
  'textarea[placeholder*="Ask"]',
].join(', ');

function validateFolderData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  return Array.isArray(value.folders) && typeof value.folderContents === 'object';
}

export type FolderStoreChange = 'account' | 'data' | 'title' | 'activity' | 'loaded' | 'saved';

export interface FolderStoreOptions {
  getContext: () => {
    sidebar: HTMLElement | null;
    sortMode: ConversationSortMode;
    enabled: boolean;
  };
  onChange: (reason: FolderStoreChange) => void;
  onArchive: () => void;
  onRecovery: (result: 'recovered' | 'lost') => void;
}

/** Owns Gemini folder data, account sessions, recovery, and serialized persistence. */
export class FolderStore {
  private readonly storageInitializations = new Map<string, Promise<void>>();
  private dataSession: FolderDataSession | null = new FolderDataSession(
    STORAGE_KEY,
    'gemini-folders',
    null,
    validateFolderData,
  );
  private readonly dataSessions = new Map<string, FolderDataSession>();
  private unresolvedData: FolderData = { folders: [], folderContents: {} };
  private accountScopeRequest = 0;
  accountIsolationEnabled = false;
  accountScope: AccountScope | null = null;
  private activeStorageKey = STORAGE_KEY;
  private isDestroyed = false;
  private nativeTitleSyncInProgress = false;
  private pendingTitleUpdates = new Map<string, string>();
  private pendingStorageEchoes = 0;
  private lastStorageEchoArmedAt = 0;
  private saveDebounceTimer: number | null = null;
  private beforeUnloadFlushHandler: (() => void) | null = null;
  private activityTimestampService: TimestampService | null = null;
  private activityTrackingPromise: Promise<void> | null = null;
  private activityTimestampUnsubscribe: (() => void) | null = null;
  private activitySendIntentHandler: ((event: Event) => void) | null = null;
  private readonly storageChangeHandler = (
    changes: Record<string, Storage.StorageChange>,
    area: string,
  ): void => {
    if (this.isDestroyed) return;
    if (area === 'local' && changes[this.activeStorageKey]) {
      if (!this.consumeStorageEchoSuppression()) void this.reloadFoldersFromStorage();
    }
    if (
      area === 'sync' &&
      (changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] ||
        changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI])
    ) {
      void accountIsolationService
        .isIsolationEnabled({
          platform: 'gemini',
          pageUrl: window.location.href,
        })
        .then((enabled) => this.setAccountIsolationEnabled(enabled));
    }
  };

  constructor(
    private readonly options: FolderStoreOptions,
    private readonly storage: IFolderStorageAdapter = createFolderStorageAdapter(),
  ) {}

  get data(): FolderData {
    return this.dataSession?.data ?? this.unresolvedData;
  }
  set data(value: FolderData) {
    if (this.dataSession) this.dataSession.data = value;
    else this.unresolvedData = value;
  }
  get session(): FolderDataSession | null {
    return this.dataSession;
  }
  get activation(): number {
    return this.accountScopeRequest;
  }
  get storageKey(): string {
    return this.activeStorageKey;
  }

  async init(): Promise<void> {
    await this.initializeStorage(STORAGE_KEY);
    if (this.isDestroyed) return;
    this.beforeUnloadFlushHandler = () => this.flushPendingSaveData();
    window.addEventListener('beforeunload', this.beforeUnloadFlushHandler);
    await this.loadAccountIsolationSetting();
    if (this.isDestroyed) return;
    await this.refreshAccountScope();
    await this.loadData();
    if (!this.isDestroyed) browser.storage.onChanged.addListener(this.storageChangeHandler);
  }

  destroy(): void {
    this.isDestroyed = true;
    this.flushPendingSaveData();
    this.dataSession?.deactivate();
    this.accountScopeRequest += 1;
    this.teardownConversationActivityTracking();
    browser.storage.onChanged.removeListener(this.storageChangeHandler);
    if (this.beforeUnloadFlushHandler)
      window.removeEventListener('beforeunload', this.beforeUnloadFlushHandler);
    this.beforeUnloadFlushHandler = null;
  }

  async setAccountIsolationEnabled(enabled: boolean): Promise<void> {
    if (this.isDestroyed || enabled === this.accountIsolationEnabled) return;
    this.accountIsolationEnabled = enabled;
    await this.refreshAccountScope();
    await this.loadData();
    if (this.options.getContext().enabled) this.options.onChange('data');
  }

  createFolder(name: string, parentId: string | null = null): Folder | null {
    if (parentId !== null && getFolderDepth(this.data, parentId) >= MAX_FOLDER_DEPTH) return null;
    const maxSortIndex = this.data.folders
      .filter((folder) => folder.parentId === parentId)
      .reduce((max, folder) => Math.max(max, folder.sortIndex ?? -1), -1);
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
    void this.saveData();
    this.options.onChange('data');
    return folder;
  }

  renameFolder(folderId: string, name: string): void {
    const folder = this.data.folders.find((item) => item.id === folderId);
    if (!folder) return;
    folder.name = name;
    folder.updatedAt = Date.now();
    void this.saveData();
    this.options.onChange('data');
  }

  removeFolder(folderId: string): void {
    this.data = removeFolder(this.data, folderId);
    void this.saveData();
    this.options.onChange('data');
  }

  removeConversationsFromFolder(folderId: string, ids: ReadonlySet<string>): void {
    const conversations = this.data.folderContents[folderId];
    if (!conversations) return;
    this.data.folderContents[folderId] = conversations.filter(
      (item) => !ids.has(item.conversationId),
    );
    void this.saveData();
    this.options.onChange('data');
  }

  async setFolderInstructions(
    folderId: string,
    instructions: string | undefined,
  ): Promise<boolean> {
    const folder = this.data.folders.find((item) => item.id === folderId);
    if (!folder) return false;
    folder.instructions = instructions;
    folder.updatedAt = Date.now();
    return this.saveData();
  }

  bufferTitleUpdate(conversation: ConversationReference, title: string): void {
    conversation.title = title;
    this.pendingTitleUpdates.set(conversation.conversationId, title);
  }

  flushTitleUpdates(): void {
    if (this.pendingTitleUpdates.size === 0) return;
    const session = this.dataSession;
    const activation = this.accountScopeRequest;
    void this.saveData()
      .then((saved) => {
        if (saved && this.dataSession === session && this.accountScopeRequest === activation)
          this.pendingTitleUpdates.clear();
      })
      .catch((error) =>
        console.error('[FolderStore] Failed to save pending title updates:', error),
      );
  }

  private debug(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.log('[FolderStore]', ...args);
    }
  }

  private debugWarn(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.warn('[FolderStore]', ...args);
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

  private initializeStorage(key: string): Promise<void> {
    const existing = this.storageInitializations.get(key);
    if (existing) return existing;
    // init() performs a best-effort migration that can write to storage. Run it
    // once per key so revisiting an account cannot race that account's save queue.
    const initialization = this.storage.init(key).catch((error) => {
      this.storageInitializations.delete(key);
      throw error;
    });
    this.storageInitializations.set(key, initialization);
    return initialization;
  }

  hasStoredConversations(): boolean {
    return Object.values(this.data.folderContents).some(
      (conversations) => conversations.length > 0,
    );
  }

  toggleFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.isExpanded = !folder.isExpanded;
    folder.updatedAt = Date.now();
    // Pure UI state — debounce the full persistence pipeline instead of
    // running stringify/verify/mirror/backup on every expand/collapse click.
    this.scheduleSaveData();
    this.options.onChange('data');
  }

  togglePinFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.pinned = !folder.pinned;
    folder.updatedAt = Date.now();
    this.saveData();
    this.options.onChange('data');
  }

  reorderFolder(folderId: string, targetParentId: string, insertIndex: number): void {
    const targetParent = targetParentId === '__root__' ? null : targetParentId;
    const nextData = moveFolder(this.data, folderId, targetParent, Date.now(), insertIndex);
    if (nextData === this.data) return;
    this.data = nextData;
    void this.saveData();
    this.options.onChange('data');
  }

  ensureConversationsInFolder(folderId: string, dragData: DragData): void {
    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    const convs = dragData.conversations ?? [];
    const items: {
      id: string;
      title: string;
      url?: string;
      isGem?: boolean;
      gemId?: string;
    }[] =
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
        lastTurnAt: this.getKnownConversationLastTurnAt(item.id, item.url),
        isGem: item.isGem,
        gemId: item.gemId,
        sortIndex: ++maxSortIndex,
      });
    }
  }

  private resolveDraggedConversationTitleForStorage(conversationId: string, title: string): string {
    const normalizedTitle = title.trim();
    if (normalizedTitle && normalizedTitle !== 'Untitled') return normalizedTitle;

    return syncConversationTitleFromNative(conversationId) || normalizedTitle || 'Untitled';
  }

  reorderOrMoveConversations(
    conversationIds: string[],
    sourceParentId: string,
    targetParentId: string,
    insertIndex: number,
  ): void {
    const nextData = reorderConversations(
      this.data,
      conversationIds,
      sourceParentId,
      targetParentId,
      insertIndex,
      this.options.getContext().sortMode,
    );
    if (nextData === this.data) return;
    this.data = nextData;
    void this.saveData();
    this.options.onChange('data');
  }

  addConversationToFolder(
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
      lastTurnAt: this.getKnownConversationLastTurnAt(conversationId, dragData.url),
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
    this.options.onChange('data');
    this.options.onArchive();
  }

  addConversationsToFolder(
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
          lastTurnAt:
            conv.lastTurnAt ?? this.getKnownConversationLastTurnAt(conv.conversationId, conv.url),
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
    this.options.onChange('data');
    // Trigger nudge only if at least one conversation was actually added from
    // outside. If the whole batch came from another folder (sourceFolderId set),
    // it's a folder→folder move and not a "first archive" event.
    if (addedCount > 0 && !sourceFolderId) {
      this.options.onArchive();
    }
  }

  addFolderToFolder(targetFolderId: string, dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to folder:', {
      draggedFolderId,
      targetFolderId,
    });

    const nextData = moveFolder(this.data, draggedFolderId, targetFolderId, Date.now());
    if (nextData === this.data) {
      this.debug('Folder move rejected');
      return;
    }
    this.data = nextData;
    void this.saveData();
    this.options.onChange('data');
  }

  moveFolderToRoot(dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to root level:', draggedFolderId);

    const nextData = moveFolder(this.data, draggedFolderId, null, Date.now());
    if (nextData === this.data) {
      this.debug('Folder move to root rejected');
      return;
    }
    this.data = nextData;
    void this.saveData();
    this.options.onChange('data');
  }

  toggleConversationStar(folderId: string, conversationId: string): void {
    const conversations = this.data.folderContents[folderId];
    if (!conversations) return;

    const conv = conversations.find((c) => c.conversationId === conversationId);
    if (!conv) return;

    // Toggle starred state
    conv.starred = !conv.starred;

    // Save data
    this.saveData();

    // Refresh the folder UI to update the star icon and re-sort
    this.options.onChange('data');

    this.debug('Toggled star for conversation:', conversationId, 'starred:', conv.starred);
  }

  setConversationStarAcrossFolders(conversationId: string, starred: boolean): void {
    let changed = false;
    Object.values(this.data.folderContents).forEach((conversations) => {
      conversations.forEach((conversation) => {
        if (!this.isSameConversation(conversationId, conversation)) return;
        if (conversation.starred === starred) return;
        conversation.starred = starred;
        changed = true;
      });
    });

    if (!changed) return;
    this.saveData();
    this.options.onChange('data');
  }

  removeConversationFromFolder(folderId: string, conversationId: string): void {
    if (!this.data.folderContents[folderId]) return;

    this.data.folderContents[folderId] = this.data.folderContents[folderId].filter(
      (c) => c.conversationId !== conversationId,
    );

    this.saveData();
    this.options.onChange('data');
  }

  changeFolderColor(folderId: string, colorId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.color = colorId;
    folder.updatedAt = Date.now();

    this.saveData();
    this.options.onChange('data');
  }

  moveConversationToFolder(
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
    this.options.onChange('data');
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
      // up by one. Time-based fallback alone is not enough — normalization
      // (called from saveData) will assign sortIndex 0 to the newest entry by
      // time and collide with any pre-existing sortIndex 0, after which JS's
      // stable sort drops the new entry below the old one.
      //
      // Normalize first so any nullish sortIndex on existing
      // entries gets a numeric value before the shift. Otherwise (sortIndex ?? 0)
      // would map both null entries and the existing 0 entry to 1.
      this.data = normalizeFolderData(this.data);
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
        lastTurnAt: lastTurnAt ?? this.getKnownConversationLastTurnAt(conversationId, url),
        isGem,
        gemId,
        sortIndex: 0,
      });
      addedNewConversation = true;
    }

    this.saveData();
    this.options.onChange('data');
    if (addedNewConversation) {
      this.options.onArchive();
    }
  }

  async ensureDataLoaded(): Promise<void> {
    if (this.data.folders.length === 0) {
      await this.loadData();
    }
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

  async syncConversationTitlesFromNative(): Promise<void> {
    if (this.nativeTitleSyncInProgress) return;
    if (!this.hasStoredConversations()) return;

    this.nativeTitleSyncInProgress = true;
    try {
      let updated = false;
      const conversations = getNativeConversationElements(this.options.getContext().sidebar);

      for (const convEl of Array.from(conversations)) {
        const element = convEl as HTMLElement;
        const conversationId =
          extractNativeConversationId(element) || extractConversationIdFromElement(element);
        const title = extractNativeConversationTitle(element);
        if (!conversationId || !title) continue;

        updated = this.applyConversationTitleUpdate(conversationId, title) || updated;
      }

      if (!updated) return;

      await this.saveData();
      this.options.onChange('title');
    } finally {
      this.nativeTitleSyncInProgress = false;
    }
  }

  updateConversationTitle(conversationId: string, newTitle: string): void {
    if (!this.applyConversationTitleUpdate(conversationId, newTitle)) return;

    void this.saveData();
    // Re-render folders to show updated title
    this.options.onChange('title');
  }

  async restoreNativeTitleSync(conversationId: string, nativeTitle: string | null): Promise<void> {
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
    this.options.onChange('title');
  }

  removeConversationFromAllFolders(conversationId: string): void {
    // Remove this conversation from all folders when the original conversation is deleted
    let removed = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      const initialLength = conversations.length;

      // Filter out the deleted conversation
      this.data.folderContents[folderId] = conversations.filter(
        (conv) => !this.isSameConversation(conversationId, conv),
      );

      if (this.data.folderContents[folderId].length < initialLength) {
        removed = true;
        this.debug(`Removed deleted conversation ${conversationId} from folder ${folderId}`);
      }
    }

    if (removed) {
      this.saveData();
      // Re-render folders to reflect the removal
      this.options.onChange('title');
    }
  }

  async loadData(): Promise<void> {
    const session = this.dataSession;
    if (!session) return;
    // A returning account may still own a queued edit that is newer than disk.
    if (session.saveInProgress && session.ready) return;
    const version = ++session.loadVersion;
    const isCurrent = () =>
      this.dataSession === session && session.loadVersion === version && !this.isDestroyed;
    try {
      // On Safari, restore recovery backups from the durable mirror before any
      // recoverFromBackup() can run (localStorage may have been ITP-evicted).
      await session.backup.ensureHydrated();
      if (!isCurrent()) return;

      let loadedData = await this.storage.loadData(session.storageKey);
      if (!isCurrent()) return;

      if (!loadedData && session.accountScope) {
        loadedData = await this.migrateLegacyFolderDataToScopedStorage(session, version);
        if (!isCurrent()) return;
      }

      if (loadedData && validateFolderData(loadedData)) {
        // Validate and repair data integrity
        this.data = normalizeFolderData(loadedData);

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
        session.backup.createPrimaryBackup(this.data);
        session.markReady();

        this.debug('Data loaded and validated successfully');
      } else if (loadedData) {
        // Data exists but validation failed - this is a real corruption case
        console.warn(
          '[FolderStore] Storage returned invalid data structure, attempting recovery from backup',
        );
        await this.attemptDataRecovery({ reason: 'corrupted', originalData: loadedData }, session);
      } else {
        // No data found - likely a first-time user
        console.log(
          '[FolderStore] No folder data found, initializing empty state (likely first-time user)',
        );
        this.data = { folders: [], folderContents: {} };
        session.markReady();
        // No notification needed - this is expected for new users
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('[FolderStore] Load data error:', error);

      // CRITICAL: Do NOT clear data on error - this causes data loss!
      // Instead, try to recover from backup or keep existing data
      await this.attemptDataRecovery(error, session);
    } finally {
      if (isCurrent() && session.ready) {
        this.options.onChange('loaded');
      }
    }
  }

  private filterLegacyFolderDataByCurrentAccount(
    data: FolderData,
    scope: AccountScope | null,
  ): FolderData {
    const routeUserId = scope?.routeUserId;
    if (!routeUserId) {
      return cloneFolderData(data);
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

      nextContents[folderId] = filtered.map((conversation) => ({
        ...conversation,
      }));
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

  private async migrateLegacyFolderDataToScopedStorage(
    session: FolderDataSession,
    version: number,
  ): Promise<FolderData | null> {
    try {
      const legacyData = await this.storage.loadData(STORAGE_KEY);
      if (
        this.dataSession !== session ||
        session.loadVersion !== version ||
        !legacyData ||
        !validateFolderData(legacyData)
      ) {
        return null;
      }

      const migratedData = normalizeFolderData(
        this.filterLegacyFolderDataByCurrentAccount(legacyData, session.accountScope),
      );
      session.data = migratedData;
      session.markReady();
      const saved = await this.persistDataSession(session, cloneFolderData(session.data));
      if (!saved) {
        console.warn('[FolderStore] Failed to persist scoped migration data');
      }
      this.debug(
        'Migrated legacy folder data to scoped storage:',
        session.storageKey,
        migratedData.folders.length,
      );
      return migratedData;
    } catch (error) {
      console.error('[FolderStore] Failed to migrate legacy folder data:', error);
      return null;
    }
  }

  private async attemptDataRecovery(error: unknown, session: FolderDataSession): Promise<void> {
    if (this.dataSession !== session) return;
    console.warn('[FolderStore] Attempting data recovery after load failure');

    // Step 1: Try to restore from localStorage backups (primary, emergency, beforeUnload)
    const recovered = session.backup.recoverFromBackup();
    if (recovered && validateFolderData(recovered)) {
      this.data = normalizeFolderData(recovered);
      session.markReady();
      console.warn('[FolderStore] Data recovered from localStorage backup');
      this.options.onRecovery('recovered');
      // Save recovered data to persistent storage
      await this.saveData();
      return; // Successfully recovered, no need to continue
    }

    // Step 2: If current this.data already has valid structure, keep it
    if (validateFolderData(this.data) && this.data.folders.length > 0) {
      console.warn('[FolderStore] Keeping existing in-memory data after load error');
      this.data = normalizeFolderData(this.data);
      session.markReady();
      return;
    }

    // Step 3: Last resort - initialize empty data and log critical error
    console.error('[FolderStore] CRITICAL: Unable to recover data, initializing empty state');
    console.error('[FolderStore] Original error:', error);
    this.data = { folders: [], folderContents: {} };
    session.markReady();

    // Show user notification about data loss
    this.options.onRecovery('lost');
  }

  scheduleSaveData(): void {
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.saveData();
    }, SAVE_DEBOUNCE_MS);
  }

  flushPendingSaveData(): void {
    if (this.saveDebounceTimer === null) return;
    window.clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = null;
    void this.saveData();
  }

  private armStorageEchoSuppression(): void {
    this.pendingStorageEchoes += 1;
    this.lastStorageEchoArmedAt = Date.now();
  }

  private consumeStorageEchoSuppression(): boolean {
    if (this.pendingStorageEchoes <= 0) return false;
    if (Date.now() - this.lastStorageEchoArmedAt > STORAGE_ECHO_SUPPRESS_WINDOW_MS) {
      this.pendingStorageEchoes = 0;
      return false;
    }
    this.pendingStorageEchoes -= 1;
    return true;
  }

  async saveData(): Promise<boolean> {
    const session = this.dataSession;
    if (!session || (!session.ready && session.accountScope)) return false;
    try {
      this.data = normalizeFolderData(this.data);
      const snapshot = cloneFolderData(session.data);
      // A mutation supersedes any storage read already in flight for this session.
      session.loadVersion += 1;
      session.markReady();
      session.backup.createEmergencyBackup(snapshot);
      if (session.saveInProgress) {
        session.pendingSave = snapshot;
        this.debug('Save already in progress, queueing one trailing save');
        return false;
      }

      return this.persistDataSession(session, snapshot);
    } catch (error) {
      console.error('[FolderStore] Save data error:', error);
      return false;
    }
  }

  private async persistDataSession(
    session: FolderDataSession,
    snapshot: FolderData,
  ): Promise<boolean> {
    this.dataSessions.set(session.storageKey, session);
    session.saveInProgress = true;
    let success = false;

    try {
      // Additional safety check: warn if saving empty data
      if (snapshot.folders.length === 0 && Object.keys(snapshot.folderContents).length === 0) {
        // Check if we're about to overwrite non-empty data
        const existingData = await this.storage.loadData(session.storageKey);
        if (
          existingData &&
          (existingData.folders.length > 0 || Object.keys(existingData.folderContents).length > 0)
        ) {
          console.warn(
            '[FolderStore] WARNING: Attempting to save empty data over existing non-empty data',
          );
          console.warn('[FolderStore] This may indicate a bug.');
          // Still proceed, but log it prominently
        }
      }

      // Save via storage adapter (handles both Safari and non-Safari).
      // Each write mirrors into chrome.storage.local and echoes back through
      // storage.onChanged in this same context — arm suppression so the echo
      // doesn't trigger a redundant full reload (see setupStorageListener).
      if (this.dataSession === session) this.armStorageEchoSuppression();
      success = await this.storage.saveData(session.storageKey, snapshot);

      // Retry once if the first attempt fails (for transient errors)
      if (!success) {
        console.warn('[FolderStore] Save failed, retrying once...');
        if (this.dataSession === session) this.armStorageEchoSuppression();
        success = await this.storage.saveData(session.storageKey, snapshot);
      }

      if (success) {
        // Create primary backup AFTER successful save
        session.backup.createPrimaryBackup(snapshot);
        this.debug('Data saved successfully');
        // Centralised floating-panel sync. Any code path that persists folder
        // data (sidebar actions, cloud download, native menu → "Move to
        // folder", etc.) ends up here, so one hook keeps the floating view
        // live without every call site having to remember.
        if (this.dataSession === session && !this.isDestroyed) {
          this.options.onChange('saved');
        }
      } else {
        console.error('[FolderStore] Save failed after retry');
      }
    } catch (error) {
      console.error('[FolderStore] Save data error:', error);
      success = false;
    } finally {
      session.saveInProgress = false;
      const pending = session.pendingSave;
      session.pendingSave = null;
      if (pending) {
        void this.persistDataSession(session, pending);
      } else if (this.dataSession !== session) {
        this.dataSessions.delete(session.storageKey);
      }
    }

    return success;
  }

  private async loadAccountIsolationSetting(): Promise<void> {
    try {
      this.accountIsolationEnabled = await accountIsolationService.isIsolationEnabled({
        platform: 'gemini',
        pageUrl: window.location.href,
      });
      this.debug('Loaded account isolation setting:', this.accountIsolationEnabled);
    } catch (error) {
      console.error('[FolderStore] Failed to load account isolation setting:', error);
      this.accountIsolationEnabled = false;
    }
  }

  async refreshAccountScope(): Promise<void> {
    const request = ++this.accountScopeRequest;
    const previous = this.dataSession;
    // Flush the old account's pending debounce before releasing its data owner.
    this.flushPendingSaveData();
    previous?.deactivate();
    if (previous && !previous.saveInProgress) this.dataSessions.delete(previous.storageKey);
    this.dataSession = null;
    this.unresolvedData = { folders: [], folderContents: {} };
    this.accountScope = null;
    this.activeStorageKey = '';
    this.pendingStorageEchoes = 0;
    this.pendingTitleUpdates.clear();
    this.options.onChange('account');
    try {
      let resolvedScope: AccountScope | null = null;
      if (this.accountIsolationEnabled) {
        const context = detectAccountContextFromDocument(window.location.href, document);
        resolvedScope = await accountIsolationService.resolveAccountScope({
          pageUrl: window.location.href,
          routeUserId: context.routeUserId,
          email: context.email,
        });
      }
      if (request !== this.accountScopeRequest || this.isDestroyed) return;
      const storageKey = resolvedScope
        ? buildScopedFolderStorageKey(resolvedScope.accountKey)
        : STORAGE_KEY;
      await this.initializeStorage(storageKey);
      if (request !== this.accountScopeRequest || this.isDestroyed) return;
      const session =
        this.dataSessions.get(storageKey) ??
        (previous?.storageKey === storageKey
          ? previous
          : new FolderDataSession(storageKey, 'gemini-folders', resolvedScope, validateFolderData));
      this.dataSessions.set(storageKey, session);
      session.accountScope = resolvedScope;
      this.dataSession = session;
      this.accountScope = resolvedScope;
      this.activeStorageKey = storageKey;
      session.activate();
      if (session.ready) {
        this.options.onChange('title');
        this.options.onChange('loaded');
      }
    } catch (error) {
      console.error('[FolderStore] Failed to resolve account scope:', error);
      // Keep persistence unbound on failure. A global fallback has no known owner.
    }
  }

  initializeConversationActivityTracking(): Promise<void> {
    if (this.activityTimestampUnsubscribe || this.activitySendIntentHandler) {
      return Promise.resolve();
    }
    if (this.activityTrackingPromise) return this.activityTrackingPromise;

    this.activityTrackingPromise = (async () => {
      try {
        if (!this.activityTimestampService) {
          this.activityTimestampService = new TimestampService();
          await this.activityTimestampService.initialize();
        }
        await historyTimestampStore.start();
        if (this.isDestroyed || !this.options.getContext().enabled) return;

        this.backfillKnownConversationActivity();
        this.activityTimestampUnsubscribe = historyTimestampStore.subscribe((cids) => {
          if (this.isDestroyed || !this.options.getContext().enabled) return;
          this.applyHistoryActivityTimestamps(cids);
        });

        this.activitySendIntentHandler = (event) => {
          if (!this.isConversationSendIntent(event)) return;
          const conversationId = getCurrentConversationId();
          if (!conversationId || !this.isConversationInFolders(conversationId)) return;

          const sentAt = Date.now();
          window.setTimeout(() => {
            if (this.isDestroyed || !this.options.getContext().enabled || event.defaultPrevented)
              return;
            this.markConversationLastTurnAt(conversationId, sentAt);
          }, 0);
        };
        document.addEventListener('click', this.activitySendIntentHandler, true);
        document.addEventListener('submit', this.activitySendIntentHandler, true);
      } catch (error) {
        if (!isExtensionContextInvalidatedError(error)) {
          this.debugWarn('Failed to initialize conversation activity tracking:', error);
        }
      }
    })().finally(() => {
      this.activityTrackingPromise = null;
    });

    return this.activityTrackingPromise;
  }

  teardownConversationActivityTracking(): void {
    this.activityTimestampUnsubscribe?.();
    this.activityTimestampUnsubscribe = null;

    if (this.activitySendIntentHandler) {
      document.removeEventListener('click', this.activitySendIntentHandler, true);
      document.removeEventListener('submit', this.activitySendIntentHandler, true);
      this.activitySendIntentHandler = null;
    }
  }

  private isConversationSendIntent(event: Event): boolean {
    if (event.type === 'submit') {
      const form = event.target;
      return (
        form instanceof HTMLFormElement &&
        form.querySelector(ACTIVITY_COMPOSER_INPUT_SELECTOR) !== null
      );
    }

    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest(ACTIVITY_SEND_BUTTON_SELECTOR);
    if (!(button instanceof HTMLElement)) return false;
    if (
      button instanceof HTMLButtonElement &&
      (button.disabled || button.getAttribute('aria-disabled') === 'true')
    ) {
      return false;
    }

    const composer = button.closest(
      'form, .text-input-field, input-area-v2, input-container, ms-prompt-input-wrapper',
    );
    return composer?.querySelector(ACTIVITY_COMPOSER_INPUT_SELECTOR) !== null;
  }

  getKnownConversationLastTurnAt(conversationId: string, url?: string): number | undefined {
    const nativeConversationId = normalizeConversationId(conversationId);
    if (!nativeConversationId) return undefined;

    const serverTimestamp =
      historyTimestampStore.getLatestTurnTimestamp(nativeConversationId) ?? undefined;
    const stableConversationId = buildConversationIdFromUrl(
      url || `https://gemini.google.com/app/${nativeConversationId}`,
    );
    const storedTimestamp =
      this.activityTimestampService?.getLatestTimestampForConversation(stableConversationId) ??
      undefined;
    const latest = Math.max(serverTimestamp ?? 0, storedTimestamp ?? 0);
    return latest > 0 ? latest : undefined;
  }

  backfillKnownConversationActivity(): void {
    let changed = false;
    Object.values(this.data.folderContents).forEach((conversations) => {
      conversations.forEach((conversation) => {
        const timestamp = this.getKnownConversationLastTurnAt(
          conversation.conversationId,
          conversation.url,
        );
        if (!timestamp || timestamp <= (conversation.lastTurnAt ?? 0)) return;
        conversation.lastTurnAt = timestamp;
        changed = true;
      });
    });

    if (!changed) return;
    this.scheduleSaveData();
    this.options.onChange('activity');
  }

  applyHistoryActivityTimestamps(cids: string[]): void {
    const latestByConversationId = new Map<string, number>();
    cids.forEach((cid) => {
      const nativeConversationId = normalizeConversationId(cid);
      if (!nativeConversationId) return;
      const latest = historyTimestampStore.getLatestTurnTimestamp(nativeConversationId);
      if (latest) latestByConversationId.set(nativeConversationId, latest);
    });
    if (latestByConversationId.size === 0) return;

    let changed = false;
    Object.values(this.data.folderContents).forEach((conversations) => {
      conversations.forEach((conversation) => {
        const nativeConversationId = normalizeConversationId(conversation.conversationId);
        const latest = nativeConversationId
          ? latestByConversationId.get(nativeConversationId)
          : undefined;
        if (!latest || latest <= (conversation.lastTurnAt ?? 0)) return;
        conversation.lastTurnAt = latest;
        changed = true;
      });
    });

    if (!changed) return;
    this.scheduleSaveData();
    this.options.onChange('activity');
  }

  markConversationLastTurnAt(conversationId: string, timestamp: number): void {
    let changed = false;
    Object.values(this.data.folderContents).forEach((conversations) => {
      conversations.forEach((conversation) => {
        if (!this.isSameConversation(conversationId, conversation)) return;
        if (timestamp <= (conversation.lastTurnAt ?? 0)) return;
        conversation.lastTurnAt = timestamp;
        changed = true;
      });
    });

    if (!changed) return;
    this.scheduleSaveData();
    this.options.onChange('activity');
  }

  async reloadFoldersFromStorage(): Promise<void> {
    try {
      await this.loadData();
      this.backfillKnownConversationActivity();
      this.options.onChange('title');
      this.debug('Folders reloaded from storage');
    } catch (error) {
      console.error('[FolderStore] Failed to reload folders:', error);
    }
  }

  isConversationInFolders(conversationId: string): boolean {
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

  private isSameConversation(targetId: string, conversation: ConversationReference): boolean {
    const normalizedTarget = normalizeConversationId(targetId);
    if (!normalizedTarget) return false;

    if (normalizeConversationId(conversation.conversationId) === normalizedTarget) return true;

    return (
      resolveConversationRouteId(conversation.url, conversation.conversationId) === normalizedTarget
    );
  }

  markConversationAsRecentlyOpened(conversationId: string): void {
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

  updateConversationGem(hexId: string, gemId: string): void {
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
      this.options.onChange('title');
    }
  }

  private getUserIdFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/^\/u\/(\d+)\//);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async reloadScopedDataOnAccountRouteChange(): Promise<void> {
    if (!this.accountIsolationEnabled) return;

    const routeUserId = extractRouteUserIdFromPath(window.location.pathname);
    if (routeUserId === this.accountScope?.routeUserId) return;

    const previousStorageKey = this.activeStorageKey;
    await this.refreshAccountScope();
    if (this.activeStorageKey === previousStorageKey) return;

    await this.loadData();
    this.backfillKnownConversationActivity();
    this.options.onChange('title');
    this.debug('Switched account-scoped folder storage:', this.activeStorageKey);
  }
}
