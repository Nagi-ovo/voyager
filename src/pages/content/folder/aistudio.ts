import browser, { type Runtime } from 'webextension-polyfill';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedStorageKey,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';
import { StorageKeys } from '@/core/types/common';
import type { PromptItem, SyncAccountScope } from '@/core/types/sync';
import { isSafari } from '@/core/utils/browser';
import { createTranslator, initI18n } from '@/utils/i18n';
import {
  mergeFolderData as mergeSyncedFolderData,
  mergePrompts as mergeSyncedPrompts,
} from '@/utils/merge';

import { watchRouteChanges } from '../utils/routeWatcher';
import {
  mountHideArchivedNudge,
  shouldShowHideArchivedNudge,
  unmountHideArchivedNudge,
} from './hideArchivedNudge';
import type { ConversationReference, DragData, Folder, FolderData } from './types';

function waitForElement<T extends Element = Element>(
  selector: string,
  timeoutMs = 10000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const found = document.querySelector(selector) as T | null;
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector) as T | null;
      if (el) {
        try {
          obs.disconnect();
        } catch {}
        resolve(el);
      }
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {}
    if (timeoutMs > 0) {
      setTimeout(() => {
        try {
          obs.disconnect();
        } catch {}
        resolve(null);
      }, timeoutMs);
    }
  });
}

function normalizeText(text: string | null | undefined): string {
  try {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
    } catch {}
    URL.revokeObjectURL(url);
  }, 0);
}

function now(): number {
  return Date.now();
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const NOTIFICATION_TIMEOUT_MS = 5000;
const PROMPT_LINK_SELECTORS = [
  'a[href^="/prompts/"]',
  'a[href^="/u/"][href*="/prompts/"]',
  'a[href*="://aistudio.google.com/prompts/"]',
  'a[href*="://aistudio.google.com/u/"][href*="/prompts/"]',
  'a[href*="://aistudio.google.cn/prompts/"]',
  'a[href*="://aistudio.google.cn/u/"][href*="/prompts/"]',
];
const PROMPT_LINK_SELECTOR = PROMPT_LINK_SELECTORS.join(', ');
const UNBOUND_PROMPT_LINK_SELECTOR = PROMPT_LINK_SELECTORS.map(
  (selector) => `${selector}:not([data-gv-drag-bound])`,
).join(', ');
const BODY_PROMPT_POPOVER_SELECTOR = [
  '.cdk-overlay-container',
  '.cdk-overlay-pane',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
].join(', ');
const PROMPT_LIST_BIND_DEBOUNCE_MS = 120;
const PROMPT_TITLE_SYNC_DEBOUNCE_MS = 280;
// If no dragover arrives for this long while the floating library drop zone is
// visible, treat the drag as over (e.g. the source row was torn out of the DOM by an
// Angular refresh, so dragend never fires) and hide the zone.
const LIBRARY_DRAG_HEARTBEAT_MS = 800;
const PROMPT_DRAG_HOST_SELECTORS = [
  '[data-test-id^="history-item"]',
  '[role="listitem"]',
  '.mat-mdc-list-item',
  'li',
];

type LibraryPromptData = DragData & { conversationId: string };

type InlineFolderEditor = {
  wrapper: HTMLElement;
  input: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
};

function nodeContainsPromptLink(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.matches(PROMPT_LINK_SELECTOR)) return true;
  return !!node.querySelector(PROMPT_LINK_SELECTOR);
}

export function mutationAddsPromptLinks(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    for (const node of Array.from(mutation.addedNodes)) {
      if (nodeContainsPromptLink(node)) return true;
    }
  }
  return false;
}

function mutationMayAffectPromptTitles(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    if (mutation.type === 'characterData') {
      if (mutation.target.parentElement?.closest(PROMPT_LINK_SELECTOR)) return true;
      continue;
    }

    if (mutation.type === 'attributes') {
      if (mutation.target instanceof Element && mutation.target.closest(PROMPT_LINK_SELECTOR))
        return true;
      continue;
    }

    if (mutation.type === 'childList') {
      if (mutation.target instanceof Element && mutation.target.closest(PROMPT_LINK_SELECTOR)) {
        return true;
      }

      for (const node of Array.from(mutation.addedNodes)) {
        if (nodeContainsPromptLink(node)) return true;
      }
      for (const node of Array.from(mutation.removedNodes)) {
        if (nodeContainsPromptLink(node)) return true;
      }
    }
  }
  return false;
}

function extractPromptIdFromHref(rawHref: string): string | null {
  const href = String(rawHref || '').trim();
  if (!href) return null;
  const match = href.match(/\/prompts\/([^/?#]+)/);
  if (match && match[1]) return match[1];
  try {
    const url = new URL(href, location.origin);
    const pathMatch = url.pathname.match(/\/prompts\/([^/?#]+)/);
    return pathMatch?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeDroppedUrl(raw: string): string | null {
  const firstLine = String(raw || '')
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!firstLine) return null;
  if (/^https?:\/\//i.test(firstLine)) return firstLine;
  if (firstLine.startsWith('/')) return `${location.origin}${firstLine}`;
  return null;
}

export function parseDragDataPayload(raw: string): DragData | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { type?: unknown }).type === 'conversation' &&
      typeof (parsed as { conversationId?: unknown }).conversationId === 'string'
    ) {
      const data = parsed as DragData;
      return {
        type: 'conversation',
        conversationId: data.conversationId,
        title: typeof data.title === 'string' ? data.title : '',
        url: typeof data.url === 'string' ? data.url : '',
      };
    }
  } catch {}

  const normalizedUrl = normalizeDroppedUrl(trimmed);
  if (!normalizedUrl) return null;
  const conversationId = extractPromptIdFromHref(normalizedUrl);
  if (!conversationId) return null;

  return {
    type: 'conversation',
    conversationId,
    title: '',
    url: normalizedUrl,
  };
}

/**
 * Validate folder data structure
 */
function validateFolderData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.folders) && typeof d.folderContents === 'object';
}

export class AIStudioFolderManager {
  private t: (key: string) => string = (k) => k;
  private data: FolderData = { folders: [], folderContents: {} };
  private container: HTMLElement | null = null;
  private historyRoot: HTMLElement | null = null;
  private cleanupFns: Array<() => void> = [];
  private promptListBindTimer: number | null = null;
  private promptTitleSyncTimer: number | null = null;
  private promptTitleSyncInProgress: boolean = false;
  private selectedLibraryPrompts: Set<string> = new Set();
  private isLibraryMultiSelectMode: boolean = false;
  private libraryOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private libraryMultiSelectHostElement: HTMLElement | null = null;
  private libraryBatchDeleteInProgress: boolean = false;
  private libraryBatchDeleteProgressElement: HTMLElement | null = null;
  private readonly STORAGE_KEY = StorageKeys.FOLDER_DATA_AISTUDIO;
  private folderEnabled: boolean = true; // Whether folder feature is enabled
  private hideArchivedEnabled: boolean = false; // AI Studio-scoped — hide filed convs in /library table
  private hideArchivedNudgeShown: boolean = false; // AI Studio-scoped — nudge dismissed/enabled before
  private accountIsolationEnabled: boolean = false; // Whether hard account isolation is enabled
  private accountScope: AccountScope | null = null; // Resolved account scope for current account
  private activeStorageKey: string = StorageKeys.FOLDER_DATA_AISTUDIO; // Active folder data key
  private accountContextPoller: number | null = null; // Detect account switches
  private lastAccountContextFingerprint: string | null = null; // Debounce account scope refresh
  private stopRouteWatcher: (() => void) | null = null;
  private backupService!: DataBackupService<FolderData>; // Initialized in init()
  private sidebarWidth: number = 360; // Default sidebar width (increased to reduce text truncation)
  private readonly SIDEBAR_WIDTH_KEY = 'gvAIStudioSidebarWidth';
  private readonly MIN_SIDEBAR_WIDTH = 240;
  private readonly MAX_SIDEBAR_WIDTH = 600;
  private readonly UNCATEGORIZED_KEY = '__uncategorized__'; // Special key for root-level conversations
  private readonly LIBRARY_LONG_PRESS_MS = 500;
  private readonly MAX_LIBRARY_BATCH_DELETE_COUNT = 50;
  private readonly LIBRARY_BATCH_DELETE_CONFIG = {
    DELAY_BETWEEN_DELETIONS: 500,
    MENU_APPEAR_DELAY: 300,
    DIALOG_APPEAR_DELAY: 300,
    DELETION_COMPLETE_DELAY: 500,
    MAX_BUTTON_WAIT_TIME: 3000,
    BUTTON_CHECK_INTERVAL: 100,
    PAGE_REFRESH_DELAY: 1500,
  } as const;

  // Helper to create a ligature icon span with a data-icon attribute
  private createIcon(name: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'google-symbols';
    try {
      span.dataset.icon = name;
    } catch {}
    span.textContent = name;
    return span;
  }

  private createInlineMaterialIcon(name: string): HTMLElement {
    const icon = document.createElement('mat-icon');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
    icon.textContent = name;
    return icon;
  }

  private createMenuItem(
    label: string,
    iconName: string,
    action: () => void,
    options: { danger?: boolean } = {},
  ): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `gv-folder-menu-item${options.danger ? ' gv-folder-menu-item-danger' : ''}`;
    item.appendChild(this.createInlineMaterialIcon(iconName));
    item.append(document.createTextNode(label));
    item.addEventListener('click', action);
    return item;
  }

  private createInlineFolderEditor(
    wrapperTag: 'div' | 'span',
    wrapperClassName: string,
    inputClassName: string,
    inputOptions: { placeholder?: string; value?: string } = {},
  ): InlineFolderEditor {
    const wrapper = document.createElement(wrapperTag);
    wrapper.className = wrapperClassName;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = inputClassName;
    input.maxLength = 50;
    if (inputOptions.placeholder) input.placeholder = inputOptions.placeholder;
    if (inputOptions.value) input.value = inputOptions.value;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
    saveBtn.title = this.t('pm_save');
    saveBtn.appendChild(this.createInlineMaterialIcon('check'));

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancelBtn.title = this.t('pm_cancel');
    cancelBtn.appendChild(this.createInlineMaterialIcon('close'));

    wrapper.appendChild(input);
    wrapper.appendChild(saveBtn);
    wrapper.appendChild(cancelBtn);

    return { wrapper, input, saveBtn, cancelBtn };
  }

  private showFolderConfirm(
    anchor: HTMLElement | null | undefined,
    message: string,
    actionLabel: string,
    onConfirm: () => void,
    alignRight = false,
  ): void {
    document.querySelector('.gv-folder-confirm-dialog.gv-aistudio-confirm')?.remove();

    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-confirm-dialog gv-aistudio-confirm';

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      dialog.style.position = 'fixed';
      dialog.style.top = `${rect.bottom + 4}px`;
      dialog.style.left = `${Math.max(10, alignRight ? rect.right - 200 : rect.left + 24)}px`;
      dialog.style.zIndex = '2147483647';
    }

    const msg = document.createElement('div');
    msg.className = 'gv-confirm-message';
    msg.textContent = message;
    dialog.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'gv-confirm-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'gv-confirm-btn gv-confirm-delete';
    confirmBtn.textContent = actionLabel;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gv-confirm-btn gv-confirm-cancel';
    cancelBtn.textContent = this.t('pm_cancel');

    let closeOnOutside: ((e: MouseEvent) => void) | null = null;
    const cleanup = () => {
      if (closeOnOutside) {
        document.removeEventListener('click', closeOnOutside);
        closeOnOutside = null;
      }
      dialog.remove();
    };

    confirmBtn.addEventListener('click', () => {
      onConfirm();
      cleanup();
    });
    cancelBtn.addEventListener('click', cleanup);

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    dialog.appendChild(actions);
    document.body.appendChild(dialog);

    setTimeout(() => {
      if (!dialog.isConnected) return;
      closeOnOutside = (e: MouseEvent) => {
        if (!dialog.contains(e.target as Node)) cleanup();
      };
      document.addEventListener('click', closeOnOutside);
    }, 0);
  }

  async init(): Promise<void> {
    await initI18n();
    this.t = createTranslator();

    // Initialize backup service
    this.backupService = new DataBackupService<FolderData>('aistudio-folders', validateFolderData);

    // Setup automatic backup before page unload
    this.backupService.setupBeforeUnloadBackup(() => this.data);

    // Migrate data from chrome.storage.sync to chrome.storage.local (one-time)
    await this.migrateFromSyncToLocal();

    // Only enable on prompts, library, or root pages
    // Root path (/) is where the main playground is, prompts are saved chats, library is history
    const isValidPath =
      /^\/(prompts|library)(\/|$)/.test(location.pathname) || location.pathname === '/';
    if (!isValidPath) return;

    // Load folder enabled setting
    await this.loadFolderEnabledSetting();
    await this.loadHideArchivedSettings();

    // Load account isolation setting/scope before reading folder data.
    await this.loadAccountIsolationSetting();
    await this.refreshAccountScope(true);

    // Load sidebar width setting
    await this.loadSidebarWidth();

    // Set up storage change listener (always needed to respond to setting changes)
    this.setupStorageListener();

    // Keep account-scoped data aligned with current AI Studio account.
    this.setupAccountContextPoller();

    // Setup message listener for sync operations (always needed)
    this.setupMessageListener();

    // If folder feature is disabled, skip initialization
    if (!this.folderEnabled) {
      return;
    }

    // Initialize folder UI
    await this.initializeFolderUI();
  }

  /**
   * Migrate folder data from chrome.storage.sync to chrome.storage.local
   * This is a one-time migration for users upgrading from older versions
   * Benefits: No 100KB quota limit, consistent with Gemini storage
   */
  private async migrateFromSyncToLocal(): Promise<void> {
    try {
      // Check if there's data in chrome.storage.sync
      const syncResult = await chrome.storage.sync.get(this.STORAGE_KEY);
      const syncData = syncResult[this.STORAGE_KEY];

      if (syncData && validateFolderData(syncData)) {
        // Check if chrome.storage.local already has data
        const localResult = await chrome.storage.local.get(this.STORAGE_KEY);
        const localData = localResult[this.STORAGE_KEY];

        if (!localData || !validateFolderData(localData)) {
          // Migrate sync data to local storage
          await chrome.storage.local.set({ [this.STORAGE_KEY]: syncData });
          console.log('[AIStudioFolderManager] Migrated folder data from sync to local storage');

          // Optionally clear sync storage after successful migration
          // await chrome.storage.sync.remove(this.STORAGE_KEY);
        } else {
          // Both have data - merge them (local takes priority for conflicts)
          const mergedFolders = this.mergeFolderData(
            localData as FolderData,
            syncData as FolderData,
          );
          await chrome.storage.local.set({ [this.STORAGE_KEY]: mergedFolders });
          console.log('[AIStudioFolderManager] Merged sync and local folder data');
        }
      }
    } catch (error) {
      console.warn('[AIStudioFolderManager] Migration from sync to local failed:', error);
      // Don't throw - migration failure should not block normal operation
    }
  }

  /**
   * Simple merge of folder data (used during migration)
   * Local data takes priority for conflicts
   */
  private mergeFolderData(local: FolderData, sync: FolderData): FolderData {
    const mergedFolders = [...local.folders];
    const localFolderIds = new Set(local.folders.map((f) => f.id));

    // Add folders from sync that don't exist in local
    for (const folder of sync.folders) {
      if (!localFolderIds.has(folder.id)) {
        mergedFolders.push(folder);
      }
    }

    // Merge folder contents
    const mergedContents = { ...local.folderContents };
    for (const [folderId, conversations] of Object.entries(sync.folderContents)) {
      if (!mergedContents[folderId]) {
        mergedContents[folderId] = conversations;
      } else {
        // Merge conversations, avoiding duplicates
        const existingIds = new Set(mergedContents[folderId].map((c) => c.conversationId));
        for (const conv of conversations) {
          if (!existingIds.has(conv.conversationId)) {
            mergedContents[folderId].push(conv);
          }
        }
      }
    }

    return { folders: mergedFolders, folderContents: mergedContents };
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

  private async migrateLegacyFolderDataToScopedStorage(): Promise<FolderData | null> {
    try {
      const legacyResult = await chrome.storage.local.get(this.STORAGE_KEY);
      const legacyData = legacyResult[this.STORAGE_KEY];
      if (!legacyData || !validateFolderData(legacyData)) {
        return null;
      }

      const migratedData = this.cloneFolderData(legacyData as FolderData);
      await chrome.storage.local.set({ [this.activeStorageKey]: migratedData });
      console.log(
        '[AIStudioFolderManager] Migrated legacy AI Studio folder data to scoped storage:',
        this.activeStorageKey,
      );
      return migratedData;
    } catch (error) {
      console.warn(
        '[AIStudioFolderManager] Failed to migrate scoped AI Studio folder data:',
        error,
      );
      return null;
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

  private buildAccountContextFingerprint(routeUserId: string | null, email: string | null): string {
    return `${routeUserId || ''}::${email || ''}`;
  }

  private async loadAccountIsolationSetting(): Promise<void> {
    try {
      this.accountIsolationEnabled = await accountIsolationService.isIsolationEnabled({
        platform: 'aistudio',
        pageUrl: window.location.href,
      });
      console.log(
        '[AIStudioFolderManager] Loaded account isolation setting:',
        this.accountIsolationEnabled,
      );
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to load account isolation setting:', error);
      this.accountIsolationEnabled = false;
    }
  }

  private async refreshAccountScope(force: boolean = false): Promise<boolean> {
    if (!this.accountIsolationEnabled) {
      const changed = this.activeStorageKey !== this.STORAGE_KEY;
      this.accountScope = null;
      this.activeStorageKey = this.STORAGE_KEY;
      this.lastAccountContextFingerprint = null;
      return changed;
    }

    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      const fingerprint = this.buildAccountContextFingerprint(context.routeUserId, context.email);
      if (!force && fingerprint === this.lastAccountContextFingerprint) {
        return false;
      }
      this.lastAccountContextFingerprint = fingerprint;

      const resolvedScope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });
      this.accountScope = resolvedScope;

      const nextStorageKey = buildScopedStorageKey(this.STORAGE_KEY, resolvedScope.accountKey);
      const changed = nextStorageKey !== this.activeStorageKey;
      this.activeStorageKey = nextStorageKey;
      return changed;
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to resolve account scope:', error);
      const changed = this.activeStorageKey !== this.STORAGE_KEY;
      this.accountScope = null;
      this.activeStorageKey = this.STORAGE_KEY;
      return changed;
    }
  }

  private async handleAccountIsolationToggle(enabled: boolean): Promise<void> {
    if (enabled === this.accountIsolationEnabled) return;

    this.accountIsolationEnabled = enabled;
    await this.refreshAccountScope(true);
    await this.load();
    if (this.folderEnabled && this.container) {
      this.render();
    }
  }

  private setupAccountContextPoller(): void {
    if (this.accountContextPoller) {
      clearInterval(this.accountContextPoller);
      this.accountContextPoller = null;
    }

    this.accountContextPoller = window.setInterval(() => {
      void this.refreshScopedDataOnAccountContextChange();
    }, 1200);
    // No cleanupFns registration: destroy() clears this.accountContextPoller directly,
    // so repeated setup calls cannot grow the cleanup list.
  }

  private async refreshScopedDataOnAccountContextChange(): Promise<void> {
    if (!this.accountIsolationEnabled) return;
    const changed = await this.refreshAccountScope(false);
    if (!changed) return;

    await this.load();
    if (this.folderEnabled && this.container) {
      this.render();
    }
    console.log(
      '[AIStudioFolderManager] Switched account-scoped folder storage:',
      this.activeStorageKey,
    );
  }

  /**
   * Setup message listener for sync operations
   * Handles gv.sync.requestData and gv.folders.reload messages from popup
   */
  private setupMessageListener(): void {
    const listener = (
      message: unknown,
      _sender: Runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): true | undefined => {
      const msg = message as Record<string, unknown>;
      // Handle request for folder data (for cloud sync upload)
      if (msg?.type === 'gv.sync.requestData') {
        console.log('[AIStudioFolderManager] Received request for folder data from popup');
        sendResponse({
          ok: true,
          data: this.data,
          accountScope: this.toSyncAccountScope(this.accountScope),
        });
        return true;
      }

      // Handle reload request (after cloud sync download)
      if (msg?.type === 'gv.folders.reload') {
        console.log('[AIStudioFolderManager] Received reload request from sync');
        this.load().then(() => {
          this.render();
          console.log('[AIStudioFolderManager] Folder data reloaded from sync');
        });
        sendResponse({ ok: true });
        return true;
      }

      // Unknown message: return undefined so the sender's promise settles immediately.
      // Returning true here would declare an async response that never arrives, leaving
      // senders (e.g. background broadcasts awaiting chrome.tabs.sendMessage) hanging.
      return undefined;
    };
    // The polyfill's OnMessageListener typing cannot express "sync-respond to some
    // messages, ignore the rest" (its callback variant requires a constant `true`
    // return). Runtime behavior is well-defined for both values, so cast: `true`
    // keeps the channel open for handled messages, `undefined` closes it for
    // unknown ones.
    browser.runtime.onMessage.addListener(listener as Runtime.OnMessageListenerCallback);
  }

  private async initializeFolderUI(): Promise<void> {
    const isLibraryPage = /\/library(\/|$)/.test(location.pathname);

    // Wait for a *stable* insertion anchor rather than just the outer nav-content.
    // Angular renders the shell first and fills in children asynchronously; waiting only on
    // the shell caused intermittent mis-mounts where the anchor wasn't there yet and we
    // fell through to an awkward appendChild position (or appeared to "never mount" at all).
    const anchorSelector = [
      'ms-prompt-history-v3',
      '.nav-content.v3-left-nav > nav > .empty-space',
      '.nav-content.v3-left-nav > nav > .bottom-actions',
    ].join(', ');
    const mountSignal = await waitForElement<HTMLElement>(anchorSelector);

    this.historyRoot =
      (document.querySelector('ms-prompt-history-v3') as HTMLElement | null) ?? null;

    if (!mountSignal) return;

    try {
      document.documentElement.classList.add('gv-aistudio-root');
    } catch {}

    await this.load();

    // Inject the sidebar folder panel anywhere a mount anchor exists — including /library.
    // Previously /library skipped the sidebar because legacy AI Studio had no place to mount
    // it there; the V2 nav has `.empty-space`/`.bottom-actions` on every page, so users
    // should see their folders while triaging the history table.
    this.injectUI();

    // Self-heal: Angular can tear down and rebuild the nav on route transitions, which
    // silently detaches our container. Watch the nav root and re-inject on detach.
    this.watchContainerMount();

    // Observers that read prompt-link anchors only run when the legacy history panel is present.
    if (this.historyRoot) {
      this.observePromptList();
      this.bindDraggablesInPromptList();
      await this.syncConversationTitlesFromPromptList();
    }

    // V2 nav renders History recents in a body-level hover popover rather than
    // inline ms-prompt-history-v3 rows. Bind those transient links as they appear.
    this.observeBodyPromptPopovers();

    // These work off our own folder DOM + location, so they run in both legacy and V2 nav.
    this.highlightActiveConversation();
    this.installRouteChangeListener();

    // Apply initial sidebar width (force on first load)
    this.applySidebarWidth(true);

    // Add resize handle for sidebar width adjustment
    this.addResizeHandle();

    // On library page, also bind the table rows as drag sources and surface the floating
    // drop zone (belt-and-suspenders alongside the sidebar panel).
    if (isLibraryPage) {
      this.observeLibraryTable();
      this.bindDraggablesInLibraryTable();
      this.injectLibraryDropZone();
    }
  }

  private containerMountObserver: MutationObserver | null = null;
  private lastContainerReinjectAt: number = 0;
  private libraryShortcutBtn: HTMLButtonElement | null = null;
  private libraryTableObserver: MutationObserver | null = null;
  private bodyPromptPopoverObserver: MutationObserver | null = null;
  private libraryDropZoneInjected: boolean = false;

  /**
   * Watches the AI Studio left nav for Angular tear-downs that would silently detach
   * our folder panel, and re-injects it. Cheap reconciliation: each mutation just checks
   * whether `this.container` is still in the document, throttled to avoid flapping.
   */
  private watchContainerMount(): void {
    try {
      this.containerMountObserver?.disconnect();
    } catch {}
    this.containerMountObserver = null;

    const navContent = document.querySelector('.nav-content.v3-left-nav');
    if (!navContent) return;

    const observer = new MutationObserver(() => {
      const container = this.container;
      if (!container) return;
      if (document.body.contains(container)) return;

      // Throttle re-injection — browsers fire many mutations in a single tick during
      // an Angular re-render. We only need to run once per burst.
      const nowTs = Date.now();
      if (nowTs - this.lastContainerReinjectAt < 250) return;
      this.lastContainerReinjectAt = nowTs;

      this.container = null;
      try {
        this.injectUI();
      } catch (error) {
        console.error('[AIStudioFolderManager] Failed to re-inject folder panel:', error);
      }
    });

    try {
      observer.observe(navContent, { childList: true, subtree: true });
    } catch {}
    this.containerMountObserver = observer;
    // No cleanupFns registration: this method re-arms on every route change, so a
    // per-call push would grow the cleanup list without bound. destroy() disconnects
    // this.containerMountObserver directly.
  }

  private async load(): Promise<void> {
    try {
      // On Safari, restore recovery backups from the durable mirror before any
      // recoverFromBackup() can run (localStorage may have been ITP-evicted).
      await this.backupService.ensureHydrated();

      // Use chrome.storage.local with account-scoped key when isolation is enabled.
      const result = await chrome.storage.local.get(this.activeStorageKey);
      let data = result[this.activeStorageKey];

      if (!data && this.accountIsolationEnabled && this.activeStorageKey !== this.STORAGE_KEY) {
        data = await this.migrateLegacyFolderDataToScopedStorage();
      }

      if (data && validateFolderData(data)) {
        this.data = data as FolderData;
        // Create primary backup on successful load
        this.backupService.createPrimaryBackup(this.data);
      } else {
        // Don't immediately clear data - try to recover from backup
        console.warn(
          '[AIStudioFolderManager] Storage returned no data, attempting recovery from backup',
        );
        this.attemptDataRecovery(null);
      }
    } catch (error) {
      console.error('[AIStudioFolderManager] Load error:', error);
      // CRITICAL: Don't clear data on error - attempt recovery from backup
      this.attemptDataRecovery(error);
    }
  }

  private async save(): Promise<void> {
    try {
      // Create emergency backup BEFORE saving (snapshot of previous state)
      this.backupService.createEmergencyBackup(this.data);

      // Save to chrome.storage.local using active scoped key.
      await chrome.storage.local.set({ [this.activeStorageKey]: this.data });

      // Create primary backup AFTER successful save
      this.backupService.createPrimaryBackup(this.data);
    } catch (error) {
      console.error('[AIStudioFolderManager] Save error:', error);
      // Show error notification to user
      this.showErrorNotification('Failed to save folder data. Changes may not be persisted.');
    }
    // Folder membership drives which /library rows count as "archived"; re-sync the
    // table and nudge visibility after every mutation, not just on explicit user toggles.
    this.applyHideArchivedToLibraryTable();
    this.updateHideArchivedNudgeVisibility();
  }

  private injectUI(): void {
    if (this.container && document.body.contains(this.container)) return;

    const container = document.createElement('div');
    // Scope aistudio-specific styles under .gv-aistudio to avoid impacting Gemini
    container.className = 'gv-folder-container gv-aistudio';

    const header = document.createElement('div');
    header.className = 'gv-folder-header';

    const title = document.createElement('div');
    title.className = 'gv-folder-title gds-label-l';
    title.textContent = this.t('folder_title');
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'gv-folder-header-actions';
    header.appendChild(actions);

    // For AI Studio, hide import/export for now to simplify UI

    // Cloud buttons (Skip on Safari as it doesn't support cloud sync yet)
    if (!isSafari()) {
      // Cloud upload button
      const cloudUploadButton = document.createElement('button');
      cloudUploadButton.className = 'gv-folder-action-btn';
      cloudUploadButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H520q-33 0-56.5-23.5T440-240v-206l-64 62-56-56 160-160 160 160-56 56-64-62v206h220q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h100v80H260Zm220-280Z"/></svg>`;
      cloudUploadButton.title = this.t('folder_cloud_upload');
      cloudUploadButton.addEventListener('click', () => this.handleCloudUpload());
      // Add dynamic tooltip on mouseenter
      cloudUploadButton.addEventListener('mouseenter', async () => {
        const tooltip = await this.getCloudUploadTooltip();
        cloudUploadButton.title = tooltip;
      });
      actions.appendChild(cloudUploadButton);

      // Cloud sync button
      const cloudSyncButton = document.createElement('button');
      cloudSyncButton.className = 'gv-folder-action-btn';
      cloudSyncButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q17-72 85-137t145-65q33 0 56.5 23.5T520-716v242l64-62 56 56-160 160-160-160 56-56 64 62v-242q-76 14-118 73.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-48-22-89.5T600-680v-93q74 35 117 103.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm220-358Z"/></svg>`;
      cloudSyncButton.title = this.t('folder_cloud_sync');
      cloudSyncButton.addEventListener('click', () => this.handleCloudSync());
      // Add dynamic tooltip on mouseenter
      cloudSyncButton.addEventListener('mouseenter', async () => {
        const tooltip = await this.getCloudSyncTooltip();
        cloudSyncButton.title = tooltip;
      });
      actions.appendChild(cloudSyncButton);
    }

    // Add folder
    const addBtn = document.createElement('button');
    addBtn.className = 'gv-folder-add-btn';
    addBtn.title = this.t('folder_create');
    addBtn.appendChild(this.createIcon('add'));
    addBtn.addEventListener('click', () => this.createFolder());
    actions.appendChild(addBtn);

    // On the V2 nav (no inline prompt history), surface a shortcut to /library.
    // We always create the button in V2 mode and toggle its visibility on route change,
    // since Angular won't re-run injectUI when the container survives a soft navigation.
    if (!this.historyRoot) {
      const libraryBtn = document.createElement('button');
      libraryBtn.className = 'gv-folder-action-btn gv-folder-library-btn';
      libraryBtn.title = this.t('folder_manage_in_library');
      libraryBtn.appendChild(this.createIcon('library_books'));
      libraryBtn.addEventListener('click', () => {
        try {
          location.assign('/library');
        } catch {}
      });
      actions.appendChild(libraryBtn);
      this.libraryShortcutBtn = libraryBtn;
      this.updateLibraryShortcutVisibility();
    } else {
      this.libraryShortcutBtn = null;
    }

    const list = document.createElement('div');
    list.className = 'gv-folder-list';
    container.appendChild(header);
    container.appendChild(list);

    // Insertion point: prefer the legacy prompt history anchor; otherwise drop the
    // panel inside the V2 left nav, right before the `.empty-space` spacer so the
    // panel sits just below the nav items while `.bottom-actions` stays pinned.
    const root = this.historyRoot;
    if (root) {
      const host: Element = root.parentElement ?? root;
      host.insertAdjacentElement('beforebegin', container);
    } else {
      const navContent = document.querySelector('.nav-content.v3-left-nav');
      const navEl = navContent?.querySelector(':scope > nav');
      const emptySpace = navEl?.querySelector(':scope > .empty-space');
      const bottomActions = navEl?.querySelector(':scope > .bottom-actions');
      if (emptySpace) {
        emptySpace.insertAdjacentElement('beforebegin', container);
      } else if (bottomActions) {
        bottomActions.insertAdjacentElement('beforebegin', container);
      } else if (navEl) {
        navEl.appendChild(container);
      } else if (navContent) {
        navContent.appendChild(container);
      } else {
        return;
      }
      container.classList.add('gv-aistudio-v2');
    }

    this.container = container;
    this.injectStyles();
    this.render();

    // Apply initial folder enabled setting
    this.applyFolderEnabledSetting();
  }

  private injectStyles(): void {
    const styleId = 'gv-aistudio-folder-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* AI Studio is a predominantly dark surface; tuned for low contrast so the
         confirm dialog reads as a subtle elevated card, not a bright pop-out. */
      .gv-folder-confirm-dialog.gv-aistudio-confirm {
        background: var(--mat-sys-surface-container-high, #2d2e30);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        padding: 16px;
        min-width: 280px;
        font-family: 'Google Sans', 'Segoe UI', sans-serif;
        animation: gv-fade-in 0.2s ease-out;
        color: var(--mat-sys-on-surface, #e3e3e3);
      }

      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-message {
        margin-bottom: 16px;
        color: var(--mat-sys-on-surface, #e3e3e3);
        font-size: 14px;
        line-height: 1.5;
        font-weight: 400;
        opacity: 0.92;
      }

      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-actions {
        display: flex;
        gap: 4px;
        justify-content: flex-end;
      }

      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-btn {
        padding: 6px 14px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.15s ease;
        border: none;
        outline: none;
        background: transparent;
      }

      /* Destructive action: filled but muted — use the token-scaled error tone when
         available, otherwise a desaturated red that sits quietly on dark surfaces. */
      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-delete {
        background-color: var(--mat-sys-error-container, rgba(220, 90, 90, 0.22));
        color: var(--mat-sys-on-error-container, #f5b8b3);
        box-shadow: none;
      }

      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-delete:hover {
        background-color: rgba(220, 90, 90, 0.32);
        color: #ffd3cf;
        box-shadow: none;
      }

      /* Cancel is a borderless text button — removes the framing that fought the Delete fill. */
      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-cancel {
        background-color: transparent;
        color: var(--mat-sys-on-surface-variant, #c4c7c5);
        border: none;
      }

      .gv-folder-confirm-dialog.gv-aistudio-confirm .gv-confirm-cancel:hover {
        background-color: rgba(255, 255, 255, 0.06);
        color: var(--mat-sys-on-surface, #e3e3e3);
      }

      /* Hover effect for remove button in list */
      .gv-aistudio .gv-conversation-remove-btn:hover {
        background-color: rgba(220, 90, 90, 0.14) !important;
        color: #e69892 !important;
      }

      .gv-aistudio .gv-conversation-remove-btn:hover span {
        font-variation-settings: 'FILL' 1, 'wght' 600 !important;
      }

      @keyframes gv-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  private render(): void {
    if (!this.container) return;
    const list = this.container.querySelector('.gv-folder-list') as HTMLElement | null;
    if (!list) return;
    list.innerHTML = '';

    // Render only root-level folders here; children are rendered recursively
    const folders = this.data.folders.filter((f) => !f.parentId);
    folders.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return a.createdAt - b.createdAt;
    });

    for (const f of folders) {
      list.appendChild(this.renderFolder(f));
    }

    // Root drop zone
    const rootDrop = document.createElement('div');
    rootDrop.className = 'gv-folder-root-drop';
    rootDrop.textContent = '';
    this.bindDropZone(rootDrop, null);
    list.appendChild(rootDrop);

    // Render uncategorized conversations (dropped to root)
    const uncategorized = this.data.folderContents[this.UNCATEGORIZED_KEY] || [];
    if (uncategorized.length > 0) {
      const uncatSection = document.createElement('div');
      uncatSection.className = 'gv-folder-uncategorized';

      const uncatHeader = document.createElement('div');
      uncatHeader.className = 'gv-folder-uncategorized-header';
      uncatHeader.innerHTML = `<span class="google-symbols" data-icon="inbox" style="margin-right: 6px;">inbox</span>${this.t('folder_uncategorized') || 'Uncategorized'}`;
      uncatSection.appendChild(uncatHeader);

      const uncatContent = document.createElement('div');
      uncatContent.className = 'gv-folder-uncategorized-content';
      for (const conv of uncategorized) {
        uncatContent.appendChild(this.renderConversation(this.UNCATEGORIZED_KEY, conv));
      }
      uncatSection.appendChild(uncatContent);
      list.appendChild(uncatSection);
    }

    // After rendering, update active highlight
    this.highlightActiveConversation();

    // Keep the onboarding nudge in sync with the post-render folder state — e.g. the
    // user just archived their first conversation, so now we have a reason to show it.
    this.updateHideArchivedNudgeVisibility();
  }

  private getCurrentPromptIdFromLocation(): string | null {
    try {
      const m = (location.pathname || '').match(/\/prompts\/([^/?#]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  private highlightActiveConversation(): void {
    if (!this.container) return;
    const currentId = this.getCurrentPromptIdFromLocation();
    const rows = this.container.querySelectorAll(
      '.gv-folder-conversation',
    ) as NodeListOf<HTMLElement>;
    rows.forEach((row) => {
      const isActive = currentId && row.dataset.conversationId === currentId;
      row.classList.toggle('gv-folder-conversation-selected', !!isActive);
    });
  }

  /**
   * Lazily attach the /library-only setup (table observer, drag bindings, floating
   * drop zone, hide-archived pass) when entering /library via SPA navigation. On
   * initial page load this is already run by initializeFolderUI; this method handles
   * the case where the user landed on /prompts first and later navigates to /library,
   * as well as Angular rebuilding the table on re-entry.
   */
  private ensureLibraryBindings(): void {
    if (!/\/library(\/|$)/.test(location.pathname)) return;
    this.observeLibraryTable();
    this.bindDraggablesInLibraryTable();
    this.injectLibraryDropZone();
    this.applyHideArchivedToLibraryTable();
  }

  /**
   * Toggle the V2 "Manage in Library" shortcut button based on the current path.
   * Hidden on /library itself (clicking would re-navigate to self).
   */
  private updateLibraryShortcutVisibility(): void {
    const btn = this.libraryShortcutBtn;
    if (!btn) return;
    const onLibrary = /\/library(\/|$)/.test(location.pathname);
    btn.style.display = onLibrary ? 'none' : '';
  }

  /**
   * Re-attach the folder panel if Angular tore it down between checks. Idempotent and
   * cheap when the panel is already mounted.
   */
  private ensureContainerMounted(): void {
    if (!this.folderEnabled) return;
    if (this.container && document.body.contains(this.container)) return;
    this.container = null;
    try {
      this.injectUI();
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to ensure folder panel mounted:', error);
    }
    // If the nav-content subtree was recreated, the previous MutationObserver lost its
    // target. Re-arm it against the current nav root so future detaches are detected.
    this.watchContainerMount();
  }

  private installRouteChangeListener(): void {
    this.stopRouteWatcher?.();
    const update = () =>
      setTimeout(() => {
        this.ensureContainerMounted();
        this.updateLibraryShortcutVisibility();
        if (!/\/library(\/|$)/.test(location.pathname)) {
          if (this.isLibraryMultiSelectMode) {
            this.exitLibraryMultiSelectMode();
          }
          // The /library table observer watches document.body; keep it disconnected
          // while away from /library so unrelated SPA mutations stay cheap. It is
          // recreated by ensureLibraryBindings() on re-entry.
          this.disconnectLibraryTableObserver();
        }
        this.ensureLibraryBindings();
        this.highlightActiveConversation();
      }, 0);
    this.stopRouteWatcher = watchRouteChanges(update);
  }

  private renderFolder(folder: Folder, level: number = 0): HTMLElement {
    const item = document.createElement('div');
    item.className = 'gv-folder-item';
    item.dataset.folderId = folder.id;
    item.dataset.pinned = folder.pinned ? 'true' : 'false';
    item.dataset.level = String(level);

    const header = document.createElement('div');
    header.className = 'gv-folder-item-header';
    // Add left padding for nested folders
    header.style.paddingLeft = `${level * 16 + 8}px`;
    item.appendChild(header);
    // Allow dropping directly on folder header
    this.bindDropZone(header, folder.id);

    const expandBtn = document.createElement('button');
    expandBtn.className = 'gv-folder-expand-btn';
    expandBtn.appendChild(this.createIcon(folder.isExpanded ? 'expand_more' : 'chevron_right'));
    expandBtn.addEventListener('click', () => {
      folder.isExpanded = !folder.isExpanded;
      this.save().then(() => this.render());
    });
    header.appendChild(expandBtn);

    const icon = document.createElement('span');
    icon.className = 'gv-folder-icon google-symbols';
    icon.dataset.icon = 'folder';
    icon.textContent = 'folder';
    header.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'gv-folder-name gds-label-l';
    name.textContent = folder.name;
    name.addEventListener('dblclick', () => this.renameFolder(folder.id));
    header.appendChild(name);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'gv-folder-pin-btn';
    pinBtn.title = folder.pinned ? this.t('folder_unpin') : this.t('folder_pin');
    try {
      pinBtn.dataset.state = folder.pinned ? 'pinned' : 'unpinned';
    } catch {}
    pinBtn.appendChild(this.createIcon('push_pin'));
    pinBtn.addEventListener('click', () => {
      folder.pinned = !folder.pinned;
      this.save().then(() => this.render());
    });
    header.appendChild(pinBtn);

    const moreBtn = document.createElement('button');
    moreBtn.className = 'gv-folder-actions-btn';
    moreBtn.appendChild(this.createIcon('more_vert'));
    moreBtn.addEventListener('click', (e) => this.openFolderMenu(e, folder.id));
    header.appendChild(moreBtn);

    // Content (conversations and subfolders)
    if (folder.isExpanded) {
      const content = document.createElement('div');
      content.className = 'gv-folder-content';
      this.bindDropZone(content, folder.id);

      // Render conversations in this folder
      const convs = this.data.folderContents[folder.id] || [];
      for (const conv of convs) {
        const convEl = this.renderConversation(folder.id, conv);
        // Add indentation for nested conversations
        convEl.style.paddingLeft = `${(level + 1) * 16 + 8}px`;
        content.appendChild(convEl);
      }

      // Render subfolders (only for root-level folders, creating 2-level hierarchy)
      if (level === 0) {
        const subfolders = this.data.folders.filter((f) => f.parentId === folder.id);
        // Sort subfolders: pinned first, then by creation time
        subfolders.sort((a, b) => {
          const ap = a.pinned ? 1 : 0;
          const bp = b.pinned ? 1 : 0;
          if (ap !== bp) return bp - ap;
          return a.createdAt - b.createdAt;
        });
        for (const subfolder of subfolders) {
          content.appendChild(this.renderFolder(subfolder, level + 1));
        }
      }

      item.appendChild(content);
    }

    return item;
  }

  private renderConversation(folderId: string, conv: ConversationReference): HTMLElement {
    const row = document.createElement('div');
    row.className = conv.starred ? 'gv-folder-conversation gv-starred' : 'gv-folder-conversation';
    row.dataset.folderId = folderId;
    row.dataset.conversationId = conv.conversationId;

    const icon = document.createElement('span');
    icon.className = 'gv-conversation-icon google-symbols';
    icon.dataset.icon = 'chat';
    icon.textContent = 'chat';
    row.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'gv-conversation-title gds-label-l';
    title.textContent = conv.title || this.t('conversation_untitled');
    row.appendChild(title);

    const starBtn = document.createElement('button');
    starBtn.className = conv.starred
      ? 'gv-conversation-star-btn starred'
      : 'gv-conversation-star-btn';
    starBtn.appendChild(this.createIcon(conv.starred ? 'star' : 'star_outline'));
    starBtn.title = conv.starred ? this.t('conversation_unstar') : this.t('conversation_star');
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      conv.starred = !conv.starred;
      this.save().then(() => this.render());
    });
    row.appendChild(starBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'gv-conversation-remove-btn';
    removeBtn.appendChild(this.createIcon('close'));
    removeBtn.title = this.t('folder_remove_conversation');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.confirmRemoveConversation(folderId, conv.conversationId, conv.title || '', e);
    });
    row.appendChild(removeBtn);

    row.addEventListener('click', () => this.navigateToPrompt(conv.conversationId, conv.url));

    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      const data: DragData = {
        type: 'conversation',
        conversationId: conv.conversationId,
        title: conv.title,
        url: conv.url,
        sourceFolderId: folderId,
      };
      try {
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer?.setData('application/json', JSON.stringify(data));
      } catch {}
      try {
        e.dataTransfer?.setDragImage(row, 10, 10);
      } catch {}
    });

    return row;
  }

  private openFolderMenu(ev: MouseEvent, folderId: string): void {
    ev.stopPropagation();
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu gv-aistudio-folder-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;

    const closeMenu = () => {
      menu.remove();
      document.removeEventListener('click', onClickAway);
    };

    // Only show "Create subfolder" for root-level folders (to maintain 2-level hierarchy)
    if (!folder.parentId) {
      menu.appendChild(
        this.createMenuItem(this.t('folder_create_subfolder'), 'create_new_folder', () => {
          this.createFolder(folderId);
          closeMenu();
        }),
      );
    }

    const onClickAway = (e: MouseEvent) => {
      if (e.target instanceof Node && !menu.contains(e.target)) {
        closeMenu();
      }
    };

    menu.appendChild(
      this.createMenuItem(this.t('folder_rename'), 'edit', () => {
        this.renameFolder(folderId);
        closeMenu();
      }),
    );
    menu.appendChild(
      this.createMenuItem(
        this.t('folder_delete'),
        'delete',
        () => {
          this.deleteFolder(folderId);
          closeMenu();
        },
        { danger: true },
      ),
    );

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', onClickAway), 0);
  }

  private createFolder(parentId: string | null = null): void {
    const existingInput = this.container?.querySelector<HTMLInputElement>(
      '.gv-folder-inline-input input',
    );
    if (existingInput) {
      existingInput.focus();
      return;
    }

    const {
      wrapper: inputContainer,
      input,
      saveBtn,
      cancelBtn,
    } = this.createInlineFolderEditor('div', 'gv-folder-inline-input', 'gv-folder-name-input', {
      placeholder: this.t('folder_name_prompt'),
    });

    const cancel = () => {
      inputContainer.remove();
    };

    const save = async () => {
      const name = input.value.trim();
      if (!name) {
        cancel();
        return;
      }

      const f: Folder = {
        id: uid(),
        name,
        parentId: parentId || null,
        isExpanded: true,
        createdAt: now(),
        updatedAt: now(),
      };
      this.data.folders.push(f);
      this.data.folderContents[f.id] = [];
      await this.save();
      this.render();
    };

    saveBtn.addEventListener('click', () => {
      void save();
    });
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key === 'Escape') cancel();
    });

    const folderList = this.container?.querySelector('.gv-folder-list');
    if (!folderList) return;

    if (parentId) {
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
  }

  private renameFolder(folderId: string): void {
    const activeRenameInput = this.container?.querySelector<HTMLInputElement>(
      '.gv-folder-rename-inline input',
    );
    if (activeRenameInput) {
      activeRenameInput.focus();
      activeRenameInput.select();
      return;
    }

    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const folderEl = this.container?.querySelector(`[data-folder-id="${folderId}"]`);
    if (!folderEl) return;

    const headerEl = folderEl.querySelector<HTMLElement>('.gv-folder-item-header');
    if (!headerEl) return;

    const folderNameEl = folderEl.querySelector('.gv-folder-name');
    if (!folderNameEl) return;

    const {
      wrapper: inputContainer,
      input,
      saveBtn,
      cancelBtn,
    } = this.createInlineFolderEditor('span', 'gv-folder-rename-inline', 'gv-folder-rename-input', {
      value: folder.name,
    });

    const restore = () => {
      headerEl.classList.remove('gv-folder-editing');
      folderNameEl.classList.remove('gv-hidden');
      inputContainer.remove();
    };

    const save = async () => {
      const name = input.value.trim();
      if (!name) {
        restore();
        return;
      }

      folder.name = name;
      folder.updatedAt = now();
      await this.save();
      this.render();
    };

    saveBtn.addEventListener('click', () => {
      void save();
    });
    cancelBtn.addEventListener('click', restore);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key === 'Escape') restore();
    });

    folderNameEl.classList.add('gv-hidden');
    headerEl.classList.add('gv-folder-editing');
    headerEl.insertBefore(inputContainer, folderNameEl.nextSibling);
    input.focus();
    input.select();
  }

  private deleteFolder(folderId: string): void {
    const folderEl = this.container?.querySelector(`[data-folder-id="${folderId}"]`);
    const headerEl = folderEl?.querySelector<HTMLElement>('.gv-folder-item-header');

    this.showFolderConfirm(
      headerEl,
      this.t('folder_delete_confirm'),
      this.t('folder_remove_conversation_action'),
      () => {
        // Collect all folder IDs to delete (including subfolders)
        const folderIdsToDelete: string[] = [folderId];
        const subfolders = this.data.folders.filter((f) => f.parentId === folderId);
        for (const subfolder of subfolders) {
          folderIdsToDelete.push(subfolder.id);
        }

        // Delete all collected folders and their contents
        this.data.folders = this.data.folders.filter((f) => !folderIdsToDelete.includes(f.id));
        for (const id of folderIdsToDelete) {
          delete this.data.folderContents[id];
        }

        void this.save().then(() => this.render());
      },
    );
  }

  private removeConversationFromFolder(folderId: string, conversationId: string): void {
    const arr = this.data.folderContents[folderId] || [];
    this.data.folderContents[folderId] = arr.filter((c) => c.conversationId !== conversationId);
    this.save().then(() => this.render());
  }

  private confirmRemoveConversation(
    folderId: string,
    conversationId: string,
    title: string,
    event: MouseEvent,
  ): void {
    const target = event.currentTarget as HTMLElement;
    this.showFolderConfirm(
      target,
      this.t('folder_remove_conversation_confirm').replace(
        '{title}',
        title || this.t('conversation_untitled'),
      ),
      this.t('folder_remove_conversation_action'),
      () => this.removeConversationFromFolder(folderId, conversationId),
      true,
    );
  }

  private bindDropZone(el: HTMLElement, targetFolderId: string | null): void {
    // Use a counter to properly track nested dragenter/dragleave events
    // This fixes the issue where child elements trigger spurious leave events
    let dragEnterCounter = 0;

    el.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to parent drop zones
      dragEnterCounter++;
      // Only add class on first enter
      if (dragEnterCounter === 1) {
        el.classList.add('gv-folder-dragover');
      }
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to parent drop zones
      try {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      } catch {}
    });
    el.addEventListener('dragleave', (e) => {
      e.stopPropagation(); // Prevent bubbling to parent drop zones
      dragEnterCounter--;
      // Only remove class when truly leaving the container (counter reaches 0)
      // Also check relatedTarget as a fallback
      if (dragEnterCounter <= 0) {
        dragEnterCounter = 0; // Prevent negative values
        // Double-check: if relatedTarget is still inside, don't remove
        const related = e.relatedTarget as Node | null;
        if (!related || !el.contains(related)) {
          el.classList.remove('gv-folder-dragover');
        }
      }
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent bubbling to parent drop zones
      dragEnterCounter = 0; // Reset counter on drop
      el.classList.remove('gv-folder-dragover');
      const data = this.parseDragDataFromEvent(e);
      if (!data || data.type !== 'conversation' || !data.conversationId) return;
      const conv: ConversationReference = {
        conversationId: data.conversationId,
        title: normalizeText(data.title) || this.t('conversation_untitled'),
        url: data.url || '',
        addedAt: now(),
      };
      const folderId = targetFolderId;
      if (!folderId || folderId === this.UNCATEGORIZED_KEY) {
        // Drop to root or uncategorized section: move to uncategorized section
        // First remove from any existing folder
        Object.keys(this.data.folderContents).forEach((fid) => {
          if (fid === this.UNCATEGORIZED_KEY) return; // Don't remove from uncategorized yet
          this.data.folderContents[fid] = (this.data.folderContents[fid] || []).filter(
            (c) => c.conversationId !== conv.conversationId,
          );
        });
        // Add to uncategorized if not already there
        const uncatArr = this.data.folderContents[this.UNCATEGORIZED_KEY] || [];
        const existsInUncat = uncatArr.some((c) => c.conversationId === conv.conversationId);
        if (!existsInUncat) {
          uncatArr.push(conv);
          this.data.folderContents[this.UNCATEGORIZED_KEY] = uncatArr;
        }
      } else {
        const arr = this.data.folderContents[folderId] || [];
        const exists = arr.some((c) => c.conversationId === conv.conversationId);
        if (!exists) {
          arr.push(conv);
          this.data.folderContents[folderId] = arr;
        }
        // If moving from another folder (including uncategorized), remove there
        Object.keys(this.data.folderContents).forEach((fid) => {
          if (fid === folderId) return;
          this.data.folderContents[fid] = (this.data.folderContents[fid] || []).filter(
            (c) => c.conversationId !== conv.conversationId,
          );
        });
      }
      this.save().then(() => this.render());
    });
  }

  private observePromptList(): void {
    const root = this.historyRoot;
    if (!root) return;
    const observer = new MutationObserver((mutations) => {
      if (mutationAddsPromptLinks(mutations)) {
        this.schedulePromptListBinding();
      }
      if (mutationMayAffectPromptTitles(mutations)) {
        this.schedulePromptTitleSync();
      }
    });
    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'aria-label', 'href'],
      });
    } catch {}
    this.cleanupFns.push(() => {
      try {
        observer.disconnect();
      } catch {}
      if (this.promptListBindTimer !== null) {
        clearTimeout(this.promptListBindTimer);
        this.promptListBindTimer = null;
      }
      if (this.promptTitleSyncTimer !== null) {
        clearTimeout(this.promptTitleSyncTimer);
        this.promptTitleSyncTimer = null;
      }
    });

    // Also update on clicks within the prompt list (SPA navigation)
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest('a.prompt-link') as HTMLAnchorElement | null;
      if (a && /\/prompts\//.test(a.getAttribute('href') || '')) {
        setTimeout(() => this.highlightActiveConversation(), 0);
      }
    };
    try {
      root.addEventListener('click', onClick, true);
    } catch {}
    this.cleanupFns.push(() => {
      try {
        root.removeEventListener('click', onClick, true);
      } catch {}
    });
  }

  private isBodyPromptPopoverElement(element: Element): boolean {
    return (
      element.matches(BODY_PROMPT_POPOVER_SELECTOR) ||
      !!element.closest(BODY_PROMPT_POPOVER_SELECTOR)
    );
  }

  private bindDraggablesInBodyPromptPopovers(): void {
    const popoverRoots = document.querySelectorAll(BODY_PROMPT_POPOVER_SELECTOR);
    popoverRoots.forEach((root) => this.bindDraggablesInPromptList(root));
  }

  private observeBodyPromptPopovers(): void {
    if (this.bodyPromptPopoverObserver) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof Element)) continue;
          // Cheap overlay-container gate first (class match + ancestor walk) before
          // the expensive subtree scan for prompt links.
          if (!this.isBodyPromptPopoverElement(node)) continue;
          if (!nodeContainsPromptLink(node)) continue;
          this.bindDraggablesInPromptList(node);
        }
      }
    });

    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch {}
    this.bodyPromptPopoverObserver = observer;
    // destroy() disconnects and nulls this.bodyPromptPopoverObserver directly.

    this.bindDraggablesInBodyPromptPopovers();
  }

  private schedulePromptListBinding(): void {
    if (this.promptListBindTimer !== null) return;
    this.promptListBindTimer = window.setTimeout(() => {
      this.promptListBindTimer = null;
      this.bindDraggablesInPromptList();
    }, PROMPT_LIST_BIND_DEBOUNCE_MS);
  }

  private schedulePromptTitleSync(): void {
    if (!this.hasStoredConversations()) return;
    if (this.promptTitleSyncTimer !== null) return;

    this.promptTitleSyncTimer = window.setTimeout(() => {
      this.promptTitleSyncTimer = null;
      void this.runPromptTitleSync();
    }, PROMPT_TITLE_SYNC_DEBOUNCE_MS);
  }

  private async runPromptTitleSync(): Promise<void> {
    if (this.promptTitleSyncInProgress) return;

    this.promptTitleSyncInProgress = true;
    try {
      await this.syncConversationTitlesFromPromptList();
    } finally {
      this.promptTitleSyncInProgress = false;
    }
  }

  private hasStoredConversations(): boolean {
    return Object.values(this.data.folderContents).some(
      (conversations) => conversations.length > 0,
    );
  }

  private extractPromptTitle(anchor: HTMLAnchorElement | null): string | null {
    if (!anchor) return null;

    const aria = normalizeText(anchor.getAttribute('aria-label'));
    if (aria) return aria;

    const title = normalizeText(anchor.getAttribute('title'));
    if (title) return title;

    const text = normalizeText(anchor.textContent);
    if (text) return text;

    return null;
  }

  /**
   * Collect every native prompt-link title in a single document scan and return a
   * promptId -> title map. Anchors carrying the `prompt-link` class win over generic
   * matches (mirroring the old per-conversation selector priority); within each tier
   * the first anchor in document order with a usable title wins.
   */
  private collectNativePromptTitles(): Map<string, string> {
    const preferred = new Map<string, string>();
    const fallback = new Map<string, string>();
    const anchors = document.querySelectorAll<HTMLAnchorElement>(PROMPT_LINK_SELECTOR);
    anchors.forEach((anchor) => {
      const promptId = extractPromptIdFromHref(anchor.getAttribute('href') || anchor.href || '');
      if (!promptId) return;
      const title = this.extractPromptTitle(anchor);
      if (!title) return;
      if (anchor.classList.contains('prompt-link')) {
        if (!preferred.has(promptId)) preferred.set(promptId, title);
      } else if (!fallback.has(promptId)) {
        fallback.set(promptId, title);
      }
    });
    const titles = fallback;
    preferred.forEach((title, promptId) => titles.set(promptId, title));
    return titles;
  }

  private async syncConversationTitlesFromPromptList(): Promise<void> {
    if (!this.hasStoredConversations()) return;

    // One full-document scan up front; per-conversation lookups are then O(1) instead
    // of three full-document selector scans for every stored conversation.
    const nativeTitles = this.collectNativePromptTitles();
    if (nativeTitles.size === 0) return;

    let hasUpdates = false;
    for (const conversations of Object.values(this.data.folderContents)) {
      for (const conversation of conversations) {
        if (conversation.customTitle) continue;
        const nativeTitle = nativeTitles.get(conversation.conversationId);
        if (!nativeTitle || nativeTitle === conversation.title) continue;
        conversation.title = nativeTitle;
        conversation.updatedAt = now();
        hasUpdates = true;
      }
    }

    if (!hasUpdates) return;

    await this.save();
    this.render();
  }

  private resolvePromptAnchorFromHost(hostEl: HTMLElement): HTMLAnchorElement | null {
    if (hostEl.matches(PROMPT_LINK_SELECTOR)) {
      return hostEl as HTMLAnchorElement;
    }
    return hostEl.querySelector(PROMPT_LINK_SELECTOR) as HTMLAnchorElement | null;
  }

  private resolvePromptAnchorFromDragEvent(
    event: DragEvent,
    hostEl: HTMLElement,
  ): HTMLAnchorElement | null {
    const target = event.target;
    if (target instanceof Element) {
      const targetAnchor = target.closest(PROMPT_LINK_SELECTOR) as HTMLAnchorElement | null;
      if (targetAnchor) return targetAnchor;
    }
    return this.resolvePromptAnchorFromHost(hostEl);
  }

  private resolvePromptDragHost(anchor: HTMLAnchorElement): HTMLElement {
    for (const selector of PROMPT_DRAG_HOST_SELECTORS) {
      const match = anchor.closest(selector) as HTMLElement | null;
      if (match) return match;
    }
    return anchor.parentElement || anchor;
  }

  private setPromptDragData(e: DragEvent, data: DragData, dragImageEl: HTMLElement): void {
    try {
      const transfer = e.dataTransfer;
      if (!transfer) return;
      const json = JSON.stringify(data);
      transfer.effectAllowed = 'move';
      transfer.setData('application/json', json);
      transfer.setData('text/plain', json);
      if (data.url) {
        transfer.setData('text/uri-list', data.url);
        transfer.setData('text/x-moz-url', `${data.url}\n${data.title || ''}`);
      }
    } catch {}
    try {
      e.dataTransfer?.setDragImage(dragImageEl, 10, 10);
    } catch {}
  }

  private parseDragDataFromEvent(event: DragEvent): DragData | null {
    const transfer = event.dataTransfer;
    if (!transfer) return null;

    const candidates = [
      transfer.getData('application/json'),
      transfer.getData('text/plain'),
      transfer.getData('text/uri-list'),
      transfer.getData('text/x-moz-url'),
      transfer.getData('URL'),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const parsed = parseDragDataPayload(candidate);
      if (parsed) return parsed;
    }

    return null;
  }

  private bindDraggablesInPromptList(scope: ParentNode | null = this.historyRoot): void {
    const root = scope ?? this.historyRoot;
    if (!root) return;
    const anchors: HTMLAnchorElement[] = [];
    if (root instanceof Element && root.matches(UNBOUND_PROMPT_LINK_SELECTOR)) {
      anchors.push(root as HTMLAnchorElement);
    }
    root.querySelectorAll(UNBOUND_PROMPT_LINK_SELECTOR).forEach((anchor) => {
      anchors.push(anchor as HTMLAnchorElement);
    });
    anchors.forEach((anchor) => {
      const hostEl = this.resolvePromptDragHost(anchor);
      anchor.dataset.gvDragBound = '1';
      if (!(hostEl as Element & { _gvDragBound?: boolean })._gvDragBound) {
        (hostEl as Element & { _gvDragBound?: boolean })._gvDragBound = true;
        hostEl.draggable = true;
        if (!hostEl.style.cursor) {
          hostEl.style.cursor = 'grab';
        }
        hostEl.addEventListener('dragstart', (e) => {
          const promptAnchor = this.resolvePromptAnchorFromDragEvent(e, hostEl);
          if (!promptAnchor) return;

          const id = this.extractPromptId(promptAnchor);
          const title = this.extractPromptTitle(promptAnchor) || '';
          const rawHref = promptAnchor.getAttribute('href') || promptAnchor.href || '';
          const url = rawHref.startsWith('http')
            ? rawHref
            : `${location.origin}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;
          const data: DragData = { type: 'conversation', conversationId: id, title, url };
          this.setPromptDragData(e, data, hostEl);
        });
      }
    });
  }

  /**
   * Observe the library table for dynamic row additions. Idempotent — repeated calls
   * are no-ops. Watches document.body so SPA navigations that swap the table subtree
   * don't leave us with a stale observer target.
   */
  private observeLibraryTable(): void {
    if (this.libraryTableObserver) return;

    const bodyObserver = new MutationObserver((mutations) => {
      // Cheap gate: the library table only exists on /library; skip all selector work
      // elsewhere (the observer is also disconnected on route-away, this is a backstop).
      if (!/\/library(\/|$)/.test(location.pathname)) return;
      if (!this.libraryTableMutated(mutations)) return;
      this.bindDraggablesInLibraryTable();
    });
    try {
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    } catch {}
    this.libraryTableObserver = bodyObserver;
    // Disconnected via disconnectLibraryTableObserver() on route-away and in destroy();
    // no cleanupFns registration so repeated /library visits cannot grow the list.
  }

  private disconnectLibraryTableObserver(): void {
    if (!this.libraryTableObserver) return;
    try {
      this.libraryTableObserver.disconnect();
    } catch {}
    this.libraryTableObserver = null;
  }

  private libraryTableMutated(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      if (
        mutation.target instanceof Element &&
        mutation.target.closest('table.mat-mdc-table, mat-table')
      ) {
        return true;
      }

      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches(
            'table.mat-mdc-table, mat-table, tr.mat-mdc-row, tr[mat-row], tr[role="row"]',
          ) ||
          !!node.querySelector(
            'table.mat-mdc-table, mat-table, tr.mat-mdc-row, tr[mat-row], tr[role="row"]',
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Bind drag handlers to library table rows
   * Each row contains an anchor with href like /prompts/{id}
   */
  private bindDraggablesInLibraryTable(): void {
    // Find all table rows that contain chat prompt links
    // The structure from user's example: <tr> > <td> > <a href="/prompts/..."> title </a>
    const rows = this.getLibraryPromptRows();
    rows.forEach((row) => {
      const tr = row;
      const anchor = this.getLibraryPromptAnchor(tr);
      if (!anchor) return;

      // Skip if already bound
      if ((tr as Element & { _gvLibraryDragBound?: boolean })._gvLibraryDragBound) return;
      (tr as Element & { _gvLibraryDragBound?: boolean })._gvLibraryDragBound = true;

      tr.draggable = true;
      tr.style.cursor = 'grab';

      // Disable the anchor's native drag: an <a href> is implicitly draggable as a URL,
      // which hijacks the drag from the row and produces a payload with no title.
      anchor.draggable = false;
      try {
        (anchor.style as CSSStyleDeclaration & { webkitUserDrag?: string }).webkitUserDrag = 'none';
      } catch {}

      const buildDragData = (): LibraryPromptData | null => this.buildLibraryPromptData(tr);

      const onDragStart = (e: DragEvent) => {
        // Prevent interference from Angular Material's own drag handling if any
        e.stopPropagation();
        const data = buildDragData();
        if (!data) return;
        this.setPromptDragData(e, data, tr);
        tr.style.opacity = '0.5';
      };

      this.bindLibraryMultiSelectRow(tr);

      // Primary: row-level drag covers every cell (icon, title, description, type, timestamp, overflow).
      tr.addEventListener('dragstart', onDragStart, true);

      // Fallback: if a browser still honors the anchor's default drag, populate the same JSON payload
      // so the dropped conversation carries its title instead of degrading to a raw URL.
      anchor.addEventListener('dragstart', onDragStart, true);

      tr.addEventListener('dragend', () => {
        tr.style.opacity = '';
      });
    });

    // Rows are bound opportunistically as the table updates; re-sync the hide-archived
    // state each pass so newly added rows pick up the current setting.
    this.applyHideArchivedToLibraryTable();
    this.updateLibrarySelectionUI();
  }

  private getLibraryPromptRows(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('tr.mat-mdc-row, tr[mat-row], tr[role="row"]'),
    ).filter((row) => !!this.getLibraryPromptAnchor(row));
  }

  private getLibraryPromptAnchor(row: HTMLElement): HTMLAnchorElement | null {
    return row.querySelector(PROMPT_LINK_SELECTOR) as HTMLAnchorElement | null;
  }

  private buildLibraryPromptData(row: HTMLElement): LibraryPromptData | null {
    const anchor = this.getLibraryPromptAnchor(row);
    if (!anchor) return null;
    const conversationId = this.extractPromptId(anchor);
    if (!conversationId) return null;
    const title = this.extractPromptTitle(anchor) || '';
    const rawHref = anchor.getAttribute('href') || anchor.href || '';
    const url = rawHref.startsWith('http')
      ? rawHref
      : `${location.origin}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;
    return { type: 'conversation', conversationId, title, url };
  }

  private bindLibraryMultiSelectRow(row: HTMLElement): void {
    if ((row as Element & { _gvLibraryMultiSelectBound?: boolean })._gvLibraryMultiSelectBound)
      return;
    (row as Element & { _gvLibraryMultiSelectBound?: boolean })._gvLibraryMultiSelectBound = true;

    let longPressTriggered = false;
    let longPressTimeoutId: number | null = null;

    const clearLongPress = () => {
      if (longPressTimeoutId === null) return;
      clearTimeout(longPressTimeoutId);
      longPressTimeoutId = null;
    };

    row.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('button, [role="button"]')) {
        return;
      }
      const data = this.buildLibraryPromptData(row);
      if (!data) return;
      longPressTriggered = false;
      clearLongPress();
      longPressTimeoutId = window.setTimeout(() => {
        longPressTriggered = true;
        this.enterLibraryMultiSelectMode(data.conversationId);
      }, this.LIBRARY_LONG_PRESS_MS);
    });

    row.addEventListener('mouseup', clearLongPress);
    row.addEventListener('mouseleave', clearLongPress);

    row.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof Element && event.target.closest('button, [role="button"]')) {
          return;
        }
        if (this.libraryBatchDeleteInProgress) return;

        if (longPressTriggered) {
          event.preventDefault();
          event.stopPropagation();
          longPressTriggered = false;
          return;
        }

        if (!this.isLibraryMultiSelectMode) return;

        const data = this.buildLibraryPromptData(row);
        if (!data) return;
        event.preventDefault();
        event.stopPropagation();
        this.toggleLibraryPromptSelection(data.conversationId);
      },
      true,
    );
  }

  private enterLibraryMultiSelectMode(initialConversationId: string): void {
    this.isLibraryMultiSelectMode = true;
    this.selectedLibraryPrompts.add(initialConversationId);
    this.updateLibrarySelectionUI();
    this.setupLibraryOutsideClickHandler();
  }

  private exitLibraryMultiSelectMode(): void {
    this.isLibraryMultiSelectMode = false;
    this.removeLibraryOutsideClickHandler();
    this.selectedLibraryPrompts.clear();
    this.updateLibrarySelectionUI();
  }

  private toggleLibraryPromptSelection(conversationId: string): void {
    if (this.selectedLibraryPrompts.has(conversationId)) {
      this.selectedLibraryPrompts.delete(conversationId);
      if (this.selectedLibraryPrompts.size === 0) {
        this.exitLibraryMultiSelectMode();
        return;
      }
    } else {
      if (this.selectedLibraryPrompts.size >= this.MAX_LIBRARY_BATCH_DELETE_COUNT) {
        this.showNotification(
          this.t('batch_delete_limit_reached').replace(
            '{max}',
            String(this.MAX_LIBRARY_BATCH_DELETE_COUNT),
          ),
          'info',
        );
        return;
      }
      this.selectedLibraryPrompts.add(conversationId);
    }
    this.updateLibrarySelectionUI();
  }

  private updateLibrarySelectionUI(): void {
    this.getLibraryPromptRows().forEach((row) => {
      const data = this.buildLibraryPromptData(row);
      row.classList.toggle(
        'gv-library-row-selected',
        !!data && this.selectedLibraryPrompts.has(data.conversationId),
      );
    });

    const host = this.isLibraryMultiSelectMode
      ? this.getLibraryMultiSelectHost()
      : this.getExistingLibraryMultiSelectHost();
    if (!host) return;

    host.classList.toggle('gv-multi-select-mode', this.isLibraryMultiSelectMode);

    const count = host.querySelector('[data-selection-count="true"]');
    if (count) count.textContent = `${this.selectedLibraryPrompts.size} selected`;

    const actions = host.querySelector('[data-multi-select-actions="true"]');
    if (!actions) return;
    if (!this.isLibraryMultiSelectMode) {
      if (actions.childElementCount > 0) actions.innerHTML = '';
      return;
    }
    if (actions.childElementCount > 0) return;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
    deleteBtn.title = this.t('batch_delete_button');
    deleteBtn.appendChild(this.createIcon('delete'));
    deleteBtn.addEventListener('click', () => void this.batchDeleteLibraryPrompts());
    actions.appendChild(deleteBtn);

    const exitBtn = document.createElement('button');
    exitBtn.className = 'gv-multi-select-action-btn gv-multi-select-exit-btn';
    exitBtn.title = 'Exit multi-select mode';
    exitBtn.appendChild(this.createIcon('close'));
    exitBtn.addEventListener('click', () => this.exitLibraryMultiSelectMode());
    actions.appendChild(exitBtn);
  }

  private createLibraryMultiSelectIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'gv-multi-select-indicator';

    const content = document.createElement('div');
    content.className = 'gv-multi-select-indicator-content';
    content.appendChild(this.createIcon('check_circle'));

    const text = document.createElement('span');
    text.className = 'gv-multi-select-indicator-text';
    text.dataset.selectionCount = 'true';
    text.textContent = '0 selected';
    content.appendChild(text);
    indicator.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'gv-multi-select-actions';
    actions.dataset.multiSelectActions = 'true';
    indicator.appendChild(actions);

    return indicator;
  }

  private getLibraryMultiSelectHost(): HTMLElement {
    if (!this.libraryMultiSelectHostElement?.isConnected) {
      const host = document.createElement('div');
      host.className =
        'gv-folder-container gv-multi-select-floating-host gv-aistudio-library-select';
      host.dataset.multiSelectFloatingHost = 'true';
      host.style.position = 'fixed';
      host.style.top = '72px';
      host.style.right = '24px';
      host.style.width = 'min(360px, calc(100vw - 48px))';
      host.style.zIndex = String(2147483647);
      host.appendChild(this.createLibraryMultiSelectIndicator());
      document.body.appendChild(host);
      this.libraryMultiSelectHostElement = host;
    }
    return this.libraryMultiSelectHostElement;
  }

  private getExistingLibraryMultiSelectHost(): HTMLElement | null {
    return this.libraryMultiSelectHostElement?.isConnected
      ? this.libraryMultiSelectHostElement
      : null;
  }

  private setupLibraryOutsideClickHandler(): void {
    this.removeLibraryOutsideClickHandler();
    this.libraryOutsideClickHandler = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.libraryMultiSelectHostElement?.contains(target)) return;
      if ((target as Element).closest?.('.cdk-overlay-container, .mat-mdc-dialog-container'))
        return;
      if (this.getLibraryPromptRows().some((row) => row.contains(target))) return;
      this.exitLibraryMultiSelectMode();
    };
    setTimeout(() => {
      document.addEventListener('click', this.libraryOutsideClickHandler!, true);
    }, 0);
  }

  private removeLibraryOutsideClickHandler(): void {
    if (!this.libraryOutsideClickHandler) return;
    document.removeEventListener('click', this.libraryOutsideClickHandler, true);
    this.libraryOutsideClickHandler = null;
  }

  private async batchDeleteLibraryPrompts(): Promise<void> {
    if (this.libraryBatchDeleteInProgress) return;
    const conversationIds = Array.from(this.selectedLibraryPrompts);
    if (conversationIds.length === 0) return;

    const confirmed = confirm(
      this.t('batch_delete_confirm').replace('{count}', String(conversationIds.length)),
    );
    if (!confirmed) return;

    this.libraryBatchDeleteInProgress = true;
    let successCount = 0;
    let failedCount = 0;

    try {
      this.showLibraryBatchDeleteProgress(0, conversationIds.length);
      for (let i = 0; i < conversationIds.length; i++) {
        this.updateLibraryBatchDeleteProgress(i + 1, conversationIds.length);
        const success = await this.triggerLibraryDeleteForPrompt(conversationIds[i]);
        if (success) successCount++;
        else failedCount++;
        if (i < conversationIds.length - 1) {
          await this.delay(this.LIBRARY_BATCH_DELETE_CONFIG.DELAY_BETWEEN_DELETIONS);
        }
      }
    } finally {
      this.libraryBatchDeleteInProgress = false;
      this.hideLibraryBatchDeleteProgress();
    }

    if (failedCount === 0) {
      this.showNotification(
        this.t('batch_delete_success').replace('{count}', String(successCount)),
        'info',
      );
    } else {
      this.showNotification(
        this.t('batch_delete_partial')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(failedCount)),
        'warning',
      );
    }

    this.exitLibraryMultiSelectMode();
    if (successCount > 0) {
      setTimeout(() => location.reload(), this.LIBRARY_BATCH_DELETE_CONFIG.PAGE_REFRESH_DELAY);
    }
  }

  private async triggerLibraryDeleteForPrompt(conversationId: string): Promise<boolean> {
    const row = this.findLibraryPromptRow(conversationId);
    if (!row) return false;
    const moreButton = row.querySelector<HTMLElement>(
      'button[aria-label="More options"], button[aria-label*="More"], button.ms-button-icon',
    );
    if (!moreButton) return false;

    moreButton.click();
    await this.delay(this.LIBRARY_BATCH_DELETE_CONFIG.MENU_APPEAR_DELAY);
    const deleteClicked = await this.waitForDeleteButtonAndClick();
    if (!deleteClicked) {
      this.clickBackdropToCloseMenu();
      return false;
    }

    await this.delay(this.LIBRARY_BATCH_DELETE_CONFIG.DIALOG_APPEAR_DELAY);
    await this.confirmDeleteIfNeeded();
    await this.delay(this.LIBRARY_BATCH_DELETE_CONFIG.DELETION_COMPLETE_DELAY);
    return true;
  }

  private findLibraryPromptRow(conversationId: string): HTMLElement | null {
    for (const row of this.getLibraryPromptRows()) {
      const data = this.buildLibraryPromptData(row);
      if (data?.conversationId === conversationId) return row;
    }
    return null;
  }

  private async waitForDeleteButtonAndClick(): Promise<boolean> {
    const maxWaitTime = this.LIBRARY_BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
    const checkInterval = this.LIBRARY_BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
    const keywords = this.getDeleteKeywords();
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const byTestId = Array.from(
        document.querySelectorAll<HTMLElement>('[data-test-id="delete-button"]'),
      ).find((el) => this.isVisibleElement(el));
      if (byTestId) {
        byTestId.click();
        return true;
      }

      const menuItems = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container button[role="menuitem"], .cdk-overlay-container [role="menuitem"], .mat-mdc-menu-content button',
        ),
      );
      for (const item of menuItems) {
        if (!this.isVisibleElement(item)) continue;
        const text = normalizeText(item.textContent).toLowerCase();
        if (
          keywords.some(
            (keyword) => text === keyword || (text.includes(keyword) && text.length < 20),
          )
        ) {
          item.click();
          return true;
        }
      }

      const deleteIcon = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container mat-icon, .cdk-overlay-container .material-icons, .cdk-overlay-container .google-symbols',
        ),
      ).find((icon) => {
        const text = normalizeText(icon.textContent).toLowerCase();
        const fontIcon = normalizeText(icon.getAttribute('fonticon')).toLowerCase();
        return ['delete', 'delete_forever', 'delete_outline'].includes(text || fontIcon);
      });
      const iconButton = deleteIcon?.closest('button, [role="menuitem"]') as HTMLElement | null;
      if (iconButton && this.isVisibleElement(iconButton)) {
        iconButton.click();
        return true;
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }

    return false;
  }

  private async confirmDeleteIfNeeded(): Promise<void> {
    const maxWaitTime = this.LIBRARY_BATCH_DELETE_CONFIG.MAX_BUTTON_WAIT_TIME;
    const checkInterval = this.LIBRARY_BATCH_DELETE_CONFIG.BUTTON_CHECK_INTERVAL;
    const keywords = this.getDeleteKeywords();
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const confirmByTestId = document.querySelector<HTMLElement>(
        '[data-test-id*="confirm"], [data-test-id*="delete"]:not([data-test-id="delete-button"])',
      );
      if (confirmByTestId && this.isVisibleElement(confirmByTestId)) {
        confirmByTestId.click();
        return;
      }

      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cdk-overlay-container button, .mat-mdc-dialog-container button',
        ),
      ).filter((button) => this.isVisibleElement(button));
      for (const button of buttons) {
        const text = normalizeText(button.textContent).toLowerCase();
        if (keywords.some((keyword) => text === keyword || text.includes(keyword))) {
          button.click();
          return;
        }
      }

      const actions = document.querySelector('.mat-mdc-dialog-actions, .mat-dialog-actions');
      const actionButtons = actions?.querySelectorAll<HTMLElement>('button');
      if (actionButtons && actionButtons.length >= 2) {
        const last = actionButtons[actionButtons.length - 1];
        if (this.isVisibleElement(last)) {
          last.click();
          return;
        }
      }

      await this.delay(checkInterval);
      elapsed += checkInterval;
    }
  }

  private getDeleteKeywords(): string[] {
    return (this.t('batch_delete_match_patterns') || '')
      .split(/[,，、；;]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  private isVisibleElement(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.offsetParent !== null
    );
  }

  private clickBackdropToCloseMenu(): void {
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
  }

  private showLibraryBatchDeleteProgress(current: number, total: number): void {
    this.hideLibraryBatchDeleteProgress();

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

    const text = document.createElement('span');
    text.className = 'gv-batch-delete-progress-text';
    text.textContent = this.t('batch_delete_in_progress')
      .replace('{current}', String(current))
      .replace('{total}', String(total));
    progress.appendChild(text);
    document.body.appendChild(progress);
    this.libraryBatchDeleteProgressElement = progress;
  }

  private updateLibraryBatchDeleteProgress(current: number, total: number): void {
    const text = this.libraryBatchDeleteProgressElement?.querySelector(
      '.gv-batch-delete-progress-text',
    );
    if (!text) return;
    text.textContent = this.t('batch_delete_in_progress')
      .replace('{current}', String(current))
      .replace('{total}', String(total));
  }

  private hideLibraryBatchDeleteProgress(): void {
    this.libraryBatchDeleteProgressElement?.remove();
    this.libraryBatchDeleteProgressElement = null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Inject a floating drop zone for the library page. Guarded so SPA navigations
   * into /library don't create duplicate floating cards.
   */
  private injectLibraryDropZone(): void {
    if (this.libraryDropZoneInjected) return;
    if (document.querySelector('.gv-library-drop-zone')) {
      this.libraryDropZoneInjected = true;
      return;
    }

    // Create a floating container that appears during drag
    const floatingZone = document.createElement('div');
    floatingZone.className = 'gv-library-drop-zone';
    this.libraryDropZoneInjected = true;
    floatingZone.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(32, 33, 36, 0.95);
      border: 2px dashed rgba(138, 180, 248, 0.5);
      border-radius: 12px;
      padding: 16px;
      min-width: 200px;
      max-width: 300px;
      max-height: 400px;
      overflow-y: auto;
      z-index: 2147483646;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
      transform: translateY(10px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      color: #e8eaed;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    title.innerHTML = `<span class="google-symbols" style="font-size: 18px;">folder</span>${this.t('folder_title')}`;
    floatingZone.appendChild(title);

    const folderList = document.createElement('div');
    folderList.className = 'gv-library-folder-list';
    floatingZone.appendChild(folderList);

    document.body.appendChild(floatingZone);

    // Update folder list content
    const updateFolderList = () => {
      folderList.innerHTML = '';

      // Add a "Root / Uncategorized" option at the top
      const rootItem = document.createElement('div');
      rootItem.className = 'gv-library-folder-item gv-library-root-item';
      rootItem.style.cssText = `
        padding: 10px 12px;
        margin: 4px 0 12px 0;
        background: rgba(138, 180, 248, 0.1);
        border-radius: 8px;
        color: #8ab4f8;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background 0.15s, border-color 0.15s;
        border: 2px dashed rgba(138, 180, 248, 0.4);
      `;
      rootItem.innerHTML = `<span class="google-symbols" data-icon="inbox">inbox</span>${this.t('folder_uncategorized') || 'Uncategorized'}`;

      const onDropToRoot = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        rootItem.style.background = 'rgba(138, 180, 248, 0.2)';
        rootItem.style.borderColor = '#8ab4f8';

        const data = this.parseDragDataFromEvent(e);
        if (!data || data.type !== 'conversation' || !data.conversationId) return;

        const conv: ConversationReference = {
          conversationId: data.conversationId,
          title: normalizeText(data.title) || this.t('conversation_untitled'),
          url: data.url || '',
          addedAt: now(),
        };

        // Add to uncategorized section
        Object.keys(this.data.folderContents).forEach((fid) => {
          if (fid === this.UNCATEGORIZED_KEY) return;
          this.data.folderContents[fid] = (this.data.folderContents[fid] || []).filter(
            (c) => c.conversationId !== conv.conversationId,
          );
        });

        const uncatArr = this.data.folderContents[this.UNCATEGORIZED_KEY] || [];
        const existsInUncat = uncatArr.some((c) => c.conversationId === conv.conversationId);
        if (!existsInUncat) {
          uncatArr.push(conv);
          this.data.folderContents[this.UNCATEGORIZED_KEY] = uncatArr;
        }

        this.save();
        this.showNotification(
          this.t('conversation_saved_to_root') || 'Saved to Uncategorized',
          'info',
        );
      };

      rootItem.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rootItem.style.background = 'rgba(138, 180, 248, 0.3)';
        rootItem.style.borderColor = '#8ab4f8';
      });
      rootItem.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        } catch {}
      });
      rootItem.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        rootItem.style.background = 'rgba(138, 180, 248, 0.1)';
        rootItem.style.borderColor = 'rgba(138, 180, 248, 0.4)';
      });
      rootItem.addEventListener('drop', onDropToRoot);
      folderList.appendChild(rootItem);

      // Ensure at least one folder exists for the dedicated folder list section
      if (this.data.folders.length === 0) {
        const defaultFolder: Folder = {
          id: uid(),
          name: this.t('folder_default_name') || 'My Folder',
          parentId: null,
          isExpanded: true,
          createdAt: now(),
          updatedAt: now(),
        };
        this.data.folders.push(defaultFolder);
        this.data.folderContents[defaultFolder.id] = [];
        this.save();
      }

      // Render folders with proper hierarchy (root folders + their subfolders)
      const rootFolders = this.data.folders.filter((f) => !f.parentId);
      // Sort root folders: pinned first, then by creation time
      rootFolders.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return a.createdAt - b.createdAt;
      });

      // Helper function to create a folder drop item
      const createFolderDropItem = (folder: Folder, isSubfolder: boolean) => {
        const folderItem = document.createElement('div');
        folderItem.className = 'gv-library-folder-item';
        folderItem.dataset.folderId = folder.id;
        const paddingLeft = isSubfolder ? '28px' : '12px';
        folderItem.style.cssText = `
          padding: 10px ${paddingLeft};
          margin: 4px 0;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          color: #e8eaed;
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          transition: background 0.15s, border-color 0.15s;
          border: 2px solid transparent;
        `;
        const iconName = isSubfolder ? 'subdirectory_arrow_right' : 'folder';
        folderItem.innerHTML = `<span class="google-symbols" style="font-size: 16px; color: #8ab4f8;">${iconName}</span>${folder.name}`;

        // Bind drop events
        folderItem.addEventListener('dragenter', (e) => {
          e.preventDefault();
          e.stopPropagation();
          folderItem.style.background = 'rgba(138, 180, 248, 0.2)';
          folderItem.style.borderColor = '#8ab4f8';
        });
        folderItem.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          } catch {}
        });
        folderItem.addEventListener('dragleave', (e) => {
          e.stopPropagation();
          folderItem.style.background = 'rgba(255, 255, 255, 0.05)';
          folderItem.style.borderColor = 'transparent';
        });
        folderItem.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          folderItem.style.background = 'rgba(255, 255, 255, 0.05)';
          folderItem.style.borderColor = 'transparent';

          const data = this.parseDragDataFromEvent(e);
          if (!data || data.type !== 'conversation' || !data.conversationId) return;

          const conv: ConversationReference = {
            conversationId: data.conversationId,
            title: normalizeText(data.title) || this.t('conversation_untitled'),
            url: data.url || '',
            addedAt: now(),
          };

          // Add to this folder
          const arr = this.data.folderContents[folder.id] || [];
          const exists = arr.some((c) => c.conversationId === conv.conversationId);
          if (!exists) {
            arr.push(conv);
            this.data.folderContents[folder.id] = arr;
          }

          // Remove from other folders
          Object.keys(this.data.folderContents).forEach((fid) => {
            if (fid === folder.id) return;
            this.data.folderContents[fid] = (this.data.folderContents[fid] || []).filter(
              (c) => c.conversationId !== conv.conversationId,
            );
          });

          this.save();
          this.showNotification(
            `${this.t('conversation_added_to_folder') || 'Added to'} "${folder.name}"`,
            'info',
          );
        });

        return folderItem;
      };

      // Render root folders and their subfolders
      rootFolders.forEach((rootFolder) => {
        folderList.appendChild(createFolderDropItem(rootFolder, false));

        // Render subfolders of this root folder
        const subfolders = this.data.folders.filter((f) => f.parentId === rootFolder.id);
        subfolders.sort((a, b) => {
          const ap = a.pinned ? 1 : 0;
          const bp = b.pinned ? 1 : 0;
          if (ap !== bp) return bp - ap;
          return a.createdAt - b.createdAt;
        });
        subfolders.forEach((subfolder) => {
          folderList.appendChild(createFolderDropItem(subfolder, true));
        });
      });
    };

    // Show/hide the floating zone on drag events
    let zoneVisible = false;
    let dragHeartbeatTimer: number | null = null;

    const clearDragHeartbeat = () => {
      if (dragHeartbeatTimer === null) return;
      clearTimeout(dragHeartbeatTimer);
      dragHeartbeatTimer = null;
    };

    const showZone = () => {
      zoneVisible = true;
      updateFolderList();
      floatingZone.style.opacity = '1';
      floatingZone.style.pointerEvents = 'auto';
      floatingZone.style.transform = 'translateY(0)';
      armDragHeartbeat();
    };

    const hideZone = () => {
      zoneVisible = false;
      clearDragHeartbeat();
      floatingZone.style.opacity = '0';
      floatingZone.style.pointerEvents = 'none';
      floatingZone.style.transform = 'translateY(10px)';
    };

    // Heartbeat: while the zone is up, every document dragover re-arms this timer. If
    // the source row is removed mid-drag (Angular table refresh), dragend never fires
    // and no drop arrives — the silent gap in dragover traffic hides the zone.
    const armDragHeartbeat = () => {
      clearDragHeartbeat();
      dragHeartbeatTimer = window.setTimeout(() => {
        dragHeartbeatTimer = null;
        hideZone();
      }, LIBRARY_DRAG_HEARTBEAT_MS);
    };

    // Listen for drag events on the document
    const onDragStart = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      // Check if the dragged element is or is within a library table row
      const isLibraryRow = target.closest?.('tr.mat-mdc-row, tr[mat-row]');
      if (isLibraryRow) {
        // Also ensure it's not a row from some other table
        const hasPromptLink = isLibraryRow.querySelector('a[href*="/prompts/"]');
        if (hasPromptLink) {
          setTimeout(showZone, 0);
        }
      }
    };

    const onDragOver = () => {
      if (!zoneVisible) return;
      armDragHeartbeat();
    };

    const onDragEnd = () => {
      setTimeout(hideZone, 100);
    };

    // Belt-and-suspenders alongside dragend: a drop anywhere in the document also
    // dismisses the zone (covers sources whose dragend is swallowed).
    const onDrop = () => {
      setTimeout(hideZone, 100);
    };

    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragend', onDragEnd);
    document.addEventListener('drop', onDrop);

    this.cleanupFns.push(() => {
      clearDragHeartbeat();
      try {
        document.removeEventListener('dragstart', onDragStart);
      } catch {}
      try {
        document.removeEventListener('dragover', onDragOver);
      } catch {}
      try {
        document.removeEventListener('dragend', onDragEnd);
      } catch {}
      try {
        document.removeEventListener('drop', onDrop);
      } catch {}
      try {
        floatingZone.remove();
      } catch {}
    });
  }

  private extractPromptId(anchor: HTMLAnchorElement): string {
    const rawHref = anchor.getAttribute('href') || anchor.href || '';
    const id = extractPromptIdFromHref(rawHref);
    if (id) return id;

    try {
      const u = new URL(rawHref, location.origin);
      const parts = (u.pathname || '').split('/').filter(Boolean);
      // Expected format: /prompts/{id} -> ['', 'prompts', '{id}']
      if (parts.length >= 2 && parts[0] === 'prompts') {
        return parts[1];
      }
      return parts[1] || rawHref;
    } catch {
      return rawHref;
    }
  }

  private navigateToPrompt(promptId: string, url: string): void {
    // Prefer clicking the native link to preserve SPA behavior
    const selector = `ms-prompt-history-v3 a.prompt-link[href*="/prompts/${promptId}"]`;
    const a = document.querySelector(selector) as HTMLAnchorElement | null;
    if (a) {
      a.click();
      setTimeout(() => this.highlightActiveConversation(), 0);
      return;
    }
    try {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      setTimeout(() => this.highlightActiveConversation(), 0);
    } catch {
      location.href = url;
    }
  }

  private handleExport(): void {
    const payload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: new Date().toISOString(),
      data: this.data,
    };
    downloadJSON(payload, `gemini-voyager-folders-${this.timestamp()}.json`);
  }

  private handleImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener(
      'change',
      async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          const next = (json && (json.data || json)) as FolderData;
          if (!next || !Array.isArray(next.folders) || typeof next.folderContents !== 'object') {
            alert(this.t('folder_import_invalid_format') || 'Invalid file format');
            return;
          }
          // Merge mode by default: simple union without duplicates
          const existingIds = new Set(this.data.folders.map((x) => x.id));
          for (const f of next.folders) {
            if (!existingIds.has(f.id)) {
              this.data.folders.push(f);
              this.data.folderContents[f.id] = next.folderContents[f.id] || [];
            } else {
              // Merge conversations
              const base = this.data.folderContents[f.id] || [];
              const add = next.folderContents[f.id] || [];
              const seen = new Set(base.map((c) => c.conversationId));
              for (const c of add) {
                if (!seen.has(c.conversationId)) base.push(c);
              }
              this.data.folderContents[f.id] = base;
            }
          }
          await this.save();
          this.render();
          alert(this.t('folder_import_success') || 'Imported');
        } catch {
          alert(this.t('folder_import_error') || 'Import failed');
        }
      },
      { once: true },
    );
    input.click();
  }

  private timestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  private async loadFolderEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({ geminiFolderEnabled: true });
      this.folderEnabled = result.geminiFolderEnabled !== false;
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to load folder enabled setting:', error);
      this.folderEnabled = true;
    }
  }

  /**
   * Load the AI Studio hide-archived settings. Kept fully separate from the Gemini keys
   * so a user who toggled the feature on Gemini is not surprised when they open AI Studio.
   */
  private async loadHideArchivedSettings(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO]: false,
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: false,
      });
      this.hideArchivedEnabled =
        result[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO] === true;
      this.hideArchivedNudgeShown =
        result[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO] === true;
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to load hide-archived settings:', error);
      this.hideArchivedEnabled = false;
      this.hideArchivedNudgeShown = false;
    }
  }

  private async saveHideArchivedEnabled(next: boolean): Promise<void> {
    this.hideArchivedEnabled = next;
    try {
      await browser.storage.sync.set({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO]: next,
      });
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to save hide-archived setting:', error);
    }
  }

  private async saveHideArchivedNudgeShown(): Promise<void> {
    this.hideArchivedNudgeShown = true;
    try {
      await browser.storage.sync.set({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]: true,
      });
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to persist nudge-shown flag:', error);
    }
  }

  /**
   * Returns true when the user has at least one conversation filed into a real folder
   * (uncategorized doesn't count). Used to decide whether to show the onboarding nudge
   * — showing it with an empty state would be a mystery card.
   */
  private hasAnyArchivedConversation(): boolean {
    for (const [folderId, conversations] of Object.entries(this.data.folderContents)) {
      if (folderId === this.UNCATEGORIZED_KEY) continue;
      if (Array.isArray(conversations) && conversations.length > 0) return true;
    }
    return false;
  }

  /**
   * Decide whether to mount or unmount the AI Studio hide-archived nudge. Safe to call
   * from any state change path — idempotent and cheap.
   */
  private updateHideArchivedNudgeVisibility(): void {
    const container = this.container;
    if (!container) return;

    const eligible =
      shouldShowHideArchivedNudge({
        nudgeShown: this.hideArchivedNudgeShown,
        hideArchivedAlreadyOn: this.hideArchivedEnabled,
      }) && this.hasAnyArchivedConversation();

    if (!eligible) {
      unmountHideArchivedNudge(container);
      return;
    }

    mountHideArchivedNudge({
      container,
      variantClass: 'gv-hide-archived-nudge--aistudio',
      i18nKeys: {
        title: 'aistudio_hide_archived_nudge_title',
        body: 'aistudio_hide_archived_nudge_body',
        enable: 'aistudio_hide_archived_nudge_enable',
        dismiss: 'aistudio_hide_archived_nudge_dismiss',
        footnote: 'aistudio_hide_archived_nudge_footnote',
      },
      onEnable: () => {
        void this.saveHideArchivedEnabled(true).then(() => this.saveHideArchivedNudgeShown());
      },
      onDismiss: () => {
        void this.saveHideArchivedNudgeShown();
      },
    });
  }

  /**
   * A conversation is "archived" if any non-uncategorized folder contains it. Build
   * the id set once per hide-archived pass so the per-row check is O(1) instead of
   * scanning every folder's contents for every table row.
   */
  private collectArchivedConversationIds(): Set<string> {
    const archived = new Set<string>();
    for (const [folderId, conversations] of Object.entries(this.data.folderContents)) {
      if (folderId === this.UNCATEGORIZED_KEY) continue;
      if (!Array.isArray(conversations)) continue;
      for (const conversation of conversations) {
        archived.add(conversation.conversationId);
      }
    }
    return archived;
  }

  /**
   * Toggle the hide class on every table row in /library according to the current
   * setting and folder membership. No-op outside /library.
   */
  private applyHideArchivedToLibraryTable(): void {
    if (!/\/library(\/|$)/.test(location.pathname)) return;
    const rows = document.querySelectorAll<HTMLElement>('tr.mat-mdc-row, tr[mat-row]');
    if (rows.length === 0) return;
    const archivedIds = this.collectArchivedConversationIds();
    rows.forEach((row) => {
      const anchor = row.querySelector(
        'a[href^="/prompts/"], a.name-btn[href*="/prompts/"]',
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const id = extractPromptIdFromHref(anchor.getAttribute('href') || anchor.href || '');
      if (!id) return;
      const shouldHide = this.hideArchivedEnabled && archivedIds.has(id);
      row.classList.toggle('gv-conversation-archived', shouldHide);
    });
  }

  private setupStorageListener(): void {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        if (changes.geminiFolderEnabled) {
          this.folderEnabled = changes.geminiFolderEnabled.newValue !== false;
          this.applyFolderEnabledSetting();
        }
        if (
          changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] ||
          changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO]
        ) {
          void (async () => {
            const nextEnabled = await accountIsolationService.isIsolationEnabled({
              platform: 'aistudio',
              pageUrl: window.location.href,
            });
            await this.handleAccountIsolationToggle(nextEnabled);
          })();
        }
        if (changes[this.SIDEBAR_WIDTH_KEY]) {
          const w = changes[this.SIDEBAR_WIDTH_KEY].newValue;
          if (typeof w === 'number') {
            const clamped = Math.min(
              this.MAX_SIDEBAR_WIDTH,
              Math.max(this.MIN_SIDEBAR_WIDTH, Math.round(w)),
            );
            this.sidebarWidth = clamped;
            this.applySidebarWidth();
          }
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO]) {
          this.hideArchivedEnabled =
            changes[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO].newValue === true;
          this.applyHideArchivedToLibraryTable();
          this.updateHideArchivedNudgeVisibility();
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO]) {
          this.hideArchivedNudgeShown =
            changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN_AISTUDIO].newValue === true;
          this.updateHideArchivedNudgeVisibility();
        }
      }
    });
  }

  private applyFolderEnabledSetting(): void {
    if (this.folderEnabled) {
      // Re-enabling after destroy(): restart the account-scope poller destroy() stopped.
      if (this.accountContextPoller === null) {
        this.setupAccountContextPoller();
      }
      // If folder UI doesn't exist yet, initialize it
      if (!this.container) {
        this.initializeFolderUI().catch((error) => {
          console.error('[AIStudioFolderManager] Failed to initialize folder UI:', error);
        });
      } else {
        // UI already exists, just show it
        this.container.style.display = '';
      }
    } else {
      // Fully tear down injected DOM, observers, pollers and document listeners so a
      // disabled folder feature costs nothing. Re-enabling goes through
      // initializeFolderUI() again because destroy() resets this.container to null.
      this.destroy();
    }
  }

  /**
   * Tear down everything the folder feature attached to the page: injected DOM,
   * observers, pollers, timers and document/window listeners. Idempotent — safe to
   * call multiple times. The storage-change and runtime message listeners stay alive
   * so a later re-enable (folderEnabled -> true) can rebuild the UI from scratch via
   * initializeFolderUI().
   */
  private destroy(): void {
    const cleanups = this.cleanupFns.splice(0, this.cleanupFns.length);
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {}
    }

    // Field-managed observers (registered outside cleanupFns to stay idempotent).
    try {
      this.containerMountObserver?.disconnect();
    } catch {}
    this.containerMountObserver = null;
    try {
      this.bodyPromptPopoverObserver?.disconnect();
    } catch {}
    this.bodyPromptPopoverObserver = null;
    this.disconnectLibraryTableObserver();

    // Pollers and debounce timers.
    if (this.accountContextPoller !== null) {
      clearInterval(this.accountContextPoller);
      this.accountContextPoller = null;
    }
    if (this.promptListBindTimer !== null) {
      clearTimeout(this.promptListBindTimer);
      this.promptListBindTimer = null;
    }
    if (this.promptTitleSyncTimer !== null) {
      clearTimeout(this.promptTitleSyncTimer);
      this.promptTitleSyncTimer = null;
    }

    this.stopRouteWatcher?.();
    this.stopRouteWatcher = null;

    // Library multi-select state and any floating UI hosted on document.body.
    if (this.isLibraryMultiSelectMode) {
      this.exitLibraryMultiSelectMode();
    }
    this.removeLibraryOutsideClickHandler();
    try {
      this.libraryMultiSelectHostElement?.remove();
    } catch {}
    this.libraryMultiSelectHostElement = null;
    this.hideLibraryBatchDeleteProgress();

    // Body-appended transient popovers we may have left open.
    try {
      document.querySelector('.gv-folder-confirm-dialog.gv-aistudio-confirm')?.remove();
    } catch {}
    try {
      document.querySelector('.gv-folder-menu.gv-aistudio-folder-menu')?.remove();
    } catch {}

    // Un-hide any /library rows we hid; with the feature off nothing would restore them.
    try {
      document
        .querySelectorAll('.gv-conversation-archived')
        .forEach((row) => row.classList.remove('gv-conversation-archived'));
    } catch {}

    // Injected DOM. Resetting container/flags lets initializeFolderUI() re-init cleanly.
    try {
      this.container?.remove();
    } catch {}
    this.container = null;
    this.libraryShortcutBtn = null;
    this.historyRoot = null;
    this.libraryDropZoneInjected = false;
    try {
      document.getElementById('gv-aistudio-folder-styles')?.remove();
    } catch {}
    try {
      document.documentElement.classList.remove('gv-aistudio-root');
    } catch {}
  }

  /**
   * Attempt to recover data when load() fails
   * Uses multi-layer backup system: primary > emergency > beforeUnload > in-memory
   */
  private attemptDataRecovery(_error: unknown): void {
    console.warn('[AIStudioFolderManager] Attempting data recovery after load failure');

    // Step 1: Try to restore from localStorage backups (primary, emergency, beforeUnload)
    const recovered = this.backupService.recoverFromBackup();
    if (recovered && validateFolderData(recovered)) {
      this.data = recovered;
      console.warn('[AIStudioFolderManager] Data recovered from localStorage backup');
      this.showNotification('Folder data recovered from backup', 'warning');
      // Try to save recovered data to persistent storage
      this.save();
      return;
    }

    // Step 2: Keep existing in-memory data if it exists and is valid
    if (validateFolderData(this.data) && this.data.folders.length > 0) {
      console.warn('[AIStudioFolderManager] Keeping existing in-memory data after load error');
      this.showErrorNotification('Failed to load folder data, using cached version');
      return;
    }

    // Step 3: Last resort - initialize empty data and notify user
    console.error('[AIStudioFolderManager] All recovery attempts failed, initializing empty data');
    this.data = { folders: [], folderContents: {} };
    this.showErrorNotification('Failed to load folder data. All folders have been reset.');
  }

  /**
   * Show an error notification to the user
   * @deprecated Use showNotification() instead for better level support
   */
  private showErrorNotification(message: string): void {
    this.showNotification(message, 'error');
  }

  /**
   * Show a notification to the user with customizable level
   */
  private showNotification(message: string, level: 'info' | 'warning' | 'error' = 'error'): void {
    try {
      const notification = document.createElement('div');
      notification.className = `gv-notification gv-notification-${level}`;
      notification.textContent = `[Gemini Voyager] ${message}`;

      // Color based on level
      const colors = {
        info: '#2196F3',
        warning: '#FF9800',
        error: '#f44336',
      };

      // Apply inline styles for visibility
      const style = notification.style;
      style.position = 'fixed';
      style.top = '20px';
      style.right = '20px';
      style.padding = '12px 20px';
      style.background = colors[level];
      style.color = 'white';
      style.borderRadius = '4px';
      style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
      style.zIndex = String(2147483647);
      style.maxWidth = '400px';
      style.fontSize = '14px';
      style.fontFamily = 'system-ui, -apple-system, sans-serif';
      style.lineHeight = '1.4';

      document.body.appendChild(notification);

      // Auto-remove after timeout (longer for errors/warnings)
      const timeout =
        level === 'info' ? 3000 : level === 'warning' ? 7000 : NOTIFICATION_TIMEOUT_MS;
      setTimeout(() => {
        try {
          document.body.removeChild(notification);
        } catch {
          // Element might already be removed
        }
      }, timeout);
    } catch (notificationError) {
      console.error('[AIStudioFolderManager] Failed to show notification:', notificationError);
    }
  }

  /**
   * Check if extension context is valid
   */
  private isExtensionContextValid(): boolean {
    try {
      // Try to access chrome.runtime.id to check if context is valid
      return !!(browser?.runtime?.id || chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Load sidebar width from storage (with localStorage fallback)
   */
  private async loadSidebarWidth(): Promise<void> {
    try {
      // Try chrome.storage.sync first
      if (this.isExtensionContextValid()) {
        const result = await browser.storage.sync.get({ [this.SIDEBAR_WIDTH_KEY]: 280 });
        const width = result[this.SIDEBAR_WIDTH_KEY];
        if (
          typeof width === 'number' &&
          width >= this.MIN_SIDEBAR_WIDTH &&
          width <= this.MAX_SIDEBAR_WIDTH
        ) {
          this.sidebarWidth = width;
          return;
        }
      }
    } catch (error) {
      console.warn(
        '[AIStudioFolderManager] Failed to load from sync storage, trying localStorage:',
        error,
      );
    }

    // Fallback to localStorage
    try {
      const stored = localStorage.getItem(this.SIDEBAR_WIDTH_KEY);
      if (stored) {
        const width = parseInt(stored, 10);
        if (
          typeof width === 'number' &&
          width >= this.MIN_SIDEBAR_WIDTH &&
          width <= this.MAX_SIDEBAR_WIDTH
        ) {
          this.sidebarWidth = width;
        }
      }
    } catch (error) {
      console.error(
        '[AIStudioFolderManager] Failed to load sidebar width from localStorage:',
        error,
      );
    }
  }

  /**
   * Save sidebar width to storage (with localStorage fallback)
   */
  private async saveSidebarWidth(): Promise<void> {
    // Always save to localStorage as immediate backup
    try {
      localStorage.setItem(this.SIDEBAR_WIDTH_KEY, String(this.sidebarWidth));
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to save to localStorage:', error);
    }

    // Try to save to chrome.storage.sync if context is valid
    if (this.isExtensionContextValid()) {
      try {
        await browser.storage.sync.set({ [this.SIDEBAR_WIDTH_KEY]: this.sidebarWidth });
      } catch (error) {
        // Silent fail if extension context is invalidated (happens during dev reload)
        if (error instanceof Error && !error.message.includes('Extension context invalidated')) {
          console.error('[AIStudioFolderManager] Failed to save sidebar width:', error);
        }
      }
    }
  }

  /**
   * Apply sidebar width to the navbar element (only when expanded)
   */
  private applySidebarWidth(force: boolean = false): void {
    // Target the actual nav-content div, not the outer ms-navbar
    const navContent = document.querySelector('.nav-content.v3-left-nav') as HTMLElement | null;
    if (!navContent) return;

    // Check if sidebar is expanded by looking at the 'expanded' class
    const isExpanded = navContent.classList.contains('expanded');

    if (isExpanded || force) {
      navContent.style.width = `${this.sidebarWidth}px`;
      navContent.style.minWidth = `${this.sidebarWidth}px`;
      navContent.style.maxWidth = `${this.sidebarWidth}px`;
      navContent.style.flex = `0 0 ${this.sidebarWidth}px`;
    } else {
      // Remove our width overrides when collapsed to allow native behavior
      navContent.style.width = '';
      navContent.style.minWidth = '';
      navContent.style.maxWidth = '';
      navContent.style.flex = '';
    }
  }

  /**
   * Add a draggable resize handle to adjust sidebar width
   */
  private addResizeHandle(): void {
    // Target the actual nav-content div
    const navContent = document.querySelector('.nav-content.v3-left-nav') as HTMLElement | null;
    if (!navContent) {
      console.warn('[AIStudioFolderManager] nav-content not found, resize handle not added');
      return;
    }

    // Create resize handle
    const handle = document.createElement('div');
    handle.className = 'gv-sidebar-resize-handle';
    handle.title = 'Drag to resize sidebar';

    // Position it at the right edge of the nav-content with inline styles
    const handleStyle = handle.style;
    handleStyle.position = 'absolute';
    handleStyle.top = '0';
    handleStyle.right = '-4px'; // Position at right edge, overlapping slightly outside
    handleStyle.width = '8px';
    handleStyle.height = '100%';
    handleStyle.cursor = 'ew-resize';
    handleStyle.zIndex = '10000';
    handleStyle.backgroundColor = 'transparent';
    handleStyle.transition = 'background-color 0.2s';
    handleStyle.pointerEvents = 'auto';

    // Hover effect
    handle.addEventListener('mouseenter', () => {
      handleStyle.backgroundColor = 'rgba(66, 133, 244, 0.5)';
    });
    handle.addEventListener('mouseleave', () => {
      handleStyle.backgroundColor = 'transparent';
    });

    // Dragging logic
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = this.sidebarWidth;
      e.preventDefault();
      e.stopPropagation();

      // Add dragging class for visual feedback
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const delta = e.clientX - startX;
      const newWidth = Math.max(
        this.MIN_SIDEBAR_WIDTH,
        Math.min(this.MAX_SIDEBAR_WIDTH, startWidth + delta),
      );

      this.sidebarWidth = newWidth;
      this.applySidebarWidth(true); // Force apply during drag

      // Handle position is relative, no need to update during drag
    };

    const handleMouseUp = () => {
      if (!isDragging) return;

      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Save the new width
      this.saveSidebarWidth();
    };

    handle.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Ensure nav-content has position relative for absolute handle positioning
    navContent.style.position = 'relative';

    // Add to nav-content for correct positioning
    navContent.appendChild(handle);

    // Update handle visibility when sidebar state changes
    const updateHandleVisibility = () => {
      const isExpanded = navContent.classList.contains('expanded');

      if (isExpanded) {
        handleStyle.display = 'block';
      } else {
        handleStyle.display = 'none'; // Hide when collapsed
      }
    };

    // Monitor sidebar state changes by watching the 'expanded' class
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          updateHandleVisibility();
          this.applySidebarWidth(); // Reapply width based on current state
          break;
        }
      }
    });

    try {
      observer.observe(navContent, {
        attributes: true,
        attributeFilter: ['class'],
      });
    } catch (error) {
      console.error('[AIStudioFolderManager] Failed to observe nav-content:', error);
    }

    // Initial visibility update
    updateHandleVisibility();

    this.cleanupFns.push(() => {
      try {
        observer.disconnect();
        handle.removeEventListener('mousedown', handleMouseDown);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        if (handle.parentElement) {
          handle.parentElement.removeChild(handle);
        }
      } catch {}
    });
  }

  /**
   * Handle cloud upload - upload folder data and prompts to Google Drive
   * This mirrors the logic in CloudSyncSettings.tsx handleSyncNow()
   * Note: AI Studio uses its own folder file but shares prompts with Gemini
   */
  private async handleCloudUpload(): Promise<void> {
    try {
      this.showNotification(this.t('uploadInProgress'), 'info');

      // Get current folder data
      const folders = this.data;

      // Get prompts from storage (shared with Gemini)
      let prompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          prompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[AIStudioFolderManager] Could not get prompts for upload:', err);
      }

      console.log(
        `[AIStudioFolderManager] Uploading - folders: ${folders.folders?.length || 0}, prompts: ${prompts.length}`,
      );

      // Send upload request to background script
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.upload',
        payload: {
          folders,
          prompts,
          platform: 'aistudio',
          accountScope: this.toSyncAccountScope(this.accountScope),
        },
      })) as { ok?: boolean; error?: string } | undefined;

      if (response?.ok) {
        this.showNotification(this.t('uploadSuccess'), 'info');
      } else {
        const errorMsg = response?.error || 'Unknown error';
        this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AIStudioFolderManager] Cloud upload failed:', error);
      this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
    }
  }

  /**
   * Handle cloud sync - download and merge folder data and prompts from Google Drive
   * This mirrors the logic in CloudSyncSettings.tsx handleDownloadFromDrive()
   * Note: AI Studio uses its own folder file but shares prompts with Gemini
   */
  private async handleCloudSync(): Promise<void> {
    try {
      this.showNotification(this.t('downloadInProgress'), 'info');

      // Send download request to background script
      const response = (await browser.runtime.sendMessage({
        type: 'gv.sync.download',
        payload: {
          platform: 'aistudio',
          accountScope: this.toSyncAccountScope(this.accountScope),
        },
      })) as
        | {
            ok?: boolean;
            error?: string;
            data?: {
              folders?: { data?: FolderData };
              prompts?: { items?: PromptItem[] };
            };
          }
        | undefined;

      if (!response?.ok) {
        const errorMsg = response?.error || 'Download failed';
        this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
        return;
      }

      if (!response.data) {
        this.showNotification(this.t('syncNoData') || 'No data in cloud', 'info');
        return;
      }

      // Extract cloud data
      const cloudFoldersPayload = response.data?.folders;
      const cloudPromptsPayload = response.data?.prompts;
      const cloudFolderData = cloudFoldersPayload?.data || { folders: [], folderContents: {} };
      const cloudPromptItems = cloudPromptsPayload?.items || [];

      console.log(
        `[AIStudioFolderManager] Downloaded - folders: ${cloudFolderData.folders?.length || 0}, prompts: ${cloudPromptItems.length}`,
      );

      // Get local prompts for merge (shared with Gemini)
      let localPrompts: PromptItem[] = [];
      try {
        const storageResult = await chrome.storage.local.get(['gvPromptItems']);
        if (storageResult.gvPromptItems) {
          localPrompts = storageResult.gvPromptItems as PromptItem[];
        }
      } catch (err) {
        console.warn('[AIStudioFolderManager] Could not get local prompts for merge:', err);
      }

      // Merge folder data
      const localFolders = this.data;
      const mergedFolders = mergeSyncedFolderData(localFolders, cloudFolderData);

      // Merge prompts (simple ID-based merge)
      const mergedPrompts = this.mergePromptsData(localPrompts, cloudPromptItems);

      console.log(
        `[AIStudioFolderManager] Merged - folders: ${mergedFolders.folders?.length || 0}, prompts: ${mergedPrompts.length}`,
      );

      // Apply merged folder data
      this.data = mergedFolders;
      await this.save();

      // Save merged prompts to storage (shared with Gemini)
      try {
        await chrome.storage.local.set({
          gvPromptItems: mergedPrompts,
        });
      } catch (err) {
        console.error('[AIStudioFolderManager] Failed to save merged prompts:', err);
      }

      this.render();
      this.showNotification(this.t('downloadMergeSuccess'), 'info');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AIStudioFolderManager] Cloud sync failed:', error);
      this.showNotification(this.t('syncError').replace('{error}', errorMsg), 'error');
    }
  }

  /**
   * Merge prompts through the shared sync policy so legacy cloud records
   * cannot erase names that exist only in local storage.
   */
  private mergePromptsData(local: PromptItem[], cloud: PromptItem[]): PromptItem[] {
    return mergeSyncedPrompts(local, cloud);
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
      console.warn('[AIStudioFolderManager] Failed to get sync state for tooltip:', e);
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
      console.warn('[AIStudioFolderManager] Failed to get sync state for tooltip:', e);
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

export async function startAIStudioFolderManager(): Promise<void> {
  try {
    const mgr = new AIStudioFolderManager();
    await mgr.init();
  } catch (e) {
    console.error('[AIStudioFolderManager] Start error:', e);
  }
}
