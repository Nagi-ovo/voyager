import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { startSlashPromptFeature } from '../slashPromptFeature';

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const storageMocks = vi.hoisted(() => ({
  get: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: storageMocks.get,
      },
      onChanged: {
        addListener: storageMocks.addListener,
        removeListener: storageMocks.removeListener,
      },
    },
  },
}));

function getStorageListener(): StorageChangeListener {
  const listener = storageMocks.addListener.mock.calls.at(-1)?.[0] as
    | StorageChangeListener
    | undefined;
  expect(listener).toBeTypeOf('function');
  return listener!;
}

async function flushRuntimeChange(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

describe('slash prompt feature lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.get.mockResolvedValue({ [StorageKeys.SLASH_PROMPT_ENABLED]: true });
  });

  it('stays inert on surfaces that do not support Gemini slash completion', async () => {
    const start = vi.fn();

    const feature = await startSlashPromptFeature({
      pageUrl: 'https://aistudio.google.com/prompts/new_chat',
      start,
    });
    feature.destroy();

    expect(start).not.toHaveBeenCalled();
    expect(storageMocks.get).not.toHaveBeenCalled();
    expect(storageMocks.addListener).not.toHaveBeenCalled();
    expect(storageMocks.removeListener).not.toHaveBeenCalled();
  });

  it('defaults to enabled and tears down its listener and controller exactly once', async () => {
    storageMocks.get.mockResolvedValue({});
    const destroyController = vi.fn();
    const start = vi.fn().mockResolvedValue({ destroy: destroyController });

    const feature = await startSlashPromptFeature({
      pageUrl: 'https://gemini.google.com/app',
      start,
    });
    const listener = getStorageListener();

    expect(storageMocks.get).toHaveBeenCalledWith({
      [StorageKeys.SLASH_PROMPT_ENABLED]: true,
    });
    expect(start).toHaveBeenCalledTimes(1);

    feature.destroy();
    feature.destroy();

    expect(storageMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(storageMocks.removeListener).toHaveBeenCalledWith(listener);
    expect(destroyController).toHaveBeenCalledTimes(1);
  });

  it.each([
    { hidePromptManager: false, slashPromptEnabled: true, expectedStarts: 1 },
    { hidePromptManager: true, slashPromptEnabled: true, expectedStarts: 1 },
    { hidePromptManager: false, slashPromptEnabled: false, expectedStarts: 0 },
    { hidePromptManager: true, slashPromptEnabled: false, expectedStarts: 0 },
  ])(
    'uses only the slash setting when hide=$hidePromptManager and slash=$slashPromptEnabled',
    async ({ hidePromptManager, slashPromptEnabled, expectedStarts }) => {
      storageMocks.get.mockResolvedValue({
        [StorageKeys.HIDE_PROMPT_MANAGER]: hidePromptManager,
        [StorageKeys.SLASH_PROMPT_ENABLED]: slashPromptEnabled,
      });
      const start = vi.fn().mockResolvedValue({ destroy: vi.fn() });

      const feature = await startSlashPromptFeature({
        pageUrl: 'https://gemini.google.com/app',
        start,
      });

      expect(start).toHaveBeenCalledTimes(expectedStarts);
      feature.destroy();
    },
  );

  it('starts and destroys completion immediately as the sync setting changes', async () => {
    storageMocks.get.mockResolvedValue({ [StorageKeys.SLASH_PROMPT_ENABLED]: false });
    const destroyController = vi.fn();
    const start = vi.fn().mockResolvedValue({ destroy: destroyController });
    const feature = await startSlashPromptFeature({
      pageUrl: 'https://business.gemini.google/app',
      start,
    });
    const listener = getStorageListener();

    expect(start).not.toHaveBeenCalled();

    listener({ [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: false, newValue: true } }, 'sync');
    await flushRuntimeChange();
    expect(start).toHaveBeenCalledTimes(1);

    listener({ [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: true, newValue: false } }, 'sync');
    await flushRuntimeChange();
    expect(destroyController).toHaveBeenCalledTimes(1);

    listener({ [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: false, newValue: true } }, 'local');
    listener({ unrelated: { oldValue: false, newValue: true } }, 'sync');
    await flushRuntimeChange();
    expect(start).toHaveBeenCalledTimes(1);

    feature.destroy();
  });

  it('treats removing the setting as restoring the enabled default', async () => {
    storageMocks.get.mockResolvedValue({ [StorageKeys.SLASH_PROMPT_ENABLED]: false });
    const destroyController = vi.fn();
    const start = vi.fn().mockResolvedValue({ destroy: destroyController });
    const feature = await startSlashPromptFeature({
      pageUrl: 'https://gemini.google.com/app',
      start,
    });

    getStorageListener()(
      { [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: false, newValue: undefined } },
      'sync',
    );
    await flushRuntimeChange();

    expect(start).toHaveBeenCalledTimes(1);
    feature.destroy();
    expect(destroyController).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale initial read overwrite a newer runtime setting', async () => {
    let resolveInitialRead!: (value: Record<string, unknown>) => void;
    storageMocks.get.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveInitialRead = resolve;
        }),
    );
    const start = vi.fn().mockResolvedValue({ destroy: vi.fn() });

    const initializing = startSlashPromptFeature({
      pageUrl: 'https://gemini.google.com/app',
      start,
    });
    await vi.waitFor(() => expect(storageMocks.get).toHaveBeenCalledTimes(1));

    getStorageListener()(
      { [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: true, newValue: false } },
      'sync',
    );
    resolveInitialRead({ [StorageKeys.SLASH_PROMPT_ENABLED]: true });
    const feature = await initializing;

    expect(start).not.toHaveBeenCalled();
    feature.destroy();
  });

  it('destroys a controller whose runtime start finishes after feature teardown', async () => {
    storageMocks.get.mockResolvedValue({ [StorageKeys.SLASH_PROMPT_ENABLED]: false });
    let resolveStart!: (controller: { destroy: () => void }) => void;
    const pendingStart = new Promise<{ destroy: () => void }>((resolve) => {
      resolveStart = resolve;
    });
    const destroyController = vi.fn();
    const start = vi.fn(() => pendingStart);
    const feature = await startSlashPromptFeature({
      pageUrl: 'https://gemini.google.com/app',
      start,
    });

    getStorageListener()(
      { [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: false, newValue: true } },
      'sync',
    );
    feature.destroy();
    resolveStart({ destroy: destroyController });
    await flushRuntimeChange();

    expect(destroyController).toHaveBeenCalledTimes(1);
  });
});
