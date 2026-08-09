import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { activateChatGptExport } from './index';

const { resumePendingHandoffMock } = vi.hoisted(() => ({
  resumePendingHandoffMock: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/utils/i18n', () => ({
  getCurrentLanguage: vi.fn().mockResolvedValue('en'),
}));

vi.mock('./tempHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tempHandoff')>()),
  resumePendingHandoff: resumePendingHandoffMock,
}));

function addConversation(): void {
  document.body.innerHTML = `
    <div id="conversation-header-actions"></div>
    <main>
      <section data-testid="conversation-turn-0">
        <div data-message-author-role="user" data-message-id="u-1">Question</div>
      </section>
      <section data-testid="conversation-turn-1">
        <div data-message-author-role="assistant" data-message-id="a-1">Answer</div>
      </section>
    </main>
  `;
}

function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
}

function clickDialogButton(label: string): void {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.gv-chatgpt-export-dialog button'),
  ).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Dialog button not found: ${label}`);
  button.click();
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('[data-gv-plugin-scope]').forEach((node) => node.remove());
  sessionStorage.clear();
  vi.restoreAllMocks();
  resumePendingHandoffMock.mockReset().mockResolvedValue(null);
});

describe('ChatGPT export native plugin lifecycle', () => {
  it('mounts one button and removes all owned UI on scope disposal', async () => {
    document.body.innerHTML = '<div id="conversation-header-actions"></div>';
    const scope = new PluginScope();
    await activateChatGptExport(scope);

    const button = document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-button]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('Export');
    expect(button?.getAttribute('aria-label')).toBe('Export conversation');
    expect(document.querySelectorAll('[data-gv-chatgpt-export-button]')).toHaveLength(1);
    button?.click();
    expect(document.querySelector('.gv-chatgpt-export-menu')).not.toBeNull();

    await scope.dispose();

    expect(document.querySelector('[data-gv-chatgpt-export-button]')).toBeNull();
    expect(document.querySelector('.gv-chatgpt-export-menu')).toBeNull();
    expect(document.querySelector('.gv-chatgpt-export-overlay')).toBeNull();
    expect(document.querySelector('[data-gv-plugin-scope]')).toBeNull();
    expect(scope.getEffects()).toEqual([]);
  });

  it('supports disable and re-enable without duplicate injection', async () => {
    document.body.innerHTML = '<div id="conversation-header-actions"></div>';
    const first = new PluginScope();
    await activateChatGptExport(first);
    await first.dispose();

    const second = new PluginScope();
    await activateChatGptExport(second);

    expect(document.querySelectorAll('[data-gv-chatgpt-export-button]')).toHaveLength(1);
    await second.dispose();
    expect(document.querySelectorAll('[data-gv-chatgpt-export-button]')).toHaveLength(0);
  });

  it('retries a pending handoff when the composer mounts during a slow SPA transition', async () => {
    document.body.innerHTML = '<div id="conversation-header-actions"></div>';
    let finishFirst: ((value: null) => void) | undefined;
    resumePendingHandoffMock
      .mockReturnValueOnce(
        new Promise<null>((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValue(null);
    const scope = new PluginScope();
    await activateChatGptExport(scope);
    expect(resumePendingHandoffMock).toHaveBeenCalledTimes(1);

    const composer = document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.contentEditable = 'true';
    composer.setAttribute('role', 'textbox');
    document.body.appendChild(composer);
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    finishFirst?.(null);

    await vi.waitFor(() => expect(resumePendingHandoffMock).toHaveBeenCalledTimes(2));
    await scope.dispose();
  });

  it('runs whole-conversation Markdown export through the plugin dialogs', async () => {
    addConversation();
    let downloaded = '';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    const scope = new PluginScope();
    await activateChatGptExport(scope);

    clickButton('Export conversation');
    clickButton('Export entire conversation');
    await vi.waitFor(() =>
      expect(document.querySelector('input[value="markdown"]')).not.toBeNull(),
    );
    clickDialogButton('Export');

    await vi.waitFor(() => expect(downloaded).toMatch(/^chatgpt-.+\.md$/));
    await scope.dispose();
  });

  it('runs selected-message JSON export and marks the filename as selected', async () => {
    addConversation();
    let downloaded = '';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    const scope = new PluginScope();
    await activateChatGptExport(scope);

    clickButton('Export conversation');
    clickButton('Select messages to export');
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-chatgpt-export-pick-bar')).not.toBeNull(),
    );
    expect(document.querySelector('.gv-chatgpt-export-progress')).toBeNull();
    expect(document.querySelectorAll('.gv-chatgpt-export-pick-checkbox')).toHaveLength(2);
    clickButton('Loaded: only ChatGPT');
    clickButton('Choose format');
    await vi.waitFor(() => expect(document.querySelector('input[value="json"]')).not.toBeNull());
    document.querySelector<HTMLInputElement>('input[value="json"]')!.click();
    clickDialogButton('Export');

    await vi.waitFor(() => expect(downloaded).toMatch(/-selected-\d{8}-\d{4}\.json$/));
    await scope.dispose();
  });
});
