import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeFolderData,
  sortConversationsByPriority,
} from '@/features/folder/model/folderData';

import { FolderManager } from '../manager';
import type { ConversationReference, Folder, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type TestableManager = {
  data: FolderData;
  saveData: () => void;
  refresh: () => void;
};

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

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('places newly auto-assigned conversation at the top after data normalization', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    vi.spyOn(typedManager, 'saveData').mockImplementation(() => {});
    vi.spyOn(typedManager, 'refresh').mockImplementation(() => {});

    const folder = createFolder('folder-1', 'Project A', 0);
    typedManager.data = {
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

    typedManager.data = normalizeFolderData(typedManager.data);

    const sorted = sortConversationsByPriority(typedManager.data.folderContents['folder-1']);

    expect(sorted[0]?.conversationId).toBe('auto-assigned');
  });

  it('does not create duplicate sortIndex values when an existing entry lacks sortIndex', () => {
    manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    vi.spyOn(typedManager, 'saveData').mockImplementation(() => {});
    vi.spyOn(typedManager, 'refresh').mockImplementation(() => {});

    const folder = createFolder('folder-1', 'Project A', 0);
    typedManager.data = {
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

    const indices = typedManager.data.folderContents['folder-1'].map((c) => c.sortIndex);
    expect(new Set(indices).size).toBe(indices.length);
  });
});
