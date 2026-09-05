import { describe, expect, it } from 'vitest';

import type { ConversationReference, Folder, FolderData } from '@/core/types/folder';

import {
  getFolderAndDescendants,
  getFolderDepth,
  moveFolder,
  normalizeFolderData,
  removeFolder,
  reorderConversations,
  sortFolders,
} from '../folderData';

function folder(id: string, parentId: string | null = null, sortIndex = 0): Folder {
  return { id, name: id, parentId, sortIndex, isExpanded: true, createdAt: 1, updatedAt: 2 };
}

function conversation(id: string, sortIndex = 0): ConversationReference {
  return { conversationId: id, title: id, url: `/app/${id}`, addedAt: 1, sortIndex };
}

function freezeData(data: FolderData): FolderData {
  data.folders.forEach(Object.freeze);
  Object.freeze(data.folders);
  for (const conversations of Object.values(data.folderContents)) {
    conversations.forEach(Object.freeze);
    Object.freeze(conversations);
  }
  Object.freeze(data.folderContents);
  return Object.freeze(data);
}

function orderedFolderIds(data: FolderData, parentId: string | null): string[] {
  return data.folders
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    .map((item) => item.id);
}

describe('folder data movement', () => {
  it.each([
    { index: 2, expected: ['b', 'a', 'c'] },
    { index: 3, expected: ['b', 'c', 'a'] },
    { index: 100, expected: ['b', 'c', 'a'] },
    { index: -10, expected: ['a', 'b', 'c'] },
  ])('reorders within a parent at original-list index $index', ({ index, expected }) => {
    const data = freezeData({
      folders: [folder('a'), folder('b', null, 1), folder('c', null, 2)],
      folderContents: {},
    });

    const result = moveFolder(data, 'a', null, 123, index);

    expect(orderedFolderIds(result, null)).toEqual(expected);
    expect(result.folders[0]).toEqual({
      ...data.folders[0],
      updatedAt: 123,
      sortIndex: expected.indexOf('a'),
    });
    expect(result.folders.slice(1).map((item) => item.updatedAt)).toEqual([2, 2]);
    expect(result.folderContents).toBe(data.folderContents);
    expect(data.folders.map((item) => item.sortIndex)).toEqual([0, 1, 2]);
  });

  it('moves a multi-level folder into another folder while keeping subtree order and metadata intact', () => {
    const data = freezeData({
      folders: [
        folder('target'),
        folder('existing-child', 'target'),
        { ...folder('moving', null, 1), color: 'blue', instructions: 'Keep these instructions' },
        folder('moving-child-a', 'moving'),
        folder('moving-child-b', 'moving', 1),
      ],
      folderContents: {
        moving: [conversation('stored')],
        __root_conversations__: [conversation('root')],
      },
    });

    const result = moveFolder(data, 'moving', 'target', 123);

    expect(result.folders[2]).toEqual({ ...data.folders[2], parentId: 'target', updatedAt: 123 });
    expect(orderedFolderIds(result, 'target')).toEqual(['existing-child', 'moving']);
    expect(orderedFolderIds(result, 'moving')).toEqual(['moving-child-a', 'moving-child-b']);
    expect(result.folders[3]).toBe(data.folders[3]);
    expect(result.folders[4]).toBe(data.folders[4]);
    expect(result.folderContents).toBe(data.folderContents);
    expect(data.folders[2].parentId).toBeNull();
  });

  it('moves a multi-level folder to root while retaining source siblings and subtree order', () => {
    const data = freezeData({
      folders: [
        folder('root-a'),
        folder('root-b', null, 1),
        folder('container', null, 2),
        folder('existing-child', 'container'),
        folder('moving', 'container', 1),
        folder('moving-child-a', 'moving'),
        folder('moving-child-b', 'moving', 1),
      ],
      folderContents: {},
    });

    const result = moveFolder(data, 'moving', null, 123);

    expect(result.folders[4].parentId).toBeNull();
    expect(orderedFolderIds(result, null)).toEqual(['root-a', 'root-b', 'container', 'moving']);
    expect(orderedFolderIds(result, 'container')).toEqual(['existing-child']);
    expect(orderedFolderIds(result, 'moving')).toEqual(['moving-child-a', 'moving-child-b']);
    expect(data.folders[4].parentId).toBe('container');
  });

  it.each([
    { id: 'pinned', parent: 'target' },
    { id: 'ancestor', parent: 'ancestor' },
    { id: 'ancestor', parent: 'child' },
    { id: 'missing', parent: 'target' },
    { id: 'ancestor', parent: null },
  ])('leaves input intact when moving $id to $parent is rejected', ({ id, parent }) => {
    const data = freezeData({
      folders: [
        { ...folder('pinned'), pinned: true },
        folder('target', null, 1),
        folder('ancestor', null, 2),
        folder('child', 'ancestor'),
      ],
      folderContents: { ancestor: [conversation('keep')] },
    });
    expect(moveFolder(data, id, parent, 123)).toBe(data);
  });

  it('does not renumber pinned siblings when reordering an unpinned folder', () => {
    const data = freezeData({
      folders: [{ ...folder('pinned', null, 8), pinned: true }, folder('a'), folder('b', null, 1)],
      folderContents: {},
    });
    const result = moveFolder(data, 'a', null, 123, 2);
    expect(result.folders.map((item) => item.sortIndex)).toEqual([8, 1, 0]);
    expect(result.folders[0]).toBe(data.folders[0]);
  });
});

describe('folder data traversal and removal', () => {
  it('retains depth-first source order, root depth and the unknown-folder fallback', () => {
    const data = freezeData({
      folders: [folder('root'), folder('a', 'root'), folder('b', 'root'), folder('leaf', 'a')],
      folderContents: {},
    });
    expect(getFolderAndDescendants(data, 'root')).toEqual(['root', 'a', 'leaf', 'b']);
    expect(getFolderAndDescendants(data, 'missing')).toEqual(['missing']);
    expect(getFolderDepth(data, 'root')).toBe(0);
    expect(getFolderDepth(data, 'leaf')).toBe(2);
    expect(getFolderDepth(data, 'missing')).toBe(0);
  });

  it('terminates cyclic legacy traversal without rewriting parent links', () => {
    const data = freezeData({
      folders: [folder('a', 'b'), folder('b', 'a'), folder('c')],
      folderContents: {},
    });
    expect(getFolderAndDescendants(data, 'a')).toEqual(['a', 'b']);
    expect(getFolderDepth(data, 'a')).toBe(2);
    expect(moveFolder(data, 'a', 'b', 123)).toBe(data);
    expect(data.folders.map((item) => item.parentId)).toEqual(['b', 'a', null]);
  });

  it('removes only exact subtree IDs while preserving root conversations and unrelated legacy buckets', () => {
    const data = freezeData({
      folders: [folder('a'), folder('child', 'a'), folder('ab')],
      folderContents: {
        a: [conversation('a-chat')],
        child: [conversation('child-chat')],
        ab: [conversation('ab-chat')],
        legacy: [conversation('legacy-chat')],
        __root_conversations__: [conversation('root-chat')],
      },
    });
    const result = removeFolder(data, 'a');
    expect(result.folders.map((item) => item.id)).toEqual(['ab']);
    expect(Object.keys(result.folderContents)).toEqual(['ab', 'legacy', '__root_conversations__']);
    expect(result.folderContents.legacy).toBe(data.folderContents.legacy);
    expect(data.folders).toHaveLength(3);
    expect(data.folderContents.a).toHaveLength(1);
    expect(removeFolder(result, 'missing')).toBe(result);
  });
});

describe('folder data conversation order', () => {
  it('counts duplicate selected IDs once when adjusting a same-folder insertion gap', () => {
    const data = freezeData({
      folders: [],
      folderContents: {
        folder: ['a', 'b', 'c', 'd'].map((id, index) => conversation(id, index)),
      },
    });

    const result = reorderConversations(data, ['a', 'a'], 'folder', 'folder', 3);

    expect(result.folderContents.folder.map((item) => item.conversationId)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
    expect(result.folderContents.folder.map((item) => item.sortIndex)).toEqual([0, 1, 2, 3]);
    expect(data.folderContents.folder.map((item) => item.conversationId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('adjusts same-folder insertion within the dragged starred group and retains all metadata', () => {
    const moving = {
      ...conversation('a'),
      starred: true,
      customTitle: true,
      lastTurnAt: 42,
      updatedAt: 7,
    };
    const data = freezeData({
      folders: [],
      folderContents: {
        folder: [
          moving,
          { ...conversation('b', 1), starred: true },
          { ...conversation('c', 2), starred: true },
          conversation('normal', 9),
        ],
      },
    });
    const result = reorderConversations(data, ['a'], 'folder', 'folder', 2);
    expect(
      result.folderContents.folder.map((item) => [item.conversationId, item.sortIndex]),
    ).toEqual([
      ['b', 0],
      ['a', 1],
      ['c', 2],
      ['normal', 9],
    ]);
    expect(result.folderContents.folder[1]).toEqual({ ...moving, sortIndex: 1 });
    expect(data.folderContents.folder[0]).toBe(moving);
    expect(moving.sortIndex).toBe(0);
  });

  it('moves unique references to root, replaces target duplicates and reindexes only affected lists', () => {
    const moving = {
      ...conversation('a', 1),
      customTitle: true,
      lastTurnAt: 42,
      isGem: true,
      gemId: 'gem',
    };
    const data = freezeData({
      folders: [],
      folderContents: {
        source: [conversation('b'), moving, conversation('c', 2)],
        __root_conversations__: [
          conversation('first'),
          { ...conversation('a', 1), title: 'target duplicate' },
        ],
        untouched: [conversation('a')],
      },
    });
    const result = reorderConversations(
      data,
      ['a', 'a', 'missing'],
      'source',
      '__root_conversations__',
      0,
    );
    expect(
      result.folderContents.source.map((item) => [item.conversationId, item.sortIndex]),
    ).toEqual([
      ['b', 0],
      ['c', 1],
    ]);
    expect(result.folderContents.__root_conversations__).toEqual([
      { ...moving, sortIndex: 0 },
      conversation('first', 1),
    ]);
    expect(result.folderContents.untouched).toBe(data.folderContents.untouched);
    expect(data.folderContents.source).toHaveLength(3);
    expect(data.folderContents.__root_conversations__[1].title).toBe('target duplicate');
  });

  it('keeps the original data when the source contains none of the selected IDs', () => {
    const data = freezeData({ folders: [], folderContents: { source: [conversation('a')] } });
    expect(reorderConversations(data, ['missing'], 'source', 'new-target', 0)).toBe(data);
    expect(data.folderContents).not.toHaveProperty('new-target');
  });

  it('sorts folders by pinned group, manual index and natural name without mutating the list', () => {
    const folders = [
      folder('Folder 10'),
      { ...folder('Folder 2'), sortIndex: undefined },
      { ...folder('Pinned'), pinned: true },
    ];
    const original = folders.slice();
    expect(sortFolders(folders).map((item) => item.id)).toEqual([
      'Pinned',
      'Folder 2',
      'Folder 10',
    ]);
    expect(
      sortFolders([folder('a', null, 5), folder('z', null, 1)]).map((item) => item.id),
    ).toEqual(['z', 'a']);
    expect(folders).toEqual(original);
  });
});

describe('folder data integrity', () => {
  it('fills missing containers and initializes empty folder buckets', () => {
    expect(normalizeFolderData({} as FolderData)).toEqual({ folders: [], folderContents: {} });
    const data = freezeData({ folders: [folder('empty')], folderContents: {} });
    expect(normalizeFolderData(data).folderContents).toEqual({ empty: [] });
    expect(data.folderContents).toEqual({});
  });

  it('keeps the first exact duplicate, legacy ID variants, orphan contents and original parents', () => {
    const first = { ...conversation('c_abc'), customTitle: true };
    const data = freezeData({
      folders: [folder('orphan', 'missing-parent')],
      folderContents: {
        orphan: [first, { ...conversation('c_abc'), title: 'duplicate' }, conversation('abc', 1)],
        legacy: [conversation('legacy')],
        __root_conversations__: [conversation('root')],
      },
    });
    const result = normalizeFolderData(data);
    expect(result.folderContents.orphan).toEqual([first, conversation('abc', 1)]);
    expect(result.folderContents.orphan[0]).toBe(first);
    expect(result.folderContents.legacy).toBe(data.folderContents.legacy);
    expect(result.folderContents.__root_conversations__).toBe(
      data.folderContents.__root_conversations__,
    );
    expect(result.folders[0].parentId).toBe('missing-parent');
    expect(data.folderContents.orphan).toHaveLength(3);
    expect(normalizeFolderData(result)).toBe(result);
  });

  it('fills only missing indices using legacy name and activity order, preserving existing indices and timestamps', () => {
    const data = freezeData({
      folders: [
        { ...folder('Folder 10'), sortIndex: undefined },
        { ...folder('Folder 2'), pinned: true, sortIndex: undefined },
        folder('Folder 1', null, 8),
      ],
      folderContents: {
        'Folder 1': [
          { ...conversation('old'), sortIndex: undefined },
          { ...conversation('opened'), sortIndex: undefined, lastOpenedAt: 5 },
          { ...conversation('already-indexed', 9), addedAt: 10 },
        ],
      },
    });
    const result = normalizeFolderData(data);
    expect(result.folders.map((item) => item.sortIndex)).toEqual([2, 1, 8]);
    expect(result.folderContents['Folder 1'].map((item) => item.sortIndex)).toEqual([2, 1, 9]);
    expect(result.folders.map((item) => item.updatedAt)).toEqual([2, 2, 2]);
    expect(result.folderContents['Folder 1'][1]).toEqual({
      ...data.folderContents['Folder 1'][1],
      sortIndex: 1,
    });
    expect(data.folders[0].sortIndex).toBeUndefined();
  });
});
