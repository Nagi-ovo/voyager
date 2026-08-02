import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

import { ACTIVITY_PRIORITY_WINDOW_MS } from '../activityView';
import { FolderManager } from '../manager';
import type { FolderData } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(), set: vi.fn() },
      local: { get: vi.fn(), set: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: 'test-extension-id', lastError: null },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

vi.mock('../floatingPanel', () => ({
  mountFloatingPanel: vi.fn(() => ({ destroy: vi.fn(), update: vi.fn() })),
}));

type TestableManager = {
  accountIsolationEnabled: boolean;
  containerElement: HTMLElement | null;
  data: FolderData;
  folderSearchEnabled: boolean;
  folderViewMode: 'folders' | 'activity';
  foldersCollapsed: boolean;
  recentSection: HTMLElement | null;
  createFolderUI: () => void;
  markConversationLastTurnAt: (conversationId: string, timestamp: number) => void;
  destroy: () => void;
};

const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();

function mountSidebar(): HTMLElement {
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-test-id', 'overflow-container');
  const recents = document.createElement('expandable-section');
  recents.setAttribute('data-test-id', 'chats-expandable-section');
  sidebar.appendChild(recents);
  document.body.appendChild(sidebar);
  return recents;
}

function activityData(): FolderData {
  const recent = NOW - 60_000;
  return {
    folders: [
      {
        id: 'project',
        name: 'Project',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'copy',
        name: 'Copy',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: {
      project: [
        {
          conversationId: 'c_starred',
          title: 'Starred chat',
          url: 'https://gemini.google.com/app/starred',
          addedAt: 1,
          lastTurnAt: NOW - 4 * 60 * 60 * 1000,
          starred: true,
        },
        {
          conversationId: 'c_active',
          title: 'Active chat',
          url: 'https://gemini.google.com/app/active',
          addedAt: 1,
          lastOpenedAt: Date.now(),
          lastTurnAt: recent - 1_000,
        },
      ],
      copy: [
        {
          conversationId: 'active',
          title: 'Active chat',
          url: 'https://gemini.google.com/app/active',
          addedAt: 1,
          lastTurnAt: recent,
        },
        {
          conversationId: 'c_unknown',
          title: 'Legacy chat',
          url: 'https://gemini.google.com/app/unknown',
          addedAt: 1,
          lastOpenedAt: Date.now(),
        },
      ],
    },
  };
}

function nestedMultiFolderActivityData(): FolderData {
  const today = Date.now() - 60_000;
  const conversation = {
    conversationId: 'c_shared',
    title: 'Shared chat',
    url: 'https://gemini.google.com/app/shared',
    addedAt: 1,
    lastTurnAt: today,
  };

  return {
    folders: [
      {
        id: 'parent',
        name: 'Folder tests',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'child',
        name: 'Food diary',
        parentId: 'parent',
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: {
      parent: [conversation],
      child: [{ ...conversation, conversationId: 'shared' }],
    },
  };
}

describe('folder Activity view', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the bell projection with exclusive Priority and deduplicated folder context', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.recentSection = mountSidebar();
    typed.data = activityData();
    typed.folderSearchEnabled = false;
    typed.folderViewMode = 'activity';
    typed.foldersCollapsed = false;
    typed.createFolderUI();

    const container = typed.containerElement;
    const bell = container?.querySelector<HTMLButtonElement>('.gv-folder-activity-toggle');
    expect(bell?.getAttribute('aria-pressed')).toBe('true');
    expect(bell?.classList.contains('is-active')).toBe(true);
    expect(bell?.title).toBe('folder_activity_turn_off');
    const bellIcon = bell?.querySelector<SVGSVGElement>('.lucide-bell');
    expect(bellIcon?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(bellIcon?.getAttribute('stroke-width')).toBe('2');
    expect(bellIcon?.querySelectorAll('path')).toHaveLength(2);
    expect(container?.querySelector('.lucide-user-round')).not.toBeNull();
    expect(container?.querySelector('.lucide-folder')).not.toBeNull();
    expect(container?.querySelector('.lucide-cloud')).not.toBeNull();
    expect(container?.querySelector('.lucide-settings')).not.toBeNull();
    expect(container?.querySelector('.lucide-plus')).not.toBeNull();
    expect(container?.querySelector('.gv-sidebar-section-toggle-btn')).toBeNull();
    expect(container?.querySelectorAll('.gv-folder-activity-item')).toHaveLength(2);
    expect(container?.querySelector('.gv-folder-activity-item .gv-conversation-icon')).toBeNull();
    expect(
      container?.querySelector('.gv-folder-activity-group-priority .lucide-star'),
    ).not.toBeNull();
    expect(
      container
        ?.querySelector('.gv-folder-activity-group-priority .lucide-star')
        ?.getAttribute('fill'),
    ).toBe('none');
    expect(
      container?.querySelectorAll('.gv-folder-activity-group-priority .gv-folder-activity-item'),
    ).toHaveLength(1);
    expect(container?.querySelector('.gv-folder-activity-group-today')?.textContent).toContain(
      'Starred chat',
    );
    expect(
      container
        ?.querySelector('.gv-folder-activity-group-today .lucide-star')
        ?.getAttribute('fill'),
    ).toBe('currentColor');
    expect(container?.textContent).not.toContain('Legacy chat');
    expect(container?.querySelector('.gv-folder-activity-context')?.textContent).toContain(
      'Project',
    );

    bell?.click();
    await Promise.resolve();

    expect(typed.folderViewMode).toBe('folders');
    expect(bell?.title).toBe('folder_activity_turn_on');
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
    });
  });

  it('automatically returns an expired Priority conversation to Today', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.recentSection = mountSidebar();
    typed.data = activityData();
    Object.values(typed.data.folderContents)
      .flat()
      .filter((conversation) => conversation.conversationId.replace(/^c_/, '') === 'active')
      .forEach((conversation) => {
        conversation.lastTurnAt = NOW - ACTIVITY_PRIORITY_WINDOW_MS + 1_000;
      });
    typed.folderSearchEnabled = false;
    typed.folderViewMode = 'activity';
    typed.foldersCollapsed = false;
    typed.createFolderUI();

    expect(
      typed.containerElement?.querySelector('.gv-folder-activity-group-priority')?.textContent,
    ).toContain('Active chat');

    vi.advanceTimersByTime(1_002);

    expect(typed.containerElement?.querySelector('.gv-folder-activity-group-priority')).toBeNull();
    expect(
      typed.containerElement?.querySelector('.gv-folder-activity-group-today')?.textContent,
    ).toContain('Active chat');
  });

  it('shows leaf folder names while preserving full multi-folder paths for context', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.recentSection = mountSidebar();
    typed.data = nestedMultiFolderActivityData();
    typed.folderSearchEnabled = false;
    typed.folderViewMode = 'activity';
    typed.foldersCollapsed = false;
    typed.createFolderUI();

    const context = typed.containerElement?.querySelector<HTMLElement>(
      '.gv-folder-activity-context',
    );

    expect(context?.textContent).toBe('Folder tests · Food diary');
    expect(context?.getAttribute('aria-label')).toBe('Folder tests\nFolder tests / Food diary');
  });

  it('updates every folder reference when a real new turn is observed', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.data = activityData();

    const nextTurnAt = Date.now() + 10_000;
    typed.markConversationLastTurnAt('active', nextTurnAt);

    const copies = Object.values(typed.data.folderContents)
      .flat()
      .filter((conversation) => conversation.conversationId.replace(/^c_/, '') === 'active');
    expect(copies).toHaveLength(2);
    expect(copies.every((conversation) => conversation.lastTurnAt === nextTurnAt)).toBe(true);
  });

  it('marks the user filter button active after the Activity bell is inserted first', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.recentSection = mountSidebar();
    typed.data = activityData();
    typed.folderSearchEnabled = false;
    typed.folderViewMode = 'folders';
    typed.foldersCollapsed = false;
    typed.createFolderUI();

    const container = typed.containerElement;
    const bell = container?.querySelector<HTMLButtonElement>('.gv-folder-activity-toggle');
    const userFilterButton = container?.querySelector<HTMLButtonElement>(
      '.gv-folder-user-filter-toggle',
    );

    userFilterButton?.click();
    await Promise.resolve();

    expect(userFilterButton?.classList.contains('gv-filter-active')).toBe(true);
    expect(bell?.classList.contains('gv-filter-active')).toBe(false);
    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.GV_FOLDER_FILTER_USER_ONLY]: true,
    });
  });

  it('hides the redundant user filter when hard account isolation is enabled', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.recentSection = mountSidebar();
    typed.data = activityData();
    typed.folderSearchEnabled = false;
    typed.folderViewMode = 'folders';
    typed.foldersCollapsed = false;
    typed.accountIsolationEnabled = true;
    typed.createFolderUI();

    const userFilterButton = typed.containerElement?.querySelector<HTMLButtonElement>(
      '.gv-folder-user-filter-toggle',
    );
    expect(userFilterButton?.hidden).toBe(true);
  });
});
