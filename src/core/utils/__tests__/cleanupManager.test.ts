import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CleanupManager } from '@/core/utils/cleanupManager';

enum Sequence {
  First,
  Second,
  Third,
}

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

    expect(cleanupManager.list()).toEqual([
      {
        pos: -1,
        func: function1,
      },
      {
        pos: -1,
        func: function2,
      },
    ]);
  });

  it('can return registered functions as-is', () => {
    const function1 = () => {};

    expect(cleanupManager.registerCleanupFunctionAndReturnIt(function1)).toBe(function1);
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

    expect(() => cleanupManager.executeCleanups()).toThrow();

    expect(function2).toHaveBeenCalled();
    expect(function2).toHaveBeenCalledTimes(1);
    expect(cleanupManager.list()).toEqual([]);
  });

  it('can identify cleanup functions that throws falsy error', () => {
    const function1 = () => {
      throw undefined;
    };

    const errorSpy = vi.fn();

    cleanupManager.registerCleanupFunction(function1);

    try {
      cleanupManager.executeCleanups();
    } catch (error) {
      errorSpy(error);
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenLastCalledWith(undefined);
  });

  it('can call functions in correct sequence', () => {
    const function1 = vi.fn();
    const function2 = vi.fn();
    const function3 = vi.fn();

    cleanupManager.registerCleanupFunction(function3, Sequence.Third);
    cleanupManager.registerCleanupFunction(function2, Sequence.Second);
    cleanupManager.registerCleanupFunction(function1, Sequence.First);

    cleanupManager.executeCleanups();

    expect(function2).toHaveBeenCalledAfter(function1);
    expect(function3).toHaveBeenCalledAfter(function2);
  });

  it('can withdraw functions by position number', () => {
    const function1 = vi.fn();
    const function2 = vi.fn();
    const function3 = vi.fn();

    cleanupManager.registerCleanupFunction(function3, Sequence.Third);
    cleanupManager.registerCleanupFunction(function2, Sequence.Second);
    cleanupManager.registerCleanupFunction(function1, Sequence.First);

    cleanupManager.withdrawCleanupFunctionsByPositionNumber(Sequence.Second);

    expect(cleanupManager.list().some((cleanups) => cleanups.func === function1)).toBe(true);
    expect(cleanupManager.list().some((cleanups) => cleanups.func === function2)).toBe(false);
    expect(cleanupManager.list().some((cleanups) => cleanups.func === function3)).toBe(true);
  });
});
