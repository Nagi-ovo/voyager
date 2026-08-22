import browser from 'webextension-polyfill';

import { promptStorageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';
import { type PromptItem } from '@/core/types/sync';
import { getPromptNameComparisonKey, getPromptNameConflictIds } from '@/core/utils/promptName';

import { findChatInput, insertTextIntoChatInput } from '../chatInput/index';
import { findClosestSendActionButton, isSendKeyboardEvent } from '../sendBehavior/sendButton';

const ROOT_ID = 'gv-pm-slash-root';
const LIST_ID = 'gv-pm-slash-list';
const TOOLTIP_ID = 'gv-pm-slash-tooltip';
const TOKEN_CLASS = 'gv-pm-slash-token';
const TEXTAREA_TOKEN_CLASS = 'gv-pm-slash-textarea-token';
const TEXTAREA_TOKEN_NAME_CLASS = 'gv-pm-slash-textarea-token-name';
const NATIVE_TOKEN_MARKER_CLASS = 'gv-pm-slash-textarea-token-native';
const COVERED_SOURCE_MARKER_CLASS = 'gv-pm-slash-textarea-token-covered-source';
const SELECTED_TOKEN_MARKER_CLASS = 'gv-pm-slash-textarea-token-selected';
const INPUT_PROMPT_SELECTION_CLASS = 'gv-pm-slash-prompt-only-selection';
const TEXTAREA_HIDE_VALUE_CLASS = 'gv-pm-slash-textarea-hide-value';
const MAX_RESULTS = 8;
const TOKEN_SPACER = '\u00a0';
const TOOLTIP_HIDE_GRACE_MS = 150;

const CHAT_INPUT_SELECTOR =
  '[data-testid="chat-input"][contenteditable="true"], #prompt-textarea[contenteditable="true"], ' +
  'rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], ' +
  '.input-area textarea, textarea[placeholder*="Ask"], textarea';

const SEND_COMPOSER_SELECTOR =
  'form, .text-input-field, .input-area, ms-prompt-input-wrapper, chat-message';

export interface SlashPromptController {
  destroy: () => void;
}

export interface SlashPromptLifecycle {
  setEnabled: (enabled: boolean) => Promise<void>;
  destroy: () => void;
}

interface PromptQuery {
  input: HTMLElement;
  query: string;
  start: number;
  end: number;
  range: Range | null;
}

interface SlashPromptOptions {
  initialItems?: PromptItem[];
  initialCtrlEnterSend?: boolean;
}

interface SelectedPrompt {
  id: string;
  name: string;
  start: number;
  text: string;
}

interface PendingPromptEdit {
  start: number;
  end: number;
  previousLength: number;
}

type PromptBackspaceResult =
  | { kind: 'spacer'; caretOffset: number; token: HTMLElement | null }
  | { kind: 'prompt'; index: number; caretOffset: number };

const selectedPrompts = new Map<HTMLElement, SelectedPrompt[]>();

/** Keeps one slash controller alive while enabled and safely absorbs async enable/disable races. */
export function createSlashPromptLifecycle(
  start: () => Promise<SlashPromptController>,
): SlashPromptLifecycle {
  let enabled = false;
  let controller: SlashPromptController | null = null;
  let pendingStart: Promise<void> | null = null;

  const stopController = (): void => {
    controller?.destroy();
    controller = null;
  };

  const setEnabled = async (nextEnabled: boolean): Promise<void> => {
    enabled = nextEnabled;
    if (!enabled) {
      stopController();
      return;
    }
    if (controller) return;
    if (pendingStart) return pendingStart;

    const startAttempt = (async () => {
      const nextController = await start();
      if (enabled && !controller) controller = nextController;
      else nextController.destroy();
    })();
    pendingStart = startAttempt;
    try {
      await startAttempt;
    } finally {
      if (pendingStart === startAttempt) pendingStart = null;
    }
  };

  return {
    setEnabled,
    destroy: () => {
      enabled = false;
      stopController();
    },
  };
}

export function isGeminiSlashPromptSurface(pageUrl = window.location.href): boolean {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hostname === 'gemini.google.com' || hostname === 'business.gemini.google';
  } catch {
    return false;
  }
}

function isPromptItem(value: unknown): value is PromptItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PromptItem>;
  return typeof item.id === 'string' && typeof item.text === 'string';
}

function usablePrompts(items: PromptItem[]): PromptItem[] {
  const conflictIds = getPromptNameConflictIds(items);
  return items.filter(
    (item) => typeof item.name === 'string' && item.name.trim() !== '' && !conflictIds.has(item.id),
  );
}

/** Returns whether at least one saved Prompt can be addressed unambiguously by slash completion. */
export function hasSlashEligiblePrompts(items: PromptItem[]): boolean {
  return usablePrompts(items).length > 0;
}

/** Matches names only. Prompt body and tags are deliberately excluded. */
export function matchSlashPrompts(items: PromptItem[], query: string): PromptItem[] {
  const normalizedQuery = getPromptNameComparisonKey(query);
  return usablePrompts(items)
    .filter((item) => getPromptNameComparisonKey(item.name!).includes(normalizedQuery))
    .sort((left, right) => {
      const leftName = getPromptNameComparisonKey(left.name!);
      const rightName = getPromptNameComparisonKey(right.name!);
      const leftPrefix = leftName.startsWith(normalizedQuery) ? 0 : 1;
      const rightPrefix = rightName.startsWith(normalizedQuery) ? 0 : 1;
      return leftPrefix - rightPrefix || leftName.localeCompare(rightName);
    })
    .slice(0, MAX_RESULTS);
}

function inputFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('.gv-pm-panel, .gv-pm-slash-root, .gv-pm-slash-tooltip')) return null;
  const input = target.closest<HTMLElement>(CHAT_INPUT_SELECTOR);
  if (!input) return null;
  if (findChatInput({ requireVisible: false }) !== input) return null;
  if (input instanceof HTMLTextAreaElement) return input;
  if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') return input;
  return null;
}

function readText(input: HTMLElement): string {
  return input instanceof HTMLTextAreaElement
    ? input.value
    : input.innerText || input.textContent || '';
}

function getCaretOffset(input: HTMLElement): {
  prefix: string;
  range: Range | null;
  baseOffset: number;
} {
  if (input instanceof HTMLTextAreaElement) {
    const end = input.selectionStart ?? input.value.length;
    return { prefix: input.value.slice(0, end), range: null, baseOffset: 0 };
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { prefix: readText(input), range: null, baseOffset: 0 };
  }
  const selectionRange = selection.getRangeAt(0);
  if (!input.contains(selectionRange.commonAncestorContainer)) {
    return { prefix: readText(input), range: null, baseOffset: 0 };
  }

  const prefixRange = selectionRange.cloneRange();
  prefixRange.selectNodeContents(input);
  prefixRange.setEnd(selectionRange.endContainer, selectionRange.endOffset);
  const fullPrefix = prefixRange.toString();

  // An inserted token's real DOM text is the full prompt body. Slash parsing
  // must only inspect text typed after the last token, otherwise a URL or path
  // inside that hidden body could reopen completion immediately.
  const tokens = Array.from(input.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`));
  for (let index = tokens.length - 1; index >= 0; index--) {
    const tokenRange = document.createRange();
    tokenRange.selectNode(tokens[index]);
    if (tokenRange.compareBoundaryPoints(Range.END_TO_END, selectionRange) > 0) continue;
    const suffixRange = selectionRange.cloneRange();
    suffixRange.setStartAfter(tokens[index]);
    const prefix = suffixRange.toString();
    return {
      prefix,
      range: selectionRange.cloneRange(),
      baseOffset: fullPrefix.length - prefix.length,
    };
  }

  return { prefix: fullPrefix, range: selectionRange.cloneRange(), baseOffset: 0 };
}

function getPromptQuery(input: HTMLElement): PromptQuery | null {
  const { prefix, range, baseOffset } = getCaretOffset(input);
  const slashIndex = prefix.lastIndexOf('/');
  if (slashIndex < 0) return null;
  const previous = slashIndex === 0 ? '' : prefix[slashIndex - 1];
  if (previous && !/\s/.test(previous)) return null;

  const query = prefix.slice(slashIndex + 1);
  if (/^\s/.test(query) || /[\r\n]/.test(query) || query.includes('/')) return null;
  const end = baseOffset + prefix.length;
  return { input, query, start: baseOffset + slashIndex, end, range };
}

function allTextNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function findTextBoundary(
  root: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  let remaining = Math.max(0, offset);
  for (const node of allTextNodes(root)) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  const last = allTextNodes(root).at(-1);
  return last ? { node: last, offset: last.data.length } : null;
}

function placeCaretAtTextOffset(input: HTMLElement, offset: number): void {
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.setSelectionRange(offset, offset);
    return;
  }

  const range = document.createRange();
  const boundary = findTextBoundary(input, offset);
  if (boundary) {
    range.setStart(boundary.node, boundary.offset);
    range.collapse(true);
  } else {
    range.selectNodeContents(input);
    range.collapse(true);
  }
  const selection = window.getSelection();
  if (!selection) return;
  input.focus();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtInputStart(input: HTMLElement): void {
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.setSelectionRange(0, 0);
    return;
  }

  const range = document.createRange();
  const firstToken = input.querySelector<HTMLElement>(`.${TOKEN_CLASS}`);
  if (firstToken) {
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(input);
    prefixRange.setEndBefore(firstToken);
    if (prefixRange.toString() === '') {
      range.setStartBefore(firstToken);
      range.collapse(true);
    } else {
      const boundary = findTextBoundary(input, 0);
      if (boundary) range.setStart(boundary.node, boundary.offset);
    }
  } else {
    const boundary = findTextBoundary(input, 0);
    if (boundary) range.setStart(boundary.node, boundary.offset);
  }
  range.collapse(true);

  const selection = window.getSelection();
  if (!selection) return;
  input.focus();
  selection.removeAllRanges();
  selection.addRange(range);
}

function restoreCaretAfterInput(input: HTMLElement, offset: number): void {
  const prefix = readText(input).slice(0, offset);
  placeCaretAtTextOffset(input, offset);

  // Gemini can reconcile the editor in a microtask after handling `input` and
  // reset its selection to the end. Reapply only while this edit still owns
  // focus and the text before the deletion point is unchanged.
  queueMicrotask(() => {
    if (
      input.isConnected &&
      document.activeElement === input &&
      readText(input).slice(0, offset) === prefix
    ) {
      placeCaretAtTextOffset(input, offset);
    }
  });
}

function restoreCaretAfterPrompt(
  input: HTMLElement,
  token: HTMLElement | null,
  offset: number,
): void {
  const prefix = readText(input).slice(0, offset);
  const place = () => {
    if (!input.isConnected) return;
    if (token?.isConnected) {
      const range = document.createRange();
      range.setStartAfter(token);
      range.collapse(true);
      const selection = window.getSelection();
      if (!selection) return;
      input.focus();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    placeCaretAtTextOffset(input, offset);
  };
  place();
  queueMicrotask(() => {
    if (document.activeElement === input && readText(input).slice(0, offset) === prefix) place();
  });
}

function createQueryRange(query: PromptQuery): Range | null {
  if (query.input instanceof HTMLTextAreaElement) return null;
  const selectionRange = query.range;
  if (!selectionRange) return null;
  const start = findTextBoundary(query.input, query.start);
  const end = findTextBoundary(query.input, query.end);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function getQueryAnchorRect(query: PromptQuery, inputRect: DOMRect): DOMRect {
  const range = createQueryRange(query);
  if (!range || typeof range.getBoundingClientRect !== 'function') return inputRect;

  const rect = range.getBoundingClientRect();
  const isVisibleInsideInput =
    rect.height > 0 &&
    rect.bottom >= inputRect.top &&
    rect.top <= inputRect.bottom &&
    rect.right >= inputRect.left &&
    rect.left <= inputRect.right;
  return isVisibleInsideInput ? rect : inputRect;
}

function setCaretAfter(input: HTMLElement, node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  input.focus();
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchInput(input: HTMLElement): void {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function rememberPrompt(input: HTMLElement, prompt: PromptItem, start: number): void {
  const selected = selectedPrompts.get(input) || [];
  selected.push({ id: prompt.id, name: prompt.name!.trim(), start, text: prompt.text });
  selectedPrompts.set(input, selected);
}

function isTextareaPromptOnlyValue(inputText: string, selected: SelectedPrompt[]): boolean {
  return (
    selected.length === 1 &&
    selected[0].start === 0 &&
    inputText === `${selected[0].name}${TOKEN_SPACER}`
  );
}

function createPromptToken(prompt: PromptItem): HTMLSpanElement {
  const token = document.createElement('span');
  token.className = TOKEN_CLASS;
  token.contentEditable = 'false';
  token.dataset.gvPromptId = prompt.id;
  token.dataset.gvPromptName = prompt.name!.trim();
  token.dataset.gvPromptText = prompt.text;
  token.dataset.gvTheme = detectTheme();
  token.setAttribute('role', 'button');
  token.setAttribute('aria-label', prompt.name!.trim());
  token.textContent = prompt.name!.trim();
  applyPromptTokenColor(token);
  bindPromptTooltip(token, prompt.text);
  return token;
}

function replaceContentEditableQuery(query: PromptQuery, prompt: PromptItem): boolean {
  const range = createQueryRange(query);
  if (!range) return false;
  range.deleteContents();
  const token = createPromptToken(prompt);
  range.insertNode(token);
  const spacer = document.createTextNode(TOKEN_SPACER);
  token.after(spacer);
  setCaretAfter(query.input, spacer);
  dispatchInput(query.input);
  return true;
}

function replaceTextareaQuery(query: PromptQuery, prompt: PromptItem): boolean {
  const textarea = query.input as HTMLTextAreaElement;
  textarea.focus();
  textarea.setRangeText(`${prompt.name!.trim()}${TOKEN_SPACER}`, query.start, query.end, 'end');
  dispatchInput(textarea);
  return true;
}

function createTooltip(): HTMLDivElement {
  let tooltip = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.className = 'gv-pm-slash-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.addEventListener('mouseenter', cancelTooltipHide);
  tooltip.addEventListener('mouseleave', scheduleTooltipHide);
  document.body.appendChild(tooltip);
  return tooltip;
}

let tooltipHideTimer: number | null = null;

function cancelTooltipHide(): void {
  if (tooltipHideTimer === null) return;
  window.clearTimeout(tooltipHideTimer);
  tooltipHideTimer = null;
}

function detectTheme(): 'light' | 'dark' {
  if (
    document.querySelector('.theme-host.dark-theme') ||
    document.body.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark') ||
    document.body.getAttribute('data-theme') === 'dark'
  ) {
    return 'dark';
  }
  if (
    document.querySelector('.theme-host.light-theme') ||
    document.body.classList.contains('light-theme') ||
    document.documentElement.classList.contains('light') ||
    document.body.getAttribute('data-theme') === 'light'
  ) {
    return 'light';
  }
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyPromptTokenColor(token: HTMLElement): void {
  token.dataset.gvTheme = detectTheme();
  // Gemini's editor applies host styles to contenteditable=false spans. An
  // inline custom property feeds the stylesheet's important declaration, so
  // the selected prompt follows Voyager's configurable accent even when a
  // Gemini host selector would otherwise win.
  token.style.setProperty(
    '--gv-pm-slash-token-color',
    'var(--gv-pm-brand, var(--gv-pm-brand-default))',
  );
}

function bindPromptTooltip(target: HTMLElement, text: string): void {
  target.addEventListener('mouseenter', () => showTooltip(target, text));
  target.addEventListener('mouseleave', scheduleTooltipHide);
}

function showTooltip(target: HTMLElement, text: string): void {
  cancelTooltipHide();
  const tooltip = createTooltip();
  tooltip.scrollTop = 0;
  tooltip.textContent = text;
  tooltip.dataset.gvTheme = detectTheme();
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  tooltip.classList.add('gv-pm-slash-tooltip-visible');
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const padding = 8;
  let left: number;
  let top: number;
  if (target.closest(`#${ROOT_ID}`)) {
    // Slash completion is anchored to Gemini's bottom composer. Keep prompt
    // previews above the whole result list so moving between rows never makes
    // the preview jump from one side to the other. Only fall below when the
    // viewport genuinely has no room above.
    const listRect = target.closest<HTMLElement>(`#${ROOT_ID}`)!.getBoundingClientRect();
    left = Math.max(
      padding,
      Math.min(listRect.left, window.innerWidth - tooltipRect.width - padding),
    );
    top = listRect.top - tooltipRect.height - 6;
    if (top < padding) top = listRect.bottom + 6;
    top = Math.max(padding, Math.min(top, window.innerHeight - tooltipRect.height - padding));
  } else {
    left = Math.max(
      padding,
      Math.min(
        targetRect.right - tooltipRect.width,
        window.innerWidth - tooltipRect.width - padding,
      ),
    );
    top = targetRect.bottom + 6;
    if (top + tooltipRect.height > window.innerHeight - padding) {
      top = Math.max(padding, targetRect.top - tooltipRect.height - 6);
    }
  }
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip(): void {
  cancelTooltipHide();
  document.getElementById(TOOLTIP_ID)?.classList.remove('gv-pm-slash-tooltip-visible');
}

function scheduleTooltipHide(): void {
  cancelTooltipHide();
  tooltipHideTimer = window.setTimeout(() => {
    tooltipHideTimer = null;
    document.getElementById(TOOLTIP_ID)?.classList.remove('gv-pm-slash-tooltip-visible');
  }, TOOLTIP_HIDE_GRACE_MS);
}

function getPromptAnchor(
  input: HTMLElement,
  prompt: SelectedPrompt,
): { nativeToken: HTMLElement | null; rect: DOMRect | null; styleSource: Element } {
  const start = findTextBoundary(input, prompt.start);
  const end = findTextBoundary(input, prompt.start + prompt.name.length);
  if (!start || !end) return { nativeToken: null, rect: null, styleSource: input };

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const startElement = start.node.parentElement;
  const nativeToken =
    startElement?.closest<HTMLElement>(`.${TOKEN_CLASS}`) ||
    Array.from(input.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`)).find(
      (token) => token.dataset.gvPromptId === prompt.id && range.intersectsNode(token),
    ) ||
    null;
  const styleSource = nativeToken || startElement || input;
  if (typeof range.getBoundingClientRect === 'function') {
    const rangeRect = range.getBoundingClientRect();
    if (rangeRect.width && rangeRect.height) return { nativeToken, rect: rangeRect, styleSource };
  }
  const tokenRect = nativeToken?.getBoundingClientRect();
  return {
    nativeToken,
    rect: tokenRect?.width && tokenRect.height ? tokenRect : null,
    styleSource,
  };
}

function syncMarkerTypography(marker: HTMLElement, source: Element, rect: DOMRect | null): void {
  const sourceStyle = window.getComputedStyle(source);
  const properties = [
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'font-stretch',
    'font-variant',
    'font-kerning',
    'font-feature-settings',
    'font-variation-settings',
    'font-optical-sizing',
    'letter-spacing',
    'word-spacing',
    'text-rendering',
    'text-transform',
  ];
  properties.forEach((property) =>
    marker.style.setProperty(property, sourceStyle.getPropertyValue(property)),
  );
  marker.style.lineHeight =
    sourceStyle.lineHeight === 'normal' && rect ? `${rect.height}px` : sourceStyle.lineHeight;
}

function isRectInsideInput(rect: DOMRect, inputRect: DOMRect): boolean {
  return (
    rect.top >= inputRect.top &&
    rect.bottom <= inputRect.bottom &&
    rect.left >= inputRect.left &&
    rect.right <= inputRect.right
  );
}

function cssColorAlpha(color: string): number {
  if (!color || color === 'transparent') return 0;
  const slashAlpha = color.match(/\/\s*([\d.]+)(%)?\s*\)$/);
  if (slashAlpha) {
    const value = Number(slashAlpha[1]);
    return slashAlpha[2] ? value / 100 : value;
  }
  const rgbaAlpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/i);
  return rgbaAlpha ? Number(rgbaAlpha[1]) : 1;
}

function findInputSurfaceColor(input: HTMLElement): string | null {
  let current: HTMLElement | null = input;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      (!style.backgroundImage || style.backgroundImage === 'none') &&
      cssColorAlpha(style.backgroundColor) >= 0.99
    ) {
      return style.backgroundColor;
    }
    current = current.parentElement;
  }
  return null;
}

function positionTextareaTokens(container: HTMLElement, input: HTMLElement): void {
  const rect = input.getBoundingClientRect();
  const inputSurfaceColor = findInputSurfaceColor(input);
  if (input instanceof HTMLTextAreaElement) {
    container.dataset.gvInputKind = 'textarea';
    container.style.left = `${Math.round(rect.left + 8)}px`;
    container.style.top = `${Math.round(rect.top + 6)}px`;
    container.style.maxWidth = `${Math.max(120, rect.width - 16)}px`;
    container.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`).forEach((marker) => {
      marker.classList.remove(NATIVE_TOKEN_MARKER_CLASS);
      marker.classList.remove(COVERED_SOURCE_MARKER_CLASS);
      marker.style.removeProperty('background-color');
      if (inputSurfaceColor) {
        marker.style.setProperty('--gv-pm-slash-input-surface', inputSurfaceColor);
      } else {
        marker.style.removeProperty('--gv-pm-slash-input-surface');
      }
      marker.style.removeProperty('left');
      marker.style.removeProperty('top');
      marker.style.removeProperty('max-width');
    });
    return;
  }

  container.dataset.gvInputKind = 'contenteditable';
  container.style.left = '0px';
  container.style.top = '0px';
  container.style.removeProperty('max-width');
  const prompts = selectedPrompts.get(input) || [];
  const markers = Array.from(container.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`));
  prompts.forEach((prompt, index) => {
    const marker = markers[index];
    if (!marker) return;
    const anchor = getPromptAnchor(input, prompt);
    const anchorRect = anchor.rect;
    const left = anchorRect?.left ?? rect.left;
    syncMarkerTypography(marker, anchor.styleSource, anchorRect);
    // Contenteditable markers keep this geometry for hover hit-testing, but
    // only paint their glyphs when an opaque editor surface can cover the
    // rebuilt plain-text source underneath without introducing a visible chip.
    marker.classList.toggle(NATIVE_TOKEN_MARKER_CLASS, Boolean(anchor.nativeToken));
    const canCoverSource = !anchor.nativeToken && Boolean(inputSurfaceColor);
    marker.classList.toggle(COVERED_SOURCE_MARKER_CLASS, canCoverSource);
    if (canCoverSource) marker.style.backgroundColor = inputSurfaceColor!;
    else marker.style.removeProperty('background-color');
    if (inputSurfaceColor) {
      marker.style.setProperty('--gv-pm-slash-input-surface', inputSurfaceColor);
    } else {
      marker.style.removeProperty('--gv-pm-slash-input-surface');
    }
    // The marker is fixed to the viewport while the editor scrolls its own
    // content. Hide it once the prompt range leaves the editor's visible area;
    // otherwise a long collapsed composer can leak the name outside the box.
    marker.hidden = Boolean(anchorRect && !isRectInsideInput(anchorRect, rect));
    marker.style.left = `${Math.round(left)}px`;
    marker.style.top = `${Math.round(anchorRect?.top ?? rect.top)}px`;
    marker.style.maxWidth = `${Math.max(20, rect.right - left)}px`;
  });
  input.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`).forEach(applyPromptTokenColor);
}

function removeTextareaTokens(container: HTMLElement, input: HTMLElement | null = null): void {
  container.replaceChildren();
  container.classList.remove('gv-pm-slash-textarea-tokens-visible');
  delete container.dataset.gvInputKind;
  if (input) {
    selectedPrompts.delete(input);
    input.classList.remove(INPUT_PROMPT_SELECTION_CLASS);
    input.classList.remove('gv-pm-slash-textarea-has-token');
    input.classList.remove(TEXTAREA_HIDE_VALUE_CLASS);
    input.classList.remove('gv-pm-slash-contenteditable-hide-value');
    if (input instanceof HTMLTextAreaElement) {
      input.style.removeProperty('--gv-pm-slash-native-padding-top');
      input.style.removeProperty('--gv-pm-slash-token-offset');
    }
  }
}

function removeTextareaTokenAt(container: HTMLElement, input: HTMLElement, index: number): boolean {
  const remaining = selectedPrompts.get(input) || [];
  if (remaining.length === 0) {
    removeTextareaTokens(container, input);
    return true;
  }
  const marker = container.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`)[index];
  marker?.remove();
  return false;
}

function replaceRangeWithPromptBody(input: HTMLElement, range: Range, body: string): boolean {
  if (!body.includes('\n')) {
    range.deleteContents();
    if (body.length > 0) range.insertNode(document.createTextNode(body));
    return true;
  }
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return insertTextIntoChatInput(body, input);
}

function expandPromptTokens(input?: HTMLElement | null): void {
  const tokens = Array.from(
    (input || document).querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`),
  ).reverse();
  if (input) {
    // These offsets describe the editor before live token bodies change its text length.
    const selected = [...(selectedPrompts.get(input) || [])].sort(
      (left, right) => right.start - left.start,
    );
    for (const prompt of selected) {
      // A live token is expanded by the DOM-token pass below. The remembered
      // offset exists so a token that Gemini rebuilt as plain text can still
      // be expanded; applying both paths to the same live token duplicates
      // its body because a Range can insert text inside contenteditable=false.
      if (getPromptAnchor(input, prompt).nativeToken) continue;
      if (readText(input).slice(prompt.start, prompt.start + prompt.name.length) !== prompt.name) {
        continue;
      }
      const start = findTextBoundary(input, prompt.start);
      const end = findTextBoundary(input, prompt.start + prompt.name.length);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      replaceRangeWithPromptBody(input, range, prompt.text);
    }
  }
  for (const token of tokens) {
    const body = token.dataset.gvPromptText || token.textContent || '';
    const tokenInput = input || token.closest<HTMLElement>(CHAT_INPUT_SELECTOR);
    if (!tokenInput) continue;
    const range = document.createRange();
    range.selectNode(token);
    replaceRangeWithPromptBody(tokenInput, range, body);
  }
  if (input && (tokens.length > 0 || selectedPrompts.has(input))) {
    selectedPrompts.delete(input);
    input.classList.remove(INPUT_PROMPT_SELECTION_CLASS);
    dispatchInput(input);
  }
}

function expandTextareaPromptTokens(input: HTMLTextAreaElement): void {
  const selected = [...(selectedPrompts.get(input) || [])].sort(
    (left, right) => right.start - left.start,
  );
  let value = input.value;
  for (const prompt of selected) {
    const name = prompt.name;
    const body = prompt.text;
    const index =
      value.slice(prompt.start, prompt.start + name.length) === name ? prompt.start : -1;
    if (index >= 0) value = `${value.slice(0, index)}${body}${value.slice(index + name.length)}`;
  }
  if (value !== input.value) {
    input.value = value;
    dispatchInput(input);
  }
  selectedPrompts.delete(input);
  input.classList.remove(INPUT_PROMPT_SELECTION_CLASS);
}

function hasPromptToken(input: HTMLElement): boolean {
  return selectedPrompts.has(input) || Boolean(input.querySelector(`.${TOKEN_CLASS}`));
}

function getInputSelectionOffsets(input: HTMLElement): { start: number; end: number } | null {
  if (input instanceof HTMLTextAreaElement) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    return start === null || end === null ? null : { start, end };
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return null;

  const startRange = document.createRange();
  startRange.selectNodeContents(input);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = document.createRange();
  endRange.selectNodeContents(input);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}

function getSelectedPromptIndexes(input: HTMLElement): number[] {
  const prompts = selectedPrompts.get(input) || [];
  if (prompts.length === 0) return [];

  const selection = getInputSelectionOffsets(input);
  if (!selection || selection.start === selection.end) return [];
  return prompts.flatMap((prompt, index) => {
    const promptEnd = prompt.start + prompt.name.length;
    return selection.start < promptEnd && selection.end > prompt.start ? [index] : [];
  });
}

function isPromptOnlySelection(input: HTMLElement, selectedIndexes: number[]): boolean {
  if (selectedIndexes.length === 0) return false;
  const selection = getInputSelectionOffsets(input);
  if (!selection || selection.start === selection.end) return false;
  const prompts = selectedPrompts.get(input) || [];
  const inputText = readText(input);

  for (let offset = selection.start; offset < selection.end; offset++) {
    if (/\s/.test(inputText[offset] || '')) continue;
    const belongsToPrompt = selectedIndexes.some((index) => {
      const prompt = prompts[index];
      return prompt && offset >= prompt.start && offset < prompt.start + prompt.name.length;
    });
    if (!belongsToPrompt) return false;
  }
  return true;
}

function findPromptInputForSendButton(button: HTMLElement): HTMLElement | null {
  let ancestor = button.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (ancestor.matches(SEND_COMPOSER_SELECTOR)) {
      const input = Array.from(ancestor.querySelectorAll<HTMLElement>(CHAT_INPUT_SELECTOR)).find(
        (candidate) => hasPromptToken(candidate),
      );
      if (input) return input;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function refreshPromptStarts(
  input: HTMLElement,
  inputText: string,
  pendingEdit: PendingPromptEdit | null,
): void {
  for (const prompt of selectedPrompts.get(input) || []) {
    // Move the remembered occurrence by the real edit delta before matching names.
    // Otherwise an identical name inserted at the old offset can steal this prompt.
    if (pendingEdit && pendingEdit.end <= prompt.start) {
      prompt.start = Math.max(0, prompt.start + inputText.length - pendingEdit.previousLength);
    }
    const candidates: number[] = [];
    let index = inputText.indexOf(prompt.name);
    while (index >= 0) {
      candidates.push(index);
      index = inputText.indexOf(prompt.name, index + prompt.name.length);
    }
    if (candidates.length > 0) {
      prompt.start = candidates.reduce((closest, candidate) =>
        Math.abs(candidate - prompt.start) < Math.abs(closest - prompt.start) ? candidate : closest,
      );
    }
  }
}

function getAtomicPromptGap(range: Range): string | null {
  const contents = range.cloneContents();
  if (contents.querySelector('*')) return null;
  const gap = contents.textContent || '';
  return gap === '' || gap === TOKEN_SPACER ? gap : null;
}

function findPromptTokenBeforeCaret(
  input: HTMLElement,
  promptId: string,
  startOffset: number,
  caretRange: Range,
): { token: HTMLElement; start: number } | null {
  const candidates = Array.from(input.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`))
    .filter((candidate) => candidate.dataset.gvPromptId === promptId)
    .map((token) => {
      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(input);
      prefixRange.setEndBefore(token);
      return { token, start: prefixRange.toString().length };
    });
  const candidatesBeforeCaret = candidates.filter(({ token }) => {
    const tokenRange = document.createRange();
    tokenRange.selectNode(token);
    return tokenRange.compareBoundaryPoints(Range.END_TO_END, caretRange) <= 0;
  });
  const exact = candidatesBeforeCaret.find((candidate) => candidate.start === startOffset);
  if (exact) return exact;
  return candidatesBeforeCaret.sort((left, right) => right.start - left.start)[0] || null;
}

function handlePromptBackspace(input: HTMLElement): PromptBackspaceResult | null {
  const prompts = selectedPrompts.get(input) || [];
  if (prompts.length === 0) return null;

  if (input instanceof HTMLTextAreaElement) {
    const caret = input.selectionStart ?? 0;
    if (caret !== input.selectionEnd) return null;
    for (let index = prompts.length - 1; index >= 0; index--) {
      const prompt = prompts[index];
      const start = prompt.start;
      const promptEnd = start + prompt.name.length;
      if (input.value.slice(start, promptEnd) !== prompt.name) continue;
      if (caret < promptEnd) continue;
      const gap = input.value.slice(promptEnd, caret);
      if (gap !== '' && gap !== TOKEN_SPACER) continue;
      if (gap === TOKEN_SPACER) {
        const caretOffset = caret - TOKEN_SPACER.length;
        input.setRangeText('', caretOffset, caret, 'end');
        return { kind: 'spacer', caretOffset, token: null };
      }
      input.setRangeText('', start, caret, 'end');
      prompts.splice(index, 1);
      if (prompts.length === 0) {
        selectedPrompts.delete(input);
      }
      return { kind: 'prompt', index, caretOffset: start };
    }
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const caretRange = selection.getRangeAt(0);
  if (!caretRange.collapsed || !input.contains(caretRange.commonAncestorContainer)) return null;
  const prefixRange = caretRange.cloneRange();
  prefixRange.selectNodeContents(input);
  prefixRange.setEnd(caretRange.endContainer, caretRange.endOffset);
  const prefix = prefixRange.toString();

  for (let index = prompts.length - 1; index >= 0; index--) {
    const prompt = prompts[index];
    let startOffset = prompt.start;
    const tokenMatch = findPromptTokenBeforeCaret(input, prompt.id, startOffset, caretRange);
    const token = tokenMatch?.token || null;
    if (tokenMatch) {
      startOffset = tokenMatch.start;
      prompt.start = startOffset;
    }
    if (!token && prefix.slice(startOffset, startOffset + prompt.name.length) !== prompt.name) {
      continue;
    }
    const gapRange = caretRange.cloneRange();
    if (token) {
      gapRange.setStartAfter(token);
    } else {
      const promptEnd = findTextBoundary(input, startOffset + prompt.name.length);
      if (!promptEnd) continue;
      gapRange.setStart(promptEnd.node, promptEnd.offset);
    }
    const gap = getAtomicPromptGap(gapRange);
    if (gap === null) continue;
    if (gap === TOKEN_SPACER) {
      gapRange.deleteContents();
      gapRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(gapRange);
      return {
        kind: 'spacer',
        caretOffset: startOffset + prompt.name.length,
        token,
      };
    }
    const deleteRange = caretRange.cloneRange();
    if (token) {
      deleteRange.setStartBefore(token);
    } else {
      const start = findTextBoundary(input, startOffset);
      if (!start) return null;
      deleteRange.setStart(start.node, start.offset);
    }
    deleteRange.deleteContents();
    deleteRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(deleteRange);
    prompts.splice(index, 1);
    if (prompts.length === 0) {
      selectedPrompts.delete(input);
    }
    return { kind: 'prompt', index, caretOffset: startOffset };
  }
  return null;
}

export function expandAllPromptTokens(): void {
  const inputs = new Set<HTMLElement>();
  document.querySelectorAll<HTMLElement>(`.${TOKEN_CLASS}`).forEach((token) => {
    const input = token.closest<HTMLElement>(CHAT_INPUT_SELECTOR);
    if (input) inputs.add(input);
  });
  for (const input of inputs) expandPromptTokens(input);
  for (const input of selectedPrompts.keys()) {
    if (input instanceof HTMLTextAreaElement) expandTextareaPromptTokens(input);
    else expandPromptTokens(input);
  }
  document
    .querySelectorAll<HTMLTextAreaElement>('textarea.gv-pm-slash-textarea-has-token')
    .forEach((input) => expandTextareaPromptTokens(input));
  document.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`).forEach((token) => {
    token.parentElement?.classList.remove('gv-pm-slash-textarea-tokens-visible');
    token.remove();
  });
  document
    .querySelectorAll<HTMLTextAreaElement>('textarea.gv-pm-slash-textarea-has-token')
    .forEach((input) => {
      input.classList.remove('gv-pm-slash-textarea-has-token', TEXTAREA_HIDE_VALUE_CLASS);
      input.style.removeProperty('--gv-pm-slash-native-padding-top');
      input.style.removeProperty('--gv-pm-slash-token-offset');
    });
}

export function startPromptSlashCommand(options: SlashPromptOptions = {}): SlashPromptController {
  if (!document.body || document.getElementById(ROOT_ID)) return { destroy: () => {} };

  let items = Array.isArray(options.initialItems) ? options.initialItems.filter(isPromptItem) : [];
  let activeInput: HTMLElement | null = null;
  let activeQuery: PromptQuery | null = null;
  let selectedIndex = 0;
  let results: PromptItem[] = [];
  let textareaTokenInput: HTMLElement | null = null;
  let ctrlEnterSendEnabled = options.initialCtrlEnterSend === true;
  const slashRefreshSuppressedInputs = new WeakSet<HTMLElement>();
  const pendingPromptEdits = new WeakMap<HTMLElement, PendingPromptEdit>();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gv-pm-slash-root';
  root.dataset.gvInteraction = 'keyboard';
  root.hidden = true;
  const list = document.createElement('div');
  list.id = LIST_ID;
  list.className = 'gv-pm-slash-list';
  list.setAttribute('role', 'listbox');
  root.appendChild(list);
  document.body.appendChild(root);

  const textareaTokens = document.createElement('div');
  textareaTokens.className = 'gv-pm-slash-textarea-tokens';
  textareaTokens.setAttribute('aria-hidden', 'false');
  document.body.appendChild(textareaTokens);

  const tokenResizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (!textareaTokenInput?.isConnected) return;
          positionTextareaTokens(textareaTokens, textareaTokenInput);
          requestAnimationFrame(() => {
            if (textareaTokenInput?.isConnected) {
              positionTextareaTokens(textareaTokens, textareaTokenInput);
            }
          });
        })
      : null;

  function close(): void {
    root.hidden = true;
    activeInput = null;
    activeQuery = null;
    results = [];
    hideTooltip();
  }

  function syncPromptSelectionVisuals(): void {
    document
      .querySelectorAll<HTMLElement>(`.${INPUT_PROMPT_SELECTION_CLASS}`)
      .forEach((input) => input.classList.remove(INPUT_PROMPT_SELECTION_CLASS));
    textareaTokens
      .querySelectorAll<HTMLElement>(`.${SELECTED_TOKEN_MARKER_CLASS}`)
      .forEach((marker) => marker.classList.remove(SELECTED_TOKEN_MARKER_CLASS));

    for (const input of selectedPrompts.keys()) {
      const selectedIndexes = getSelectedPromptIndexes(input);
      if (selectedIndexes.length === 0) continue;
      if (isPromptOnlySelection(input, selectedIndexes)) {
        input.classList.add(INPUT_PROMPT_SELECTION_CLASS);
      }
      if (textareaTokenInput === input) {
        const markers = textareaTokens.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`);
        selectedIndexes.forEach((index) =>
          markers[index]?.classList.add(SELECTED_TOKEN_MARKER_CLASS),
        );
      }
      break;
    }
  }

  function expandTokensForSend(input: HTMLElement): void {
    close();
    slashRefreshSuppressedInputs.add(input);
    try {
      if (input instanceof HTMLTextAreaElement) {
        expandTextareaPromptTokens(input);
      } else {
        expandPromptTokens(input);
      }
    } finally {
      slashRefreshSuppressedInputs.delete(input);
    }
    if (textareaTokenInput === input) {
      removeTextareaTokens(textareaTokens, input);
      textareaTokenInput = null;
    }
  }

  function removeSelectedPromptRecords(input: HTMLElement, indexes: number[]): void {
    if (indexes.length === 0) return;
    const prompts = selectedPrompts.get(input);
    if (!prompts) return;
    const markers =
      textareaTokenInput === input
        ? Array.from(textareaTokens.querySelectorAll<HTMLElement>(`.${TEXTAREA_TOKEN_CLASS}`))
        : [];
    const descendingIndexes = [...new Set(indexes)].sort((left, right) => right - left);
    for (const index of descendingIndexes) {
      if (index < 0 || index >= prompts.length) continue;
      prompts.splice(index, 1);
      markers[index]?.remove();
    }
    if (prompts.length === 0) {
      if (textareaTokenInput === input) {
        removeTextareaTokens(textareaTokens, input);
        textareaTokenInput = null;
      } else {
        selectedPrompts.delete(input);
      }
      syncPromptSelectionVisuals();
      return;
    }
    selectedPrompts.set(input, prompts);
    input.classList.remove(TEXTAREA_HIDE_VALUE_CLASS);
    syncPromptSelectionVisuals();
  }

  function position(): void {
    const theme = detectTheme();
    root.dataset.gvTheme = theme;
    textareaTokens.dataset.gvTheme = theme;
    if (activeInput && activeQuery && !root.hidden) {
      const rect = activeInput.getBoundingClientRect();
      const anchorRect = getQueryAnchorRect(activeQuery, rect);
      const width = Math.max(120, Math.min(380, rect.width || 320, window.innerWidth - 16));
      root.style.width = `${Math.round(width)}px`;
      root.style.left = `${Math.round(
        Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8)),
      )}px`;
      const listHeight = list.getBoundingClientRect().height || 240;
      const below = anchorRect.bottom + 6;
      const above = anchorRect.top - listHeight - 6;
      const spaceBelow = window.innerHeight - below - 8;
      const spaceAbove = anchorRect.top - 14;
      const preferredTop = spaceBelow >= listHeight || spaceBelow >= spaceAbove ? below : above;
      const maxTop = Math.max(8, window.innerHeight - listHeight - 8);
      root.style.top = `${Math.round(Math.max(8, Math.min(preferredTop, maxTop)))}px`;
    }
    if (textareaTokenInput) positionTextareaTokens(textareaTokens, textareaTokenInput);
  }

  function addTextareaToken(prompt: PromptItem, input: HTMLElement, hideValue: boolean): void {
    tokenResizeObserver?.disconnect();
    textareaTokenInput = input;
    tokenResizeObserver?.observe(input);
    const chip = document.createElement('span');
    chip.className = TEXTAREA_TOKEN_CLASS;
    const name = document.createElement('span');
    name.className = TEXTAREA_TOKEN_NAME_CLASS;
    name.textContent = prompt.name!.trim();
    chip.appendChild(name);
    syncMarkerTypography(chip, input, null);
    chip.dataset.gvPromptText = prompt.text;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', prompt.name!.trim());
    bindPromptTooltip(chip, prompt.text);
    textareaTokens.appendChild(chip);
    textareaTokens.classList.add('gv-pm-slash-textarea-tokens-visible');
    positionTextareaTokens(textareaTokens, input);
    if (hideValue && input instanceof HTMLTextAreaElement) {
      input.classList.add(TEXTAREA_HIDE_VALUE_CLASS);
    }
    if (
      input instanceof HTMLTextAreaElement &&
      !input.classList.contains('gv-pm-slash-textarea-has-token')
    ) {
      input.style.setProperty(
        '--gv-pm-slash-native-padding-top',
        window.getComputedStyle(input).paddingTop || '0px',
      );
      input.classList.add('gv-pm-slash-textarea-has-token');
    }
    const syncTokenOffset = () => {
      if (
        !textareaTokens.isConnected ||
        !(input instanceof HTMLTextAreaElement) ||
        !input.classList.contains('gv-pm-slash-textarea-has-token')
      ) {
        return;
      }
      const height = textareaTokens.getBoundingClientRect().height || 28;
      input.style.setProperty('--gv-pm-slash-token-offset', `${Math.ceil(height + 8)}px`);
    };
    syncTokenOffset();
    requestAnimationFrame(syncTokenOffset);
    syncPromptSelectionVisuals();
  }

  function confirm(index: number): boolean {
    if (!activeQuery || !results[index]) return false;
    const prompt = results[index];
    const query = activeQuery;
    const hideInputValue = query.start === 0 && query.end === readText(query.input).length;
    const inserted =
      query.input instanceof HTMLTextAreaElement
        ? replaceTextareaQuery(query, prompt)
        : replaceContentEditableQuery(query, prompt);
    if (!inserted) return false;
    rememberPrompt(query.input, prompt, query.start);
    if (query.input instanceof HTMLTextAreaElement) {
      const textarea = query.input;
      addTextareaToken(prompt, textarea, hideInputValue);
    } else {
      addTextareaToken(prompt, query.input, hideInputValue);
    }
    close();
    return true;
  }

  function render(nextResults: PromptItem[]): void {
    results = nextResults;
    selectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
    list.replaceChildren();
    if (results.length === 0) {
      close();
      return;
    }
    root.hidden = false;
    results.forEach((prompt, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gv-pm-slash-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
      const name = document.createElement('span');
      name.className = 'gv-pm-slash-option-name';
      name.textContent = prompt.name!.trim();
      row.appendChild(name);
      const tags = document.createElement('span');
      tags.className = 'gv-pm-slash-option-tags';
      for (const tag of prompt.tags || []) {
        const tagEl = document.createElement('span');
        tagEl.className = 'gv-pm-slash-option-tag';
        tagEl.textContent = tag;
        tags.appendChild(tagEl);
      }
      row.appendChild(tags);
      row.addEventListener('mouseenter', () => {
        root.dataset.gvInteraction = 'pointer';
        selectedIndex = index;
        renderSelectionState();
        showTooltip(row, prompt.text);
      });
      row.addEventListener('mouseleave', scheduleTooltipHide);
      row.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        confirm(index);
      });
      list.appendChild(row);
    });
    position();
  }

  function renderSelectionState(): void {
    list.querySelectorAll<HTMLElement>('.gv-pm-slash-option').forEach((option, index) => {
      option.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
    });
  }

  function refresh(target: EventTarget | null): void {
    const input = inputFromTarget(target);
    if (!input) return;
    const query = getPromptQuery(input);
    if (!query) {
      close();
      return;
    }
    activeInput = input;
    activeQuery = query;
    selectedIndex = 0;
    render(matchSlashPrompts(items, query.query));
  }

  function onInput(event: Event): void {
    const input = inputFromTarget(event.target);
    if (!input) return;
    if (slashRefreshSuppressedInputs.has(input)) return;
    const inputText = readText(input);
    if (textareaTokenInput && textareaTokenInput !== input) {
      const rememberedInput = textareaTokenInput;
      const rememberedPrompts = selectedPrompts.get(rememberedInput) || [];
      if (
        rememberedPrompts.length > 0 &&
        rememberedPrompts.every((prompt) => inputText.includes(prompt.name))
      ) {
        selectedPrompts.delete(rememberedInput);
        selectedPrompts.set(input, rememberedPrompts);
        const pendingEdit = pendingPromptEdits.get(rememberedInput);
        if (pendingEdit) {
          pendingPromptEdits.delete(rememberedInput);
          pendingPromptEdits.set(input, pendingEdit);
        }
        textareaTokenInput = input;
        tokenResizeObserver?.disconnect();
        tokenResizeObserver?.observe(input);
      } else {
        removeTextareaTokens(textareaTokens, rememberedInput);
        textareaTokenInput = null;
      }
    }
    const selected = selectedPrompts.get(input) || [];
    if (input instanceof HTMLTextAreaElement && !isTextareaPromptOnlyValue(inputText, selected)) {
      input.classList.remove(TEXTAREA_HIDE_VALUE_CLASS);
    }
    if (
      selected.length > 0 &&
      (!inputText.trim() || !selected.every((prompt) => inputText.includes(prompt.name)))
    ) {
      removeTextareaTokens(textareaTokens, textareaTokenInput);
      textareaTokenInput = null;
      selectedPrompts.delete(input);
    }
    const pendingEdit = pendingPromptEdits.get(input) || null;
    pendingPromptEdits.delete(input);
    refreshPromptStarts(input, inputText, pendingEdit);
    if (input instanceof HTMLTextAreaElement && !input.value.trim()) {
      removeTextareaTokens(textareaTokens, textareaTokenInput);
      textareaTokenInput = null;
      selectedPrompts.delete(input);
    }
    if (textareaTokenInput?.isConnected) {
      positionTextareaTokens(textareaTokens, textareaTokenInput);
      requestAnimationFrame(() => {
        if (textareaTokenInput?.isConnected) {
          positionTextareaTokens(textareaTokens, textareaTokenInput);
        }
      });
    }
    syncPromptSelectionVisuals();
    refresh(event.target);
  }

  function onKeydown(event: KeyboardEvent): void {
    const input = inputFromTarget(event.target);
    if (!input) return;
    if (event.isComposing) return;

    if (event.key === 'Home' && !event.shiftKey && !event.altKey && hasPromptToken(input)) {
      // A selected prompt starts with an atomic contenteditable=false token.
      // Native Home can place the selection inside that token, where browsers
      // keep focus on the editor but do not paint a caret.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      placeCaretAtInputStart(input);
      return;
    }

    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !root.hidden &&
      activeInput === input
    ) {
      // Gemini can rebuild the editor while deleting, which means the ensuing
      // input event may no longer resolve to this active input. Invalidate the
      // old completion now; a still-valid slash query will reopen on input.
      close();
    }

    const selectedPromptIndexes =
      event.key === 'Backspace' || event.key === 'Delete' ? getSelectedPromptIndexes(input) : [];
    if (selectedPromptIndexes.length > 0) {
      removeSelectedPromptRecords(input, selectedPromptIndexes);
      return;
    }

    const backspaceResult = event.key === 'Backspace' ? handlePromptBackspace(input) : null;
    if (backspaceResult) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (backspaceResult.kind === 'prompt') {
        const removedLastPrompt = removeTextareaTokenAt(
          textareaTokens,
          input,
          backspaceResult.index,
        );
        if (removedLastPrompt) textareaTokenInput = null;
      }
      dispatchInput(input);
      if (backspaceResult.kind === 'spacer') {
        restoreCaretAfterPrompt(input, backspaceResult.token, backspaceResult.caretOffset);
      } else {
        restoreCaretAfterInput(input, backspaceResult.caretOffset);
      }
      return;
    }

    if (!root.hidden && activeInput === input && results.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        root.dataset.gvInteraction = 'keyboard';
        selectedIndex =
          (selectedIndex + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
        renderSelectionState();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.altKey)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        confirm(selectedIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
    }

    if (event.key === 'Escape' && !root.hidden) {
      close();
      return;
    }

    if (isSendKeyboardEvent(event, ctrlEnterSendEnabled)) {
      if (!hasPromptToken(input)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      expandTokensForSend(input);
      window.setTimeout(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: event.code || 'Enter',
            bubbles: true,
            cancelable: true,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          }),
        );
      }, 0);
    }
  }

  function onBeforeInput(event: InputEvent): void {
    const input = inputFromTarget(event.target);
    if (!input) return;
    const selection = getInputSelectionOffsets(input);
    if (selection) {
      pendingPromptEdits.set(input, {
        ...selection,
        previousLength: readText(input).length,
      });
    }
    if (!event.inputType.startsWith('delete')) return;
    if (!root.hidden && activeInput === input) close();
    removeSelectedPromptRecords(input, getSelectedPromptIndexes(input));
  }

  function onPointerDown(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(`#${ROOT_ID}, #${TOOLTIP_ID}`)) return;
    if (!target?.closest(CHAT_INPUT_SELECTOR)) close();
  }

  function onSubmit(event: Event): void {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    const input = form.querySelector<HTMLElement>(CHAT_INPUT_SELECTOR);
    if (!input || !hasPromptToken(input)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    expandTokensForSend(input);
    const submitter = event instanceof SubmitEvent ? event.submitter : null;
    window.setTimeout(() => {
      if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
        form.requestSubmit(submitter);
      } else {
        form.requestSubmit();
      }
    }, 0);
  }

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? findClosestSendActionButton(target) : null;
    if (!button) return;
    const input = findPromptInputForSendButton(button);
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    expandTokensForSend(input);
    window.setTimeout(() => button.click(), 0);
  }

  function onPointerOver(event: PointerEvent): void {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>(`.${TOKEN_CLASS}`) : null;
    if (target) showTooltip(target, target.dataset.gvPromptText || target.textContent || '');
  }

  function onPointerOut(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target.closest(`.${TOKEN_CLASS}`) : null;
    if (target) scheduleTooltipHide();
  }

  function onStorageChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void {
    if (area === 'sync' && changes[StorageKeys.CTRL_ENTER_SEND]) {
      ctrlEnterSendEnabled = changes[StorageKeys.CTRL_ENTER_SEND].newValue === true;
      return;
    }
    if (area !== 'local') return;
    const change = changes[StorageKeys.PROMPT_ITEMS];
    if (!change || !Array.isArray(change.newValue)) return;
    items = change.newValue.filter(isPromptItem);
    if (activeInput && activeQuery) render(matchSlashPrompts(items, activeQuery.query));
  }

  const onScrollOrResize = () => position();
  document.addEventListener('input', onInput, true);
  document.addEventListener('beforeinput', onBeforeInput, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('selectionchange', syncPromptSelectionVisuals);
  document.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  browser.storage.onChanged.addListener(onStorageChanged);

  return {
    destroy: () => {
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('selectionchange', syncPromptSelectionVisuals);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      browser.storage.onChanged.removeListener(onStorageChanged);
      tokenResizeObserver?.disconnect();
      hideTooltip();
      expandAllPromptTokens();
      selectedPrompts.clear();
      removeTextareaTokens(textareaTokens, textareaTokenInput);
      root.remove();
      textareaTokens.remove();
      document.getElementById(TOOLTIP_ID)?.remove();
    },
  };
}

export async function startStoredPromptSlashCommand(): Promise<SlashPromptController> {
  const [stored, sendMode] = await Promise.all([
    promptStorageService.get<PromptItem[]>(StorageKeys.PROMPT_ITEMS),
    browser.storage.sync
      .get({ [StorageKeys.CTRL_ENTER_SEND]: false })
      .catch(() => ({ [StorageKeys.CTRL_ENTER_SEND]: false })),
  ]);
  return startPromptSlashCommand({
    initialItems: stored.success && Array.isArray(stored.data) ? stored.data : [],
    initialCtrlEnterSend: sendMode[StorageKeys.CTRL_ENTER_SEND] === true,
  });
}
