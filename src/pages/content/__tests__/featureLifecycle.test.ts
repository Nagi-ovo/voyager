import { describe, expect, it, vi } from 'vitest';

import { CleanupPositions } from '@/core/types/cleanupPositions';
import { CleanupManager } from '@/core/utils/cleanupManager';

import {
  createNativeFeatureToggle,
  mountNativeFeature,
  type NativeFeature,
} from '../featureLifecycle';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function feature(start: NativeFeature['start']): NativeFeature {
  return {
    id: 'probe',
    position: CleanupPositions.CleanupFork,
    start,
    toggle: { key: 'gvProbe', isEnabled: (value) => value === true },
  };
}

describe('mountNativeFeature', () => {
  it('registers the stop at the feature position so page teardown runs it', async () => {
    const manager = new CleanupManager();
    const stop = vi.fn();
    await mountNativeFeature(
      manager,
      feature(() => stop),
    );

    expect(manager.list()).toEqual([{ pos: CleanupPositions.CleanupFork, func: stop }]);
    manager.executeCleanups();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('createNativeFeatureToggle', () => {
  it('mounts on enable and stops, withdrawing the cleanup, on disable', async () => {
    const manager = new CleanupManager();
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const toggle = createNativeFeatureToggle(manager, feature(start));

    await toggle.applyInitial(true);
    expect(start).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(true);

    toggle.handleChange({ gvProbe: { newValue: false } }, 'sync');
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('withdraws the cleanup even when stop throws, so teardown and re-enable do not double up', async () => {
    const manager = new CleanupManager();
    const throwingStop = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    const nextStop = vi.fn();
    const start = vi
      .fn<() => () => void>()
      .mockReturnValueOnce(throwingStop)
      .mockReturnValue(nextStop);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const toggle = createNativeFeatureToggle(manager, feature(start));

    await toggle.applyInitial(true);
    toggle.handleChange({ gvProbe: { newValue: false } }, 'sync');
    await drain();
    expect(throwingStop).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(false);
    expect(manager.list()).toEqual([]);
    // An invalidated context is routine on extension reload: no error log.
    expect(consoleError).not.toHaveBeenCalled();

    toggle.handleChange({ gvProbe: { newValue: true } }, 'sync');
    await drain();
    expect(start).toHaveBeenCalledTimes(2);
    expect(manager.list()).toEqual([{ pos: CleanupPositions.CleanupFork, func: nextStop }]);

    manager.executeCleanups();
    expect(throwingStop).toHaveBeenCalledOnce();
    expect(nextStop).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('ignores other keys and non-storage areas, and does not start twice', async () => {
    const start = vi.fn(() => () => {});
    const toggle = createNativeFeatureToggle(new CleanupManager(), feature(start));

    await toggle.applyInitial(true);
    toggle.handleChange({ gvOther: { newValue: false } }, 'sync');
    toggle.handleChange({ gvProbe: { newValue: false } }, 'session');
    toggle.handleChange({ gvProbe: { newValue: true } }, 'local');
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(true);
  });

  it('applies a toggle that lands during an asynchronous start after it settles', async () => {
    const pending = deferred<() => void>();
    const stop = vi.fn();
    const start = vi.fn(() => pending.promise);
    const toggle = createNativeFeatureToggle(new CleanupManager(), feature(start));

    const initial = toggle.applyInitial(true);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    toggle.handleChange({ gvProbe: { newValue: false } }, 'sync');
    expect(stop).not.toHaveBeenCalled();

    pending.resolve(stop);
    await initial;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    expect(start).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(false);
  });

  it('coalesces opposite requests that arrive before the first one runs', async () => {
    const start = vi.fn(() => () => {});
    const toggle = createNativeFeatureToggle(new CleanupManager(), feature(start));

    const initial = toggle.applyInitial(true);
    toggle.handleChange({ gvProbe: { newValue: false } }, 'sync');
    await initial;
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(toggle.isMounted()).toBe(false);
  });

  it('lets a change that arrived before the startup read override the stale value', async () => {
    const start = vi.fn(() => () => {});
    const toggle = createNativeFeatureToggle(new CleanupManager(), feature(start));

    toggle.handleChange({ gvProbe: { newValue: true } }, 'sync');
    await toggle.applyInitial(false);

    expect(start).toHaveBeenCalledOnce();
    expect(toggle.isMounted()).toBe(true);
  });

  it('refuses a feature without a toggle', () => {
    expect(() =>
      createNativeFeatureToggle(new CleanupManager(), {
        id: 'plain',
        position: CleanupPositions.CleanupFork,
        start: () => () => {},
      }),
    ).toThrow(/needs a toggle/);
  });
});
