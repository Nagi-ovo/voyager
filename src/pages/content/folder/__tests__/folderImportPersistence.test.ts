import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import { historyTimestampStore } from '../../timestamp/historyTimestamps';
import { FolderManager } from '../manager';
import * as storageAdapters from '../storage/FolderStorageAdapter';
import { mountSidebar } from './sidebarRuntimeHarness';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

function folderData(id: string): FolderData {
  return {
    folders: [
      {
        id,
        name: `${id} folder`,
        parentId: null,
        isExpanded: true,
        sortIndex: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: {
      [id]: [
        {
          conversationId: `c_${id}`,
          title: `${id} conversation`,
          url: `https://gemini.google.com/app/${id}`,
          sortIndex: 0,
          addedAt: 1,
        },
      ],
    },
  };
}

describe('FolderManager import persistence through the sidebar UI', () => {
  let manager: FolderManager;
  let adapter: storageAdapters.IFolderStorageAdapter;
  let persisted: FolderData;
  let original: FolderData;

  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState({}, '', '/app');
    mountSidebar();
    vi.mocked(chrome.storage.sync.get).mockImplementation(async (keys) => ({
      ...(keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {}),
      [StorageKeys.LANGUAGE]: 'en',
      [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: false,
      [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
    }));
    vi.mocked(chrome.storage.local.get).mockImplementation(
      async (_keys, callback?: (items: Record<string, unknown>) => void) => {
        callback?.({});
        return {};
      },
    );
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    original = folderData('existing');
    persisted = structuredClone(original);
    adapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async () => structuredClone(persisted)),
      saveData: vi.fn(async (_key, data) => {
        persisted = structuredClone(data);
        return true;
      }),
      removeData: vi.fn(async () => {}),
      getBackendName: () => 'test-memory',
    };
    vi.spyOn(storageAdapters, 'createFolderStorageAdapter').mockReturnValue(adapter);
    manager = new FolderManager();
    await manager.init();
    expect(manager.getFolders()).toEqual(original.folders);
    expect(document.querySelector('.gv-folder-list')?.textContent).toContain(
      'existing conversation',
    );
    expect(adapter.saveData).not.toHaveBeenCalled();
  });

  afterEach(() => {
    manager?.destroy();
    historyTimestampStore.stop();
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  async function failImport(strategy: 'merge' | 'overwrite') {
    document.querySelector<HTMLButtonElement>('.gv-folder-import-export-btn')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-folder-menu-item'))
      .find((button) => button.textContent?.endsWith(t('folder_import')))!
      .click();
    const dialog = document.querySelector<HTMLElement>('.gv-folder-import-dialog')!;
    dialog.querySelector<HTMLInputElement>(`input[value="${strategy}"]`)!.click();
    dialog.querySelector<HTMLButtonElement>('.gv-folder-import-paste-toggle')!.click();
    const input = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    const text = JSON.stringify(FolderImportExportService.exportToPayload(folderData('imported')));
    input.value = text;
    const submit = dialog.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-primary')!;
    let finishSave!: (saved: boolean) => void;
    vi.mocked(adapter.saveData)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishSave = resolve)))
      .mockResolvedValueOnce(false); // The store retries a failed adapter write once.

    submit.click();
    await vi.waitFor(() => expect(adapter.saveData).toHaveBeenCalledTimes(1));
    expect.soft(manager.getFolders()).toEqual(original.folders);
    expect(persisted).toEqual(original);
    expect(submit.disabled).toBe(true);
    finishSave(false);
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(adapter.saveData).toHaveBeenCalledTimes(2);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(text);
    expect(document.querySelector('.gv-notification-error')?.textContent).toBe(
      t('folder_save_error'),
    );
    expect(document.querySelector('.gv-notification-success')).toBeNull();
    return { dialog, submit };
  }

  it.each(['merge', 'overwrite'] as const)(
    'does not persist a cancelled failed %s during the next ordinary folder save',
    async (strategy) => {
      const { dialog } = await failImport(strategy);
      dialog.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-secondary')!.click();
      expect(dialog.isConnected).toBe(false);
      expect.soft(manager.getFolders()).toEqual(original.folders);
      document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click();
      const input = document.querySelector<HTMLInputElement>('.gv-folder-name-input')!;
      input.value = 'Created after cancellation';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => expect(adapter.saveData).toHaveBeenCalledTimes(3));

      expect(persisted.folders.map((folder) => folder.name)).toEqual([
        'existing folder',
        'Created after cancellation',
      ]);
      expect(persisted.folderContents.existing).toEqual(original.folderContents.existing);
      expect(persisted.folderContents.imported).toBeUndefined();
      expect(manager.getFolders()).toEqual(persisted.folders);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain(
        'existing conversation',
      );
    },
  );

  it('retries the retained draft with the original merge counts and persists it once', async () => {
    const { dialog, submit } = await failImport('merge');
    submit.click();
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));

    expect(adapter.saveData).toHaveBeenCalledTimes(3);
    expect(persisted.folders.map((folder) => folder.id)).toEqual(['existing', 'imported']);
    expect(persisted.folderContents.existing).toEqual(original.folderContents.existing);
    expect(persisted.folderContents.imported).toEqual(
      folderData('imported').folderContents.imported,
    );
    expect(manager.getFolders()).toEqual(persisted.folders);
    expect(document.querySelector('.gv-notification-success')?.textContent).toBe(
      t('folder_import_success').replace('{folders}', '1').replace('{conversations}', '1'),
    );
  });
});
