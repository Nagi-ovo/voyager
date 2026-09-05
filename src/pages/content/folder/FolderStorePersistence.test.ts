import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
} from '@/core/services/AccountIsolationService';

import { FolderStore } from './FolderStore';
import type { IFolderStorageAdapter } from './storage/FolderStorageAdapter';
import type { ConversationReference, DragData, FolderData } from './types';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function sampleData(name = 'Original'): FolderData {
  return {
    folders: [
      { id: 'root', name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      { id: 'other', name: 'Other', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
    ],
    folderContents: {
      root: [
        {
          conversationId: 'c_123456789abcdef0',
          title: 'Original chat',
          url: '/app/123456789abcdef0',
          addedAt: 1,
        },
      ],
      other: [],
    },
  };
}

function accountScope(account: string): AccountScope {
  return { accountKey: `email:${account}`, accountId: 1, routeUserId: account, emailHash: account };
}

describe('FolderStore editable account and save completion', () => {
  let store: FolderStore;
  let adapter: IFolderStorageAdapter;
  let saved: Map<string, FolderData>;
  const onChange = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
    saved = new Map([['gvFolderData', sampleData()]]);
    adapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async (key) => structuredClone(saved.get(key) ?? null)),
      saveData: vi.fn(async (key, data) => {
        saved.set(key, structuredClone(data));
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
        onRecovery: vi.fn(),
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

  it('keeps coalesced callers pending until their trailing snapshot is persisted', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const writes: FolderData[] = [];
    vi.mocked(adapter.saveData).mockImplementation(async (key, data) => {
      const snapshot = structuredClone(data);
      const index = writes.push(snapshot) - 1;
      await gates[index].promise;
      saved.set(key, snapshot);
      return true;
    });

    const first = store.saveData();
    store.data.folders[0].name = 'Queued edit';
    const second = store.saveData();
    store.data.folders[0].name = 'Latest queued edit';
    const third = store.saveData();
    const secondSettled = vi.fn();
    const thirdSettled = vi.fn();
    void second.then(secondSettled);
    void third.then(thirdSettled);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondSettled).not.toHaveBeenCalled();
    expect(thirdSettled).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);

    gates[0].resolve();
    expect(await first).toBe(true);
    expect(writes).toHaveLength(2);
    expect(saved.get('gvFolderData')?.folders[0].name).toBe('Original');
    expect(secondSettled).not.toHaveBeenCalled();
    expect(thirdSettled).not.toHaveBeenCalled();

    store.data.folders[0].name = 'Edit during trailing save';
    const fourth = store.saveData();
    const fourthSettled = vi.fn();
    void fourth.then(fourthSettled);
    gates[1].resolve();
    expect(await second).toBe(true);
    expect(await third).toBe(true);
    expect(saved.get('gvFolderData')?.folders[0].name).toBe('Latest queued edit');
    expect(fourthSettled).not.toHaveBeenCalled();

    gates[2].resolve();
    expect(await fourth).toBe(true);
    expect(saved.get('gvFolderData')?.folders[0].name).toBe('Edit during trailing save');
    expect(writes.map((data) => data.folders[0].name)).toEqual([
      'Original',
      'Latest queued edit',
      'Edit during trailing save',
    ]);
  });

  it.each(['false', 'throw'] as const)(
    'settles a failed trailing save as false after storage returns %s',
    async (failure) => {
      const firstGate = deferred<void>();
      const failedGate = deferred<void>();
      vi.mocked(adapter.saveData)
        .mockImplementationOnce(async (key, data) => {
          const snapshot = structuredClone(data);
          await firstGate.promise;
          saved.set(key, snapshot);
          return true;
        })
        .mockImplementationOnce(async () => {
          await failedGate.promise;
          if (failure === 'throw') throw new Error('storage unavailable');
          return false;
        })
        .mockResolvedValueOnce(false);
      const first = store.saveData();
      store.data.folders[0].name = 'Unsaved edit';
      const queued = store.saveData();
      const settled = vi.fn();
      void queued.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      firstGate.resolve();
      expect(await first).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      failedGate.resolve();
      expect(await queued).toBe(false);
      expect(saved.get('gvFolderData')?.folders[0].name).toBe('Original');
      expect(adapter.saveData).toHaveBeenCalledTimes(failure === 'throw' ? 2 : 3);
    },
  );

  it('rejects creation and drag mutations through both account resolution and initial load', async () => {
    const resolution = deferred<AccountScope>();
    const loading = deferred<FolderData>();
    const loadStarted = deferred<void>();
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockReturnValueOnce(
      resolution.promise,
    );
    vi.mocked(adapter.loadData).mockImplementationOnce(() => {
      loadStarted.resolve();
      return loading.promise;
    });
    expect(store.canEdit).toBe(true);
    const switching = store.setAccountIsolationEnabled(true);
    expect(store.session).toBeNull();
    const conversation = sampleData().folderContents.root[0];
    const drag: DragData = { type: 'conversation', ...conversation };
    const assertReadOnly = async () => {
      const before = structuredClone(store.data);
      expect(store.canEdit).toBe(false);
      expect(store.createFolder('During account load')).toBeNull();
      store.ensureConversationsInFolder('root', drag);
      store.addConversationToFolder('root', drag);
      store.addConversationsToFolder('root', [conversation]);
      store.moveConversationToFolder('other', 'root', conversation);
      store.reorderOrMoveConversations([conversation.conversationId], 'other', 'root', 0);
      expect(await store.setFolderInstructions('root', 'Unsaved')).toBe(false);
      expect(await store.saveData()).toBe(false);
      expect(store.data).toEqual(before);
      expect(adapter.saveData).not.toHaveBeenCalled();
    };
    await assertReadOnly();
    resolution.resolve(accountScope('b'));
    await loadStarted.promise;
    expect(store.session).not.toBeNull();
    expect(store.session?.ready).toBe(false);
    await assertReadOnly();
    loading.resolve(sampleData('Account B'));
    await switching;
    expect(store.canEdit).toBe(true);
    expect(store.data.folders[0].name).toBe('Account B');
    expect(store.createFolder('After account load')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.get(store.storageKey)?.folders.map((folder) => folder.name)).toContain(
      'After account load',
    );
  });

  it('keeps a non-isolated account read-only until its initial empty load completes', async () => {
    store.destroy();
    const loading = deferred<FolderData | null>();
    const loadStarted = deferred<void>();
    vi.mocked(adapter.loadData).mockImplementationOnce(() => {
      loadStarted.resolve();
      return loading.promise;
    });
    store = new FolderStore(
      {
        getContext: () => ({ sidebar: null, sortMode: 'manual', enabled: true }),
        onChange,
        onArchive: vi.fn(),
        onRecovery: vi.fn(),
      },
      adapter,
    );
    expect(store.canEdit).toBe(false);
    const initialization = store.init();
    await loadStarted.promise;
    expect(store.accountIsolationEnabled).toBe(false);
    expect(store.canEdit).toBe(false);
    expect(store.createFolder('Before first load')).toBeNull();
    expect(await store.saveData()).toBe(false);
    expect(adapter.saveData).not.toHaveBeenCalled();
    loading.resolve(null);
    await initialization;
    expect(store.canEdit).toBe(true);
    expect(store.data).toEqual({ folders: [], folderContents: {} });
    expect(onChange).toHaveBeenCalledWith('loaded');
    expect(store.createFolder('After first load')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.get('gvFolderData')?.folders.map((folder) => folder.name)).toEqual([
      'After first load',
    ]);
  });

  it('rejects stale data commands after destroy without changing existing data', async () => {
    const before = structuredClone(store.data);
    const conversation: ConversationReference = before.folderContents.root[0];
    store.destroy();
    expect(store.canEdit).toBe(false);
    expect(store.createFolder('After destroy')).toBeNull();
    store.renameFolder('root', 'Changed');
    store.toggleFolder('root');
    store.togglePinFolder('root');
    store.changeFolderColor('root', 'red');
    store.reorderFolder('root', 'other', 0);
    store.addFolderToFolder('other', { type: 'folder', folderId: 'root', title: 'Original' });
    store.toggleConversationStar('root', conversation.conversationId);
    store.setConversationStarAcrossFolders(conversation.conversationId, true);
    store.removeConversationFromFolder('root', conversation.conversationId);
    store.removeConversationsFromFolder('root', new Set([conversation.conversationId]));
    store.removeFolder('root');
    expect(await store.setFolderInstructions('root', 'Unsaved')).toBe(false);
    expect(await store.saveData()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.data).toEqual(before);
    expect(adapter.saveData).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('finishes detached account writes in their own queue while the next account can save', async () => {
    const aScope = accountScope('a');
    const bScope = accountScope('b');
    const aKey = buildScopedFolderStorageKey(aScope.accountKey);
    const bKey = buildScopedFolderStorageKey(bScope.accountKey);
    saved.set(aKey, sampleData('Account A'));
    saved.set(bKey, sampleData('Account B'));
    vi.spyOn(accountIsolationService, 'resolveAccountScope')
      .mockResolvedValueOnce(aScope)
      .mockResolvedValueOnce(bScope);
    await store.setAccountIsolationEnabled(true);
    const gate = deferred<void>();
    vi.mocked(adapter.saveData).mockImplementationOnce(async (key, data) => {
      const snapshot = structuredClone(data);
      await gate.promise;
      saved.set(key, snapshot);
      return true;
    });
    const original = store.saveData();
    store.data.folders[0].name = 'Queued A';
    const queued = store.saveData();
    const queuedSettled = vi.fn();
    void queued.then(queuedSettled);
    await store.refreshAccountScope();
    await store.loadData();
    store.data.folders[0].name = 'Saved B';
    expect(await store.saveData()).toBe(true);
    expect(saved.get(bKey)?.folders[0].name).toBe('Saved B');
    expect(queuedSettled).not.toHaveBeenCalled();
    gate.resolve();
    expect(await original).toBe(true);
    expect(await queued).toBe(true);
    expect(saved.get(aKey)?.folders[0].name).toBe('Queued A');
    expect(saved.get(bKey)?.folders[0].name).toBe('Saved B');
    expect(store.data.folders[0].name).toBe('Saved B');
  });
});
