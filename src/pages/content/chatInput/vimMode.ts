import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { expandInputWithCursorAtEnd } from '../inputCollapse';
import { findChatInput } from './index';

type VimMode = 'insert' | 'normal' | 'visual';
type PendingOperator = 'd' | 'c' | 'y';
type MotionKind = 'char-left' | 'char-right' | 'word-forward' | 'word-backward' | 'word-end';
type LineMotionKind = 'line-start' | 'line-first-nonblank' | 'line-end';

interface VimState {
  mode: VimMode;
  countBuffer: string;
  pendingOperator: PendingOperator | null;
  commandBuffer: string;
  visualAnchor: number | null;
  yankBuffer: string;
  yankLinewise: boolean;
  desiredColumn: number | null;
  desiredRenderedColumn: number | null;
  undoStack: string[];
}

interface GraphemeRange {
  start: number;
  end: number;
}

interface RenderedCharacter {
  start: number;
  end: number;
  rect: DOMRect;
  centerX: number;
  isEmptyLine?: boolean;
}

interface RenderedLine {
  top: number;
  bottom: number;
  items: RenderedCharacter[];
}

interface SegmentLike {
  segment: string;
  index: number;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<SegmentLike>;
}

interface LogicalLine {
  start: number;
  end: number;
}

interface BlockLineEntry {
  element: HTMLElement;
  start: number;
  end: number;
  isEmpty: boolean;
}

interface HudMountTarget {
  element: HTMLElement;
  input: HTMLElement | null;
  placement: 'composer' | 'floating' | 'edit' | 'edit-floating' | 'inline';
}

interface FindVimInputOptions {
  requireVisible?: boolean;
  target?: HTMLElement | null;
}

interface StartInputVimModeOptions {
  /** PluginHost owns enable/disable state on third-party platforms. */
  forceEnabled?: boolean;
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
};

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="textbox"]';
const EDIT_PROMPT_SELECTOR = [
  '.query-content.edit-mode textarea',
  '.edit-container textarea',
  'textarea[aria-label="Edit prompt"]',
  'textarea[aria-label="Edit message"]',
].join(',');
const MODE_CLASS_PREFIX = 'gv-input-vim-mode-';
const HUD_CLASS = 'gv-input-vim-hud';
const HUD_MOUNT_CLASS = 'gv-input-vim-hud-mount';
const HUD_COMPOSER_MOUNT_CLASS = 'gv-input-vim-hud-composer-mount';
const HUD_MODE_CLASS = 'gv-input-vim-hud-mode';
const HUD_BUFFER_CLASS = 'gv-input-vim-hud-buffer';
const CURSOR_CLASS = 'gv-input-vim-cursor';
const CURSOR_MOVING_CLASS = 'gv-input-vim-cursor-moving';
const TEXTAREA_MIRROR_CLASS = 'gv-input-vim-textarea-mirror';
const TEXTAREA_MARKER_CLASS = 'gv-input-vim-textarea-marker';
const NORMAL_CURSOR_WIDTH = 9;
const MAX_UNDO_DEPTH = 50;
const CARET_SCROLL_PADDING = 12;
const SEND_RECONCILE_DELAY_MS = 80;
const SEND_RECONCILE_ATTEMPTS = 8;
const CURSOR_MOVE_FLASH_MS = 70;
const SEND_BUTTON_SELECTOR = [
  '.update-button',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[data-tooltip*="Send"]',
  'button[data-tooltip*="send"]',
  'button mat-icon[fonticon="send"]',
  '[data-send-button]',
  '.send-button',
  'button[aria-label*="Update"]',
  'button[aria-label*="Save"]',
  'button[aria-label*="更新"]',
].join(',');

const state: VimState = {
  mode: 'insert',
  countBuffer: '',
  pendingOperator: null,
  commandBuffer: '',
  visualAnchor: null,
  yankBuffer: '',
  yankLinewise: false,
  desiredColumn: null,
  desiredRenderedColumn: null,
  undoStack: [],
};

let isEnabled = false;
let isListenerActive = false;
let activeInput: HTMLElement | null = null;
let keydownHandler: ((event: KeyboardEvent) => void) | null = null;
let clickHandler: ((event: MouseEvent) => void) | null = null;
let focusInHandler: ((event: FocusEvent) => void) | null = null;
let focusOutHandler: ((event: FocusEvent) => void) | null = null;
let selectionChangeHandler: (() => void) | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let hudElement: HTMLElement | null = null;
let hudMountElement: HTMLElement | null = null;
let cursorElement: HTMLElement | null = null;
let cursorUpdateRaf: number | null = null;
let cursorMoveFlashTimer: number | null = null;
let lastCursorBox: {
  top: number;
  left: number;
  width: number;
  height: number;
  mode: VimMode;
} | null = null;
let hudRetryTimer: number | null = null;
let hudRetryAttempts = 0;
let sendReconcileTimer: number | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getGraphemeRanges(text: string): GraphemeRange[] {
  const ranges: GraphemeRange[] = [];
  const Segmenter = typeof Intl === 'undefined' ? undefined : (Intl as IntlWithSegmenter).Segmenter;

  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const segment of segmenter.segment(text)) {
      ranges.push({
        start: segment.index,
        end: segment.index + segment.segment.length,
      });
    }
    return ranges;
  }

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const nextIndex = index + (codePoint && codePoint > 0xffff ? 2 : 1);
    ranges.push({ start: index, end: nextIndex });
    index = nextIndex;
  }

  return ranges;
}

function getNextGraphemeOffset(text: string, offset: number): number {
  const current = clamp(offset, 0, text.length);
  for (const range of getGraphemeRanges(text)) {
    if (current < range.start) return range.start;
    if (current < range.end) return range.end;
  }

  return text.length;
}

function getPreviousGraphemeOffset(text: string, offset: number): number {
  const current = clamp(offset, 0, text.length);
  const ranges = getGraphemeRanges(text);

  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index];
    if (current > range.start) return range.start;
  }

  return 0;
}

function moveTextOffsetByGraphemes(
  text: string,
  offset: number,
  direction: -1 | 1,
  count: number,
): number {
  let nextOffset = clamp(offset, 0, text.length);

  for (let index = 0; index < count; index++) {
    nextOffset =
      direction < 0
        ? getPreviousGraphemeOffset(text, nextOffset)
        : getNextGraphemeOffset(text, nextOffset);
  }

  return nextOffset;
}

function getLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n') continue;

    lines.push({ start, end: index });
    start = index + 1;
  }

  lines.push({ start, end: text.length });
  return lines;
}

function resetCommandState(clearCommand = true, preserveDesiredColumn = false): void {
  state.countBuffer = '';
  state.pendingOperator = null;
  if (clearCommand) {
    state.commandBuffer = '';
  }
  if (!preserveDesiredColumn) {
    state.desiredColumn = null;
    state.desiredRenderedColumn = null;
  }
}

function getInputText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement) {
    return input.value;
  }

  const blocks = getLineBlockElements(input);
  if (blocks.length > 0) {
    return blocks
      .map((block) => (isEmptyLineBlock(block) ? '' : getLineBlockText(block)))
      .join('\n');
  }

  return input.innerText ?? input.textContent ?? '';
}

function isLineBlockElement(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    (element.tagName === 'P' || element.tagName === 'DIV' || element.tagName === 'LI')
  );
}

function getLineBlockElements(input: HTMLElement): HTMLElement[] {
  return Array.from(input.children).filter(isLineBlockElement);
}

function getLineBlockText(element: HTMLElement): string {
  return element.textContent?.replace(/\u200b/g, '') ?? '';
}

function isEmptyLineBlock(element: HTMLElement): boolean {
  return getLineBlockText(element).trim().length === 0;
}

function getBlockLineEntries(input: HTMLElement): BlockLineEntry[] {
  const blocks = getLineBlockElements(input);
  if (blocks.length === 0) return [];

  const entries: BlockLineEntry[] = [];
  let offset = 0;

  blocks.forEach((element, index) => {
    const text = isEmptyLineBlock(element) ? '' : getLineBlockText(element);
    const start = offset;
    const end = start + text.length;

    entries.push({
      element,
      start,
      end,
      isEmpty: text.length === 0,
    });

    offset = end;
    if (index < blocks.length - 1) {
      offset += 1;
    }
  });

  return entries;
}

function getBlockLineIndexAtOffset(entries: BlockLineEntry[], offset: number): number {
  const directIndex = entries.findIndex((entry) => offset >= entry.start && offset <= entry.end);
  if (directIndex >= 0) return directIndex;

  for (let index = entries.length - 1; index >= 0; index--) {
    if (offset >= entries[index].start) return index;
  }

  return 0;
}

function clearLineBlockElement(element: HTMLElement): void {
  element.textContent = '';
  element.appendChild(document.createElement('br'));
}

function setInputText(input: HTMLElement, text: string): void {
  if (input instanceof HTMLTextAreaElement) {
    input.value = text;
  } else {
    input.classList.toggle('ql-blank', text.length === 0);
    input.textContent = text;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findBlockLineEntry(input: HTMLElement, node: Node): BlockLineEntry | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  if (!element) return null;

  return (
    getBlockLineEntries(input).find(
      (entry) => entry.element === element || entry.element.contains(element),
    ) ?? null
  );
}

function getRangePointOffset(input: HTMLElement, node: Node, offset: number): number | null {
  const entry = findBlockLineEntry(input, node);
  if (!entry) return null;

  if (entry.isEmpty) return entry.start;

  const range = document.createRange();
  range.selectNodeContents(entry.element);
  range.setEnd(node, offset);
  return clamp(entry.start + range.toString().length, entry.start, entry.end);
}

function getSelectionRange(input: HTMLElement): { start: number; end: number } {
  const text = getInputText(input);

  if (input instanceof HTMLTextAreaElement) {
    return {
      start: clamp(input.selectionStart ?? 0, 0, text.length),
      end: clamp(input.selectionEnd ?? input.selectionStart ?? 0, 0, text.length),
    };
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { start: text.length, end: text.length };
  }

  const activeRange = selection.getRangeAt(0);
  if (!input.contains(activeRange.commonAncestorContainer)) {
    return { start: text.length, end: text.length };
  }

  const blockStart = getRangePointOffset(
    input,
    activeRange.startContainer,
    activeRange.startOffset,
  );
  const blockEnd = getRangePointOffset(input, activeRange.endContainer, activeRange.endOffset);
  if (blockStart !== null && blockEnd !== null) {
    return {
      start: clamp(blockStart, 0, text.length),
      end: clamp(blockEnd, 0, text.length),
    };
  }

  const startRange = document.createRange();
  startRange.selectNodeContents(input);
  startRange.setEnd(activeRange.startContainer, activeRange.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(input);
  endRange.setEnd(activeRange.endContainer, activeRange.endOffset);

  return {
    start: clamp(startRange.toString().length, 0, text.length),
    end: clamp(endRange.toString().length, 0, text.length),
  };
}

function findTextPositionInElement(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let lastTextNode: Node | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    lastTextNode = node;
    const length = node.textContent?.length ?? 0;

    if (currentOffset + length >= targetOffset) {
      return {
        node,
        offset: clamp(targetOffset - currentOffset, 0, length),
      };
    }

    currentOffset += length;
  }

  if (lastTextNode) {
    return { node: lastTextNode, offset: lastTextNode.textContent?.length ?? 0 };
  }

  return { node: root, offset: 0 };
}

function findBlockLineTextPosition(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } | null {
  const entries = getBlockLineEntries(root);
  if (entries.length === 0) return null;

  for (const entry of entries) {
    if (entry.isEmpty && targetOffset === entry.start) {
      return { node: entry.element, offset: 0 };
    }

    if (!entry.isEmpty && targetOffset >= entry.start && targetOffset <= entry.end) {
      return findTextPositionInElement(entry.element, targetOffset - entry.start);
    }
  }

  return null;
}

function findTextPosition(root: HTMLElement, targetOffset: number): { node: Node; offset: number } {
  return (
    findBlockLineTextPosition(root, targetOffset) ?? findTextPositionInElement(root, targetOffset)
  );
}

function createRangeForTextOffsets(root: HTMLElement, start: number, end = start): Range {
  const text = getInputText(root);
  const range = document.createRange();
  const rangeStart = findTextPosition(root, clamp(start, 0, text.length));
  const rangeEnd = findTextPosition(root, clamp(end, 0, text.length));

  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);
  return range;
}

function hasScrollableContent(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
}

function getScrollContainer(input: HTMLElement): HTMLElement | null {
  if (hasScrollableContent(input)) return input;

  for (
    let element = input.parentElement;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (hasScrollableContent(element)) return element;
  }

  return null;
}

function scrollRectIntoContainer(container: HTMLElement, rect: DOMRect): void {
  const containerRect = container.getBoundingClientRect();
  const scrollTop = container.scrollTop;
  const scrollLeft = container.scrollLeft;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);

  if (rect.bottom > containerRect.bottom - CARET_SCROLL_PADDING) {
    container.scrollTop = clamp(
      scrollTop + (rect.bottom - containerRect.bottom) + CARET_SCROLL_PADDING,
      0,
      maxScrollTop,
    );
  } else if (rect.top < containerRect.top + CARET_SCROLL_PADDING) {
    container.scrollTop = clamp(
      scrollTop - (containerRect.top - rect.top) - CARET_SCROLL_PADDING,
      0,
      maxScrollTop,
    );
  }

  if (rect.right > containerRect.right - CARET_SCROLL_PADDING) {
    container.scrollLeft = clamp(
      scrollLeft + (rect.right - containerRect.right) + CARET_SCROLL_PADDING,
      0,
      maxScrollLeft,
    );
  } else if (rect.left < containerRect.left + CARET_SCROLL_PADDING) {
    container.scrollLeft = clamp(
      scrollLeft - (containerRect.left - rect.left) - CARET_SCROLL_PADDING,
      0,
      maxScrollLeft,
    );
  }
}

function scrollCaretIntoView(input: HTMLElement, offset: number): void {
  const container = getScrollContainer(input);
  if (!container) return;

  const rect = getCaretRect(input, offset);
  if (!rect) return;

  scrollRectIntoContainer(container, rect);
}

function setInputSelection(input: HTMLElement, start: number, end = start): void {
  const text = getInputText(input);
  const nextStart = clamp(start, 0, text.length);
  const nextEnd = clamp(end, 0, text.length);

  if (input instanceof HTMLTextAreaElement) {
    input.selectionStart = nextStart;
    input.selectionEnd = nextEnd;
    input.focus();
    scrollCaretIntoView(input, nextEnd);
    scheduleCursorUpdate();
    return;
  }

  const selection = window.getSelection();
  if (!selection) return;

  const range = createRangeForTextOffsets(input, nextStart, nextEnd);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }

  scrollCaretIntoView(input, nextEnd);
  scheduleCursorUpdate();
}

function getCaretOffset(input = activeInput): number {
  if (!input) return 0;
  const range = getSelectionRange(input);
  return range.end;
}

function pushUndo(input: HTMLElement): void {
  const snapshot = getInputText(input);
  const previous = state.undoStack.at(-1);

  if (previous !== snapshot) {
    state.undoStack.push(snapshot);
    if (state.undoStack.length > MAX_UNDO_DEPTH) {
      state.undoStack.shift();
    }
  }
}

function clearUndoStack(): void {
  state.undoStack = [];
}

function restoreUndo(input: HTMLElement): void {
  const snapshot = state.undoStack.pop();
  if (typeof snapshot !== 'string') return;

  setInputText(input, snapshot);
  setInputSelection(input, snapshot.length);
}

function applyTextChange(input: HTMLElement, text: string, caret: number): void {
  pushUndo(input);
  setInputText(input, text);
  setInputSelection(input, caret);
}

function applyContentEditableRangeChange(
  input: HTMLElement,
  from: number,
  to: number,
  replacement: string,
): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  pushUndo(input);

  const range = createRangeForTextOffsets(input, from, to);
  selection.removeAllRanges();
  selection.addRange(range);
  range.deleteContents();

  if (replacement) {
    const textNode = document.createTextNode(replacement);
    range.insertNode(textNode);
  }

  input.classList.toggle('ql-blank', getInputText(input).length === 0);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  setInputSelection(input, from + replacement.length);
  return true;
}

function normalizeLinewiseText(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function writeClipboard(text: string, linewise = false): void {
  if (!text) return;

  const nextText = linewise ? normalizeLinewiseText(text) : text;
  state.yankBuffer = nextText;
  state.yankLinewise = linewise;
  const writePromise = navigator.clipboard?.writeText?.(nextText);
  void writePromise?.catch(() => {
    // The in-memory buffer is enough for Vim paste when clipboard access is blocked.
  });
}

function completeCommand(preserveDesiredColumn = false): void {
  resetCommandState(true, preserveDesiredColumn);
  updateHud();
}

function replaceRange(input: HTMLElement, start: number, end: number, replacement = ''): string {
  const text = getInputText(input);
  const from = clamp(Math.min(start, end), 0, text.length);
  const to = clamp(Math.max(start, end), 0, text.length);
  const removed = text.slice(from, to);

  if (
    !(input instanceof HTMLTextAreaElement) &&
    applyContentEditableRangeChange(input, from, to, replacement)
  ) {
    return removed;
  }

  applyTextChange(
    input,
    `${text.slice(0, from)}${replacement}${text.slice(to)}`,
    from + replacement.length,
  );
  return removed;
}

function openLine(input: HTMLElement, above: boolean, count: number): void {
  const text = getInputText(input);
  const caret = getCaretOffset(input);
  const insertAt = above ? getLineStart(text, caret) : getLineEnd(text, caret);
  const newlines = '\n'.repeat(Math.max(1, count));
  const nextCaret = above ? insertAt : insertAt + 1;

  replaceRange(input, insertAt, insertAt, newlines);
  setInputSelection(input, nextCaret);
  completeCommand();
  enterMode('insert');
}

function getLineStart(text: string, offset: number): number {
  const index = text.lastIndexOf('\n', clamp(offset - 1, 0, text.length));
  return index < 0 ? 0 : index + 1;
}

function getLineEnd(text: string, offset: number): number {
  const index = text.indexOf('\n', clamp(offset, 0, text.length));
  return index < 0 ? text.length : index;
}

function getNormalModeCaretOffset(text: string, offset: number): number {
  const current = clamp(offset, 0, text.length);
  if (text.length === 0) return 0;

  const lineStart = getLineStart(text, current);
  const lineEnd = getLineEnd(text, current);
  if (lineStart === lineEnd) return lineStart;
  if (current >= lineEnd) return getPreviousGraphemeOffset(text, lineEnd);
  return current;
}

function getNextLineStart(text: string, offset: number): number {
  const currentEnd = getLineEnd(text, offset);
  return currentEnd >= text.length ? text.length : currentEnd + 1;
}

function getPreviousLineStart(text: string, offset: number): number {
  const currentStart = getLineStart(text, offset);
  if (currentStart === 0) return 0;
  return getLineStart(text, currentStart - 1);
}

function getColumn(text: string, offset: number): number {
  return offset - getLineStart(text, offset);
}

function getLineMotionOffset(text: string, offset: number, kind: LineMotionKind): number {
  const lineStart = getLineStart(text, offset);
  const lineEnd = getLineEnd(text, offset);

  if (kind === 'line-start') return lineStart;
  if (kind === 'line-end') return lineEnd;

  const line = text.slice(lineStart, lineEnd);
  const firstNonblank = line.search(/\S/);
  return firstNonblank < 0 ? lineStart : lineStart + firstNonblank;
}

function moveVertical(text: string, offset: number, direction: -1 | 1, count: number): number {
  let targetLineStart = getLineStart(text, offset);
  const column = state.desiredColumn ?? getColumn(text, offset);
  state.desiredColumn = column;

  for (let i = 0; i < count; i++) {
    targetLineStart =
      direction < 0
        ? getPreviousLineStart(text, targetLineStart)
        : getNextLineStart(text, targetLineStart);
  }

  const targetLineEnd = getLineEnd(text, targetLineStart);
  return clamp(targetLineStart + column, targetLineStart, targetLineEnd);
}

function isWordChar(char: string): boolean {
  if (!char) return false;
  return /[\p{L}\p{N}_]/u.test(char);
}

function findWordForward(text: string, offset: number, count: number): number {
  let index = clamp(offset, 0, text.length);

  for (let step = 0; step < count; step++) {
    if (index < text.length && isWordChar(text[index])) {
      while (index < text.length && isWordChar(text[index])) index++;
    }

    while (index < text.length && !isWordChar(text[index])) index++;
  }

  return index;
}

function findWordBackward(text: string, offset: number, count: number): number {
  let index = clamp(offset, 0, text.length);

  for (let step = 0; step < count; step++) {
    if (index > 0) index--;
    while (index > 0 && !isWordChar(text[index])) index--;
    while (index > 0 && isWordChar(text[index - 1])) index--;
  }

  return index;
}

function findWordEnd(text: string, offset: number, count: number): number {
  let index = clamp(offset, 0, text.length);

  for (let step = 0; step < count; step++) {
    if (index < text.length && isWordChar(text[index])) index++;
    while (index < text.length && !isWordChar(text[index])) index++;
    while (index + 1 < text.length && isWordChar(text[index + 1])) index++;
  }

  return clamp(index, 0, text.length);
}

function getMotionOffset(input: HTMLElement, kind: MotionKind, count: number): number {
  const text = getInputText(input);
  const caret = getCaretOffset(input);
  state.desiredColumn = null;

  if (kind === 'char-left') return moveTextOffsetByGraphemes(text, caret, -1, count);
  if (kind === 'char-right') return moveTextOffsetByGraphemes(text, caret, 1, count);
  if (kind === 'word-forward') return findWordForward(text, caret, count);
  if (kind === 'word-backward') return findWordBackward(text, caret, count);
  return findWordEnd(text, caret, count);
}

function getCount(defaultValue = 1): number {
  const count = Number.parseInt(state.countBuffer, 10);
  return Number.isFinite(count) && count > 0 ? count : defaultValue;
}

function enterMode(mode: VimMode): void {
  state.mode = mode;

  if (mode !== 'visual') {
    state.visualAnchor = null;
  }

  if (mode === 'normal' && activeInput) {
    const text = getInputText(activeInput);
    const caret = getCaretOffset(activeInput);
    const normalCaret = getNormalModeCaretOffset(text, caret);
    if (normalCaret !== caret) {
      setInputSelection(activeInput, normalCaret);
    }
  }

  updateInputModeClasses();
  updateHud();
  scheduleCursorUpdate();
}

function setActiveInput(input: HTMLElement | null): void {
  if (activeInput === input) return;

  if (activeInput) {
    activeInput.classList.remove(
      `${MODE_CLASS_PREFIX}insert`,
      `${MODE_CLASS_PREFIX}normal`,
      `${MODE_CLASS_PREFIX}visual`,
    );
    delete activeInput.dataset.gvVimMode;
  }

  activeInput = input;
  resetCommandState();
  clearUndoStack();

  if (input) {
    enterMode('insert');
  } else {
    hideCursor();
    updateHud();
  }
}

function clearSendReconcileTimer(): void {
  if (sendReconcileTimer !== null) {
    clearTimeout(sendReconcileTimer);
    sendReconcileTimer = null;
  }
}

function returnToInsertAfterSubmit(input: HTMLElement | null): void {
  const nextInput =
    (input?.isConnected ? input : null) ??
    findVimInput() ??
    findVimInput({ requireVisible: false });

  if (!nextInput) {
    setActiveInput(null);
    return;
  }

  if (activeInput !== nextInput) {
    setActiveInput(nextInput);
  }

  resetCommandState();
  clearUndoStack();
  enterMode('insert');
  scheduleCursorUpdate();
}

function reconcilePossibleSend(input: HTMLElement, previousText: string, attempt = 0): void {
  if (!activeInput || !input.isConnected) {
    clearSendReconcileTimer();
    setActiveInput(null);
    return;
  }

  const currentInput = findVimInput() ?? findVimInput({ requireVisible: false });
  const inputChanged = Boolean(currentInput && currentInput !== input);
  const becameEmpty = previousText.trim().length > 0 && getInputText(input).trim().length === 0;

  if (inputChanged || becameEmpty) {
    clearSendReconcileTimer();
    returnToInsertAfterSubmit(currentInput ?? input);
    return;
  }

  if (attempt >= SEND_RECONCILE_ATTEMPTS) {
    clearSendReconcileTimer();
    return;
  }

  sendReconcileTimer = window.setTimeout(() => {
    sendReconcileTimer = null;
    reconcilePossibleSend(input, previousText, attempt + 1);
  }, SEND_RECONCILE_DELAY_MS);
}

function scheduleSendReconcile(input: HTMLElement | null): void {
  if (!input) return;

  const previousText = getInputText(input);
  if (previousText.trim().length === 0) return;

  clearSendReconcileTimer();
  sendReconcileTimer = window.setTimeout(() => {
    sendReconcileTimer = null;
    reconcilePossibleSend(input, previousText);
  }, SEND_RECONCILE_DELAY_MS);
}

function isEditableTarget(element: HTMLElement | null): boolean {
  if (!element) return false;
  return element.matches(EDITABLE_SELECTOR) || Boolean(element.closest(EDITABLE_SELECTOR));
}

function getTargetElement(event: KeyboardEvent): HTMLElement | null {
  if (event.target instanceof HTMLElement) return event.target;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function isEditPromptInput(element: HTMLElement): boolean {
  return element.matches(EDIT_PROMPT_SELECTOR);
}

function findEditPromptInput(requireVisible = true): HTMLElement | null {
  let fallback: HTMLElement | null = null;

  for (const element of Array.from(document.querySelectorAll<HTMLElement>(EDIT_PROMPT_SELECTOR))) {
    if (!fallback && element.isConnected) fallback = element;
    if (isVisibleHudMount(element)) return element;
  }

  return requireVisible ? null : fallback;
}

function findVimInputFromTarget(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null;

  const editable = element.matches(EDITABLE_SELECTOR)
    ? element
    : element.closest<HTMLElement>(EDITABLE_SELECTOR);
  if (!editable) return null;

  if (isEditPromptInput(editable)) return editable;

  const input = findChatInput({ requireVisible: false });
  return input && (editable === input || input.contains(editable)) ? input : null;
}

function findVimInput(options: FindVimInputOptions = {}): HTMLElement | null {
  const requireVisible = options.requireVisible ?? true;
  const activeElement =
    options.target ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const targetedInput = findVimInputFromTarget(activeElement);

  if (targetedInput && (!requireVisible || isVisibleHudMount(targetedInput))) {
    return targetedInput;
  }

  const editInput = findEditPromptInput(true);
  if (editInput) return editInput;

  const chatInput = findChatInput();
  if (chatInput) return chatInput;

  if (requireVisible) return null;
  return findEditPromptInput(false) ?? findChatInput({ requireVisible: false });
}

function getSendButtonTarget(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null;

  const matched = element.closest(SEND_BUTTON_SELECTOR);
  if (!(matched instanceof HTMLElement)) return null;

  const button = matched.closest('button');
  return button instanceof HTMLElement ? button : matched;
}

function focusElement(input: HTMLElement): void {
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

function focusVimInput(mode: VimMode = 'insert'): boolean {
  let input = findVimInput();
  if (!input) {
    expandInputWithCursorAtEnd();
    input = findVimInput() ?? findVimInput({ requireVisible: false });
  }

  if (!input) return false;

  setActiveInput(input);
  focusElement(input);
  setInputSelection(input, getCaretOffset(input));
  enterMode(mode);
  return true;
}

function updateInputModeClasses(): void {
  if (!activeInput) return;

  activeInput.classList.toggle(`${MODE_CLASS_PREFIX}insert`, state.mode === 'insert');
  activeInput.classList.toggle(`${MODE_CLASS_PREFIX}normal`, state.mode === 'normal');
  activeInput.classList.toggle(`${MODE_CLASS_PREFIX}visual`, state.mode === 'visual');
  activeInput.dataset.gvVimMode = state.mode;
}

function hasVisibleLayout(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isElementHidden(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true;

  const style = window.getComputedStyle?.(element);
  return style?.display === 'none' || style?.visibility === 'hidden';
}

function isVisibleHudMount(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected || isElementHidden(element)) return false;
  return hasVisibleLayout(element);
}

function queryHudMountCandidates(): HTMLElement[] {
  const selectors = [
    'toolbox-drawer .toolbox-drawer-button-label-icon-text',
    'toolbox-drawer .toolbox-drawer-button-label',
    'toolbox-drawer .toolbox-drawer-button-container',
    'toolbox-drawer button',
    'toolbox-drawer .toolbox-drawer-container',
    '[class*="toolbox-drawer"] .toolbox-drawer-button-label-icon-text',
    '[class*="toolbox-drawer"] button',
    'button[aria-label*="Tools"]',
    'button[aria-label*="tools"]',
    'button[aria-label*="工具"]',
    'button[aria-label*="ツール"]',
    'button[aria-label*="도구"]',
  ];

  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (seen.has(element)) continue;
      seen.add(element);
      candidates.push(element);
    }
  }

  return candidates;
}

function getCrossSiteComposerMount(input: HTMLElement | null): HTMLElement | null {
  if (!input) return null;

  if (input.matches('#prompt-textarea[contenteditable="true"]')) {
    return input.closest<HTMLElement>('form');
  }

  if (input.matches('[data-testid="chat-input"][contenteditable="true"]')) {
    return input.closest<HTMLElement>('fieldset');
  }

  return null;
}

function getCrossSiteEditMount(input: HTMLElement | null): HTMLElement | null {
  if (!input?.matches('textarea[aria-label="Edit message"]')) return null;

  let candidate = input.parentElement;
  for (let depth = 0; candidate && candidate !== document.body && depth < 8; depth++) {
    if (candidate.querySelectorAll('button').length >= 2) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }

  return input.parentElement;
}

function getHudMount(): HudMountTarget | null {
  if (typeof document === 'undefined') return null;

  const input =
    (activeInput?.isConnected ? activeInput : null) ??
    findVimInput() ??
    findVimInput({ requireVisible: false });
  const editForm =
    input && isEditPromptInput(input)
      ? input.closest<HTMLElement>('mat-form-field.edit-form, .edit-form')
      : null;

  if (editForm?.isConnected) {
    return { element: editForm, input, placement: 'edit' };
  }

  const crossSiteEdit = getCrossSiteEditMount(input);
  if (crossSiteEdit?.isConnected) {
    return { element: crossSiteEdit, input, placement: 'edit-floating' };
  }

  const crossSiteComposer = getCrossSiteComposerMount(input);
  if (crossSiteComposer?.isConnected) {
    return { element: crossSiteComposer, input, placement: 'floating' };
  }

  const composer = input?.closest<HTMLElement>('.text-input-field, input-area-v2, input-container');

  if (composer?.isConnected) {
    return { element: composer, input, placement: 'composer' };
  }

  const candidates = queryHudMountCandidates();
  const visibleCandidate = candidates.find(isVisibleHudMount);
  if (visibleCandidate) {
    return { element: visibleCandidate, input, placement: 'inline' };
  }

  const fallbackCandidate = candidates.find((element) => element.isConnected);
  if (fallbackCandidate) {
    return { element: fallbackCandidate, input, placement: 'inline' };
  }

  const inputFallback = document.querySelector<HTMLElement>('rich-textarea')?.parentElement;
  return inputFallback instanceof HTMLElement
    ? { element: inputFallback, input, placement: 'inline' }
    : null;
}

function updateHudPlacement(
  hud: HTMLElement,
  mount: HTMLElement,
  input: HTMLElement | null,
  placement: HudMountTarget['placement'],
): void {
  hud.dataset.placement = placement;

  if (placement === 'inline' || !input) {
    hud.style.removeProperty('--gv-input-vim-hud-left');
    return;
  }

  const mountRect = mount.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const left = clamp(inputRect.left - mountRect.left, 0, mountRect.width);
  hud.style.setProperty('--gv-input-vim-hud-left', `${Math.round(left)}px`);
}

function clearHudMountClasses(mount: HTMLElement | null): void {
  mount?.classList.remove(HUD_MOUNT_CLASS, HUD_COMPOSER_MOUNT_CLASS);
}

function updateHudMountClass(mount: HTMLElement, placement: HudMountTarget['placement']): void {
  mount.classList.toggle(HUD_MOUNT_CLASS, placement === 'inline');
  mount.classList.toggle(HUD_COMPOSER_MOUNT_CLASS, placement !== 'inline');
}

function ensureHud(): HTMLElement | null {
  const target = getHudMount();
  if (!target) {
    return hudElement?.isConnected ? hudElement : null;
  }

  const { element: mount, input, placement } = target;

  if (hudElement?.isConnected) {
    if (hudElement.parentElement !== mount) {
      clearHudMountClasses(hudMountElement);
      mount.appendChild(hudElement);
      hudMountElement = mount;
    }
    updateHudMountClass(mount, placement);
    updateHudPlacement(hudElement, mount, input, placement);
    return hudElement;
  }

  const hud = document.createElement('div');
  hud.className = HUD_CLASS;
  hud.innerHTML = `
    <span class="${HUD_MODE_CLASS}"></span>
    <span class="${HUD_BUFFER_CLASS}"></span>
  `;
  updateHudMountClass(mount, placement);
  mount.appendChild(hud);
  hudMountElement = mount;
  hudElement = hud;
  updateHudPlacement(hud, mount, input, placement);
  return hud;
}

function stopHudRetry(): void {
  if (hudRetryTimer !== null) {
    clearTimeout(hudRetryTimer);
    hudRetryTimer = null;
  }
}

function scheduleHudRetry(): void {
  if (!isEnabled || typeof document === 'undefined') return;
  if (hudRetryTimer !== null || hudElement?.isConnected) return;
  if (hudRetryAttempts >= 20) return;

  hudRetryTimer = window.setTimeout(() => {
    hudRetryTimer = null;
    hudRetryAttempts++;
    updateHud();

    if (!hudElement?.isConnected) {
      scheduleHudRetry();
    }
  }, 250);
}

function updateHud(): void {
  if (typeof document === 'undefined') return;

  const hud = ensureHud();
  if (!hud) {
    scheduleHudRetry();
    return;
  }

  stopHudRetry();

  const modeElement = hud.querySelector<HTMLElement>(`.${HUD_MODE_CLASS}`);
  const bufferElement = hud.querySelector<HTMLElement>(`.${HUD_BUFFER_CLASS}`);

  const isActive = Boolean(activeInput && isEnabled);
  hud.dataset.mode = isActive ? state.mode : 'off';
  hud.dataset.active = String(isActive);

  if (modeElement) {
    modeElement.textContent = isActive ? state.mode.toUpperCase() : 'VIM';
  }

  if (bufferElement) {
    const prefix = state.pendingOperator ?? state.commandBuffer;
    const buffer = state.pendingOperator
      ? `${state.countBuffer}${prefix}`
      : `${state.countBuffer}${prefix}`;
    bufferElement.textContent = buffer;
    bufferElement.hidden = buffer.length === 0;
  }
}

function ensureCursor(): HTMLElement {
  if (cursorElement?.isConnected) return cursorElement;

  const cursor = document.createElement('div');
  cursor.className = CURSOR_CLASS;
  cursor.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cursor);
  cursorElement = cursor;
  return cursor;
}

function hideCursor(): void {
  if (cursorElement) {
    cursorElement.hidden = true;
    cursorElement.classList.remove(CURSOR_MOVING_CLASS);
  }
  lastCursorBox = null;
  if (cursorMoveFlashTimer !== null) {
    clearTimeout(cursorMoveFlashTimer);
    cursorMoveFlashTimer = null;
  }
}

function updateCursorMotion(cursor: HTMLElement, box: NonNullable<typeof lastCursorBox>): void {
  const previousBox = lastCursorBox;
  lastCursorBox = box;

  if (!previousBox || cursor.hidden) return;

  const moved =
    previousBox.mode !== box.mode ||
    previousBox.top !== box.top ||
    previousBox.left !== box.left ||
    previousBox.width !== box.width ||
    previousBox.height !== box.height;

  if (!moved) return;

  cursor.classList.remove(CURSOR_MOVING_CLASS);
  cursor.classList.add(CURSOR_MOVING_CLASS);

  if (cursorMoveFlashTimer !== null) {
    clearTimeout(cursorMoveFlashTimer);
  }
  cursorMoveFlashTimer = window.setTimeout(() => {
    cursorMoveFlashTimer = null;
    cursor.classList.remove(CURSOR_MOVING_CLASS);
  }, CURSOR_MOVE_FLASH_MS);
}

function isUsableRect(rect: DOMRect | undefined): rect is DOMRect {
  return Boolean(
    rect &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width + rect.height > 0,
  );
}

function getFirstRangeRect(range: Range): DOMRect | null {
  const clientRect = Array.from(range.getClientRects()).find(isUsableRect);
  if (clientRect) return clientRect;

  const boundingRect = range.getBoundingClientRect();
  return isUsableRect(boundingRect) ? boundingRect : null;
}

function makeDomRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    height,
    width,
    top,
    left,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => {},
  } as DOMRect;
}

const TEXTAREA_MIRROR_STYLE_PROPERTIES = [
  'border-bottom-width',
  'border-left-width',
  'border-right-width',
  'border-top-width',
  'direction',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'tab-size',
  'text-align',
  'text-indent',
  'text-rendering',
  'text-transform',
  'word-break',
  'word-spacing',
] as const;

function createTextareaMirror(input: HTMLTextAreaElement): {
  inputRect: DOMRect;
  mirror: HTMLDivElement;
} {
  const inputRect = input.getBoundingClientRect();
  const computedStyle = getComputedStyle(input);
  const mirror = document.createElement('div');

  mirror.className = TEXTAREA_MIRROR_CLASS;
  mirror.setAttribute('aria-hidden', 'true');

  for (const property of TEXTAREA_MIRROR_STYLE_PROPERTIES) {
    mirror.style.setProperty(property, computedStyle.getPropertyValue(property));
  }

  const borderLeft = Number.parseFloat(computedStyle.borderLeftWidth) || 0;
  const borderRight = Number.parseFloat(computedStyle.borderRightWidth) || 0;
  const measuredWidth =
    input.clientWidth > 0 ? input.clientWidth + borderLeft + borderRight : inputRect.width;

  mirror.style.position = 'fixed';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.zIndex = '-1';
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${measuredWidth}px`;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '0';
  mirror.style.overflow = 'hidden';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.whiteSpace = input.wrap === 'off' ? 'pre' : 'pre-wrap';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';

  return { inputRect, mirror };
}

function translateTextareaMarkerRect(
  input: HTMLTextAreaElement,
  inputRect: DOMRect,
  mirrorRect: DOMRect,
  markerRect: DOMRect,
  width: number,
): DOMRect {
  const left = inputRect.left + (markerRect.left - mirrorRect.left) - input.scrollLeft;
  const top = inputRect.top + (markerRect.top - mirrorRect.top) - input.scrollTop;
  return makeDomRect(left, top, width, markerRect.height);
}

function getTextareaTextRangeRect(
  input: HTMLTextAreaElement,
  start: number,
  end: number,
): DOMRect | null {
  const text = input.value;
  const rangeStart = clamp(start, 0, text.length);
  const rangeEnd = clamp(end, rangeStart, text.length);
  if (text.slice(rangeStart, rangeEnd).includes('\n')) return null;

  const { inputRect, mirror } = createTextareaMirror(input);
  const marker = document.createElement('span');
  marker.className = TEXTAREA_MARKER_CLASS;
  marker.dataset.gvVimOffset = String(rangeStart);

  mirror.append(document.createTextNode(text.slice(0, rangeStart)));
  marker.textContent = text.slice(rangeStart, rangeEnd) || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);

  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();

    if (!isUsableRect(markerRect)) return null;

    return translateTextareaMarkerRect(
      input,
      inputRect,
      mirrorRect,
      markerRect,
      rangeStart === rangeEnd ? 0 : markerRect.width,
    );
  } finally {
    mirror.remove();
  }
}

function getTextareaRenderedCharacters(input: HTMLTextAreaElement): RenderedCharacter[] {
  const text = input.value;
  const { inputRect, mirror } = createTextareaMirror(input);
  const markers: Array<{ element: HTMLSpanElement; range: GraphemeRange }> = [];

  for (const range of getGraphemeRanges(text)) {
    const segment = text.slice(range.start, range.end);
    if (segment === '\n') {
      mirror.append(document.createTextNode(segment));
      continue;
    }

    const marker = document.createElement('span');
    marker.className = TEXTAREA_MARKER_CLASS;
    marker.dataset.gvVimOffset = String(range.start);
    marker.textContent = segment;
    mirror.append(marker);
    markers.push({ element: marker, range });
  }

  document.body.append(mirror);

  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const characters: RenderedCharacter[] = [];

    for (const { element, range } of markers) {
      const markerRect = element.getBoundingClientRect();
      if (!isUsableRect(markerRect)) continue;

      const rect = translateTextareaMarkerRect(
        input,
        inputRect,
        mirrorRect,
        markerRect,
        markerRect.width,
      );
      characters.push({
        ...range,
        rect,
        centerX: rect.left + rect.width / 2,
      });
    }

    return characters;
  } finally {
    mirror.remove();
  }
}

function getCollapsedTextOffsetRect(input: HTMLElement, offset: number): DOMRect | null {
  if (input instanceof HTMLTextAreaElement) {
    return getTextareaTextRangeRect(input, offset, offset);
  }

  const text = getInputText(input);
  const current = clamp(offset, 0, text.length);
  const range = createRangeForTextOffsets(input, current);
  return getFirstRangeRect(range);
}

function getTextRangeRect(input: HTMLElement, start: number, end: number): DOMRect | null {
  if (start === end || getInputText(input).slice(start, end).includes('\n')) return null;

  if (input instanceof HTMLTextAreaElement) {
    return getTextareaTextRangeRect(input, start, end);
  }

  const range = createRangeForTextOffsets(input, start, end);
  const rect = getFirstRangeRect(range);
  return rect && rect.width > 0 ? rect : null;
}

function getElementTextRangeRect(element: HTMLElement, start: number, end: number): DOMRect | null {
  if (start === end) return null;

  const range = document.createRange();
  const rangeStart = findTextPositionInElement(element, start);
  const rangeEnd = findTextPositionInElement(element, end);
  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);

  const rect = getFirstRangeRect(range);
  return rect && rect.width > 0 ? rect : null;
}

function getCharacterRect(
  input: HTMLElement,
  offset: number,
  direction: -1 | 1 = 1,
): DOMRect | null {
  const text = getInputText(input);
  const current = clamp(offset, 0, text.length);
  const start = direction < 0 ? getPreviousGraphemeOffset(text, current) : current;
  const end = direction < 0 ? current : getNextGraphemeOffset(text, current);

  if (start === end || text.slice(start, end) === '\n') return null;
  return getTextRangeRect(input, start, end);
}

function estimateRenderedLineHeight(input: HTMLElement, lines: RenderedLine[]): number {
  const measuredLine = lines.find((line) => line.bottom > line.top);
  const firstItemHeight = lines.flatMap((line) => line.items).find((item) => item.rect.height > 0)
    ?.rect.height;
  const measuredHeight = measuredLine ? measuredLine.bottom - measuredLine.top : undefined;
  const fallbackHeight = input.getBoundingClientRect().height || 18;

  return Math.max(16, firstItemHeight ?? measuredHeight ?? fallbackHeight);
}

function getCaretRect(input: HTMLElement, offset: number): DOMRect | null {
  if (input instanceof HTMLTextAreaElement) {
    return getTextareaTextRangeRect(input, offset, offset) ?? input.getBoundingClientRect();
  }

  const text = getInputText(input);
  const current = clamp(offset, 0, text.length);
  const renderedPosition = findRenderedLinePosition(getRenderedLines(input), current);
  const renderedLineRect = renderedPosition?.character.rect ?? null;

  if (renderedPosition?.character.isEmptyLine && renderedLineRect) {
    return renderedLineRect;
  }

  const rect = getCollapsedTextOffsetRect(input, current);
  if (rect) {
    return rect;
  }

  if (renderedLineRect) return renderedLineRect;

  if (current > 0) {
    const previousOffset = getPreviousGraphemeOffset(text, current);
    const previousText = text.slice(previousOffset, current);
    if (!previousText.includes('\n')) {
      const previousRect = getTextRangeRect(input, previousOffset, current);
      if (previousRect) return previousRect;
    }
  }

  return input.getBoundingClientRect();
}

function updateCursor(): void {
  if (!activeInput || state.mode === 'insert' || !activeInput.isConnected) {
    hideCursor();
    return;
  }

  const cursor = ensureCursor();
  const caretOffset = getCaretOffset(activeInput);
  const characterRect =
    state.mode === 'normal'
      ? (getCharacterRect(activeInput, caretOffset) ??
        getCharacterRect(activeInput, caretOffset, -1))
      : null;
  const rect = characterRect ?? getCaretRect(activeInput, caretOffset);
  if (!rect) {
    hideCursor();
    return;
  }

  const inputRect = activeInput.getBoundingClientRect();
  const height = Math.max(16, rect.height || inputRect.height || 18);
  const top = Number.isFinite(rect.top) ? rect.top : inputRect.top;
  const left = Number.isFinite(rect.left) ? rect.left : inputRect.left;
  const width =
    state.mode === 'visual'
      ? 2
      : Math.max(NORMAL_CURSOR_WIDTH, Math.round(characterRect?.width ?? NORMAL_CURSOR_WIDTH));
  const box = {
    top: Math.round(top),
    left: Math.round(left),
    width,
    height: Math.round(height),
    mode: state.mode,
  };

  updateCursorMotion(cursor, box);
  cursor.hidden = false;
  cursor.dataset.mode = state.mode;
  cursor.style.top = `${box.top}px`;
  cursor.style.left = `${box.left}px`;
  cursor.style.height = `${box.height}px`;
  cursor.style.width = `${box.width}px`;
}

function scheduleCursorUpdate(): void {
  if (cursorUpdateRaf !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(cursorUpdateRaf);
    } else {
      clearTimeout(cursorUpdateRaf);
    }
  }

  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);

  cursorUpdateRaf = schedule(() => {
    cursorUpdateRaf = null;
    updateCursor();
  });
}

function setVisualSelection(input: HTMLElement, target: number): void {
  const text = getInputText(input);
  const anchor = state.visualAnchor ?? getCaretOffset(input);
  state.visualAnchor = anchor;

  setInputSelection(input, anchor, clamp(target, 0, text.length));
}

function moveCaret(input: HTMLElement, target: number): void {
  if (state.mode === 'visual') {
    setVisualSelection(input, target);
    return;
  }

  setInputSelection(input, target);
}

function handleMotion(input: HTMLElement, kind: MotionKind, count = getCount()): void {
  const target = getMotionOffset(input, kind, count);

  if (state.pendingOperator) {
    applyOperatorMotion(input, target);
    return;
  }

  moveCaret(
    input,
    state.mode === 'normal' ? getNormalModeCaretOffset(getInputText(input), target) : target,
  );
  completeCommand();
}

function handleLineMotion(input: HTMLElement, kind: LineMotionKind): void {
  const text = getInputText(input);
  const rawTarget = getLineMotionOffset(text, getCaretOffset(input), kind);

  if (state.pendingOperator) {
    applyOperatorMotion(input, rawTarget);
    return;
  }

  const target = state.mode === 'normal' ? getNormalModeCaretOffset(text, rawTarget) : rawTarget;
  moveCaret(input, target);
  completeCommand();
}

function handleVerticalMotion(input: HTMLElement, direction: -1 | 1): void {
  const count = getCount();

  if (!state.pendingOperator) {
    const renderedTarget = getRenderedLineMotionOffset(input, direction, count);
    if (renderedTarget !== null) {
      moveCaret(
        input,
        state.mode === 'normal'
          ? getNormalModeCaretOffset(getInputText(input), renderedTarget)
          : renderedTarget,
      );
      completeCommand(true);
      return;
    }
  }

  const text = getInputText(input);
  const target = moveVertical(text, getCaretOffset(input), direction, count);

  if (state.pendingOperator) {
    applyOperatorMotion(input, target);
    return;
  }

  moveCaret(input, state.mode === 'normal' ? getNormalModeCaretOffset(text, target) : target);
  completeCommand(true);
}

function getRenderedCharacters(input: HTMLElement): RenderedCharacter[] {
  if (input instanceof HTMLTextAreaElement) return getTextareaRenderedCharacters(input);

  const blockEntries = getBlockLineEntries(input);
  if (blockEntries.length > 0) {
    const characters: RenderedCharacter[] = [];

    for (const entry of blockEntries) {
      if (entry.isEmpty) continue;

      const blockText = getLineBlockText(entry.element);
      for (const range of getGraphemeRanges(blockText)) {
        const rect = getElementTextRangeRect(entry.element, range.start, range.end);
        if (!rect) continue;

        characters.push({
          start: entry.start + range.start,
          end: entry.start + range.end,
          rect,
          centerX: rect.left + rect.width / 2,
        });
      }
    }

    return characters;
  }

  const text = getInputText(input);
  const characters: RenderedCharacter[] = [];

  for (const range of getGraphemeRanges(text)) {
    if (text.slice(range.start, range.end) === '\n') continue;

    const rect = getTextRangeRect(input, range.start, range.end);
    if (!rect) continue;

    characters.push({
      ...range,
      rect,
      centerX: rect.left + rect.width / 2,
    });
  }

  return characters;
}

function isRenderedCharacterOnLine(line: RenderedLine, character: RenderedCharacter): boolean {
  const centerY = character.rect.top + character.rect.height / 2;
  const tolerance = Math.max(2, character.rect.height * 0.25);
  return centerY >= line.top - tolerance && centerY <= line.bottom + tolerance;
}

function isRenderedItemAtOffset(item: RenderedCharacter, offset: number): boolean {
  return item.start === item.end
    ? offset === item.start
    : offset >= item.start && offset < item.end;
}

function isRectOnRenderedLine(rect: DOMRect, line: RenderedLine): boolean {
  const centerY = rect.top + rect.height / 2;
  const tolerance = Math.max(2, rect.height * 0.25);
  return centerY >= line.top - tolerance && centerY <= line.bottom + tolerance;
}

function createEmptyLineItemFromRect(
  input: HTMLElement,
  lines: RenderedLine[],
  offset: number,
  rect: DOMRect,
  allowOverlap = false,
): RenderedCharacter | null {
  const overlapsExistingLine =
    !allowOverlap && lines.some((line) => isRectOnRenderedLine(rect, line));
  if (overlapsExistingLine) return null;

  const lineHeight = estimateRenderedLineHeight(input, lines);
  const height = Math.max(16, rect.height || lineHeight);

  return {
    start: offset,
    end: offset,
    rect: makeDomRect(rect.left, rect.top, 0, height),
    centerX: rect.left,
    isEmptyLine: true,
  };
}

function createTextEmptyLineItem(
  input: HTMLElement,
  lines: RenderedLine[],
  offset: number,
): RenderedCharacter | null {
  const collapsedRect = getCollapsedTextOffsetRect(input, offset);
  return collapsedRect ? createEmptyLineItemFromRect(input, lines, offset, collapsedRect) : null;
}

function getLineFirstStart(line: RenderedLine): number {
  return line.items.reduce((first, item) => Math.min(first, item.start), Number.POSITIVE_INFINITY);
}

function getLineLastEnd(line: RenderedLine): number {
  return line.items.reduce((last, item) => Math.max(last, item.end), 0);
}

function findRenderedLineBefore(lines: RenderedLine[], offset: number): RenderedLine | null {
  return (
    lines
      .filter((line) => getLineFirstStart(line) < offset)
      .sort((left, right) => getLineFirstStart(right) - getLineFirstStart(left))[0] ?? null
  );
}

function findRenderedLineAfter(lines: RenderedLine[], offset: number): RenderedLine | null {
  return (
    lines
      .filter((line) => getLineLastEnd(line) > offset)
      .sort((left, right) => getLineFirstStart(left) - getLineFirstStart(right))[0] ?? null
  );
}

function createSyntheticEmptyLineItems(
  input: HTMLElement,
  lines: RenderedLine[],
  offsets: number[],
): RenderedCharacter[] {
  if (offsets.length === 0) return [];

  const previousLine = findRenderedLineBefore(lines, offsets[0]);
  const nextLine = findRenderedLineAfter(lines, offsets[offsets.length - 1]);
  const lineHeight = estimateRenderedLineHeight(input, lines);
  const inputRect = input.getBoundingClientRect();
  const left = previousLine?.items[0]?.rect.left ?? nextLine?.items[0]?.rect.left ?? inputRect.left;

  return offsets.map((offset, index) => {
    let top = inputRect.top + lineHeight * index;

    if (previousLine && nextLine) {
      const advance = Math.max(1, (nextLine.top - previousLine.top) / (offsets.length + 1));
      top = previousLine.top + advance * (index + 1);
    } else if (previousLine) {
      top = previousLine.top + lineHeight * (index + 1);
    } else if (nextLine) {
      top = nextLine.top - lineHeight * (offsets.length - index);
    }

    return {
      start: offset,
      end: offset,
      rect: makeDomRect(left, top, 0, lineHeight),
      centerX: left,
      isEmptyLine: true,
    };
  });
}

function pushEmptyLineItem(lines: RenderedLine[], item: RenderedCharacter | null): void {
  if (!item) return;

  lines.push({
    top: item.rect.top,
    bottom: item.rect.bottom,
    items: [item],
  });
}

function addBlockEmptyRenderedLines(input: HTMLElement, lines: RenderedLine[]): RenderedLine[] {
  const nextLines = [...lines];

  for (const entry of getBlockLineEntries(input)) {
    if (!entry.isEmpty) continue;

    const rect = entry.element.getBoundingClientRect();
    if (!isUsableRect(rect)) continue;

    pushEmptyLineItem(
      nextLines,
      createEmptyLineItemFromRect(input, nextLines, entry.start, rect, true),
    );
  }

  return nextLines;
}

function addTextEmptyRenderedLines(input: HTMLElement, lines: RenderedLine[]): RenderedLine[] {
  const text = getInputText(input);
  const nextLines = [...lines];
  const syntheticGroups: Array<Array<{ lineIndex: number; offset: number }>> = [];

  getLogicalLines(text).forEach((logicalLine, lineIndex) => {
    const isEmptyLineBetweenNewlines =
      logicalLine.start === logicalLine.end &&
      logicalLine.start > 0 &&
      text[logicalLine.start - 1] === '\n' &&
      text[logicalLine.start] === '\n';

    if (!isEmptyLineBetweenNewlines) return;

    const alreadyRepresented = nextLines.some((line) =>
      line.items.some((item) => isRenderedItemAtOffset(item, logicalLine.start)),
    );
    if (alreadyRepresented) return;

    const measuredItem = createTextEmptyLineItem(input, nextLines, logicalLine.start);
    if (measuredItem) {
      pushEmptyLineItem(nextLines, measuredItem);
      return;
    }

    const previousGroup = syntheticGroups.at(-1);
    const previousItem = previousGroup?.at(-1);
    if (previousGroup && previousItem?.lineIndex === lineIndex - 1) {
      previousGroup.push({ lineIndex, offset: logicalLine.start });
    } else {
      syntheticGroups.push([{ lineIndex, offset: logicalLine.start }]);
    }
  });

  for (const group of syntheticGroups) {
    for (const item of createSyntheticEmptyLineItems(
      input,
      nextLines,
      group.map(({ offset }) => offset),
    )) {
      pushEmptyLineItem(nextLines, item);
    }
  }

  return nextLines;
}

function addEmptyRenderedLines(input: HTMLElement, lines: RenderedLine[]): RenderedLine[] {
  const withBlockEmptyLines =
    getBlockLineEntries(input).length > 0 ? addBlockEmptyRenderedLines(input, lines) : lines;
  return addTextEmptyRenderedLines(input, withBlockEmptyLines);
}

function getRenderedLines(input: HTMLElement): RenderedLine[] {
  const sortedCharacters = getRenderedCharacters(input).sort(
    (left, right) =>
      left.rect.top - right.rect.top ||
      left.rect.left - right.rect.left ||
      left.start - right.start,
  );
  const lines: RenderedLine[] = [];

  for (const character of sortedCharacters) {
    const existingLine = lines.find((line) => isRenderedCharacterOnLine(line, character));

    if (existingLine) {
      existingLine.top = Math.min(existingLine.top, character.rect.top);
      existingLine.bottom = Math.max(existingLine.bottom, character.rect.bottom);
      existingLine.items.push(character);
      continue;
    }

    lines.push({
      top: character.rect.top,
      bottom: character.rect.bottom,
      items: [character],
    });
  }

  return addEmptyRenderedLines(input, lines)
    .map((line) => ({
      ...line,
      items: line.items.sort(
        (left, right) => left.rect.left - right.rect.left || left.start - right.start,
      ),
    }))
    .sort((left, right) => {
      const topDelta = left.top - right.top;
      return Math.abs(topDelta) <= 4
        ? getLineFirstStart(left) - getLineFirstStart(right)
        : topDelta;
    });
}

function findRenderedLinePosition(
  lines: RenderedLine[],
  offset: number,
): { lineIndex: number; character: RenderedCharacter } | null {
  let previousMatch: { lineIndex: number; character: RenderedCharacter } | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    for (const character of lines[lineIndex].items) {
      if (isRenderedItemAtOffset(character, offset)) {
        return { lineIndex, character };
      }

      if (character.start <= offset) {
        previousMatch = { lineIndex, character };
      }
    }
  }

  return (
    previousMatch ?? (lines[0]?.items[0] ? { lineIndex: 0, character: lines[0].items[0] } : null)
  );
}

function findClosestRenderedCharacter(line: RenderedLine, targetX: number): RenderedCharacter {
  return line.items.reduce((closest, character) => {
    const closestDistance = Math.abs(closest.centerX - targetX);
    const nextDistance = Math.abs(character.centerX - targetX);
    return nextDistance < closestDistance ? character : closest;
  });
}

function getRenderedLineMotionOffset(
  input: HTMLElement,
  direction: -1 | 1,
  count: number,
): number | null {
  const lines = getRenderedLines(input);
  if (lines.length < 2) return null;

  const currentPosition = findRenderedLinePosition(lines, getCaretOffset(input));
  if (!currentPosition) return null;

  const targetX =
    state.desiredRenderedColumn ??
    currentPosition.character.rect.left + currentPosition.character.rect.width / 2;
  state.desiredRenderedColumn = targetX;

  let targetLineIndex = currentPosition.lineIndex;
  for (let index = 0; index < count; index++) {
    targetLineIndex = clamp(targetLineIndex + direction, 0, lines.length - 1);
  }

  if (targetLineIndex === currentPosition.lineIndex) return getCaretOffset(input);
  return findClosestRenderedCharacter(lines[targetLineIndex], targetX).start;
}

function applyOperatorMotion(input: HTMLElement, target: number): void {
  const operator = state.pendingOperator;
  if (!operator) return;

  const caret = getCaretOffset(input);
  const text = getInputText(input);
  const from = Math.min(caret, target);
  const to = Math.max(caret, target);
  const selected = text.slice(from, to);

  if (operator === 'y') {
    writeClipboard(selected);
    setInputSelection(input, caret);
    enterMode('normal');
  } else {
    state.yankBuffer = selected;
    state.yankLinewise = false;
    replaceRange(input, from, to);
    enterMode(operator === 'c' ? 'insert' : 'normal');
  }

  completeCommand();
}

function applyOperatorBlockLine(
  input: HTMLElement,
  operator: PendingOperator,
  count: number,
): boolean {
  if (input instanceof HTMLTextAreaElement) return false;

  const entries = getBlockLineEntries(input);
  if (entries.length === 0) return false;

  const startIndex = getBlockLineIndexAtOffset(entries, getCaretOffset(input));
  const endIndex = clamp(startIndex + Math.max(1, count), startIndex + 1, entries.length);
  const targetEntries = entries.slice(startIndex, endIndex);
  const selected = targetEntries.map((entry) => getLineBlockText(entry.element)).join('\n');
  const clipboardText = selected.length === 0 ? '\n' : selected;

  if (operator === 'y') {
    writeClipboard(clipboardText, true);
    setInputSelection(input, entries[startIndex].start);
    return true;
  }

  writeClipboard(clipboardText, true);
  pushUndo(input);

  const shouldKeepFirstTarget = operator === 'c' || targetEntries.length === entries.length;
  const entriesToRemove = shouldKeepFirstTarget ? targetEntries.slice(1) : targetEntries;

  if (shouldKeepFirstTarget) {
    clearLineBlockElement(targetEntries[0].element);
  }

  for (const entry of entriesToRemove) {
    entry.element.remove();
  }

  input.classList.toggle('ql-blank', getInputText(input).length === 0);
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const nextEntries = getBlockLineEntries(input);
  const nextIndex = clamp(startIndex, 0, Math.max(0, nextEntries.length - 1));
  const nextOffset = nextEntries[nextIndex]?.start ?? 0;
  setInputSelection(input, nextOffset);

  if (operator === 'c') {
    enterMode('insert');
  }

  return true;
}

function applyOperatorLine(
  input: HTMLElement,
  operator: PendingOperator,
  count = getCount(),
): void {
  if (applyOperatorBlockLine(input, operator, count)) {
    completeCommand();
    return;
  }

  const text = getInputText(input);
  const caret = getCaretOffset(input);
  const start = getLineStart(text, caret);
  let end = start;

  for (let i = 0; i < count; i++) {
    const lineEnd = getLineEnd(text, end);
    end = operator === 'c' || lineEnd >= text.length ? lineEnd : lineEnd + 1;
  }

  const selected = text.slice(start, end);

  if (operator === 'y') {
    writeClipboard(selected, true);
    setInputSelection(input, start);
  } else {
    writeClipboard(selected, true);
    replaceRange(input, start, end);
    if (operator === 'c') {
      enterMode('insert');
    }
  }

  completeCommand();
}

function deleteChars(input: HTMLElement, count: number): void {
  const caret = getCaretOffset(input);
  const text = getInputText(input);
  const end = moveTextOffsetByGraphemes(text, caret, 1, count);
  writeClipboard(text.slice(caret, end));
  replaceRange(input, caret, end);
  completeCommand();
}

function deleteCharsBefore(input: HTMLElement, count: number): void {
  const caret = getCaretOffset(input);
  const text = getInputText(input);
  const start = moveTextOffsetByGraphemes(text, caret, -1, count);
  writeClipboard(text.slice(start, caret));
  replaceRange(input, start, caret);
  completeCommand();
}

function substituteChars(input: HTMLElement, count: number): void {
  const caret = getCaretOffset(input);
  const text = getInputText(input);
  const end = moveTextOffsetByGraphemes(text, caret, 1, count);
  writeClipboard(text.slice(caret, end));
  replaceRange(input, caret, end);
  completeCommand();
  enterMode('insert');
}

function paste(input: HTMLElement, before: boolean): void {
  if (!state.yankBuffer) return;

  const text = getInputText(input);
  const caret = getCaretOffset(input);

  if (state.yankLinewise) {
    const lineStart = getLineStart(text, caret);
    const lineEnd = getLineEnd(text, caret);
    const buffer = normalizeLinewiseText(state.yankBuffer);

    if (before) {
      replaceRange(input, lineStart, lineStart, buffer);
      setInputSelection(input, lineStart);
      completeCommand();
      return;
    }

    const isLastLine = lineEnd >= text.length;
    const insertAt = isLastLine ? text.length : lineEnd + 1;
    const prefix = isLastLine && text.length > 0 ? '\n' : '';
    const nextCaret = insertAt + prefix.length;
    replaceRange(input, insertAt, insertAt, `${prefix}${buffer}`);
    setInputSelection(input, nextCaret);
    completeCommand();
    return;
  }

  const insertAt = before ? caret : moveTextOffsetByGraphemes(text, caret, 1, 1);
  replaceRange(input, insertAt, insertAt, state.yankBuffer);
  completeCommand();
}

function deleteToLineEnd(input: HTMLElement, change: boolean): void {
  const text = getInputText(input);
  const caret = getCaretOffset(input);
  const end = getLineEnd(text, caret);
  writeClipboard(text.slice(caret, end));
  replaceRange(input, caret, end);
  enterMode(change ? 'insert' : 'normal');
  completeCommand();
}

function applyVisualOperator(input: HTMLElement, operator: PendingOperator): void {
  const range = getSelectionRange(input);
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  const selected = getInputText(input).slice(from, to);

  if (operator === 'y') {
    writeClipboard(selected);
    setInputSelection(input, from);
    enterMode('normal');
  } else {
    state.yankBuffer = selected;
    state.yankLinewise = false;
    replaceRange(input, from, to);
    enterMode(operator === 'c' ? 'insert' : 'normal');
  }

  completeCommand();
}

function appendDigit(key: string): boolean {
  if (key === '0' && state.countBuffer.length === 0) {
    return false;
  }

  state.countBuffer += key;
  state.commandBuffer = '';
  updateHud();
  return true;
}

function shouldIgnoreKey(event: KeyboardEvent): boolean {
  return (
    event.isComposing ||
    event.altKey ||
    (event.metaKey && event.key !== 'Enter' && !isBrowserEditingShortcut(event)) ||
    (event.ctrlKey &&
      event.key !== '[' &&
      event.key !== 'Enter' &&
      !isBrowserEditingShortcut(event))
  );
}

function isPlainPrintableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function isBrowserEditingShortcut(event: KeyboardEvent): boolean {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return false;

  const key = event.key.toLowerCase();
  return key === 'a' || key === 'v' || key === 'x' || key === 'y' || key === 'z';
}

function isBlockedCommandModeEditingKey(event: KeyboardEvent): boolean {
  return event.key === 'Backspace' || event.key === 'Delete' || isBrowserEditingShortcut(event);
}

function isRepeatSensitiveCommandKey(key: string): boolean {
  return (
    key === 'd' ||
    key === 'c' ||
    key === 'x' ||
    key === 'X' ||
    key === 's' ||
    key === 'D' ||
    key === 'C' ||
    key === 'p' ||
    key === 'P' ||
    key === 'u' ||
    key === 'o' ||
    key === 'O'
  );
}

function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape' || (event.ctrlKey && event.key === '[');
}

function handleInsertMode(event: KeyboardEvent, input: HTMLElement): boolean {
  if (!isEscapeKey(event)) return false;

  const caret = getCaretOffset(input);
  setInputSelection(input, caret);
  resetCommandState();
  enterMode('normal');
  updateHud();
  return true;
}

function handleVisualMode(event: KeyboardEvent, input: HTMLElement): boolean {
  const key = event.key;
  const count = getCount();

  if (isEscapeKey(event)) {
    setInputSelection(
      input,
      Math.min(getSelectionRange(input).start, getSelectionRange(input).end),
    );
    resetCommandState();
    enterMode('normal');
    return true;
  }

  if (key === 'd' || key === 'c' || key === 'y') {
    applyVisualOperator(input, key);
    return true;
  }

  if (/^\d$/.test(key) && appendDigit(key)) return true;
  if (key === 'h' || key === 'ArrowLeft' || key === 'H') handleMotion(input, 'char-left', count);
  else if (key === 'l' || key === 'ArrowRight' || key === 'L')
    handleMotion(input, 'char-right', count);
  else if (key === 'w') handleMotion(input, 'word-forward', count);
  else if (key === 'b') handleMotion(input, 'word-backward', count);
  else if (key === 'e') handleMotion(input, 'word-end', count);
  else if (key === 'j' || key === 'ArrowDown') handleVerticalMotion(input, 1);
  else if (key === 'k' || key === 'ArrowUp') handleVerticalMotion(input, -1);
  else if (key === '0') handleLineMotion(input, 'line-start');
  else if (key === '^') handleLineMotion(input, 'line-first-nonblank');
  else if (key === '$') handleLineMotion(input, 'line-end');
  else return false;

  return true;
}

function handleNormalMode(event: KeyboardEvent, input: HTMLElement): boolean {
  const key = event.key;
  const count = getCount();

  if (/^\d$/.test(key) && appendDigit(key)) return true;

  if (isEscapeKey(event)) {
    resetCommandState();
    enterMode('normal');
    return true;
  }

  if (key === 'i') {
    resetCommandState();
    enterMode('insert');
    return true;
  }

  if (key === 'a') {
    moveCaret(input, getMotionOffset(input, 'char-right', 1));
    resetCommandState();
    enterMode('insert');
    return true;
  }

  if (key === 'I') {
    handleLineMotion(input, 'line-first-nonblank');
    enterMode('insert');
    return true;
  }

  if (key === 'A') {
    const text = getInputText(input);
    setInputSelection(input, getLineMotionOffset(text, getCaretOffset(input), 'line-end'));
    resetCommandState();
    enterMode('insert');
    return true;
  }

  if (key === 'o' || key === 'O') {
    openLine(input, key === 'O', count);
    return true;
  }

  if (key === 'v') {
    state.visualAnchor = getCaretOffset(input);
    resetCommandState();
    enterMode('visual');
    return true;
  }

  if (key === 'u') {
    restoreUndo(input);
    completeCommand();
    return true;
  }

  if (key === 'x') {
    deleteChars(input, count);
    return true;
  }

  if (key === 'X') {
    deleteCharsBefore(input, count);
    return true;
  }

  if (key === 's') {
    substituteChars(input, count);
    return true;
  }

  if (key === 'p' || key === 'P') {
    paste(input, key === 'P');
    return true;
  }

  if (key === 'D' || key === 'C') {
    deleteToLineEnd(input, key === 'C');
    return true;
  }

  if (key === 'd' || key === 'c' || key === 'y') {
    if (state.pendingOperator === key) {
      applyOperatorLine(input, key, count);
      return true;
    }

    state.pendingOperator = key;
    state.commandBuffer = key;
    updateHud();
    return true;
  }

  if (key === 'g' && state.commandBuffer === 'g') {
    setInputSelection(input, 0);
    completeCommand();
    return true;
  }

  if (key === 'g') {
    state.commandBuffer = 'g';
    updateHud();
    return true;
  }

  if (key === 'G') {
    const text = getInputText(input);
    setInputSelection(input, getNormalModeCaretOffset(text, text.length));
    completeCommand();
    return true;
  }

  if (key === 'h' || key === 'ArrowLeft' || key === 'H') handleMotion(input, 'char-left', count);
  else if (key === 'l' || key === 'ArrowRight' || key === 'L')
    handleMotion(input, 'char-right', count);
  else if (key === 'w') handleMotion(input, 'word-forward', count);
  else if (key === 'b') handleMotion(input, 'word-backward', count);
  else if (key === 'e') handleMotion(input, 'word-end', count);
  else if (key === 'j' || key === 'ArrowDown') handleVerticalMotion(input, 1);
  else if (key === 'k' || key === 'ArrowUp') handleVerticalMotion(input, -1);
  else if (key === '0') handleLineMotion(input, 'line-start');
  else if (key === '^') handleLineMotion(input, 'line-first-nonblank');
  else if (key === '$') handleLineMotion(input, 'line-end');
  else return false;

  return true;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!isEnabled || shouldIgnoreKey(event)) return;

  const target = getTargetElement(event);

  if (!activeInput && event.key === 'i' && !event.shiftKey && !isEditableTarget(target)) {
    if (focusVimInput('insert')) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  const targetInput = findVimInputFromTarget(target);
  if (!activeInput && targetInput) {
    setActiveInput(targetInput);
  }

  if (!activeInput || targetInput !== activeInput) return;

  if (
    event.repeat &&
    (state.mode === 'normal' || state.mode === 'visual') &&
    !state.pendingOperator &&
    isRepeatSensitiveCommandKey(event.key)
  ) {
    event.preventDefault();
    event.stopPropagation();
    scheduleCursorUpdate();
    return;
  }

  if (event.key === 'Enter') {
    scheduleSendReconcile(activeInput);
  }

  let handled = false;
  if (state.mode === 'insert') handled = handleInsertMode(event, activeInput);
  else if (state.mode === 'visual') handled = handleVisualMode(event, activeInput);
  else handled = handleNormalMode(event, activeInput);

  if (handled) {
    event.preventDefault();
    event.stopPropagation();
    updateInputModeClasses();
    updateHud();
    scheduleCursorUpdate();
    return;
  }

  if (
    (state.mode === 'normal' || state.mode === 'visual') &&
    isBlockedCommandModeEditingKey(event)
  ) {
    completeCommand();
    event.preventDefault();
    event.stopPropagation();
    scheduleCursorUpdate();
    return;
  }

  if ((state.mode === 'normal' || state.mode === 'visual') && isPlainPrintableKey(event)) {
    completeCommand();
    event.preventDefault();
    event.stopPropagation();
    scheduleCursorUpdate();
  }
}

function handleClick(event: MouseEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!getSendButtonTarget(target)) return;

  scheduleSendReconcile(activeInput ?? findVimInput() ?? findVimInput({ requireVisible: false }));
}

function handleFocusIn(event: FocusEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const input = findVimInputFromTarget(target);
  if (!input) return;

  setActiveInput(input);
}

function handleFocusOut(event: FocusEvent): void {
  if (!activeInput) return;
  const nextFocus = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;

  if (nextFocus && activeInput.contains(nextFocus)) return;

  window.setTimeout(() => {
    if (!activeInput) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeInput.contains(activeElement)) return;
    setActiveInput(null);
  }, 0);
}

function activateListener(): void {
  if (isListenerActive) return;

  keydownHandler = handleKeyDown;
  clickHandler = handleClick;
  focusInHandler = handleFocusIn;
  focusOutHandler = handleFocusOut;
  selectionChangeHandler = () => scheduleCursorUpdate();

  window.addEventListener('keydown', keydownHandler, { capture: true });
  document.addEventListener('click', clickHandler, { capture: true });
  document.addEventListener('focusin', focusInHandler, { capture: true });
  document.addEventListener('focusout', focusOutHandler, { capture: true });
  document.addEventListener('selectionchange', selectionChangeHandler);
  window.addEventListener('resize', updateCursor, { passive: true });
  window.addEventListener('scroll', updateCursor, { passive: true });

  hudRetryAttempts = 0;
  updateHud();
  isListenerActive = true;
}

function deactivateListener(): void {
  if (!isListenerActive) return;

  if (keydownHandler) window.removeEventListener('keydown', keydownHandler, { capture: true });
  if (clickHandler) document.removeEventListener('click', clickHandler, { capture: true });
  if (focusInHandler) document.removeEventListener('focusin', focusInHandler, { capture: true });
  if (focusOutHandler) document.removeEventListener('focusout', focusOutHandler, { capture: true });
  if (selectionChangeHandler)
    document.removeEventListener('selectionchange', selectionChangeHandler);

  window.removeEventListener('resize', updateCursor);
  window.removeEventListener('scroll', updateCursor);

  if (cursorUpdateRaf !== null) {
    cancelAnimationFrame(cursorUpdateRaf);
    cursorUpdateRaf = null;
  }

  stopHudRetry();
  clearSendReconcileTimer();

  setActiveInput(null);
  hideCursor();
  isListenerActive = false;
  keydownHandler = null;
  clickHandler = null;
  focusInHandler = null;
  focusOutHandler = null;
  selectionChangeHandler = null;
}

function reconcileListener(): void {
  if (isEnabled) {
    activateListener();
  } else {
    deactivateListener();
  }
}

async function loadSettings(): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.sync?.get) {
        resolve();
        return;
      }

      chrome.storage.sync.get({ [StorageKeys.INPUT_VIM_MODE]: false }, (result) => {
        isEnabled = result?.[StorageKeys.INPUT_VIM_MODE] === true;
        resolve();
      });
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) {
        console.warn('[InputVimMode] Failed to load settings:', error);
      }
      resolve();
    }
  });
}

function setupStorageListener(): void {
  if (storageListener) return;

  storageListener = (changes, areaName) => {
    if (areaName !== 'sync' || !(StorageKeys.INPUT_VIM_MODE in changes)) return;

    isEnabled = changes[StorageKeys.INPUT_VIM_MODE].newValue === true;
    reconcileListener();
  };

  try {
    if (typeof chrome !== 'undefined') {
      chrome.storage?.onChanged?.addListener(storageListener);
    }
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.warn('[InputVimMode] Failed to setup storage listener:', error);
    }
  }
}

function cleanup(): void {
  isEnabled = false;
  deactivateListener();
  clearUndoStack();

  if (storageListener) {
    try {
      if (typeof chrome !== 'undefined') {
        chrome.storage?.onChanged?.removeListener(storageListener);
      }
    } catch {
      // Ignore cleanup errors.
    }
    storageListener = null;
  }

  hudElement?.remove();
  cursorElement?.remove();
  clearHudMountClasses(hudMountElement);
  hudElement = null;
  hudMountElement = null;
  cursorElement = null;
}

export async function startInputVimMode(
  options: StartInputVimModeOptions = {},
): Promise<() => void> {
  if (options.forceEnabled) {
    isEnabled = true;
  } else {
    setupStorageListener();
    await loadSettings();
  }
  reconcileListener();

  return cleanup;
}
