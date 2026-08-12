import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { activateChatGptTemporaryHandoff } from './index';

const mocks = vi.hoisted(() => ({
  temporary: true,
  getCurrentLanguage: vi.fn(),
  collectContainers: vi.fn(),
  buildTurns: vi.fn(),
  resolveAdapter: vi.fn(),
  downloadBackup: vi.fn(),
  handoff: vi.fn(),
  plan: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@/utils/i18n', () => ({
  getCurrentLanguage: mocks.getCurrentLanguage,
}));

vi.mock('@/pages/content/export/adapter/chatgpt', () => ({
  chatgptCollectTurnContainers: mocks.collectContainers,
  buildChatGptTurnsForSelection: mocks.buildTurns,
}));

vi.mock('@/pages/content/export/adapter/platformAdapters', () => ({
  resolveExportAdapter: mocks.resolveAdapter,
}));

vi.mock('./handoff', () => ({
  CHATGPT_TEMP_TOGGLE_SELECTOR: '[data-testid="temporary-chat-toggle"]',
  downloadHandoffBackup: mocks.downloadBackup,
  handoffTemporaryChat: mocks.handoff,
  isTemporaryChat: () => mocks.temporary,
  planHandoff: mocks.plan,
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
  mocks.getCurrentLanguage.mockResolvedValue('en');
  mocks.collectContainers.mockReturnValue([
    { id: 'user-1', role: 'user', sequence: 0, container: document.createElement('div') },
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
  mocks.resume.mockResolvedValue(null);
});

afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
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
    document
      .querySelector<HTMLButtonElement>('.gv-chatgpt-handoff-dialog-button--primary')
      ?.click();

    await vi.waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
    expect(mocks.buildTurns).toHaveBeenCalledWith(new Set(['user-1']), {
      signal: expect.any(AbortSignal),
      expectedUrl: location.href,
    });
    expect(mocks.downloadBackup).toHaveBeenCalledWith('## User\n\nQuestion', 'unique.md');
    expect(mocks.handoff).toHaveBeenCalledWith(
      expect.any(PluginScope),
      expect.objectContaining({ mode: 'inline', text: 'Continue' }),
    );
    expect(document.querySelectorAll('[data-gv-chatgpt-handoff-button]')).toHaveLength(1);
  });
});
