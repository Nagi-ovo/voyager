import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeFolderData,
  sortConversationsByPriority,
} from '@/features/folder/model/folderData';

import type { FolderStore } from '../FolderStore';
import { FolderManager } from '../manager';
import * as storageAdapters from '../storage/FolderStorageAdapter';
import type { ConversationReference, Folder, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type ManagerOwners = { store: FolderStore };

function createFolder(id: string, name: string, sortIndex: number): Folder {
  const now = Date.now();
  return {
    id,
    name,
    parentId: null,
    isExpanded: true,
    sortIndex,
    createdAt: now,
    updatedAt: now,
  };
}

function createConversation(
  conversationId: string,
  sortIndex: number,
  addedAt: number,
): ConversationReference {
  return {
    conversationId,
    title: conversationId,
    url: `https://gemini.google.com/app/${conversationId}`,
    addedAt,
    lastOpenedAt: addedAt,
    sortIndex,
  };
}

describe('addConversationToFolderFromNative — sort-order preservation', () => {
  let manager: FolderManager | null = null;
  let saved: FolderData | null = null;

  async function makeManager(): Promise<FolderStore> {
    saved = null;
    vi.spyOn(storageAdapters, 'createFolderStorageAdapter').mockReturnValue({
      init: async () => {},
      loadData: async () => ({ folders: [], folderContents: {} }),
      saveData: async (_key, data) => {
        saved = structuredClone(data);
        return true;
      },
      removeData: async () => {},
      getBackendName: () => 'test-memory',
    });
    manager = new FolderManager();
    const store = (manager as unknown as ManagerOwners).store;
    await store.init();
    return store;
  }

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('places newly auto-assigned conversation at the top after data normalization', async () => {
    const store = await makeManager();

    const folder = createFolder('folder-1', 'Project A', 0);
    store.data = {
      folders: [folder],
      folderContents: {
        'folder-1': [
          createConversation('existing-old', 0, 100),
          createConversation('existing-newer', 1, 200),
        ],
      },
    };

    (manager as FolderManager).addConversationToFolderFromNative(
      'folder-1',
      'auto-assigned',
      'Auto Assigned',
      'https://gemini.google.com/app/auto-assigned',
    );

    store.data = normalizeFolderData(store.data);

    const sorted = sortConversationsByPriority(store.data.folderContents['folder-1']);

    expect(sorted[0]?.conversationId).toBe('auto-assigned');
    expect(
      sortConversationsByPriority(saved?.folderContents['folder-1'] ?? [])[0]?.conversationId,
    ).toBe('auto-assigned');
  });

  it('does not create duplicate sortIndex values when an existing entry lacks sortIndex', async () => {
    const store = await makeManager();

    const folder = createFolder('folder-1', 'Project A', 0);
    store.data = {
      folders: [folder],
      folderContents: {
        'folder-1': [
          // Indexed entry, newer in time
          createConversation('indexed-newer', 0, 200),
          // Null-sortIndex entry, older in time. ensureSortIndices will assign it 1
          // (last position in time-DESC order). Without normalization-before-shift,
          // (sortIndex ?? 0) + 1 would map both this entry and 'indexed-newer' to 1.
          {
            conversationId: 'no-index-older',
            title: 'no-index-older',
            url: 'https://gemini.google.com/app/no-index-older',
            addedAt: 100,
            lastOpenedAt: 100,
          },
        ],
      },
    };

    (manager as FolderManager).addConversationToFolderFromNative(
      'folder-1',
      'auto-assigned',
      'Auto Assigned',
      'https://gemini.google.com/app/auto-assigned',
    );

    const indices = store.data.folderContents['folder-1'].map((c) => c.sortIndex);
    expect(new Set(indices).size).toBe(indices.length);
    expect(saved?.folderContents['folder-1'].map((conversation) => conversation.sortIndex)).toEqual(
      indices,
    );
  });
});
