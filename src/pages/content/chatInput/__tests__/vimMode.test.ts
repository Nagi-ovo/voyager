import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

function setVisibleRect(element: HTMLElement): void {
  element.getBoundingClientRect = () =>
    ({
      height: 24,
      width: 320,
      top: 0,
      left: 0,
      right: 320,
      bottom: 24,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;
}

function setScrollableRect(element: HTMLElement, height: number, width = 320): void {
  let scrollTop = 0;
  let scrollLeft = 0;

  element.getBoundingClientRect = () =>
    ({
      height,
      width,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: height,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: height * 4,
  });
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
}

function mockInputVimModeStorage(enabled: boolean): void {
  (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
      callback({ [StorageKeys.INPUT_VIM_MODE]: enabled });
    },
  );
}

function createQuestionInput(text = 'hello'): HTMLElement {
  document.body.innerHTML = `
    <rich-textarea>
      <div id="question-input" contenteditable="true" role="textbox">${text}</div>
    </rich-textarea>
  `;

  const input = document.getElementById('question-input');
  if (!(input instanceof HTMLElement)) {
    throw new Error('Expected question input.');
  }

  setVisibleRect(input);
  input.focus = vi.fn();
  input.blur = vi.fn();
  return input;
}

function createQuillParagraphInput(lines: string[]): HTMLElement {
  document.body.innerHTML = `
    <rich-textarea>
      <div id="question-input" class="ql-editor" contenteditable="true" role="textbox">
        ${lines.map((line) => (line ? `<p>${line}</p>` : '<p><br></p>')).join('')}
      </div>
    </rich-textarea>
  `;

  const input = document.getElementById('question-input');
  if (!(input instanceof HTMLElement)) {
    throw new Error('Expected question input.');
  }

  Object.defineProperty(input, 'innerText', {
    configurable: true,
    get: () => lines.join('\n'),
  });

  setVisibleRect(input);
  input.focus = vi.fn();
  input.blur = vi.fn();
  return input;
}

function createQuillInlineNewlineInput(text: string): HTMLElement {
  document.body.innerHTML = `
    <rich-textarea>
      <div id="question-input" class="ql-editor" contenteditable="true" role="textbox">
        <p></p>
      </div>
    </rich-textarea>
  `;

  const input = document.getElementById('question-input');
  const paragraph = input?.querySelector('p');
  if (!(input instanceof HTMLElement) || !(paragraph instanceof HTMLElement)) {
    throw new Error('Expected Quill input with one paragraph.');
  }

  paragraph.textContent = text;
  setVisibleRect(input);
  input.focus = vi.fn();
  input.blur = vi.fn();
  return input;
}

function setParagraphRects(input: HTMLElement, topByLine: number[]): void {
  Array.from(input.children).forEach((child, index) => {
    if (!(child instanceof HTMLElement)) return;

    const top = topByLine[index] ?? 10 + index * 20;
    child.getBoundingClientRect = () =>
      ({
        height: 18,
        width: 280,
        top,
        left: 80,
        right: 360,
        bottom: top + 18,
        x: 80,
        y: top,
        toJSON: () => {},
      }) as DOMRect;
  });
}

function getParagraphTexts(input: HTMLElement): string[] {
  return Array.from(input.children).map((child) => child.textContent ?? '');
}

function addToolboxLabel(options: { hidden?: boolean; text?: string } = {}): HTMLElement {
  const label = document.createElement('div');
  label.className = 'toolbox-drawer-button-label-icon-text';
  label.innerHTML = `<span>${options.text ?? 'Tools'}</span>`;
  label.getBoundingClientRect = () =>
    ({
      height: options.hidden ? 0 : 24,
      width: options.hidden ? 0 : 80,
      top: 0,
      left: 0,
      right: options.hidden ? 0 : 80,
      bottom: options.hidden ? 0 : 24,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;

  const drawer = document.createElement('toolbox-drawer');
  drawer.appendChild(label);
  document.body.appendChild(drawer);
  return label;
}

function addPromptComposer(input: HTMLElement): HTMLElement {
  const richTextarea = input.closest('rich-textarea');
  if (!(richTextarea instanceof HTMLElement)) {
    throw new Error('Expected rich-textarea parent.');
  }

  const composer = document.createElement('div');
  composer.className = 'text-input-field';
  composer.getBoundingClientRect = () =>
    ({
      height: 64,
      width: 420,
      top: 0,
      left: 20,
      right: 440,
      bottom: 64,
      x: 20,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;
  input.getBoundingClientRect = () =>
    ({
      height: 24,
      width: 320,
      top: 20,
      left: 74,
      right: 394,
      bottom: 44,
      x: 74,
      y: 20,
      toJSON: () => {},
    }) as DOMRect;

  richTextarea.replaceWith(composer);
  composer.appendChild(richTextarea);
  return composer;
}

function addEditPromptInput(value = 'hello'): {
  editForm: HTMLElement;
  input: HTMLTextAreaElement;
  wrapper: HTMLElement;
} {
  const editContainer = document.createElement('div');
  editContainer.className = 'query-content edit-mode';
  editContainer.innerHTML = `
    <div class="edit-container">
      <mat-form-field class="edit-form">
        <div class="mat-mdc-text-field-wrapper">
          <textarea aria-label="Edit prompt"></textarea>
        </div>
      </mat-form-field>
    </div>
  `;
  document.body.prepend(editContainer);

  const input = editContainer.querySelector('textarea');
  const editForm = editContainer.querySelector('.edit-form');
  const wrapper = editContainer.querySelector('.mat-mdc-text-field-wrapper');
  if (
    !(input instanceof HTMLTextAreaElement) ||
    !(editForm instanceof HTMLElement) ||
    !(wrapper instanceof HTMLElement)
  ) {
    throw new Error('Expected edit prompt textarea.');
  }

  input.value = value;
  input.focus = vi.fn();
  editForm.getBoundingClientRect = () =>
    ({
      height: 152,
      width: 484,
      top: 0,
      left: 20,
      right: 504,
      bottom: 152,
      x: 20,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;
  wrapper.getBoundingClientRect = () =>
    ({
      height: 136,
      width: 484,
      top: 0,
      left: 20,
      right: 504,
      bottom: 136,
      x: 20,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;
  input.getBoundingClientRect = () =>
    ({
      height: 96,
      width: 428,
      top: 20,
      left: 48,
      right: 476,
      bottom: 116,
      x: 48,
      y: 20,
      toJSON: () => {},
    }) as DOMRect;

  return { editForm, input, wrapper };
}

function createTextareaInput(value: string): HTMLTextAreaElement {
  document.body.innerHTML = `<textarea id="question-input">${value}</textarea>`;

  const input = document.getElementById('question-input');
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Expected textarea input.');
  }

  setVisibleRect(input);
  input.focus = vi.fn();
  return input;
}

function fireWindowKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function fireInputKey(
  input: HTMLElement,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  input.dispatchEvent(event);
  return event;
}

function fireClick(input: HTMLElement): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  return event;
}

function fireCtrlInputKey(input: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  return event;
}

function setContentEditableSelection(input: HTMLElement, offset: number): void {
  const textNode = input.firstChild;
  if (!(textNode instanceof Text)) {
    throw new Error('Expected text node.');
  }

  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function setParagraphSelection(input: HTMLElement, lineIndex: number, offset = 0): void {
  const paragraph = input.children[lineIndex];
  if (!(paragraph instanceof HTMLElement)) {
    throw new Error('Expected paragraph.');
  }

  const textNode = Array.from(paragraph.childNodes).find((node) => node instanceof Text);
  const node = textNode ?? paragraph;
  const range = document.createRange();
  range.setStart(node, textNode ? offset : 0);
  range.collapse(true);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function mockCollapsedCaretRects(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const left = 80 + this.startOffset * 12;
      return [
        {
          height: 18,
          width: 0,
          top: 10,
          left,
          right: left,
          bottom: 28,
          x: left,
          y: 10,
          toJSON: () => {},
        } as DOMRect,
      ] as unknown as DOMRectList;
    },
  });

  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      const left = 80 + this.startOffset * 12;
      return {
        height: 18,
        width: 0,
        top: 10,
        left,
        right: left,
        bottom: 28,
        x: left,
        y: 10,
        toJSON: () => {},
      } as DOMRect;
    },
  });
}

function mockCharacterRects(
  rects: Record<
    number,
    { left: number; top: number; width: number; height?: number; missing?: boolean }
  >,
): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      const characterRect = rects[start] ?? { left: 80 + start * 10, top: 10, width: 10 };
      if (characterRect.missing) return [] as unknown as DOMRectList;
      const width = end > start ? characterRect.width : 0;
      const height = characterRect.height ?? 18;
      const right = characterRect.left + width;
      return [
        {
          height,
          width,
          top: characterRect.top,
          left: characterRect.left,
          right,
          bottom: characterRect.top + height,
          x: characterRect.left,
          y: characterRect.top,
          toJSON: () => {},
        } as DOMRect,
      ] as unknown as DOMRectList;
    },
  });

  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      const rect = this.getClientRects()[0];
      return (
        rect ??
        ({
          height: 0,
          width: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect)
      );
    },
  });
}

function mockParagraphRangeRects(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const container =
        this.startContainer instanceof HTMLElement
          ? this.startContainer
          : this.startContainer.parentElement;
      const paragraph = container?.closest('p');
      const paragraphRect = paragraph?.getBoundingClientRect();
      const top = paragraphRect?.top ?? 10;
      const left = (paragraphRect?.left ?? 80) + this.startOffset * 10;
      const width = this.endOffset > this.startOffset ? 10 : 0;
      const height = paragraphRect?.height ?? 18;

      return [
        {
          height,
          width,
          top,
          left,
          right: left + width,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => {},
        } as DOMRect,
      ] as unknown as DOMRectList;
    },
  });

  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      return (
        this.getClientRects()[0] ??
        ({
          height: 0,
          width: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect)
      );
    },
  });
}

describe('input Vim mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('focuses the question input with i when enabled', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireWindowKey('i');

    expect(input.focus).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    cleanup();
  });

  it('can be forced on by the plugin lifecycle without the Gemini setting', async () => {
    mockInputVimModeStorage(false);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode({ forceEnabled: true });

    const event = fireInputKey(input, 'Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(input.dataset.gvVimMode).toBe('normal');
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();

    cleanup();
  });

  it('mounts the mode HUD below the prompt text instead of next to the Tools button', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();
    const composer = addPromptComposer(input);
    const label = addToolboxLabel();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const hud = composer.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(hud).not.toBeNull();
    expect(hud?.parentElement).toBe(composer);
    expect(hud?.dataset.placement).toBe('composer');
    expect(hud?.style.getPropertyValue('--gv-input-vim-hud-left')).toBe('54px');
    expect(label.querySelector('.gv-input-vim-hud')).toBeNull();
    expect(composer.classList.contains('gv-input-vim-hud-composer-mount')).toBe(true);
    expect(composer.classList.contains('gv-input-vim-hud-mount')).toBe(false);

    cleanup();

    expect(composer.classList.contains('gv-input-vim-hud-composer-mount')).toBe(false);
  });

  it('anchors the composer HUD in the bottom gutter below editable text', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const composerHudBlock =
      css.match(/\.gv-input-vim-hud\[data-placement='composer'\]\s*{([\s\S]*?)}/)?.[1] ?? '';

    expect(composerHudBlock).toContain('top: auto;');
    expect(composerHudBlock).toContain('bottom: 1px;');
    expect(composerHudBlock).toContain('left: var(--gv-input-vim-hud-left, 48px);');
    expect(composerHudBlock).toContain('transform: none;');
    expect(composerHudBlock).not.toContain('top: 50%;');

    const baseHudBlock = css.match(/\.gv-input-vim-hud\s*{([\s\S]*?)}/)?.[1] ?? '';
    expect(baseHudBlock).toContain('box-sizing: border-box;');
  });

  it.each([
    {
      site: 'Claude',
      markup:
        '<fieldset><div data-testid="chat-input" class="tiptap ProseMirror" contenteditable="true" role="textbox">hello</div></fieldset>',
      inputSelector: '[data-testid="chat-input"]',
      mountSelector: 'fieldset',
    },
    {
      site: 'ChatGPT',
      markup:
        '<form><textarea aria-label="Chat with ChatGPT"></textarea><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox">hello</div></form>',
      inputSelector: '#prompt-textarea',
      mountSelector: 'form',
    },
  ])(
    'uses Vim commands and a non-overlapping HUD in $site',
    async ({ markup, inputSelector, mountSelector }) => {
      mockInputVimModeStorage(true);
      document.body.innerHTML = markup;

      const input = document.querySelector<HTMLElement>(inputSelector);
      const mount = document.querySelector<HTMLElement>(mountSelector);
      if (!input || !mount) throw new Error('Expected cross-site composer.');

      setVisibleRect(input);
      setVisibleRect(mount);
      input.focus = vi.fn();
      setContentEditableSelection(input, 1);

      const onInput = vi.fn();
      input.addEventListener('input', onInput);

      const { startInputVimMode } = await import('../vimMode');
      const cleanup = await startInputVimMode();

      fireInputKey(input, 'Escape');
      fireInputKey(input, 'x');

      expect(input.textContent).toBe('hllo');
      expect(onInput).toHaveBeenCalledTimes(1);
      expect(input.dataset.gvVimMode).toBe('normal');
      const hud = mount.querySelector<HTMLElement>('.gv-input-vim-hud');
      expect(hud?.dataset.placement).toBe('floating');
      expect(hud?.parentElement).toBe(mount);

      cleanup();
    },
  );

  it('floats the cross-site HUD above the composer instead of covering its input row', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const floatingHudBlock =
      css.match(/\.gv-input-vim-hud\[data-placement='floating'\]\s*{([\s\S]*?)}/)?.[1] ?? '';

    expect(floatingHudBlock).toContain('bottom: calc(100% + 6px);');
    expect(floatingHudBlock).toContain('left: var(--gv-input-vim-hud-left, 16px);');
    expect(floatingHudBlock).toContain('transform: none;');
  });

  it('uses Vim commands in the visible edit prompt instead of the main composer', async () => {
    mockInputVimModeStorage(true);
    const mainInput = createQuestionInput('main prompt');
    const { editForm, input, wrapper } = addEditPromptInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const escapeEvent = fireInputKey(input, 'Escape');

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(input.dataset.gvVimMode).toBe('normal');
    expect(mainInput.dataset.gvVimMode).toBeUndefined();
    const hud = editForm.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(hud).not.toBeNull();
    expect(hud?.dataset.placement).toBe('edit');
    expect(hud?.style.getPropertyValue('--gv-input-vim-hud-left')).toBe('28px');
    expect(wrapper.querySelector('.gv-input-vim-hud')).toBeNull();

    fireInputKey(input, 'x');

    expect(input.value).toBe('hllo');

    cleanup();
  });

  it('keeps the edit prompt HUD in the reserved row below its outlined textarea', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const editHudBlock =
      css.match(/\.gv-input-vim-hud\[data-placement='edit'\]\s*{([\s\S]*?)}/)?.[1] ?? '';

    expect(editHudBlock).toContain('bottom: 0;');
    expect(editHudBlock).toContain('height: 16px;');
    expect(editHudBlock).toContain('left: var(--gv-input-vim-hud-left, 28px);');
  });

  it.each([
    { site: 'Claude', saveLabel: 'Save' },
    { site: 'ChatGPT', saveLabel: 'Send' },
  ])('uses Vim commands in the $site historical-message editor', async ({ saveLabel }) => {
    mockInputVimModeStorage(true);
    const mainInput = createQuestionInput('main prompt');
    const editCard = document.createElement('div');
    editCard.innerHTML = `
        <div class="edit-scroll">
          <textarea aria-label="Edit message">hello</textarea>
        </div>
        <div class="edit-actions">
          <button type="button">Cancel</button>
          <button type="button">${saveLabel}</button>
        </div>
      `;
    document.body.prepend(editCard);

    const input = editCard.querySelector('textarea');
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Expected cross-site edit textarea.');
    }

    setVisibleRect(editCard);
    setVisibleRect(input);
    input.focus = vi.fn();
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'x');

    expect(input.value).toBe('hllo');
    expect(input.dataset.gvVimMode).toBe('normal');
    expect(mainInput.dataset.gvVimMode).toBeUndefined();
    const hud = editCard.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(hud?.dataset.placement).toBe('edit-floating');
    expect(hud?.parentElement).toBe(editCard);

    cleanup();
  });

  it('floats the cross-site edit HUD below the card without covering host controls', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const editFloatingHudBlock =
      css.match(/\.gv-input-vim-hud\[data-placement='edit-floating'\]\s*{([\s\S]*?)}/)?.[1] ?? '';

    expect(editFloatingHudBlock).toContain('top: calc(100% + 4px);');
    expect(editFloatingHudBlock).toContain('bottom: auto;');
    expect(editFloatingHudBlock).toContain('left: var(--gv-input-vim-hud-left, 12px);');
  });

  it('does not mistake a newline in the edit prompt for submitting the main composer', async () => {
    mockInputVimModeStorage(true);
    const mainInput = createQuestionInput('main prompt');
    const { input } = addEditPromptInput('edit prompt');
    input.selectionStart = 4;
    input.selectionEnd = 4;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'Enter');

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(input.dataset.gvVimMode).toBe('normal');
    expect(mainInput.dataset.gvVimMode).toBeUndefined();

    cleanup();
  });

  it('mounts the HUD on a visible Tools label instead of a stale hidden one', async () => {
    mockInputVimModeStorage(true);
    createQuestionInput();
    const hiddenLabel = addToolboxLabel({ hidden: true });
    const visibleLabel = addToolboxLabel();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    expect(hiddenLabel.querySelector('.gv-input-vim-hud')).toBeNull();
    const hud = visibleLabel.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(hud).not.toBeNull();
    expect(hud?.parentElement).toBe(visibleLabel);

    cleanup();
  });

  it('relocates the HUD when the visible Tools label appears after startup', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const initialHud = document.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(initialHud).not.toBeNull();
    expect(initialHud?.parentElement).not.toBeNull();

    const label = addToolboxLabel();
    fireInputKey(input, 'Escape');

    const hud = label.querySelector<HTMLElement>('.gv-input-vim-hud');
    expect(hud).toBe(initialHud);

    cleanup();
  });

  it('switches the question input from insert to normal mode with Escape', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireInputKey(input, 'Escape');

    expect(input.blur).not.toHaveBeenCalled();
    expect(input.dataset.gvVimMode).toBe('normal');
    expect(event.defaultPrevented).toBe(true);

    cleanup();
  });

  it('switches from insert to normal mode with Ctrl+[', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireCtrlInputKey(input, '[');

    expect(input.dataset.gvVimMode).toBe('normal');
    expect(event.defaultPrevented).toBe(true);

    cleanup();
  });

  it('allows normal typing while in insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireInputKey(input, 'a');

    expect(event.defaultPrevented).toBe(false);

    cleanup();
  });

  it('positions the normal-mode cursor at the collapsed caret rect after h/l movement', async () => {
    mockInputVimModeStorage(true);
    mockCollapsedCaretRects();
    const input = createQuestionInput();
    setContentEditableSelection(input, 2);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'l');
    window.dispatchEvent(new Event('resize'));

    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(cursor?.hidden).toBe(false);
    expect(cursor?.style.left).toBe('116px');

    cleanup();
  });

  it('flashes the Vim cursor when it moves', async () => {
    mockInputVimModeStorage(true);
    mockCollapsedCaretRects();
    const input = createQuestionInput();
    setContentEditableSelection(input, 1);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    window.dispatchEvent(new Event('resize'));
    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(cursor?.classList.contains('gv-input-vim-cursor-moving')).toBe(false);

    fireInputKey(input, 'l');
    window.dispatchEvent(new Event('resize'));

    expect(cursor?.classList.contains('gv-input-vim-cursor-moving')).toBe(true);

    cleanup();
  });

  it('sizes the normal-mode cursor to the full rendered CJK character width', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 9 },
      1: { left: 89, top: 10, width: 18 },
      2: { left: 107, top: 10, width: 9 },
    });
    const input = createQuestionInput('a你b');
    setContentEditableSelection(input, 1);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    window.dispatchEvent(new Event('resize'));

    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(cursor?.style.left).toBe('89px');
    expect(cursor?.style.width).toBe('18px');

    cleanup();
  });

  it('keeps the HUD buffer empty after a single completed H motion', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();
    setContentEditableSelection(input, 2);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'H');

    const buffer = document.querySelector<HTMLElement>('.gv-input-vim-hud-buffer');
    expect(buffer?.hidden).toBe(true);
    expect(buffer?.textContent).toBe('');

    cleanup();
  });

  it('shows count while pending and clears it after a counted H motion', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();
    setContentEditableSelection(input, 4);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, '1');
    fireInputKey(input, '2');

    const buffer = document.querySelector<HTMLElement>('.gv-input-vim-hud-buffer');
    expect(buffer?.hidden).toBe(false);
    expect(buffer?.textContent).toBe('12');

    fireInputKey(input, 'H');

    expect(buffer?.hidden).toBe(true);
    expect(buffer?.textContent).toBe('');

    cleanup();
  });

  it('shows pending operator commands in typed order', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput('one\ntwo\nthree');
    setContentEditableSelection(input, 0);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, '3');
    fireInputKey(input, 'd');

    const buffer = document.querySelector<HTMLElement>('.gv-input-vim-hud-buffer');
    expect(buffer?.hidden).toBe(false);
    expect(buffer?.textContent).toBe('3d');

    cleanup();
  });

  it('opens a line above with O and enters insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello\nworld');
    input.selectionStart = 7;
    input.selectionEnd = 7;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'O');

    expect(input.value).toBe('hello\n\nworld');
    expect(input.selectionStart).toBe(6);
    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('opens a line below with o and enters insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello\nworld');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'o');

    expect(input.value).toBe('hello\n\nworld');
    expect(input.selectionStart).toBe(6);
    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('prevents unsupported printable keys from inserting text in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    const event = fireInputKey(input, 'q');

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('hello');

    cleanup();
  });

  it('prevents Backspace and Delete from editing text in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    const backspaceEvent = fireInputKey(input, 'Backspace');
    const deleteEvent = fireInputKey(input, 'Delete');

    expect(backspaceEvent.defaultPrevented).toBe(true);
    expect(deleteEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('hello');

    cleanup();
  });

  it('prevents browser editing shortcuts from mutating text in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    const pasteEvent = fireCtrlInputKey(input, 'v');
    const undoEvent = fireCtrlInputKey(input, 'z');

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(undoEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('hello');

    cleanup();
  });

  it('allows browser editing shortcuts in insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const pasteEvent = fireCtrlInputKey(input, 'v');

    expect(pasteEvent.defaultPrevented).toBe(false);

    cleanup();
  });

  it('clamps the normal-mode caret to the final character when leaving insert at EOF', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 5;
    input.selectionEnd = 5;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');

    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(4);

    cleanup();
  });

  it('keeps x effective after leaving insert mode at EOF', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 5;
    input.selectionEnd = 5;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'x');

    expect(input.value).toBe('hell');
    expect(input.selectionStart).toBe(4);

    cleanup();
  });

  it('keeps G on the final character in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'G');

    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(4);

    cleanup();
  });

  it('moves the textarea caret with h and l in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'h');
    expect(input.selectionStart).toBe(1);

    fireInputKey(input, 'l');
    expect(input.selectionStart).toBe(2);

    cleanup();
  });

  it('moves the visible block cursor with the textarea caret', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;
    input.getBoundingClientRect = () =>
      ({
        height: 24,
        width: 200,
        top: 40,
        left: 100,
        right: 300,
        bottom: 64,
        x: 100,
        y: 40,
        toJSON: () => {},
      }) as DOMRect;
    Object.defineProperty(input, 'clientWidth', { configurable: true, value: 200 });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('gv-input-vim-textarea-mirror')) {
          return {
            height: 24,
            width: 200,
            top: 0,
            left: 0,
            right: 200,
            bottom: 24,
            x: 0,
            y: 0,
            toJSON: () => {},
          } as DOMRect;
        }

        if (this.classList.contains('gv-input-vim-textarea-marker')) {
          const offset = Number(this.dataset.gvVimOffset ?? 0);
          const line = offset >= 3 ? 1 : 0;
          const left = (line === 0 ? offset : offset - 3) * 12;
          const top = line * 24;
          return {
            height: 24,
            width: 12,
            top,
            left,
            right: left + 12,
            bottom: top + 24,
            x: left,
            y: top,
            toJSON: () => {},
          } as DOMRect;
        }

        return originalGetBoundingClientRect.call(this);
      },
    );

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'h');
    window.dispatchEvent(new Event('resize'));

    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(input.selectionStart).toBe(1);
    expect(cursor?.style.left).toBe('112px');
    expect(cursor?.style.top).toBe('40px');
    expect(cursor?.style.width).toBe('12px');
    expect(document.querySelector('.gv-input-vim-textarea-mirror')).toBeNull();

    fireInputKey(input, 'l');
    window.dispatchEvent(new Event('resize'));

    expect(input.selectionStart).toBe(2);
    expect(cursor?.style.left).toBe('124px');

    fireInputKey(input, 'j');
    window.dispatchEvent(new Event('resize'));

    expect(input.selectionStart).toBe(4);
    expect(cursor?.style.left).toBe('112px');
    expect(cursor?.style.top).toBe('64px');

    fireInputKey(input, 'k');
    expect(input.selectionStart).toBe(2);

    cleanup();
  });

  it('moves j/k between rendered lines without an extra horizontal character step', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      1: { left: 90, top: 10, width: 10 },
      2: { left: 80, top: 30, width: 10 },
      3: { left: 90, top: 30, width: 10 },
    });
    const input = createQuestionInput('abcd');
    setContentEditableSelection(input, 1);
    const selection = window.getSelection();
    const modify = vi.fn();
    if (!selection) throw new Error('Expected selection.');
    Object.defineProperty(selection, 'modify', {
      configurable: true,
      value: modify,
    });

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');

    expect(input.textContent).toBe('abcd');
    expect(selection.anchorOffset).toBe(3);

    fireInputKey(input, 'k');

    expect(selection.anchorOffset).toBe(1);
    expect(modify).not.toHaveBeenCalled();

    cleanup();
  });

  it('moves j/k through consecutive empty rendered lines', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      2: { left: 80, top: 30, width: 0 },
      3: { left: 80, top: 50, width: 0 },
      4: { left: 80, top: 70, width: 10 },
    });
    const input = createQuestionInput('a\n\n\nb');
    setContentEditableSelection(input, 0);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected selection.');

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');
    window.dispatchEvent(new Event('resize'));
    expect(selection.anchorOffset).toBe(2);
    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(cursor?.style.top).toBe('30px');

    fireInputKey(input, 'j');
    window.dispatchEvent(new Event('resize'));
    expect(selection.anchorOffset).toBe(3);
    expect(cursor?.style.top).toBe('50px');

    fireInputKey(input, 'j');
    expect(selection.anchorOffset).toBe(4);

    fireInputKey(input, 'k');
    expect(selection.anchorOffset).toBe(3);

    cleanup();
  });

  it('moves j/k through literal empty lines inside one Quill paragraph', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      2: { left: 0, top: 0, width: 0, missing: true },
      3: { left: 0, top: 0, width: 0, missing: true },
      4: { left: 80, top: 70, width: 10 },
    });
    const input = createQuillInlineNewlineInput('a\n\n\nb');
    setParagraphSelection(input, 0);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected selection.');

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');
    window.dispatchEvent(new Event('resize'));
    expect(selection.anchorOffset).toBe(2);
    const literalCursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(literalCursor?.style.top).toBe('30px');

    fireInputKey(input, 'j');
    window.dispatchEvent(new Event('resize'));
    expect(selection.anchorOffset).toBe(3);
    expect(literalCursor?.style.top).toBe('50px');

    fireInputKey(input, 'j');
    expect(selection.anchorOffset).toBe(4);

    fireInputKey(input, 'k');
    expect(selection.anchorOffset).toBe(3);

    cleanup();
  });

  it('moves j/k through Quill empty paragraphs', async () => {
    mockInputVimModeStorage(true);
    mockParagraphRangeRects();
    const input = createQuillParagraphInput(['a', '', '', 'b']);
    setParagraphRects(input, [10, 30, 50, 70]);
    setParagraphSelection(input, 0);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected selection.');

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');
    expect(selection.anchorNode).toBe(input.children[1]);

    fireInputKey(input, 'j');
    expect(selection.anchorNode).toBe(input.children[2]);

    fireInputKey(input, 'j');
    expect(selection.anchorNode).toBe(input.children[3].firstChild);

    fireInputKey(input, 'k');
    expect(selection.anchorNode).toBe(input.children[2]);

    cleanup();
  });

  it('moves onto an empty line even when the collapsed newline rect overlaps a text line', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      2: { left: 80, top: 30, width: 0 },
      3: { left: 80, top: 30, width: 10 },
    });
    const input = createQuestionInput('a\n\nb');
    setContentEditableSelection(input, 0);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected selection.');

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');

    expect(selection.anchorOffset).toBe(2);

    fireInputKey(input, 'j');
    expect(selection.anchorOffset).toBe(3);

    fireInputKey(input, 'k');
    expect(selection.anchorOffset).toBe(2);

    cleanup();
  });

  it('does not treat a trailing newline as an empty rendered line', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      2: { left: 80, top: 30, width: 10 },
    });
    const input = createQuestionInput('a\nb\n');
    setContentEditableSelection(input, 2);
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected selection.');

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');

    expect(selection.anchorOffset).toBe(2);

    cleanup();
  });

  it('uses a narrow normal-mode cursor on an empty line', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      2: { left: 80, top: 30, width: 0 },
      3: { left: 80, top: 50, width: 10 },
    });
    const input = createQuestionInput('a\n\nb');
    setContentEditableSelection(input, 2);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    window.dispatchEvent(new Event('resize'));

    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(cursor?.style.left).toBe('80px');
    expect(cursor?.style.width).toBe('9px');

    cleanup();
  });

  it('scrolls the input viewport when j moves the Vim caret below the visible area', async () => {
    mockInputVimModeStorage(true);
    mockCharacterRects({
      0: { left: 80, top: 10, width: 10 },
      1: { left: 90, top: 10, width: 10 },
      2: { left: 80, top: 90, width: 10 },
      3: { left: 90, top: 90, width: 10 },
    });
    const input = createQuestionInput('abcd');
    setScrollableRect(input, 40);
    setContentEditableSelection(input, 1);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'j');

    expect(input.scrollTop).toBeGreaterThan(0);

    cleanup();
  });

  it('returns to insert mode and hides the Vim cursor after Enter sends and clears the input', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput('send this');
    setContentEditableSelection(input, 4);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'Enter');
    input.textContent = '';

    await new Promise((resolve) => setTimeout(resolve, 120));

    const cursor = document.querySelector<HTMLElement>('.gv-input-vim-cursor');
    expect(input.dataset.gvVimMode).toBe('insert');
    expect(cursor?.hidden).toBe(true);

    cleanup();
  });

  it('returns to insert mode after clicking the send button clears the input', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput('send this');
    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send message');
    document.body.appendChild(sendButton);
    setContentEditableSelection(input, 4);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireClick(sendButton);
    input.textContent = '';

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('keeps normal mode after Enter when the input content remains', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput('send this');
    setContentEditableSelection(input, 4);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'Enter');
    input.textContent = 'send this\n';

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(input.dataset.gvVimMode).toBe('normal');

    cleanup();
  });

  it('deletes text with x in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'x');

    expect(input.value).toBe('hllo');
    expect(input.selectionStart).toBe(1);

    cleanup();
  });

  it('deletes text before the caret with X in normal mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 2;
    input.selectionEnd = 2;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'X');

    expect(input.value).toBe('hllo');
    expect(input.selectionStart).toBe(1);

    cleanup();
  });

  it('substitutes the current character with s and enters insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 's');

    expect(input.value).toBe('hllo');
    expect(input.selectionStart).toBe(1);
    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('clears the current line with cc and enters insert mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree');
    input.selectionStart = 5;
    input.selectionEnd = 5;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'c');
    fireInputKey(input, 'c');

    expect(input.value).toBe('one\n\nthree');
    expect(input.selectionStart).toBe(4);
    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('deletes exactly two lines with 2dd', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree\nfour');
    input.selectionStart = 4;
    input.selectionEnd = 4;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, '2');
    fireInputKey(input, 'd');
    fireInputKey(input, 'd');

    expect(input.value).toBe('one\nfour');
    expect(input.selectionStart).toBe(4);

    cleanup();
  });

  it('deletes a full Quill paragraph with dd instead of only text to the right', async () => {
    mockInputVimModeStorage(true);
    mockParagraphRangeRects();
    const input = createQuillParagraphInput(['one', 'two', 'three']);
    setParagraphRects(input, [10, 30, 50]);
    setParagraphSelection(input, 1, 1);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'd');
    fireInputKey(input, 'd');

    expect(getParagraphTexts(input)).toEqual(['one', 'three']);
    expect(window.getSelection()?.anchorNode).toBe(input.children[1].firstChild);

    cleanup();
  });

  it('deletes an empty Quill paragraph with dd', async () => {
    mockInputVimModeStorage(true);
    mockParagraphRangeRects();
    const input = createQuillParagraphInput(['one', '', 'three']);
    setParagraphRects(input, [10, 30, 50]);
    setParagraphSelection(input, 1);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'd');
    fireInputKey(input, 'd');

    expect(getParagraphTexts(input)).toEqual(['one', 'three']);
    expect(window.getSelection()?.anchorNode).toBe(input.children[1].firstChild);

    cleanup();
  });

  it('completes dd even when the second d keydown is marked repeat', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree');
    input.selectionStart = 4;
    input.selectionEnd = 4;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'd');
    fireInputKey(input, 'd', { repeat: true });

    expect(input.value).toBe('one\nthree');
    expect(input.selectionStart).toBe(4);

    cleanup();
  });

  it('ignores repeated destructive keydown events after 2dd', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree\nfour\nfive');
    input.selectionStart = 4;
    input.selectionEnd = 4;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, '2');
    fireInputKey(input, 'd');
    fireInputKey(input, 'd');
    const repeatEvent = fireInputKey(input, 'd', { repeat: true });

    expect(repeatEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('one\nfour\nfive');

    cleanup();
  });

  it('extends selection in visual mode and deletes it', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'v');
    fireInputKey(input, 'l');
    fireInputKey(input, 'l');

    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(3);

    fireInputKey(input, 'd');

    expect(input.value).toBe('hlo');
    expect(input.dataset.gvVimMode).toBe('normal');

    cleanup();
  });

  it('changes selected text with c in visual mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'v');
    fireInputKey(input, 'l');
    fireInputKey(input, 'l');
    fireInputKey(input, 'c');

    expect(input.value).toBe('hlo');
    expect(input.dataset.gvVimMode).toBe('insert');

    cleanup();
  });

  it('copies selected text with y in visual mode', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('hello');
    input.selectionStart = 1;
    input.selectionEnd = 1;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'v');
    fireInputKey(input, 'l');
    fireInputKey(input, 'l');
    fireInputKey(input, 'y');

    expect(writeText).toHaveBeenCalledWith('el');
    expect(input.dataset.gvVimMode).toBe('normal');

    cleanup();
  });

  it('pastes a yy line above the current line with P', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree');
    input.selectionStart = 5;
    input.selectionEnd = 5;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'y');
    fireInputKey(input, 'y');
    fireInputKey(input, 'P');

    expect(input.value).toBe('one\ntwo\ntwo\nthree');
    expect(input.selectionStart).toBe(4);

    cleanup();
  });

  it('pastes a yy line below the current line with p', async () => {
    mockInputVimModeStorage(true);
    const input = createTextareaInput('one\ntwo\nthree');
    input.selectionStart = 5;
    input.selectionEnd = 5;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(input, 'Escape');
    fireInputKey(input, 'y');
    fireInputKey(input, 'y');
    fireInputKey(input, 'p');

    expect(input.value).toBe('one\ntwo\ntwo\nthree');
    expect(input.selectionStart).toBe(8);

    cleanup();
  });

  it('clears undo history when the active input changes', async () => {
    mockInputVimModeStorage(true);
    const firstInput = createTextareaInput('hello');
    firstInput.selectionStart = 1;
    firstInput.selectionEnd = 1;

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    fireInputKey(firstInput, 'Escape');
    fireInputKey(firstInput, 'x');
    expect(firstInput.value).toBe('hllo');

    const secondInput = createTextareaInput('world');
    secondInput.selectionStart = 1;
    secondInput.selectionEnd = 1;
    secondInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    fireInputKey(secondInput, 'Escape');
    fireInputKey(secondInput, 'u');

    expect(secondInput.value).toBe('world');

    cleanup();
  });

  it('does not steal keys while another editable element is focused', async () => {
    mockInputVimModeStorage(true);
    const input = createQuestionInput();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireInputKey(otherInput, 'i');

    expect(input.focus).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    cleanup();
  });

  it('does nothing while disabled', async () => {
    mockInputVimModeStorage(false);
    const input = createQuestionInput();

    const { startInputVimMode } = await import('../vimMode');
    const cleanup = await startInputVimMode();

    const event = fireWindowKey('i');

    expect(input.focus).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    cleanup();
  });
});
