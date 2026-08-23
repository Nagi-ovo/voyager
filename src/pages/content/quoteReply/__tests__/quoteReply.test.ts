import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { getBrowserName } from '@/core/utils/browser';

import { HighlightManager } from '../../highlight';
import { expandInputCollapseIfNeeded } from '../../inputCollapse/index';
import { startQuoteReply } from '../index';

vi.mock('../../inputCollapse/index', () => ({
  expandInputCollapseIfNeeded: vi.fn(),
}));

vi.mock('@/core/utils/browser', () => ({
  getBrowserName: vi.fn(() => 'Chrome/Chromium'),
}));

let activeElement: Element | null = null;
let inputFocusMock: ReturnType<typeof vi.fn>;
let inputBlurMock: ReturnType<typeof vi.fn>;

function installFocusTracking(element: HTMLElement | HTMLTextAreaElement) {
  const focusMock = vi.fn((_options?: FocusOptions) => {
    activeElement = element;
  });
  const blurMock = vi.fn(() => {
    if (activeElement === element) {
      activeElement = document.body;
    }
  });

  Object.defineProperty(element, 'focus', {
    value: focusMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(element, 'blur', {
    value: blurMock,
    configurable: true,
    writable: true,
  });

  return { focusMock, blurMock };
}

function selectSourceText(start = 0, end = 5) {
  const selection = window.getSelection();
  const textNode = document.getElementById('source')?.firstChild;
  if (!(textNode instanceof Text)) {
    throw new Error('Expected a Text node for quote selection.');
  }

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function installHighlightConversation(): void {
  document.querySelector('main')!.innerHTML = `
    <div class="conversation-container" id="1111111111111111">
      <div class="user-query-bubble-with-background">Question</div>
      <model-response><message-content><p id="source">Hello world</p></message-content></model-response>
    </div>
  `;
}

function triggerQuoteReply() {
  selectSourceText();
  document.dispatchEvent(new MouseEvent('mouseup'));
  vi.runAllTimers();

  const quoteButton = document.querySelector<HTMLElement>('.gv-quote-btn');
  if (!(quoteButton instanceof HTMLElement)) {
    throw new Error('Expected quote button to be present.');
  }

  quoteButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  quoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  vi.runAllTimers();
}

describe('quote reply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(getBrowserName).mockReturnValue('Chrome/Chromium');
    activeElement = document.body;

    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => activeElement ?? document.body,
    });

    document.body.innerHTML = `
      <main>
        <div class="conversation-container">
          <model-response><message-content><p id="source">Hello world</p></message-content></model-response>
        </div>
      </main>
      <div id="input-container">
        <rich-textarea>
          <div id="input" contenteditable="true"></div>
        </rich-textarea>
      </div>
    `;

    const input = document.getElementById('input') as HTMLElement;
    input.getBoundingClientRect = () =>
      ({
        height: 20,
        width: 100,
        top: 0,
        left: 0,
        bottom: 20,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    ({ focusMock: inputFocusMock, blurMock: inputBlurMock } = installFocusTracking(input));
    input.scrollIntoView = vi.fn();

    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      value: vi.fn(
        () =>
          ({
            height: 10,
            width: 10,
            top: 0,
            left: 0,
            bottom: 10,
            right: 10,
            x: 0,
            y: 0,
            toJSON: () => {},
          }) as DOMRect,
      ),
      configurable: true,
    });

    Object.defineProperty(document, 'execCommand', {
      value: vi.fn((command: string, _showUI?: boolean, value?: string) => {
        if (command !== 'insertText' || typeof value !== 'string') {
          return false;
        }
        const input = document.getElementById('input');
        if (!(input instanceof HTMLElement)) {
          return false;
        }
        input.textContent = (input.textContent ?? '') + value;
        return true;
      }),
      configurable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('expands input collapse when using quote reply', () => {
    const cleanup = startQuoteReply();
    triggerQuoteReply();

    expect(expandInputCollapseIfNeeded).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('does not show Quote Reply for Gemini new-chat greeting text', () => {
    document.querySelector('main')!.innerHTML = '<h1>Your move, Ivaris!</h1>';
    const greeting = document.querySelector('h1');
    if (!(greeting?.firstChild instanceof Text)) {
      throw new Error('Expected greeting text node.');
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(greeting);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const cleanup = startQuoteReply({ highlightEnabled: false });
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();

    expect(document.querySelector('.gv-quote-btn')).toBeNull();

    cleanup();
  });

  it.each([
    ['message to greeting', 'source', 'greeting'],
    ['greeting to message', 'greeting', 'source'],
  ])('does not show Quote Reply for a selection spanning %s', (_direction, anchorId, focusId) => {
    document
      .querySelector('main')!
      .insertAdjacentHTML('afterbegin', '<h1 id="greeting">Your move, Ivaris!</h1>');
    const anchorNode = document.getElementById(anchorId)?.firstChild;
    const focusNode = document.getElementById(focusId)?.firstChild;
    const greetingNode = document.getElementById('greeting')?.firstChild;
    const sourceNode = document.getElementById('source')?.firstChild;
    if (!(anchorNode instanceof Text) || !(focusNode instanceof Text)) {
      throw new Error('Expected selection boundary text nodes.');
    }
    if (!(greetingNode instanceof Text) || !(sourceNode instanceof Text)) {
      throw new Error('Expected ordered range boundary text nodes.');
    }

    const range = document.createRange();
    range.setStart(greetingNode, 0);
    range.setEnd(sourceNode, sourceNode.length);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      anchorNode,
      focusNode,
      rangeCount: 1,
      isCollapsed: false,
      toString: () => range.toString(),
      getRangeAt: () => range,
    } as unknown as Selection);

    const cleanup = startQuoteReply({ highlightEnabled: false });
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();

    expect(document.querySelector('.gv-quote-btn')).toBeNull();

    cleanup();
  });

  it('does not blur or refocus the contenteditable input after quote insertion', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    triggerQuoteReply();

    expect(inputBlurMock).not.toHaveBeenCalled();
    expect(inputFocusMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);

    cleanup();
  });

  it('activates Quote Reply from a keyboard-style click without mousedown', () => {
    const cleanup = startQuoteReply();
    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();
    const quoteButton = document.querySelector<HTMLElement>('.gv-quote-btn');
    if (!quoteButton) throw new Error('Expected quote button');

    quoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.runAllTimers();

    expect(document.getElementById('input')?.textContent).toBe('> Hello\n');
    cleanup();
  });

  it('treats ql-blank editor as empty even if placeholder text exists', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    input.classList.add('ql-blank');
    input.setAttribute('data-placeholder', 'Message Gemini');
    input.textContent = 'Message Gemini';

    triggerQuoteReply();

    expect(input.textContent).toBe('Message Gemini> Hello\n');

    cleanup();
  });

  it('treats stale ql-blank with real user text as non-empty', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    input.classList.add('ql-blank');
    input.setAttribute('data-placeholder', 'Message Gemini');
    input.textContent = '已有内容';

    triggerQuoteReply();

    expect(input.textContent).toBe('已有内容\n\n> Hello\n');

    cleanup();
  });

  it('adds a blank line when input has visible text', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    input.textContent = 'Existing';

    triggerQuoteReply();

    expect(input.textContent).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('uses single-line separator for Firefox contenteditable', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    vi.mocked(getBrowserName).mockReturnValue('Firefox');

    const execCommandMock = vi.spyOn(document, 'execCommand');
    input.textContent = 'Existing';

    triggerQuoteReply();

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, '\n');
    expect(execCommandMock).not.toHaveBeenCalledWith('insertText', false, '\n\n');
    expect(input.textContent).toBe('Existing\n> Hello\n');

    cleanup();
  });

  it('prepends two newlines for non-empty textarea input', () => {
    const cleanup = startQuoteReply();
    const inputContainer = document.getElementById('input-container');
    if (!(inputContainer instanceof HTMLElement)) {
      throw new Error('Expected input container element.');
    }

    inputContainer.innerHTML = '<textarea id="input" placeholder="Ask Gemini"></textarea>';
    const textarea = document.getElementById('input');
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('Expected textarea input element.');
    }

    textarea.getBoundingClientRect = () =>
      ({
        height: 20,
        width: 100,
        top: 0,
        left: 0,
        bottom: 20,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    installFocusTracking(textarea);
    textarea.scrollIntoView = vi.fn();
    textarea.value = 'Existing';

    triggerQuoteReply();

    expect(textarea.value).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('falls back to Range insertion when execCommand is unavailable', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    const execCommandMock = vi.spyOn(document, 'execCommand').mockReturnValue(false);
    input.textContent = 'Existing';

    triggerQuoteReply();

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, '\n\n> Hello\n');
    expect(input.textContent).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('avoids full fallback separator when separator insertion partially mutates content', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    input.textContent = 'Existing';
    const execCommandMock = vi
      .spyOn(document, 'execCommand')
      .mockImplementation((command: string, _showUI?: boolean, value?: string) => {
        if (command === 'insertText' && typeof value === 'string') {
          const stripped = value.startsWith('\n') ? value.slice(1) : value;
          input.textContent = `${input.textContent ?? ''}${stripped}`;
          return true;
        }
        return false;
      });

    triggerQuoteReply();

    expect(execCommandMock.mock.calls).toEqual(
      expect.arrayContaining([['insertText', false, '\n\n']]),
    );
    expect(execCommandMock).not.toHaveBeenCalledWith('insertText', false, '\n\n> Hello\n');
    expect(input.textContent).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('keeps leading newline fallback when separator command does not change content', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    input.textContent = 'Existing';
    const execCommandMock = vi
      .spyOn(document, 'execCommand')
      .mockImplementation((command: string, _showUI?: boolean, value?: string) => {
        if (command === 'insertText' && typeof value === 'string') {
          if (value === '\n\n') {
            return true; // Pretend success but do not mutate content
          }
          input.textContent = `${input.textContent ?? ''}${value}`;
          return true;
        }
        return false;
      });

    triggerQuoteReply();

    expect(execCommandMock.mock.calls).toEqual(
      expect.arrayContaining([
        ['insertText', false, '\n\n'],
        ['insertText', false, '\n\n> Hello\n'],
      ]),
    );
    expect(input.textContent).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('treats separator as inserted when only innerText reflects line breaks', () => {
    const cleanup = startQuoteReply();
    const input = document.getElementById('input');
    if (!(input instanceof HTMLElement)) {
      throw new Error('Expected quote input element.');
    }

    const state = {
      visible: 'Existing',
      raw: 'Existing',
    };

    Object.defineProperty(input, 'innerText', {
      configurable: true,
      get: () => state.visible,
      set: (value: string) => {
        state.visible = value;
      },
    });

    Object.defineProperty(input, 'textContent', {
      configurable: true,
      get: () => state.raw,
      set: (value: string | null) => {
        state.raw = value ?? '';
      },
    });

    const execCommandMock = vi
      .spyOn(document, 'execCommand')
      .mockImplementation((command: string, _showUI?: boolean, value?: string) => {
        if (command !== 'insertText' || typeof value !== 'string') {
          return false;
        }

        if (value === '\n\n') {
          // Simulate Quill: visual line breaks changed, raw textContent unchanged.
          state.visible = `${state.visible}\n\n`;
          return true;
        }

        state.visible = `${state.visible}${value}`;
        state.raw = `${state.raw}${value.replace(/\n/g, '')}`;
        return true;
      });

    triggerQuoteReply();

    expect(execCommandMock.mock.calls).toEqual(
      expect.arrayContaining([
        ['insertText', false, '\n\n'],
        ['insertText', false, '> Hello\n'],
      ]),
    );
    expect(execCommandMock).not.toHaveBeenCalledWith('insertText', false, '\n\n> Hello\n');
    expect(state.visible).toBe('Existing\n\n> Hello\n');

    cleanup();
  });

  it('preserves inline math LaTeX syntax in quoted text', () => {
    const cleanup = startQuoteReply();
    const source = document.getElementById('source');
    if (!source) throw new Error('Expected source element.');

    source.innerHTML =
      'Variable <span class="math-inline"><span data-math="U \\in [0, 1)">U∈[0,1)</span></span> is uniform';

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();

    const quoteButton = document.querySelector<HTMLElement>('.gv-quote-btn');
    if (!quoteButton) throw new Error('Expected quote button.');
    quoteButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    quoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.runAllTimers();

    const input = document.getElementById('input');
    if (!input) throw new Error('Expected input element.');

    expect(input.textContent).toContain('$U \\in [0, 1)$');

    cleanup();
  });

  it('preserves block math LaTeX syntax in quoted text', () => {
    const cleanup = startQuoteReply();
    const source = document.getElementById('source');
    if (!source) throw new Error('Expected source element.');

    source.innerHTML =
      'Equation: <span class="math-block"><span data-math="E = mc^2">E=mc²</span></span>';

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();

    const quoteButton = document.querySelector<HTMLElement>('.gv-quote-btn');
    if (!quoteButton) throw new Error('Expected quote button.');
    quoteButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    quoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.runAllTimers();

    const input = document.getElementById('input');
    if (!input) throw new Error('Expected input element.');

    expect(input.textContent).toContain('$$E = mc^2$$');

    cleanup();
  });

  it('preserves standalone data-math elements without container', () => {
    const cleanup = startQuoteReply();
    const source = document.getElementById('source');
    if (!source) throw new Error('Expected source element.');

    source.innerHTML = 'Value <span data-math="x^2">x²</span> here';

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.runAllTimers();

    const quoteButton = document.querySelector<HTMLElement>('.gv-quote-btn');
    if (!quoteButton) throw new Error('Expected quote button.');
    quoteButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    quoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.runAllTimers();

    const input = document.getElementById('input');
    if (!input) throw new Error('Expected input element.');

    expect(input.textContent).toContain('$x^2$');

    cleanup();
  });

  it('uses the same selection toolbar for Highlight when Quote Reply is disabled', () => {
    installHighlightConversation();
    const cleanup = startQuoteReply({ quoteEnabled: false });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    const toolbar = document.querySelector('.gv-selection-toolbar');
    const quoteButton = toolbar?.querySelector('.gv-quote-btn');
    const highlightButton = toolbar?.querySelector('.gv-highlight-action');
    expect(document.querySelectorAll('.gv-selection-toolbar')).toHaveLength(1);
    expect(quoteButton?.classList.contains('gv-hidden')).toBe(true);
    expect(highlightButton?.classList.contains('gv-hidden')).toBe(false);

    cleanup();
  });

  it('previews the selected color immediately and saves it with Highlight', async () => {
    installHighlightConversation();
    const createFromRange = vi
      .spyOn(HighlightManager.prototype, 'createFromRange')
      .mockResolvedValue(true);
    const cleanup = startQuoteReply({ quoteEnabled: false, highlightDefaultColor: 'blue' });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    const iconPaths = Array.from(
      document.querySelectorAll<SVGPathElement>('.gv-highlight-action .lucide-highlighter path'),
      (path) => path.getAttribute('d'),
    );
    expect(iconPaths).toEqual([
      'm9 11-6 6v3h9l3-3',
      'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
    ]);

    const colorButton = document.querySelector<HTMLButtonElement>('.gv-highlight-color-trigger');
    expect(colorButton?.classList.contains('gv-hidden')).toBe(false);
    expect(colorButton?.style.backgroundColor).toBe('rgb(96, 165, 250)');
    colorButton?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    colorButton?.click();

    const palette = document.querySelector('.gv-highlight-color-palette');
    expect(palette?.classList.contains('gv-hidden')).toBe(false);
    expect(palette?.getAttribute('role')).toBe('group');
    expect(palette?.querySelectorAll('.gv-highlight-color-option')).toHaveLength(5);
    expect(
      palette?.querySelector('[data-highlight-color="blue"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      palette?.querySelector('[data-highlight-color="pink"]')?.getAttribute('aria-label'),
    ).toBe('Highlight color 4');
    expect(document.getElementById('gemini-voyager-quote-reply-style')?.textContent).toContain(
      'outline: 2px solid #8ab4f8',
    );
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(palette?.classList.contains('gv-hidden')).toBe(true);
    colorButton?.click();
    const pink = palette?.querySelector<HTMLButtonElement>('[data-highlight-color="pink"]');
    pink?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    pink?.click();
    await Promise.resolve();

    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      { [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: 'pink' },
      expect.any(Function),
    );
    expect(createFromRange).not.toHaveBeenCalled();
    expect(
      document.documentElement.classList.contains('gv-highlight-selection-preview-active'),
    ).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue('--gv-highlight-selection-preview-color'),
    ).toBe('rgba(244, 114, 182, 0.38)');
    expect(palette?.classList.contains('gv-hidden')).toBe(false);

    const highlightButton = document.querySelector<HTMLButtonElement>('.gv-highlight-action');
    highlightButton?.click();
    await Promise.resolve();

    expect(createFromRange).toHaveBeenCalledWith(expect.any(Range), 'pink');
    expect(document.querySelector('.gv-selection-toolbar')?.classList.contains('gv-hidden')).toBe(
      true,
    );
    expect(
      document.documentElement.classList.contains('gv-highlight-selection-preview-active'),
    ).toBe(false);
    cleanup();
  });

  it('uses and remembers a custom highlight color', async () => {
    installHighlightConversation();
    const createFromRange = vi
      .spyOn(HighlightManager.prototype, 'createFromRange')
      .mockResolvedValue(true);
    const cleanup = startQuoteReply({ quoteEnabled: false, highlightDefaultColor: 'blue' });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    const colorButton = document.querySelector<HTMLButtonElement>('.gv-highlight-color-trigger');
    colorButton?.click();
    const editColorControl = document.querySelector<HTMLLabelElement>('.gv-highlight-color-edit');
    expect(editColorControl).toBeInstanceOf(HTMLLabelElement);
    const customColor = document.querySelector<HTMLInputElement>('.gv-highlight-custom-color');
    if (!customColor) throw new Error('Expected custom color input');
    expect(editColorControl?.contains(customColor)).toBe(true);
    expect(customColor.getAttribute('aria-label')).toBe(
      'Choose a custom highlight color · Highlight color 3',
    );
    customColor.value = '#123456';
    customColor.dispatchEvent(new Event('input', { bubbles: true }));
    customColor.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(chrome.storage.sync.set).toHaveBeenCalledWith(
      {
        [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: '#123456',
        [StorageKeys.HIGHLIGHT_COLOR_PALETTE]: ['yellow', 'green', '#123456', 'pink', '#c084fc'],
      },
      expect.any(Function),
    );
    expect(createFromRange).not.toHaveBeenCalled();
    expect(
      document.documentElement.style.getPropertyValue('--gv-highlight-selection-preview-color'),
    ).toBe('rgba(18, 52, 86, 0.38)');
    expect(
      document.querySelector('.gv-highlight-color-palette')?.classList.contains('gv-hidden'),
    ).toBe(false);

    document.querySelector<HTMLButtonElement>('.gv-highlight-action')?.click();
    await Promise.resolve();
    expect(createFromRange).toHaveBeenCalledWith(expect.any(Range), '#123456');

    cleanup();
  });

  it('keeps the palette inside the viewport near the bottom-right edge', () => {
    installHighlightConversation();
    const cleanup = startQuoteReply({ quoteEnabled: false });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    const colorButton = document.querySelector<HTMLButtonElement>('.gv-highlight-color-trigger');
    const palette = document.querySelector<HTMLElement>('.gv-highlight-color-palette');
    if (!colorButton || !palette) throw new Error('Expected highlight color controls');
    colorButton.getBoundingClientRect = () =>
      ({
        top: window.innerHeight - 30,
        bottom: window.innerHeight - 8,
        left: window.innerWidth - 30,
        right: window.innerWidth - 8,
        width: 22,
        height: 22,
        x: window.innerWidth - 30,
        y: window.innerHeight - 30,
        toJSON: () => {},
      }) as DOMRect;
    palette.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 150,
        width: 150,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    colorButton.click();

    expect(palette.style.top).toBe(`${window.innerHeight - 30 - 40 - 6}px`);
    expect(palette.style.left).toBe(`${window.innerWidth - 150 - 10}px`);
    cleanup();
  });

  it('does not leave an empty toolbar when Highlight is disabled live', () => {
    installHighlightConversation();
    const cleanup = startQuoteReply({ quoteEnabled: false, highlightEnabled: true });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    const listener = (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0];
    if (typeof listener !== 'function') throw new Error('Expected storage change listener');
    const toolbar = document.querySelector('.gv-selection-toolbar');
    expect(toolbar?.classList.contains('gv-hidden')).toBe(false);

    listener({ [StorageKeys.HIGHLIGHT_ENABLED]: { newValue: false } }, 'sync');
    expect(toolbar?.classList.contains('gv-hidden')).toBe(true);

    listener({ [StorageKeys.HIGHLIGHT_ENABLED]: { newValue: true } }, 'sync');
    expect(document.querySelector('.gv-highlight-action')?.classList.contains('gv-hidden')).toBe(
      false,
    );
    expect(toolbar?.classList.contains('gv-hidden')).toBe(false);
    cleanup();
  });

  it('hides Highlight and its color picker when the feature is disabled', () => {
    installHighlightConversation();
    const cleanup = startQuoteReply({ quoteEnabled: true, highlightEnabled: false });

    selectSourceText();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(300);

    expect(document.querySelector('.gv-highlight-action')?.classList.contains('gv-hidden')).toBe(
      true,
    );
    expect(
      document.querySelector('.gv-highlight-color-trigger')?.classList.contains('gv-hidden'),
    ).toBe(true);
    expect(document.querySelector('.gv-quote-btn')?.classList.contains('gv-hidden')).toBe(false);
    cleanup();
  });

  it('does not run Highlight until enabled and destroys it when disabled again', () => {
    const init = vi.spyOn(HighlightManager.prototype, 'init').mockResolvedValue();
    const destroy = vi.spyOn(HighlightManager.prototype, 'destroy').mockImplementation(() => {});
    const cleanup = startQuoteReply({ quoteEnabled: true, highlightEnabled: false });

    expect(init).not.toHaveBeenCalled();

    const listener = (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0];
    if (typeof listener !== 'function') throw new Error('Expected storage change listener');

    listener({ [StorageKeys.HIGHLIGHT_ENABLED]: { newValue: true } }, 'sync');
    expect(init).toHaveBeenCalledOnce();

    listener({ [StorageKeys.HIGHLIGHT_ENABLED]: { newValue: false } }, 'sync');
    expect(destroy).toHaveBeenCalledOnce();

    cleanup();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
