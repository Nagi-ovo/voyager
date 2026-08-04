import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

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
  containerElement: HTMLElement | null;
  data: FolderData;
  folderSearchEnabled: boolean;
  foldersCollapsed: boolean;
  recentSection: HTMLElement | null;
  createFolderUI: () => void;
  loadFoldersCollapsedSetting: () => Promise<void>;
  destroy: () => void;
};

function mountSidebar(): { recents: HTMLElement } {
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-test-id', 'overflow-container');

  const recents = document.createElement('expandable-section');
  recents.setAttribute('data-test-id', 'chats-expandable-section');
  sidebar.appendChild(recents);

  document.body.appendChild(sidebar);
  return { recents };
}

function emptyFolders(): FolderData {
  return { folders: [], folderContents: {} };
}

describe('folder section collapse', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('toggles the Folders section without changing folder tree expansion state', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    const { recents } = mountSidebar();

    typed.recentSection = recents;
    typed.data = emptyFolders();
    typed.folderSearchEnabled = true;
    typed.foldersCollapsed = false;
    typed.createFolderUI();

    const container = typed.containerElement;
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
  });

  it('applies the saved collapsed state on first render', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    const { recents } = mountSidebar();

    typed.recentSection = recents;
    typed.data = emptyFolders();
    typed.folderSearchEnabled = true;
    typed.foldersCollapsed = true;
    typed.createFolderUI();

    expect(typed.containerElement?.classList.contains('gv-folder-collapsed')).toBe(true);
    expect(
      typed.containerElement?.querySelector('.gv-folder-section-toggle .lucide-chevron-right'),
    ).not.toBeNull();
  });

  it('migrates the retired hidden-eye state into the built-in collapsed state', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      [StorageKeys.FOLDERS_HIDDEN]: true,
      [StorageKeys.FOLDERS_COLLAPSED]: false,
      [StorageKeys.FOLDERS_VIEW_MODE]: 'folders',
    });
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    await typed.loadFoldersCollapsedSetting();

    expect(typed.foldersCollapsed).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_HIDDEN]: false,
      [StorageKeys.FOLDERS_COLLAPSED]: true,
    });
  });
});
