import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Folder } from '@/core/types/folder';

import { type FolderDialogs, createFolderDialogs } from '../folderDialogs';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('move to folder dialog', () => {
  let dialogs: FolderDialogs | null = null;

  afterEach(() => {
    dialogs?.closeAll();
    dialogs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders folder paths in a searchable tree list', () => {
    dialogs = createFolderDialogs();
    const folders: Folder[] = [
      {
        id: 'root-misc',
        name: 'misc',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'software',
        name: 'software',
        parentId: null,
        isExpanded: true,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'software-misc',
        name: 'misc',
        parentId: 'software',
        isExpanded: true,
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const onSelect = vi.fn();
    dialogs.openMove(folders, onSelect);

    const items = [...document.querySelectorAll<HTMLButtonElement>('.gv-folder-dialog-item')];
    expect(items.map((item) => item.dataset.folderPath)).toEqual([
      'misc',
      'software',
      'software / misc',
    ]);
    expect(items.map((item) => item.style.paddingLeft)).toEqual(['12px', '12px', '28px']);
    expect(
      items.map((item) => item.querySelector('.gv-folder-dialog-item-path')?.textContent),
    ).toEqual(['/misc', '/software', '/software/misc']);

    const search = document.querySelector<HTMLInputElement>('.gv-folder-dialog-search');
    expect(search).not.toBeNull();

    search!.value = 'missing';
    search!.dispatchEvent(new InputEvent('input', { bubbles: true }));

    const filteredItems = [
      ...document.querySelectorAll<HTMLButtonElement>('.gv-folder-dialog-item'),
    ];
    expect(filteredItems).toHaveLength(0);
    expect(document.querySelector('.gv-folder-dialog-empty')?.textContent).toBe(
      'timelinePreviewNoResults',
    );

    search!.value = ' SOFTWARE / misc ';
    search!.dispatchEvent(new InputEvent('input', { bubbles: true }));

    const matchingItems = [
      ...document.querySelectorAll<HTMLButtonElement>('.gv-folder-dialog-item'),
    ];
    expect(matchingItems).toHaveLength(1);
    expect(matchingItems[0].dataset.folderPath).toBe('software / misc');

    matchingItems[0].click();

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('software-misc');
    expect(document.querySelector('.gv-folder-dialog-overlay')).toBeNull();
  });
});
