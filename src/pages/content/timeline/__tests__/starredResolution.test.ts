import { describe, expect, it } from 'vitest';

import { resolveStarredDisplay } from '../starredResolution';

function marker(id: string) {
  return { id };
}

describe('resolveStarredDisplay', () => {
  it('paints a server-id star directly', () => {
    const result = resolveStarredDisplay({
      markers: [marker('s-first'), marker('s-second')],
      starredIds: new Set(['s-first']),
      resolveCanonicalId: (id) => id,
    });

    expect(result.displayByMarkerId.get('s-first')).toBe(true);
    expect(result.displayByMarkerId.get('s-second')).toBe(false);
    expect(result.storageIdsByMarkerId.get('s-first')).toEqual(['s-first']);
  });

  it('uses a verified legacy alias from the complete history map', () => {
    const aliases = new Map([['u-0', 's-first']]);
    const result = resolveStarredDisplay({
      markers: [marker('s-first'), marker('s-second')],
      starredIds: new Set(['u-0']),
      resolveCanonicalId: (id) => aliases.get(id) ?? id,
    });

    expect(result.displayByMarkerId.get('s-first')).toBe(true);
    expect(result.storageIdsByMarkerId.get('s-first')).toEqual(['u-0']);
  });

  it('suppresses a legacy star when no complete history map exists (#871)', () => {
    const result = resolveStarredDisplay({
      markers: [marker('s-tail-60'), marker('s-tail-61')],
      starredIds: new Set(['u-0']),
      resolveCanonicalId: () => null,
    });

    expect(result.displayByMarkerId.get('s-tail-60')).toBe(false);
    expect(result.displayByMarkerId.get('s-tail-61')).toBe(false);
    expect(result.storageIdsByMarkerId.size).toBe(0);
  });

  it('does not inspect prompt text, so duplicate prompts cannot collide', () => {
    const result = resolveStarredDisplay({
      markers: [marker('s-old-continue'), marker('s-new-continue')],
      starredIds: new Set(['u-0']),
      resolveCanonicalId: (id) => (id === 'u-0' ? 's-old-continue' : null),
    });

    expect(result.displayByMarkerId.get('s-old-continue')).toBe(true);
    expect(result.displayByMarkerId.get('s-new-continue')).toBe(false);
  });

  it('tracks duplicate stable and legacy records for safe removal', () => {
    const result = resolveStarredDisplay({
      markers: [marker('s-first')],
      starredIds: new Set(['s-first', 'u-0']),
      resolveCanonicalId: (id) => (id === 'u-0' ? 's-first' : id),
    });

    expect(result.storageIdsByMarkerId.get('s-first')).toEqual(['s-first', 'u-0']);
  });

  it('does nothing when there are no markers', () => {
    const result = resolveStarredDisplay({
      markers: [],
      starredIds: new Set(['s-first']),
      resolveCanonicalId: (id) => id,
    });
    expect(result.displayByMarkerId.size).toBe(0);
    expect(result.storageIdsByMarkerId.size).toBe(0);
  });
});
