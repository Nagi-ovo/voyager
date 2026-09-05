import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';
import { StorageKeys } from '@/core/types/common';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';

import type { FolderSidebarRuntime } from '../FolderSidebarRuntime';
import type { FolderStore } from '../FolderStore';
import type { FolderTransferController } from '../FolderTransferController';
import type { FolderTreeView } from '../FolderTreeView';
import { AIStudioFolderManager } from '../aistudio';
import { type FloatingPanelHandle, mountFloatingPanel } from '../floatingPanel';
import { FolderManager } from '../manager';
import * as storageAdapters from '../storage/FolderStorageAdapter';
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
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
  createTranslator: () => (key: string) => key,
}));

type Platform = 'gemini' | 'aistudio';
type Internals = {
  data: FolderData;
  container: HTMLElement | null;
  floatingPanelHandle: FloatingPanelHandle | null;
  accountScope: AccountScope | null;
  activeStorageKey: string;
  initializeFolderUI(): Promise<void>;
  refreshAccountScope(force?: boolean): Promise<unknown>;
  load(): Promise<void>;
  save(): Promise<void>;
  handleCloudSync(): Promise<void>;
  transfer: FolderTransferController;
  store: FolderStore;
  sidebarRuntime: FolderSidebarRuntime;
  treeView: FolderTreeView;
  refreshScopedDataOnAccountContextChange(): Promise<void>;
  destroy(): void;
};
type Harness = {
  manager: Internals;
  store: FolderStore | null;
  adapter: storageAdapters.IFolderStorageAdapter | null;
  data: FolderData;
  readonly storageKey: string;
  readonly accountScope: AccountScope | null;
  load(): Promise<void>;
  save(): Promise<unknown>;
  sync(): Promise<void>;
  switchTo(account: 'a' | 'b'): Promise<void>;
};

type StorageListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  area: string,
) => void;
const storageListeners = new Set<StorageListener>();
function emitStorageChange(changes: Parameters<StorageListener>[0], area: string): void {
  for (const listener of storageListeners) listener(changes, area);
}

let extensionLocal: Record<string, unknown>;
let extensionSync: Record<string, unknown>;
const cleanup: Array<() => void> = [];
const emptyData = (): FolderData => ({ folders: [], folderContents: {} });
const baseKey = (platform: Platform) =>
  platform === 'gemini' ? StorageKeys.FOLDER_DATA : StorageKeys.FOLDER_DATA_AISTUDIO;

function selectAccount(platform: Platform, account: 'a' | 'b'): void {
  const host = platform === 'gemini' ? 'gemini.google.com' : 'aistudio.google.com';
  const route = platform === 'gemini' ? `/u/${account === 'a' ? 1 : 2}/app` : '/';
  const jsdom = (
    globalThis as unknown as {
      jsdom: { reconfigure(options: { url: string }): void };
    }
  ).jsdom;
  jsdom.reconfigure({ url: `https://${host}${route}` });
  let accountIndicator = document.querySelector('.account-switcher-text');
  if (!accountIndicator) {
    accountIndicator = document.createElement('span');
    accountIndicator.className = 'account-switcher-text';
    document.body.appendChild(accountIndicator);
  }
  accountIndicator.setAttribute('data-email', `${account}@example.com`);
  accountIndicator.textContent = `${account}@example.com`;
}

function pick(store: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  if (typeof keys === 'string') return structuredClone({ [keys]: store[keys] });
  if (Array.isArray(keys)) {
    return structuredClone(Object.fromEntries(keys.map((key) => [key, store[key]])));
  }
  if (keys && typeof keys === 'object') {
    return structuredClone(
      Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback]),
      ),
    );
  }
  return structuredClone(store);
}

function privateData(account: 'a' | 'b'): FolderData {
  return {
    folders: [
      {
        id: account,
        name: `Private ${account}`,
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
        sortIndex: 0,
      },
    ],
    folderContents: { [account]: [] },
  };
}

async function accountKeys(platform: Platform, account: 'a' | 'b') {
  selectAccount(platform, account);
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: `${account}@example.com`,
    routeUserId: platform === 'gemini' ? (account === 'a' ? '1' : '2') : null,
  });
  return {
    live: buildScopedStorageKey(baseKey(platform), scope.accountKey),
    backup: buildScopedStorageKey(`${platform}-folders`, scope.accountKey),
  };
}

function backupData(namespace: string, slot = 'primary'): FolderData | undefined {
  const serialized = localStorage.getItem(`gvBackup_${namespace}_${slot}`);
  return serialized ? JSON.parse(serialized).data : undefined;
}

async function makeHarness(platform: Platform, account: 'a' | 'b'): Promise<Harness> {
  selectAccount(platform, account);
  // Gemini still runs its real init/load lifecycle, with UI disabled. AI Studio's
  // UI initializer calls its real load, avoiding waits for the native sidebar.
  extensionSync.geminiFolderEnabled = platform === 'aistudio';
  const adapter = platform === 'gemini' ? storageAdapters.createFolderStorageAdapter() : null;
  if (adapter) vi.spyOn(storageAdapters, 'createFolderStorageAdapter').mockReturnValueOnce(adapter);
  const instance = platform === 'gemini' ? new FolderManager() : new AIStudioFolderManager();
  const manager = instance as unknown as Internals;
  cleanup.push(() => manager.destroy());
  if (platform === 'aistudio') {
    vi.spyOn(manager, 'initializeFolderUI').mockImplementation(() => manager.load());
  }
  await instance.init();
  const store = platform === 'gemini' ? manager.store : null;
  return {
    manager,
    store,
    adapter,
    get data() {
      return store ? store.data : manager.data;
    },
    set data(data: FolderData) {
      if (store) store.data = data;
      else manager.data = data;
    },
    get storageKey() {
      return store ? store.storageKey : manager.activeStorageKey;
    },
    get accountScope() {
      return store ? store.accountScope : manager.accountScope;
    },
    load: () => (store ? store.loadData() : manager.load()),
    save: () => (store ? store.saveData() : manager.save()),
    sync: () => (platform === 'gemini' ? manager.transfer.sync() : manager.handleCloudSync()),
    switchTo: async (next) => {
      selectAccount(platform, next);
      if (store) await store.refreshAccountScope();
      else await manager.refreshAccountScope(true);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mountGeminiPanel(harness: Harness): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.id = 'app-root';
  root.className = 'side-nav-open';
  root.innerHTML =
    '<div data-test-id="overflow-container"><expandable-section data-test-id="chats-expandable-section"></expandable-section></div>';
  document.body.appendChild(root);
  await harness.manager.sidebarRuntime.start('sidebar');
  return harness.manager.sidebarRuntime.panel!;
}

function pauseFirstWrite(harness: Harness, platform: Platform, storageKey: string) {
  const pending = deferred<void>();
  const started = deferred<void>();
  let first = true;
  const write = async (key: string, data: FolderData) => {
    const snapshot = structuredClone(data);
    if (key === storageKey && first) {
      first = false;
      started.resolve();
      await pending.promise;
    }
    extensionLocal[key] = snapshot;
    return true;
  };
  if (platform === 'gemini') vi.spyOn(harness.adapter!, 'saveData').mockImplementation(write);
  else
    mockBrowser.storage.local.set.mockImplementation(async (values) => {
      const [key, data] = Object.entries(values)[0];
      await write(key, data as FolderData);
    });
  return { started: started.promise, release: () => pending.resolve() };
}

beforeEach(() => {
  vi.useFakeTimers();
  storageListeners.clear();
  mockBrowser.storage.onChanged.addListener.mockImplementation((listener: StorageListener) =>
    storageListeners.add(listener),
  );
  mockBrowser.storage.onChanged.removeListener.mockImplementation((listener: StorageListener) =>
    storageListeners.delete(listener),
  );
  localStorage.clear();
  document.body.innerHTML = '';
  extensionLocal = {};
  extensionSync = { [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: true };
  const localGet = vi.fn(async (keys: unknown) => pick(extensionLocal, keys));
  const localSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(extensionLocal, structuredClone(values));
  });
  const syncGet = vi.fn(async (keys: unknown) => pick(extensionSync, keys));
  const syncSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(extensionSync, structuredClone(values));
  });
  chrome.storage.local.get = localGet as typeof chrome.storage.local.get;
  chrome.storage.local.set = localSet as typeof chrome.storage.local.set;
  chrome.storage.sync.get = syncGet as typeof chrome.storage.sync.get;
  chrome.storage.sync.set = syncSet as typeof chrome.storage.sync.set;
  mockBrowser.storage.local.get = localGet;
  mockBrowser.storage.local.set = localSet;
  mockBrowser.storage.sync.get = syncGet;
  mockBrowser.storage.sync.set = syncSet;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const action of cleanup.splice(0)) action();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each<Platform>(['gemini', 'aistudio'])('%s backup account ownership', (platform) => {
  it('keeps scoped primary backups separate and rejects another account after corrupt storage', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    const a = await makeHarness(platform, 'a');
    expect(a.data.folders[0]?.name).toBe('Private a');
    extensionLocal[bKeys.live] = { folders: 'corrupted', folderContents: {} };
    const b = await makeHarness(platform, 'b');
    expect(b.data).toEqual(emptyData());
    expect(extensionLocal[bKeys.live]).not.toEqual(privateData('a'));
    expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Private a');
    expect(backupData(`${platform}-folders`)).toBeUndefined();
  });

  it('leaves a new account empty when the other account has a backup', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    await makeHarness(platform, 'a');
    const b = await makeHarness(platform, 'b');
    expect(b.data).toEqual(emptyData());
    expect(extensionLocal[bKeys.live]).toBeUndefined();
  });

  it('keeps a valid empty account empty', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = emptyData();
    await makeHarness(platform, 'a');
    const b = await makeHarness(platform, 'b');
    expect(b.data).toEqual(emptyData());
  });

  it('recovers a corrupt live value from the same stable account backup', async () => {
    const keys = await accountKeys(platform, 'a');
    extensionLocal[keys.live] = privateData('a');
    const first = await makeHarness(platform, 'a');
    first.manager.destroy();
    extensionLocal[keys.live] = { folders: 'corrupted', folderContents: {} };
    const recovered = await makeHarness(platform, 'a');
    expect(recovered.data.folders[0]?.name).toBe('Private a');
    expect((extensionLocal[keys.live] as FolderData).folders[0]?.name).toBe('Private a');
  });

  it('does not claim or delete an old ownerless platform backup when isolation is enabled', async () => {
    const keys = await accountKeys(platform, 'b');
    const namespace = `${platform}-folders`;
    new DataBackupService<FolderData>(namespace).createPrimaryBackup(privateData('a'));
    extensionLocal[keys.live] = { folders: 'corrupted', folderContents: {} };
    const b = await makeHarness(platform, 'b');
    expect(b.data).toEqual(emptyData());
    expect(backupData(namespace)).toEqual(privateData('a'));
  });

  it('still recovers the existing platform backup with isolation disabled', async () => {
    extensionSync[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] = false;
    new DataBackupService<FolderData>(`${platform}-folders`).createPrimaryBackup(privateData('a'));
    extensionLocal[baseKey(platform)] = { folders: 'corrupted', folderContents: {} };
    const harness = await makeHarness(platform, 'a');
    expect(harness.data.folders[0]?.name).toBe('Private a');
    expect(harness.storageKey).toBe(baseKey(platform));
    expect(backupData(`${platform}-folders`)?.folders[0]?.name).toBe('Private a');
  });

  it('drops old in-memory recovery data when the same instance switches accounts', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    const harness = await makeHarness(platform, 'a');
    localStorage.clear();
    await harness.switchTo('b');
    extensionLocal[bKeys.live] = { folders: 'corrupted', folderContents: {} };
    await harness.load();
    expect(harness.data).toEqual(emptyData());
    await harness.save();
    expect((extensionLocal[bKeys.live] as FolderData).folders).not.toEqual(
      privateData('a').folders,
    );
  });

  it('does not back up initial or old data while a new account is still loading', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    const harness = await makeHarness(platform, 'a');
    window.dispatchEvent(new Event('beforeunload'));
    expect(backupData(aKeys.backup, 'beforeUnload')?.folders[0]?.name).toBe('Private a');
    await harness.switchTo('b');
    window.dispatchEvent(new Event('beforeunload'));
    expect(backupData(bKeys.backup, 'beforeUnload')).toBeUndefined();
    expect(backupData(aKeys.backup, 'beforeUnload')?.folders[0]?.name).toBe('Private a');
    extensionLocal[bKeys.live] = privateData('b');
    await harness.load();
    window.dispatchEvent(new Event('beforeunload'));
    expect(backupData(bKeys.backup, 'beforeUnload')?.folders[0]?.name).toBe('Private b');
    expect(backupData(aKeys.backup, 'beforeUnload')?.folders[0]?.name).toBe('Private a');
  });

  it('discards an old account load that completes after the new account load', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<void>();
    mockBrowser.storage.local.get.mockImplementationOnce((key) => {
      expect(key).toBe(aKeys.live);
      started.resolve();
      return pending.promise;
    });
    const oldLoad = harness.load();
    await started.promise;
    await harness.switchTo('b');
    await harness.load();
    pending.resolve({ [aKeys.live]: privateData('a') });
    await oldLoad;
    expect(harness.data.folders[0]?.name).toBe('Private b');
    expect(backupData(bKeys.backup)?.folders[0]?.name).toBe('Private b');
  });

  it('keeps a delayed save completion and its snapshot owned by the original account', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const pending = deferred<void>();
    const started = deferred<void>();
    const write = async (key: string, data: FolderData) => {
      if (key === aKeys.live) {
        started.resolve();
        await pending.promise;
      }
      Object.assign(extensionLocal, structuredClone({ [key]: data }));
      return true;
    };
    if (platform === 'gemini') vi.spyOn(harness.adapter!, 'saveData').mockImplementation(write);
    else
      mockBrowser.storage.local.set.mockImplementation(async (values) => {
        const [key, data] = Object.entries(values)[0];
        await write(key, data as FolderData);
      });
    const oldSave = harness.save();
    await started.promise;
    harness.data.folders[0].name = 'Later edit in a';
    await harness.switchTo('b');
    await harness.load();
    await harness.save();
    pending.resolve();
    await oldSave;
    expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe('Private a');
    expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Private a');
    expect((extensionLocal[bKeys.live] as FolderData).folders[0]?.name).toBe('Private b');
    expect(backupData(bKeys.backup)?.folders[0]?.name).toBe('Private b');
  });

  it('fails closed when resolving the next account throws', async () => {
    const aKeys = await accountKeys(platform, 'a');
    extensionLocal[aKeys.live] = privateData('a');
    const harness = await makeHarness(platform, 'a');
    new DataBackupService<FolderData>(`${platform}-folders`).createPrimaryBackup(privateData('a'));
    const globalBackup = localStorage.getItem(`gvBackup_${platform}-folders_primary`);
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockRejectedValueOnce(
      new Error('offline'),
    );
    await harness.switchTo('b');
    await harness.load();
    await harness.save();
    window.dispatchEvent(new Event('beforeunload'));
    expect(harness.data).toEqual(emptyData());
    expect(extensionLocal[baseKey(platform)]).toBeUndefined();
    expect(localStorage.getItem(`gvBackup_${platform}-folders_primary`)).toBe(globalBackup);
  });

  it('keeps the latest queued edit in its original account after switching away', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const pending = deferred<void>();
    const started = deferred<void>();
    let first = true;
    const write = async (key: string, data: FolderData) => {
      if (key === aKeys.live && first) {
        first = false;
        started.resolve();
        await pending.promise;
      }
      extensionLocal[key] = structuredClone(data);
      return true;
    };
    if (platform === 'gemini') vi.spyOn(harness.adapter!, 'saveData').mockImplementation(write);
    else
      mockBrowser.storage.local.set.mockImplementation(async (values) => {
        const [key, data] = Object.entries(values)[0];
        await write(key, data as FolderData);
      });
    const oldSave = harness.save();
    await started.promise;
    harness.data.folders[0].name = 'Queued a';
    const queuedSave = harness.save();
    await harness.switchTo('b');
    await harness.load();
    harness.data.folders[0].name = 'Edited b';
    await harness.save();
    pending.resolve();
    await oldSave;
    await queuedSave;
    await Promise.resolve();
    expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe('Queued a');
    expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Queued a');
    expect((extensionLocal[bKeys.live] as FolderData).folders[0]?.name).toBe('Edited b');
  });

  it('discards a delayed legacy migration after its account has been released', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    delete extensionLocal[aKeys.live];
    localStorage.removeItem(aKeys.live);
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<void>();
    mockBrowser.storage.local.get.mockImplementation(async (key: unknown) => {
      if (key === baseKey(platform)) {
        started.resolve();
        return pending.promise;
      }
      return pick(extensionLocal, key);
    });
    const oldLoad = harness.load();
    await started.promise;
    await harness.switchTo('b');
    await harness.load();
    pending.resolve({ [baseKey(platform)]: privateData('a') });
    await oldLoad;
    expect(harness.data.folders[0]?.name).toBe('Private b');
    expect((extensionLocal[bKeys.live] as FolderData).folders[0]?.name).toBe('Private b');
    expect(extensionLocal[aKeys.live]).toBeUndefined();
  });

  it('serializes writes when returning to an account whose old save is still pending', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const pending = deferred<void>();
    const started = deferred<void>();
    let first = true;
    const write = async (key: string, data: FolderData) => {
      const snapshot = structuredClone(data);
      if (key === aKeys.live && first) {
        first = false;
        started.resolve();
        await pending.promise;
      }
      extensionLocal[key] = snapshot;
      return true;
    };
    if (platform === 'gemini') vi.spyOn(harness.adapter!, 'saveData').mockImplementation(write);
    else
      mockBrowser.storage.local.set.mockImplementation(async (values) => {
        const [key, data] = Object.entries(values)[0];
        await write(key, data as FolderData);
      });
    const originalSave = harness.save();
    await started.promise;
    harness.data.folders[0].name = 'Older queued a';
    const olderSave = harness.save();
    await harness.switchTo('b');
    await harness.load();
    harness.data.folders[0].name = 'B can still save';
    await harness.save();
    expect((extensionLocal[bKeys.live] as FolderData).folders[0]?.name).toBe('B can still save');
    await harness.switchTo('a');
    await harness.load();
    const nameOnReturn = harness.data.folders[0]?.name;
    harness.data.folders[0].name = 'Newest a after returning';
    const newestSave = harness.save();
    pending.resolve();
    await originalSave;
    await olderSave;
    await newestSave;
    await Promise.resolve();
    expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe(
      'Newest a after returning',
    );
    expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Newest a after returning');
    expect(harness.data.folders[0]?.name).toBe('Newest a after returning');
    expect(nameOnReturn).toBe('Older queued a');
  });

  it('does not revive a cloud download after leaving and returning to its account', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const writes = pauseFirstWrite(harness, platform, aKeys.live);
    const originalSave = harness.save();
    await writes.started;
    const pending = deferred<unknown>();
    const started = deferred<void>();
    mockBrowser.runtime.sendMessage.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const download = harness.sync();
    await started.promise;
    await harness.switchTo('b');
    await harness.load();
    await harness.switchTo('a');
    await harness.load();
    harness.data.folders[0].name = 'New edit in a';
    const queuedSave = harness.save();
    writes.release();
    await originalSave;
    await queuedSave;
    await Promise.resolve();
    const cloudData: FolderData = {
      folders: [{ ...privateData('a').folders[0], id: 'cloud-only', name: 'Old cloud response' }],
      folderContents: { 'cloud-only': [] },
    };
    pending.resolve({ ok: true, data: { folders: { data: cloudData } } });
    await download;
    expect(harness.data.folders.map((folder) => folder.name)).toEqual(['New edit in a']);
    expect((extensionLocal[aKeys.live] as FolderData).folders.map((folder) => folder.name)).toEqual(
      ['New edit in a'],
    );
  });

  it('serializes a legacy migration with edits made after returning to its account', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    delete extensionLocal[aKeys.live];
    localStorage.removeItem(aKeys.live);
    const legacy = privateData('a');
    legacy.folderContents.a.push({
      conversationId: 'legacy-a',
      title: 'Legacy a',
      addedAt: 1,
      url:
        platform === 'gemini'
          ? 'https://gemini.google.com/u/1/app/abc'
          : 'https://aistudio.google.com/prompts/abc',
    });
    extensionLocal[baseKey(platform)] = legacy;
    const writes = pauseFirstWrite(harness, platform, aKeys.live);
    const migration = harness.load();
    await writes.started;
    await harness.switchTo('b');
    await harness.load();
    await harness.switchTo('a');
    await harness.load();
    harness.data.folders[0].name = 'Edited after migration started';
    const newestSave = harness.save();
    writes.release();
    await migration;
    await newestSave;
    await Promise.resolve();
    expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe(
      'Edited after migration started',
    );
    expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Edited after migration started');
    expect(extensionLocal[baseKey(platform)]).toEqual(legacy);
  });

  it('ignores an earlier account resolution that finishes after a newer one', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const scopeA = harness.accountScope!;
    const pending = deferred<AccountScope>();
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockImplementationOnce(
      () => pending.promise,
    );
    const oldResolution = harness.switchTo('a');
    await harness.switchTo('b');
    await harness.load();
    pending.resolve(scopeA);
    await oldResolution;
    expect(harness.storageKey).toBe(bKeys.live);
    expect(harness.data.folders[0]?.name).toBe('Private b');
  });

  it('does not apply a cloud download after its account has changed', async () => {
    const aKeys = await accountKeys(platform, 'a');
    const bKeys = await accountKeys(platform, 'b');
    extensionLocal[aKeys.live] = privateData('a');
    extensionLocal[bKeys.live] = privateData('b');
    const harness = await makeHarness(platform, 'a');
    const pending = deferred<unknown>();
    const started = deferred<void>();
    mockBrowser.runtime.sendMessage.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const download = harness.sync();
    await started.promise;
    await harness.switchTo('b');
    await harness.load();
    pending.resolve({ ok: true, data: { folders: { data: privateData('a') } } });
    await download;
    expect(harness.data.folders.map((folder) => folder.name)).toEqual(['Private b']);
    expect((extensionLocal[bKeys.live] as FolderData).folders.map((folder) => folder.name)).toEqual(
      ['Private b'],
    );
  });

  it('clears mounted account rows while resolution is pending and after it fails', async () => {
    const aKeys = await accountKeys(platform, 'a');
    extensionLocal[aKeys.live] = privateData('a');
    const harness = await makeHarness(platform, 'a');
    const container =
      platform === 'gemini' ? await mountGeminiPanel(harness) : document.createElement('div');
    if (platform === 'aistudio') {
      container.innerHTML = '<div class="gv-folder-list"><div>Private a</div></div>';
      document.body.appendChild(container);
      harness.manager.container = container;
    }
    expect(container.textContent).toContain('Private a');
    const pending = deferred<void>();
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error('offline');
    });
    selectAccount(platform, 'b');
    const switching =
      platform === 'gemini'
        ? harness.store!.reloadScopedDataOnAccountRouteChange()
        : harness.manager.refreshScopedDataOnAccountContextChange();
    expect(container.textContent).not.toContain('Private a');
    pending.resolve();
    await switching;
    expect(container.textContent).not.toContain('Private a');
  });
});

it('Gemini retries an old save under its captured key without suppressing the new account echo', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[aKeys.live] = privateData('a');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  const pending = deferred<boolean>();
  const write = vi
    .spyOn(harness.adapter!, 'saveData')
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(true);
  const oldSave = harness.save();
  await harness.switchTo('b');
  await harness.load();
  pending.resolve(false);
  await oldSave;
  expect(write.mock.calls.map(([key]) => key)).toEqual([aKeys.live, aKeys.live]);
  const reload = vi.spyOn(harness.store!, 'reloadFoldersFromStorage').mockResolvedValue();
  emitStorageChange({ [bKeys.live]: { newValue: privateData('b') } }, 'local');
  expect(reload).toHaveBeenCalledOnce();
});

it('Gemini discards an import result that completes after switching accounts', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[aKeys.live] = privateData('a');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  const payload = FolderImportExportService.exportToPayload(privateData('a'));
  const result = await FolderImportExportService.importFromPayload(payload, privateData('a'), {
    strategy: 'merge',
    createBackup: false,
  });
  const pending = deferred<typeof result>();
  vi.spyOn(FolderImportExportService, 'importFromPayload').mockImplementationOnce(
    () => pending.promise,
  );
  const imported = harness.manager.transfer.import({ text: JSON.stringify(payload) }, 'merge');
  await harness.switchTo('b');
  await harness.load();
  pending.resolve(result);
  await imported;
  expect(harness.data.folders.map((folder) => folder.name)).toEqual(['Private b']);
  expect((extensionLocal[bKeys.live] as FolderData).folders.map((folder) => folder.name)).toEqual([
    'Private b',
  ]);
});

it('AI Studio does not restart a slow account resolution on every poll', async () => {
  const keys = await accountKeys('aistudio', 'a');
  extensionLocal[keys.live] = privateData('a');
  const harness = await makeHarness('aistudio', 'a');
  const resolved = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: 'b@example.com',
    routeUserId: null,
  });
  const pending = deferred<AccountScope>();
  const resolveScope = vi
    .spyOn(accountIsolationService, 'resolveAccountScope')
    .mockImplementation(() => pending.promise);
  selectAccount('aistudio', 'b');
  const first = harness.manager.refreshScopedDataOnAccountContextChange();
  const second = harness.manager.refreshScopedDataOnAccountContextChange();
  pending.resolve(resolved);
  await Promise.all([first, second]);
  expect(resolveScope).toHaveBeenCalledOnce();
});

it('Gemini does not revive an import after returning to its still-saving account', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[aKeys.live] = privateData('a');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  const writes = pauseFirstWrite(harness, 'gemini', aKeys.live);
  const originalSave = harness.save();
  await writes.started;
  const payload = FolderImportExportService.exportToPayload(privateData('a'));
  const result = await FolderImportExportService.importFromPayload(payload, privateData('a'), {
    strategy: 'merge',
    createBackup: false,
  });
  const pending = deferred<typeof result>();
  vi.spyOn(FolderImportExportService, 'importFromPayload').mockImplementationOnce(
    () => pending.promise,
  );
  const imported = harness.manager.transfer.import({ text: JSON.stringify(payload) }, 'merge');
  await harness.switchTo('b');
  await harness.load();
  await harness.switchTo('a');
  await harness.load();
  harness.data.folders[0].name = 'New edit in a';
  const queuedSave = harness.save();
  writes.release();
  await originalSave;
  await queuedSave;
  await Promise.resolve();
  pending.resolve(result);
  await imported;
  expect(harness.data.folders[0]?.name).toBe('New edit in a');
  expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe('New edit in a');
});

it('Gemini resets a focused floating draft on account switch and renders the loaded account', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[aKeys.live] = privateData('a');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  const panel = mountFloatingPanel({ data: harness.data });
  harness.manager.floatingPanelHandle = panel;
  const geometry = panel.element.style.cssText;
  panel.element
    .querySelector<HTMLButtonElement>('.gv-floating-folder-panel__icon-button--create')!
    .click();
  const input = panel.element.querySelector<HTMLInputElement>(
    '.gv-floating-folder-panel__inline-input',
  )!;
  input.value = 'Private draft a';
  input.focus();
  const switching = harness.switchTo('b');
  expect(panel.element.textContent).not.toContain('Private a');
  expect(panel.element.querySelector('.gv-floating-folder-panel__inline-input')).toBeNull();
  expect(panel.element.style.cssText).toBe(geometry);
  await switching;
  await harness.load();
  expect(panel.element.textContent).toContain('Private b');
});

it('Gemini closes the old instructions editor on account change and ignores its detached save button', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[aKeys.live] = privateData('a');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  harness.manager.treeView.applySettings(
    { [StorageKeys.FOLDER_PROJECT_ENABLED]: { newValue: true } },
    'sync',
  );
  const panel = await mountGeminiPanel(harness);
  panel.querySelector<HTMLButtonElement>('.gv-folder-actions-btn')!.click();
  const item = Array.from(document.querySelectorAll<HTMLElement>('.gv-folder-menu-item')).find(
    (element) => element.textContent === 'folderAsProject_setInstructions',
  );
  expect(item).toBeDefined();
  item!.click();
  const editor = document.querySelector<HTMLTextAreaElement>('.gv-fi-textarea')!;
  editor.value = 'Private instructions from A';
  const oldSave = document.querySelector<HTMLButtonElement>('.gv-fi-btn-save')!;
  await harness.switchTo('b');
  await harness.load();
  expect(document.querySelector('.gv-fi-textarea')).toBeNull();
  oldSave.click();
  await Promise.resolve();
  expect(harness.data).toEqual(privateData('b'));
  expect(extensionLocal[bKeys.live]).toEqual(privateData('b'));
});

it('Gemini updates the mounted user filter button when account isolation changes in either direction', async () => {
  extensionSync[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] = false;
  const harness = await makeHarness('gemini', 'a');
  const panel = await mountGeminiPanel(harness);
  const filter = panel.querySelector<HTMLButtonElement>('.gv-folder-user-filter-toggle')!;
  expect(filter.hidden).toBe(false);
  await harness.store!.setAccountIsolationEnabled(true);
  expect(filter.hidden).toBe(true);
  await harness.store!.setAccountIsolationEnabled(false);
  expect(filter.hidden).toBe(false);
});

it('Gemini does not restart adapter migration while the first account mirror is pending', async () => {
  const aKeys = await accountKeys('gemini', 'a');
  const bKeys = await accountKeys('gemini', 'b');
  extensionLocal[bKeys.live] = privateData('b');
  const harness = await makeHarness('gemini', 'a');
  harness.data = privateData('a');
  const firstMirror = deferred<void>();
  const initMirror = deferred<void>();
  const started = deferred<void>();
  let originalMirrors = 0;
  mockBrowser.storage.local.set.mockImplementation(async (values) => {
    const snapshot = structuredClone(values);
    const data = snapshot[aKeys.live] as FolderData | undefined;
    if (data?.folders[0]?.name === 'Private a') {
      originalMirrors += 1;
      if (originalMirrors === 1) {
        started.resolve();
        await firstMirror.promise;
      } else {
        await initMirror.promise;
      }
    }
    Object.assign(extensionLocal, snapshot);
  });
  // Keep the real adapter: init() can write a chrome mirror independently of saveData().
  const originalSave = harness.save();
  await started.promise;
  harness.data.folders[0].name = 'Queued latest a';
  const queuedSave = harness.save();
  await harness.switchTo('b');
  await harness.load();
  const returning = harness.switchTo('a');
  await vi.waitFor(() => {
    expect(originalMirrors === 2 || harness.storageKey === aKeys.live).toBe(true);
  });
  firstMirror.resolve();
  await originalSave;
  await queuedSave;
  await vi.waitFor(() => {
    expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe('Queued latest a');
  });
  initMirror.resolve();
  await returning;
  await harness.load();
  expect((extensionLocal[aKeys.live] as FolderData).folders[0]?.name).toBe('Queued latest a');
  expect(backupData(aKeys.backup)?.folders[0]?.name).toBe('Queued latest a');
  expect(originalMirrors).toBe(1);
});
