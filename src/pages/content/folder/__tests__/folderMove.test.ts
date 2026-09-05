import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationSortMode } from '@/features/folder/model/folderData';

import { FolderManager } from '../manager';
import type { ConversationReference, DragData, Folder, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type TestableManager = {
  data: FolderData;
  conversationSortMode: ConversationSortMode;
  saveData: () => void;
  refresh: () => void;
  createFolderElement: (folder: Folder, level?: number) => HTMLElement;
  reorderFolder: (folderId: string, targetParentId: string, insertIndex: number) => void;
  addFolderToFolder: (targetFolderId: string, dragData: DragData) => void;
};

type RafQueue = {
  flush: () => void;
  restore: () => void;
  requestAnimationFrameMock: ReturnType<typeof vi.fn>;
};

let rafQueue: RafQueue | null = null;

function createFolder(
  id: string,
  name: string,
  parentId: string | null,
  sortIndex: number,
  pinned?: boolean,
): Folder {
  const now = Date.now();
  return {
    id,
    name,
    parentId,
    isExpanded: true,
    pinned,
    sortIndex,
    createdAt: now,
    updatedAt: now,
  };
}

function getOrderedFolderIds(manager: TestableManager, parentId: string | null): string[] {
  return manager.data.folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    .map((folder) => folder.id);
}

function createFolderDragData(folderId: string, title: string): DragData {
  return {
    type: 'folder',
    folderId,
    title,
  };
}

function createConversation(id: string, sortIndex: number): ConversationReference {
  return {
    conversationId: id,
    title: `Conversation ${id}`,
    url: `/app/${id}`,
    addedAt: Date.now(),
    sortIndex,
  };
}

function createDataTransfer(payload: DragData): DataTransfer {
  return {
    types: ['application/json'],
    effectAllowed: 'all',
    dropEffect: 'none',
    getData: vi.fn(() => JSON.stringify(payload)),
    setData: vi.fn(),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function createDragEvent(type: string, clientY: number, payload: DragData): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: createDataTransfer(payload),
    configurable: true,
  });
  return event;
}

function installRafQueue(): RafQueue {
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  const cancelAnimationFrameMock = vi.fn((id: number) => {
    callbacks.delete(id);
  });

  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelAnimationFrameMock,
  });

  return {
    requestAnimationFrameMock,
    flush: () => {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      pending.forEach(([, callback]) => callback(0));
    },
    restore: () => {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRaf,
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelRaf,
      });
    },
  };
}

describe('folder movement', () => {
  let manager: FolderManager | null = null;

  afterEach(() => {
    manager?.destroy();
    rafQueue?.restore();
    rafQueue = null;
    manager = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('allows dragging a non-pinned folder even when it has subfolders', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const parentFolder = createFolder('parent', 'Parent', null, 0);
    const childFolder = createFolder('child', 'Child', 'parent', 0);
    const pinnedFolder = createFolder('pinned', 'Pinned', null, 1, true);

    typedManager.data = {
      folders: [parentFolder, childFolder, pinnedFolder],
      folderContents: {},
    };

    const parentElement = typedManager.createFolderElement(parentFolder);
    const pinnedElement = typedManager.createFolderElement(pinnedFolder);
    const parentHeader = parentElement.querySelector('.gv-folder-item-header');
    const pinnedHeader = pinnedElement.querySelector('.gv-folder-item-header');

    expect(parentHeader instanceof HTMLElement ? parentHeader.draggable : false).toBe(true);
    expect(pinnedHeader instanceof HTMLElement ? pinnedHeader.draggable : true).toBe(false);
  });

  it('preserves sibling order when reordering a folder within the same parent', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const saveSpy = vi.spyOn(typedManager, 'saveData').mockImplementation(() => {});
    const refreshSpy = vi.spyOn(typedManager, 'refresh').mockImplementation(() => {});

    typedManager.data = {
      folders: [
        createFolder('a', 'A', null, 0),
        createFolder('b', 'B', null, 1),
        createFolder('c', 'C', null, 2),
      ],
      folderContents: {},
    };

    typedManager.reorderFolder('a', '__root__', 2);

    expect(getOrderedFolderIds(typedManager, null)).toEqual(['b', 'a', 'c']);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['pinned', 'descendant'])(
    'does not save or refresh after a rejected %s move',
    (reason) => {
      manager = new FolderManager();
      const typedManager = manager as unknown as TestableManager;
      const saveSpy = vi.spyOn(typedManager, 'saveData').mockImplementation(() => {});
      const refreshSpy = vi.spyOn(typedManager, 'refresh').mockImplementation(() => {});

      typedManager.data = {
        folders: [
          createFolder('moving', 'Moving', null, 0, reason === 'pinned'),
          createFolder('target', 'Target', reason === 'descendant' ? 'moving' : null, 1),
        ],
        folderContents: {},
      };

      const original = structuredClone(typedManager.data);
      typedManager.addFolderToFolder('target', createFolderDragData('moving', 'Moving'));

      expect(typedManager.data).toEqual(original);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
    },
  );

  it('restores in-folder conversation reorder handles in manual mode', () => {
    rafQueue = installRafQueue();
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;

    const folder = createFolder('folder', 'Folder', null, 0);
    typedManager.data = {
      folders: [folder],
      folderContents: {
        folder: [
          createConversation('a', 0),
          createConversation('b', 1),
          createConversation('c', 2),
        ],
      },
    };

    const folderElement = typedManager.createFolderElement(folder);
    document.body.appendChild(folderElement);
    const rows = Array.from(folderElement.querySelectorAll<HTMLElement>('.gv-folder-conversation'));
    const dragData: DragData = {
      type: 'conversation',
      title: 'Conversation a',
      conversations: [createConversation('a', 0)],
      sourceFolderId: 'folder',
    };

    Object.defineProperty(rows[2], 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 40 }),
    });
    rows[2].dispatchEvent(createDragEvent('dragover', 5, dragData));

    expect(rafQueue.requestAnimationFrameMock).toHaveBeenCalledTimes(1);
    rafQueue.flush();
    expect(rows[2].classList.contains('gv-reorder-above')).toBe(true);

    const saveSpy = vi.spyOn(typedManager, 'saveData').mockImplementation(() => {});
    vi.spyOn(typedManager, 'refresh').mockImplementation(() => {});
    rows[2].dispatchEvent(createDragEvent('drop', 5, dragData));

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(
      typedManager.data.folderContents.folder
        .slice()
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((conversation) => conversation.conversationId),
    ).toEqual(['b', 'a', 'c']);
  });

  it('keeps in-folder reorder disabled in recently-opened mode and explains why', () => {
    rafQueue = installRafQueue();
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.conversationSortMode = 'recent';

    const folder = createFolder('folder', 'Folder', null, 0);
    typedManager.data = {
      folders: [folder],
      folderContents: { folder: [createConversation('a', 0), createConversation('b', 1)] },
    };

    const folderElement = typedManager.createFolderElement(folder);
    document.body.appendChild(folderElement);
    const rows = Array.from(folderElement.querySelectorAll<HTMLElement>('.gv-folder-conversation'));
    const content = folderElement.querySelector<HTMLElement>('.gv-folder-content');
    const dragData: DragData = {
      type: 'conversation',
      title: 'Conversation a',
      conversations: [createConversation('a', 0)],
      sourceFolderId: 'folder',
    };

    rows[1].dispatchEvent(createDragEvent('dragover', 5, dragData));
    expect(rafQueue.requestAnimationFrameMock).not.toHaveBeenCalled();
    expect(content?.classList.contains('gv-folder-dragover')).toBe(true);

    rows[1].dispatchEvent(createDragEvent('drop', 5, dragData));
    expect(document.querySelector('.gv-notification')?.textContent).toBe(
      'folder_sort_recent_drag_hint',
    );
  });
});
