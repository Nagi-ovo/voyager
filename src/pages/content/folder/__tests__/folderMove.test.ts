import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import type { ConversationReference, DragData, Folder, FolderData } from '../types';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

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

function getOrderedFolderIds(data: FolderData, parentId: string | null): string[] {
  return data.folders
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
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  const requestAnimationFrameMock = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
  const cancelAnimationFrameMock = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id: number) => {
      callbacks.delete(id);
    });

  return {
    requestAnimationFrameMock,
    flush: () => {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      pending.forEach(([, callback]) => callback(0));
    },
    restore: () => {
      requestAnimationFrameMock.mockRestore();
      cancelAnimationFrameMock.mockRestore();
    },
  };
}

describe('folder movement', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
  });

  afterEach(() => {
    harness?.destroy();
    rafQueue?.restore();
    rafQueue = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows dragging a non-pinned folder even when it has subfolders', async () => {
    harness = await createFolderViewHarness({
      folders: [
        createFolder('parent', 'Parent', null, 0),
        createFolder('child', 'Child', 'parent', 0),
        createFolder('pinned', 'Pinned', null, 1, true),
      ],
      folderContents: {},
    });

    const panel = harness.runtime.panel!;
    expect(
      panel.querySelector<HTMLElement>('[data-folder-id="parent"] > .gv-folder-item-header')!
        .draggable,
    ).toBe(true);
    expect(
      panel.querySelector<HTMLElement>('[data-folder-id="pinned"] > .gv-folder-item-header')!
        .draggable,
    ).toBe(false);
  });

  it('preserves sibling order when reordering a folder within the same parent', async () => {
    harness = await createFolderViewHarness({
      folders: [
        createFolder('a', 'A', null, 0),
        createFolder('b', 'B', null, 1),
        createFolder('c', 'C', null, 2),
      ],
      folderContents: {},
    });

    harness.store.reorderFolder('a', '__root__', 2);
    await vi.advanceTimersByTimeAsync(0);

    expect(getOrderedFolderIds(harness.store.data, null)).toEqual(['b', 'a', 'c']);
    expect(getOrderedFolderIds(harness.saved, null)).toEqual(['b', 'a', 'c']);
    expect(harness.adapter.saveData).toHaveBeenCalledTimes(1);
    expect(harness.onRefresh).toHaveBeenCalledTimes(1);
    expect(
      Array.from(harness.runtime.panel!.querySelectorAll<HTMLElement>('.gv-folder-item')).map(
        (row) => row.dataset.folderId,
      ),
    ).toEqual(['b', 'a', 'c']);
  });

  it.each(['pinned', 'descendant'])(
    'does not save or refresh after a rejected %s move',
    async (reason) => {
      harness = await createFolderViewHarness({
        folders: [
          createFolder('moving', 'Moving', null, 0, reason === 'pinned'),
          createFolder('target', 'Target', reason === 'descendant' ? 'moving' : null, 1),
        ],
        folderContents: {},
      });
      const original = structuredClone(harness.store.data);
      const originalList = harness.runtime.panel!.querySelector('.gv-folder-list');
      harness.store.addFolderToFolder('target', createFolderDragData('moving', 'Moving'));
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.store.data).toEqual(original);
      expect(harness.adapter.saveData).not.toHaveBeenCalled();
      expect(harness.onRefresh).not.toHaveBeenCalled();
      expect(originalList!.isConnected).toBe(true);
    },
  );

  it('restores in-folder conversation reorder handles in manual mode', async () => {
    harness = await createFolderViewHarness({
      folders: [createFolder('folder', 'Folder', null, 0)],
      folderContents: {
        folder: [
          createConversation('a', 0),
          createConversation('b', 1),
          createConversation('c', 2),
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    rafQueue = installRafQueue();
    const rows = Array.from(
      harness.runtime.panel!.querySelectorAll<HTMLElement>('.gv-folder-conversation'),
    );
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
    rows[2].dispatchEvent(createDragEvent('drop', 5, dragData));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.adapter.saveData).toHaveBeenCalledTimes(1);
    expect(
      harness.store.data.folderContents.folder
        .slice()
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((conversation) => conversation.conversationId),
    ).toEqual(['b', 'a', 'c']);
    expect(
      Array.from(
        harness.runtime.panel!.querySelectorAll<HTMLElement>('.gv-folder-conversation'),
      ).map((row) => row.dataset.conversationId),
    ).toEqual(['b', 'a', 'c']);
  });

  it('keeps in-folder reorder disabled in recently-opened mode and explains why', async () => {
    harness = await createFolderViewHarness({
      folders: [createFolder('folder', 'Folder', null, 0)],
      folderContents: { folder: [createConversation('a', 0), createConversation('b', 1)] },
    });
    harness.treeView.applySettings(
      { [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: { newValue: 'recent' } },
      'sync',
    );
    await vi.advanceTimersByTimeAsync(0);
    rafQueue = installRafQueue();
    const rows = Array.from(
      harness.runtime.panel!.querySelectorAll<HTMLElement>('.gv-folder-conversation'),
    );
    const content = harness.runtime.panel!.querySelector<HTMLElement>('.gv-folder-content');
    const original = structuredClone(harness.store.data);
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
    expect(harness.store.data).toEqual(original);
    expect(harness.adapter.saveData).not.toHaveBeenCalled();
  });
});
