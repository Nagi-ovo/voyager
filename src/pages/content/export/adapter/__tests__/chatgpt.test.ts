import { describe, expect, it } from 'vitest';

import { chatgptCollectTurnContainers } from '../chatgpt';

describe('chatgptCollectTurnContainers', () => {
  it('keeps only the first container for each stable turn id', () => {
    document.body.innerHTML = `
      <div data-turn-id-container="user-1">
        <div data-message-author-role="user">你好</div>
      </div>
      <div data-turn-id-container="user-1">
        <div data-message-author-role="user">你好</div>
      </div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">你好！</div>
      </div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">你好！</div>
      </div>
    `;

    const turns = chatgptCollectTurnContainers();

    expect(turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-1']);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns.map((turn) => turn.sequence)).toEqual([0, 1]);
  });

  it('uses a mounted duplicate when the first container is an empty virtualized shell', () => {
    document.body.innerHTML = `
      <div data-turn-id-container="assistant-1"></div>
      <div data-turn-id-container="assistant-1">
        <div data-message-author-role="assistant">已加载回复</div>
      </div>
    `;

    const [turn] = chatgptCollectTurnContainers();

    expect(turn.role).toBe('assistant');
    expect(turn.container.textContent).toContain('已加载回复');
    expect(turn.sequence).toBe(0);
  });
});
