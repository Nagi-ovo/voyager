import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FolderSidebarRuntime } from '../FolderSidebarRuntime';
import type { FolderStore } from '../FolderStore';
import { FolderManager } from '../manager';
import type { ConversationReference, FolderData } from '../types';
import { mountSidebar } from './sidebarRuntimeHarness';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

function createConversation(hexId: string, title: string): ConversationReference {
  return {
    conversationId: `c_${hexId}`,
    title,
    url: `https://gemini.google.com/app/${hexId}`,
    addedAt: Date.now(),
  };
}

function createNativeConversation(hexId: string, title: string) {
  const wrapper = document.createElement('div');
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
  wrapper.appendChild(row);
  return { wrapper, row, titleEl };
}

function addNativeActions(wrapper: HTMLElement, onRenameClick: () => void) {
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
  wrapper.appendChild(actions);
  return { actions, moreButton };
}

describe('Gemini native conversation title sync', () => {
  let manager: FolderManager;

  async function mountFolder(
    conversation: ConversationReference,
    native: HTMLElement,
    hideArchived = false,
  ) {
    const { recentsSection } = mountSidebar();
    recentsSection.appendChild(native);
    manager = new FolderManager();
    const { store, sidebarRuntime } = manager as unknown as {
      store: FolderStore;
      sidebarRuntime: FolderSidebarRuntime;
    };
    (manager as unknown as { hideArchivedConversations: boolean }).hideArchivedConversations =
      hideArchived;
    store.data = {
      folders: [
        {
          id: 'folderA',
          name: 'Folder A',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { folderA: [conversation] },
    };
    await sidebarRuntime.start('sidebar');
    return { store, panel: sidebarRuntime.panel! };
  }

  function savedConversation(): ConversationReference {
    const data: FolderData = JSON.parse(localStorage.getItem('gvFolderData')!);
    return data.folderContents.folderA[0];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    manager?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('syncs stored folder conversation titles from native sidebar mutations', async () => {
    const hexId = 'abc123def4567890';
    const { wrapper, titleEl } = createNativeConversation(hexId, 'Old title');
    const { store, panel } = await mountFolder(createConversation(hexId, 'Old title'), wrapper);

    titleEl.textContent = 'Renamed title';
    await vi.advanceTimersByTimeAsync(350);

    expect(store.data.folderContents.folderA[0].title).toBe('Renamed title');
    expect(savedConversation().title).toBe('Renamed title');
    expect(panel.querySelector('.gv-conversation-title')?.textContent).toBe('Renamed title');
  });

  it('does not overwrite manually renamed folder conversation titles', async () => {
    const hexId = 'fedcba0987654321';
    const { wrapper, titleEl } = createNativeConversation(hexId, 'Native title');
    const { store, panel } = await mountFolder(
      { ...createConversation(hexId, 'Manual title'), customTitle: true },
      wrapper,
    );
    titleEl.textContent = 'Changed native title';
    await vi.advanceTimersByTimeAsync(350);

    expect(store.data.folderContents.folderA[0].title).toBe('Manual title');
    expect(panel.querySelector('.gv-conversation-title')?.textContent).toBe('Manual title');
    expect(localStorage.getItem('gvFolderData')).toBeNull();
  });

  it.each(['double-click', 'right-click menu'])(
    'opens the native Gemini rename action through the %s and restores title sync',
    async (trigger) => {
      const hexId = '0123456789abcdef';
      const native = createNativeConversation(hexId, 'Native title');
      native.row.classList.add('gv-conversation-archived');
      const renameClicked = vi.fn();
      const { moreButton, actions } = addNativeActions(native.wrapper, renameClicked);
      const blur = vi.spyOn(moreButton, 'blur');
      const { store, panel } = await mountFolder(
        { ...createConversation(hexId, 'Folder-only title'), customTitle: true },
        native.wrapper,
        true,
      );
      const row = panel.querySelector<HTMLElement>('.gv-folder-conversation')!;

      if (trigger === 'double-click') {
        row
          .querySelector('.gv-conversation-title')!
          .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      } else {
        row.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 32,
          }),
        );
        const renameItem = document.querySelector<HTMLElement>(
          '.gv-folder-conversation-menu .gv-folder-menu-item',
        )!;
        expect(renameItem.textContent).toBe('folder_rename');
        renameItem.click();
        expect(document.querySelector('.gv-folder-conversation-menu')).toBeNull();
      }
      await vi.advanceTimersByTimeAsync(100);

      expect(renameClicked).toHaveBeenCalledTimes(1);
      expect(blur).toHaveBeenCalledTimes(1);
      expect(native.row.classList.contains('gv-conversation-archived')).toBe(true);
      expect(actions.classList.contains('gv-conversation-archived-actions')).toBe(true);
      expect(store.data.folderContents.folderA[0].title).toBe('Native title');
      expect(store.data.folderContents.folderA[0].customTitle).toBeUndefined();
      expect(savedConversation().title).toBe('Native title');
      expect(savedConversation().customTitle).toBeUndefined();
      expect(panel.querySelector('.gv-conversation-title')?.textContent).toBe('Native title');
      expect(panel.querySelector('.gv-conversation-rename-input')).toBeNull();
    },
  );
});
