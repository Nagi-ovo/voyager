import { afterEach, describe, expect, it } from 'vitest';

import { resolveUniqueExportTurnIds } from '../selectionIds';

function createTurn(id: string, text: string): HTMLElement {
  const element = document.createElement('span');
  element.dataset.turnId = id;
  element.textContent = text;
  document.body.appendChild(element);
  return element;
}

describe('export selection turn ids', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('repairs ids repeated by lazy-loaded history batches', () => {
    const elements = Array.from({ length: 71 }, (_, index) =>
      createTurn(`u-${index % 10}`, `turn ${index}`),
    );

    const ids = resolveUniqueExportTurnIds(elements);

    expect(new Set(ids).size).toBe(elements.length);
    expect(ids[0]).toBe('u-0');
    expect(ids[1]).toBe('u-1');
    expect(ids[10]).not.toBe('u-0');
    expect(ids[11]).not.toBe('u-1');
  });

  it('preserves the selected owner when an older batch reuses its ids', () => {
    const older = createTurn('u-0', 'older message');
    const selected = createTurn('u-0', 'currently selected message');
    const selector = document.createElement('div');
    selector.className = 'gv-export-msg-selector';
    selector.dataset.gvExportMessageId = 'u-0:u';
    selected.appendChild(selector);

    const ids = resolveUniqueExportTurnIds([older, selected]);

    expect(ids[1]).toBe('u-0');
    expect(ids[0]).not.toBe('u-0');
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps generated ids deterministic for rerendered turns', () => {
    const first = document.createElement('span');
    first.textContent = 'same turn after rerender';
    const replacement = document.createElement('span');
    replacement.textContent = 'same turn after rerender';

    expect(resolveUniqueExportTurnIds([first])).toEqual(resolveUniqueExportTurnIds([replacement]));
  });

  it('prefers Gemini response ids over stale positional datasets', () => {
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.id = 'b6eb23222c6b10a2';
    const turn = createTurn('u-0', 'mounted tail turn');
    container.appendChild(turn);
    document.body.appendChild(container);

    expect(resolveUniqueExportTurnIds([turn])).toEqual(['s-b6eb23222c6b10a2']);
  });
});
