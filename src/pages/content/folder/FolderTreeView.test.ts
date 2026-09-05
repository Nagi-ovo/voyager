import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFolderViewHarness,
  resetFolderViewBrowserMocks,
} from './__tests__/folderViewHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('FolderTreeView conversation links', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes plain clicks with current data and preserves browser-native new-tab actions', async () => {
    const id = '4d5e6f7890abcdef';
    harness = await createFolderViewHarness({
      folders: [
        {
          id: 'folder-1',
          name: 'Folder 1',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: {
        'folder-1': [
          {
            conversationId: `c_${id}`,
            title: 'Conversation',
            url: `https://gemini.google.com/app/${id}`,
            addedAt: 1,
          },
        ],
      },
    });
    const navigate = vi.spyOn(harness.navigation, 'navigate').mockImplementation(() => {});
    const link = harness.runtime.panel!.querySelector<HTMLAnchorElement>(
      'a.gv-folder-conversation-link',
    )!;
    expect(link.href).toBe(`https://gemini.google.com/app/${id}`);

    // A storage/model update may replace the record without rebuilding this live row.
    const latest = { ...harness.store.data.folderContents['folder-1'][0], lastOpenedAt: 100 };
    harness.store.data = {
      ...harness.store.data,
      folderContents: { 'folder-1': [latest] },
    };
    const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    expect(link.dispatchEvent(plainClick)).toBe(false);
    expect(plainClick.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(latest, 'folder-1');

    link.target = '_blank';
    const ctrlClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    expect(link.dispatchEvent(ctrlClick)).toBe(true);
    expect(ctrlClick.defaultPrevented).toBe(false);

    const middleClick = new MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    expect(link.dispatchEvent(middleClick)).toBe(true);
    expect(middleClick.defaultPrevented).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
