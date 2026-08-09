import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import type { FormulaCopyLifecycleService } from './nativeFeature';
import { startNativeFormulaCopy } from './nativeFeature';

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
      sync: { get: storageMocks.get },
      onChanged: {
        addListener: storageMocks.addListener,
        removeListener: storageMocks.removeListener,
      },
    },
  },
}));

function createService(): FormulaCopyLifecycleService & {
  prepare: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  let initialized = false;
  return {
    prepare: vi.fn(async () => {}),
    initialize: vi.fn(() => {
      initialized = true;
    }),
    destroy: vi.fn(() => {
      initialized = false;
    }),
    isServiceInitialized: () => initialized,
  };
}

function getStorageListener(): StorageChangeListener {
  const listener = storageMocks.addListener.mock.calls.at(-1)?.[0] as
    | StorageChangeListener
    | undefined;
  expect(listener).toBeTypeOf('function');
  return listener!;
}

describe('native formula copy lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.get.mockResolvedValue({ [StorageKeys.FORMULA_COPY_ENABLED]: true });
  });

  it('treats a missing setting as enabled and cleans up exactly once', async () => {
    storageMocks.get.mockResolvedValue({});
    const service = createService();

    const controller = await startNativeFormulaCopy({ service });
    const listener = getStorageListener();

    expect(storageMocks.get).toHaveBeenCalledWith({
      [StorageKeys.FORMULA_COPY_ENABLED]: true,
    });
    expect(service.prepare).toHaveBeenCalledTimes(1);
    expect(service.initialize).toHaveBeenCalledTimes(1);

    controller.destroy();
    controller.destroy();

    expect(storageMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(storageMocks.removeListener).toHaveBeenCalledWith(listener);
    expect(service.destroy).toHaveBeenCalledTimes(1);
  });

  it('stays inactive when the stored setting is false', async () => {
    storageMocks.get.mockResolvedValue({ [StorageKeys.FORMULA_COPY_ENABLED]: false });
    const service = createService();

    const controller = await startNativeFormulaCopy({ service });

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.destroy).not.toHaveBeenCalled();
    controller.destroy();
    expect(service.destroy).not.toHaveBeenCalled();
  });

  it('applies on, off, and removed-key changes immediately', async () => {
    const service = createService();
    const controller = await startNativeFormulaCopy({ service });
    const listener = getStorageListener();

    listener({ [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: true, newValue: false } }, 'sync');
    expect(service.destroy).toHaveBeenCalledTimes(1);

    listener({ [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: false, newValue: true } }, 'sync');
    expect(service.initialize).toHaveBeenCalledTimes(2);

    listener(
      { [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: true, newValue: undefined } },
      'sync',
    );
    expect(service.initialize).toHaveBeenCalledTimes(2);

    listener({ [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: true, newValue: false } }, 'local');
    listener({ unrelated: { oldValue: true, newValue: false } }, 'sync');
    expect(service.destroy).toHaveBeenCalledTimes(1);

    controller.destroy();
    expect(service.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale initial read override a newer runtime setting', async () => {
    let resolveInitialRead!: (value: Record<string, unknown>) => void;
    storageMocks.get.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveInitialRead = resolve;
        }),
    );
    const service = createService();

    const initializing = startNativeFormulaCopy({ service });
    await vi.waitFor(() => expect(storageMocks.get).toHaveBeenCalledTimes(1));
    getStorageListener()(
      { [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: true, newValue: false } },
      'sync',
    );
    resolveInitialRead({ [StorageKeys.FORMULA_COPY_ENABLED]: true });

    const controller = await initializing;
    expect(service.initialize).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('does not enable click handling until the current format is prepared', async () => {
    let resolvePrepare!: () => void;
    const service = createService();
    service.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );

    const initializing = startNativeFormulaCopy({ service });
    await Promise.resolve();
    expect(service.initialize).not.toHaveBeenCalled();
    expect(storageMocks.get).not.toHaveBeenCalled();

    resolvePrepare();
    const controller = await initializing;
    expect(service.initialize).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('queues a runtime off change received while format preparation is pending', async () => {
    let resolvePrepare!: () => void;
    const service = createService();
    service.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );

    const initializing = startNativeFormulaCopy({ service });
    await Promise.resolve();
    getStorageListener()(
      { [StorageKeys.FORMULA_COPY_ENABLED]: { oldValue: true, newValue: false } },
      'sync',
    );
    resolvePrepare();

    const controller = await initializing;
    expect(service.initialize).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('always disposes the service when listener removal throws', async () => {
    const baseService = createService();
    const dispose = vi.fn();
    const service = { ...baseService, dispose };
    const controller = await startNativeFormulaCopy({ service });
    storageMocks.removeListener.mockImplementationOnce(() => {
      throw new Error('extension context invalidated');
    });

    expect(() => controller.destroy()).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rolls back a partially-started controller when preparation fails', async () => {
    const baseService = createService();
    const dispose = vi.fn();
    baseService.prepare.mockRejectedValueOnce(new Error('format storage unavailable'));
    const service = { ...baseService, dispose };

    await expect(startNativeFormulaCopy({ service })).rejects.toThrow('format storage unavailable');

    expect(storageMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
