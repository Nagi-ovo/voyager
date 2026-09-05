import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

import { FolderManager } from '../manager';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: vi.fn(),
        set: vi.fn(),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

vi.mock('../floatingPanel', () => ({
  mountFloatingPanel: vi.fn(() => ({
    destroy: vi.fn(),
    update: vi.fn(),
  })),
}));

type TestableManager = {
  containerElement: HTMLElement | null;
  sidebarContainer: HTMLElement | null;
  activeFolderInput: HTMLElement | null;
  activeImportDialog: HTMLElement | null;
  enterMultiSelectMode: (
    initialConversationId?: string,
    source?: 'folder' | 'native',
    folderId?: string,
  ) => void;
  exitMultiSelectMode: () => void;
  reinitializePromise: Promise<void> | null;
  createFolder: (parentId?: string | null) => void;
  initializeFolderUI: () => Promise<void>;
  reinitializeFolderUI: () => void;
  createHeader: () => HTMLElement;
  showImportDialog: () => void;
  exportFolders: () => void;
  handleCloudUpload: () => Promise<void>;
  handleCloudSync: () => Promise<void>;
  startFloatingMode: () => Promise<void>;
};

function mountFolderList(manager: TestableManager): HTMLElement {
  const container = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'gv-folder-list';
  container.appendChild(list);
  document.body.appendChild(container);
  manager.containerElement = container;
  return list;
}

function mountNativeSidebar(conversationId: string = 'c_abc123'): HTMLElement {
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-test-id', 'overflow-container');

  const conversation = document.createElement('div');
  conversation.setAttribute('data-test-id', 'conversation');
  conversation.setAttribute('jslog', `["${conversationId}"]`);

  sidebar.appendChild(conversation);
  document.body.appendChild(sidebar);
  return conversation;
}

describe('folder duplicate click guards', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reuses the active folder input instead of creating duplicates', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    mountFolderList(typedManager);

    typedManager.createFolder();

    const input = document.querySelector('.gv-folder-name-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(1);
    expect(typedManager.activeFolderInput).not.toBeNull();

    const focusTrap = document.createElement('button');
    document.body.appendChild(focusTrap);
    focusTrap.focus();
    expect(document.activeElement).toBe(focusTrap);

    typedManager.createFolder();

    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });

  it('clears stale folder input state during reinitialize so creation stays usable', async () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    mountFolderList(typedManager);

    typedManager.createFolder();
    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(1);
    expect(typedManager.activeFolderInput).not.toBeNull();

    vi.spyOn(typedManager, 'initializeFolderUI').mockImplementation(async () => {
      mountFolderList(typedManager);
    });

    typedManager.reinitializeFolderUI();
    await typedManager.reinitializePromise;

    expect(typedManager.activeFolderInput).toBeNull();

    typedManager.createFolder();

    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(1);
    expect(typedManager.activeFolderInput).not.toBeNull();
  });

  it('runs the chosen import, export or cloud action through the header buttons', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const importAction = vi.spyOn(typedManager, 'showImportDialog').mockImplementation(() => {});
    const exportAction = vi.spyOn(typedManager, 'exportFolders').mockImplementation(() => {});
    const uploadAction = vi.spyOn(typedManager, 'handleCloudUpload').mockResolvedValue(undefined);
    const syncAction = vi.spyOn(typedManager, 'handleCloudSync').mockResolvedValue(undefined);
    const header = typedManager.createHeader();
    document.body.appendChild(header);

    for (const [buttonSelector, label, action] of [
      ['.gv-folder-import-export-btn', 'folder_import', importAction],
      ['.gv-folder-import-export-btn', 'folder_export', exportAction],
      ['.gv-folder-cloud-btn', 'folder_cloud_upload', uploadAction],
      ['.gv-folder-cloud-btn', 'folder_cloud_sync', syncAction],
    ] as const) {
      header.querySelector<HTMLButtonElement>(buttonSelector)?.click();
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.gv-folder-menu-item'),
      ).find((candidate) => candidate.textContent?.endsWith(label));
      expect(item).toBeDefined();
      item?.click();

      expect(action).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.gv-folder-menu')).toBeNull();
    }
    for (const action of [importAction, exportAction, uploadAction, syncAction]) {
      expect(action).toHaveBeenCalledTimes(1);
    }
  });

  it('persists a sort choice made through the header settings button', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const header = typedManager.createHeader();
    document.body.appendChild(header);
    expect(header.querySelector('.gv-folder-sort-btn')).toBeNull();

    header.querySelector<HTMLButtonElement>('.gv-folder-settings-btn')?.click();
    const recentOption = document.querySelector<HTMLButtonElement>(
      '.gv-folder-sort-option:last-child',
    );
    expect(recentOption).not.toBeNull();
    recentOption?.click();

    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'recent',
    });
  });

  it('keeps the import dialog singleton and reopens cleanly after closing', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    typedManager.showImportDialog();

    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(1);
    expect(typedManager.activeImportDialog).not.toBeNull();

    typedManager.showImportDialog();

    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(1);

    const cancelBtn = document.querySelector(
      '.gv-folder-dialog-btn-secondary',
    ) as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();

    cancelBtn?.click();

    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(0);
    expect(typedManager.activeImportDialog).toBeNull();

    typedManager.showImportDialog();

    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(1);
    expect(typedManager.activeImportDialog).not.toBeNull();
  });

  it('cleans up tracked UI overlays during destroy', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    mountFolderList(typedManager);
    typedManager.createFolder();
    typedManager.showImportDialog();
    const header = typedManager.createHeader();
    document.body.appendChild(header);
    header.querySelector<HTMLButtonElement>('.gv-folder-import-export-btn')?.click();
    vi.runOnlyPendingTimers();

    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(1);
    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(1);
    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);

    manager.destroy();
    manager = null;

    expect(document.querySelectorAll('.gv-folder-inline-input')).toHaveLength(0);
    expect(document.querySelectorAll('.gv-folder-dialog-overlay')).toHaveLength(0);
    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(0);
    expect(typedManager.activeFolderInput).toBeNull();
    expect(typedManager.activeImportDialog).toBeNull();
  });

  it('shows native multi-select actions without the sidebar folder container', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    typedManager.enterMultiSelectMode('conv-a', 'native');

    const floatingHost = document.querySelector(
      '[data-multi-select-floating-host="true"]',
    ) as HTMLElement | null;
    expect(floatingHost).not.toBeNull();
    expect(floatingHost?.classList.contains('gv-multi-select-mode')).toBe(true);
    expect(floatingHost?.querySelector('[data-selection-count="true"]')?.textContent).toBe(
      '1 selected',
    );
    expect(floatingHost?.querySelector('.gv-multi-select-delete-btn')).not.toBeNull();

    typedManager.exitMultiSelectMode();

    expect(floatingHost?.classList.contains('gv-multi-select-mode')).toBe(false);
    expect(floatingHost?.querySelector('.gv-multi-select-delete-btn')).toBeNull();
  });

  it('wires native long-press multi-select when floating mode starts first', async () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const conversation = mountNativeSidebar('c_abc123');

    await typedManager.startFloatingMode();
    // Run the scheduled row enhancement through its production frame/idle path.
    await vi.advanceTimersByTimeAsync(100);

    expect(conversation.dataset.gvConvDragAttached).toBe('true');

    conversation.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    vi.advanceTimersByTime(500);

    const floatingHost = document.querySelector(
      '[data-multi-select-floating-host="true"]',
    ) as HTMLElement | null;
    expect(conversation.classList.contains('gv-conversation-selected')).toBe(true);
    expect(floatingHost).not.toBeNull();
    expect(floatingHost?.querySelector('[data-selection-count="true"]')?.textContent).toBe(
      '1 selected',
    );
    expect(floatingHost?.querySelector('.gv-multi-select-delete-btn')).not.toBeNull();
  });
});
