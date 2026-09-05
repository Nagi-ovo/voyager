import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineTurns } from '../TimelineTurns';

describe('TimelineTurns top-level turn filtering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('removes nested matches regardless of input order and preserves top-level order', () => {
    const firstTopLevel = document.createElement('div');
    const nested = document.createElement('div');
    const deeplyNested = document.createElement('div');
    firstTopLevel.appendChild(nested);
    nested.appendChild(deeplyNested);

    const secondTopLevel = document.createElement('div');
    const secondNested = document.createElement('div');
    secondTopLevel.appendChild(secondNested);
    document.body.append(firstTopLevel, secondTopLevel);

    const manager = new TimelineTurns();
    expect(
      manager.filterTopLevel([deeplyNested, secondTopLevel, nested, firstTopLevel, secondNested]),
    ).toEqual([secondTopLevel, firstTopLevel]);
  });

  it('keeps sibling matches that only share a non-matching ancestor', () => {
    const wrapper = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    wrapper.append(first, second);
    document.body.appendChild(wrapper);

    const manager = new TimelineTurns();
    expect(manager.filterTopLevel([first, second])).toEqual([first, second]);
  });

  it('does not perform pairwise contains checks for large flat lists', () => {
    const elements = Array.from({ length: 1_000 }, () => {
      const element = document.createElement('div');
      document.body.appendChild(element);
      return element;
    });
    const contains = vi.spyOn(Node.prototype, 'contains');

    const manager = new TimelineTurns();
    expect(manager.filterTopLevel(elements)).toEqual(elements);
    expect(contains).not.toHaveBeenCalled();
  });
});
