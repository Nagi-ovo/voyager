import { describe, expect, it } from 'vitest';

import { StarSnapshotLoader } from './starSnapshot';

describe('star snapshot generation', () => {
  it('invalidates an older read even for the same conversation', () => {
    const loader = new StarSnapshotLoader();
    const old = loader.begin(() => true);
    const current = loader.begin(() => true);
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });

  it('invalidates a read when its route or lifecycle expires', () => {
    let active = true;
    const current = new StarSnapshotLoader().begin(() => active);
    expect(current()).toBe(true);
    active = false;
    expect(current()).toBe(false);
  });
});
