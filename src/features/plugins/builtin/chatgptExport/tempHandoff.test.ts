import { afterEach, describe, expect, it } from 'vitest';

import { collectMountedChatGptMessages } from './conversation';
import { buildHandoffTranscript, isTemporaryChat, planHandoff } from './tempHandoff';

function addMessage(id: string, role: 'user' | 'assistant', text: string): void {
  const message = document.createElement('div');
  message.dataset.messageId = id;
  message.dataset.messageAuthorRole = role;
  message.textContent = text;
  document.body.appendChild(message);
}

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
});

describe('temporary chat handoff', () => {
  it('detects temporary mode from the route or native toggle state', () => {
    history.replaceState({}, '', '/?temporary-chat=true');
    expect(isTemporaryChat()).toBe(true);
    history.replaceState({}, '', '/');
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    document.body.appendChild(toggle);
    expect(isTemporaryChat()).toBe(true);
  });

  it('builds a role-preserving Markdown transcript and inline handoff', () => {
    addMessage('u-1', 'user', 'First question');
    addMessage('a-1', 'assistant', 'First answer');
    const messages = collectMountedChatGptMessages();

    expect(buildHandoffTranscript(messages)).toContain('## User\n\nFirst question');
    expect(buildHandoffTranscript(messages)).toContain('## ChatGPT\n\nFirst answer');
    const delivery = planHandoff(messages);
    expect(delivery.mode).toBe('inline');
    if (delivery.mode === 'inline') expect(delivery.text).toContain('TRANSCRIPT START');
  });

  it('uses an attachment plan for a long temporary transcript', () => {
    addMessage('u-long', 'user', 'x'.repeat(5_100));
    const delivery = planHandoff(collectMountedChatGptMessages());

    expect(delivery.mode).toBe('attachment');
    if (delivery.mode === 'attachment') {
      expect(delivery.filename).toMatch(/^chatgpt-temporary-handoff-\d{8}\.md$/);
      expect(delivery.attachment.length).toBeGreaterThan(5_000);
    }
  });
});
