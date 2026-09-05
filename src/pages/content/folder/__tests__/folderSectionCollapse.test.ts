import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

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

function emptyFolders(): FolderData {
  return { folders: [], folderContents: {} };
}

describe('folder section collapse', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    localStorage.clear();
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('toggles the Folders section without changing folder tree expansion state', async () => {
    harness = await createFolderViewHarness({
      folders: [
        { id: 'root', name: 'Root', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      ],
      folderContents: { root: [] },
    });
    const originalData = structuredClone(harness.store.data);
    const container = harness.runtime.panel;
    const button = container?.querySelector<HTMLButtonElement>('.gv-folder-section-toggle');
    expect(container).not.toBeNull();
    expect(button).not.toBeNull();
    expect(container?.classList.contains('gv-folder-collapsed')).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(container?.querySelector('.gv-folder-search')).not.toBeNull();
    expect(container?.querySelector('.gv-folder-list')).not.toBeNull();

    button?.click();
    await Promise.resolve();

    expect(container?.classList.contains('gv-folder-collapsed')).toBe(true);
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.querySelector('.lucide-chevron-right')).not.toBeNull();
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_COLLAPSED]: true,
    });

    button?.click();
    await Promise.resolve();

    expect(container?.classList.contains('gv-folder-collapsed')).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.querySelector('.lucide-chevron-down')).not.toBeNull();
    expect(browser.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.FOLDERS_COLLAPSED]: false,
    });
    expect(harness.store.data).toEqual(originalData);
    expect(harness.adapter.saveData).not.toHaveBeenCalled();
  });

  it('applies the saved collapsed state on first render', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [StorageKeys.FOLDERS_COLLAPSED]: true,
    });
    harness = await createFolderViewHarness(emptyFolders());

    expect(harness.runtime.panel?.classList.contains('gv-folder-collapsed')).toBe(true);
    expect(
      harness.runtime.panel?.querySelector('.gv-folder-section-toggle .lucide-chevron-right'),
    ).not.toBeNull();
  });

  it.each(['extension storage', 'localStorage fallback'])(
    'migrates the retired hidden-eye state from %s into the built-in collapsed state',
    async (source) => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [StorageKeys.FOLDERS_HIDDEN]: source === 'extension storage',
        [StorageKeys.FOLDERS_COLLAPSED]: false,
        [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
      });
      if (source === 'localStorage fallback')
        localStorage.setItem(StorageKeys.FOLDERS_HIDDEN, 'true');
      harness = await createFolderViewHarness(emptyFolders());

      expect(harness.runtime.panel?.classList.contains('gv-folder-collapsed')).toBe(true);
      expect(
        harness.runtime.panel
          ?.querySelector('.gv-folder-section-toggle')
          ?.getAttribute('aria-expanded'),
      ).toBe('false');
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [StorageKeys.FOLDERS_HIDDEN]: false,
        [StorageKeys.FOLDERS_COLLAPSED]: true,
      });
      expect(localStorage.getItem(StorageKeys.FOLDERS_HIDDEN)).toBeNull();
    },
  );
});
