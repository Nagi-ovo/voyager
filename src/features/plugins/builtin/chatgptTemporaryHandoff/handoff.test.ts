import { afterEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import type { ChatTurn } from '@/features/export/types/export';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { APP_LANGUAGES } from '@/utils/language';

import {
  type HandoffDelivery,
  PENDING_HANDOFF_KEY,
  PENDING_HANDOFF_TAB_KEY,
  buildHandoffBackup,
  buildHandoffTranscript,
  createHandoffFilename,
  discardDeliveredPendingHandoff,
  discardPendingHandoff,
  getChatGptNewChatPath,
  handoffTemporaryChat,
  hasCurrentComposerAttachments,
  isTemporaryChat,
  markHandoffPageActive,
  markHandoffPageUnloading,
  planHandoff,
  resumePendingHandoff,
} from './handoff';
import { getTemporaryHandoffCopy } from './i18n';
import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
} from './storage';

const storageState = vi.hoisted(() => new Map<string, unknown>());

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(async (keys?: null | string | string[]) => {
          if (keys == null) return Object.fromEntries(storageState);
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, storageState.get(key)]));
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) storageState.delete(item);
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storageState.set(key, value);
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => ({ ok: true })),
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
  delivery: HandoffDelivery,
  storedAt = Date.now(),
  accountScope = 'route:default',
  draft?: string,
): void {
  const token = 'test-tab-token';
  sessionStorage.setItem(PENDING_HANDOFF_TAB_KEY, token);
  storageState.set(`${PENDING_HANDOFF_KEY}:${token}`, {
    delivery,
    storedAt,
    accountScope,
    ...(draft ? { draft } : {}),
  });
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
  markHandoffPageActive();
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
    history.replaceState({}, '', '/g/g-example/c/example');
    expect(getChatGptNewChatPath()).toBe('/g/g-example/');
    history.replaceState({}, '', '/u/12/g/g-example/c/example');
    expect(getChatGptNewChatPath()).toBe('/u/12/g/g-example/');
    history.replaceState({}, '', '/c/example');
    expect(getChatGptNewChatPath()).toBe('/');
  });

  it('builds a role-preserving Markdown transcript and localized inline handoff', () => {
    const turns = [turn('First question', 'First answer')];
    expect(buildHandoffTranscript(turns)).toContain('## User\n\nFirst question');
    expect(buildHandoffTranscript(turns)).toContain('## ChatGPT\n\nFirst answer');

    const chinese = planHandoff(turns, 'zh', 'zh.md');
    const english = planHandoff(turns, 'en', 'en.md');
    const japanese = planHandoff(turns, 'ja', 'ja.md');
    expect(chinese.delivery.mode).toBe('inline');
    expect(english.delivery.mode).toBe('inline');
    if (chinese.delivery.mode === 'inline' && english.delivery.mode === 'inline') {
      expect(chinese.delivery.text).toContain('[从临时对话继续]');
      expect(english.delivery.text).toContain('[Continue from a temporary chat]');
    }
    expect(japanese.transcript).toContain('## ユーザー\n\nFirst question');
    if (japanese.delivery.mode === 'inline') {
      expect(japanese.delivery.text).toContain('[一時チャットから続ける]');
      expect(japanese.delivery.text).toContain('--- 会話記録 開始 ---');
    }
  });

  it('includes an unsent draft in the downloaded backup without adding it to the handoff transcript', () => {
    const transcript = '## User\n\nQuestion\n\n## ChatGPT\n\nAnswer';
    const backup = buildHandoffBackup(transcript, 'Unsent follow-up', 'en');

    expect(backup).toBe(`${transcript}\n\n## Unsent draft\n\nUnsent follow-up`);
    expect(buildHandoffBackup(transcript, '   ', 'en')).toBe(transcript);
    expect(buildHandoffBackup(transcript, '待发送内容', 'zh')).toContain('## 未发送草稿');
    expect(buildHandoffBackup(transcript, '待傳送內容', 'zh_TW')).toContain('## 未傳送草稿');
  });

  it('localizes every user-visible handoff artifact in all supported languages', () => {
    const shortTurns = [turn('Question', 'Answer')];
    const longTurns = [turn('x'.repeat(5_100))];
    const titles = new Set<string>();
    const draftWarnings = new Set<string>();

    for (const language of APP_LANGUAGES) {
      const copy = getTemporaryHandoffCopy(language);
      const inline = planHandoff(shortTurns, language, `${language}-inline.md`);
      const attachment = planHandoff(longTurns, language, `${language}-attachment.md`);
      expect(inline.transcript).toContain(`## ${copy.userRole}\n\nQuestion`);
      expect(inline.delivery.mode).toBe('inline');
      if (inline.delivery.mode === 'inline') {
        expect(inline.delivery.text).toContain(copy.handoffTitle);
        expect(inline.delivery.text).toContain(copy.inlineInstruction);
        expect(inline.delivery.text).toContain(copy.transcriptStart);
        expect(inline.delivery.text).toContain(copy.transcriptEnd);
      }
      expect(attachment.delivery.mode).toBe('attachment');
      if (attachment.delivery.mode === 'attachment') {
        expect(attachment.delivery.directive).toContain(copy.handoffTitle);
        expect(attachment.delivery.directive).toContain(copy.attachmentInstruction);
      }
      expect(buildHandoffBackup(inline.transcript, 'Draft', language)).toContain(
        `## ${copy.unsentDraftHeading}`,
      );
      titles.add(copy.handoffTitle);
      draftWarnings.add(copy.attachmentDraftUnsupported);
    }

    expect(titles.size).toBe(APP_LANGUAGES.length);
    expect(draftWarnings.size).toBe(APP_LANGUAGES.length);
  });

  it('detects a native attachment preview in the live composer draft', () => {
    const form = document.createElement('form');
    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    form.appendChild(composer);
    document.body.appendChild(form);

    expect(hasCurrentComposerAttachments()).toBe(false);
    const preview = document.createElement('div');
    preview.dataset.testid = 'attachment-preview';
    form.appendChild(preview);
    expect(hasCurrentComposerAttachments()).toBe(true);
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

  it('hands an inline transcript to the normal-chat composer and keeps bounded recovery state', async () => {
    const scope = createScope();
    addComposer();
    const getComposer = addTemporaryExit();

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Continue this transcript' }),
    ).resolves.toBe('ready');

    expect(getComposer()?.textContent).toContain('Continue this transcript');
    expect(pendingEntryCount()).toBe(1);
    expect(sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY)).not.toBeNull();
    expect(storedPending()).toMatchObject({ deliveredRoute: '/' });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE }),
    );
    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE }),
    );
  });

  it('accepts a reused composer node and verifies multiline content by rendered text', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    const composer = addComposer('Unsent follow-up');
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
    expect(composer.textContent.indexOf('First line')).toBeLessThan(
      composer.textContent.indexOf('Unsent follow-up'),
    );
    expect(pendingEntryCount()).toBe(1);
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

  it('keeps the expiry alarm when pending storage deletion fails', async () => {
    seedPending({ mode: 'inline', text: 'Delete me later' });
    const storageKey = currentPendingStorageKey()!;
    vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(new Error('storage busy'));

    await discardPendingHandoff();

    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE }),
    );
    expect(storageState.has(storageKey)).toBe(true);
  });

  it('does not leave temporary mode when durable expiry scheduling fails', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    addComposer();
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    const click = vi.spyOn(toggle, 'click');
    document.body.appendChild(toggle);
    vi.mocked(browser.runtime.sendMessage).mockResolvedValueOnce({ ok: false });

    await expect(
      handoffTemporaryChat(scope, { mode: 'inline', text: 'Keep this private' }),
    ).resolves.toBe('storage-failed');

    expect(click).not.toHaveBeenCalled();
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
    const resume = resumePendingHandoff(scope);
    await vi.advanceTimersByTimeAsync(800);
    await expect(resume).resolves.toBe('ready');
    expect(normalComposer.textContent).toContain('Deliver after a slow mount');
    expect(pendingEntryCount()).toBe(1);
  });

  it('restores an unsent temporary-chat draft after the new-chat fallback replaces the composer', async () => {
    vi.useFakeTimers();
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    const temporaryComposer = addComposer('Unsent follow-up');
    let normalComposer: HTMLElement | null = null;
    const newChat = document.createElement('a');
    newChat.dataset.testid = 'create-new-chat-button';
    newChat.href = '/';
    newChat.addEventListener('click', (event) => {
      event.preventDefault();
      history.replaceState({}, '', '/');
      temporaryComposer.remove();
      normalComposer = addComposer();
    });
    document.body.appendChild(newChat);

    const handoff = handoffTemporaryChat(scope, {
      mode: 'inline',
      text: 'Continue the saved transcript',
    });
    await vi.advanceTimersByTimeAsync(900);

    await expect(handoff).resolves.toBe('ready');
    const mountedComposer = document.querySelector<HTMLElement>('#prompt-textarea');
    expect(mountedComposer).toBe(normalComposer);
    expect(mountedComposer?.textContent).toContain('Continue the saved transcript');
    expect(mountedComposer?.textContent).toContain('Unsent follow-up');
    expect(mountedComposer!.textContent.indexOf('Continue the saved transcript')).toBeLessThan(
      mountedComposer!.textContent.indexOf('Unsent follow-up'),
    );
    expect(pendingEntryCount()).toBe(1);
  });

  it('redelivers when ChatGPT replaces the accepted composer after the old wait budget', async () => {
    vi.useFakeTimers();
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    const staleComposer = addComposer('Unsent follow-up');
    let replacement: HTMLElement | null = null;
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    toggle.addEventListener('click', () => {
      history.replaceState({}, '', '/');
      toggle.remove();
      window.setTimeout(() => {
        staleComposer.remove();
        replacement = addComposer();
      }, 800);
    });
    document.body.appendChild(toggle);

    const handoff = handoffTemporaryChat(scope, {
      mode: 'inline',
      text: 'Continue the stable transcript',
    });
    await vi.advanceTimersByTimeAsync(600);

    await expect(handoff).resolves.toBe('ready');
    expect(pendingEntryCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(300);
    await expect(resumePendingHandoff(scope)).resolves.toBeNull();
    const settledComposer = document.querySelector<HTMLElement>('#prompt-textarea');
    expect(settledComposer).toBe(replacement);
    expect(settledComposer?.textContent).toContain('Continue the stable transcript');
    expect(settledComposer?.textContent).toContain('Unsent follow-up');
    expect(pendingEntryCount()).toBe(1);
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

  it('restores a short draft as its own segment instead of matching an unrelated substring', async () => {
    const composer = addComposer('data');
    seedPending({ mode: 'inline', text: 'Recovered handoff' }, Date.now(), 'route:default', 'a');

    await expect(resumePendingHandoff(createScope())).resolves.toBe('ready');

    expect(composer.textContent).toContain('data');
    expect(composer.textContent).toContain('Recovered handoff');
    expect(composer.lastChild?.textContent).toBe('a');
  });

  it('restores a draft separately when the transcript already contains the exact draft line', async () => {
    const composer = addComposer();
    seedPending(
      { mode: 'inline', text: 'Recovered handoff\n\nFollow up\n\nEarlier answer' },
      Date.now(),
      'route:default',
      'Follow up',
    );

    await expect(resumePendingHandoff(createScope())).resolves.toBe('ready');

    expect(composer.textContent?.match(/Follow up/g)).toHaveLength(2);
    expect(composer.lastChild?.textContent).toBe('Follow up');
  });

  it('discards delivered recovery state instead of replaying it on another chat route', async () => {
    const composer = addComposer('Current chat draft');
    seedPending({ mode: 'inline', text: 'Old delivered handoff' });
    const storageKey = currentPendingStorageKey()!;
    storageState.set(storageKey, {
      ...(storageState.get(storageKey) as object),
      deliveredRoute: '/c/old-chat',
    });
    history.replaceState({}, '', '/c/new-chat');

    await expect(resumePendingHandoff(createScope())).resolves.toBeNull();

    expect(composer.textContent).toBe('Current chat draft');
    expect(pendingEntryCount()).toBe(0);
  });

  it('stops delivered recovery before the user edits the composer', async () => {
    const composer = addComposer();
    seedPending({ mode: 'inline', text: 'Recovered handoff' });
    await expect(resumePendingHandoff(createScope())).resolves.toBe('ready');

    discardDeliveredPendingHandoff();
    await vi.waitFor(() => expect(pendingEntryCount()).toBe(0));

    composer.textContent = 'User replacement';
    await expect(resumePendingHandoff(createScope())).resolves.toBeNull();
    expect(composer.textContent).toBe('User replacement');
  });

  it('finishes attachment delivery in the live composer when ChatGPT replaces the editor', async () => {
    class TestDataTransfer {
      private readonly transferredFiles: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.transferredFiles.push(file);
        },
      };
      readonly setData = vi.fn();
      get files(): File[] {
        return this.transferredFiles;
      }
    }
    class TestClipboardEvent extends Event {
      readonly clipboardData: TestDataTransfer;
      constructor(type: string, init: EventInit & { clipboardData: TestDataTransfer }) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
    vi.stubGlobal('DataTransfer', TestDataTransfer);
    vi.stubGlobal('ClipboardEvent', TestClipboardEvent);

    const oldForm = document.createElement('form');
    const oldComposer = document.createElement('div');
    oldComposer.id = 'prompt-textarea';
    oldComposer.contentEditable = 'true';
    oldComposer.setAttribute('role', 'textbox');
    oldForm.appendChild(oldComposer);
    document.body.appendChild(oldForm);

    oldComposer.addEventListener('paste', () => {
      oldForm.remove();
      const liveForm = document.createElement('form');
      const replacement = document.createElement('div');
      replacement.id = 'prompt-textarea';
      replacement.contentEditable = 'true';
      replacement.setAttribute('role', 'textbox');
      const preview = document.createElement('div');
      preview.dataset.testid = 'attachment-preview';
      preview.textContent = 'handoff.md';
      liveForm.append(replacement, preview);
      document.body.appendChild(liveForm);
    });
    seedPending(
      {
        mode: 'attachment',
        directive: 'Read the saved handoff',
        attachment: '# Transcript',
        filename: 'handoff.md',
      },
      Date.now(),
      'route:default',
      'Unsent follow-up',
    );

    await expect(resumePendingHandoff(createScope())).resolves.toBe('ready');

    const liveComposer = document.querySelector<HTMLElement>('#prompt-textarea');
    expect(oldComposer.isConnected).toBe(false);
    expect(liveComposer?.textContent).toContain('Read the saved handoff');
    expect(liveComposer?.lastChild?.textContent).toBe('Unsent follow-up');
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

  it('retains pending state when page unload aborts a live handoff', async () => {
    vi.useFakeTimers();
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    addComposer('Unsent draft');
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    document.body.appendChild(toggle);

    const handoff = handoffTemporaryChat(scope, { mode: 'inline', text: 'Resume after reload' });
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingEntryCount()).toBe(1);

    markHandoffPageUnloading();
    const rejected = expect(handoff).rejects.toMatchObject({ name: 'AbortError' });
    await scope.dispose();
    await rejected;

    expect(pendingEntryCount()).toBe(1);
    expect(storedPending()).toMatchObject({ draft: 'Unsent draft' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('retains pending state when unload happens before the storage write resolves', async () => {
    const scope = createScope();
    history.replaceState({}, '', '/?temporary-chat=true');
    addComposer('Deferred draft');
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'temporary-chat-toggle';
    toggle.setAttribute('aria-label', 'Close temporary chat');
    document.body.appendChild(toggle);

    let finishWrite!: () => void;
    vi.mocked(browser.storage.local.set).mockImplementationOnce(
      (items) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            for (const [key, value] of Object.entries(items)) storageState.set(key, value);
            resolve();
          };
        }),
    );

    const handoff = handoffTemporaryChat(scope, { mode: 'inline', text: 'Resume after reload' });
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    markHandoffPageUnloading();
    await scope.dispose();
    finishWrite();

    await expect(handoff).rejects.toMatchObject({ name: 'AbortError' });
    expect(pendingEntryCount()).toBe(1);
    expect(storedPending()).toMatchObject({ draft: 'Deferred draft' });
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
