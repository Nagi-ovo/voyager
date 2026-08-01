import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WillCleanUp } from '@/core/utils/willCleanUp';

describe('willCleanUp tests module', () => {
  let willCleanUp: WillCleanUp;

  beforeEach(() => {
    willCleanUp = new WillCleanUp();
  });

  it('can store registered cleanup functions', () => {
    const function1 = () => {};
    const function2 = () => {};

    willCleanUp.it(function1);
    willCleanUp.it(function2);
    willCleanUp.it(function2); // won't store duplicate functions

    expect(willCleanUp.list()).toEqual([function1, function2]);
  });

  it('can execute registered cleanup functions at correct time', () => {
    const function1 = vi.fn();

    willCleanUp.it(function1);

    expect(function1).not.toHaveBeenCalled();

    willCleanUp.execute();

    expect(function1).toHaveBeenCalled();
    expect(function1).toHaveBeenCalledTimes(1);

    willCleanUp.execute(); // no duplicate call

    expect(function1).toHaveBeenCalledTimes(1);
  });

  it('can release stored cleanup functions at correct time', () => {
    const function1 = () => {};

    willCleanUp.it(function1);

    expect(willCleanUp.list()).not.toEqual([]);

    willCleanUp.execute();

    expect(willCleanUp.list()).toEqual([]);
  });
});
