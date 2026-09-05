import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { FolderManager } from '../manager';
import type { FolderData } from '../types';

const { mountFloatingFabMock, mountFloatingPanelMock } = vi.hoisted(() => ({
  mountFloatingFabMock: vi.fn(),
  mountFloatingPanelMock: vi.fn(() => ({ destroy: vi.fn(), update: vi.fn() })),
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

vi.mock('../floatingPanel', () => ({
  mountFloatingPanel: mountFloatingPanelMock,
}));

vi.mock('../floatingModeFab', () => ({
  mountFloatingFab: mountFloatingFabMock,
  unmountFloatingFab: vi.fn(),
}));

type TestableManager = {
  data: FolderData;
  folderEnabled: boolean;
  floatingModeEnabled: boolean;
  floatingOpenOnStart: boolean;
  floatingModeActive: boolean;
  applyFolderEnabledSetting: () => void;
  initializeFolderUI: () => Promise<void>;
  startFloatingMode: (openPanel?: boolean) => Promise<void>;
  navigateToConversation: (url: string, conversation?: unknown) => void;
};

function mountSidebar(): { appRoot: HTMLElement; sidebar: HTMLElement; recents: HTMLElement } {
  const appRoot = document.createElement('div');
  appRoot.id = 'app-root';
  appRoot.className = 'side-nav-open';

  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-test-id', 'overflow-container');

  const recents = document.createElement('expandable-section');
  recents.setAttribute('data-test-id', 'chats-expandable-section');
  sidebar.appendChild(recents);
  appRoot.appendChild(sidebar);
  document.body.appendChild(appRoot);

  return { appRoot, sidebar, recents };
}

describe('FolderManager disabled runtime teardown', () => {
  let manager: FolderManager | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined);
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops enhancing native rows and menus when disabled while preserving folder data', async () => {
    vi.useFakeTimers();
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    const { recents } = mountSidebar();
    const row = document.createElement('div');
    row.setAttribute('data-test-id', 'conversation');
    row.innerHTML = '<a href="/app/abcdef0123456789">Native conversation</a>';
    const nextRow = row.cloneNode(true) as HTMLElement;
    recents.appendChild(row);

    const menu = document.createElement('gem-menu');
    menu.innerHTML = '<gem-menu-item data-test-id="rename-button">Rename</gem-menu-item>';
    const nextMenu = menu.cloneNode(true) as HTMLElement;
    const storedData: FolderData = {
      folders: [
        {
          id: 'saved-folder',
          name: 'Saved folder',
          parentId: null,
          isExpanded: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { 'saved-folder': [] },
    };
    typed.data = structuredClone(storedData);
    typed.folderEnabled = true;
    await typed.initializeFolderUI();
    document.body.appendChild(menu);
    await vi.advanceTimersByTimeAsync(100);

    expect(row.draggable).toBe(true);
    expect(menu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();
    expect(document.querySelector('.gv-folder-container')).not.toBeNull();
    menu.remove();

    typed.folderEnabled = false;
    typed.applyFolderEnabledSetting();
    recents.appendChild(nextRow);
    document.body.appendChild(nextMenu);
    await vi.advanceTimersByTimeAsync(100);

    expect(document.querySelector('.gv-folder-container')).toBeNull();
    expect(nextRow.draggable).toBe(false);
    expect(nextMenu.querySelector('.gv-move-to-folder-btn')).toBeNull();
    expect(typed.data).toEqual(storedData);
  });

  it('uses floating mode when folders are re-enabled with the floating toggle on', () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    const startFloatingSpy = vi.spyOn(typed, 'startFloatingMode').mockResolvedValue(undefined);

    typed.folderEnabled = true;
    typed.floatingModeEnabled = true;
    typed.floatingModeActive = false;

    typed.applyFolderEnabledSetting();

    expect(startFloatingSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the floating panel by default when floating mode starts', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    typed.folderEnabled = true;

    await typed.startFloatingMode();

    expect(mountFloatingPanelMock).toHaveBeenCalledTimes(1);
    expect(mountFloatingFabMock).not.toHaveBeenCalled();
  });

  it('keeps the FAB reopen path for explicit floating mode', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    typed.folderEnabled = true;

    await typed.startFloatingMode();
    const calls = mountFloatingPanelMock.mock.calls as unknown as Array<[{ onClose?: () => void }]>;
    const panelArgs = calls[0]?.[0];
    panelArgs?.onClose?.();

    await vi.waitFor(() => expect(mountFloatingFabMock).toHaveBeenCalledTimes(1));
  });

  it('routes floating panel conversation clicks through the SPA navigator', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;
    const navigateSpy = vi.spyOn(typed, 'navigateToConversation').mockImplementation(() => {});
    const conversation = {
      conversationId: 'c_1234567890abcdef',
      title: 'Conversation',
      url: 'https://gemini.google.com/app/1234567890abcdef',
      addedAt: 1,
    };

    typed.folderEnabled = true;

    await typed.startFloatingMode();
    const calls = mountFloatingPanelMock.mock.calls as unknown as Array<
      [
        {
          onNavigate?: (conv: typeof conversation) => void;
        },
      ]
    >;
    const args = calls[0][0];
    args.onNavigate?.(conversation);

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(conversation.url, conversation);
  });

  it('starts floating mode as a FAB only when startup panel is disabled', async () => {
    manager = new FolderManager();
    const typed = manager as unknown as TestableManager;

    typed.folderEnabled = true;
    typed.floatingOpenOnStart = false;

    await typed.startFloatingMode();
    await vi.waitFor(() => expect(mountFloatingFabMock).toHaveBeenCalledTimes(1));

    expect(mountFloatingPanelMock).not.toHaveBeenCalled();
    expect(typed.floatingModeActive).toBe(true);
  });
});
