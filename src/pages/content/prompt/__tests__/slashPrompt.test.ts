import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';

import {
  hasSlashEligiblePrompts,
  isGeminiSlashPromptSurface,
  matchSlashPrompts,
  startPromptSlashCommand,
} from '../slashPrompt';

const prompts: PromptItem[] = [
  {
    id: 'translate',
    name: 'Translator',
    text: 'Translate the following text into Chinese.',
    tags: ['writing', 'language'],
    createdAt: 1,
  },
  {
    id: 'review',
    name: 'Code Review',
    text: 'Review this code and report correctness issues.',
    tags: ['code'],
    createdAt: 2,
  },
  {
    id: 'legacy',
    text: 'Legacy body without a name',
    tags: ['legacy'],
    createdAt: 3,
  },
];

function setRect(element: HTMLElement, rect: Partial<DOMRect> = {}): void {
  element.getBoundingClientRect = () =>
    ({
      x: 20,
      y: 300,
      top: 300,
      left: 20,
      right: 420,
      bottom: 360,
      width: 400,
      height: 60,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect;
}

function createContentEditable(text: string): HTMLElement {
  document.body.innerHTML = `<rich-textarea><div id="question-input" contenteditable="true" role="textbox"></div></rich-textarea>`;
  const input = document.getElementById('question-input')!;
  input.textContent = text;
  setRect(input);
  input.focus();
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return input;
}

function typeInto(input: HTMLElement): void {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(
  input: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, 'key'> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    ...init,
    key,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  return event;
}

describe('matchSlashPrompts', () => {
  it('matches only prompt names and excludes legacy prompts without names', () => {
    expect(matchSlashPrompts(prompts, 'review').map((item) => item.id)).toEqual(['review']);
    expect(matchSlashPrompts(prompts, 'correctness')).toEqual([]);
    expect(matchSlashPrompts(prompts, 'legacy')).toEqual([]);
  });

  it('excludes every member of a normalized duplicate-name group', () => {
    const duplicateNames: PromptItem[] = [
      { id: 'first', name: 'Translator', text: 'First body', tags: [], createdAt: 1 },
      { id: 'second', name: 'ＴＲＡＮＳＬＡＴＯＲ', text: 'Second body', tags: [], createdAt: 2 },
      { id: 'unique', name: 'Summarizer', text: 'Unique body', tags: [], createdAt: 3 },
    ];

    expect(matchSlashPrompts(duplicateNames, 'translator')).toEqual([]);
    expect(matchSlashPrompts(duplicateNames, 'summarizer').map((item) => item.id)).toEqual([
      'unique',
    ]);
  });

  it('restores slash eligibility as soon as duplicate prompts have unique names', () => {
    const items: PromptItem[] = [
      { id: 'first', name: 'Translator', text: 'First body', tags: [], createdAt: 1 },
      { id: 'second', name: 'translator', text: 'Second body', tags: [], createdAt: 2 },
    ];

    expect(matchSlashPrompts(items, 'translator')).toEqual([]);

    items[1] = { ...items[1], name: 'Editor' };

    expect(matchSlashPrompts(items, 'translator').map((item) => item.id)).toEqual(['first']);
    expect(matchSlashPrompts(items, 'editor').map((item) => item.id)).toEqual(['second']);
  });
});

describe('hasSlashEligiblePrompts', () => {
  it('requires a non-empty name that is not part of a normalized conflict group', () => {
    const duplicateNames: PromptItem[] = [
      { id: 'first', name: 'Translator', text: 'First body', tags: [], createdAt: 1 },
      { id: 'second', name: 'ＴＲＡＮＳＬＡＴＯＲ', text: 'Second body', tags: [], createdAt: 2 },
      { id: 'legacy', text: 'Legacy body', tags: [], createdAt: 3 },
      { id: 'blank', name: '  ', text: 'Blank name', tags: [], createdAt: 4 },
    ];

    expect(hasSlashEligiblePrompts(duplicateNames)).toBe(false);
    expect(
      hasSlashEligiblePrompts([
        ...duplicateNames,
        { id: 'unique', name: 'Summarizer', text: 'Unique body', tags: [], createdAt: 5 },
      ]),
    ).toBe(true);
  });
});

describe('isGeminiSlashPromptSurface', () => {
  it('allows Gemini surfaces and rejects AI Studio and plugin platforms', () => {
    expect(isGeminiSlashPromptSurface('https://gemini.google.com/app')).toBe(true);
    expect(isGeminiSlashPromptSurface('https://business.gemini.google/app')).toBe(true);
    expect(isGeminiSlashPromptSurface('https://aistudio.google.com/prompts/new_chat')).toBe(false);
    expect(isGeminiSlashPromptSurface('https://chatgpt.com/c/abc')).toBe(false);
    expect(isGeminiSlashPromptSurface('https://claude.ai/chat/abc')).toBe(false);
  });
});

describe('slash prompt completion', () => {
  let destroy: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    destroy?.();
    destroy = null;
    document.body.innerHTML = '';
  });

  it('shows only matching names and tags, with the body in a hover tooltip', () => {
    const input = createContentEditable('/trans');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;

    typeInto(input);

    const list = document.getElementById('gv-pm-slash-list')!;
    expect(list.textContent).toContain('Translator');
    expect(list.textContent).toContain('writing');
    expect(list.textContent).toContain('language');
    expect(list.textContent).not.toContain('Translate the following');
    expect(list.textContent).not.toContain('Code Review');

    const option = list.querySelector<HTMLElement>('.gv-pm-slash-option')!;
    option.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('gv-pm-slash-tooltip')?.textContent).toBe(
      'Translate the following text into Chinese.',
    );
  });

  it('anchors completion beside the slash inside a fullscreen composer', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 52,
        top: 80,
        right: 60,
        bottom: 102,
        width: 8,
        height: 22,
        x: 52,
        y: 80,
        toJSON: () => ({}),
      }),
    });

    try {
      const input = createContentEditable('/');
      setRect(input, { top: 40, bottom: 720, height: 680 });
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      const list = document.getElementById('gv-pm-slash-list')!;
      setRect(list, { height: 144 });

      typeInto(input);

      const root = document.getElementById('gv-pm-slash-root')!;
      expect(root.style.left).toBe('52px');
      expect(root.style.top).toBe('108px');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('keeps completion above a bottom composer when there is no room below the slash', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 52,
        top: 700,
        right: 60,
        bottom: 722,
        width: 8,
        height: 22,
        x: 52,
        y: 700,
        toJSON: () => ({}),
      }),
    });

    try {
      const input = createContentEditable('/');
      setRect(input, { top: 680, bottom: 748, height: 68 });
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      const list = document.getElementById('gv-pm-slash-list')!;
      setRect(list, { height: 144 });

      typeInto(input);

      const root = document.getElementById('gv-pm-slash-root')!;
      expect(root.style.left).toBe('52px');
      expect(root.style.top).toBe('550px');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('confirms with Enter and renders an inline name token backed by the prompt body', () => {
    const input = createContentEditable('/trans');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    const event = press(input, 'Enter');

    expect(event.defaultPrevented).toBe(true);
    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    expect(token.dataset.gvPromptName).toBe('Translator');
    expect(token.textContent).toBe('Translator');
    expect(token.dataset.gvPromptText).toBe('Translate the following text into Chinese.');
    expect(token.hasAttribute('title')).toBe(false);
    expect(input.classList.contains('gv-pm-slash-contenteditable-hide-value')).toBe(false);
    expect(token.style.getPropertyValue('color')).toBe('rgb(11, 87, 208)');
    expect(token.style.getPropertyPriority('color')).toBe('important');
    const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
    expect(marker.classList.contains('gv-pm-slash-textarea-token-native')).toBe(true);
    expect(marker.style.left).toBe('20px');
    expect(marker.style.top).toBe('300px');
    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);

    token.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('gv-pm-slash-tooltip')?.textContent).toBe(
      'Translate the following text into Chinese.',
    );
  });

  it('expands a selected contenteditable prompt before destroying slash completion', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    destroy();

    expect(input.textContent?.trim()).toBe('Review this code and report correctness issues.');
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
  });

  it('keeps the caret visible at the input start when Home is pressed after selection', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    const event = press(input, 'Home');
    const range = window.getSelection()!.getRangeAt(0);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(range.collapsed).toBe(true);
    expect(token.contains(range.startContainer)).toBe(false);
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(input);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    expect(prefixRange.toString()).toBe('');
  });

  it('does not reopen completion for a slash contained inside a selected prompt body', () => {
    const input = createContentEditable('/review');
    const withPath = prompts.map((prompt) =>
      prompt.id === 'review' ? { ...prompt, text: 'Review https://example.com/a/b.' } : prompt,
    );
    destroy = startPromptSlashCommand({ initialItems: withPath }).destroy;
    typeInto(input);
    press(input, 'Enter');

    typeInto(input);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
  });

  it('keeps an external marker when Gemini rebuilds the editor and sends the body', async () => {
    const input = createContentEditable('/review');
    input.addEventListener('input', () => {
      if (input.querySelector('.gv-pm-slash-token')) input.textContent = 'Code Review';
    });
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
    expect(marker.textContent).toBe('Code Review');
    expect(marker.classList.contains('gv-pm-slash-textarea-token-native')).toBe(false);
    marker.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('gv-pm-slash-tooltip')?.textContent).toBe(
      'Review this code and report correctness issues.',
    );

    setRect(input, { left: 40, top: 180 });
    input.textContent = 'Code Review\n\nMy note';
    typeInto(input);
    expect(marker.style.left).toBe('40px');
    expect(marker.style.top).toBe('180px');

    let sentText = '';
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sentText = input.textContent || '';
    });
    press(input, 'Enter');
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(sentText).toContain('Review this code and report correctness issues.');
  });

  it('expands a rebuilt prompt alongside a later live token when sending', async () => {
    const input = createContentEditable('/trans');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const rebuiltToken = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    rebuiltToken.replaceWith(document.createTextNode(rebuiltToken.textContent || ''));
    input.append(document.createTextNode('/review'));
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);
    press(input, 'Enter');

    expect(input.querySelectorAll('.gv-pm-slash-token')).toHaveLength(1);

    let sentText = '';
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sentText = input.textContent || '';
    });
    press(input, 'Enter');
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(sentText).toContain('Translate the following text into Chinese.');
    expect(sentText).toContain('Review this code and report correctness issues.');
  });

  it('preserves blank lines when expanding a rebuilt multiline prompt', async () => {
    const multilinePrompt: PromptItem = {
      ...prompts[0],
      text: 'Line 1\n\nLine 3',
    };
    const input = createContentEditable('/trans');
    destroy = startPromptSlashCommand({ initialItems: [multilinePrompt] }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const rebuiltToken = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    rebuiltToken.replaceWith(document.createTextNode(rebuiltToken.textContent || ''));
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();

    press(input, 'Enter');
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    const renderedChildren = Array.from(input.childNodes).filter(
      (node) => node.nodeName === 'BR' || node.textContent?.trim() !== '',
    );
    expect(renderedChildren.map((node) => `${node.nodeName}:${node.textContent}`)).toEqual([
      '#text:Line 1',
      'BR:',
      'BR:',
      '#text:Line 3',
    ]);
  });

  it('expands a rebuilt prompt after an earlier live token when sending', async () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    input.append(document.createTextNode('/trans'));
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);
    press(input, 'Enter');

    const tokens = input.querySelectorAll<HTMLElement>('.gv-pm-slash-token');
    tokens[1].replaceWith(document.createTextNode(tokens[1].textContent || ''));
    expect(input.querySelectorAll('.gv-pm-slash-token')).toHaveLength(1);

    let sentText = '';
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sentText = input.textContent || '';
    });
    press(input, 'Enter');
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(sentText).toContain('Review this code and report correctness issues.');
    expect(sentText).toContain('Translate the following text into Chinese.');
  });

  it('anchors the marker to a prompt range after preceding text and multiline reflow', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    let rangeRect = { left: 140, top: 220, right: 220, bottom: 246, width: 80, height: 26 };
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...rangeRect, x: rangeRect.left, y: rangeRect.top, toJSON: () => ({}) }),
    });

    try {
      const input = createContentEditable('Before /review');
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      typeInto(input);
      press(input, 'Enter');

      const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
      expect(marker.style.left).toBe('140px');
      expect(marker.style.top).toBe('220px');

      rangeRect = { left: 156, top: 164, right: 236, bottom: 190, width: 80, height: 26 };
      input.textContent = 'Before Code Review\n\nMy note';
      typeInto(input);
      expect(marker.style.left).toBe('156px');
      expect(marker.style.top).toBe('164px');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('hides the marker when the prompt range is outside the editor viewport', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 140,
        top: 220,
        right: 220,
        bottom: 246,
        width: 80,
        height: 26,
        x: 140,
        y: 220,
        toJSON: () => ({}),
      }),
    });

    try {
      const input = createContentEditable('/review');
      setRect(input, { top: 300, bottom: 360 });
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      typeInto(input);
      press(input, 'Enter');

      const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
      expect(marker.hidden).toBe(true);

      setRect(input, { top: 180, bottom: 260 });
      typeInto(input);
      expect(marker.hidden).toBe(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('positions each rebuilt marker over its own prompt name', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        const left = 100 + this.startOffset * 10;
        return {
          left,
          top: 180,
          right: left + 80,
          bottom: 206,
          width: 80,
          height: 26,
          x: left,
          y: 180,
          toJSON: () => ({}),
        };
      },
    });

    try {
      const input = createContentEditable('/trans');
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      typeInto(input);
      press(input, 'Enter');

      input.append(document.createTextNode('/review'));
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      typeInto(input);
      press(input, 'Enter');

      input.textContent = 'Translator\u00a0Code Review\u00a0';
      typeInto(input);
      const markers = Array.from(
        document.querySelectorAll<HTMLElement>('.gv-pm-slash-textarea-token'),
      );

      expect(markers.map((marker) => marker.textContent)).toEqual(['Translator', 'Code Review']);
      expect(markers[0].style.left).toBe('100px');
      expect(markers[1].style.left).toBe('210px');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('copies typography from the rebuilt node that contains a mixed-script prompt name', () => {
    const metaPrompt: PromptItem = {
      id: 'meta',
      name: '元Prompt(杠杆)',
      text: 'Long meta prompt body.',
      tags: [],
      createdAt: 4,
    };
    const input = createContentEditable('/元');
    destroy = startPromptSlashCommand({ initialItems: [...prompts, metaPrompt] }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const paragraph = document.createElement('p');
    paragraph.style.fontFamily = 'serif';
    paragraph.style.fontSize = '19px';
    paragraph.style.fontWeight = '500';
    paragraph.style.lineHeight = '27px';
    paragraph.style.letterSpacing = '0.4px';
    paragraph.textContent = '元Prompt(杠杆)\u00a0';
    input.replaceChildren(paragraph);
    typeInto(input);

    const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
    expect(marker.style.fontFamily).toBe('serif');
    expect(marker.style.fontSize).toBe('19px');
    expect(marker.style.fontWeight).toBe('500');
    expect(marker.style.lineHeight).toBe('27px');
    expect(marker.style.letterSpacing).toBe('0.4px');
  });

  it('keeps a long prompt tooltip open while the pointer moves onto and scrolls it', () => {
    const hideGraceMs = 151;
    vi.useFakeTimers();
    try {
      const longText = Array.from({ length: 20 }, () => prompts[1].text).join('\n');
      const longPrompts = prompts.map((prompt) =>
        prompt.id === 'review' ? { ...prompt, text: longText } : prompt,
      );
      const input = createContentEditable('/review');
      destroy = startPromptSlashCommand({ initialItems: longPrompts }).destroy;
      typeInto(input);
      press(input, 'Enter');

      const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
      marker.dispatchEvent(new MouseEvent('mouseenter'));
      const tooltip = document.getElementById('gv-pm-slash-tooltip')!;
      marker.dispatchEvent(new MouseEvent('mouseleave'));
      tooltip.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(hideGraceMs);

      expect(tooltip.classList.contains('gv-pm-slash-tooltip-visible')).toBe(true);
      tooltip.scrollTop = 120;
      expect(tooltip.scrollTop).toBe(120);
      tooltip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      expect(tooltip.classList.contains('gv-pm-slash-tooltip-visible')).toBe(true);

      tooltip.dispatchEvent(new MouseEvent('mouseleave'));
      vi.advanceTimersByTime(hideGraceMs);
      expect(tooltip.classList.contains('gv-pm-slash-tooltip-visible')).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('repositions the marker when the editor grows without emitting an input event', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    let resizeCallback: ResizeObserverCallback = () => {
      throw new Error('ResizeObserver callback was not registered');
    };
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    });

    try {
      const input = createContentEditable('/review');
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      typeInto(input);
      press(input, 'Enter');

      setRect(input, { left: 52, top: 140 });
      resizeCallback([], {} as ResizeObserver);

      const marker = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
      expect(marker.style.left).toBe('52px');
      expect(marker.style.top).toBe('140px');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      }
    }
  });

  it('supports arrow navigation and Tab confirmation', () => {
    const input = createContentEditable('/');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    press(input, 'ArrowDown');
    const event = press(input, 'Tab');

    expect(event.defaultPrevented).toBe(true);
    expect(input.querySelector<HTMLElement>('.gv-pm-slash-token')?.dataset.gvPromptName).toBe(
      'Translator',
    );
  });

  it.each(['/ ', 'A / B'])(
    'does not complete a slash query starting with whitespace: %s',
    (text) => {
      const input = createContentEditable(text);
      const promptsWithB: PromptItem[] = [
        ...prompts,
        { id: 'b', name: 'B', text: 'Prompt B body.', tags: [], createdAt: 4 },
      ];
      destroy = startPromptSlashCommand({ initialItems: promptsWithB }).destroy;

      typeInto(input);

      expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
      expect(press(input, 'Enter').defaultPrevented).toBe(false);
      expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    },
  );

  it('still completes a slash query when the name immediately follows the slash', () => {
    const input = createContentEditable('/B');
    const promptsWithB: PromptItem[] = [
      ...prompts,
      { id: 'b', name: 'B', text: 'Prompt B body.', tags: [], createdAt: 4 },
    ];
    destroy = startPromptSlashCommand({ initialItems: promptsWithB }).destroy;

    typeInto(input);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(false);
    expect(document.getElementById('gv-pm-slash-list')?.textContent).toContain('B');
    expect(press(input, 'Enter').defaultPrevented).toBe(true);
    expect(input.querySelector<HTMLElement>('.gv-pm-slash-token')?.dataset.gvPromptName).toBe('B');
  });

  it('filters and completes a multi-word prompt name after an internal space', () => {
    const input = createContentEditable('/Daily S');
    const dailyStandup: PromptItem = {
      id: 'daily-standup',
      name: 'Daily Standup',
      text: 'Summarize yesterday, today, and blockers.',
      tags: [],
      createdAt: 4,
    };
    destroy = startPromptSlashCommand({ initialItems: [...prompts, dailyStandup] }).destroy;

    typeInto(input);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(false);
    expect(document.getElementById('gv-pm-slash-list')?.textContent).toContain('Daily Standup');
    expect(press(input, 'Enter').defaultPrevented).toBe(true);
    expect(input.querySelector<HTMLElement>('.gv-pm-slash-token')?.dataset.gvPromptName).toBe(
      'Daily Standup',
    );
  });

  it('closes completion immediately when the slash query is deleted', () => {
    const input = createContentEditable('/');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(false);

    const event = press(input, 'Backspace');

    expect(event.defaultPrevented).toBe(false);
    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
  });

  it('closes completion for beforeinput deletion commands', () => {
    const input = createContentEditable('/');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
  });

  it('reopens completion after deletion when the remaining text is still a slash query', () => {
    const input = createContentEditable('/trans');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    press(input, 'Backspace');
    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);

    input.textContent = '/tran';
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    typeInto(input);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(false);
    expect(document.getElementById('gv-pm-slash-list')?.textContent).toContain('Translator');
  });

  it('removes the external prompt marker when the editor content is deleted', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).not.toBeNull();

    input.replaceChildren();
    typeInto(input);

    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
    expect(input.classList.contains('gv-pm-slash-contenteditable-hide-value')).toBe(false);
    expect(press(input, 'Enter').defaultPrevented).toBe(false);
  });

  it('removes the marker when Gemini replaces the editor after deleting a full selection', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).not.toBeNull();

    const replacement = document.createElement('div');
    replacement.id = 'question-input';
    replacement.setAttribute('contenteditable', 'true');
    replacement.setAttribute('role', 'textbox');
    setRect(replacement);
    input.replaceWith(replacement);
    typeInto(replacement);

    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
    expect(press(replacement, 'Enter').defaultPrevented).toBe(false);
  });

  it('clears the marker before Ctrl+A Backspace deletes the editor content', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    press(input, 'Backspace');

    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
    expect(input.classList.contains('gv-pm-slash-contenteditable-hide-value')).toBe(false);
  });

  it('updates the prompt anchor when text is inserted before its name', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect',
    );
    let capturedStartOffset = -1;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        capturedStartOffset = this.startOffset;
        return {
          left: 120,
          top: 180,
          right: 200,
          bottom: 206,
          width: 80,
          height: 26,
          x: 120,
          y: 180,
          toJSON: () => ({}),
        };
      },
    });

    try {
      const input = createContentEditable('/review');
      destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
      typeInto(input);
      press(input, 'Enter');
      input.textContent = 'Before Code Review';
      typeInto(input);
      expect(capturedStartOffset).toBe(7);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      }
    }
  });

  it('removes the prompt spacer before removing the prompt with Backspace', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    expect(input.textContent).toBe('Code Review\u00a0');
    const spacerEvent = press(input, 'Backspace');

    expect(spacerEvent.defaultPrevented).toBe(true);
    expect(input.textContent).toBe('Code Review');
    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();
    expect(document.querySelector('.gv-pm-slash-textarea-token')).not.toBeNull();
    expect(document.activeElement).toBe(input);

    const promptEvent = press(input, 'Backspace');

    expect(promptEvent.defaultPrevented).toBe(true);
    expect(input.textContent).toBe('');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
  });

  it('does not treat matching ordinary text after a rebuilt prompt as an atomic prompt', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    token.replaceWith(document.createTextNode(token.textContent || ''));
    input.append(document.createTextNode('Code Review'));
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);

    const backspaceEvent = press(input, 'Backspace');

    expect(backspaceEvent.defaultPrevented).toBe(false);
    expect(input.textContent).toBe('Code Review\u00a0Code Review');
    expect(document.querySelectorAll('.gv-pm-slash-textarea-token')).toHaveLength(1);

    const sendEvent = press(input, 'Enter');

    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.textContent).toBe(
      'Review this code and report correctness issues.\u00a0Code Review',
    );
  });

  it('removes a rebuilt prompt spacer before removing its remembered range', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    token.replaceWith(document.createTextNode(token.textContent || ''));
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);

    const spacerEvent = press(input, 'Backspace');
    const promptEvent = press(input, 'Backspace');

    expect(spacerEvent.defaultPrevented).toBe(true);
    expect(promptEvent.defaultPrevented).toBe(true);
    expect(input.textContent).toBe('');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
  });

  it('expands the stored prompt occurrence when the same name already appears earlier', () => {
    const input = createContentEditable('Code Review notes: /review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    input.textContent = 'Code Review notes: Code Review\u00a0';
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);

    press(input, 'Enter');

    expect(input.textContent).toBe(
      'Code Review notes: Review this code and report correctness issues.\u00a0',
    );
  });

  it('keeps a rebuilt prompt anchored when the same name is inserted before it', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    input.textContent = 'Code Review';
    typeInto(input);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(input.firstChild!, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    input.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: 'Code Review ',
        inputType: 'insertFromPaste',
      }),
    );
    input.textContent = 'Code Review Code Review';
    typeInto(input);

    press(input, 'Enter');

    expect(input.textContent).toBe('Code Review Review this code and report correctness issues.');
  });

  it('removes the repeated prompt token immediately before the caret', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    const firstToken = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;

    input.append(document.createTextNode('/review'));
    const caret = document.createRange();
    caret.selectNodeContents(input);
    caret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);
    typeInto(input);
    press(input, 'Enter');
    const tokens = input.querySelectorAll<HTMLElement>('.gv-pm-slash-token');
    const secondToken = tokens[1];

    const spacerEvent = press(input, 'Backspace');
    const event = press(input, 'Backspace');

    expect(spacerEvent.defaultPrevented).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(firstToken.isConnected).toBe(true);
    expect(secondToken.isConnected).toBe(false);
    expect(input.querySelectorAll('.gv-pm-slash-token')).toHaveLength(1);
  });

  it('preserves the first prompt styling and focus after deleting a later prompt', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    const firstToken = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    const firstColor = firstToken.style.getPropertyValue('color');

    input.append(document.createTextNode('hello /trans'));
    const secondCaret = document.createRange();
    secondCaret.selectNodeContents(input);
    secondCaret.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(secondCaret);
    typeInto(input);
    press(input, 'Enter');
    const secondToken = input.querySelectorAll<HTMLElement>('.gv-pm-slash-token')[1];

    press(input, 'Backspace');
    press(input, 'Backspace');

    expect(firstToken.isConnected).toBe(true);
    expect(secondToken.isConnected).toBe(false);
    expect(document.querySelectorAll('.gv-pm-slash-textarea-token')).toHaveLength(1);
    expect(firstToken.style.getPropertyValue('color')).toBe(firstColor);
    expect(firstToken.style.getPropertyPriority('color')).toBe('important');

    const spacer = firstToken.nextSibling!;
    while (spacer.nextSibling) spacer.nextSibling.remove();
    const firstCaret = document.createRange();
    firstCaret.setStartAfter(spacer);
    firstCaret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(firstCaret);
    typeInto(input);

    const spacerEvent = press(input, 'Backspace');

    expect(spacerEvent.defaultPrevented).toBe(true);
    expect(firstToken.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);

    const firstEvent = press(input, 'Backspace');

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(firstToken.isConnected).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(selection.rangeCount).toBe(1);
    expect(input.contains(selection.getRangeAt(0).commonAncestorContainer)).toBe(true);
  });

  it('keeps the caret at the removed prompt when Gemini rebuilds the editor', async () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    const spacer = token.nextSibling!;
    token.before(document.createTextNode('Three '));
    spacer.after(document.createTextNode('after'));
    const caret = document.createRange();
    caret.setStartAfter(spacer);
    caret.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(caret);

    input.addEventListener('input', () => {
      const text = input.textContent || '';
      queueMicrotask(() => {
        input.textContent = text;
        const end = document.createRange();
        end.selectNodeContents(input);
        end.collapse(false);
        selection.removeAllRanges();
        selection.addRange(end);
      });
    });

    press(input, 'Backspace');
    await Promise.resolve();
    press(input, 'Backspace');
    await Promise.resolve();

    const prefix = selection.getRangeAt(0).cloneRange();
    prefix.selectNodeContents(input);
    prefix.setEnd(selection.focusNode!, selection.focusOffset);
    expect(input.textContent).toBe('Three after');
    expect(prefix.toString()).toBe('Three ');
  });

  it('does not remove the prompt when Backspace follows two line breaks', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const token = input.querySelector<HTMLElement>('.gv-pm-slash-token')!;
    input.append(document.createElement('br'), document.createElement('br'));
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = press(input, 'Backspace');

    expect(event.defaultPrevented).toBe(false);
    expect(token.isConnected).toBe(true);
    expect(document.querySelector('.gv-pm-slash-textarea-token')).not.toBeNull();
  });

  it('confirms with a left mouse press without moving the editor selection', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    const option = document.querySelector<HTMLElement>('.gv-pm-slash-option')!;
    option.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
    );

    expect(input.querySelector<HTMLElement>('.gv-pm-slash-token')?.dataset.gvPromptName).toBe(
      'Code Review',
    );
  });

  it('unwraps inline tokens to plain prompt text before a send Enter reaches the host page', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    const sendEvent = press(input, 'Enter');

    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.textContent).toContain('Review this code and report correctness issues.');
    expect(input.classList.contains('gv-pm-slash-contenteditable-hide-value')).toBe(false);
  });

  it('materializes line breaks when expanding a multiline prompt for send', () => {
    const multilinePrompt: PromptItem = {
      id: 'structured',
      name: 'Structured',
      text: 'Please analyze:\n\n1. Find the issue\n2. Suggest a fix',
      tags: [],
      createdAt: 4,
    };
    const input = createContentEditable('/structured');
    destroy = startPromptSlashCommand({ initialItems: [multilinePrompt] }).destroy;
    typeInto(input);
    press(input, 'Enter');

    press(input, 'Enter');

    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.querySelectorAll('br')).toHaveLength(3);
    expect(input.textContent).toContain('Please analyze:');
    expect(input.textContent).toContain('1. Find the issue');
    expect(input.textContent).toContain('2. Suggest a fix');
    expect(
      Array.from(input.childNodes).some((node) => node instanceof Text && node.data.includes('\n')),
    ).toBe(false);
  });

  it('preserves the token on plain Enter when Ctrl/Cmd+Enter send mode is enabled', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({
      initialItems: prompts,
      initialCtrlEnterSend: true,
    }).destroy;
    typeInto(input);
    press(input, 'Tab');

    const newlineEvent = press(input, 'Enter');

    expect(newlineEvent.defaultPrevented).toBe(false);
    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();
    expect(input.textContent).toBe('Code Review\u00a0');

    const sendEvent = press(input, 'Enter', { ctrlKey: true });

    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.textContent).toContain('Review this code and report correctness issues.');
  });

  it('updates the Ctrl/Cmd+Enter send mode when the sync setting changes', () => {
    const input = createContentEditable('/review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Tab');
    const addStorageListener = chrome.storage.onChanged.addListener as unknown as ReturnType<
      typeof vi.fn
    >;
    const storageListener = addStorageListener.mock.calls.at(-1)?.[0] as
      | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
      | undefined;

    storageListener?.(
      { [StorageKeys.CTRL_ENTER_SEND]: { oldValue: false, newValue: true } },
      'sync',
    );
    const newlineEvent = press(input, 'Enter');

    expect(storageListener).toBeDefined();
    expect(newlineEvent.defaultPrevented).toBe(false);
    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();
  });

  it('does not reopen completion from a slash in the expanded body before replaying Enter', async () => {
    const input = createContentEditable('/slash');
    const slashBodyPrompt: PromptItem = {
      id: 'slash-body',
      name: 'Slash Body',
      text: 'Use /review',
      tags: [],
      createdAt: 4,
    };
    destroy = startPromptSlashCommand({
      initialItems: [slashBodyPrompt, ...prompts],
    }).destroy;
    typeInto(input);
    press(input, 'Enter');

    let hostEnterCount = 0;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') hostEnterCount++;
    });
    press(input, 'Enter');
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(hostEnterCount).toBe(1);
    expect(input.textContent).toBe('Use /review\u00a0');
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
  });

  it('expands each live inline prompt exactly once when sending', () => {
    const input = createContentEditable('First /review');
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    input.append(document.createTextNode(', then /trans'));
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    typeInto(input);
    press(input, 'Enter');
    input.append(document.createTextNode('.'));

    press(input, 'Enter');

    expect(input.textContent).toBe(
      'First Review this code and report correctness issues.\u00a0, then Translate the following text into Chinese.\u00a0.',
    );
  });

  it('unwraps inline tokens before a programmatic send-button click', () => {
    document.body.innerHTML = `
      <form>
        <rich-textarea><div id="question-input" contenteditable="true" role="textbox">/review</div></rich-textarea>
        <button type="button" aria-label="Send message"></button>
      </form>
    `;
    const input = document.getElementById('question-input')!;
    const send = document.querySelector<HTMLButtonElement>('button')!;
    setRect(input);
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    send.click();

    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.textContent).toContain('Review this code and report correctness issues.');
  });

  it.each([
    ['localized label', '<button type="button" aria-label="发送消息"></button>', 'button'],
    [
      'icon only',
      '<button type="button"><span class="material-symbols-outlined">send</span></button>',
      '.material-symbols-outlined',
    ],
  ])('unwraps inline tokens for a %s send button', (_name, buttonHtml, clickSelector) => {
    document.body.innerHTML = `
      <form>
        <rich-textarea><div id="question-input" contenteditable="true" role="textbox">/review</div></rich-textarea>
        ${buttonHtml}
      </form>
    `;
    const input = document.getElementById('question-input')!;
    const clickTarget = document.querySelector<HTMLElement>(clickSelector)!;
    setRect(input);
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    clickTarget.click();

    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.textContent).toContain('Review this code and report correctness issues.');
  });

  it('does not unwrap prompts for an unrelated send-looking button', () => {
    const input = createContentEditable('/review');
    const feedback = document.createElement('button');
    feedback.setAttribute('aria-label', 'Send feedback');
    document.body.appendChild(feedback);
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');

    feedback.click();

    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();
    expect(input.textContent).toBe('Code Review\u00a0');
  });

  it('unwraps tokens only when their chat form is submitted', () => {
    document.body.innerHTML =
      '<form id="chat-form"><rich-textarea><div id="question-input" contenteditable="true" role="textbox"></div></rich-textarea></form>';
    const input = document.getElementById('question-input')!;
    input.textContent = '/review';
    setRect(input);
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const chatForm = document.getElementById('chat-form')!;
    const unrelatedForm = document.createElement('form');
    document.body.appendChild(unrelatedForm);
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();

    unrelatedForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(input.querySelector('.gv-pm-slash-token')).not.toBeNull();

    chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(input.querySelector('.gv-pm-slash-token')).toBeNull();
    expect(input.textContent).toContain('Review this code and report correctness issues.');
  });

  it('replaces a textarea query and keeps a hoverable name marker inside the composer', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    input.value = 'Please /review';
    input.setSelectionRange(input.value.length, input.value.length);
    setRect(input);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    press(input, 'Tab');

    expect(input.value.trimEnd()).toBe('Please Code Review');
    expect(document.querySelector('.gv-pm-slash-textarea-token')?.textContent).toBe('Code Review');
  });

  it('shows a selected prompt name in a textarea and expands its body only when sending', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    setRect(input);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);

    press(input, 'Enter');

    const token = document.querySelector<HTMLElement>('.gv-pm-slash-textarea-token')!;
    expect(input.value.trimEnd()).toBe('Code Review');
    expect(input.classList.contains('gv-pm-slash-textarea-hide-value')).toBe(true);
    expect(token.textContent).toBe('Code Review');
    expect(token.hasAttribute('title')).toBe(false);

    token.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.getElementById('gv-pm-slash-tooltip')?.textContent).toBe(
      'Review this code and report correctness issues.',
    );

    press(input, 'Enter');
    expect(input.value.trimEnd()).toBe('Review this code and report correctness issues.');
    expect(input.classList.contains('gv-pm-slash-textarea-hide-value')).toBe(false);
  });

  it('expands a selected textarea prompt before destroying slash completion', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    setRect(input);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Tab');

    destroy();

    expect(input.value.trimEnd()).toBe('Review this code and report correctness issues.');
    expect(input.classList.contains('gv-pm-slash-textarea-hide-value')).toBe(false);
    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
  });

  it('reveals textarea text typed after a selected prompt and preserves it when sending', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    setRect(input);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Tab');

    expect(input.classList.contains('gv-pm-slash-textarea-hide-value')).toBe(true);

    input.setRangeText('Focus on security.', input.selectionStart, input.selectionEnd, 'end');
    typeInto(input);

    expect(input.value).toContain('Code Review\u00a0Focus on security.');
    expect(input.classList.contains('gv-pm-slash-textarea-hide-value')).toBe(false);
    expect(document.querySelector('.gv-pm-slash-textarea-token')?.textContent).toBe('Code Review');

    press(input, 'Enter');
    expect(input.value).toContain(
      'Review this code and report correctness issues.\u00a0Focus on security.',
    );
  });

  it('removes a selected textarea prompt with two Backspaces', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    setRect(input);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Tab');

    const spacerEvent = press(input, 'Backspace');

    expect(spacerEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('Code Review');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).not.toBeNull();

    const event = press(input, 'Backspace');

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(document.querySelector('.gv-pm-slash-textarea-token')).toBeNull();
  });

  it('keeps later textarea prompts tracked when a selected earlier prompt is deleted', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    setRect(input);
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    input.setRangeText(' /trans', input.value.length, input.value.length, 'end');
    typeInto(input);
    press(input, 'Enter');

    input.setSelectionRange(0, 'Code Review'.length);
    const deleteEvent = press(input, 'Delete');
    input.setRangeText('', 0, 'Code Review'.length, 'start');
    typeInto(input);

    expect(deleteEvent.defaultPrevented).toBe(false);
    expect(document.querySelectorAll('.gv-pm-slash-textarea-token')).toHaveLength(1);
    expect(document.querySelector('.gv-pm-slash-textarea-token')?.textContent).toBe('Translator');

    input.setSelectionRange(input.value.length, input.value.length);
    const sendEvent = press(input, 'Enter');

    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.value).toContain('Translate the following text into Chinese.');
    expect(input.value).not.toContain('Translator');
  });

  it('does not forget a textarea prompt when deleting ordinary text with the same name', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    setRect(input);
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    input.setRangeText('Code Review', input.value.length, input.value.length, 'end');
    typeInto(input);

    const ordinaryStart = input.value.lastIndexOf('Code Review');
    input.setSelectionRange(ordinaryStart, ordinaryStart + 'Code Review'.length);
    press(input, 'Delete');
    input.setRangeText('', ordinaryStart, ordinaryStart + 'Code Review'.length, 'start');
    typeInto(input);

    expect(document.querySelectorAll('.gv-pm-slash-textarea-token')).toHaveLength(1);
    input.setSelectionRange(input.value.length, input.value.length);
    const sendEvent = press(input, 'Enter');
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.value).toContain('Review this code and report correctness issues.');
  });

  it('does not treat matching ordinary text before the caret as a textarea prompt', () => {
    document.body.innerHTML = '<div class="input-area"><textarea></textarea></div>';
    const input = document.querySelector('textarea')!;
    setRect(input);
    input.value = '/review';
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;
    typeInto(input);
    press(input, 'Enter');
    input.setRangeText('Code Review', input.value.length, input.value.length, 'end');
    typeInto(input);

    const backspaceEvent = press(input, 'Backspace');

    expect(backspaceEvent.defaultPrevented).toBe(false);
    expect(input.value).toBe('Code Review\u00a0Code Review');
    expect(document.querySelectorAll('.gv-pm-slash-textarea-token')).toHaveLength(1);

    const sendEvent = press(input, 'Enter');
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe('Review this code and report correctness issues.\u00a0Code Review');
  });

  it('ignores the Prompt Manager form textarea', () => {
    document.body.innerHTML = `
      <div class="gv-pm-panel"><textarea class="gv-pm-input-text"></textarea></div>
      <rich-textarea><div id="question-input" contenteditable="true" role="textbox"></div></rich-textarea>
    `;
    const promptTextarea = document.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!;
    promptTextarea.value = '/review';
    const chatInput = document.getElementById('question-input')!;
    setRect(chatInput);
    destroy = startPromptSlashCommand({ initialItems: prompts }).destroy;

    typeInto(promptTextarea);

    expect(document.getElementById('gv-pm-slash-root')?.hidden).toBe(true);
  });
});
