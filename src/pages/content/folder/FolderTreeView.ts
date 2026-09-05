import browser from 'webextension-polyfill';

import { createBellIcon } from '@/core/icons/bellIcon';
import { CLOUD_SYNC_PATH, CLOUD_UPLOAD_PATH } from '@/core/icons/cloudSyncPaths';
import {
  createChevronDownIcon,
  createChevronRightIcon,
  createCloudIcon,
  createFolderIcon,
  createPlusIcon,
  createSettingsIcon,
  createStarIcon,
  createUserRoundIcon,
} from '@/core/icons/folderIcons';
import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import {
  type ConversationSortMode,
  getFolderDepth,
  sortConversationsByPriority,
  sortFolders,
} from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import { hasSeenCoachmark, markCoachmarkSeen } from '../coachmark';
import type { FolderFeedback } from './FolderFeedback';
import type { FolderNavigation } from './FolderNavigation';
import type { FolderSelection } from './FolderSelection';
import type { FolderSidebarRuntime } from './FolderSidebarRuntime';
import type { FolderStore } from './FolderStore';
import type { FolderTransferController } from './FolderTransferController';
import {
  ACTIVITY_PRIORITY_WINDOW_MS,
  type ConversationActivityGroup,
  type ConversationActivityItem,
  type FolderViewMode,
  buildConversationActivityGroups,
  formatActivityFolderSummary,
} from './activityView';
import { getFolderColor, isDarkMode } from './folderColors';
import type { FolderDialogs } from './folderDialogs';
import { DEFAULT_CONVERSATION_ICON, getGemIcon } from './gemConfig';
import type { createFolderHeaderMenus } from './headerMenus';
import {
  buildNativeConversationTitleMap,
  lookupNativeConversationTitle,
  syncConversationTitleFromNative,
} from './nativeSidebarDom';
import type { ConversationReference, Folder } from './types';

const ROOT_CONVERSATIONS_ID = '__root_conversations__';

const FOLDER_TREE_INDENT_MIN = -8;

const FOLDER_TREE_INDENT_MAX = 32;

const FOLDER_TREE_INDENT_DEFAULT = -8;

const MAX_FOLDER_DEPTH = 1;

const FOLDER_NAME_SINGLE_CLICK_DELAY_MS = 220;

const FOLDER_SEARCH_DEBOUNCE_MS = 200;

const FOLDER_ONLY_SEARCH_HINT_ID = 'folder-only-search-prefix-hint';

function clampFolderTreeIndent(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return FOLDER_TREE_INDENT_DEFAULT;
  return Math.min(FOLDER_TREE_INDENT_MAX, Math.max(FOLDER_TREE_INDENT_MIN, Math.round(numeric)));
}

function calculateFolderHeaderPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 8);
}

function calculateFolderConversationPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 24);
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

interface FolderTreeViewOptions {
  store: FolderStore;
  runtime: FolderSidebarRuntime;
  selection: FolderSelection;
  navigation: FolderNavigation;
  feedback: FolderFeedback;
  dialogs: FolderDialogs;
  transfer: FolderTransferController;
  headerMenus: ReturnType<typeof createFolderHeaderMenus>;
  getContext(): { enabled: boolean; hideArchivedConversations: boolean; isDestroyed: boolean };
  onRefresh(): void;
  onRenameNative(conversation: ConversationReference): Promise<boolean>;
  onSortModeChange(mode: ConversationSortMode): void;
}

function debug(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') console[level]('[FolderManager]', ...args);
  } catch {
    /* Debugging must not affect rendering. */
  }
}

/** Renders the folder tree and activity view, and owns their local preferences and editors. */
export class FolderTreeView {
  private foldersCollapsed: boolean = false;
  private folderProjectEnabled: boolean = false;
  private folderTreeIndent: number = FOLDER_TREE_INDENT_DEFAULT;
  private filterCurrentUserOnly: boolean = false;
  private folderSearchEnabled: boolean = true;
  private folderSearchQuery: string = '';
  private folderOnlySearchHintSeen: boolean = false;
  private conversationSortMode: ConversationSortMode = 'manual';
  private folderViewMode: FolderViewMode = 'folders';
  private folderNameClickTimeout: number | null = null;
  private folderSearchDebounceTimer: number | null = null;
  private activityPriorityRefreshTimer: number | null = null;
  private nativeTitleLookup: Map<string, string> | null = null;

  constructor(private readonly options: FolderTreeViewOptions) {}

  get sortMode(): ConversationSortMode {
    return this.conversationSortMode;
  }
  get viewMode(): FolderViewMode {
    return this.folderViewMode;
  }

  async loadSettings(): Promise<void> {
    await this.loadFoldersCollapsedSetting();
    await this.loadFilterUserSetting();
    await this.loadFolderSearchEnabledSetting();
    await this.loadFolderOnlySearchHintState();
    await this.loadFolderTreeIndentSetting();
    await this.loadFolderProjectEnabledSetting();
    await this.loadConversationSortModeSetting();
  }

  mount(): void {
    this.applyFoldersCollapsedState();
    this.applyFolderViewModeState();
  }

  unmount(): void {
    this.clearPendingFolderNameClick();
    this.clearFolderSearchDebounceTimer();
    this.clearActivityPriorityRefreshTimer();
    this.options.dialogs.closeInline();
  }

  clearRenderContext(): void {
    this.nativeTitleLookup = null;
    this.unmount();
    this.applyUserFilterButtonState();
  }

  applySettings(changes: Record<string, browser.Storage.StorageChange>, area: string): void {
    if (area === 'sync') {
      if (changes[StorageKeys.GV_FOLDER_TREE_INDENT])
        this.applyFolderTreeIndentSetting(changes[StorageKeys.GV_FOLDER_TREE_INDENT].newValue);
      if (changes[StorageKeys.FOLDER_SEARCH_ENABLED])
        this.applyFolderSearchEnabledSetting(changes[StorageKeys.FOLDER_SEARCH_ENABLED].newValue);
      if (changes[StorageKeys.FOLDER_PROJECT_ENABLED])
        this.folderProjectEnabled = changes[StorageKeys.FOLDER_PROJECT_ENABLED].newValue === true;
      if (changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE])
        this.applyConversationSortMode(changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE].newValue);
    }
    if (area === 'local' && changes[StorageKeys.FOLDERS_COLLAPSED]) {
      const next = changes[StorageKeys.FOLDERS_COLLAPSED].newValue === true;
      if (next !== this.foldersCollapsed) {
        this.foldersCollapsed = next;
        this.applyFoldersCollapsedState();
      }
    }
    if (area === 'local' && changes[StorageKeys.FOLDERS_VIEW_MODE]) {
      const next =
        changes[StorageKeys.FOLDERS_VIEW_MODE].newValue === 'activity' ? 'activity' : 'folders';
      if (next !== this.folderViewMode) {
        this.folderViewMode = next;
        this.applyFolderViewModeState();
        this.options.onRefresh();
      }
    }
    if (changes[StorageKeys.LANGUAGE]) this.refreshLanguage();
  }

  createPanel(): HTMLElement {
    // Create folder container
    const panel = document.createElement('div');
    panel.className = 'gv-folder-container';

    // Create multi-select mode indicator
    const indicator = this.options.selection.createMultiSelectIndicator();
    panel.appendChild(indicator);

    // Create header
    const header = this.createHeader();
    panel.appendChild(header);

    if (this.folderSearchEnabled) {
      const search = this.createFolderSearch();
      panel.appendChild(search);
    }

    // Create folders list
    const foldersList = this.createFoldersList();
    panel.appendChild(foldersList);
    return panel;
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'gv-folder-header';

    // Match the style of Recent section title
    const titleContainer = document.createElement('div');
    titleContainer.className = 'title-container';

    const title = document.createElement('h1');
    title.className = 'title gds-label-l'; // Match Recent section style
    title.textContent = t('folder_title');
    title.style.visibility = 'visible';

    const collapseButton = document.createElement('button');
    collapseButton.className = 'gv-folder-section-toggle';
    collapseButton.type = 'button';
    collapseButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void this.toggleFoldersCollapsed();
    });
    collapseButton.replaceChildren(createChevronDownIcon(16));

    titleContainer.appendChild(title);
    titleContainer.appendChild(collapseButton);

    // Actions container for buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-folder-header-actions';

    // Activity is a read-only projection over the same folder data. The bell
    // occupies the old section-hider eye slot while the left chevron remains
    // the single collapse control.
    const activityButton = document.createElement('button');
    activityButton.className = 'gv-folder-action-btn gv-folder-activity-toggle';
    activityButton.type = 'button';
    activityButton.replaceChildren(createBellIcon(18));
    activityButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.toggleFolderViewMode();
    });
    actionsContainer.appendChild(activityButton);

    // Filter current user button
    const filterUserButton = document.createElement('button');
    filterUserButton.className = 'gv-folder-action-btn gv-folder-user-filter-toggle';
    filterUserButton.type = 'button';
    filterUserButton.replaceChildren(createUserRoundIcon(18));
    filterUserButton.title = t('folder_filter_current_user');
    filterUserButton.setAttribute('aria-label', t('folder_filter_current_user'));
    filterUserButton.setAttribute('aria-pressed', String(this.filterCurrentUserOnly));
    filterUserButton.hidden = this.options.store.accountIsolationEnabled;
    // Apply active state if filter is enabled
    if (this.filterCurrentUserOnly) {
      filterUserButton.classList.add('gv-filter-active');
    }
    filterUserButton.addEventListener('click', () => this.toggleFilterCurrentUser());

    // Import/Export combined button (shows dropdown menu)
    const importExportButton = document.createElement('button');
    importExportButton.className = 'gv-folder-action-btn gv-folder-import-export-btn';
    importExportButton.type = 'button';
    importExportButton.replaceChildren(createFolderIcon(18));
    importExportButton.title = t('folder_import_export');
    importExportButton.setAttribute('aria-label', t('folder_import_export'));
    importExportButton.addEventListener('click', (event) => {
      this.options.headerMenus.openActions(event, [
        {
          label: t('folder_import'),
          icon: 'upload',
          action: () => this.options.transfer.showImportDialog(),
        },
        {
          label: t('folder_export'),
          icon: 'download',
          action: () => this.options.transfer.exportFolders(),
        },
      ]);
    });

    actionsContainer.appendChild(filterUserButton);
    actionsContainer.appendChild(importExportButton);

    // Cloud popover (single button → menu with Upload + Sync). Skipped on Safari.
    if (!isSafari()) {
      const cloudButton = document.createElement('button');
      cloudButton.className = 'gv-folder-action-btn gv-folder-cloud-btn';
      cloudButton.type = 'button';
      cloudButton.replaceChildren(createCloudIcon(18));
      cloudButton.title = t('folder_cloud');
      cloudButton.setAttribute('aria-label', t('folder_cloud'));
      cloudButton.addEventListener('click', (event) => {
        // Gemini's bundled symbol font lacks these cloud glyphs.
        this.options.headerMenus.openActions(event, [
          {
            label: t('folder_cloud_upload'),
            iconHtml: `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="${CLOUD_UPLOAD_PATH}"/></svg>`,
            action: () => {
              void this.options.transfer.upload();
            },
          },
          {
            label: t('folder_cloud_sync'),
            iconHtml: `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="${CLOUD_SYNC_PATH}"/></svg>`,
            action: () => {
              void this.options.transfer.sync();
            },
          },
        ]);
      });
      actionsContainer.appendChild(cloudButton);
    }

    // Folder settings (conversation order, font size, spacing, and indentation).
    const settingsButton = document.createElement('button');
    settingsButton.className = 'gv-folder-action-btn gv-folder-settings-btn';
    settingsButton.type = 'button';
    settingsButton.replaceChildren(createSettingsIcon(18));
    settingsButton.title = t('folder_settings');
    settingsButton.setAttribute('aria-label', t('folder_settings'));
    settingsButton.addEventListener('click', (event) => {
      this.options.headerMenus.openSettings(event, this.conversationSortMode, (mode) => {
        this.setConversationSortMode(mode);
      });
    });
    actionsContainer.appendChild(settingsButton);

    // Add folder button
    const addButton = document.createElement('button');
    addButton.className = 'gv-folder-add-btn';
    addButton.type = 'button';
    addButton.replaceChildren(createPlusIcon(18));
    addButton.title = t('folder_create');
    addButton.setAttribute('aria-label', t('folder_create'));
    addButton.addEventListener('click', () => this.createFolder());

    actionsContainer.appendChild(addButton);

    header.appendChild(titleContainer);
    header.appendChild(actionsContainer);

    // Setup root drop zone on header
    this.options.selection.setupRootDropZone(header);

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
        this.options.onRefresh();
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
    const baseLabel = t('folder_search_placeholder');
    const modeLabel = t('folder_search_mode_folder');

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
    input.placeholder = t('folder_search_placeholder');
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

    if (this.folderViewMode === 'activity') {
      list.classList.add('gv-folder-activity-list');
      return this.populateActivityList(list, isSearchActive);
    }
    this.clearActivityPriorityRefreshTimer();

    // Native-title sync used to scan the whole sidebar once PER stored
    // conversation (O(M×N) per render). Build one lookup table per render
    // pass instead; `createConversationElement` consults it while this field
    // is non-null. Search-triggered renders (and hide-archived mode, where the
    // per-conversation guard skips syncing anyway) use an empty table so they
    // skip the sidebar scan entirely.
    this.nativeTitleLookup =
      !this.options.getContext().hideArchivedConversations && !isSearchActive
        ? buildNativeConversationTitleMap()
        : new Map();
    try {
      return this.populateFoldersList(list, isSearchActive);
    } finally {
      this.nativeTitleLookup = null;
    }
  }

  private populateActivityList(list: HTMLElement, isSearchActive: boolean): HTMLElement {
    const matches = (conversation: ConversationReference, folderPaths: string[]): boolean => {
      if (this.filterConversationsByCurrentUser([conversation]).length === 0) return false;
      if (!isSearchActive) return true;

      if (this.isFolderOnlySearchActive()) {
        return folderPaths.some((path) => this.matchesFolderSearchText(path));
      }
      return (
        this.matchesFolderSearchText(conversation.title) ||
        folderPaths.some((path) => this.matchesFolderSearchText(path))
      );
    };

    const groups = buildConversationActivityGroups(this.options.store.data, {
      rootLabel: t('folder_activity_top_level'),
      matches,
    });
    this.scheduleActivityPriorityRefresh(groups);

    if (groups.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'gv-folder-empty gv-folder-activity-empty';
      emptyState.textContent = t(isSearchActive ? 'folder_search_empty' : 'folder_activity_empty');
      list.appendChild(emptyState);
      return list;
    }

    groups.forEach((group) => {
      const section = document.createElement('section');
      section.className = `gv-folder-activity-group gv-folder-activity-group-${group.id}`;

      const heading = document.createElement('h2');
      heading.className = 'gv-folder-activity-heading';
      heading.id = `gv-folder-activity-${group.id}`;
      heading.textContent = this.formatActivityGroupHeading(group);
      section.setAttribute('aria-labelledby', heading.id);
      section.appendChild(heading);

      group.items.forEach((item) => {
        section.appendChild(this.createActivityConversationElement(item));
      });
      list.appendChild(section);
    });

    return list;
  }

  private clearActivityPriorityRefreshTimer(): void {
    if (this.activityPriorityRefreshTimer === null) return;
    window.clearTimeout(this.activityPriorityRefreshTimer);
    this.activityPriorityRefreshTimer = null;
  }

  private scheduleActivityPriorityRefresh(groups: readonly ConversationActivityGroup[]): void {
    this.clearActivityPriorityRefreshTimer();
    if (this.folderViewMode !== 'activity') return;

    const priorityGroup = groups.find((group) => group.id === 'priority');
    const nextExpiry = priorityGroup?.items.reduce<number | null>((earliest, item) => {
      if (!item.lastTurnAt || !Number.isFinite(item.lastTurnAt)) return earliest;
      const expiry = item.lastTurnAt + ACTIVITY_PRIORITY_WINDOW_MS;
      return earliest === null ? expiry : Math.min(earliest, expiry);
    }, null);
    if (nextExpiry === null || nextExpiry === undefined) return;

    const delay = Math.max(1, nextExpiry - Date.now() + 1);
    this.activityPriorityRefreshTimer = window.setTimeout(() => {
      this.activityPriorityRefreshTimer = null;
      if (this.options.getContext().isDestroyed || this.folderViewMode !== 'activity') return;
      this.options.onRefresh();
    }, delay);
  }

  private createActivityConversationElement(item: ConversationActivityItem): HTMLElement {
    const { conversation } = item;
    const row = document.createElement('div');
    row.className = item.starred
      ? 'gv-folder-conversation gv-folder-activity-item gv-starred'
      : 'gv-folder-conversation gv-folder-activity-item';
    row.dataset.conversationId = conversation.conversationId;
    row.dataset.folderId = item.sourceFolderId;

    const link = document.createElement('a');
    link.className = 'gv-folder-conversation-link gv-folder-activity-link';
    link.href = this.options.navigation.getConversationHref(conversation);
    link.draggable = false;

    const text = document.createElement('span');
    text.className = 'gv-folder-activity-text';

    const title = document.createElement('span');
    title.className = 'gv-conversation-title gds-label-l';
    title.textContent = conversation.title;

    const folderSummary = formatActivityFolderSummary(item.folderContexts);
    const folderPaths = item.folderContexts.map((folder) => folder.path).join('\n');
    const context = document.createElement('span');
    context.className = 'gv-folder-activity-context';
    context.textContent = folderSummary;
    context.setAttribute('aria-label', folderPaths);
    context.addEventListener('mouseenter', () =>
      this.options.feedback.showTooltip(context, folderPaths, true),
    );
    context.addEventListener('mouseleave', () => this.options.feedback.hideTooltip());
    link.addEventListener('focus', () =>
      this.options.feedback.showTooltip(context, folderPaths, true),
    );
    link.addEventListener('blur', () => this.options.feedback.hideTooltip());

    text.append(title, context);
    link.appendChild(text);

    const timeLabel = this.formatActivityTimestamp(item.lastTurnAt);
    if (timeLabel) {
      const time = document.createElement('time');
      time.className = 'gv-folder-activity-time';
      time.dateTime = new Date(item.lastTurnAt!).toISOString();
      time.textContent = timeLabel;
      time.title = new Date(item.lastTurnAt!).toLocaleString();
      row.appendChild(time);
    }

    const starButton = document.createElement('button');
    starButton.className = item.starred
      ? 'gv-conversation-star-btn starred'
      : 'gv-conversation-star-btn';
    starButton.type = 'button';
    starButton.replaceChildren(createStarIcon(18, item.starred));
    starButton.title = item.starred ? t('conversation_unstar') : t('conversation_star');
    starButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.options.store.setConversationStarAcrossFolders(
        conversation.conversationId,
        !item.starred,
      );
    });

    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.navigateToConversationById(item.sourceFolderId, conversation.conversationId);
    });
    title.addEventListener('mouseenter', () =>
      this.options.feedback.showTooltip(title, conversation.title),
    );
    title.addEventListener('mouseleave', () => this.options.feedback.hideTooltip());
    title.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.options.onRenameNative(conversation);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.dialogs.openMenu(
        event,
        [
          {
            label: t('folder_rename'),
            action: () => {
              void this.options.onRenameNative(conversation);
            },
          },
        ],
        'conversation',
      );
    });

    row.prepend(link);
    row.appendChild(starButton);
    return row;
  }

  private formatActivityGroupHeading(group: ConversationActivityGroup): string {
    if (group.id === 'priority') return t('folder_activity_priority');
    if (group.id === 'today') return t('folder_activity_today');
    if (group.id === 'yesterday') return t('folder_activity_yesterday');
    if (!group.dayStart) return '';

    return new Date(group.dayStart).toLocaleDateString([], { weekday: 'long' });
  }

  private formatActivityTimestamp(timestamp: number | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp)) return '';

    const date = new Date(timestamp);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  private populateFoldersList(list: HTMLElement, isSearchActive: boolean): HTMLElement {
    let renderedItems = 0;

    // Setup root-level drop zone for dragging folders and conversations to root
    this.options.selection.setupRootDropZone(list);

    // Render root-level conversations (favorites/pinned conversations)
    const rootConversations = this.options.store.data.folderContents[ROOT_CONVERSATIONS_ID] || [];
    const filteredRootConversations = this.filterVisibleConversations(rootConversations);
    if (filteredRootConversations.length > 0) {
      const sortedRootConversations = sortConversationsByPriority(
        filteredRootConversations,
        this.conversationSortMode,
      );
      const groupIndices = { starred: 0, normal: 0 };
      sortedRootConversations.forEach((conv) => {
        const convEl = this.createConversationElement(conv, ROOT_CONVERSATIONS_ID, 0);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          const group = conv.starred ? 'starred' : 'normal';
          this.options.selection.setupConversationReorderZone(
            convEl,
            ROOT_CONVERSATIONS_ID,
            groupIndices[group]++,
          );
        }
        list.appendChild(convEl);
        renderedItems++;
      });
    }

    // Render root level folders (sorted)
    const rootFolders = this.options.store.data.folders.filter((f) => f.parentId === null);
    const sortedRootFolders = sortFolders(rootFolders);
    let rootFolderIndex = 0;
    if (!isSearchActive) {
      list.appendChild(this.options.selection.createReorderGap('__root__', 'folder', 0));
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
        list.appendChild(
          this.options.selection.createReorderGap('__root__', 'folder', rootFolderIndex),
        );
      }
    });

    // If no folders and no root conversations, show empty state placeholder
    if (renderedItems === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'gv-folder-empty';
      emptyState.textContent = t(isSearchActive ? 'folder_search_empty' : 'folder_empty');
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
    expandBtn.addEventListener('click', () => this.options.store.toggleFolder(folder.id));

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
      this.options.dialogs.openColor(
        folder.id,
        folder.color,
        e,
        (color) => this.options.store.changeFolderColor(folder.id, color),
        true,
      );
    });

    // Folder name
    const folderName = document.createElement('span');
    folderName.className = 'gv-folder-name gds-label-l';
    folderName.textContent = folder.name;
    folderName.style.cursor = 'pointer';
    folderName.addEventListener('click', (event) => this.handleFolderNameClick(folder.id, event));
    folderName.addEventListener('dblclick', () => this.handleFolderNameDoubleClick(folder.id));

    // Add tooltip event listeners
    folderName.addEventListener('mouseenter', () =>
      this.options.feedback.showTooltip(folderName, folder.name),
    );
    folderName.addEventListener('mouseleave', () => this.options.feedback.hideTooltip());

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
    pinBtn.title = folder.pinned ? t('folder_unpin') : t('folder_pin');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.store.togglePinFolder(folder.id);
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
    this.options.selection.setupDropZone(folderHeader, folder.id);

    folderEl.appendChild(folderHeader);

    // Apply draggable behavior dynamically based on current state
    // This ensures draggability is always in sync with folder structure
    this.options.selection.applyFolderDraggableBehavior(folderHeader, folder);

    // Folder content (conversations and subfolders)
    if (isExpanded) {
      const content = document.createElement('div');
      content.className = 'gv-folder-content';
      // Fix: Allow dropping into the content area of the folder (not just the header)
      this.options.selection.setupDropZone(content, folder.id);

      // Render conversations in this folder (sorted: starred first)
      const conversations = this.options.store.data.folderContents[folder.id] || [];
      const filteredConversations = this.filterVisibleConversations(
        conversations,
        includeFolderSubtree,
      );
      const sortedConversations = sortConversationsByPriority(
        filteredConversations,
        this.conversationSortMode,
      );
      const groupIndices = { starred: 0, normal: 0 };
      sortedConversations.forEach((conv) => {
        const convEl = this.createConversationElement(conv, folder.id, level + 1);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          const group = conv.starred ? 'starred' : 'normal';
          this.options.selection.setupConversationReorderZone(
            convEl,
            folder.id,
            groupIndices[group]++,
          );
        }
        content.appendChild(convEl);
      });

      // Render subfolders (sorted)
      const subfolders = this.options.store.data.folders.filter((f) => f.parentId === folder.id);
      const sortedSubfolders = sortFolders(subfolders);
      let subfolderIndex = 0;
      const visibleSubfolders = sortedSubfolders.filter((subfolder) =>
        isSearchActive
          ? includeFolderSubtree
            ? this.hasVisibleContent(subfolder.id)
            : this.matchesFolderSearchTree(subfolder.id)
          : this.hasVisibleContent(subfolder.id),
      );
      if (!isSearchActive && visibleSubfolders.length > 0) {
        content.appendChild(this.options.selection.createReorderGap(folder.id, 'folder', 0));
      }
      visibleSubfolders.forEach((subfolder) => {
        const subfolderEl = this.createFolderElement(subfolder, level + 1, includeFolderSubtree);
        content.appendChild(subfolderEl);
        subfolderIndex++;
        if (!isSearchActive) {
          content.appendChild(
            this.options.selection.createReorderGap(folder.id, 'folder', subfolderIndex),
          );
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
      this.options.store.toggleFolder(folderId);
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
    if (!conv.customTitle && !this.options.getContext().hideArchivedConversations) {
      // Render passes populate `nativeTitleLookup` once up front (see
      // createFoldersList); outside a render pass fall back to the direct scan.
      const syncedTitle = this.nativeTitleLookup
        ? lookupNativeConversationTitle(this.nativeTitleLookup, conv.conversationId)
        : syncConversationTitleFromNative(conv.conversationId);
      if (syncedTitle && syncedTitle !== conv.title) {
        displayTitle = syncedTitle;
        // Buffer title updates during render to avoid multiple rapid saves
        this.options.store.bufferTitleUpdate(conv, syncedTitle);
        debug('log', 'Buffered title update for:', conv.conversationId);
      }
    }

    const link = document.createElement('a');
    link.className = 'gv-folder-conversation-link';
    link.href = this.options.navigation.getConversationHref(conv);
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
    title.addEventListener('mouseenter', () =>
      this.options.feedback.showTooltip(title, displayTitle),
    );
    title.addEventListener('mouseleave', () => this.options.feedback.hideTooltip());

    // Actions container for buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-conversation-actions';

    // Star button
    const starBtn = document.createElement('button');
    starBtn.className = conv.starred
      ? 'gv-conversation-star-btn starred'
      : 'gv-conversation-star-btn';
    starBtn.type = 'button';
    starBtn.replaceChildren(createStarIcon(18, Boolean(conv.starred)));
    starBtn.title = conv.starred ? t('conversation_unstar') : t('conversation_star');
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.store.toggleConversationStar(folderId, conv.conversationId);
    });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'gv-conversation-remove-btn';
    removeBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
    removeBtn.title = t('folder_remove_conversation');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.dialogs.confirmConversationRemoval(displayTitle, e.target as HTMLElement, () => {
        this.options.store.removeConversationFromFolder(folderId, conv.conversationId);
      });
    });

    actionsContainer.appendChild(starBtn);
    actionsContainer.appendChild(removeBtn);

    // Double-click to rename
    title.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.options.onRenameNative(conv);
    });

    convEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.options.dialogs.openMenu(
        e,
        [
          {
            label: t('folder_rename'),
            action: () => {
              void this.options.onRenameNative(conv);
            },
          },
        ],
        'conversation',
      );
    });

    link.appendChild(icon);
    link.appendChild(title);
    convEl.appendChild(link);
    convEl.appendChild(actionsContainer);

    this.options.selection.bindFolderConversation(convEl, link, conv, folderId, displayTitle);
    return convEl;
  }

  private createFolder(parentId: string | null = null): void {
    // Depth cap: subfolder creation stops once the parent is already as deep
    // as MAX_FOLDER_DEPTH allows. The sidebar context menu hides the affordance
    // at this depth, but guard here too so any other caller (imports, cross-
    // module wiring, drag shortcuts) can't silently exceed the cap. Root
    // creation (parentId === null) is always allowed.
    if (
      parentId !== null &&
      getFolderDepth(this.options.store.data, parentId) >= MAX_FOLDER_DEPTH
    ) {
      debug('warn', 'createFolder refused: parent is already at MAX_FOLDER_DEPTH', parentId);
      return;
    }

    this.options.dialogs.openCreate(
      this.options.runtime.panel?.querySelector<HTMLElement>('.gv-folder-list') ?? null,
      parentId,
      (name) => {
        this.options.store.createFolder(name, parentId);
      },
    );
  }

  private renameFolder(folderId: string): void {
    this.clearPendingFolderNameClick();
    const folder = this.options.store.data.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const element =
      this.options.runtime.panel?.querySelector(`[data-folder-id="${folderId}"]`) ?? null;
    this.options.dialogs.openRename(element, folder.name, (name) => {
      this.options.store.renameFolder(folderId, name);
    });
  }

  private deleteFolder(folderId: string, _event?: MouseEvent): void {
    const element =
      this.options.runtime.panel?.querySelector(`[data-folder-id="${folderId}"]`) ?? null;
    this.options.dialogs.confirmFolderRemoval(element, () => {
      this.options.store.removeFolder(folderId);
    });
  }

  private showFolderMenu(event: MouseEvent, folderId: string): void {
    event.stopPropagation();

    const folder = this.options.store.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const menuItems: Array<{ label: string; action: () => void }> = [
      {
        label: folder.pinned ? t('folder_unpin') : t('folder_pin'),
        action: () => this.options.store.togglePinFolder(folderId),
      },
    ];

    // "Create subfolder" only appears when the parent isn't already at the
    // floor of the depth cap. Pre-existing deeper data still renders; we just
    // don't offer a UI path to grow it further.
    if (getFolderDepth(this.options.store.data, folderId) < MAX_FOLDER_DEPTH) {
      menuItems.push({
        label: t('folder_create_subfolder'),
        action: () => this.createFolder(folderId),
      });
    }

    menuItems.push(
      {
        label: t('folder_rename'),
        action: () => this.renameFolder(folderId),
      },
      {
        label: t('folder_change_color'),
        action: () =>
          this.options.dialogs.openColor(folderId, folder.color, event, (color) =>
            this.options.store.changeFolderColor(folderId, color),
          ),
      },
    );

    // Only show instructions editor when Folder-as-Project is enabled
    if (this.folderProjectEnabled) {
      menuItems.push({
        label: t('folder_new_chat_in_folder'),
        action: () => this.options.navigation.createNewChatInFolder(folderId),
      });
      menuItems.push({
        label: folder.instructions
          ? t('folderAsProject_editInstructions')
          : t('folderAsProject_setInstructions'),
        action: () =>
          this.options.dialogs.openInstructions(folder.instructions, async (instructions) => {
            await this.options.store.setFolderInstructions(folderId, instructions);
          }),
      });
    }

    menuItems.push({
      label: t('folder_delete'),
      action: () => this.deleteFolder(folderId),
    });

    this.options.dialogs.openMenu(event, menuItems);
  }

  private navigateToConversationById(folderId: string, conversationId: string): void {
    // Look up the latest conversation data from storage
    const conv = this.options.store.data.folderContents[folderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (!conv) {
      console.error('[FolderManager] Conversation not found:', conversationId);
      return;
    }

    debug('log', 'Navigating to conversation:', {
      title: conv.title,
      url: conv.url,
      isGem: conv.isGem,
      gemId: conv.gemId,
    });

    this.options.navigation.navigate(conv, folderId);
  }

  render(): void {
    if (!this.options.runtime.panel) return;

    // Find the existing folders list
    const existingList = this.options.runtime.panel.querySelector('.gv-folder-list');
    if (!existingList) return;

    // Create a new folders list
    const newList = this.createFoldersList();

    // Replace the old list with the new one
    this.options.dialogs.closeInline();
    existingList.replaceWith(newList);

    debug('log', 'Re-rendered all folders');

    // Ensure active conversation remains highlighted after full re-render
    this.options.navigation.highlightActiveConversation();
  }

  private async loadFoldersCollapsedSetting(): Promise<void> {
    try {
      const result = await browser.storage.local.get({
        [StorageKeys.FOLDERS_COLLAPSED]: false,
        [StorageKeys.FOLDERS_HIDDEN]: false,
        [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
      });
      let legacyHidden = result[StorageKeys.FOLDERS_HIDDEN] === true;
      try {
        legacyHidden ||= localStorage.getItem(StorageKeys.FOLDERS_HIDDEN) === 'true';
      } catch {
        // Local storage is only a legacy fallback and may be unavailable.
      }

      this.foldersCollapsed = legacyHidden || result[StorageKeys.FOLDERS_COLLAPSED] === true;
      this.folderViewMode =
        result[StorageKeys.FOLDERS_VIEW_MODE] === 'activity' ? 'activity' : 'folders';

      if (legacyHidden) {
        await browser.storage.local.set({
          [StorageKeys.FOLDERS_HIDDEN]: false,
          [StorageKeys.FOLDERS_COLLAPSED]: true,
        });
        try {
          localStorage.removeItem(StorageKeys.FOLDERS_HIDDEN);
        } catch {
          // Ignore legacy fallback cleanup failures.
        }
      }
      debug('log', 'Loaded folder collapsed preference:', this.foldersCollapsed);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder collapsed preference:', error);
      this.foldersCollapsed = false;
      this.folderViewMode = 'folders';
    }
  }

  private applyFoldersCollapsedState(): void {
    const container = this.options.runtime.panel;
    if (!container) return;

    container.classList.toggle('gv-folder-collapsed', this.foldersCollapsed);

    const button = container.querySelector<HTMLButtonElement>('.gv-folder-section-toggle');
    if (!button) return;

    const label = t(this.foldersCollapsed ? 'pm_expand' : 'pm_collapse');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!this.foldersCollapsed));

    button.replaceChildren(
      this.foldersCollapsed ? createChevronRightIcon(16) : createChevronDownIcon(16),
    );
  }

  private async toggleFoldersCollapsed(): Promise<void> {
    this.foldersCollapsed = !this.foldersCollapsed;
    this.applyFoldersCollapsedState();

    try {
      await browser.storage.local.set({
        [StorageKeys.FOLDERS_COLLAPSED]: this.foldersCollapsed,
      });
    } catch (error) {
      console.error('[FolderManager] Failed to persist folder collapsed preference:', error);
    }
  }

  private applyFolderViewModeState(): void {
    const container = this.options.runtime.panel;
    if (!container) return;

    const activityMode = this.folderViewMode === 'activity';
    container.classList.toggle('gv-folder-activity-mode', activityMode);

    const button = container.querySelector<HTMLButtonElement>('.gv-folder-activity-toggle');
    if (!button) return;

    const label = t(activityMode ? 'folder_activity_turn_off' : 'folder_activity_turn_on');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(activityMode));
    button.classList.toggle('is-active', activityMode);
  }

  private async toggleFolderViewMode(): Promise<void> {
    this.folderViewMode = this.folderViewMode === 'activity' ? 'folders' : 'activity';

    const update: Record<string, unknown> = {
      [StorageKeys.FOLDERS_VIEW_MODE]: this.folderViewMode,
    };
    if (this.folderViewMode === 'activity' && this.foldersCollapsed) {
      this.foldersCollapsed = false;
      update[StorageKeys.FOLDERS_COLLAPSED] = false;
      this.applyFoldersCollapsedState();
    }

    this.applyFolderViewModeState();
    this.options.onRefresh();

    try {
      await browser.storage.local.set(update);
    } catch (error) {
      console.error('[FolderManager] Failed to persist folder view preference:', error);
    }
  }

  private async loadFilterUserSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: false,
      });
      this.filterCurrentUserOnly = !!result[StorageKeys.GV_FOLDER_FILTER_USER_ONLY];
      debug('log', 'Loaded filter user setting:', this.filterCurrentUserOnly);
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
    if (!this.options.runtime.panel) return;

    this.options.runtime.panel.querySelector('.gv-folder-search')?.remove();

    if (next) {
      const list = this.options.runtime.panel.querySelector('.gv-folder-list');
      this.options.runtime.panel.insertBefore(this.createFolderSearch(), list);
    }

    this.options.onRefresh();
  }

  private async loadFolderTreeIndentSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_TREE_INDENT]: FOLDER_TREE_INDENT_DEFAULT,
      });
      this.folderTreeIndent = clampFolderTreeIndent(result[StorageKeys.GV_FOLDER_TREE_INDENT]);
      debug('log', 'Loaded folder tree indent setting:', this.folderTreeIndent);
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
    this.options.selection.clearConversationReorderIndicator();
    this.options.onRefresh();
    this.options.onSortModeChange(next);
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
    debug('log', 'Folder tree indent changed:', this.folderTreeIndent);

    if (this.options.getContext().enabled && this.options.runtime.panel) {
      this.render();
    }
  }

  refreshLanguage(): void {
    if (!this.options.runtime.panel) return;

    // Update folder title
    const title = this.options.runtime.panel.querySelector('.gv-folder-header .title');
    if (title) {
      title.textContent = t('folder_title');
    }
    this.applyFoldersCollapsedState();
    this.applyFolderViewModeState();

    // Update button tooltips in header actions
    const actionsContainer = this.options.runtime.panel.querySelector('.gv-folder-header-actions');
    if (actionsContainer) {
      const buttons = actionsContainer.querySelectorAll('button');
      buttons.forEach((btn) => {
        const setButtonLabel = (label: string): void => {
          btn.title = label;
          btn.setAttribute('aria-label', label);
        };

        if (btn.classList.contains('gv-folder-add-btn')) {
          setButtonLabel(t('folder_create'));
        } else if (btn.classList.contains('gv-folder-activity-toggle')) {
          // Updated by applyFolderViewModeState above.
        } else if (btn.classList.contains('gv-folder-user-filter-toggle')) {
          setButtonLabel(t('folder_filter_current_user'));
        } else if (btn.classList.contains('gv-folder-import-export-btn')) {
          setButtonLabel(t('folder_import_export'));
        } else if (btn.classList.contains('gv-folder-cloud-btn')) {
          setButtonLabel(t('folder_cloud'));
        } else if (btn.classList.contains('gv-folder-settings-btn')) {
          setButtonLabel(t('folder_settings'));
        }
      });
    }

    const searchInput =
      this.options.runtime.panel.querySelector<HTMLInputElement>('.gv-folder-search-input');
    if (searchInput) {
      const searchContainer = searchInput.closest<HTMLElement>('.gv-folder-search');
      const modeBadge = searchContainer?.querySelector<HTMLElement>('.gv-folder-search-mode-badge');
      if (searchContainer && modeBadge) {
        this.updateFolderSearchInputState(searchContainer, searchInput, modeBadge);
      }
    }

    // Update empty state text if present
    const emptyState = this.options.runtime.panel.querySelector('.gv-folder-empty');
    if (emptyState) {
      emptyState.textContent = t(
        this.isFolderSearchActive() ? 'folder_search_empty' : 'folder_empty',
      );
    }

    // Notebooks corner swap toggle is mounted on the Notebooks section, not
    // inside our container — refresh its tooltip in the now-current locale.
    this.options.runtime.refreshLanguage();

    if (this.folderViewMode === 'activity') {
      this.options.onRefresh();
    }

    debug('log', 'Header language text updated');
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

    const folder = this.options.store.data.folders.find((item) => item.id === folderId);
    if (!folder) return false;
    if (this.matchesFolderSearchText(folder.name) && this.hasVisibleContent(folder.id)) return true;

    const conversations = this.options.store.data.folderContents[folderId] || [];
    if (this.filterVisibleConversations(conversations).length > 0) return true;

    const subfolders = this.options.store.data.folders.filter((item) => item.parentId === folderId);
    return subfolders.some((subfolder) => this.matchesFolderSearchTree(subfolder.id));
  }

  private hasVisibleContent(folderId: string): boolean {
    if (!this.filterCurrentUserOnly) return true;

    // Check direct conversations
    const conversations = this.options.store.data.folderContents[folderId] || [];
    const userConversations = this.filterConversationsByCurrentUser(conversations);
    if (userConversations.length > 0) return true;

    // Check subfolders recursively
    const subfolders = this.options.store.data.folders.filter((f) => f.parentId === folderId);
    for (const subfolder of subfolders) {
      if (this.hasVisibleContent(subfolder.id)) return true;
    }

    // Always show empty folders (no conversations, no subfolders) —
    // the filter hides folders with only other users' content, not empty ones
    if (conversations.length === 0 && subfolders.length === 0) return true;

    return false;
  }

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

  private getCurrentUserId(): string {
    try {
      const path = window.location.pathname;
      const match = path.match(/^\/u\/(\d+)\//);
      return match ? match[1] : '0';
    } catch {
      return '0';
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

  private toggleFilterCurrentUser(): void {
    this.filterCurrentUserOnly = !this.filterCurrentUserOnly;
    debug('log', 'Filter current user only:', this.filterCurrentUserOnly);

    // Save setting to storage
    browser.storage.sync
      .set({
        [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: this.filterCurrentUserOnly,
      })
      .catch((e) => console.error('Failed to save filter user setting:', e));

    // Refresh the entire folder container to update button state and list
    this.applyUserFilterButtonState();

    // Refresh the folders list to apply the filter
    this.options.onRefresh();
  }

  private applyUserFilterButtonState(): void {
    const filterButton = this.options.runtime.panel?.querySelector<HTMLButtonElement>(
      '.gv-folder-user-filter-toggle',
    );
    if (!filterButton) return;

    filterButton.hidden = this.options.store.accountIsolationEnabled;
    filterButton.classList.toggle('gv-filter-active', this.filterCurrentUserOnly);
    filterButton.setAttribute('aria-pressed', String(this.filterCurrentUserOnly));
  }
}
