import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { activateFormulaCopy, getFormulaCopyService, stopFormulaCopy } from './index';

describe('formula copy plugin lifecycle', () => {
  afterEach(() => {
    getFormulaCopyService().dispose();
  });

  it('initializes on activate and destroys on scope disposal', async () => {
    const scope = new PluginScope();
    activateFormulaCopy(scope);
    await vi.waitFor(() => expect(getFormulaCopyService().isServiceInitialized()).toBe(true));
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(true);

    await scope.dispose();
    expect(getFormulaCopyService().isServiceInitialized()).toBe(false);
    expect(document.documentElement.classList.contains('gv-formula-copy-enabled')).toBe(false);
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

    await newScope.dispose();
    expect(service.isServiceInitialized()).toBe(false);
    prepareSpy.mockRestore();
  });

  it('does not activate after an explicit stop during pending preparation', async () => {
    const service = getFormulaCopyService();
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
    prepareSpy.mockRestore();
  });
});
