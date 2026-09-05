import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';
import { getTranslationSync } from '@/utils/i18n';

import { AIStudioFolderManager } from '../aistudio';
import type { FolderData } from '../types';

const { mockBrowser } = vi.hoisted(() => ({
  mockBrowser: {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
    },
  },
}));

vi.mock('webextension-polyfill', () => ({ default: mockBrowser }));

type Manager = {
  data: FolderData;
  accountScope: AccountScope | null;
  activeStorageKey: string;
  handleAccountIsolationToggle(enabled: boolean): Promise<void>;
  refreshScopedDataOnAccountContextChange(): Promise<void>;
  handleCloudSync(): Promise<void>;
  handleImport(): void;
  load(): Promise<void>;
  save(): Promise<boolean>;
  destroy(): void;
};

const storageKey = StorageKeys.FOLDER_DATA_AISTUDIO;
let local: Record<string, unknown>;
let sync: Record<string, unknown>;
const managers: Manager[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pick(values: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  if (typeof keys === 'string') return structuredClone({ [keys]: values[keys] });
  if (Array.isArray(keys)) {
    return structuredClone(Object.fromEntries(keys.map((key) => [key, values[key]])));
  }
  if (keys && typeof keys === 'object') {
    return structuredClone(
      Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, values[key] ?? fallback]),
      ),
    );
  }
  return structuredClone(values);
}

function folderData(name: string): FolderData {
  return {
    folders: [{ id: name, name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 }],
    folderContents: { [name]: [] },
  };
}

function selectAccount(account: string): void {
  const indicator = document.querySelector('.account-switcher-text')!;
  indicator.setAttribute('data-email', `${account}@example.com`);
  indicator.textContent = `${account}@example.com`;
}

async function accountKey(account: string): Promise<string> {
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: `${account}@example.com`,
  });
  return buildScopedStorageKey(storageKey, scope.accountKey);
}

async function mountManager(): Promise<Manager> {
  local[storageKey] = folderData('Global original');
  local[await accountKey('a')] = folderData('Private a');
  local[await accountKey('b')] = folderData('Private b');
  const instance = new AIStudioFolderManager();
  const manager = instance as unknown as Manager;
  managers.push(manager);
  await instance.init();
  expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private a');
  return manager;
}

function attemptCreateAndDrop(): void {
  document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click();
  const input = document.querySelector<HTMLInputElement>('.gv-folder-name-input');
  if (input) {
    input.value = 'Created during load';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: {
      getData: () =>
        JSON.stringify({
          type: 'conversation',
          conversationId: 'dropped-during-load',
          title: 'Dropped during load',
          url: '/prompts/dropped-during-load',
        }),
    },
  });
  document.querySelector('.gv-folder-root-drop')!.dispatchEvent(drop);
}

function holdFolderWrites(key: string) {
  const first = deferred<void>();
  const tail = deferred<boolean>();
  const firstStarted = deferred<void>();
  const tailStarted = deferred<void>();
  const snapshots: FolderData[] = [];
  mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
    const snapshot = structuredClone(values);
    if (snapshot[key]) {
      snapshots.push(snapshot[key] as FolderData);
      if (snapshots.length === 1) {
        firstStarted.resolve();
        await first.promise;
      } else {
        tailStarted.resolve();
        if (!(await tail.promise)) throw new Error('Storage quota exceeded');
      }
    }
    Object.assign(local, snapshot);
  });
  return { first, tail, firstStarted, tailStarted, snapshots };
}

function notificationText(): string {
  return Array.from(document.querySelectorAll('.gv-notification'), (node) => node.textContent).join(
    '\n',
  );
}

function backupData(manager: Manager, slot: 'primary' | 'emergency' | 'beforeUnload'): FolderData {
  const namespace = buildScopedStorageKey('aistudio-folders', manager.accountScope!.accountKey);
  return JSON.parse(localStorage.getItem(`gvBackup_${namespace}_${slot}`)!).data as FolderData;
}

function createFolder(name: string): void {
  document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click();
  const input = document.querySelector<HTMLInputElement>('.gv-folder-name-input')!;
  expect(input).not.toBeNull();
  input.value = name;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function chooseImport(manager: Manager, data: FolderData): void {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  manager.handleImport();
  const input = click.mock.contexts.at(-1) as HTMLInputElement;
  expect(input).toBeInstanceOf(HTMLInputElement);
  Object.defineProperty(input, 'files', {
    value: [{ text: async () => JSON.stringify({ data }) }],
  });
  input.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = `
    <span class="account-switcher-text" data-email="a@example.com">a@example.com</span>
    <div class="nav-content v3-left-nav"><nav><div class="empty-space"></div></nav></div>`;
  (
    globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }
  ).jsdom.reconfigure({ url: 'https://aistudio.google.com/' });
  local = {};
  sync = {
    [StorageKeys.LANGUAGE]: 'en',
    [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: true,
    geminiFolderEnabled: true,
  };
  mockBrowser.storage.local.get.mockImplementation(async (keys: unknown) => pick(local, keys));
  mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(local, structuredClone(values));
  });
  mockBrowser.storage.sync.get.mockImplementation(async (keys: unknown) => pick(sync, keys));
  mockBrowser.storage.sync.set.mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(sync, structuredClone(values));
  });
  chrome.storage.local.get = mockBrowser.storage.local.get as typeof chrome.storage.local.get;
  chrome.storage.local.set = mockBrowser.storage.local.set as typeof chrome.storage.local.set;
  chrome.storage.sync.get = mockBrowser.storage.sync.get as typeof chrome.storage.sync.get;
  chrome.storage.sync.set = mockBrowser.storage.sync.set as typeof chrome.storage.sync.set;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

describe('AI Studio folder persistence', () => {
  it.each(['global', 'scoped'] as const)(
    'rejects editing while the new %s data is loading',
    async (kind) => {
      const manager = await mountManager();
      const key = kind === 'global' ? storageKey : await accountKey('b');
      const original = structuredClone(local[key]);
      const loaded = deferred<Record<string, unknown>>();
      const started = deferred<void>();
      mockBrowser.storage.local.get.mockImplementation(async (keys: unknown) => {
        if (keys === key) {
          started.resolve();
          return loaded.promise;
        }
        return pick(local, keys);
      });
      selectAccount('b');
      const switching =
        kind === 'global'
          ? manager.handleAccountIsolationToggle(false)
          : manager.refreshScopedDataOnAccountContextChange();
      await started.promise;
      try {
        expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(
          true,
        );
        expect(document.querySelector('.gv-folder-container')?.getAttribute('aria-busy')).toBe(
          'true',
        );
        attemptCreateAndDrop();
        await vi.advanceTimersByTimeAsync(0);
        expect(local[key]).toEqual(original);
        expect(manager.data).toEqual({ folders: [], folderContents: {} });
      } finally {
        loaded.resolve({ [key]: original });
        await switching;
      }
      expect(manager.data).toEqual(original);
      expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(false);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain(
        kind === 'global' ? 'Global original' : 'Private b',
      );
    },
  );

  it.each([true, false])(
    'settles coalesced saves only with their trailing result: %s',
    async (saved) => {
      const manager = await mountManager();
      const writes = holdFolderWrites(manager.activeStorageKey);
      manager.data.folders[0].name = 'First';
      const first = manager.save();
      await writes.firstStarted.promise;
      manager.data.folders[0].name = 'Superseded';
      const queued = manager.save();
      manager.data.folders[0].name = 'Latest';
      const latest = manager.save();
      const outcomes: boolean[] = [];
      void queued.then((result) => outcomes.push(result));
      void latest.then((result) => outcomes.push(result));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcomes).toEqual([]);
        writes.first.resolve();
        await writes.tailStarted.promise;
        expect(outcomes).toEqual([]);
        writes.tail.resolve(saved);
        expect(await first).toBe(true);
        expect(await queued).toBe(saved);
        expect(await latest).toBe(saved);
        expect(writes.snapshots.map((snapshot) => snapshot.folders[0].name)).toEqual([
          'First',
          'Latest',
        ]);
        expect((local[manager.activeStorageKey] as FolderData).folders[0].name).toBe(
          saved ? 'Latest' : 'First',
        );
      } finally {
        writes.first.resolve();
        writes.tail.resolve(saved);
        await Promise.all([first, queued, latest]);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it('does not create a default library folder while global storage is loading', async () => {
    window.history.replaceState({}, '', '/library');
    const manager = await mountManager();
    const original = structuredClone(local[storageKey]);
    const loaded = deferred<Record<string, unknown>>();
    const started = deferred<void>();
    mockBrowser.storage.local.get.mockImplementation(async (keys: unknown) => {
      if (keys === storageKey) {
        started.resolve();
        return loaded.promise;
      }
      return pick(local, keys);
    });
    const switching = manager.handleAccountIsolationToggle(false);
    await started.promise;
    try {
      // A provider row can appear before Voyager's observer attaches its row handlers.
      const table = document.createElement('table');
      table.innerHTML =
        '<tr class="mat-mdc-row"><td><a href="/prompts/new-row">New row</a></td></tr>';
      document.body.appendChild(table);
      table.querySelector('tr')!.dispatchEvent(new Event('dragstart', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.data).toEqual({ folders: [], folderContents: {} });
      expect(local[storageKey]).toEqual(original);
      expect(document.querySelector('.gv-library-folder-item')).toBeNull();
    } finally {
      loaded.resolve({ [storageKey]: original });
      await switching;
    }
    expect(manager.data).toEqual(original);
  });

  it('does not report a superseded write failure when its trailing snapshot succeeds', async () => {
    const manager = await mountManager();
    const firstResult = deferred<void>();
    const tailResult = deferred<void>();
    let writes = 0;
    mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      const snapshot = structuredClone(values);
      if (snapshot[manager.activeStorageKey]) {
        if (++writes === 1) {
          await firstResult.promise;
          throw new Error('Temporary storage failure');
        }
        await tailResult.promise;
      }
      Object.assign(local, snapshot);
    });

    const first = manager.save();
    manager.data.folders[0].name = 'Latest ordinary edit';
    const queued = manager.save();
    try {
      firstResult.resolve();
      expect(await first).toBe(false);
      expect(document.querySelector('.gv-notification-error')).toBeNull();
      tailResult.resolve();
      expect(await queued).toBe(true);
      expect((local[manager.activeStorageKey] as FolderData).folders[0].name).toBe(
        'Latest ordinary edit',
      );
      expect(document.querySelector('.gv-notification-error')).toBeNull();
    } finally {
      firstResult.resolve();
      tailResult.resolve();
      await Promise.all([first, queued]);
    }
  });

  it.each([true, false])(
    'continues cloud sync only after its queued folder save succeeds: %s',
    async (saved) => {
      const manager = await mountManager();
      const prompt: PromptItem = {
        id: 'remote',
        text: 'Remote prompt',
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      };
      local.gvPromptItems = [];
      mockBrowser.runtime.sendMessage.mockResolvedValue({
        ok: true,
        data: { folders: { data: folderData('Cloud') }, prompts: { items: [prompt] } },
      });
      const writes = holdFolderWrites(manager.activeStorageKey);
      const first = manager.save();
      await writes.firstStarted.promise;
      const syncing = manager.handleCloudSync();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(local.gvPromptItems).toEqual([]);
        expect(notificationText()).not.toContain(getTranslationSync('downloadMergeSuccess'));
        writes.first.resolve();
        await writes.tailStarted.promise;
        expect(manager.data).toEqual(folderData('Private a'));
        expect(document.querySelector('.gv-folder-list')?.textContent).not.toContain('Cloud');
        expect(local.gvPromptItems).toEqual([]);
        writes.tail.resolve(saved);
        await syncing;
        expect(local.gvPromptItems).toEqual(saved ? [prompt] : []);
        if (saved) {
          expect(notificationText()).toContain(getTranslationSync('downloadMergeSuccess'));
          expect(
            (local[manager.activeStorageKey] as FolderData).folders.map((folder) => folder.name),
          ).toEqual(['Private a', 'Cloud']);
        } else {
          expect(notificationText()).not.toContain(getTranslationSync('downloadMergeSuccess'));
          expect(document.querySelector('.gv-notification-error')).not.toBeNull();
          expect(
            (local[manager.activeStorageKey] as FolderData).folders.map((folder) => folder.name),
          ).toEqual(['Private a']);
          expect(manager.data).toEqual(folderData('Private a'));
        }
      } finally {
        writes.first.resolve();
        writes.tail.resolve(saved);
        await Promise.all([first, syncing]);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each(['import', 'cloud'] as const)(
    'keeps a failed %s draft out of live data, recovery and the next ordinary save',
    async (kind) => {
      const manager = await mountManager();
      const original = structuredClone(manager.data);
      await manager.save();
      local.gvPromptItems = [];
      mockBrowser.storage.local.set.mockRejectedValue(new Error('Storage quota exceeded'));
      mockBrowser.runtime.sendMessage.mockResolvedValue({
        ok: true,
        data: { folders: { data: folderData('Failed draft') }, prompts: { items: [] } },
      });
      if (kind === 'import') chooseImport(manager, folderData('Failed draft'));
      else await manager.handleCloudSync();
      await vi.waitFor(() =>
        expect(document.querySelector('.gv-notification-error')).not.toBeNull(),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(window.alert).not.toHaveBeenCalled();
      expect(notificationText()).not.toContain(getTranslationSync('downloadMergeSuccess'));
      expect(local[manager.activeStorageKey]).toEqual(original);
      expect.soft(manager.data).toEqual(original);
      window.dispatchEvent(new Event('beforeunload'));
      for (const slot of ['primary', 'emergency', 'beforeUnload'] as const) {
        expect.soft(backupData(manager, slot)).toEqual(original);
      }

      mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
        Object.assign(local, structuredClone(values));
      });
      createFolder('After failed draft');
      await vi.waitFor(() => {
        expect(
          (local[manager.activeStorageKey] as FolderData).folders.some(
            (folder) => folder.name === 'After failed draft',
          ),
        ).toBe(true);
      });
      expect
        .soft((local[manager.activeStorageKey] as FolderData).folders.map((folder) => folder.name))
        .toEqual(['Private a', 'After failed draft']);
      window.dispatchEvent(new Event('beforeunload'));
      expect
        .soft(manager.data.folders.map((folder) => folder.name))
        .toEqual(['Private a', 'After failed draft']);
      for (const slot of ['primary', 'emergency', 'beforeUnload'] as const) {
        expect
          .soft(backupData(manager, slot).folders.map((folder) => folder.name))
          .toEqual(['Private a', 'After failed draft']);
      }
    },
  );

  it('does not announce cloud sync success when writing merged prompts fails', async () => {
    const manager = await mountManager();
    const original = structuredClone(manager.data);
    local.gvPromptItems = [];
    mockBrowser.runtime.sendMessage.mockResolvedValue({
      ok: true,
      data: { folders: { data: folderData('Cloud') }, prompts: { items: [] } },
    });
    mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      if ('gvPromptItems' in values) throw new Error('Storage quota exceeded');
      Object.assign(local, structuredClone(values));
    });

    await manager.handleCloudSync();

    expect(notificationText()).not.toContain(getTranslationSync('downloadMergeSuccess'));
    expect(document.querySelector('.gv-notification-error')).not.toBeNull();
    expect(manager.data).toEqual(original);
    expect(local[manager.activeStorageKey]).toEqual(original);
    expect(local.gvPromptItems).toEqual([]);
  });

  it('finishes accepted ordinary writes but abandons an unissued import after A → B → A', async () => {
    const manager = await mountManager();
    const key = manager.activeStorageKey;
    const writes = holdFolderWrites(key);
    manager.data.folders[0].name = 'First ordinary edit';
    const first = manager.save();
    await writes.firstStarted.promise;
    manager.data.folders[0].name = 'Latest ordinary edit';
    const queued = manager.save();
    chooseImport(manager, folderData('Abandoned import'));
    await vi.advanceTimersByTimeAsync(0);
    selectAccount('b');
    await manager.refreshScopedDataOnAccountContextChange();
    expect(manager.data).toEqual(folderData('Private b'));
    selectAccount('a');
    await manager.refreshScopedDataOnAccountContextChange();
    writes.first.resolve();
    await writes.tailStarted.promise;
    writes.tail.resolve(true);
    await Promise.all([first, queued]);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      writes.snapshots.map((snapshot) => snapshot.folders.map((folder) => folder.name)),
    ).toEqual([['First ordinary edit'], ['Latest ordinary edit']]);
    expect(manager.data.folders.map((folder) => folder.name)).toEqual(['Latest ordinary edit']);
    expect(local[key]).toEqual(manager.data);
    expect(window.alert).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-folder-list')?.textContent).not.toContain(
      'Abandoned import',
    );
    expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(false);
  });

  it('publishes an issued cloud draft in its original account when returning through A → B → A', async () => {
    const manager = await mountManager();
    const original = structuredClone(manager.data);
    const key = manager.activeStorageKey;
    const writes = holdFolderWrites(key);
    const prompt: PromptItem = {
      id: 'remote',
      text: 'Remote prompt',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    local.gvPromptItems = [];
    mockBrowser.runtime.sendMessage.mockResolvedValue({
      ok: true,
      data: { folders: { data: folderData('Cloud') }, prompts: { items: [prompt] } },
    });
    const syncing = manager.handleCloudSync();
    await writes.firstStarted.promise;
    try {
      expect(manager.data).toEqual(original);
      selectAccount('b');
      await manager.refreshScopedDataOnAccountContextChange();
      expect(manager.data).toEqual(folderData('Private b'));
      expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(false);
      selectAccount('a');
      await manager.refreshScopedDataOnAccountContextChange();
      expect(manager.data).toEqual(original);
      expect(document.querySelector('.gv-folder-list')?.textContent).not.toContain('Cloud');
      expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(true);
      writes.first.resolve();
      await syncing;
      expect(manager.data.folders.map((folder) => folder.name)).toEqual(['Private a', 'Cloud']);
      expect(local[key]).toEqual(manager.data);
      expect(local.gvPromptItems).toEqual([prompt]);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Cloud');
      expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(false);
      expect(notificationText()).not.toContain(getTranslationSync('downloadMergeSuccess'));
    } finally {
      writes.first.resolve();
      await syncing;
    }
  });

  it('does not announce an old account import after its issued write completes', async () => {
    const manager = await mountManager();
    const aKey = manager.activeStorageKey;
    const bKey = await accountKey('b');
    const writes = holdFolderWrites(aKey);
    chooseImport(manager, folderData('Imported into a'));
    await writes.firstStarted.promise;
    selectAccount('b');
    await manager.refreshScopedDataOnAccountContextChange();
    writes.first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.alert).not.toHaveBeenCalled();
    expect(manager.data).toEqual(folderData('Private b'));
    expect(local[bKey]).toEqual(folderData('Private b'));
    expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private b');
    expect((local[aKey] as FolderData).folders.map((folder) => folder.name)).toEqual([
      'Private a',
      'Imported into a',
    ]);
  });

  it('finishes a pending legacy migration before importing after A → B → A', async () => {
    const manager = await mountManager();
    const key = manager.activeStorageKey;
    const legacy = folderData('Legacy');
    delete local[key];
    local[storageKey] = legacy;
    const writes = holdFolderWrites(key);
    const migration = manager.load();
    await writes.firstStarted.promise;
    try {
      selectAccount('b');
      await manager.refreshScopedDataOnAccountContextChange();
      selectAccount('a');
      await manager.refreshScopedDataOnAccountContextChange();
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Legacy');

      chooseImport(manager, folderData('Imported after migration'));
      // An incorrectly concurrent import can finish before the slow migration.
      writes.tail.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(writes.snapshots).toHaveLength(1);
      expect.soft(window.alert).not.toHaveBeenCalled();
      writes.first.resolve();
      await migration;
      await vi.advanceTimersByTimeAsync(0);

      expect((local[key] as FolderData).folders.map((folder) => folder.name)).toEqual([
        'Legacy',
        'Imported after migration',
      ]);
      expect(local[key]).toEqual(manager.data);
      expect(backupData(manager, 'primary')).toEqual(manager.data);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain(
        'Imported after migration',
      );
      expect(local[storageKey]).toEqual(legacy);
    } finally {
      writes.first.resolve();
      writes.tail.resolve(true);
      await migration;
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
