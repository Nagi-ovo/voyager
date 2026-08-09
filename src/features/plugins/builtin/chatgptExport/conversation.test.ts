import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildChatTurns,
  buildConversationMetadata,
  collectChatGptConversation,
  collectMountedChatGptMessages,
} from './conversation';

function turn(index: number, id: string, role: 'user' | 'assistant', text: string): HTMLElement {
  const section = document.createElement('section');
  section.dataset.testid = `conversation-turn-${index}`;
  const message = document.createElement('div');
  message.dataset.messageAuthorRole = role;
  message.dataset.messageId = id;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  message.appendChild(paragraph);
  section.appendChild(message);
  return section;
}

afterEach(() => {
  document.body.replaceChildren();
  document.title = '';
  vi.restoreAllMocks();
});

describe('ChatGPT conversation snapshots', () => {
  it('uses stable ids, document order, detached clones, and excludes action text', () => {
    const first = turn(0, 'message-user', 'user', 'Hello');
    const button = document.createElement('button');
    button.textContent = 'Copy';
    first.querySelector('[data-message-author-role]')?.appendChild(button);
    document.body.append(first, turn(1, 'message-assistant', 'assistant', 'Hi there'));

    const messages = collectMountedChatGptMessages();

    expect(messages.map(({ id, role, text }) => ({ id, role, text }))).toEqual([
      { id: 'message-user', role: 'user', text: 'Hello' },
      { id: 'message-assistant', role: 'assistant', text: 'Hi there' },
    ]);
    expect(messages[0].element.isConnected).toBe(false);
    first.querySelector('p')!.textContent = 'Changed later';
    expect(messages[0].element.textContent).toContain('Hello');
  });

  it('pairs adjacent user/assistant messages and preserves assistant-only selections', () => {
    document.body.append(
      turn(0, 'u-1', 'user', 'Question'),
      turn(1, 'a-1', 'assistant', 'Answer'),
      turn(2, 'a-2', 'assistant', 'Selected answer only'),
    );
    const messages = collectMountedChatGptMessages();

    const turns = buildChatTurns(messages);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ user: 'Question', assistant: 'Answer' });
    expect(turns[1]).toMatchObject({ user: '', assistant: 'Selected answer only' });
    expect(turns[1].omitEmptySections).toBe(true);
  });

  it('walks a virtualised scroll window and restores the original position', async () => {
    const scroller = document.createElement('main');
    scroller.style.overflowY = 'auto';
    let currentTop = 500;
    const render = (): void => {
      scroller.replaceChildren(
        ...(currentTop < 300
          ? [turn(0, 'u-1', 'user', 'Top question'), turn(1, 'a-1', 'assistant', 'Top answer')]
          : [
              turn(2, 'u-2', 'user', 'Bottom question'),
              turn(3, 'a-2', 'assistant', 'Bottom answer'),
            ]),
      );
    };
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: {
        configurable: true,
        get: () => currentTop,
        set: (value: number) => {
          currentTop = value;
          render();
        },
      },
    });
    render();
    document.body.appendChild(scroller);
    const progress = vi.fn();

    const messages = await collectChatGptConversation({
      signal: new AbortController().signal,
      settleMs: 0,
      onProgress: progress,
    });

    expect(messages.map((message) => message.id)).toEqual(['u-1', 'a-1', 'u-2', 'a-2']);
    expect(currentTop).toBe(500);
    expect(progress).toHaveBeenCalled();
  });

  it('builds ChatGPT metadata without Gemini branding', () => {
    document.title = 'A useful chat - ChatGPT';
    document.body.append(turn(0, 'u-1', 'user', 'Question'));

    const metadata = buildConversationMetadata(collectMountedChatGptMessages());

    expect(metadata.title).toBe('A useful chat');
    expect(metadata.count).toBe(1);
    expect(metadata.title).not.toContain('Gemini');
  });
});
