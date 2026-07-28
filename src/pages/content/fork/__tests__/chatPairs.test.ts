import { describe, expect, it } from 'vitest';

import { collectForkChatPairs } from '../chatPairs';

describe('collectForkChatPairs', () => {
  it('should collect user and assistant pairs from chat DOM', () => {
    document.body.innerHTML = `
      <main>
        <div class="user-query-container">
          <div class="user-query-bubble-with-background">user-1</div>
        </div>
        <div class="response-container">
          <div class="markdown-main-panel">assistant-1</div>
        </div>
        <div class="user-query-container">
          <div class="user-query-bubble-with-background">user-2</div>
        </div>
        <div class="response-container">
          <div class="markdown-main-panel">assistant-2</div>
        </div>
      </main>
    `;

    const userContainers = document.querySelectorAll<HTMLElement>('.user-query-container');
    const responseContainers = document.querySelectorAll<HTMLElement>('.response-container');
    Object.defineProperty(userContainers[0], 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(responseContainers[0], 'offsetTop', { value: 100, configurable: true });
    Object.defineProperty(userContainers[1], 'offsetTop', { value: 200, configurable: true });
    Object.defineProperty(responseContainers[1], 'offsetTop', { value: 300, configurable: true });

    const pairs = collectForkChatPairs();
    expect(pairs).toHaveLength(2);
    expect(pairs[0].user).toContain('user-1');
    expect(pairs[0].assistant).toContain('assistant-1');
    expect(pairs[1].user).toContain('user-2');
    expect(pairs[1].assistant).toContain('assistant-2');
    expect(pairs[0].turnId).toBe('u-0');
    expect(pairs[1].turnId).toBe('u-1');
  });

  it('keeps response ids stable when only a tail window is mounted', () => {
    document.body.innerHTML = `
      <main>
        <div class="conversation-container" id="6060606060606060">
          <div class="user-query-container">mounted turn 60</div>
          <div class="response-container">answer 60</div>
        </div>
        <div class="conversation-container" id="6161616161616161">
          <div class="user-query-container">mounted turn 61</div>
          <div class="response-container">answer 61</div>
        </div>
      </main>
    `;
    const positioned = document.querySelectorAll<HTMLElement>(
      '.user-query-container, .response-container',
    );
    positioned.forEach((element, index) => {
      Object.defineProperty(element, 'offsetTop', { value: index * 100, configurable: true });
    });

    const firstWindow = collectForkChatPairs().map((pair) => pair.turnId);
    document.querySelector('.conversation-container')?.remove();
    const remountedTail = collectForkChatPairs().map((pair) => pair.turnId);

    expect(firstWindow).toEqual(['s-6060606060606060', 's-6161616161616161']);
    expect(remountedTail).toEqual(['s-6161616161616161']);
  });
});
