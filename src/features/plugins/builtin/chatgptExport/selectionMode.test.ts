import { afterEach, describe, expect, it } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { getChatGptExportCopy } from './i18n';
import { showInlineMessageSelection } from './selectionMode';

function turn(index: number, id: string, role: 'user' | 'assistant', text: string): HTMLElement {
  const section = document.createElement('section');
  section.dataset.testid = `conversation-turn-${index}`;
  const message = document.createElement('div');
  message.dataset.messageAuthorRole = role;
  message.dataset.messageId = id;
  message.textContent = text;
  section.appendChild(message);
  return section;
}

function fallbackTurn(role: 'user' | 'assistant', text: string): HTMLElement {
  const section = document.createElement('section');
  const message = document.createElement('div');
  message.dataset.messageAuthorRole = role;
  message.textContent = text;
  section.appendChild(message);
  return section;
}

function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('ChatGPT progressive inline message selection', () => {
  it('does not drive scrolling and decorates messages loaded later', async () => {
    const scroller = document.createElement('main');
    let scrollTop = 480;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    scroller.append(turn(2, 'u-2', 'user', 'Current question'));
    document.body.appendChild(scroller);
    const scope = new PluginScope();
    const result = showInlineMessageSelection(scope, getChatGptExportCopy());

    expect(scrollTop).toBe(480);
    expect(document.querySelectorAll('.gv-chatgpt-export-pick-checkbox')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-message-id="u-2"]')!.click();

    scroller.prepend(turn(0, 'u-1', 'user', 'Loaded while scrolling'));
    await expect
      .poll(() => document.querySelectorAll('.gv-chatgpt-export-pick-checkbox').length)
      .toBe(2);
    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-message-id="u-1"]')!.click();
    clickButton(getChatGptExportCopy().next);

    await expect(result).resolves.toMatchObject([
      { id: 'u-1', text: 'Loaded while scrolling' },
      { id: 'u-2', text: 'Current question' },
    ]);
    expect(scrollTop).toBe(480);
    expect(document.querySelector('.gv-chatgpt-export-pick-bar')).toBeNull();
    await scope.dispose();
  });

  it('keeps a selected snapshot when ChatGPT virtualises its node away', async () => {
    const scroller = document.createElement('main');
    scroller.append(turn(0, 'u-1', 'user', 'Keep me'));
    document.body.appendChild(scroller);
    const scope = new PluginScope();
    const copy = getChatGptExportCopy();
    const result = showInlineMessageSelection(scope, copy);

    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-message-id="u-1"]')!.click();
    scroller.replaceChildren(turn(1, 'a-1', 'assistant', 'New virtual window'));
    await expect
      .poll(() =>
        document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-message-id="a-1"]'),
      )
      .not.toBeNull();
    clickButton(copy.next);

    await expect(result).resolves.toMatchObject([{ id: 'u-1', text: 'Keep me' }]);
    await scope.dispose();
  });

  it('keeps fallback selections stable when older history shifts virtual offsets', async () => {
    const scroller = document.createElement('main');
    scroller.style.overflowY = 'auto';
    let currentTop = 0;
    const current = fallbackTurn('user', 'Current message');
    const currentMessage = current.querySelector<HTMLElement>('[data-message-author-role]')!;
    currentMessage.getBoundingClientRect = () =>
      ({
        top: -currentTop,
        bottom: -currentTop + 40,
        left: 0,
        right: 200,
        width: 200,
        height: 40,
        x: 0,
        y: -currentTop,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: {
        configurable: true,
        get: () => currentTop,
        set: (value: number) => {
          currentTop = value;
        },
      },
    });
    scroller.appendChild(current);
    document.body.appendChild(scroller);
    const scope = new PluginScope();
    const copy = getChatGptExportCopy();
    const result = showInlineMessageSelection(scope, copy);

    current.querySelector<HTMLButtonElement>('.gv-chatgpt-export-pick-checkbox')!.click();

    const older = fallbackTurn('user', 'Older prepended message');
    const olderMessage = older.querySelector<HTMLElement>('[data-message-author-role]')!;
    olderMessage.getBoundingClientRect = () =>
      ({
        top: -currentTop,
        bottom: -currentTop + 40,
        left: 0,
        right: 200,
        width: 200,
        height: 40,
        x: 0,
        y: -currentTop,
        toJSON: () => ({}),
      }) as DOMRect;
    const remountedCurrent = fallbackTurn('user', 'Current message');
    const remountedMessage = remountedCurrent.querySelector<HTMLElement>(
      '[data-message-author-role]',
    )!;
    remountedMessage.getBoundingClientRect = () =>
      ({
        top: 400 - currentTop,
        bottom: 440 - currentTop,
        left: 0,
        right: 200,
        width: 200,
        height: 40,
        x: 0,
        y: 400 - currentTop,
        toJSON: () => ({}),
      }) as DOMRect;
    scroller.replaceChildren(older, remountedCurrent);

    await expect
      .poll(() => document.querySelectorAll('.gv-chatgpt-export-pick-checkbox').length)
      .toBe(2);
    expect(current.isConnected).toBe(false);
    expect(remountedCurrent.querySelectorAll('.gv-chatgpt-export-pick-checkbox')).toHaveLength(1);
    expect(
      remountedCurrent
        .querySelector<HTMLButtonElement>('.gv-chatgpt-export-pick-checkbox')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    older.querySelector<HTMLButtonElement>('.gv-chatgpt-export-pick-checkbox')!.click();
    clickButton(copy.next);

    await expect(result).resolves.toMatchObject([
      { text: 'Older prepended message' },
      { text: 'Current message' },
    ]);
    await scope.dispose();
  });

  it('waits for a selected assistant response to finish streaming', async () => {
    const assistant = turn(0, 'a-1', 'assistant', 'Partial response');
    const stop = document.createElement('button');
    stop.dataset.testid = 'stop-button';
    document.body.append(assistant, stop);
    const scope = new PluginScope();
    const copy = getChatGptExportCopy();
    const result = showInlineMessageSelection(scope, copy);

    document.querySelector<HTMLButtonElement>('[data-gv-chatgpt-export-message-id="a-1"]')!.click();
    const next = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent === copy.next,
    )!;
    expect(next.disabled).toBe(true);

    assistant.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!.textContent =
      'Completed response';
    stop.remove();
    await expect.poll(() => next.disabled).toBe(false);
    next.click();

    await expect(result).resolves.toMatchObject([{ id: 'a-1', text: 'Completed response' }]);
    await scope.dispose();
  });

  it('cleans every checkbox, class, observer and toolbar when disabled', async () => {
    document.body.append(turn(0, 'u-1', 'user', 'Question'));
    const scope = new PluginScope();
    const result = showInlineMessageSelection(scope, getChatGptExportCopy());

    await scope.dispose();

    await expect(result).resolves.toBeNull();
    expect(document.querySelector('.gv-chatgpt-export-pick-checkbox')).toBeNull();
    expect(document.querySelector('.gv-chatgpt-export-pick-bar')).toBeNull();
    expect(document.querySelector(`.${'gv-chatgpt-export-pick-host'}`)).toBeNull();
    expect(scope.getEffects()).toEqual([]);
  });
});
