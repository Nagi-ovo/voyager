import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';

import { FolderDataSession } from '../FolderDataSession';
import { FolderTransferController } from '../FolderTransferController';
import type { FolderData } from '../types';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
let localGet: ReturnType<typeof vi.fn<(keys: unknown) => Promise<Record<string, unknown>>>>;
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage } } }));
vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const emptyData = (): FolderData => ({ folders: [], folderContents: {} });
const importedData = (): FolderData => ({
  folders: [
    {
      id: 'coding',
      name: 'Coding',
      instructions: 'Use TypeScript.',
      parentId: null,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  folderContents: {
    coding: [
      {
        conversationId: 'c_abc',
        title: 'Code review',
        url: 'https://gemini.google.com/u/1/app/abc',
        addedAt: 1,
      },
    ],
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(data = emptyData()) {
  const session = new FolderDataSession('gvFolderData', 'transfer-test', null, () => true);
  session.data = data;
  session.ready = true;
  let activation = 1;
  const applyData = vi.fn(async (next: FolderData) => {
    session.data = next;
    return true;
  });
  const refresh = vi.fn();
  const notify = vi.fn();
  const transfer = new FolderTransferController({
    getContext: () => ({ session, activation, data: session.data }),
    applyData,
    refresh,
    notify,
  });
  return {
    session,
    transfer,
    applyData,
    refresh,
    notify,
    leaveAndReturn: () => {
      activation += 2;
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  sendMessage.mockReset();
  localGet = vi.fn(async () => ({}));
  chrome.storage.local.get = localGet as typeof chrome.storage.local.get;
  vi.mocked(chrome.storage.local.set).mockResolvedValue();
});

afterEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('folder transfer commands', () => {
  it.each(['file', 'text'] as const)(
    'imports %s through the same merge and keeps a restorable backup',
    async (kind) => {
      const local = importedData();
      local.folders[0].id = 'local';
      local.folderContents = { local: [] };
      const h = harness(local);
      const text = JSON.stringify(FolderImportExportService.exportToPayload(importedData()));
      const file = new File([text], 'folders.json', { type: 'application/json' });
      Object.defineProperty(file, 'text', { value: async () => text });
      await h.transfer.import(kind === 'text' ? { text } : { file }, 'merge');

      expect(h.session.data.folders.map((folder) => folder.id)).toEqual(['local', 'coding']);
      expect(h.session.data.folders[1].instructions).toBe('Use TypeScript.');
      expect(h.session.data.folderContents.coding[0].url).toBe(
        'https://gemini.google.com/u/1/app/abc',
      );
      expect(local.folders).toHaveLength(1);
      expect(h.applyData).toHaveBeenCalledOnce();
      expect(h.refresh).toHaveBeenCalledOnce();
      const restored = FolderImportExportService.restoreFromBackup();
      expect(restored).toEqual({ success: true, data: local });
    },
  );

  it('cancels an overwrite without changing the current data or backup', async () => {
    const h = harness(importedData());
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await h.transfer.import(
      { text: JSON.stringify(FolderImportExportService.exportToPayload(emptyData())) },
      'overwrite',
    );
    expect(h.session.data).toEqual(importedData());
    expect(h.applyData).not.toHaveBeenCalled();
    expect(FolderImportExportService.hasBackup()).toBe(false);
  });

  it('submits pasted JSON from the import dialog and closes its overlay', async () => {
    const h = harness();
    h.transfer.showImportDialog();
    document.querySelector<HTMLButtonElement>('.gv-folder-import-paste-toggle')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('.gv-folder-import-paste-area')!;
    expect(input.style.display).toBe('block');
    input.value = JSON.stringify(FolderImportExportService.exportToPayload(importedData()));
    document.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-primary')!.click();
    await vi.waitFor(() => expect(h.applyData).toHaveBeenCalledOnce());
    expect(h.session.data).toEqual(importedData());
    expect(document.querySelector('.gv-folder-dialog-overlay')).toBeNull();
  });

  it('shares the in-flight import guard between file and text sources, then releases it', async () => {
    const h = harness();
    const text = JSON.stringify(FolderImportExportService.exportToPayload(importedData()));
    const pending = deferred<string>();
    const file = new File([], 'folders.json');
    Object.defineProperty(file, 'text', { value: () => pending.promise });
    const first = h.transfer.import({ file }, 'merge');
    await h.transfer.import({ text }, 'merge');
    expect(h.applyData).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith('folder_import_in_progress', 'info');
    pending.resolve(text);
    await first;
    await h.transfer.import({ text }, 'merge');
    expect(h.applyData).toHaveBeenCalledTimes(2);
    expect(h.session.data.folderContents.coding).toHaveLength(1);
  });

  it('keeps the import draft until persistence succeeds and allows retry after failure', async () => {
    const h = harness();
    const pending = deferred<boolean>();
    h.applyData.mockReturnValueOnce(pending.promise);
    h.transfer.showImportDialog();
    const input = document.querySelector<HTMLTextAreaElement>('.gv-folder-import-paste-area')!;
    const text = JSON.stringify(FolderImportExportService.exportToPayload(importedData()));
    input.value = text;
    const save = document.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-primary')!;
    save.click();
    save.click();
    await vi.waitFor(() => expect(h.applyData).toHaveBeenCalledOnce());
    expect(save.disabled).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    pending.resolve(false);
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(text);
    expect(h.notify).toHaveBeenLastCalledWith('folder_save_error', 'error');
    save.click();
    await vi.waitFor(() => expect(input.isConnected).toBe(false));
    expect(h.applyData).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith('folder_import_success', 'success');
  });

  it('does not report an old import save or close the next account dialog', async () => {
    const h = harness();
    const pending = deferred<boolean>();
    h.applyData.mockReturnValueOnce(pending.promise);
    h.transfer.showImportDialog();
    document.querySelector<HTMLTextAreaElement>('.gv-folder-import-paste-area')!.value =
      JSON.stringify(FolderImportExportService.exportToPayload(importedData()));
    document.querySelector<HTMLButtonElement>('.gv-folder-dialog-btn-primary')!.click();
    await vi.waitFor(() => expect(h.applyData).toHaveBeenCalledOnce());
    h.leaveAndReturn();
    h.transfer.closeImportDialog();
    h.transfer.showImportDialog();
    const next = document.querySelector('.gv-folder-dialog-overlay')!;
    pending.resolve(true);
    await pending.promise;
    await Promise.resolve();
    expect(next.isConnected).toBe(true);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each(['folders', 'other data'] as const)(
    'does not report a cloud merge when saving %s fails',
    async (part) => {
      const h = harness();
      sendMessage.mockResolvedValue({ ok: true, data: { folders: { data: importedData() } } });
      if (part === 'folders') h.applyData.mockResolvedValue(false);
      else vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('Quota exceeded'));

      await h.transfer.sync();

      expect(h.notify).toHaveBeenLastCalledWith(
        part === 'folders' ? 'folder_save_error' : 'syncError',
        'error',
      );
      expect(h.notify).not.toHaveBeenCalledWith('downloadMergeSuccess', 'success');
      expect(h.refresh).not.toHaveBeenCalled();
    },
  );

  it('uploads the captured folder snapshot even when live data changes before prompt loading finishes', async () => {
    const h = harness(importedData());
    const pending = deferred<Record<string, unknown>>();
    localGet.mockReturnValueOnce(pending.promise);
    sendMessage.mockResolvedValue({ ok: true });
    const uploading = h.transfer.upload();
    h.session.data.folders[0].name = 'Edited during upload';
    pending.resolve({ gvPromptItems: [] });
    await uploading;
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gv.sync.upload',
        payload: expect.objectContaining({ folders: importedData() }),
      }),
    );
  });

  it('does not upload after leaving and returning to the same account session', async () => {
    const h = harness(importedData());
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<void>();
    localGet.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const uploading = h.transfer.upload();
    await started.promise;
    h.leaveAndReturn();
    pending.resolve({ gvPromptItems: [] });
    await uploading;
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('merges downloaded folders, legacy prompts and tolerant starred messages through the real command', async () => {
    const h = harness();
    const localPrompt = {
      id: 'p1',
      name: 'Keep local name',
      text: 'local',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const cloudPrompt = { id: 'p1', text: 'cloud update', tags: [], createdAt: 1, updatedAt: 2 };
    const localStar = { turnId: 'turn1', title: 'Local tie winner' };
    localGet.mockImplementation(async (keys) => {
      if (Array.isArray(keys) && keys.includes('gvPromptItems'))
        return { gvPromptItems: [localPrompt] };
      if (Array.isArray(keys) && keys.includes('geminiTimelineStarredMessages')) {
        return { geminiTimelineStarredMessages: { messages: { abc: [null, {}, localStar] } } };
      }
      return {};
    });
    sendMessage.mockResolvedValue({
      ok: true,
      data: {
        folders: { data: importedData() },
        prompts: { items: [cloudPrompt] },
        starred: {
          data: {
            messages: {
              abc: [
                { turnId: 'turn1', title: 'Cloud' },
                { turnId: 'turn2', starredAt: 3 },
              ],
            },
          },
        },
      },
    });
    await h.transfer.sync();
    expect(h.session.data).toEqual(importedData());
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        gvPromptItems: [{ ...cloudPrompt, name: 'Keep local name' }],
        geminiTimelineStarredMessages: {
          messages: { abc: [localStar, { turnId: 'turn2', starredAt: 3 }] },
        },
      }),
    );
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith('downloadMergeSuccess', 'success');
  });
});
