import browser from 'webextension-polyfill';

import { createHighlighterIcon } from '@/core/icons/highlighterIcon';
import { StorageKeys } from '@/core/types/common';
import {
  type HighlightColor,
  areHighlightColorsEqual,
  getHighlightColorHex,
  isHighlightColor,
  normalizeHighlightColorPalette,
} from '@/core/types/highlight';
import { getBrowserName } from '@/core/utils/browser';
import { getAssistantTurnSelectors, getUserTurnSelectors } from '@/core/utils/selectors';

import { getTranslationSync } from '../../../utils/i18n';
import { findChatInput } from '../chatInput/index';
import { HighlightManager } from '../highlight';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';

// ============================================================================
// Constants
// ============================================================================

/** CSS class names for quote reply button */
const CSS_CLASSES = {
  TOOLBAR: 'gv-selection-toolbar',
  BUTTON: 'gv-quote-btn',
  ACTION: 'gv-selection-action',
  HIGHLIGHT_BUTTON: 'gv-highlight-action',
  HIGHLIGHT_COLOR_BUTTON: 'gv-highlight-color-trigger',
  HIGHLIGHT_COLOR_PALETTE: 'gv-highlight-color-palette',
  HIDDEN: 'gv-hidden',
} as const;

/** Timing constants (in milliseconds) */
const TIMING = {
  /** Delay before performing insertion to wait for UI expansion transitions */
  INSERTION_DELAY_MS: 200,
  /** Debounce delay for selection change detection */
  SELECTION_DEBOUNCE_MS: 250,
} as const;

/** UI positioning constants (in pixels) */
const POSITIONING = {
  /** Minimum distance from viewport edge */
  MIN_EDGE_OFFSET_PX: 10,
  /** Gap between button and selection */
  BUTTON_SELECTION_GAP_PX: 16,
} as const;

/** SVG icon for the quote button */
const QUOTE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path></svg>`;
const EDIT_COLOR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;

const STYLE_ID = 'gemini-voyager-quote-reply-style';
const HIGHLIGHT_PREVIEW_CLASS = 'gv-highlight-selection-preview-active';
const HIGHLIGHT_PREVIEW_COLOR_PROPERTY = '--gv-highlight-selection-preview-color';
const QUOTEABLE_MESSAGE_SELECTOR = [
  '.conversation-container',
  ...getUserTurnSelectors(),
  ...getAssistantTurnSelectors(),
].join(', ');

function getHighlightPreviewBackground(color: HighlightColor): string {
  const hex = getHighlightColorHex(color);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.38)`;
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .gv-selection-toolbar {
      position: fixed;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      background-color: #1e1e1e;
      color: #fff;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid rgba(255,255,255,0.1);
      opacity: 1;
      pointer-events: auto;
    }
    .gv-selection-action {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
    }
    .gv-selection-action:hover,
    .gv-selection-action:focus-visible {
      background-color: #2d2d2d;
      outline: none;
    }
    .gv-selection-action svg {
      width: 14px;
      height: 14px;
      opacity: 0.9;
    }
    .gv-highlight-color-trigger {
      box-sizing: border-box;
      width: 22px;
      height: 22px;
      margin: 0 4px 0 1px;
      padding: 0;
      border: 2px solid rgba(255,255,255,0.72);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.34);
      cursor: pointer;
    }
    .gv-highlight-color-trigger:hover,
    .gv-highlight-color-trigger:focus-visible {
      outline: 2px solid #8ab4f8;
      outline-offset: 2px;
    }
    .gv-highlight-color-palette {
      position: fixed;
      display: flex;
      gap: 6px;
      padding: 7px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      background: #1e1e1e;
      box-shadow: 0 6px 18px rgba(0,0,0,0.24);
    }
    .gv-highlight-color-option {
      position: relative;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 2px solid transparent;
      border-radius: 50%;
      cursor: pointer;
    }
    .gv-highlight-color-option[aria-pressed="true"] {
      border-color: rgba(255, 255, 255, 0.94);
      outline: 2px solid #8ab4f8;
      outline-offset: 1px;
      box-shadow: 0 2px 8px rgba(138, 180, 248, 0.34);
    }
    .gv-highlight-color-option[aria-pressed="true"]::after {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #fff;
      content: "✓";
      font-size: 13px;
      font-weight: 800;
      line-height: 1;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.78);
    }
    .gv-highlight-color-edit {
      position: relative;
      display: grid;
      width: 26px;
      height: 26px;
      margin-inline-start: 2px;
      padding: 0;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.08);
      color: inherit;
      cursor: pointer;
      overflow: hidden;
    }
    .gv-highlight-color-edit:hover,
    .gv-highlight-color-edit:focus-visible {
      border-color: #8ab4f8;
      background: rgba(138, 180, 248, 0.16);
      outline: none;
    }
    .gv-highlight-custom-color {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }
    html.${HIGHLIGHT_PREVIEW_CLASS}::selection,
    html.${HIGHLIGHT_PREVIEW_CLASS} *::selection {
      background-color: var(${HIGHLIGHT_PREVIEW_COLOR_PROPERTY}) !important;
      color: inherit !important;
    }
    .gv-selection-toolbar.gv-hidden {
      opacity: 0;
      pointer-events: none;
      visibility: hidden;
    }
    .gv-selection-action.gv-hidden { display: none; }
    .gv-highlight-color-trigger.gv-hidden,
    .gv-highlight-color-palette.gv-hidden { display: none; }
    /* Light mode support */
    @media (prefers-color-scheme: light) {
      .gv-selection-toolbar {
        background-color: #fff;
        color: #1f1f1f;
        border: 1px solid rgba(0,0,0,0.08);
      }
      .gv-selection-action:hover,
      .gv-selection-action:focus-visible {
        background-color: #f5f5f5;
      }
      .gv-highlight-color-trigger {
        border-color: rgba(255,255,255,0.92);
        box-shadow: 0 0 0 1px rgba(0,0,0,0.24);
      }
      .gv-highlight-color-palette {
        border-color: rgba(0,0,0,0.10);
        background: #fff;
      }
      .gv-highlight-color-edit {
        border-color: rgba(0, 0, 0, 0.14);
        background: rgba(0, 0, 0, 0.04);
      }
    }
    /* Check for specific theme attributes if Gemini uses them */
    .theme-host.light-theme .gv-selection-toolbar,
    body[data-theme="light"] .gv-selection-toolbar {
      background-color: #fff;
      color: #1f1f1f;
      border: 1px solid rgba(0,0,0,0.08);
    }
    .theme-host.light-theme .gv-selection-action:hover,
    .theme-host.light-theme .gv-selection-action:focus-visible,
    body[data-theme="light"] .gv-selection-action:hover,
    body[data-theme="light"] .gv-selection-action:focus-visible {
       background-color: #f5f5f5;
    }
    .theme-host.light-theme .gv-highlight-color-palette,
    body[data-theme="light"] .gv-highlight-color-palette {
      border-color: rgba(0,0,0,0.10);
      background: #fff;
    }
    .theme-host.light-theme .gv-highlight-color-edit,
    body[data-theme="light"] .gv-highlight-color-edit {
      border-color: rgba(0, 0, 0, 0.14);
      background: rgba(0, 0, 0, 0.04);
    }
    .theme-host.dark-theme .gv-selection-toolbar,
    body[data-theme="dark"] .gv-selection-toolbar {
      background-color: #1e1e1e;
      color: #fff;
      border-color: rgba(255,255,255,0.1);
    }
    .theme-host.dark-theme .gv-selection-action:hover,
    .theme-host.dark-theme .gv-selection-action:focus-visible,
    body[data-theme="dark"] .gv-selection-action:hover,
    body[data-theme="dark"] .gv-selection-action:focus-visible {
      background-color: #2d2d2d;
    }
    body.gv-rtl .gv-selection-toolbar { flex-direction: row-reverse; }
  `;
  document.head.appendChild(style);
}

function countLineBreaks(raw: string): number {
  return (raw.match(/\n/g) || []).length;
}

interface SeparatorInsertResult {
  inserted: boolean;
  insertedBreaks: number;
}

function getContenteditableQuoteSeparator(): string {
  // Firefox + Quill contenteditable tends to render an extra visual break
  // for double-newline insertion, so we use a single newline separator there.
  return getBrowserName() === 'Firefox' ? '\n' : '\n\n';
}

function getPlaceholderCandidates(input: HTMLElement): string[] {
  const richTextarea = input.closest('rich-textarea');
  const candidates = [
    input.getAttribute('data-placeholder'),
    input.getAttribute('aria-placeholder'),
    input.getAttribute('placeholder'),
    richTextarea?.getAttribute('data-placeholder'),
    richTextarea?.getAttribute('aria-placeholder'),
    richTextarea?.getAttribute('placeholder'),
  ];

  return candidates.filter((value): value is string => Boolean(value)).map((value) => value.trim());
}

function isChatInputEmpty(input: HTMLElement | HTMLTextAreaElement): boolean {
  if (input instanceof HTMLTextAreaElement) {
    return input.value.trim().length === 0;
  }

  const rawContent = input.innerText ?? input.textContent ?? '';
  const trimmedContent = rawContent.trim();

  // If visible text exists and it's not placeholder text, treat as non-empty even if
  // Quill's `ql-blank` class lags behind DOM updates.
  if (trimmedContent.length > 0) {
    const placeholders = getPlaceholderCandidates(input);
    const isPlaceholderText = placeholders.some(
      (placeholder) => placeholder.length > 0 && placeholder === trimmedContent,
    );
    if (!isPlaceholderText) {
      return false;
    }
  }

  // Gemini currently uses Quill internals. `ql-blank` is its canonical empty marker.
  if (input.classList.contains('ql-blank')) {
    return true;
  }

  return trimmedContent.length === 0;
}

/**
 * Attempts to insert separator text via execCommand and reports whether
 * content changed plus how many line breaks were observed as inserted.
 */
function tryInsertQuoteSeparator(input: HTMLElement, separator: string): SeparatorInsertResult {
  const beforeVisible = input.innerText ?? '';
  const beforeRaw = input.textContent ?? '';
  const beforeVisibleLineBreakCount = countLineBreaks(beforeVisible);
  const beforeRawLineBreakCount = countLineBreaks(beforeRaw);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, separator);
  } catch {
    ok = false;
  }
  if (!ok) return { inserted: false, insertedBreaks: 0 };

  const afterVisible = input.innerText ?? '';
  const afterRaw = input.textContent ?? '';
  if (afterVisible === beforeVisible && afterRaw === beforeRaw) {
    return { inserted: false, insertedBreaks: 0 };
  }

  const visibleLineBreakDelta = countLineBreaks(afterVisible) - beforeVisibleLineBreakCount;
  const rawLineBreakDelta = countLineBreaks(afterRaw) - beforeRawLineBreakCount;
  const insertedBreaks = Math.max(0, visibleLineBreakDelta, rawLineBreakDelta);
  return { inserted: true, insertedBreaks };
}

function focusChatInput(input: HTMLElement | HTMLTextAreaElement): void {
  if (document.activeElement === input) {
    return;
  }

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

/**
 * Replace math elements in a cloned DOM tree with LaTeX text nodes.
 * Gemini uses `.math-inline` / `.math-block` containers with `[data-math]` children.
 */
function replaceMathWithLatex(root: DocumentFragment): void {
  // 1. Replace .math-inline / .math-block containers
  for (const container of Array.from(root.querySelectorAll('.math-inline, .math-block'))) {
    const dataMathEl = container.querySelector('[data-math]');
    const latex = dataMathEl?.getAttribute('data-math');
    if (latex) {
      const isBlock = container.classList.contains('math-block');
      container.replaceWith(document.createTextNode(isBlock ? `$$${latex}$$` : `$${latex}$`));
    }
  }

  // 2. Handle any remaining [data-math] elements not inside a container
  for (const el of Array.from(root.querySelectorAll('[data-math]'))) {
    const latex = el.getAttribute('data-math');
    if (latex) {
      el.replaceWith(document.createTextNode(`$${latex}$`));
    }
  }
}

/**
 * Extract text from a Range, preserving LaTeX math syntax.
 *
 * `Range.toString()` returns visually rendered text, which loses LaTeX
 * delimiters (e.g. `U∈[0,1)` instead of `$U \in [0, 1)$`). This function
 * clones the range contents, replaces math elements with their `$...$` /
 * `$$...$$` LaTeX source, then returns the resulting text.
 */
function extractTextWithLatex(range: Range): string {
  const fragment = range.cloneContents();

  // Short-circuit: no math elements → use native Range.toString()
  if (!fragment.querySelector('.math-inline, .math-block, [data-math]')) {
    return range.toString();
  }

  replaceMathWithLatex(fragment);

  // Use a temporary element to get innerText (preserves newlines from block elements / <br>)
  const temp = document.createElement('div');
  temp.style.position = 'fixed';
  temp.style.left = '-9999px';
  temp.style.opacity = '0';
  temp.style.pointerEvents = 'none';
  temp.appendChild(fragment);
  document.body.appendChild(temp);
  // innerText preserves newlines from block elements / <br>; textContent is the fallback
  const text = temp.innerText ?? temp.textContent ?? '';
  temp.remove();

  return text;
}

interface QuoteReplyOptions {
  quoteEnabled?: boolean;
  highlightEnabled?: boolean;
  highlightDefaultColor?: HighlightColor;
  highlightColorPalette?: readonly HighlightColor[];
  highlightTimelineMarkersEnabled?: boolean;
}

export function startQuoteReply(options: QuoteReplyOptions = {}) {
  injectStyles();

  const quoteEnabled = options.quoteEnabled !== false;
  let highlightEnabled = options.highlightEnabled !== false;
  let highlightColors = normalizeHighlightColorPalette(
    options.highlightColorPalette,
    options.highlightDefaultColor,
  );
  let selectedHighlightSlot = Math.max(
    0,
    highlightColors.findIndex((color) =>
      areHighlightColorsEqual(color, options.highlightDefaultColor ?? 'yellow'),
    ),
  );
  let selectedHighlightColor = highlightColors[selectedHighlightSlot];
  let highlightTimelineMarkersEnabled = options.highlightTimelineMarkersEnabled !== false;
  let highlightManager: HighlightManager | null = null;

  const startHighlightManager = () => {
    if (highlightManager) return;
    const manager = new HighlightManager();
    manager.setColorPalette(highlightColors);
    manager.setTimelineMarkersEnabled(highlightTimelineMarkersEnabled);
    highlightManager = manager;
    void manager.init();
  };

  const stopHighlightManager = () => {
    highlightManager?.destroy();
    highlightManager = null;
  };

  if (highlightEnabled) startHighlightManager();

  let selectionToolbar: HTMLElement | null = null;
  let quoteBtn: HTMLElement | null = null;
  let highlightBtn: HTMLButtonElement | null = null;
  let highlightColorBtn: HTMLButtonElement | null = null;
  let highlightColorPalette: HTMLElement | null = null;
  let highlightCustomColorInput: HTMLInputElement | null = null;
  let currentSelectionRange: Range | null = null;
  let isInternalClick = false;
  let scrollRafId: number | null = null;
  let selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  function closeHighlightColorPalette(): void {
    highlightColorPalette?.classList.add(CSS_CLASSES.HIDDEN);
    highlightColorBtn?.setAttribute('aria-expanded', 'false');
  }

  function previewHighlightColor(): void {
    document.documentElement.style.setProperty(
      HIGHLIGHT_PREVIEW_COLOR_PROPERTY,
      getHighlightPreviewBackground(selectedHighlightColor),
    );
    document.documentElement.classList.add(HIGHLIGHT_PREVIEW_CLASS);
  }

  function clearHighlightColorPreview(): void {
    document.documentElement.classList.remove(HIGHLIGHT_PREVIEW_CLASS);
    document.documentElement.style.removeProperty(HIGHLIGHT_PREVIEW_COLOR_PROPERTY);
  }

  function restoreCurrentSelection(): void {
    if (!currentSelectionRange) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(currentSelectionRange.cloneRange());
  }

  function getHighlightColorLabel(index: number): string {
    return `${getTranslationSync('highlightColor')} ${index + 1}`;
  }

  function getHighlightColorEditLabel(): string {
    return `${getTranslationSync('highlightCustomColor')} · ${getHighlightColorLabel(selectedHighlightSlot)}`;
  }

  function positionHighlightColorPalette(): void {
    if (
      !highlightColorBtn ||
      !highlightColorPalette ||
      highlightColorPalette.classList.contains(CSS_CLASSES.HIDDEN)
    ) {
      return;
    }

    const triggerRect = highlightColorBtn.getBoundingClientRect();
    const paletteRect = highlightColorPalette.getBoundingClientRect();
    const edge = POSITIONING.MIN_EDGE_OFFSET_PX;
    const gap = 6;
    const maxTop = Math.max(edge, window.innerHeight - paletteRect.height - edge);
    const maxLeft = Math.max(edge, window.innerWidth - paletteRect.width - edge);
    const opensAbove = triggerRect.bottom + gap + paletteRect.height > window.innerHeight - edge;
    const preferredTop = opensAbove
      ? triggerRect.top - paletteRect.height - gap
      : triggerRect.bottom + gap;
    const preferredLeft = triggerRect.left + triggerRect.width / 2 - paletteRect.width / 2;

    highlightColorPalette.style.top = `${Math.min(maxTop, Math.max(edge, preferredTop))}px`;
    highlightColorPalette.style.left = `${Math.min(maxLeft, Math.max(edge, preferredLeft))}px`;
  }

  function updateHighlightColorUi(): void {
    if (highlightColorBtn) {
      highlightColorBtn.style.backgroundColor = getHighlightColorHex(selectedHighlightColor);
      highlightColorBtn.title = getTranslationSync('highlightColor');
      highlightColorBtn.setAttribute('aria-label', getTranslationSync('highlightColor'));
    }
    highlightColorPalette
      ?.querySelectorAll<HTMLButtonElement>('.gv-highlight-color-option')
      .forEach((swatch) => {
        const slot = Number(swatch.dataset.highlightSlot);
        const color = highlightColors[slot];
        if (!color) return;
        swatch.style.backgroundColor = getHighlightColorHex(color);
        swatch.dataset.highlightColor = color;
        swatch.setAttribute('aria-pressed', String(slot === selectedHighlightSlot));
        swatch.setAttribute('aria-label', getHighlightColorLabel(slot));
      });
    if (highlightCustomColorInput) {
      highlightCustomColorInput.value = getHighlightColorHex(selectedHighlightColor);
    }
    const editColorControl = highlightColorPalette?.querySelector<HTMLElement>(
      '.gv-highlight-color-edit',
    );
    if (editColorControl) {
      const label = getHighlightColorEditLabel();
      editColorControl.title = label;
      highlightCustomColorInput?.setAttribute('aria-label', label);
    }
  }

  function selectHighlightColor(color: HighlightColor): void {
    const matchingSlot = highlightColors.findIndex((candidate) =>
      areHighlightColorsEqual(candidate, color),
    );
    if (matchingSlot >= 0) {
      selectedHighlightSlot = matchingSlot;
    } else {
      highlightColors = [color, ...highlightColors.slice(1)];
      selectedHighlightSlot = 0;
      highlightManager?.setColorPalette(highlightColors);
    }
    selectedHighlightColor = highlightColors[selectedHighlightSlot];
    updateHighlightColorUi();
  }

  /** Update button position based on current selection range's viewport coordinates. */
  function updatePosition() {
    if (!selectionToolbar || !currentSelectionRange) return;

    const rangeRect = currentSelectionRange.getBoundingClientRect();

    // Hide when selection is scrolled out of viewport
    const isOffScreen = rangeRect.bottom < 0 || rangeRect.top > window.innerHeight;

    if (isOffScreen) {
      if (!selectionToolbar.classList.contains(CSS_CLASSES.HIDDEN)) {
        selectionToolbar.classList.add(CSS_CLASSES.HIDDEN);
      }
      return;
    }

    if (selectionToolbar.classList.contains(CSS_CLASSES.HIDDEN)) {
      selectionToolbar.classList.remove(CSS_CLASSES.HIDDEN);
    }

    // Ensure the button is visible before measuring to get actual dimensions
    const btnRect = selectionToolbar.getBoundingClientRect();

    // Use getClientRects to get the precise position of the first line.
    // This prevents the button from being pushed down by empty space in multi-line selections.
    const firstLineRect =
      typeof currentSelectionRange.getClientRects === 'function'
        ? currentSelectionRange.getClientRects()[0] || rangeRect
        : rangeRect;

    // position: fixed uses viewport coordinates, no scrollY/X needed
    const top = firstLineRect.top - btnRect.height - POSITIONING.BUTTON_SELECTION_GAP_PX;
    const left = rangeRect.left + rangeRect.width / 2 - btnRect.width / 2;

    // Edge protection: prevent the button from being clipped or overflowing the viewport
    const maxLeft = window.innerWidth - btnRect.width - POSITIONING.MIN_EDGE_OFFSET_PX;

    selectionToolbar.style.top = `${Math.max(POSITIONING.MIN_EDGE_OFFSET_PX, top)}px`;
    selectionToolbar.style.left = `${Math.min(maxLeft, Math.max(POSITIONING.MIN_EDGE_OFFSET_PX, left))}px`;
    positionHighlightColorPalette();
  }

  function onScrollOrResize() {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      updatePosition();
      scrollRafId = null;
    });
  }

  // Create the shared selection toolbar. Quote and Highlight deliberately use
  // the same listener/range so two floating controls never race each other.
  function createButton() {
    if (selectionToolbar) return;
    selectionToolbar = document.createElement('div');
    selectionToolbar.className = `${CSS_CLASSES.TOOLBAR} ${CSS_CLASSES.HIDDEN}`;
    selectionToolbar.setAttribute('role', 'toolbar');
    const text = getTranslationSync('quoteReply');
    selectionToolbar.setAttribute(
      'aria-label',
      `${text} / ${getTranslationSync('highlightAction')}`,
    );

    quoteBtn = document.createElement('button');
    quoteBtn.className = `${CSS_CLASSES.BUTTON} ${CSS_CLASSES.ACTION}`;
    quoteBtn.setAttribute('type', 'button');
    quoteBtn.innerHTML = `${QUOTE_ICON}<span>${text}</span>`;
    quoteBtn.classList.toggle(CSS_CLASSES.HIDDEN, !quoteEnabled);

    quoteBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isInternalClick = true;
    });
    quoteBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleQuoteClick();
    });

    highlightBtn = document.createElement('button');
    highlightBtn.className = `${CSS_CLASSES.HIGHLIGHT_BUTTON} ${CSS_CLASSES.ACTION} ${CSS_CLASSES.HIDDEN}`;
    highlightBtn.type = 'button';
    const highlightLabel = document.createElement('span');
    highlightLabel.textContent = getTranslationSync('highlightAction');
    highlightBtn.replaceChildren(createHighlighterIcon(16), highlightLabel);
    highlightBtn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      isInternalClick = true;
    });
    highlightBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void handleHighlightClick();
    });

    highlightColorBtn = document.createElement('button');
    highlightColorBtn.type = 'button';
    highlightColorBtn.className = `${CSS_CLASSES.HIGHLIGHT_COLOR_BUTTON} ${CSS_CLASSES.HIDDEN}`;
    highlightColorBtn.setAttribute('aria-expanded', 'false');
    highlightColorBtn.setAttribute('aria-controls', 'gv-highlight-color-palette');
    highlightColorBtn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      isInternalClick = true;
    });
    highlightColorBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = highlightColorPalette?.classList.contains(CSS_CLASSES.HIDDEN) === true;
      highlightColorPalette?.classList.toggle(CSS_CLASSES.HIDDEN, !willOpen);
      highlightColorBtn?.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) positionHighlightColorPalette();
    });

    highlightColorPalette = document.createElement('div');
    highlightColorPalette.id = 'gv-highlight-color-palette';
    highlightColorPalette.className = `${CSS_CLASSES.HIGHLIGHT_COLOR_PALETTE} ${CSS_CLASSES.HIDDEN}`;
    highlightColorPalette.setAttribute('role', 'group');
    highlightColorPalette.setAttribute('aria-label', getTranslationSync('highlightColor'));
    highlightColors.forEach((color, index) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gv-highlight-color-option';
      swatch.style.backgroundColor = getHighlightColorHex(color);
      swatch.dataset.highlightColor = color;
      swatch.dataset.highlightSlot = String(index);
      swatch.setAttribute('aria-label', getHighlightColorLabel(index));
      swatch.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        isInternalClick = true;
      });
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedHighlightSlot = index;
        selectedHighlightColor = highlightColors[index];
        updateHighlightColorUi();
        void browser.storage.sync
          .set({ [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: selectedHighlightColor })
          .catch(() => undefined);
        previewHighlightColor();
      });
      highlightColorPalette?.appendChild(swatch);
    });
    const editColorControl = document.createElement('label');
    editColorControl.className = 'gv-highlight-color-edit';
    editColorControl.innerHTML = EDIT_COLOR_ICON;
    editColorControl.title = getHighlightColorEditLabel();
    highlightCustomColorInput = document.createElement('input');
    highlightCustomColorInput.type = 'color';
    highlightCustomColorInput.className = 'gv-highlight-custom-color';
    highlightCustomColorInput.value = getHighlightColorHex(selectedHighlightColor);
    highlightCustomColorInput.setAttribute('aria-label', getHighlightColorEditLabel());
    highlightCustomColorInput.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      isInternalClick = true;
    });
    highlightCustomColorInput.addEventListener('input', () => {
      if (!highlightCustomColorInput) return;
      selectedHighlightColor = highlightCustomColorInput.value as HighlightColor;
      highlightColors[selectedHighlightSlot] = selectedHighlightColor;
      highlightManager?.setColorPalette(highlightColors);
      updateHighlightColorUi();
      previewHighlightColor();
    });
    highlightCustomColorInput.addEventListener('change', () => {
      if (!highlightCustomColorInput) return;
      selectedHighlightColor = highlightCustomColorInput.value as HighlightColor;
      highlightColors[selectedHighlightSlot] = selectedHighlightColor;
      highlightManager?.setColorPalette(highlightColors);
      updateHighlightColorUi();
      void browser.storage.sync
        .set({
          [StorageKeys.HIGHLIGHT_DEFAULT_COLOR]: selectedHighlightColor,
          [StorageKeys.HIGHLIGHT_COLOR_PALETTE]: [...highlightColors],
        })
        .catch(() => undefined);
      restoreCurrentSelection();
      previewHighlightColor();
      positionHighlightColorPalette();
    });
    editColorControl.appendChild(highlightCustomColorInput);
    highlightColorPalette.appendChild(editColorControl);
    updateHighlightColorUi();

    selectionToolbar.append(quoteBtn, highlightBtn, highlightColorBtn, highlightColorPalette);
    document.body.appendChild(selectionToolbar);
  }

  async function handleHighlightClick() {
    const manager = highlightManager;
    if (!currentSelectionRange || !manager) return;
    const range = currentSelectionRange.cloneRange();
    const saved = await manager.createFromRange(range, selectedHighlightColor);
    if (!saved) return;
    hideButton();
    currentSelectionRange = null;
    window.getSelection()?.removeAllRanges();
  }

  function handleQuoteClick() {
    if (!currentSelectionRange) return;
    const selectedText = extractTextWithLatex(currentSelectionRange).trim();
    if (!selectedText) return;

    const input = findChatInput();
    if (input) {
      expandInputCollapseIfNeeded();

      // Format: > selection
      // Prepare quote body (without leading/trailing newlines - those are added at insertion time)
      const quoteBody = selectedText
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');

      // Ensure the input is visible
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Insert the quote while minimizing selection/focus churn so IME
      // composition can start from the very next keystroke.
      const performInsertion = () => {
        focusChatInput(input);

        // Check input state at insertion time to avoid race conditions
        // (user might type or another quote might be inserted during the delay)
        const isInputEmpty = isChatInputEmpty(input);

        // 1. Add a newline at the end (any quote)
        // 2. Add a newline at the start if not the first quote
        // Example:
        // ------------
        // |> Quote 1 |
        // |New text 1|
        // |> Quote 2 |
        // |New text 2|
        // ------------
        const quoteWithTrailingNewline = `${quoteBody}\n`;

        if (input instanceof HTMLTextAreaElement) {
          // Standard Textarea logic - simplified append
          const prefix = isInputEmpty ? '' : '\n\n';
          input.value += `${prefix}${quoteWithTrailingNewline}`;
          input.selectionStart = input.selectionEnd = input.value.length;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Contenteditable (Gemini/Quill) logic
          const sel = window.getSelection();

          // For empty editors, insert from start.
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(input);
            if (isInputEmpty) {
              range.collapse(true);
            } else {
              range.collapse(false); // Move cursor to very end
            }
            sel.removeAllRanges();
            sel.addRange(range);
          }

          // Try to insert a separator via execCommand in one shot.
          // If the command succeeds and mutates content, only the quote body
          // (or missing part of it) remains to be inserted.
          // If insertion does not mutate content, fall back to prepending separator.
          const quoteSeparator = getContenteditableQuoteSeparator();
          const requiredSeparatorBreaks = countLineBreaks(quoteSeparator);
          let contentToInsert: string;
          let forceRangeInsertion = false;
          if (!isInputEmpty) {
            const separatorResult = tryInsertQuoteSeparator(input, quoteSeparator);
            if (separatorResult.inserted) {
              const missingBreaks = Math.max(
                0,
                requiredSeparatorBreaks - separatorResult.insertedBreaks,
              );
              contentToInsert =
                missingBreaks > 0
                  ? `${'\n'.repeat(missingBreaks)}${quoteWithTrailingNewline}`
                  : quoteWithTrailingNewline;
              // Avoid re-running execCommand after partial mutation to prevent duplicate separators.
              forceRangeInsertion = missingBreaks > 0;
            } else {
              contentToInsert = `${quoteSeparator}${quoteWithTrailingNewline}`;
            }
          } else {
            contentToInsert = quoteWithTrailingNewline;
          }

          // Quill handles text insertion better with native insertText command.
          // Fallback to manual Range insertion when command is unavailable.
          let inserted = false;
          if (!forceRangeInsertion) {
            try {
              inserted = document.execCommand('insertText', false, contentToInsert);
            } catch {
              inserted = false;
            }
          }

          if (!inserted) {
            const textNode = document.createTextNode(contentToInsert);
            if (sel) {
              if (forceRangeInsertion) {
                const endRange = document.createRange();
                endRange.selectNodeContents(input);
                endRange.collapse(false);
                sel.removeAllRanges();
                sel.addRange(endRange);
              }
            }

            if (sel && sel.rangeCount > 0) {
              const insertRange = sel.getRangeAt(0);
              insertRange.insertNode(textNode);

              // Move cursor to after the inserted text
              insertRange.setStartAfter(textNode);
              insertRange.setEndAfter(textNode);
              sel.removeAllRanges();
              sel.addRange(insertRange);
            } else {
              // Fallback: just append to the input
              input.appendChild(textNode);
            }
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      // Use a slightly longer delay to wait for any expansion transitions
      setTimeout(performInsertion, TIMING.INSERTION_DELAY_MS);

      // Hide button and clear selection state
      hideButton();
      currentSelectionRange = null;
      window.getSelection()?.removeAllRanges();
    } else {
      console.warn('[Gemini Voyager] Could not find chat input.');
    }
  }

  function showButton() {
    if (!selectionToolbar) createButton();
    if (!selectionToolbar) return;

    // updatePosition() manages visibility (HIDDEN class) based on viewport check
    updatePosition();

    // Add listeners for scroll/resize
    window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });
  }

  function hideButton() {
    closeHighlightColorPalette();
    clearHighlightColorPreview();
    if (selectionToolbar) {
      selectionToolbar.classList.add(CSS_CLASSES.HIDDEN);
    }
    // Remove listeners
    window.removeEventListener('scroll', onScrollOrResize, { capture: true });
    window.removeEventListener('resize', onScrollOrResize);
    if (scrollRafId) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
  }

  function handleSelectionChange() {
    // Debounce to let selection settle and avoid redundant updates on rapid key events
    if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        hideButton();
        currentSelectionRange = null;
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        hideButton();
        currentSelectionRange = null;
        return;
      }

      // Check if selection is within a message user/model bubble
      // We don't want to quote random UI elements
      const anchor = selection.anchorNode;
      if (!anchor) return;

      const element =
        anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement);

      // Check if selection is inside main content area
      // Gemini uses <main> or sometimes specific classes. We want to avoid nav, sidebar, etc.
      const mainContent = document.querySelector('main');
      if (mainContent && !mainContent.contains(element)) {
        hideButton();
        return;
      }

      // Also explicitly check for sidebar classes just in case
      if (
        element?.closest('nav') ||
        element?.closest('[role="navigation"]') ||
        element?.closest('.sidebar') ||
        element?.closest('.mat-drawer')
      ) {
        hideButton();
        return;
      }

      // Selectors for valid areas: user-query-container, model-response, conversation-container
      // Or just check if it's not the input box itself
      if (element?.closest('[contenteditable="true"]')) {
        hideButton();
        return;
      }

      // Only conversation turns are quoteable. Gemini also renders a greeting and
      // prompt suggestions inside <main> on the new-chat screen, but those are not
      // messages and must not expose Quote Reply.
      const range = selection.getRangeAt(0);
      const commonAncestor =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      if (
        !element?.closest(QUOTEABLE_MESSAGE_SELECTOR) ||
        !commonAncestor?.closest(QUOTEABLE_MESSAGE_SELECTOR)
      ) {
        hideButton();
        currentSelectionRange = null;
        return;
      }

      currentSelectionRange = range.cloneRange();
      const canHighlight =
        highlightEnabled && (highlightManager?.canCreateFromRange(range) ?? false);
      if (!selectionToolbar) createButton();
      quoteBtn?.classList.toggle(CSS_CLASSES.HIDDEN, !quoteEnabled);
      highlightBtn?.classList.toggle(CSS_CLASSES.HIDDEN, !canHighlight || !highlightEnabled);
      highlightColorBtn?.classList.toggle(CSS_CLASSES.HIDDEN, !canHighlight || !highlightEnabled);
      if (!quoteEnabled && (!canHighlight || !highlightEnabled)) {
        hideButton();
        currentSelectionRange = null;
        return;
      }
      const rect = range.getBoundingClientRect();

      // If rect is zero (e.g. invisible), don't show
      if (rect.width === 0 && rect.height === 0) return;

      showButton();
    }, TIMING.SELECTION_DEBOUNCE_MS);
  }

  function onMouseUp(event: MouseEvent) {
    if (isInternalClick) {
      isInternalClick = false;
      return;
    }
    if (
      highlightColorPalette &&
      !highlightColorPalette.classList.contains(CSS_CLASSES.HIDDEN) &&
      !highlightColorPalette.contains(event.target as Node) &&
      !highlightColorBtn?.contains(event.target as Node)
    ) {
      closeHighlightColorPalette();
    }
    handleSelectionChange();
  }

  // Function to update button text when language changes
  function updateButtonText() {
    if (quoteBtn) {
      const span = quoteBtn.querySelector('span');
      if (span) {
        span.textContent = getTranslationSync('quoteReply');
      }
    }
    const highlightSpan = highlightBtn?.querySelector('span');
    if (highlightSpan) {
      highlightSpan.textContent = getTranslationSync('highlightAction');
    }
    if (selectionToolbar) {
      selectionToolbar.setAttribute(
        'aria-label',
        `${getTranslationSync('quoteReply')} / ${getTranslationSync('highlightAction')}`,
      );
    }
    if (highlightColorPalette) {
      highlightColorPalette.setAttribute('aria-label', getTranslationSync('highlightColor'));
      highlightColorPalette
        .querySelectorAll<HTMLButtonElement>('.gv-highlight-color-option')
        .forEach((swatch) => {
          const slot = Number(swatch.dataset.highlightSlot);
          if (Number.isInteger(slot))
            swatch.setAttribute('aria-label', getHighlightColorLabel(slot));
        });
      const editColorControl = highlightColorPalette.querySelector<HTMLElement>(
        '.gv-highlight-color-edit',
      );
      if (editColorControl) {
        const label = getHighlightColorEditLabel();
        editColorControl.title = label;
        highlightCustomColorInput?.setAttribute('aria-label', label);
      }
    }
    updateHighlightColorUi();
  }

  // Listen to selection changes via mouseup (often better for "finished" selection)
  // selectionchange event fires too often while dragging.
  document.addEventListener('mouseup', onMouseUp);

  function onKeys(e: KeyboardEvent) {
    if (
      e.key === 'Escape' &&
      highlightColorPalette &&
      !highlightColorPalette.classList.contains(CSS_CLASSES.HIDDEN)
    ) {
      closeHighlightColorPalette();
      highlightColorBtn?.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'Shift' || e.key.startsWith('Arrow')) {
      handleSelectionChange();
    }
  }

  // Also listen to keyup for keyboard selection
  document.addEventListener('keyup', onKeys);

  // Listen for language changes and update button text
  function onStorageChanged(
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ) {
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      updateButtonText();
    }
    if (areaName === 'sync' && changes[StorageKeys.HIGHLIGHT_ENABLED]) {
      highlightEnabled = changes[StorageKeys.HIGHLIGHT_ENABLED].newValue === true;
      if (highlightEnabled) startHighlightManager();
      else stopHighlightManager();
      const canHighlight =
        currentSelectionRange !== null &&
        highlightEnabled &&
        (highlightManager?.canCreateFromRange(currentSelectionRange) ?? false);
      highlightBtn?.classList.toggle(CSS_CLASSES.HIDDEN, !highlightEnabled || !canHighlight);
      highlightColorBtn?.classList.toggle(CSS_CLASSES.HIDDEN, !highlightEnabled || !canHighlight);
      if (!highlightEnabled) {
        closeHighlightColorPalette();
        clearHighlightColorPreview();
      }
      if (!quoteEnabled && (!highlightEnabled || !canHighlight)) {
        hideButton();
      } else if (currentSelectionRange) {
        showButton();
      }
    }
    if (areaName === 'sync') {
      const paletteChange = changes[StorageKeys.HIGHLIGHT_COLOR_PALETTE];
      if (paletteChange) {
        highlightColors = normalizeHighlightColorPalette(
          paletteChange.newValue,
          selectedHighlightColor,
        );
        highlightManager?.setColorPalette(highlightColors);
        selectHighlightColor(selectedHighlightColor);
      }
      const nextColor = changes[StorageKeys.HIGHLIGHT_DEFAULT_COLOR]?.newValue;
      if (isHighlightColor(nextColor)) {
        selectHighlightColor(nextColor);
      }
      const timelineMarkersChange = changes[StorageKeys.HIGHLIGHT_TIMELINE_MARKERS_ENABLED];
      if (timelineMarkersChange) {
        highlightTimelineMarkersEnabled = timelineMarkersChange.newValue !== false;
        highlightManager?.setTimelineMarkersEnabled(highlightTimelineMarkersEnabled);
      }
    }
  }
  browser.storage.onChanged.addListener(onStorageChanged);

  // Cleanup
  return () => {
    hideButton();
    if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keyup', onKeys);
    browser.storage.onChanged.removeListener(onStorageChanged);
    stopHighlightManager();
    if (selectionToolbar) selectionToolbar.remove();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  };
}
