import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderManager } from '../manager';
import type { ConversationReference, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type TestableManager = {
  data: FolderData;
  sidebarContainer: HTMLElement | null;
  hideArchivedConversations: boolean;
  initializeFolderUI: () => Promise<void>;
  createConversationElement: (
    conv: ConversationReference,
    folderId: string,
    level: number,
  ) => HTMLElement;
  openNativeRenameForFolderConversation: (conversation: ConversationReference) => Promise<boolean>;
  syncConversationTitlesFromNative: () => Promise<void>;
  saveData: () => Promise<boolean>;
  renderAllFolders: () => void;
};

function createNativeConversation(hexId: string, title: string): HTMLSpanElement {
  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  row.setAttribute('jslog', `["c_${hexId}"]`);

  const link = document.createElement('a');
  link.href = `/app/${hexId}`;

  const titleEl = document.createElement('span');
  titleEl.className = 'conversation-title-text';
  titleEl.textContent = title;

  link.appendChild(titleEl);
  row.appendChild(link);
  document.body.appendChild(row);

  return titleEl;
}

function createNativeConversationWithActions(
  hexId: string,
  onRenameClick: () => void,
): {
  moreButton: HTMLButtonElement;
  row: HTMLElement;
  actions: HTMLElement;
} {
  const wrapper = document.createElement('div');

  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  row.setAttribute('jslog', `["c_${hexId}"]`);
  row.classList.add('gv-conversation-archived');

  const link = document.createElement('a');
  link.href = `/app/${hexId}`;
  const titleEl = document.createElement('span');
  titleEl.className = 'conversation-title-text';
  titleEl.textContent = 'Native title';
  link.appendChild(titleEl);
  row.appendChild(link);

  const actions = document.createElement('div');
  actions.className = 'conversation-actions-container gv-conversation-archived-actions';
  const moreButton = document.createElement('button');
  moreButton.setAttribute('data-test-id', 'actions-menu-button');
  moreButton.addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-container';
    const menuContent = document.createElement('div');
    menuContent.className = 'mat-mdc-menu-content';
    const renameButton = document.createElement('button');
    renameButton.setAttribute('data-test-id', 'rename-button');
    Object.defineProperty(renameButton, 'offsetParent', { get: () => menuContent });
    renameButton.addEventListener('click', onRenameClick);
    menuContent.appendChild(renameButton);
    overlay.appendChild(menuContent);
    document.body.appendChild(overlay);
  });
  actions.appendChild(moreButton);

  wrapper.appendChild(row);
  wrapper.appendChild(actions);
  document.body.appendChild(wrapper);

  return { row, actions, moreButton };
}

describe('Gemini native conversation title sync', () => {
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
    vi.restoreAllMocks();
  });

  it('syncs stored folder conversation titles from native sidebar mutations', async () => {
    const hexId = 'abc123def4567890';
    const titleEl = createNativeConversation(hexId, 'Old title');
    const appRoot = document.createElement('div');
    appRoot.id = 'app-root';
    appRoot.className = 'side-nav-open';
    const sidebar = document.createElement('div');
    sidebar.setAttribute('data-test-id', 'overflow-container');
    const recents = document.createElement('expandable-section');
    recents.setAttribute('data-test-id', 'chats-expandable-section');
    recents.appendChild(titleEl.closest('[data-test-id="conversation"]')!);
    sidebar.appendChild(recents);
    appRoot.appendChild(sidebar);
    document.body.appendChild(appRoot);
    manager = new FolderManager();
    const internals = manager as unknown as TestableManager;

    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: `c_${hexId}`,
            title: 'Old title',
            url: `https://gemini.google.com/app/${hexId}`,
            addedAt: Date.now(),
          },
        ],
      },
    };
    internals.sidebarContainer = sidebar;

    const saveSpy = vi.spyOn(internals, 'saveData').mockResolvedValue(true);
    const renderSpy = vi.spyOn(internals, 'renderAllFolders').mockImplementation(() => {});

    await internals.initializeFolderUI();

    titleEl.textContent = 'Renamed title';
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(350);

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Renamed title');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite manually renamed folder conversation titles', async () => {
    const hexId = 'fedcba0987654321';
    createNativeConversation(hexId, 'Native title');
    manager = new FolderManager();
    const internals = manager as unknown as TestableManager;

    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: `c_${hexId}`,
            title: 'Manual title',
            url: `https://gemini.google.com/app/${hexId}`,
            addedAt: Date.now(),
            customTitle: true,
          },
        ],
      },
    };

    const saveSpy = vi.spyOn(internals, 'saveData').mockResolvedValue(true);
    const renderSpy = vi.spyOn(internals, 'renderAllFolders').mockImplementation(() => {});

    await internals.syncConversationTitlesFromNative();

    expect(internals.data.folderContents.folderA[0]?.title).toBe('Manual title');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('opens the native Gemini rename action for a folder conversation', async () => {
    const hexId = '0123456789abcdef';
    const renameClickSpy = vi.fn();
    const {
      row: nativeRow,
      actions,
      moreButton,
    } = createNativeConversationWithActions(hexId, renameClickSpy);
    const blurSpy = vi.spyOn(moreButton, 'blur');
    manager = new FolderManager();
    const internals = manager as unknown as TestableManager;
    internals.data = {
      folders: [],
      folderContents: {
        folderA: [
          {
            conversationId: `c_${hexId}`,
            title: 'Folder-only title',
            url: `https://gemini.google.com/app/${hexId}`,
            addedAt: Date.now(),
            customTitle: true,
          },
        ],
      },
    };
    internals.sidebarContainer = document.body;
    internals.hideArchivedConversations = true;
    const saveSpy = vi.spyOn(internals, 'saveData').mockResolvedValue(true);
    const renderSpy = vi.spyOn(internals, 'renderAllFolders').mockImplementation(() => {});

    const result = await internals.openNativeRenameForFolderConversation({
      conversationId: hexId,
      title: 'Folder title',
      url: `https://gemini.google.com/app/${hexId}`,
      addedAt: Date.now(),
    });

    expect(result).toBe(true);
    expect(renameClickSpy).toHaveBeenCalledTimes(1);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(nativeRow.classList.contains('gv-conversation-archived')).toBe(true);
    expect(actions.classList.contains('gv-conversation-archived-actions')).toBe(true);
    expect(internals.data.folderContents.folderA[0]?.title).toBe('Native title');
    expect(internals.data.folderContents.folderA[0]?.customTitle).toBeUndefined();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('uses native rename when a folder conversation title is double-clicked', async () => {
    const hexId = '2468abcdef135790';
    const conversation: ConversationReference = {
      conversationId: `c_${hexId}`,
      title: 'Folder title',
      url: `https://gemini.google.com/app/${hexId}`,
      addedAt: Date.now(),
    };
    manager = new FolderManager();
    const internals = manager as unknown as TestableManager;
    const nativeRenameSpy = vi
      .spyOn(internals, 'openNativeRenameForFolderConversation')
      .mockResolvedValue(true);

    const row = internals.createConversationElement(conversation, 'folderA', 1);
    const title = row.querySelector<HTMLElement>('.gv-conversation-title');

    title?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(nativeRenameSpy).toHaveBeenCalledTimes(1);
    expect(nativeRenameSpy).toHaveBeenCalledWith(conversation);
    expect(row.querySelector('.gv-conversation-rename-input')).toBeNull();
  });

  it('shows a right-click menu that invokes native rename instead of folder-only rename', async () => {
    const hexId = '13579abcdef02468';
    const conversation: ConversationReference = {
      conversationId: `c_${hexId}`,
      title: 'Folder title',
      url: `https://gemini.google.com/app/${hexId}`,
      addedAt: Date.now(),
    };
    manager = new FolderManager();
    const internals = manager as unknown as TestableManager;
    const nativeRenameSpy = vi
      .spyOn(internals, 'openNativeRenameForFolderConversation')
      .mockResolvedValue(true);

    const row = internals.createConversationElement(conversation, 'folderA', 1);
    document.body.appendChild(row);

    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 32,
      }),
    );

    const renameItem = document.querySelector('.gv-folder-conversation-menu .gv-folder-menu-item');
    expect(renameItem?.textContent).toBe('folder_rename');

    renameItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(nativeRenameSpy).toHaveBeenCalledTimes(1);
    expect(nativeRenameSpy).toHaveBeenCalledWith(conversation);
    expect(document.querySelector('.gv-folder-conversation-menu')).toBeNull();
  });
});
