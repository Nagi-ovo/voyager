import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('folder name click/double-click interaction', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness({
      folders: [
        {
          id: 'folder-1',
          name: 'Folder 1',
          parentId: null,
          isExpanded: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: {},
    });
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('toggles folder on single click after delay', () => {
    const folderName = harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-name')!;
    folderName.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    vi.advanceTimersByTime(219);
    expect(harness.store.data.folders[0].isExpanded).toBe(false);
    expect(harness.onRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(harness.store.data.folders[0].isExpanded).toBe(true);
    expect(harness.onRefresh).toHaveBeenCalledTimes(1);
    expect(harness.runtime.panel!.querySelector('.gv-folder-content')).not.toBeNull();
    expect(document.querySelector('.gv-folder-rename-inline')).toBeNull();
  });

  it('renames folder on double click without toggle flicker', async () => {
    const folderName = harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-name')!;
    folderName.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    folderName.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    folderName.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));

    vi.advanceTimersByTime(220);
    expect(harness.store.data.folders[0].isExpanded).toBe(false);
    expect(harness.onRefresh).not.toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>('.gv-folder-rename-input')!;
    expect(input.value).toBe('Folder 1');
    expect(document.activeElement).toBe(input);
    input.value = '  Renamed  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.store.data.folders[0]).toMatchObject({ name: 'Renamed', isExpanded: false });
    expect(harness.saved.folders[0].name).toBe('Renamed');
    expect(harness.adapter.saveData).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.gv-folder-rename-inline')).toBeNull();
    expect(harness.runtime.panel!.querySelector('.gv-folder-name')?.textContent).toBe('Renamed');
  });
});
