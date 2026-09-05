import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import * as nativeSidebarDom from '../nativeSidebarDom';
import type { FolderData } from '../types';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';

const coachmarkMocks = vi.hoisted(() => ({
  hasSeenCoachmark: vi.fn(async () => false),
  markCoachmarkSeen: vi.fn(async () => undefined),
}));

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

vi.mock('../../coachmark', () => coachmarkMocks);

function getFolderNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.gv-folder-name')].map(
    (node) => node.textContent ?? '',
  );
}

function getConversationTitles(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.gv-conversation-title')].map(
    (node) => node.textContent ?? '',
  );
}

const folderData: FolderData = {
  folders: [
    {
      id: 'research',
      name: 'Research',
      parentId: null,
      isExpanded: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'papers',
      name: 'Papers',
      parentId: 'research',
      isExpanded: false,
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'recipes',
      name: 'Recipes',
      parentId: null,
      isExpanded: false,
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  folderContents: {
    research: [
      {
        conversationId: 'research-overview',
        title: 'Research overview',
        url: 'https://gemini.google.com/app/research-overview',
        addedAt: 9,
      },
    ],
    papers: [
      {
        conversationId: 'alpha-signals',
        title: 'Alpha signals',
        url: 'https://gemini.google.com/app/alpha-signals',
        addedAt: 10,
      },
    ],
    recipes: [
      {
        conversationId: 'dinner-plan',
        title: 'Dinner plan',
        url: 'https://gemini.google.com/app/dinner-plan',
        addedAt: 11,
      },
    ],
  },
};

describe('folder sidebar search', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    coachmarkMocks.hasSeenCoachmark.mockResolvedValue(false);
  });

  afterEach(() => {
    harness?.destroy();
    harness = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function typeSearch(value: string): void {
    const input =
      harness!.runtime.panel!.querySelector<HTMLInputElement>('.gv-folder-search-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function search(query: string, data = folderData): Promise<HTMLElement> {
    harness = await createFolderViewHarness(structuredClone(data));
    typeSearch(query);
    vi.advanceTimersByTime(250);
    return harness.runtime.panel!;
  }

  it('keeps the parent path visible for a nested conversation match', async () => {
    const panel = await search('alpha');
    expect(getFolderNames(panel)).toEqual(['Research', 'Papers']);
    expect(getConversationTitles(panel)).toEqual(['Alpha signals']);
    expect(panel.querySelector('.gv-folder-empty')).toBeNull();
  });

  it('filters by folder title without showing unrelated conversations', async () => {
    const panel = await search('recipes');
    expect(getFolderNames(panel)).toEqual(['Recipes']);
    expect(getConversationTitles(panel)).toEqual([]);
  });

  it('shows every conversation inside a folder matched with the f: prefix', async () => {
    const panel = await search('f:recipes');
    expect(getFolderNames(panel)).toEqual(['Recipes']);
    expect(getConversationTitles(panel)).toEqual(['Dinner plan']);
  });

  it('shows the full subtree when a parent folder matches folder:', async () => {
    const panel = await search('folder:research');
    expect(getFolderNames(panel)).toEqual(['Research', 'Papers']);
    expect(getConversationTitles(panel)).toEqual(['Research overview', 'Alpha signals']);
  });

  it('keeps only the ancestor path when a nested folder matches f:', async () => {
    const panel = await search('F: Papers');
    expect(getFolderNames(panel)).toEqual(['Research', 'Papers']);
    expect(getConversationTitles(panel)).toEqual(['Alpha signals']);
  });

  it('does not match root conversations in folder-only mode', async () => {
    const panel = await search('f:recipes', {
      ...folderData,
      folderContents: {
        ...folderData.folderContents,
        __root_conversations__: [
          {
            conversationId: 'recipes-root',
            title: 'Recipes shortcut',
            url: 'https://gemini.google.com/app/recipes-root',
            addedAt: 8,
          },
        ],
      },
    });
    expect(getFolderNames(panel)).toEqual(['Recipes']);
    expect(getConversationTitles(panel)).toEqual(['Dinner plan']);
  });

  it('teaches the prefix until the first folder-only search, then keeps only the mode badge', async () => {
    harness = await createFolderViewHarness(structuredClone(folderData));
    const search = harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-search')!;
    const input = search.querySelector<HTMLInputElement>('.gv-folder-search-input')!;
    const badge = search.querySelector<HTMLElement>('.gv-folder-search-mode-badge')!;
    expect(input.placeholder).toBe('folder_search_placeholder · f: folder_search_mode_folder');
    expect(badge.hidden).toBe(true);

    typeSearch('f:recipes');
    expect(input.placeholder).toBe('folder_search_placeholder');
    expect(search.classList.contains('gv-folder-search-folder-mode')).toBe(true);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('folder_search_mode_folder');
    expect(coachmarkMocks.markCoachmarkSeen).toHaveBeenCalledWith('folder-only-search-prefix-hint');

    typeSearch('');
    expect(search.classList.contains('gv-folder-search-folder-mode')).toBe(false);
    expect(badge.hidden).toBe(true);
    expect(input.placeholder).toBe('folder_search_placeholder');
    expect(coachmarkMocks.markCoachmarkSeen).toHaveBeenCalledTimes(1);
  });

  it('always shows the compact mode badge for returning users', async () => {
    coachmarkMocks.hasSeenCoachmark.mockResolvedValue(true);
    const panel = await search('folder:recipes');
    const input = panel.querySelector<HTMLInputElement>('.gv-folder-search-input')!;
    expect(input.placeholder).toBe('folder_search_placeholder');
    expect(input.getAttribute('aria-label')).toBe(
      'folder_search_placeholder: folder_search_mode_folder',
    );
    expect(
      panel.querySelector('.gv-folder-search')!.classList.contains('gv-folder-search-folder-mode'),
    ).toBe(true);
    expect(panel.querySelector<HTMLElement>('.gv-folder-search-mode-badge')!.hidden).toBe(false);
    expect(coachmarkMocks.markCoachmarkSeen).not.toHaveBeenCalled();
  });

  it('uses the search empty state when no titles match', async () => {
    const panel = await search('missing');
    expect(getFolderNames(panel)).toEqual([]);
    expect(getConversationTitles(panel)).toEqual([]);
    expect(panel.querySelector('.gv-folder-empty')?.textContent).toBe('folder_search_empty');
  });

  it('does not filter the tree when folder search is disabled', async () => {
    const panel = await search('alpha');
    harness!.treeView.applySettings(
      { [StorageKeys.FOLDER_SEARCH_ENABLED]: { newValue: false } },
      'sync',
    );
    expect(panel.querySelector('.gv-folder-search')).toBeNull();
    expect(getFolderNames(panel)).toEqual(['Recipes', 'Research']);
    expect(getConversationTitles(panel)).toEqual([]);
  });

  it('rebuilds the tree once after the user stops typing', async () => {
    harness = await createFolderViewHarness(structuredClone(folderData));
    harness.onRefresh.mockClear();
    for (const value of ['a', 'al', 'alp', 'alph', 'alpha']) typeSearch(value);
    expect(harness.onRefresh).not.toHaveBeenCalled();
    expect(getFolderNames(harness.runtime.panel!)).toEqual(['Recipes', 'Research']);

    vi.advanceTimersByTime(250);
    expect(harness.onRefresh).toHaveBeenCalledTimes(1);
    expect(getConversationTitles(harness.runtime.panel!)).toEqual(['Alpha signals']);
  });

  async function mountNativeTitleFixture() {
    const hexId = 'abc123def4567890';
    harness = await createFolderViewHarness({
      folders: [],
      folderContents: {
        __root_conversations__: [
          {
            conversationId: `c_${hexId}`,
            title: 'Stale stored title',
            url: `https://gemini.google.com/app/${hexId}`,
            addedAt: 1,
          },
        ],
      },
    });
    const native = document.createElement('div');
    native.dataset.testId = 'conversation';
    native.setAttribute('jslog', `["c_${hexId}"]`);
    native.innerHTML = `<a href="/app/${hexId}"><span class="conversation-title-text">Fresh native title</span></a>`;
    harness.sidebar.recentsSection.appendChild(native);
    return native;
  }

  it('uses one native title lookup per render and persists the buffered title', async () => {
    const native = await mountNativeTitleFixture();
    const build = vi.spyOn(nativeSidebarDom, 'buildNativeConversationTitleMap');
    const legacyScan = vi.spyOn(nativeSidebarDom, 'syncConversationTitleFromNative');
    harness!.onRefresh();
    expect(build).toHaveBeenCalledTimes(1);
    expect(legacyScan).not.toHaveBeenCalled();
    expect(getConversationTitles(harness!.runtime.panel!)).toEqual(['Fresh native title']);
    expect(harness!.store.data.folderContents.__root_conversations__[0].title).toBe(
      'Fresh native title',
    );
    await Promise.resolve();
    expect(harness!.saved.folderContents.__root_conversations__[0].title).toBe(
      'Fresh native title',
    );

    native.querySelector('span')!.textContent = 'Updated again';
    harness!.treeView.render();
    expect(build).toHaveBeenCalledTimes(2);
    expect(getConversationTitles(harness!.runtime.panel!)).toEqual(['Updated again']);
  });

  it('search-triggered renders skip the native title sync scan', async () => {
    await mountNativeTitleFixture();
    const build = vi.spyOn(nativeSidebarDom, 'buildNativeConversationTitleMap');
    const legacyScan = vi.spyOn(nativeSidebarDom, 'syncConversationTitleFromNative');
    typeSearch('stale');
    vi.advanceTimersByTime(250);
    expect(build).not.toHaveBeenCalled();
    expect(legacyScan).not.toHaveBeenCalled();
    expect(getConversationTitles(harness!.runtime.panel!)).toEqual(['Stale stored title']);
  });
});
