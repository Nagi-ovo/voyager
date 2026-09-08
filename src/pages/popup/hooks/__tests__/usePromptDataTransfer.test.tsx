import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { PromptImportExportService } from '@/features/backup/services/PromptImportExportService';
import type { PromptItem } from '@/features/backup/types/backup';
import type { TranslationKey } from '@/utils/translations';

import { PromptDataTransfer } from '../../components/PromptDataTransfer';
import { type PromptDataTransferController, usePromptDataTransfer } from '../usePromptDataTransfer';

const translations: Partial<Record<TranslationKey, string>> = {
  promptExportSuccess: 'Exported {count}',
  pm_import_success: 'Imported {count}',
  promptNameConflictsDetected: 'Conflicts {count}',
  promptCloudPullSuccess: 'Pulled {count}',
  promptCloudPushSuccess: 'Pushed {count}',
};
const translate = (key: TranslationKey): string => translations[key] ?? key;

function Harness({
  capture,
  visible,
}: {
  capture: (transfer: PromptDataTransferController) => void;
  visible: boolean;
}) {
  const transfer = usePromptDataTransfer(translate);
  useEffect(() => {
    capture(transfer);
  }, [capture, transfer]);
  return visible ? <PromptDataTransfer t={translate} transfer={transfer} /> : null;
}

describe('usePromptDataTransfer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let transfer: PromptDataTransferController;
  let store: Record<string, unknown>;
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>();

  const render = (visible = true) => {
    act(() => {
      root.render(<Harness visible={visible} capture={(next) => (transfer = next)} />);
    });
  };
  const buttons = () => Array.from(container.querySelectorAll('button'));
  const button = (label: string) => buttons().find((item) => item.textContent === label)!;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store = {};
    sendMessage.mockReset();
    vi.stubGlobal('chrome', {
      ...chrome,
      runtime: { ...chrome.runtime, lastError: null, sendMessage },
      storage: {
        ...chrome.storage,
        local: {
          ...chrome.storage.local,
          get: vi.fn((keys: string[], callback: (items: Record<string, unknown>) => void) => {
            callback(Object.fromEntries(keys.map((key) => [key, store[key]])));
          }),
          set: vi.fn((items: Record<string, unknown>, callback: () => void) => {
            Object.assign(store, items);
            callback();
          }),
        },
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(PromptImportExportService, 'downloadJSON').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function importFile(contents: string): Promise<HTMLInputElement> {
    const file = new File([contents], 'prompts.json', { type: 'application/json' });
    // jsdom does not implement File.text or a file-picker selection.
    Object.defineProperty(file, 'text', { value: async () => contents });
    const input = transfer.inputRef.current!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    Object.defineProperty(input, 'value', {
      configurable: true,
      writable: true,
      value: 'C:\\fakepath\\prompts.json',
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input.value).toBe('');
    expect(transfer.busy).toBe(false);
    return input;
  }

  it('exports the shared prompt library in its existing format and reports the count', async () => {
    const prompts: PromptItem[] = [
      { id: 'saved', name: 'Saved prompt', text: 'Body', tags: ['tag'], createdAt: 1 },
    ];
    store[StorageKeys.PROMPT_ITEMS] = prompts;

    await act(async () => button('pm_export').click());

    expect(PromptImportExportService.downloadJSON).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'gemini-voyager.prompts.v1', items: prompts }),
    );
    expect(transfer.status).toEqual({ kind: 'ok', text: 'Exported 1' });
    expect(transfer.busy).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('exports an empty library and reports storage failures without a download', async () => {
    await act(async () => transfer.onExport());
    expect(transfer.status).toEqual({ kind: 'ok', text: 'Exported 0' });
    vi.mocked(PromptImportExportService.downloadJSON).mockClear();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(() => {
      throw new Error('Read failed');
    });

    await act(async () => transfer.onExport());

    expect(transfer.status).toEqual({ kind: 'err', text: 'promptExportError' });
    expect(transfer.busy).toBe(false);
    expect(PromptImportExportService.downloadJSON).not.toHaveBeenCalled();
  });

  it('opens the JSON picker and imports new and duplicate prompts through the existing merge', async () => {
    store[StorageKeys.PROMPT_ITEMS] = [
      { id: 'existing', text: 'Existing body', tags: ['local'], createdAt: 1 },
    ];
    const input = transfer.inputRef.current!;
    const openPicker = vi.spyOn(input, 'click');
    act(() => button('pm_import').click());
    expect(openPicker).toHaveBeenCalledOnce();
    expect(input.accept).toBe('.json,application/json');
    expect(input.getAttribute('aria-label')).toBe('pm_import');

    await importFile(
      JSON.stringify({
        format: 'gemini-voyager.prompts.v1',
        items: [
          { id: 'existing', text: 'Existing body', tags: ['imported'], createdAt: 1 },
          { id: 'new', text: 'New body', tags: [], createdAt: 2 },
        ],
      }),
    );

    expect(transfer.status).toEqual({ kind: 'ok', text: 'Imported 2' });
    expect(store[StorageKeys.PROMPT_ITEMS]).toEqual([
      expect.objectContaining({ id: 'new', text: 'New body' }),
      expect.objectContaining({ id: 'existing', tags: ['local', 'imported'] }),
    ]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('retains prompts with conflicting names and reports a warning after importing', async () => {
    store[StorageKeys.PROMPT_ITEMS] = [
      { id: 'existing', name: 'Translator', text: 'First body', tags: [], createdAt: 1 },
    ];

    await importFile(
      JSON.stringify([{ id: 'new', name: 'translator', text: 'Second body', tags: [] }]),
    );

    expect(transfer.status).toEqual({ kind: 'warn', text: 'Conflicts 2' });
    expect(store[StorageKeys.PROMPT_ITEMS]).toHaveLength(2);
    expect(container.querySelector('p.text-amber-600')?.textContent).toBe('Conflicts 2');
  });

  it.each([
    ['[]', 'pm_import_empty'],
    ['{"items":[]}', 'pm_import_empty'],
    ['{"format":"unsupported"}', 'pm_import_invalid'],
    ['[{"text":""}]', 'pm_import_invalid'],
    ['not json', 'promptImportError'],
  ])('rejects %s without a write and resets the file input', async (contents, text) => {
    store[StorageKeys.PROMPT_ITEMS] = [{ id: 'kept', text: 'Keep me', tags: [], createdAt: 1 }];
    const before = structuredClone(store);

    await importFile(contents);

    expect(transfer.status).toEqual({ kind: 'err', text });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(store).toEqual(before);
  });

  it('reports an import storage failure and resets the file input for retry', async () => {
    vi.mocked(chrome.storage.local.set).mockImplementationOnce(() => {
      throw new Error('Write failed');
    });

    await importFile('[{"text":"Body"}]');

    expect(transfer.status).toEqual({ kind: 'err', text: 'promptImportError' });
    expect(store).toEqual({});
  });

  it('leaves the previous status alone when the file picker is cancelled', async () => {
    await act(async () => transfer.onExport());
    await act(async () => {
      transfer.inputRef.current!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(transfer.status).toEqual({ kind: 'ok', text: 'Exported 0' });
    expect(transfer.busy).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: 'onCloudPull',
      response: { ok: true, imported: 2, duplicates: 1 },
      kind: 'ok',
      text: 'Pulled 3',
    },
    {
      action: 'onCloudPull',
      response: { ok: true, empty: true },
      kind: 'ok',
      text: 'promptCloudPullEmpty',
    },
    {
      action: 'onCloudPull',
      response: { ok: true, nameConflicts: 2 },
      kind: 'warn',
      text: 'Conflicts 2',
    },
    { action: 'onCloudPull', response: { ok: true }, kind: 'ok', text: 'Pulled 0' },
    { action: 'onCloudPull', response: { ok: false }, kind: 'err', text: 'promptCloudError' },
    { action: 'onCloudPull', response: undefined, kind: 'err', text: 'promptCloudError' },
    { action: 'onCloudPush', response: { ok: true, count: 4 }, kind: 'ok', text: 'Pushed 4' },
    {
      action: 'onCloudPush',
      response: { ok: true, nameConflicts: 2 },
      kind: 'warn',
      text: 'Conflicts 2',
    },
    { action: 'onCloudPush', response: { ok: true }, kind: 'ok', text: 'Pushed 0' },
    { action: 'onCloudPush', response: { ok: false }, kind: 'err', text: 'promptCloudError' },
    { action: 'onCloudPush', response: undefined, kind: 'err', text: 'promptCloudError' },
  ] as const)(
    '$action reports $text from the background response',
    async ({ action, response, kind, text }) => {
      sendMessage.mockResolvedValueOnce(response);

      await act(async () => transfer[action]());

      expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: action === 'onCloudPull' ? 'gv.sync.pullPromptsMerge' : 'gv.sync.pushPromptsMerge',
        payload: { interactive: true },
      });
      expect(transfer.status).toEqual({ kind, text });
      expect(transfer.busy).toBe(false);
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    },
  );

  it.each(['onCloudPull', 'onCloudPush'] as const)(
    '%s reports a rejected background request',
    async (action) => {
      sendMessage.mockRejectedValueOnce(new Error('Disconnected'));

      await act(async () => transfer[action]());

      expect(transfer.status).toEqual({ kind: 'err', text: 'promptCloudError' });
      expect(transfer.busy).toBe(false);
    },
  );

  it('keeps the controls disabled while a background operation outlives a hidden panel', async () => {
    await act(async () => transfer.onExport());
    let resolve!: (value: { ok: boolean; count: number }) => void;
    const pending = new Promise<{ ok: boolean; count: number }>((done) => {
      resolve = done;
    });
    sendMessage.mockReturnValueOnce(pending);

    act(() => button('promptCloudPush').click());
    expect(transfer.busy).toBe(true);
    expect(transfer.status).toBeNull();
    expect(buttons()).toHaveLength(4);
    expect(buttons().every((item) => item.disabled)).toBe(true);

    render(false);
    expect(container.innerHTML).toBe('');
    render();
    expect(transfer.busy).toBe(true);
    expect(buttons().every((item) => item.disabled)).toBe(true);

    await act(async () => resolve({ ok: true, count: 3 }));

    expect(transfer.status).toEqual({ kind: 'ok', text: 'Pushed 3' });
    expect(buttons().every((item) => !item.disabled)).toBe(true);
    expect(container.querySelector('p.text-emerald-600')?.textContent).toBe('Pushed 3');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
  });
});
