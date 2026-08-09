import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { collectMountedChatGptMessages } from './conversation';
import {
  buildHandoffTranscript,
  handoffTemporaryChat,
  isTemporaryChat,
  planHandoff,
  resumePendingHandoff,
} from './tempHandoff';

const PENDING_KEY = 'gv-chatgpt-export-pending-handoff';

function addMessage(id: string, role: 'user' | 'assistant', text: string): void {
  const message = document.createElement('div');
  message.dataset.messageId = id;
  message.dataset.messageAuthorRole = role;
  message.textContent = text;
  document.body.appendChild(message);
}

function addComposer(draft = ''): HTMLElement {
  const composer = document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.contentEditable = 'true';
  composer.setAttribute('role', 'textbox');
  composer.textContent = draft;
  document.body.appendChild(composer);
  return composer;
}

function addTemporaryExit(): void {
  history.replaceState({}, '', '/?temporary-chat=true');
  const toggle = document.createElement('button');
  toggle.dataset.testid = 'temporary-chat-toggle';
  toggle.setAttribute('aria-label', 'Close temporary chat');
  toggle.addEventListener('click', () => {
    history.replaceState({}, '', '/');
    toggle.remove();
  });
  document.body.appendChild(toggle);
}

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('hands an inline temporary transcript to the normal-chat composer and clears pending state', async () => {
    const scope = new PluginScope();
    const composer = addComposer();
    addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Continue this transcript' }),
    ).resolves.toBe('ready');

    expect(composer.textContent).toContain('Continue this transcript');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await scope.dispose();
  });

  it('expires pending entries before touching the composer', async () => {
    const scope = new PluginScope();
    const composer = addComposer('Existing draft');
    vi.spyOn(Date, 'now').mockReturnValue(120_000);
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        delivery: { mode: 'inline', text: 'Expired handoff' },
        storedAt: 0,
        accountScope: 'route:default',
      }),
    );

    await expect(resumePendingHandoff(scope)).resolves.toBeNull();
    expect(composer.textContent).toBe('Existing draft');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await scope.dispose();
  });

  it('clears a pending handoff when the ChatGPT route account changes', async () => {
    const scope = new PluginScope();
    const composer = addComposer('Existing draft');
    history.replaceState({}, '', '/u/1/');
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        delivery: { mode: 'inline', text: 'Other account transcript' },
        storedAt: Date.now(),
        accountScope: 'route:0',
      }),
    );

    await expect(resumePendingHandoff(scope)).resolves.toBe('account-mismatch');
    expect(composer.textContent).toBe('Existing draft');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await scope.dispose();
  });

  it('preserves the composer draft when attachment delivery is rejected', async () => {
    vi.stubGlobal('DataTransfer', undefined);
    vi.stubGlobal('ClipboardEvent', undefined);
    const scope = new PluginScope();
    const composer = addComposer('Existing draft');
    addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, {
        mode: 'attachment',
        directive: 'Read the attachment',
        attachment: '# Transcript',
        filename: 'transcript.md',
      }),
    ).resolves.toBe('delivery-failed');

    expect(composer.textContent).toBe('Existing draft');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await scope.dispose();
  });

  it('resumes a matching pending handoff and preserves an existing draft', async () => {
    vi.stubGlobal('DataTransfer', undefined);
    vi.stubGlobal('ClipboardEvent', undefined);
    const scope = new PluginScope();
    const composer = addComposer('Existing draft');
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        delivery: { mode: 'inline', text: 'Recovered handoff' },
        storedAt: Date.now(),
        accountScope: 'route:default',
      }),
    );

    await expect(resumePendingHandoff(scope)).resolves.toBe('ready');
    expect(composer.textContent).toBe('Existing draft\n\nRecovered handoff');
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await scope.dispose();
  });
});
