import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineTurns } from '../TimelineTurns';

function makeTurn(html: string): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'user-query-bubble-with-background';
  turn.innerHTML = html;
  document.body.appendChild(turn);
  return turn;
}

describe('TimelineTurns turn-text cache (issue #753 follow-up)', () => {
  let turns: TimelineTurns;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    turns = new TimelineTurns();
  });

  it('computes the summary once for unchanged content', () => {
    const turn = makeTurn('<p class="query-text-line">Hello cache</p>');
    const extractSpy = vi.spyOn(turn, 'cloneNode');

    expect(turns.getTurnTextCached(turn)).toBe('Hello cache');
    expect(turns.getTurnTextCached(turn)).toBe('Hello cache');
    expect(turns.getTurnTextCached(turn)).toBe('Hello cache');

    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the turn content changes in place', () => {
    const turn = makeTurn('<p class="query-text-line">Before edit</p>');
    const extractSpy = vi.spyOn(turn, 'cloneNode');

    expect(turns.getTurnTextCached(turn)).toBe('Before edit');

    turn.querySelector('p')!.textContent = 'After edit';

    expect(turns.getTurnTextCached(turn)).toBe('After edit');
    expect(extractSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when extension UI is injected into the turn after first extraction', () => {
    const turn = makeTurn('<p class="query-text-line">Stable text</p>');

    expect(turns.getTurnTextCached(turn)).toBe('Stable text');

    // A late-injected fork button changes raw textContent (invalidates the
    // cache) but must stay excluded from the recomputed summary.
    const fork = document.createElement('button');
    fork.className = 'gv-fork-btn';
    fork.textContent = 'Fork';
    turn.appendChild(fork);

    expect(turns.getTurnTextCached(turn)).toBe('Stable text');
  });

  it('keeps the cached summary clean of visually-hidden text', () => {
    const turn = makeTurn(
      '<span class="cdk-visually-hidden">You said</span><p class="query-text-line">Visible only</p>',
    );

    expect(turns.getTurnTextCached(turn)).toBe('Visible only');
    expect(turns.getTurnTextCached(turn)).toBe('Visible only');
  });

  it('returns empty string for null elements', () => {
    expect(turns.getTurnTextCached(null)).toBe('');
  });
});
