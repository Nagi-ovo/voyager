import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('folder tree indentation', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness({
      folders: ['root', 'child', 'legacy-deep'].map((id, index, ids) => ({
        id,
        name: id,
        parentId: index ? ids[index - 1] : null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      })),
      folderContents: {
        child: [{ conversationId: 'a', title: 'A', url: '/app/a', addedAt: 1 }],
        'legacy-deep': [{ conversationId: 'b', title: 'B', url: '/app/b', addedAt: 1 }],
      },
    });
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [-40, '0px', '8px', '0px'],
    [64, '72px', '88px', '120px'],
    [0, '8px', '24px', '24px'],
    [16, '40px', '56px', '72px'],
    ['invalid', '0px', '8px', '0px'],
  ])('renders safe nested padding when indent is %s', (setting, header, child, deep) => {
    const originalData = structuredClone(harness.store.data);
    const originalList = harness.runtime.panel!.querySelector('.gv-folder-list');

    harness.treeView.applySettings(
      { [StorageKeys.GV_FOLDER_TREE_INDENT]: { newValue: setting } },
      'sync',
    );

    const panel = harness.runtime.panel!;
    expect(
      panel.querySelector<HTMLElement>('[data-folder-id="legacy-deep"] > .gv-folder-item-header')!
        .style.paddingLeft,
    ).toBe(header);
    expect(panel.querySelector<HTMLElement>('[data-conversation-id="a"]')!.style.paddingLeft).toBe(
      child,
    );
    expect(panel.querySelector<HTMLElement>('[data-conversation-id="b"]')!.style.paddingLeft).toBe(
      deep,
    );
    expect(harness.store.data).toEqual(originalData);
    if (typeof setting === 'number' && setting >= 0) expect(originalList!.isConnected).toBe(false);
  });
});
