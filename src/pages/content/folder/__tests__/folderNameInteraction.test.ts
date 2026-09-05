import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderManager } from '../manager';
import type { Folder } from '../types';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type TestableManager = {
  createFolderElement: (folder: Folder, level?: number) => HTMLElement;
  toggleFolder: (folderId: string) => void;
  renameFolder: (folderId: string) => void;
};

function createFolder(): Folder {
  const now = Date.now();
  return {
    id: 'folder-1',
    name: 'Folder 1',
    parentId: null,
    isExpanded: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('folder name click/double-click interaction', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('toggles folder on single click after delay', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const toggleSpy = vi.spyOn(typedManager, 'toggleFolder').mockImplementation(() => {});
    const renameSpy = vi.spyOn(typedManager, 'renameFolder').mockImplementation(() => {});

    const folderEl = typedManager.createFolderElement(createFolder());
    document.body.appendChild(folderEl);

    const folderName = folderEl.querySelector('.gv-folder-name') as HTMLElement | null;
    expect(folderName).not.toBeNull();
    folderName?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    vi.advanceTimersByTime(219);
    expect(toggleSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith('folder-1');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('renames folder on double click without toggle flicker', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const toggleSpy = vi.spyOn(typedManager, 'toggleFolder').mockImplementation(() => {});
    const renameSpy = vi.spyOn(typedManager, 'renameFolder').mockImplementation(() => {});

    const folderEl = typedManager.createFolderElement(createFolder());
    document.body.appendChild(folderEl);

    const folderName = folderEl.querySelector('.gv-folder-name') as HTMLElement | null;
    expect(folderName).not.toBeNull();
    folderName?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    folderName?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    folderName?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));

    vi.runAllTimers();
    expect(toggleSpy).not.toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith('folder-1');
  });
});
