import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { activateChatGptTemporaryHandoff, collectTemporaryChatTurns } from './index';

const mocks = vi.hoisted(() => ({
  temporary: true,
  unloading: false,
  getCurrentLanguage: vi.fn(),
  collectContainers: vi.fn(),
  buildTurns: vi.fn(),
  isGenerating: vi.fn(),
  resolveAdapter: vi.fn(),
  buildBackup: vi.fn(),
  cancelPendingRecovery: vi.fn(),
  downloadBackup: vi.fn(),
  handoff: vi.fn(),
  hasAttachments: vi.fn(),
  plan: vi.fn(),
  resume: vi.fn(),
  discardPending: vi.fn(),
  markUnloading: vi.fn(),
  markActive: vi.fn(),
  pendingPreviewReady: vi.fn(),
  readDraft: vi.fn(),
}));

vi.mock('@/utils/i18n', () => ({
  getCurrentLanguage: mocks.getCurrentLanguage,
}));

vi.mock('@/pages/content/export/adapter/chatgpt', () => ({
  chatgptCollectTurnContainers: mocks.collectContainers,
  buildChatGptTurnsForSelection: mocks.buildTurns,
  isChatGptResponseGenerating: mocks.isGenerating,
}));

vi.mock('@/pages/content/export/adapter/platformAdapters', () => ({
  resolveExportAdapter: mocks.resolveAdapter,
}));

vi.mock('./handoff', () => ({
  CHATGPT_COMPOSER_SELECTOR: '#prompt-textarea',
  CHATGPT_NEW_CHAT_SELECTOR: 'a[data-testid="create-new-chat-button"]',
  CHATGPT_SEND_CONTROL_SELECTOR: '[data-testid="send-button"]',
  CHATGPT_TEMP_TOGGLE_SELECTOR: '[data-testid="temporary-chat-toggle"]',
  buildHandoffBackup: mocks.buildBackup,
  cancelPendingHandoffRecovery: mocks.cancelPendingRecovery,
  discardPendingHandoff: mocks.discardPending,
  downloadHandoffBackup: mocks.downloadBackup,
  handoffTemporaryChat: mocks.handoff,
  hasCurrentComposerAttachments: mocks.hasAttachments,
  isHandoffPageUnloading: () => mocks.unloading,
  isTemporaryChat: () => mocks.temporary,
  markHandoffPageUnloading: () => {
    mocks.unloading = true;
    mocks.markUnloading();
  },
  markHandoffPageActive: () => {
    mocks.unloading = false;
    mocks.markActive();
  },
  pendingAttachmentPreviewReady: mocks.pendingPreviewReady,
  planHandoff: mocks.plan,
  readCurrentComposerDraft: mocks.readDraft,
  resumePendingHandoff: mocks.resume,
}));

const scopes: PluginScope[] = [];

function createScope(): PluginScope {
  const scope = new PluginScope();
  scopes.push(scope);
  return scope;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mocks.temporary = true;
  mocks.unloading = false;
  mocks.getCurrentLanguage.mockResolvedValue('en');
  mocks.collectContainers.mockReturnValue([
    { id: 'user-1', role: 'user', sequence: 0, container: document.createElement('div') },
    {
      id: 'assistant-1',
      role: 'assistant',
      sequence: 1,
      container: document.createElement('div'),
    },
  ]);
  mocks.buildTurns.mockResolvedValue([
    { user: 'Question', assistant: 'Answer', starred: false, omitEmptySections: true },
  ]);
  mocks.resolveAdapter.mockReturnValue({ site: { label: 'ChatGPT' } });
  mocks.plan.mockReturnValue({
    transcript: '## User\n\nQuestion',
    backupFilename: 'unique.md',
    delivery: { mode: 'inline', text: 'Continue' },
  });
  mocks.handoff.mockResolvedValue('ready');
  mocks.hasAttachments.mockReturnValue(false);
  mocks.buildBackup.mockReturnValue('## User\n\nQuestion\n\n## Unsent draft\n\nUnsent follow-up');
  mocks.readDraft.mockReturnValue('Unsent follow-up');
  mocks.resume.mockResolvedValue(null);
  mocks.discardPending.mockResolvedValue(undefined);
  mocks.pendingPreviewReady.mockResolvedValue(false);
  mocks.isGenerating.mockReturnValue(false);
});

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
  history.replaceState({}, '', '/');
  document.body.replaceChildren();
  document.head.querySelectorAll('style[data-gv-plugin-scope]').forEach((node) => node.remove());
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChatGPT temporary handoff plugin', () => {
  it('mounts only in temporary mode and removes every side effect on disposal', async () => {
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    expect(document.querySelectorAll('[data-gv-chatgpt-handoff-button]')).toHaveLength(1);
    expect(document.head.querySelector('style[data-gv-plugin-scope]')?.textContent).toContain(
      '.gv-chatgpt-handoff-button',
    );

    await scope.dispose();
    expect(document.querySelector('[data-gv-chatgpt-handoff-button]')).toBeNull();
    expect(document.querySelector('[data-gv-chatgpt-handoff-owned]')).toBeNull();
    expect(mocks.discardPending).toHaveBeenCalledOnce();
  });

  it('retains a pending handoff when disposal is caused by page navigation', async () => {
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    window.dispatchEvent(new Event('pagehide'));
    await scope.dispose();

    expect(mocks.markUnloading).toHaveBeenCalledOnce();
    expect(mocks.discardPending).not.toHaveBeenCalled();
  });

  it('marks hard navigation before the root beforeunload teardown disposes the plugin', async () => {
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    window.dispatchEvent(new Event('beforeunload'));
    await scope.dispose();

    expect(mocks.markUnloading).toHaveBeenCalledOnce();
    expect(mocks.discardPending).not.toHaveBeenCalled();
  });

  it('clears the navigation marker when a cached page is restored', async () => {
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    await scope.dispose();

    expect(mocks.markUnloading).toHaveBeenCalledOnce();
    expect(mocks.markActive).toHaveBeenCalledOnce();
    expect(mocks.discardPending).toHaveBeenCalledOnce();
  });

  it('does not mount after async language loading finishes for a disposed plugin', async () => {
    let resolveLanguage!: (language: 'en') => void;
    mocks.getCurrentLanguage.mockReturnValue(
      new Promise<'en'>((resolve) => {
        resolveLanguage = resolve;
      }),
    );
    const scope = createScope();
    const activation = activateChatGptTemporaryHandoff(scope);
    const disposal = scope.dispose();
    resolveLanguage('en');

    await Promise.all([activation, disposal]);
    expect(document.querySelector('[data-gv-chatgpt-handoff-button]')).toBeNull();
  });

  it('removes the action when ChatGPT leaves temporary mode', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?temporary-chat=true');
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);
    expect(document.querySelector('[data-gv-chatgpt-handoff-button]')).not.toBeNull();

    mocks.temporary = false;
    history.pushState(null, '', '/');
    await vi.advanceTimersByTimeAsync(500);

    expect(document.querySelector('[data-gv-chatgpt-handoff-button]')).toBeNull();
  });

  it('confirms, reuses the shared ChatGPT collector, saves a backup, and hands off once', async () => {
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-handoff-button]')?.click();
    await flush();
    const attribution = document.querySelector<HTMLAnchorElement>(
      '.gv-chatgpt-handoff-dialog-attribution',
    );
    expect(attribution?.textContent).toBe('Powered by ChatGPT Voyager');
    expect(attribution?.href).toBe('https://github.com/TanChuping/chatgpt-voyager');
    expect(attribution?.target).toBe('_blank');
    expect(attribution?.rel).toContain('noopener');
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(document.querySelector('.gv-chatgpt-handoff-dialog-body')?.textContent).toContain(
      'uploaded as a draft attachment',
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const description = document.querySelector<HTMLElement>('.gv-chatgpt-handoff-dialog-body');
    expect(dialog?.getAttribute('aria-describedby')).toBe(description?.id);
    document
      .querySelector<HTMLButtonElement>('.gv-chatgpt-handoff-dialog-button--primary')
      ?.click();

    await vi.waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
    expect(mocks.buildTurns).toHaveBeenCalledWith(new Set(['user-1', 'assistant-1']), {
      signal: expect.any(AbortSignal),
      expectedUrl: location.href,
    });
    expect(mocks.buildBackup).toHaveBeenCalledWith('## User\n\nQuestion', 'Unsent follow-up', 'en');
    expect(mocks.downloadBackup).toHaveBeenCalledWith(
      '## User\n\nQuestion\n\n## Unsent draft\n\nUnsent follow-up',
      'unique.md',
    );
    expect(mocks.handoff).toHaveBeenCalledWith(
      expect.any(PluginScope),
      expect.objectContaining({ mode: 'inline', text: 'Continue' }),
      'Unsent follow-up',
    );
    expect(document.querySelectorAll('[data-gv-chatgpt-handoff-button]')).toHaveLength(1);
  });

  it('keeps the progress dialog mounted until departure bookkeeping finishes', async () => {
    let finishHandoff!: (result: 'ready') => void;
    mocks.handoff.mockReturnValueOnce(
      new Promise<'ready'>((resolve) => {
        finishHandoff = resolve;
      }),
    );
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-handoff-button]')?.click();
    await flush();
    document
      .querySelector<HTMLButtonElement>('.gv-chatgpt-handoff-dialog-button--primary')
      ?.click();

    await vi.waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
    expect(document.querySelector('.gv-chatgpt-handoff-spinner')).not.toBeNull();

    finishHandoff('ready');
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-chatgpt-handoff-spinner')).toBeNull(),
    );
  });

  it('keeps temporary mode open when the unsent draft still has an attachment', async () => {
    mocks.hasAttachments.mockReturnValue(true);
    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);

    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-handoff-button]')?.click();
    await flush();
    document
      .querySelector<HTMLButtonElement>('.gv-chatgpt-handoff-dialog-button--primary')
      ?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('.gv-chatgpt-handoff-toast')?.textContent).toContain(
        'attached file or image',
      ),
    );
    expect(mocks.buildTurns).not.toHaveBeenCalled();
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it('refuses handoff when the latest user turn has no mounted assistant yet', async () => {
    mocks.collectContainers.mockReturnValue([
      { id: 'user-1', role: 'user', sequence: 0, container: document.createElement('div') },
    ]);

    await expect(collectTemporaryChatTurns(new AbortController().signal)).rejects.toThrow(
      'chatgpt_export_response_still_generating',
    );

    expect(mocks.buildTurns).not.toHaveBeenCalled();
  });

  it('refuses handoff when response generation starts during collection', async () => {
    mocks.isGenerating.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(collectTemporaryChatTurns(new AbortController().signal)).rejects.toThrow(
      'chatgpt_export_conversation_changed',
    );

    expect(mocks.buildTurns).toHaveBeenCalledOnce();
  });

  it('retries a pending handoff when a late attachment preview mounts in the composer', async () => {
    mocks.temporary = false;
    const form = document.createElement('form');
    form.dataset.type = 'unified-composer';
    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    form.appendChild(composer);
    document.body.appendChild(form);

    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);
    await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    mocks.resume.mockClear();

    const placeholder = document.createElement('div');
    placeholder.dataset.testid = 'attachment-placeholder';
    form.appendChild(placeholder);
    await vi.waitFor(() => expect(mocks.pendingPreviewReady).toHaveBeenCalled());
    expect(mocks.resume).not.toHaveBeenCalled();

    mocks.pendingPreviewReady.mockResolvedValue(true);
    const preview = document.createElement('div');
    preview.dataset.testid = 'attachment-preview';
    preview.textContent = 'late-transcript.md';
    form.appendChild(preview);

    await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  });

  it('rechecks pending delivery when the live composer content mutates', async () => {
    mocks.temporary = false;
    const form = document.createElement('form');
    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    form.appendChild(composer);
    document.body.appendChild(form);

    const scope = createScope();
    await activateChatGptTemporaryHandoff(scope);
    await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    mocks.resume.mockClear();

    composer.appendChild(document.createTextNode('delivery mutation'));
    await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it('stops recovery before a user edit changes the delivered composer', async () => {
    mocks.temporary = false;
    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);

    await activateChatGptTemporaryHandoff(createScope());
    composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));

    expect(mocks.cancelPendingRecovery).toHaveBeenCalledOnce();
  });

  it('stops recovery before sending clears the delivered composer', async () => {
    mocks.temporary = false;
    const form = document.createElement('form');
    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    const send = document.createElement('button');
    send.type = 'button';
    send.dataset.testid = 'send-button';
    form.append(composer, send);
    document.body.appendChild(form);

    await activateChatGptTemporaryHandoff(createScope());
    send.click();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(mocks.cancelPendingRecovery).toHaveBeenCalledTimes(2);
  });

  it('stops recovery before same-route New Chat actions', async () => {
    mocks.temporary = false;
    await activateChatGptTemporaryHandoff(createScope());

    for (const route of ['/', '/u/12/g/custom-gpt/']) {
      history.replaceState({}, '', route);
      const newChat = document.createElement('a');
      newChat.dataset.testid = 'create-new-chat-button';
      newChat.href = route;
      newChat.addEventListener('click', (event) => event.preventDefault());
      document.body.appendChild(newChat);
      newChat.click();
      newChat.remove();
    }

    expect(mocks.cancelPendingRecovery).toHaveBeenCalledTimes(2);
  });
});
