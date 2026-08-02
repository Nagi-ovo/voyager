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
  activeImportExportMenu: HTMLElement | null;
  enterMultiSelectMode: (
    initialConversationId?: string,
    source?: 'folder' | 'native',
    folderId?: string,
  ) => void;
  exitMultiSelectMode: () => void;
  reinitializePromise: Promise<void> | null;
  createFolder: (parentId?: string | null) => void;
  findNativeConversationElement: (conversationId: string) => HTMLElement | null;
  initializeFolderUI: () => Promise<void>;
  reinitializeFolderUI: () => void;
  createHeader: () => HTMLElement;
  showFolderSettingsMenu: (event: MouseEvent) => void;
  showImportDialog: () => void;
  showImportExportMenu: (event: MouseEvent) => void;
  startFloatingMode: () => Promise<void>;
  drainEnhancementQueue: () => void;
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

  it('toggles the import/export menu instead of stacking duplicates', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 }),
    );

    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);
    expect(typedManager.activeImportExportMenu).not.toBeNull();

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 28, clientY: 20 }),
    );

    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(0);
    expect(typedManager.activeImportExportMenu).toBeNull();

    vi.runOnlyPendingTimers();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 32, clientY: 24 }),
    );

    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);
    expect(typedManager.activeImportExportMenu).not.toBeNull();
  });

  it('keeps conversation order in folder settings instead of adding a header button', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    const header = typedManager.createHeader();
    expect(header.querySelector('.gv-folder-sort-btn')).toBeNull();

    typedManager.showFolderSettingsMenu(
      new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 }),
    );

    const menu = document.querySelector('.gv-folder-settings-menu');
    const options = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('.gv-folder-sort-option') ?? [],
    );

    expect(options.map((button) => button.textContent)).toEqual([
      'folder_sort_manual',
      'folder_sort_recent',
    ]);
    expect(options[0]?.getAttribute('aria-pressed')).toBe('true');

    options[1]?.click();

    expect(options[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'recent',
    });
  });

  it('controls the existing sidebar width setting from folder settings', async () => {
    vi.mocked(browser.storage.sync.get).mockImplementation(async (defaults) => ({
      ...(defaults as Record<string, unknown>),
      [StorageKeys.SIDEBAR_WIDTH]: 26,
      [StorageKeys.SIDEBAR_WIDTH_ENABLED]: true,
    }));

    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.showFolderSettingsMenu(
      new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 }),
    );
    await Promise.resolve();

    const toggle = document.querySelector<HTMLButtonElement>('.gv-folder-width-switch');
    const slider = document.querySelector<HTMLInputElement>('.gv-folder-width-slider');
    const value = document.querySelector<HTMLOutputElement>('.gv-folder-width-value');

    await vi.waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('true'));
    expect(slider?.disabled).toBe(false);
    expect(slider?.value).toBe('312');
    expect(value?.textContent).toBe('312px');

    if (!slider || !toggle) throw new Error('Sidebar width controls were not rendered');
    slider.value = '360';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(value?.textContent).toBe('360px');

    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.SIDEBAR_WIDTH]: 360,
    });

    toggle.click();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(slider.disabled).toBe(true);
    expect(browser.storage.sync.set).toHaveBeenCalledWith({
      [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
    });
  });

  it('removes stale menu listeners when toggling closed before reopening', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 }),
    );
    vi.runOnlyPendingTimers();

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 28, clientY: 20 }),
    );
    expect(typedManager.activeImportExportMenu).toBeNull();

    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 32, clientY: 24 }),
    );
    vi.runOnlyPendingTimers();

    const reopenedMenu = document.querySelector('.gv-folder-menu') as HTMLElement | null;
    expect(reopenedMenu).not.toBeNull();
    reopenedMenu?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelectorAll('.gv-folder-menu')).toHaveLength(1);
    expect(typedManager.activeImportExportMenu).toBe(reopenedMenu);
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
    typedManager.showImportExportMenu(
      new MouseEvent('click', { bubbles: true, clientX: 24, clientY: 16 }),
    );
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
    expect(typedManager.activeImportExportMenu).toBeNull();
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
    // Per-row enhancement work is queued and drained under a frame budget
    // (issue #753) — drive the drain deterministically.
    typedManager.drainEnhancementQueue();

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

  it('finds native conversations from the document when no sidebar reference is cached', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const conversation = mountNativeSidebar('c_def456');

    typedManager.sidebarContainer = null;

    expect(typedManager.findNativeConversationElement('c_def456')).toBe(conversation);
  });
});
