import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import { FolderStore } from '../FolderStore';
import { FolderManager } from '../manager';
import * as storageAdapters from '../storage/FolderStorageAdapter';
import type { FolderData } from '../types';
import { mountSidebar } from './sidebarRuntimeHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type Surface = 'sidebar' | 'floating' | 'fab';

function accountData(account: string): FolderData {
  return {
    folders: [
      {
        id: account,
        name: `Private ${account}`,
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: { [account]: [] },
  };
}

function accountScope(account: string, route: string): AccountScope {
  return {
    accountKey: `email:${account}`,
    accountId: Number(route),
    routeUserId: route,
    emailHash: account,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('FolderManager account routes across mounted surfaces', () => {
  let manager: FolderManager | null;
  let adapter: storageAdapters.IFolderStorageAdapter;

  async function initialize(surface: Surface): Promise<FolderManager> {
    vi.mocked(chrome.storage.sync.get).mockImplementation(async (keys) => ({
      ...(keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {}),
      [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: surface !== 'sidebar',
      [StorageKeys.FOLDER_FLOATING_OPEN_ON_START]: surface !== 'fab',
    }));
    manager = new FolderManager();
    await manager.init();
    expect(manager.getFolders().map((folder) => folder.name)).toEqual(['Private a']);
    return manager;
  }

  function setEnabled(enabled: boolean): void {
    for (const [listener] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls) {
      listener({ geminiFolderEnabled: { newValue: enabled } }, 'sync');
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/u/1/app');
    mountSidebar();
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(true);
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockImplementation(async (context) =>
      accountScope(context?.routeUserId === '2' ? 'b' : 'a', context?.routeUserId ?? '1'),
    );
    adapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async (key) =>
        accountData(key === buildScopedFolderStorageKey('email:b') ? 'b' : 'a'),
      ),
      saveData: vi.fn(async () => true),
      removeData: vi.fn(async () => {}),
      getBackendName: () => 'test-memory',
    };
    vi.spyOn(storageAdapters, 'createFolderStorageAdapter').mockReturnValue(adapter);
    // History fetching is independent of the manager's account route listener.
    vi.spyOn(FolderStore.prototype, 'initializeConversationActivityTracking').mockResolvedValue();
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['sidebar', 'floating', 'fab'] as const)(
    'clears account A on a real route change from %s and waits for account B to load',
    async (surface) => {
      const instance = await initialize(surface);
      const resolution = deferred<AccountScope>();
      const loaded = deferred<FolderData>();
      const loadStarted = deferred<void>();
      vi.mocked(accountIsolationService.resolveAccountScope).mockReturnValueOnce(
        resolution.promise,
      );
      vi.mocked(adapter.loadData).mockImplementationOnce(() => {
        loadStarted.resolve();
        return loaded.promise;
      });

      history.pushState({}, '', '/u/2/app');
      await vi.advanceTimersByTimeAsync(0);

      expect(instance.getFolders()).toEqual([]);
      expect(document.body.textContent).not.toContain('Private a');
      if (surface === 'fab') {
        const fab = document.querySelector<HTMLButtonElement>('.gv-floating-fab')!;
        expect(fab).not.toBeNull();
        fab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
      }
      const root = document.querySelector<HTMLElement>(
        surface === 'sidebar' ? '.gv-folder-container' : '.gv-floating-folder-panel',
      )!;
      const create = root.querySelector<HTMLButtonElement>(
        surface === 'sidebar' ? '.gv-folder-add-btn' : '[aria-label="floatingPanelCreateFolder"]',
      )!;
      const editorSelector =
        surface === 'sidebar' ? '.gv-folder-name-input' : '.gv-floating-folder-panel__inline-input';
      expect(create.disabled).toBe(true);
      create.click();
      expect(root.querySelector(editorSelector)).toBeNull();
      expect(adapter.saveData).not.toHaveBeenCalled();

      resolution.resolve(accountScope('b', '2'));
      await loadStarted.promise;
      expect(create.disabled).toBe(true);
      expect(instance.getFolders()).toEqual([]);
      loaded.resolve(accountData('b'));
      await vi.advanceTimersByTimeAsync(0);

      expect(create.disabled).toBe(false);
      expect(root.textContent).toContain('Private b');
      expect(instance.getFolders().map((folder) => folder.name)).toEqual(['Private b']);
      create.click();
      const input = root.querySelector<HTMLInputElement>(editorSelector)!;
      input.value = 'Created for B';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.saveData).toHaveBeenCalledWith(
        buildScopedFolderStorageKey('email:b'),
        expect.objectContaining({
          folders: expect.arrayContaining([expect.objectContaining({ name: 'Created for B' })]),
        }),
      );
    },
  );

  it.each(['floating', 'fab'] as const)(
    '%s rebinds once after disable/re-enable and stops reacting after destroy',
    async (surface) => {
      const instance = await initialize(surface);
      setEnabled(false);
      vi.mocked(accountIsolationService.resolveAccountScope).mockClear();
      history.pushState({}, '', '/u/1/app/while-disabled');
      await vi.advanceTimersByTimeAsync(1000);
      expect(accountIsolationService.resolveAccountScope).not.toHaveBeenCalled();
      expect(document.querySelector('.gv-floating-folder-panel, .gv-floating-fab')).toBeNull();

      setEnabled(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelectorAll('.gv-floating-folder-panel, .gv-floating-fab')).toHaveLength(
        1,
      );
      history.pushState({}, '', '/u/2/app');
      await vi.advanceTimersByTimeAsync(1000);
      expect(instance.getFolders().map((folder) => folder.name)).toEqual(['Private b']);
      expect(accountIsolationService.resolveAccountScope).toHaveBeenCalledTimes(1);

      instance.destroy();
      manager = null;
      vi.mocked(accountIsolationService.resolveAccountScope).mockClear();
      history.pushState({}, '', '/u/3/app');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(accountIsolationService.resolveAccountScope).not.toHaveBeenCalled();
      expect(document.querySelector('.gv-floating-folder-panel, .gv-floating-fab')).toBeNull();
    },
  );
});
