import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import { ACTIVITY_PRIORITY_WINDOW_MS } from '../activityView';
import type { FolderData } from '../types';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';

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

const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();

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
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({
      [StorageKeys.FOLDER_SEARCH_ENABLED]: false,
    });
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [StorageKeys.FOLDERS_VIEW_MODE]: 'activity',
    });
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the bell projection with exclusive Priority and deduplicated folder context', async () => {
    harness = await createFolderViewHarness(activityData());
    const container = harness.runtime.panel;
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

    expect(harness.treeView.viewMode).toBe('folders');
    expect(bell?.title).toBe('folder_activity_turn_on');
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
    });
  });

  it('automatically returns an expired Priority conversation to Today', async () => {
    const data = activityData();
    Object.values(data.folderContents)
      .flat()
      .filter((conversation) => conversation.conversationId.replace(/^c_/, '') === 'active')
      .forEach((conversation) => {
        conversation.lastTurnAt = NOW - ACTIVITY_PRIORITY_WINDOW_MS + 1_000;
      });
    harness = await createFolderViewHarness(data);

    expect(
      harness.runtime.panel?.querySelector('.gv-folder-activity-group-priority')?.textContent,
    ).toContain('Active chat');

    vi.advanceTimersByTime(1_002);

    expect(harness.runtime.panel?.querySelector('.gv-folder-activity-group-priority')).toBeNull();
    expect(
      harness.runtime.panel?.querySelector('.gv-folder-activity-group-today')?.textContent,
    ).toContain('Active chat');
  });

  it('does not spin refreshes for an imported timestamp beyond the browser timer limit', async () => {
    const data = activityData();
    Object.values(data.folderContents)
      .flat()
      .forEach((conversation) => {
        conversation.lastTurnAt = NOW + 30 * 24 * 60 * 60 * 1000;
      });
    harness = await createFolderViewHarness(data);
    harness.onRefresh.mockClear();

    vi.advanceTimersByTime(1_000);

    expect(
      harness.runtime.panel?.querySelector('.gv-folder-activity-group-priority'),
    ).not.toBeNull();
    expect(harness.onRefresh).not.toHaveBeenCalled();
  });

  it('shows leaf folder names while preserving full multi-folder paths for context', async () => {
    harness = await createFolderViewHarness(nestedMultiFolderActivityData());

    const context = harness.runtime.panel?.querySelector<HTMLElement>(
      '.gv-folder-activity-context',
    );

    expect(context?.textContent).toBe('Folder tests · Food diary');
    expect(context?.getAttribute('aria-label')).toBe('Folder tests\nFolder tests / Food diary');
  });

  it('updates every folder reference when a real new turn is observed', async () => {
    harness = await createFolderViewHarness(activityData());

    const nextTurnAt = Date.now() + 10_000;
    harness.store.markConversationLastTurnAt('active', nextTurnAt);

    const copies = Object.values(harness.store.data.folderContents)
      .flat()
      .filter((conversation) => conversation.conversationId.replace(/^c_/, '') === 'active');
    expect(copies).toHaveLength(2);
    expect(copies.every((conversation) => conversation.lastTurnAt === nextTurnAt)).toBe(true);
    await vi.advanceTimersByTimeAsync(350);
    const savedCopies = Object.values(harness.saved.folderContents)
      .flat()
      .filter((conversation) => conversation.conversationId.replace(/^c_/, '') === 'active');
    expect(savedCopies.every((conversation) => conversation.lastTurnAt === nextTurnAt)).toBe(true);
  });

  it('marks the user filter button active after the Activity bell is inserted first', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
    });
    harness = await createFolderViewHarness(activityData());

    const container = harness.runtime.panel;
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

  it('hides the redundant user filter when hard account isolation is enabled', async () => {
    harness = await createFolderViewHarness(activityData());
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
      accountKey: 'gemini-test',
      accountId: 1,
      routeUserId: null,
      emailHash: null,
    });
    await harness.store.setAccountIsolationEnabled(true);

    const userFilterButton = harness.runtime.panel?.querySelector<HTMLButtonElement>(
      '.gv-folder-user-filter-toggle',
    );
    expect(userFilterButton?.hidden).toBe(true);
  });
});
