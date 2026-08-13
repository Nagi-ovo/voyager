import { afterEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import type { ChatTurn } from '@/features/export/types/export';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import {
  PENDING_HANDOFF_KEY,
  PENDING_HANDOFF_TAB_KEY,
  buildHandoffTranscript,
  createHandoffFilename,
  getChatGptNewChatPath,
  handoffTemporaryChat,
  isTemporaryChat,
  planHandoff,
  resumePendingHandoff,
} from './handoff';

const storageState = vi.hoisted(() => new Map<string, unknown>());

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.get(key) })),
        remove: vi.fn(async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) storageState.delete(item);
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storageState.set(key, value);
        }),
      },
    },
  },
}));

const scopes: PluginScope[] = [];

function currentPendingStorageKey(): string | null {
  const token = sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY);
  return token ? `${PENDING_HANDOFF_KEY}:${token}` : null;
}

function storedPending(): unknown {
  const key = currentPendingStorageKey();
  return key ? storageState.get(key) : undefined;
}

function pendingEntryCount(): number {
  return [...storageState.keys()].filter((key) => key.startsWith(`${PENDING_HANDOFF_KEY}:`)).length;
}

function seedPending(
  delivery: { mode: 'inline'; text: string },
  storedAt = Date.now(),
  accountScope = 'route:default',
): void {
  const token = 'test-tab-token';
  sessionStorage.setItem(PENDING_HANDOFF_TAB_KEY, token);
  storageState.set(`${PENDING_HANDOFF_KEY}:${token}`, { delivery, storedAt, accountScope });
}

function createScope(): PluginScope {
  const scope = new PluginScope();
  scopes.push(scope);
  return scope;
}

function turn(user: string, assistant = ''): ChatTurn {
  return { user, assistant, starred: false, omitEmptySections: true };
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

function addTemporaryExit(
  onReplacement?: (composer: HTMLElement) => void,
): () => HTMLElement | null {
  history.replaceState({}, '', '/?temporary-chat=true');
  let replacement: HTMLElement | null = null;
  const toggle = document.createElement('button');
  toggle.dataset.testid = 'temporary-chat-toggle';
  toggle.setAttribute('aria-label', 'Close temporary chat');
  toggle.addEventListener('click', () => {
    const oldComposer = document.querySelector<HTMLElement>('#prompt-textarea');
    history.replaceState({}, '', '/');
    toggle.remove();
    oldComposer?.remove();
    replacement = addComposer(oldComposer?.textContent || '');
    onReplacement?.(replacement);
  });
  document.body.appendChild(toggle);
  return () => replacement;
}

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
  sessionStorage.clear();
  storageState.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it('keeps the active account prefix in fallback new-chat navigation', () => {
    history.replaceState({}, '', '/u/12/c/example');
    expect(getChatGptNewChatPath()).toBe('/u/12/');
    history.replaceState({}, '', '/c/example');
    expect(getChatGptNewChatPath()).toBe('/');
  });

  it('builds a role-preserving Markdown transcript and localized inline handoff', () => {
    const turns = [turn('First question', 'First answer')];
    expect(buildHandoffTranscript(turns)).toContain('## User\n\nFirst question');
    expect(buildHandoffTranscript(turns)).toContain('## ChatGPT\n\nFirst answer');

    const chinese = planHandoff(turns, 'zh', 'zh.md');
    const english = planHandoff(turns, 'en', 'en.md');
    expect(chinese.delivery.mode).toBe('inline');
    expect(english.delivery.mode).toBe('inline');
    if (chinese.delivery.mode === 'inline' && english.delivery.mode === 'inline') {
      expect(chinese.delivery.text).toContain('[从临时对话继续]');
      expect(english.delivery.text).toContain('[Continue from a temporary chat]');
    }
  });

  it('gives separate handoffs unique filenames even at the same instant', () => {
    const now = new Date('2026-08-13T12:34:56.789Z');
    const first = createHandoffFilename(now, 'first-nonce');
    const second = createHandoffFilename(now, 'second-nonce');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^chatgpt-temporary-handoff-20260813123456789-firstnonce\.md$/);
    expect(second).toContain('secondnonce');
  });

  it('uses the same unique filename for a long transcript backup and attachment', () => {
    const plan = planHandoff([turn('x'.repeat(5_100))], 'en', 'unique-handoff.md');
    expect(plan.delivery.mode).toBe('attachment');
    expect(plan.backupFilename).toBe('unique-handoff.md');
    if (plan.delivery.mode === 'attachment') {
      expect(plan.delivery.filename).toBe('unique-handoff.md');
      expect(plan.delivery.attachment.length).toBeGreaterThan(5_000);
    }
  });

  it('hands an inline transcript to the normal-chat composer and clears pending state', async () => {
    const scope = createScope();
    addComposer();
    const getComposer = addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Continue this transcript' }),
    ).resolves.toBe('ready');

    expect(getComposer()?.textContent).toContain('Continue this transcript');
    expect(pendingEntryCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY)).toBeNull();
  });

  it('accepts a reused composer node and verifies multiline content by rendered text', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    const composer = addComposer();
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    toggle.addEventListener('click', () => {
      history.replaceState({}, '', '/');
      toggle.remove();
    });
    document.body.appendChild(toggle);

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'First line\n\nThird line' }),
    ).resolves.toBe('ready');

    expect(composer.textContent).toContain('First line');
    expect(composer.textContent).toContain('Third line');
    expect(pendingEntryCount()).toBe(0);
  });

  it('ignores another page editor before the real ChatGPT composer', async () => {
    const scope = createScope();
    const canvas = document.createElement('div');
    canvas.contentEditable = 'true';
    canvas.setAttribute('role', 'textbox');
    canvas.textContent = 'Canvas draft';
    document.body.appendChild(canvas);
    addComposer();
    const getComposer = addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Private handoff' }),
    ).resolves.toBe('ready');

    expect(canvas.textContent).toBe('Canvas draft');
    expect(getComposer()?.textContent).toContain('Private handoff');
  });

  it('does not leave temporary mode when extension storage rejects the pending payload', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    addComposer();
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    const click = vi.spyOn(toggle, 'click');
    document.body.appendChild(toggle);
    vi.mocked(browser.storage.local.set).mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Keep this private' }),
    ).resolves.toBe('storage-failed');

    expect(click).not.toHaveBeenCalled();
    expect(isTemporaryChat()).toBe(true);
    expect(pendingEntryCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY)).toBeNull();
  });

  it('preserves pending delivery when the normal composer mounts after the wait budget', async () => {
    vi.useFakeTimers();
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    const staleComposer = addComposer('Temporary draft');
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    toggle.addEventListener('click', () => {
      history.replaceState({}, '', '/');
      toggle.remove();
      staleComposer.remove();
    });
    const newChat = document.createElement('a');
    newChat.dataset.testid = 'create-new-chat-button';
    newChat.href = '/';
    newChat.addEventListener('click', (event) => event.preventDefault());
    document.body.append(toggle, newChat);

    const handoff = handoffTemporaryChat(scope, {
      mode: 'inline',
      text: 'Deliver after a slow mount',
    });
    await vi.advanceTimersByTimeAsync(4_700);

    await expect(handoff).resolves.toBe('composer-missing');
    expect(storedPending()).toBeDefined();

    const normalComposer = addComposer();
    await expect(resumePendingHandoff(scope)).resolves.toBe('ready');
    expect(normalComposer.textContent).toContain('Deliver after a slow mount');
    expect(pendingEntryCount()).toBe(0);
  });

  it('rejects a handoff when leaving temporary mode switches accounts', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/u/0/?temporary-chat=true');
    const composer = addComposer('Existing draft');
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    toggle.addEventListener('click', () => {
      composer.remove();
      addComposer('Existing draft');
      history.replaceState({}, '', '/u/1/');
      toggle.remove();
    });
    document.body.appendChild(toggle);

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Other account transcript' }),
    ).resolves.toBe('account-mismatch');
    expect(pendingEntryCount()).toBe(0);
  });

  it('keeps a pending attachment when ChatGPT rejects delivery without changing the draft', async () => {
    vi.stubGlobal('DataTransfer', undefined);
    vi.stubGlobal('ClipboardEvent', undefined);
    const scope = createScope();
    addComposer('Existing draft');
    const getComposer = addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, {
        mode: 'attachment',
        directive: 'Read the attachment',
        attachment: '# Transcript',
        filename: 'unique-transcript.md',
      }),
    ).resolves.toBe('delivery-failed');

    expect(getComposer()?.textContent).toBe('Existing draft');
    expect(storedPending()).toBeDefined();
    expect(browser.storage.local.set).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(PENDING_HANDOFF_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY)).not.toContain('# Transcript');
  });

  it('preserves formatted composer DOM when resuming a pending inline handoff', async () => {
    const scope = createScope();
    const composer = addComposer();
    composer.innerHTML = '<p><strong>First paragraph</strong></p><p>Second paragraph</p>';
    const originalDraft = composer.innerHTML;
    seedPending({ mode: 'inline', text: 'Recovered handoff' });

    await expect(resumePendingHandoff(scope)).resolves.toBe('ready');
    expect(composer.innerHTML.startsWith(originalDraft)).toBe(true);
    expect(composer.querySelector('strong')?.textContent).toBe('First paragraph');
    expect(composer.querySelectorAll('p')).toHaveLength(2);
    expect(composer.textContent).toContain('Recovered handoff');
  });

  it('removes an expired pending payload without touching the composer', async () => {
    const composer = addComposer('Current draft');
    seedPending({ mode: 'inline', text: 'Expired handoff' }, Date.now() - 60_001);

    await expect(resumePendingHandoff(createScope())).resolves.toBeNull();

    expect(composer.textContent).toBe('Current draft');
    expect(pendingEntryCount()).toBe(0);
    expect(sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY)).toBeNull();
  });

  it('clears pending state when plugin disposal cancels a live handoff', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    addComposer();
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    document.body.appendChild(toggle);

    const handoff = handoffTemporaryChat(scope, { mode: 'inline', text: 'Do not resume later' });
    await Promise.resolve();
    const disposal = scope.dispose();

    await expect(handoff).rejects.toMatchObject({ name: 'AbortError' });
    await disposal;
    expect(pendingEntryCount()).toBe(0);
  });

  it('clears pending state when plugin disposal cancels a resume', async () => {
    vi.useFakeTimers();
    const scope = createScope();
    seedPending({ mode: 'inline', text: 'Do not replay after disable' });

    const resume = resumePendingHandoff(scope);
    const rejected = expect(resume).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    await scope.dispose();
    await rejected;

    expect(pendingEntryCount()).toBe(0);
    const composer = addComposer();
    await expect(resumePendingHandoff(createScope())).resolves.toBeNull();
    expect(composer.textContent).toBe('');
  });
});
