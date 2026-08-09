import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { activateFormulaCopy, getFormulaCopyService, stopFormulaCopy } from './index';

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

describe('formula copy plugin lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.get.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getFormulaCopyService().dispose();
  });

  it('initializes on activate and destroys on scope disposal', async () => {
    const scope = new PluginScope();
    activateFormulaCopy(scope);
    await vi.waitFor(() => expect(getFormulaCopyService().isServiceInitialized()).toBe(true));
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(true);
    expect(storageMocks.addListener).toHaveBeenCalledTimes(1);

    await scope.dispose();
    expect(getFormulaCopyService().isServiceInitialized()).toBe(false);
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(false);
    expect(storageMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(storageMocks.removeListener).toHaveBeenCalledWith(
      storageMocks.addListener.mock.calls[0]?.[0],
    );
  });

  it('does not let an older pending scope dispose a rapid remount', async () => {
    const service = getFormulaCopyService();
    // Establish the long-lived format listener, then control only the two
    // activation barriers involved in this remount race.
    await service.prepare();
    let resolveOldPrepare!: () => void;
    const prepareSpy = vi
      .spyOn(service, 'prepare')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldPrepare = resolve;
          }),
      )
      .mockResolvedValueOnce();

    const oldScope = new PluginScope();
    activateFormulaCopy(oldScope);
    await Promise.resolve();
    const oldDisposal = oldScope.dispose();

    const newScope = new PluginScope();
    activateFormulaCopy(newScope);
    await vi.waitFor(() => expect(service.isServiceInitialized()).toBe(true));

    resolveOldPrepare();
    await oldDisposal;
    expect(service.isServiceInitialized()).toBe(true);
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(true);
    expect(storageMocks.removeListener).not.toHaveBeenCalled();

    await newScope.dispose();
    expect(service.isServiceInitialized()).toBe(false);
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(false);
    expect(storageMocks.removeListener).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledTimes(2);
    prepareSpy.mockRestore();
  });

  it('does not activate after an explicit stop during pending preparation', async () => {
    const service = getFormulaCopyService();
    const initializeSpy = vi.spyOn(service, 'initialize');
    let resolvePrepare!: () => void;
    const prepareSpy = vi.spyOn(service, 'prepare').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const scope = new PluginScope();
    activateFormulaCopy(scope);
    await Promise.resolve();

    stopFormulaCopy();
    resolvePrepare();
    await scope.dispose();

    expect(service.isServiceInitialized()).toBe(false);
    expect(initializeSpy).not.toHaveBeenCalled();
    prepareSpy.mockRestore();
  });
});
