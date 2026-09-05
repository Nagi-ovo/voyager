import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { accountIsolationService } from '@/core/services/AccountIsolationService';

import { FolderStore } from './FolderStore';
import type { IFolderStorageAdapter } from './storage/FolderStorageAdapter';
import type { FolderData } from './types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: 'test-extension-id' },
  },
}));

function sampleData(): FolderData {
  return {
    folders: [
      { id: 'root', name: 'Root', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
    ],
    folderContents: {
      root: ['aaaabbbbccccdddd', '1111222233334444'].map((id, index) => ({
        conversationId: `c_${id}`,
        title: `Conversation ${index}`,
        url: `https://gemini.google.com/app/${id}`,
        addedAt: index + 1,
        sortIndex: index,
      })),
    },
  };
}

describe('FolderStore ownership', () => {
  let store: FolderStore;
  let saved: FolderData;
  let adapter: IFolderStorageAdapter;
  const onChange = vi.fn();
  const onRecovery = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
    saved = sampleData();
    adapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async () => structuredClone(saved)),
      saveData: vi.fn(async (_key, data) => {
        saved = structuredClone(data);
        return true;
      }),
      removeData: vi.fn(async () => {}),
      getBackendName: () => 'test-memory',
    };
    store = new FolderStore(
      {
        getContext: () => ({ sidebar: null, sortMode: 'manual', enabled: true }),
        onChange,
        onArchive: vi.fn(),
        onRecovery,
      },
      adapter,
    );
    await store.init();
    onChange.mockClear();
  });

  afterEach(() => {
    store.destroy();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records recency without immediately reordering the visible folder list', async () => {
    const beforeIds = store.data.folderContents.root.map(
      (conversation) => conversation.conversationId,
    );
    store.markConversationAsRecentlyOpened('1111222233334444');
    const target = store.data.folderContents.root[1];
    expect(target.lastOpenedAt).toEqual(expect.any(Number));
    expect(target.updatedAt).toBe(target.lastOpenedAt);
    expect(
      store.data.folderContents.root.map((conversation) => conversation.conversationId),
    ).toEqual(beforeIds);
    expect(adapter.saveData).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);

    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect(saved.folderContents.root[1].lastOpenedAt).toBe(target.lastOpenedAt);
    expect(saved.folderContents.root.map((conversation) => conversation.conversationId)).toEqual(
      beforeIds,
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith('saved');
  });

  it('flushes a pending UI mutation before releasing unload and storage listeners', async () => {
    store.toggleFolder('root');
    expect(adapter.saveData).not.toHaveBeenCalled();
    const registered = vi.mocked(browser.storage.onChanged.addListener).mock.calls[0][0];
    store.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(saved.folders[0].isExpanded).toBe(false);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalledWith(registered);
    vi.mocked(adapter.loadData).mockClear();
    registered({ gvFolderData: { newValue: sampleData() } }, 'local');
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.loadData).not.toHaveBeenCalled();
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
  });

  it('uses one creation command with the existing depth cap and preserves data on rejection', async () => {
    const child = store.createFolder('Child', 'root')!;
    await vi.advanceTimersByTimeAsync(0);
    const before = structuredClone(store.data);
    expect(store.createFolder('Too deep', child.id)).toBeNull();
    expect(store.data).toEqual(before);
    expect(saved.folders.map((folder) => folder.name)).toEqual(['Root', 'Child']);
    expect(saved.folderContents[child.id]).toEqual([]);
    expect(saved.folderContents.root).toHaveLength(2);
  });

  it('persists project instructions and publishes the saved data', async () => {
    const savedSuccessfully = await store.setFolderInstructions(
      'root',
      'Keep the original citations.',
    );
    expect(savedSuccessfully).toBe(true);
    expect(saved.folders[0].instructions).toBe('Keep the original citations.');
    expect(saved.folders[0].updatedAt).toBeGreaterThan(1);
    expect(store.data).toEqual(saved);
    expect(store.canEdit).toBe(true);
    expect(onChange).toHaveBeenCalledWith('data');
  });

  it('buffers the rendered record without overwriting a separate custom title for the same conversation', async () => {
    const nativeRecord = store.data.folderContents.root[0];
    const customRecord = { ...nativeRecord, title: 'My title', customTitle: true };
    store.data.folders.push({ ...store.data.folders[0], id: 'custom', name: 'Custom titles' });
    store.data.folderContents.custom = [customRecord];
    store.bufferTitleUpdate(nativeRecord, 'New native title');
    expect(nativeRecord.title).toBe('New native title');
    expect(customRecord.title).toBe('My title');
    expect(nativeRecord.updatedAt).toBeUndefined();
    expect(adapter.saveData).not.toHaveBeenCalled();

    store.flushTitleUpdates();
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect(saved.folderContents.root.map((conversation) => conversation.title)).toContain(
      'New native title',
    );
    expect(saved.folderContents.custom[0].title).toBe('My title');
    store.flushTitleUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
  });

  it('consumes one mirror echo per write and then applies an external update', async () => {
    const listener = vi.mocked(browser.storage.onChanged.addListener).mock.calls[0][0];
    await store.saveData();
    vi.mocked(adapter.loadData).mockClear();
    listener({ gvFolderData: { newValue: store.data } }, 'local');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.loadData).not.toHaveBeenCalled();

    saved.folders[0].name = 'Changed in another tab';
    listener({ gvFolderData: { newValue: saved } }, 'local');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.data.folders[0].name).toBe('Changed in another tab');
    expect(adapter.loadData).toHaveBeenCalledTimes(1);
  });

  it('applies an external update when no local write has armed echo suppression', async () => {
    const listener = vi.mocked(browser.storage.onChanged.addListener).mock.calls[0][0];
    saved.folders[0].name = 'Cloud update';
    listener({ gvFolderData: { newValue: saved } }, 'local');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.data.folders[0].name).toBe('Cloud update');
  });

  it('coalesces rapid folder toggles into one write with the final expansion state', async () => {
    for (let i = 0; i < 5; i++) store.toggleFolder('root');
    expect(adapter.saveData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect(saved.folders[0].isExpanded).toBe(false);
  });

  it('flushes a scheduled write once and leaves an empty flush harmless', async () => {
    store.flushPendingSaveData();
    expect(adapter.saveData).not.toHaveBeenCalled();
    store.scheduleSaveData();
    store.flushPendingSaveData();
    store.flushPendingSaveData();
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
  });

  it('writes the latest queued edit after an in-flight save completes', async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(adapter.saveData).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = store.saveData();
    store.data.folders[0].name = 'Newest queued edit';
    const queued = store.saveData();
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
    expect(await queued).toBe(true);
    expect(adapter.saveData).toHaveBeenCalledTimes(2);
    expect(saved.folders[0].name).toBe('Newest queued edit');
  });
});
