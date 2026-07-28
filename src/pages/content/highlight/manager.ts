import {
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import {
  DEFAULT_HIGHLIGHT_COLOR_PALETTE,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_LIMITS,
  type HighlightAccountScope,
  type HighlightColor,
  type HighlightCreateInput,
  type HighlightRecordV1,
  type HighlightUpdatePatch,
  areHighlightColorsEqual,
  getHighlightColorHex,
  isHighlightPresetColor,
  normalizeHighlightColorPalette,
} from '@/core/types/highlight';
import { buildConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { HIGHLIGHT_EXACT_MAX_BYTES, buildHighlightAnchor, resolveHighlightAnchor } from './anchor';
import { HighlightClient, highlightClient } from './client';
import {
  collectHighlightTurns,
  findHighlightTurn,
  findScrollableAncestor,
  getHighlightSelectionContext,
  resolveMountedHighlightTurnId,
  resolveStoredHighlightTurnId,
} from './dom';

const STYLE_ID = 'gv-highlight-style';
const HIGHLIGHT_HASH_PREFIX = '#gv-highlight-';
const NOTE_MAX_CHARS = 8 * 1024;
const RENDER_DEBOUNCE_MS = 120;
type NavigationResult = 'highlight' | 'turn' | 'missing';

function translate(key: TranslationKey, fallback: string): string {
  const translated = getTranslationSync(key);
  return translated === key ? fallback : translated;
}

function translateWith(
  key: TranslationKey,
  fallback: string,
  replacements: Record<string, string>,
): string {
  let output = translate(key, fallback);
  Object.entries(replacements).forEach(([name, value]) => {
    output = output.replaceAll(`{${name}}`, value);
  });
  return output;
}

function getSaveFailureMessage(error: unknown): string {
  const fallback = translate('highlightSaveFailed', 'Could not save the highlight.');
  if (!(error instanceof Error)) return fallback;
  const detail = error.message.trim();
  if (!detail || detail === 'Highlight operation failed') return fallback;
  return `${fallback} ${detail}`;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .gv-highlight-mark {
      border-radius: 2px;
      color: inherit;
      cursor: pointer;
      margin: 0;
      padding: 0;
      text-decoration: none;
    }
    .gv-highlight-mark:focus-visible,
    .gv-highlight-mark.gv-highlight-active {
      outline: 2px solid #0b57d0;
      outline-offset: 2px;
    }
    .gv-highlight-mark-yellow { background: rgba(250, 204, 21, 0.38); }
    .gv-highlight-mark-green { background: rgba(74, 222, 128, 0.30); }
    .gv-highlight-mark-blue { background: rgba(96, 165, 250, 0.28); }
    .gv-highlight-mark-pink { background: rgba(244, 114, 182, 0.28); }

    .gv-highlight-popover {
      position: fixed;
      z-index: 10002;
      box-sizing: border-box;
      width: min(340px, calc(100vw - 24px));
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      background: #202124;
      color: #f1f3f4;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .gv-highlight-popover-quote {
      max-height: 72px;
      margin-bottom: 10px;
      overflow: auto;
      color: #bdc1c6;
      font-size: 12px;
      white-space: pre-wrap;
    }
    .gv-highlight-note {
      box-sizing: border-box;
      width: 100%;
      min-height: 76px;
      resize: vertical;
      padding: 8px 10px;
      border: 1px solid #5f6368;
      border-radius: 8px;
      background: #292a2d;
      color: inherit;
      font: inherit;
    }
    .gv-highlight-note:focus {
      border-color: #8ab4f8;
      outline: 2px solid rgba(138, 180, 248, 0.22);
    }
    .gv-highlight-color-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }
    .gv-highlight-color-label { margin-inline-end: 2px; color: #bdc1c6; }
    .gv-highlight-swatch {
      position: relative;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 2px solid transparent;
      border-radius: 50%;
      cursor: pointer;
    }
    .gv-highlight-swatch[aria-pressed="true"] {
      border-color: rgba(255, 255, 255, 0.94);
      outline: 2px solid #8ab4f8;
      outline-offset: 1px;
      box-shadow: 0 2px 8px rgba(138, 180, 248, 0.34);
    }
    .gv-highlight-swatch[aria-pressed="true"]::after {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #fff;
      content: "✓";
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.78);
    }
    .gv-highlight-popover-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .gv-highlight-popover-button {
      min-height: 32px;
      padding: 5px 11px;
      border: 1px solid #5f6368;
      border-radius: 16px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    .gv-highlight-popover-button:hover { background: rgba(255, 255, 255, 0.08); }
    .gv-highlight-popover-button:disabled { cursor: default; opacity: 0.55; }
    .gv-highlight-popover-button-primary {
      border-color: #8ab4f8;
      background: #8ab4f8;
      color: #202124;
    }
    .gv-highlight-popover-button-danger { color: #f28b82; }
    .gv-highlight-live {
      position: fixed;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .gv-highlight-timeline-tick {
      position: absolute;
      z-index: 4;
      inset-inline-end: 1px;
      width: 5px;
      height: 11px;
      margin: -5px 0 0;
      padding: 0;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      transform: none;
    }
    .gv-highlight-timeline-tick:focus-visible { outline: 2px solid #0b57d0; outline-offset: 2px; }
    .gv-highlight-timeline-tick-yellow { background: #e8b400; }
    .gv-highlight-timeline-tick-green { background: #24a148; }
    .gv-highlight-timeline-tick-blue { background: #1a73e8; }
    .gv-highlight-timeline-tick-pink { background: #d9468f; }

    .theme-host.light-theme .gv-highlight-popover,
    body[data-theme="light"] .gv-highlight-popover {
      border-color: rgba(60, 64, 67, 0.18);
      background: #fff;
      color: #202124;
      box-shadow: 0 8px 28px rgba(60, 64, 67, 0.22);
    }
    .theme-host.light-theme .gv-highlight-popover-quote,
    .theme-host.light-theme .gv-highlight-color-label,
    body[data-theme="light"] .gv-highlight-popover-quote,
    body[data-theme="light"] .gv-highlight-color-label { color: #5f6368; }
    .theme-host.light-theme .gv-highlight-note,
    body[data-theme="light"] .gv-highlight-note {
      border-color: #dadce0;
      background: #f8f9fa;
      color: #202124;
    }
    .theme-host.light-theme .gv-highlight-popover-button:hover,
    body[data-theme="light"] .gv-highlight-popover-button:hover { background: #f1f3f4; }
    .theme-host.light-theme .gv-highlight-popover-button-primary,
    body[data-theme="light"] .gv-highlight-popover-button-primary {
      border-color: #0b57d0;
      background: #0b57d0;
      color: #fff;
    }
    body.gv-rtl .gv-highlight-color-row,
    body.gv-rtl .gv-highlight-popover-actions { flex-direction: row-reverse; }
    @media (prefers-color-scheme: light) {
      .gv-highlight-popover {
        border-color: rgba(60, 64, 67, 0.18);
        background: #fff;
        color: #202124;
      }
      .gv-highlight-popover-quote,
      .gv-highlight-color-label { color: #5f6368; }
      .gv-highlight-note { border-color: #dadce0; background: #f8f9fa; color: #202124; }
      .gv-highlight-popover-button:hover { background: #f1f3f4; }
      .gv-highlight-popover-button-primary {
        border-color: #0b57d0;
        background: #0b57d0;
        color: #fff;
      }
    }
    .theme-host.dark-theme .gv-highlight-popover,
    body[data-theme="dark"] .gv-highlight-popover {
      border-color: rgba(255, 255, 255, 0.14);
      background: #202124;
      color: #f1f3f4;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
    }
    .theme-host.dark-theme .gv-highlight-popover-quote,
    .theme-host.dark-theme .gv-highlight-color-label,
    body[data-theme="dark"] .gv-highlight-popover-quote,
    body[data-theme="dark"] .gv-highlight-color-label { color: #bdc1c6; }
    .theme-host.dark-theme .gv-highlight-note,
    body[data-theme="dark"] .gv-highlight-note {
      border-color: #5f6368;
      background: #292a2d;
      color: #f1f3f4;
    }
    .theme-host.dark-theme .gv-highlight-popover-button:hover,
    body[data-theme="dark"] .gv-highlight-popover-button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .theme-host.dark-theme .gv-highlight-popover-button-primary,
    body[data-theme="dark"] .gv-highlight-popover-button-primary {
      border-color: #8ab4f8;
      background: #8ab4f8;
      color: #202124;
    }
    @media (forced-colors: active) {
      .gv-highlight-mark { background: transparent; outline: 1px solid Highlight; }
      .gv-highlight-timeline-tick { background: Highlight; }
    }
  `;
  document.head.appendChild(style);
}

function unwrapMark(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  mark.replaceWith(...Array.from(mark.childNodes));
  parent.normalize();
}

function highlightColorBackground(color: HighlightColor, alpha = 0.3): string {
  const hex = getHighlightColorHex(color);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function applyMarkColor(element: HTMLElement, color: HighlightColor): void {
  HIGHLIGHT_COLORS.forEach((candidate) =>
    element.classList.remove(`gv-highlight-mark-${candidate}`),
  );
  element.style.removeProperty('background-color');
  if (isHighlightPresetColor(color)) {
    element.classList.add(`gv-highlight-mark-${color}`);
  } else {
    element.style.backgroundColor = highlightColorBackground(color);
  }
}

function isVisibleHighlightMark(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  let current: HTMLElement | null = element;
  while (current) {
    if (
      current.hidden ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden'
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function getRangeTextNodes(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) return [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      try {
        if (range.intersectsNode(current)) nodes.push(current);
      } catch {}
    }
    current = walker.nextNode();
  }
  return nodes;
}

export function wrapHighlightRange(
  range: Range,
  id: string,
  color: HighlightColor,
  ariaLabel: string,
): HTMLElement[] {
  const textNodes = getRangeTextNodes(range);
  const marks: HTMLElement[] = [];

  for (const node of [...textNodes].reverse()) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    if (end <= start) continue;

    let selected = node;
    if (end < selected.data.length) selected.splitText(end);
    if (start > 0) selected = selected.splitText(start);

    const mark = document.createElement('mark');
    mark.className = 'gv-highlight-mark';
    applyMarkColor(mark, color);
    mark.dataset.gvHighlightId = id;
    mark.setAttribute('role', 'button');
    mark.setAttribute('aria-label', ariaLabel);
    mark.tabIndex = -1;
    selected.replaceWith(mark);
    mark.appendChild(selected);
    marks.unshift(mark);
  }

  if (marks[0]) marks[0].tabIndex = 0;
  return marks;
}

function setRecordColor(elements: HTMLElement[], color: HighlightColor): void {
  elements.forEach((element) => applyMarkColor(element, color));
}

export class HighlightManager {
  private readonly records = new Map<string, HighlightRecordV1>();
  private readonly marks = new Map<string, HTMLElement[]>();
  private readonly ticks = new Map<string, HTMLButtonElement>();
  private destroyed = false;
  private observer: MutationObserver | null = null;
  private timelineStyleObserver: MutationObserver | null = null;
  private observedTimelineBar: HTMLElement | null = null;
  private renderTimer: number | null = null;
  private reloadTimer: number | null = null;
  private timelineRaf: number | null = null;
  private currentRoute = '';
  private currentConversationId = '';
  private accountScope: HighlightAccountScope | null = null;
  private scopeGeneration = 0;
  private loadGeneration = 0;
  private popover: HTMLElement | null = null;
  private popoverReturnFocus: HTMLElement | null = null;
  private liveRegion: HTMLElement | null = null;
  private activeTimer: number | null = null;
  private announceTimer: number | null = null;
  private popoverFocusTimer: number | null = null;
  private hashRetryTimer: number | null = null;
  private pendingHashId: string | null = null;
  private pendingHashDeadline = 0;
  private pendingTurnFallbackDone = false;
  private timelineMarkersEnabled = true;
  private colorPalette = [...DEFAULT_HIGHLIGHT_COLOR_PALETTE];
  private readonly onDocumentClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const mark = target?.closest<HTMLElement>('.gv-highlight-mark[data-gv-highlight-id]');
    if (mark) {
      event.preventDefault();
      event.stopPropagation();
      const id = mark.dataset.gvHighlightId;
      if (id) this.openPopover(id, mark);
      return;
    }
    if (this.popover && target && !this.popover.contains(target)) this.closePopover();
  };
  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.popover) {
      event.preventDefault();
      this.closePopover(true);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    const mark = target?.closest<HTMLElement>('.gv-highlight-mark[data-gv-highlight-id]');
    if (!mark) return;
    event.preventDefault();
    const id = mark.dataset.gvHighlightId;
    if (id) this.openPopover(id, mark);
  };
  private readonly onHashChange = (): void => {
    this.handleHashNavigation();
  };
  private readonly onRouteEvent = (): void => {
    this.checkRoute();
  };
  private readonly onViewportChange = (event: Event): void => {
    this.scheduleTimelineSync();
    const target = event.target instanceof Node ? event.target : null;
    if (this.popover && (!target || !this.popover.contains(target))) this.closePopover();
  };
  private readonly onRuntimeMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object') return;
    const typed = message as { type?: unknown; payload?: { conversationId?: unknown } };
    if (typed.type !== 'gv.highlight.changed') return;
    const changedConversationId = typed.payload?.conversationId;
    if (
      typeof changedConversationId === 'string' &&
      changedConversationId !== this.currentConversationId
    ) {
      return;
    }
    this.scheduleReload();
  };

  constructor(private readonly client: HighlightClient = highlightClient) {}

  setColorPalette(colors: readonly HighlightColor[]): void {
    this.colorPalette = normalizeHighlightColorPalette(colors);
  }

  setTimelineMarkersEnabled(enabled: boolean): void {
    this.timelineMarkersEnabled = enabled;
    if (enabled) {
      this.syncTimelineTicks();
      return;
    }
    this.ticks.forEach((tick) => tick.remove());
    this.ticks.clear();
  }

  async init(): Promise<void> {
    if (this.destroyed) return;
    injectStyles();
    this.ensureLiveRegion();
    if (!(await this.refreshScopeForCurrentRoute()) || this.destroyed) return;

    document.addEventListener('click', this.onDocumentClick, true);
    document.addEventListener('keydown', this.onDocumentKeydown, true);
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('popstate', this.onRouteEvent);
    window.addEventListener('resize', this.onViewportChange, { passive: true });
    document.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);

    this.observer = new MutationObserver(() => this.scheduleRender());
    this.observeDocument();
    await this.reload();
  }

  canCreateFromRange(range: Range): boolean {
    const context = getHighlightSelectionContext(range);
    return Boolean(context && !range.collapsed && range.toString().trim());
  }

  async createFromRange(range: Range, color: HighlightColor = 'yellow'): Promise<boolean> {
    const context = getHighlightSelectionContext(range);
    if (!context) return false;
    const anchor = buildHighlightAnchor(context.assistantRoot, range);
    if (!anchor) {
      if (new TextEncoder().encode(range.toString()).byteLength > HIGHLIGHT_EXACT_MAX_BYTES) {
        this.announce(translate('highlightTooLong', 'The selected text is too long to highlight.'));
      } else {
        this.announce(translate('highlightSaveFailed', 'Could not save the highlight.'));
      }
      return false;
    }

    const input: HighlightCreateInput = {
      conversationId: context.conversationId,
      conversationUrl: context.conversationUrl,
      conversationTitle: context.conversationTitle,
      turnId: context.turnId,
      role: 'assistant',
      anchor,
      color,
    };

    try {
      const selectedUrl = new URL(context.conversationUrl);
      const selectedRoute = selectedUrl.pathname + selectedUrl.search;
      if (selectedRoute !== this.getRouteKey() || !(await this.refreshAccountScopeForMutation())) {
        throw new Error('The conversation changed before the highlight could be saved');
      }
      const scope = this.accountScope;
      if (!scope) throw new Error('Highlight account scope is unavailable');
      const record = await this.client.create(scope, input);
      if (this.destroyed) return false;
      this.records.set(record.id, record);
      this.renderAll();
      this.announce(translate('highlightSaved', 'Highlight saved.'));
      return true;
    } catch (error) {
      this.announce(getSaveFailureMessage(error));
      return false;
    }
  }

  navigateToHighlight(
    id: string,
    behavior: ScrollBehavior = 'smooth',
    allowTurnFallback = true,
  ): NavigationResult {
    const mark = this.marks.get(id)?.find(isVisibleHighlightMark);
    if (mark) {
      mark.scrollIntoView?.({ behavior, block: 'center', inline: 'nearest' });
      try {
        mark.focus({ preventScroll: true });
      } catch {
        mark.focus();
      }
      document.querySelectorAll('.gv-highlight-active').forEach((element) => {
        element.classList.remove('gv-highlight-active');
      });
      mark.classList.add('gv-highlight-active');
      if (this.activeTimer !== null) window.clearTimeout(this.activeTimer);
      this.activeTimer = window.setTimeout(() => {
        mark.classList.remove('gv-highlight-active');
        this.activeTimer = null;
      }, 1600);
      return 'highlight';
    }

    if (!allowTurnFallback) return 'missing';
    const record = this.records.get(id);
    const turn = record ? findHighlightTurn(record.turnId) : null;
    if (turn) {
      turn.userElement.scrollIntoView?.({ behavior, block: 'center', inline: 'nearest' });
      return 'turn';
    }
    return 'missing';
  }

  private getRouteKey(): string {
    return `${location.pathname}${location.search}`;
  }

  private checkRoute(): void {
    if (this.destroyed) return;
    const nextRoute = this.getRouteKey();
    if (nextRoute === this.currentRoute) return;
    this.currentRoute = nextRoute;
    this.currentConversationId = buildConversationIdFromUrl(location.href);
    this.accountScope = null;
    this.closePopover();
    this.clearRenderedMarks();
    this.records.clear();
    void this.refreshScopeAndReload();
  }

  private async resolveAccountScope(): Promise<HighlightAccountScope | null> {
    try {
      const context = detectAccountContextFromDocument(location.href, document);
      const resolved = await accountIsolationService.resolveAccountScope({
        pageUrl: location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });
      return {
        platform: 'gemini',
        accountKey: resolved.accountKey,
        accountId: resolved.accountId,
        routeUserId: resolved.routeUserId,
      };
    } catch {
      return null;
    }
  }

  private async refreshScopeAndReload(): Promise<void> {
    if ((await this.refreshScopeForCurrentRoute()) && !this.destroyed) await this.reload();
  }

  private async refreshScopeForCurrentRoute(): Promise<boolean> {
    while (!this.destroyed) {
      const generation = ++this.scopeGeneration;
      const route = this.getRouteKey();
      const scope = await this.resolveAccountScope();
      if (this.destroyed || generation !== this.scopeGeneration) return false;
      if (route !== this.getRouteKey()) continue;
      this.currentRoute = route;
      this.currentConversationId = buildConversationIdFromUrl(location.href);
      this.accountScope = scope;
      return scope !== null;
    }
    return false;
  }

  private async refreshAccountScopeForMutation(): Promise<boolean> {
    const previous = this.accountScope;
    if (!(await this.refreshScopeForCurrentRoute())) return false;
    const next = this.accountScope;
    if (
      previous &&
      next &&
      (previous.accountKey !== next.accountKey || previous.platform !== next.platform)
    ) {
      // Listing the newly resolved account also performs the one-time migration
      // from a legacy `default` bucket before an edit/create continues.
      await this.reload();
    }
    return true;
  }

  private async reload(): Promise<void> {
    const generation = ++this.loadGeneration;
    const conversationId = this.currentConversationId;
    const scope = this.accountScope;
    if (!conversationId || !scope) return;
    try {
      const records = await this.client.list(scope, conversationId);
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.clearRenderedMarks();
      this.records.clear();
      records
        .filter((record) => !record.deletedAt)
        .forEach((record) => this.records.set(record.id, record));
      this.renderAll();
      this.handleHashNavigation();
    } catch {
      // A disabled/reloaded extension should leave Gemini untouched.
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, RENDER_DEBOUNCE_MS);
  }

  private scheduleRender(): void {
    if (this.destroyed || this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.getRouteKey() !== this.currentRoute) {
        this.checkRoute();
        return;
      }
      this.renderAll();
    }, RENDER_DEBOUNCE_MS);
  }

  private observeDocument(): void {
    if (!this.observer || this.destroyed || !document.body) return;
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  private renderAll(): void {
    if (this.destroyed) return;
    this.observer?.disconnect();
    try {
      const turns = new Map(
        collectHighlightTurns().flatMap((turn) => {
          const resolved = resolveMountedHighlightTurnId(turn.turnId);
          return resolved ? [[resolved, turn] as const] : [];
        }),
      );
      for (const [id, record] of this.records) {
        const existing = (this.marks.get(id) ?? []).filter((mark) => mark.isConnected);
        const existingText = existing.map((mark) => mark.textContent ?? '').join('');
        if (existing.length > 0 && existingText === record.anchor.quote.exact) {
          this.marks.set(id, existing);
          setRecordColor(existing, record.color);
          continue;
        }

        existing.reverse().forEach(unwrapMark);

        this.marks.delete(id);
        const normalizedTurnId = resolveStoredHighlightTurnId(record.turnId);
        if (!normalizedTurnId) continue;
        const turn = turns.get(normalizedTurnId);
        if (!turn) continue;
        const range = resolveHighlightAnchor(turn.assistantRoot, record.anchor);
        if (!range) continue;
        const label = translateWith('highlightAriaLabel', 'Highlight: {text}', {
          text: record.anchor.quote.exact.slice(0, 120),
        });
        const rendered = wrapHighlightRange(range, id, record.color, label);
        if (rendered.length > 0) this.marks.set(id, rendered);
      }

      for (const [id, elements] of this.marks) {
        if (this.records.has(id)) continue;
        elements.forEach(unwrapMark);
        this.marks.delete(id);
      }
      this.syncTimelineTicks();
      if (this.pendingHashId) this.attemptPendingHashNavigation();
    } finally {
      this.observeDocument();
    }
  }

  private clearRenderedMarks(): void {
    this.observer?.disconnect();
    try {
      Array.from(this.marks.values())
        .flat()
        .filter((mark) => mark.isConnected)
        .reverse()
        .forEach(unwrapMark);
      this.marks.clear();
      this.ticks.forEach((tick) => tick.remove());
      this.ticks.clear();
    } finally {
      this.observeDocument();
    }
  }

  private syncTimelineTicks(): void {
    if (!this.timelineMarkersEnabled) {
      this.ticks.forEach((tick) => tick.remove());
      this.ticks.clear();
      return;
    }
    const bar = document.querySelector<HTMLElement>('.gemini-timeline-bar');
    const trackContent = bar?.querySelector<HTMLElement>('.timeline-track-content');
    if (!bar || !trackContent) {
      this.timelineStyleObserver?.disconnect();
      this.observedTimelineBar = null;
      this.ticks.forEach((tick) => tick.remove());
      this.ticks.clear();
      return;
    }
    this.observeTimelineStyle(bar);
    const compact = bar.classList.contains('timeline-style-compact');
    const parent = compact ? bar : trackContent;

    for (const [id, record] of this.records) {
      const mark = this.marks.get(id)?.find(isVisibleHighlightMark);
      if (!mark) {
        this.ticks.get(id)?.remove();
        this.ticks.delete(id);
        continue;
      }

      let tick = this.ticks.get(id);
      if (!tick || !tick.isConnected || tick.parentElement !== parent) {
        tick?.remove();
        tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'gv-highlight-timeline-tick';
        tick.dataset.gvHighlightId = id;
        tick.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.navigateToHighlight(id);
        });
        parent.appendChild(tick);
        this.ticks.set(id, tick);
      }
      HIGHLIGHT_COLORS.forEach((color) =>
        tick!.classList.remove(`gv-highlight-timeline-tick-${color}`),
      );
      tick.style.removeProperty('background-color');
      if (isHighlightPresetColor(record.color)) {
        tick.classList.add(`gv-highlight-timeline-tick-${record.color}`);
      } else {
        tick.style.backgroundColor = getHighlightColorHex(record.color);
      }
      tick.setAttribute(
        'aria-label',
        translateWith('highlightTimelineAriaLabel', 'Go to highlight: {text}', {
          text: record.anchor.quote.exact.slice(0, 120),
        }),
      );
      tick.title = record.anchor.quote.exact.replace(/\s+/g, ' ').trim().slice(0, 160);
      this.positionTimelineTick(tick, mark, parent, compact);
    }

    for (const [id, tick] of this.ticks) {
      if (this.records.has(id) && this.marks.has(id)) continue;
      tick.remove();
      this.ticks.delete(id);
    }
  }

  private observeTimelineStyle(bar: HTMLElement): void {
    if (this.observedTimelineBar === bar) return;
    this.timelineStyleObserver?.disconnect();
    this.observedTimelineBar = bar;
    this.timelineStyleObserver = new MutationObserver(() => this.syncTimelineTicks());
    this.timelineStyleObserver.observe(bar, { attributes: true, attributeFilter: ['class'] });
  }

  private positionTimelineTick(
    tick: HTMLButtonElement,
    mark: HTMLElement,
    parent: HTMLElement,
    compact: boolean,
  ): void {
    const scrollContainer = findScrollableAncestor(mark);
    const containerRect = scrollContainer.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const absoluteTop = scrollContainer.scrollTop + markRect.top - containerRect.top;
    const scrollHeight = Math.max(1, scrollContainer.scrollHeight);
    const ratio = Math.max(0, Math.min(1, absoluteTop / scrollHeight));
    const targetHeight = compact
      ? Math.max(1, parent.clientHeight)
      : Math.max(1, parent.scrollHeight || parent.clientHeight);
    tick.style.top = `${Math.round(ratio * targetHeight)}px`;
  }

  private scheduleTimelineSync(): void {
    if (this.timelineRaf !== null || this.destroyed) return;
    this.timelineRaf = requestAnimationFrame(() => {
      this.timelineRaf = null;
      this.syncTimelineTicks();
    });
  }

  private openPopover(id: string, anchorElement: HTMLElement): void {
    const record = this.records.get(id);
    if (!record) return;
    this.closePopover();

    const popover = document.createElement('section');
    popover.className = 'gv-highlight-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute(
      'aria-label',
      translate('highlightAriaLabel', 'Saved highlight annotation'),
    );
    popover.setAttribute('dir', 'auto');

    const quote = document.createElement('div');
    quote.className = 'gv-highlight-popover-quote';
    quote.textContent = record.anchor.quote.exact;

    const note = document.createElement('textarea');
    note.className = 'gv-highlight-note';
    note.maxLength = NOTE_MAX_CHARS;
    note.placeholder = translate('highlightNotePlaceholder', 'Add a note');
    note.value = record.note ?? '';
    note.setAttribute('aria-label', note.placeholder);

    const colorRow = document.createElement('div');
    colorRow.className = 'gv-highlight-color-row';
    colorRow.setAttribute('role', 'group');
    const colorLabel = document.createElement('span');
    colorLabel.className = 'gv-highlight-color-label';
    colorLabel.textContent = translate('highlightColor', 'Color');
    colorRow.setAttribute('aria-label', colorLabel.textContent);
    colorRow.appendChild(colorLabel);

    let selectedColor: HighlightColor = record.color;
    const updateColorSelection = (): void => {
      swatches.forEach((item, itemIndex) => {
        item.setAttribute(
          'aria-pressed',
          String(areHighlightColorsEqual(this.colorPalette[itemIndex], selectedColor)),
        );
      });
    };
    const swatches = this.colorPalette.map((color, index) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gv-highlight-swatch';
      swatch.style.backgroundColor = getHighlightColorHex(color);
      swatch.setAttribute('aria-label', `${colorLabel.textContent} ${index + 1}`);
      swatch.setAttribute('aria-pressed', String(areHighlightColorsEqual(color, selectedColor)));
      swatch.addEventListener('click', () => {
        selectedColor = color;
        updateColorSelection();
      });
      colorRow.appendChild(swatch);
      return swatch;
    });

    const actions = document.createElement('div');
    actions.className = 'gv-highlight-popover-actions';
    const deleteButton = this.createPopoverButton(
      translate('pm_delete', 'Delete'),
      'gv-highlight-popover-button-danger',
    );
    const cancelButton = this.createPopoverButton(translate('pm_cancel', 'Cancel'));
    const saveButton = this.createPopoverButton(
      translate('pm_save', 'Save'),
      'gv-highlight-popover-button-primary',
    );
    actions.append(deleteButton, cancelButton, saveButton);
    popover.append(quote, note, colorRow, actions);
    document.body.appendChild(popover);
    this.popover = popover;
    this.popoverReturnFocus = anchorElement;

    const setBusy = (busy: boolean): void => {
      deleteButton.disabled = busy;
      cancelButton.disabled = busy;
      saveButton.disabled = busy;
      note.disabled = busy;
      swatches.forEach((swatch) => {
        swatch.disabled = busy;
      });
    };
    cancelButton.addEventListener('click', () => this.closePopover(true));
    saveButton.addEventListener('click', async () => {
      const noteBytes = new TextEncoder().encode(note.value).byteLength;
      if (noteBytes > HIGHLIGHT_LIMITS.noteBytes) {
        const message = `${translate('highlightSaveFailed', 'Could not save the highlight.')} (${noteBytes} / ${HIGHLIGHT_LIMITS.noteBytes})`;
        note.setCustomValidity(message);
        note.reportValidity();
        this.announce(message);
        return;
      }
      note.setCustomValidity('');
      setBusy(true);
      const patch: HighlightUpdatePatch = { note: note.value, color: selectedColor };
      try {
        if (!(await this.refreshAccountScopeForMutation())) {
          throw new Error('Highlight account scope is unavailable');
        }
        const scope = this.accountScope;
        if (!scope) throw new Error('Highlight account scope is unavailable');
        const updated = await this.client.update(scope, record.conversationId, record.id, patch);
        if (this.destroyed) return;
        this.records.set(updated.id, updated);
        setRecordColor(this.marks.get(updated.id) ?? [], updated.color);
        this.syncTimelineTicks();
        this.closePopover(true);
        this.announce(translate('highlightSaved', 'Highlight saved.'));
      } catch (error) {
        setBusy(false);
        this.announce(getSaveFailureMessage(error));
      }
    });
    note.addEventListener('input', () => note.setCustomValidity(''));
    deleteButton.addEventListener('click', async () => {
      setBusy(true);
      try {
        if (!(await this.refreshAccountScopeForMutation())) {
          throw new Error('Highlight account scope is unavailable');
        }
        const scope = this.accountScope;
        if (!scope) throw new Error('Highlight account scope is unavailable');
        await this.client.delete(scope, record.conversationId, record.id);
        if (this.destroyed) return;
        this.records.delete(record.id);
        (this.marks.get(record.id) ?? []).reverse().forEach(unwrapMark);
        this.marks.delete(record.id);
        this.ticks.get(record.id)?.remove();
        this.ticks.delete(record.id);
        this.closePopover();
      } catch (error) {
        setBusy(false);
        this.announce(getSaveFailureMessage(error));
      }
    });

    this.positionPopover(popover, anchorElement);
    this.popoverFocusTimer = window.setTimeout(() => {
      this.popoverFocusTimer = null;
      if (note.isConnected) note.focus({ preventScroll: true });
    }, 0);
  }

  private createPopoverButton(label: string, extraClass = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gv-highlight-popover-button ${extraClass}`.trim();
    button.textContent = label;
    return button;
  }

  private positionPopover(popover: HTMLElement, anchorElement: HTMLElement): void {
    const anchorRect = anchorElement.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const edge = 12;
    const gap = 8;
    const desiredTop = anchorRect.bottom + gap;
    const fallbackTop = anchorRect.top - popoverRect.height - gap;
    const top =
      desiredTop + popoverRect.height <= window.innerHeight - edge ? desiredTop : fallbackTop;
    const left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
    popover.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - popoverRect.height - edge))}px`;
    popover.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - popoverRect.width - edge))}px`;
  }

  private closePopover(restoreFocus = false): void {
    const returnFocus = this.popoverReturnFocus;
    if (this.popoverFocusTimer !== null) {
      window.clearTimeout(this.popoverFocusTimer);
      this.popoverFocusTimer = null;
    }
    this.popover?.remove();
    this.popover = null;
    this.popoverReturnFocus = null;
    if (!restoreFocus || !returnFocus?.isConnected) return;
    try {
      returnFocus.focus({ preventScroll: true });
    } catch {
      returnFocus.focus();
    }
  }

  private ensureLiveRegion(): void {
    if (this.liveRegion?.isConnected) return;
    const live = document.createElement('div');
    live.className = 'gv-highlight-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    this.liveRegion = live;
  }

  private announce(message: string): void {
    this.ensureLiveRegion();
    if (!this.liveRegion) return;
    this.liveRegion.textContent = '';
    if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => {
      this.announceTimer = null;
      if (this.liveRegion) this.liveRegion.textContent = message;
    }, 0);
  }

  private handleHashNavigation(): void {
    if (!location.hash.startsWith(HIGHLIGHT_HASH_PREFIX)) {
      if (this.hashRetryTimer !== null) window.clearTimeout(this.hashRetryTimer);
      this.hashRetryTimer = null;
      this.pendingHashId = null;
      this.pendingHashDeadline = 0;
      this.pendingTurnFallbackDone = false;
      return;
    }
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(HIGHLIGHT_HASH_PREFIX.length));
    } catch {
      return;
    }
    if (!id) return;
    if (this.pendingHashId !== id) {
      this.pendingHashId = id;
      this.pendingHashDeadline = Date.now() + 5000;
      this.pendingTurnFallbackDone = false;
    }
    this.attemptPendingHashNavigation();
  }

  private attemptPendingHashNavigation(): void {
    const id = this.pendingHashId;
    if (!id || this.destroyed) return;
    if (this.hashRetryTimer !== null) {
      window.clearTimeout(this.hashRetryTimer);
      this.hashRetryTimer = null;
    }
    const result = this.navigateToHighlight(id, 'smooth', !this.pendingTurnFallbackDone);
    if (result === 'highlight') {
      this.pendingHashId = null;
      this.pendingHashDeadline = 0;
      this.pendingTurnFallbackDone = false;
      return;
    }
    if (result === 'turn') this.pendingTurnFallbackDone = true;
    if (Date.now() >= this.pendingHashDeadline) {
      this.pendingHashId = null;
      this.pendingHashDeadline = 0;
      this.pendingTurnFallbackDone = false;
      return;
    }
    // The turn can exist before Gemini mounts its response. Keep a bounded
    // precise-navigation retry even after the one-time turn fallback.
    this.hashRetryTimer = window.setTimeout(() => {
      this.hashRetryTimer = null;
      this.attemptPendingHashNavigation();
    }, 300);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration++;
    this.scopeGeneration++;
    this.observer?.disconnect();
    this.observer = null;
    this.timelineStyleObserver?.disconnect();
    this.timelineStyleObserver = null;
    this.observedTimelineBar = null;
    document.removeEventListener('click', this.onDocumentClick, true);
    document.removeEventListener('keydown', this.onDocumentKeydown, true);
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('popstate', this.onRouteEvent);
    window.removeEventListener('resize', this.onViewportChange);
    document.removeEventListener('scroll', this.onViewportChange, true);
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    if (this.timelineRaf !== null) cancelAnimationFrame(this.timelineRaf);
    if (this.activeTimer !== null) window.clearTimeout(this.activeTimer);
    if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
    if (this.hashRetryTimer !== null) window.clearTimeout(this.hashRetryTimer);
    this.pendingHashId = null;
    this.closePopover();
    this.clearRenderedMarks();
    this.liveRegion?.remove();
    this.liveRegion = null;
    document.getElementById(STYLE_ID)?.remove();
  }
}
