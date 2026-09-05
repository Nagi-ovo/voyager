import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';

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
    sessionStorage.clear();
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
    sessionStorage.clear();
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

  it('renders an issued import when it finishes after leaving and returning to account A', async () => {
    const instance = await initialize('sidebar');
    const write = deferred<boolean>();
    vi.mocked(adapter.saveData).mockReturnValueOnce(write.promise);
    const imported = accountData('imported-a');
    imported.folders[0].name = 'Imported A';

    document.querySelector<HTMLButtonElement>('.gv-folder-import-export-btn')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-folder-menu-item'))
      .find((button) => button.textContent?.endsWith('folder_import'))!
      .click();
    document.querySelector<HTMLButtonElement>('.gv-folder-import-paste-toggle')!.click();
    document.querySelector<HTMLTextAreaElement>('.gv-folder-import-paste-area')!.value =
      JSON.stringify(FolderImportExportService.exportToPayload(imported));
    document.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-primary')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.saveData).toHaveBeenCalledExactlyOnceWith(
      buildScopedFolderStorageKey('email:a'),
      expect.objectContaining({
        folders: expect.arrayContaining([expect.objectContaining({ name: 'Imported A' })]),
      }),
    );

    history.pushState({}, '', '/u/2/app');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private b');
    expect(document.querySelector('.gv-folder-list')?.textContent).not.toContain('Imported A');
    expect(document.querySelector('.gv-folder-import-dialog')).toBeNull();
    history.pushState({}, '', '/u/1/app');
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getFolders().map((folder) => folder.name)).toEqual(['Private a']);
    expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private a');

    write.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.getFolders().map((folder) => folder.name)).toEqual(['Private a', 'Imported A']);
    expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Imported A');
    expect(document.querySelector('.gv-folder-list')?.textContent).not.toContain('Private b');
    expect(document.querySelector('.gv-notification-success')).toBeNull();
  });

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
