import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CleanupManager } from '@/core/utils/cleanupManager';

describe('willCleanUp tests module', () => {
  let cleanupManager: CleanupManager;

  beforeEach(() => {
    cleanupManager = new CleanupManager();
  });

  it('can store registered cleanup functions', () => {
    const function1 = () => {};
    const function2 = () => {};

    cleanupManager.registerCleanupFunction(function1);
    cleanupManager.registerCleanupFunction(function2);
    cleanupManager.registerCleanupFunction(function2); // won't store duplicate functions

    expect(cleanupManager.list()).toEqual([function1, function2]);
  });

  it('can execute registered cleanup functions at correct time', () => {
    const function1 = vi.fn();

    cleanupManager.registerCleanupFunction(function1);

    expect(function1).not.toHaveBeenCalled();

    cleanupManager.executeCleanups();

    expect(function1).toHaveBeenCalled();
    expect(function1).toHaveBeenCalledTimes(1);

    cleanupManager.executeCleanups(); // no duplicate call

    expect(function1).toHaveBeenCalledTimes(1);
  });

  it('can release stored cleanup functions at correct time', () => {
    const function1 = () => {};

    cleanupManager.registerCleanupFunction(function1);

    expect(cleanupManager.list()).not.toEqual([]);

    cleanupManager.executeCleanups();

    expect(cleanupManager.list()).toEqual([]);
  });

  it('can safely handle cleanup functions that throws an error', () => {
    const function1 = () => {
      throw Error();
    };
    const function2 = vi.fn();

    cleanupManager.registerCleanupFunction(function1);
    cleanupManager.registerCleanupFunction(function2);

    cleanupManager.executeCleanups();

    expect(function2).toHaveBeenCalled();
    expect(function2).toHaveBeenCalledTimes(1);
    expect(cleanupManager.list()).toEqual([]);
  });
});
