import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  type PromptManagerInstance,
  createCustomSiteCoverageReconciler,
} from '../customSiteCoverage';

const HOST = 'localhost:3000';

const change = (websites: unknown): Record<string, chrome.storage.StorageChange> => ({
  [StorageKeys.PROMPT_CUSTOM_WEBSITES]: { newValue: websites } as chrome.storage.StorageChange,
});

describe('custom site coverage reconciler', () => {
  let destroyed: number;
  let started: number;

  const instance = (): PromptManagerInstance => ({
    destroy: () => {
      destroyed += 1;
    },
  });

  // Async, so mounting always crosses an await — that suspension point is the
  // window every ordering hazard here lives in.
  const start = vi.fn(async (): Promise<PromptManagerInstance> => {
    started += 1;
    return instance();
  });

  /** Lets the queue run to completion, however many steps it needs. */
  const flush = async (coverage: { settled: () => Promise<void> }): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await coverage.settled();
  };

  beforeEach(() => {
    destroyed = 0;
    started = 0;
    start.mockClear();
  });

  it('destroys the instance when the site is removed and mounts it again when re-added', async () => {
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start, initial: instance() });

    coverage.handleChange(change([]), 'sync');
    await flush(coverage);
    expect(destroyed).toBe(1);
    expect(started).toBe(0);

    coverage.handleChange(change([HOST]), 'sync');
    await flush(coverage);
    expect(started).toBe(1);
    expect(destroyed).toBe(1);
  });

  it('does not leak an instance when events arrive while a mount is in flight', async () => {
    // Starts uncovered, so every mount goes through the awaited start() — that
    // await is the window the queue exists to close.
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start, initial: null });

    // on → off → on, all before the first start() resolves. Unserialized, the
    // off-event reads `instance === null` (the first mount has not landed yet),
    // decides there is nothing to tear down, and returns; the second on-event
    // then reads the same stale null and mounts again — two live Prompt
    // Managers, one of them unreachable.
    coverage.handleChange(change([HOST]), 'sync');
    coverage.handleChange(change([]), 'sync');
    coverage.handleChange(change([HOST]), 'sync');
    await flush(coverage);

    // Mounted, torn down, mounted again — never two at once.
    expect(started).toBe(2);
    expect(destroyed).toBe(1);

    // Exactly one live instance is left, so teardown destroys exactly once more.
    coverage.destroy();
    expect(destroyed).toBe(2);
  });

  it('ignores a change that leaves coverage unchanged', async () => {
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start, initial: instance() });

    coverage.handleChange(change([HOST, 'example.com']), 'sync');
    await flush(coverage);

    expect(started).toBe(0);
    expect(destroyed).toBe(0);
  });

  it('ignores local-area writes and unrelated keys', async () => {
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start, initial: instance() });

    coverage.handleChange(change([]), 'local');
    coverage.handleChange({ gvSomethingElse: { newValue: [] } }, 'sync');
    await flush(coverage);

    expect(destroyed).toBe(0);
    expect(started).toBe(0);
  });

  it('queues a toggle-off that lands while the startup mount is in flight', async () => {
    let release!: (instance: PromptManagerInstance) => void;
    const pending = new Promise<PromptManagerInstance>((resolve) => {
      release = resolve;
    });
    const slowStart = vi.fn(() => pending);
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start: slowStart });
    coverage.applyInitial(true);
    // The user switches the site off before the first mount resolves.
    coverage.handleChange(change([]), 'sync');
    release(instance());
    await flush(coverage);
    expect(slowStart).toHaveBeenCalledTimes(1);
    expect(destroyed).toBe(1);
    // Nothing stays mounted: a later re-add mounts again.
    coverage.handleChange(change([HOST]), 'sync');
    await flush(coverage);
    expect(slowStart).toHaveBeenCalledTimes(2);
  });

  it('tears down a mount that resolves after destroy() and ignores later applies', async () => {
    let release!: (instance: PromptManagerInstance) => void;
    const pending = new Promise<PromptManagerInstance>((resolve) => {
      release = resolve;
    });
    const slowStart = vi.fn(() => pending);
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start: slowStart });
    coverage.applyInitial(true);
    await vi.waitFor(() => expect(slowStart).toHaveBeenCalledTimes(1));
    // The plugin is torn down while the startup mount is still in flight.
    coverage.destroy();
    release(instance());
    await flush(coverage);
    expect(destroyed).toBe(1);
    // Nothing mounts after teardown.
    coverage.handleChange(change([HOST]), 'sync');
    await flush(coverage);
    expect(slowStart).toHaveBeenCalledTimes(1);
  });

  it('ignores a startup read that is older than a change already handled', async () => {
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start });
    coverage.handleChange(change([]), 'sync');
    await flush(coverage);
    // The pre-subscription read said "covered", but the listener already saw the removal.
    coverage.applyInitial(true);
    await flush(coverage);
    expect(started).toBe(0);
  });

  it('does not destroy twice when teardown follows a removal', async () => {
    const coverage = createCustomSiteCoverageReconciler({ host: HOST, start, initial: instance() });

    coverage.handleChange(change([]), 'sync');
    await flush(coverage);
    expect(destroyed).toBe(1);

    coverage.destroy();
    expect(destroyed).toBe(1);
  });
});
