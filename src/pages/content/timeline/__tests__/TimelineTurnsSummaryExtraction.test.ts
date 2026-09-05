import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineTurns } from '../TimelineTurns';

function setElementTop(el: HTMLElement, top: number): void {
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true });
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 0,
    bottom: top,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('TimelineTurns summary extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('excludes cdk-visually-hidden text from marker summary', () => {
    const container = document.createElement('div');
    const turn = document.createElement('span');
    turn.className = 'user-query-bubble-with-background';
    turn.innerHTML = `
      <span class="horizontal-container">
        <div role="heading" aria-level="2" class="query-text gds-body-l" dir="ltr">
          <span class="cdk-visually-hidden">你說了</span>
          <p class="query-text-line"> 嗯嗯！ </p>
        </div>
      </span>
    `;
    setElementTop(turn, 0);
    container.appendChild(turn);

    const markers = new TimelineTurns().collect(container, '.user-query-bubble-with-background');

    expect(markers).toHaveLength(1);
    expect(markers[0]?.summary).toBe('嗯嗯！');
  });

  it('excludes .gv-fork-btn button text from marker summary', () => {
    const container = document.createElement('div');
    const turn = document.createElement('span');
    turn.className = 'user-query-bubble-with-background';
    turn.innerHTML = `
      <p class="query-text-line">Hello world</p>
      <button class="gv-fork-btn"><span>Fork</span></button>
    `;
    setElementTop(turn, 0);
    container.appendChild(turn);

    const markers = new TimelineTurns().collect(container, '.user-query-bubble-with-background');

    expect(markers).toHaveLength(1);
    expect(markers[0]?.summary).toBe('Hello world');
    expect(markers[0]?.summary).not.toContain('Fork');
  });

  it('assigns unique marker IDs to turns with identical text at different positions', () => {
    const container = document.createElement('div');

    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.innerHTML = '<p>好的，继续执行下一步</p>';
    setElementTop(first, 0);

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.innerHTML = '<p>好的，继续执行下一步</p>';
    setElementTop(second, 200);

    container.appendChild(first);
    container.appendChild(second);

    const markers = new TimelineTurns().collect(container, '.user-query-bubble-with-background');

    expect(markers).toHaveLength(2);
    expect(markers[0]?.id).not.toBe(markers[1]?.id);
    expect(markers[0]?.summary).toBe('好的，继续执行下一步');
    expect(markers[1]?.summary).toBe('好的，继续执行下一步');
  });

  it('pairs each user question with the model response before the next turn', () => {
    const container = document.createElement('div');

    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.textContent = 'Can Voyager make this interaction?';
    setElementTop(first, 0);

    const firstResponse = document.createElement('model-response');
    firstResponse.innerHTML = `
      <model-thoughts>Hidden reasoning</model-thoughts>
      <message-content>Yes. The ruler can follow the active turn smoothly.</message-content>
    `;

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.textContent = 'Will the preview include both roles?';
    setElementTop(second, 200);

    const secondResponse = document.createElement('model-response');
    secondResponse.innerHTML =
      '<message-content>Yes, with a quieter model-response style.</message-content>';

    container.append(first, firstResponse, second, secondResponse);

    const markers = new TimelineTurns().collect(container, '.user-query-bubble-with-background');

    expect(markers).toHaveLength(2);
    expect(markers[0]?.assistantSummary).toBe(
      'Yes. The ruler can follow the active turn smoothly.',
    );
    expect(markers[0]?.assistantSummary).not.toContain('Hidden reasoning');
    expect(markers[1]?.assistantSummary).toBe('Yes, with a quieter model-response style.');
  });

  it('deduplicates turns by visible text when visually-hidden labels differ', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    first.className = 'user-query-bubble-with-background';
    first.innerHTML = '<span class="cdk-visually-hidden">你說了</span><p>same content</p>';
    setElementTop(first, 0);

    const second = document.createElement('div');
    second.className = 'user-query-bubble-with-background';
    second.innerHTML = '<span class="visually-hidden">you said</span><p>same content</p>';
    setElementTop(second, 0);

    container.appendChild(first);
    container.appendChild(second);

    const markers = new TimelineTurns().collect(container, '.user-query-bubble-with-background');

    expect(markers).toHaveLength(1);
    expect(markers[0]?.summary).toBe('same content');
  });
});
