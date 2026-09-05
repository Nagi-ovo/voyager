import { hashString } from '@/core/utils/hash';

import { makeStableTurnId, readServerTurnId } from '../fork/turnId';
import type { TimelineMarker } from './types';
/** Accessibility prefixes injected by Gemini's DOM that should be stripped from previews effectively globally. */
// Anchored to the start, so it only strips leading invisible characters and can
// never split an emoji sequence in the label body.
const TURN_LABEL_PREFIXES =
  // oxlint-disable-next-line no-misleading-character-class
  /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]*(?:you said|you wrote|user message|your prompt|you asked)[:\s]*/i;
const VISUALLY_HIDDEN_CLASS_FRAGMENT = 'visually-hidden';
const INJECTED_UI_SELECTOR = '.gv-fork-btn, .gv-fork-confirm, .gv-fork-indicator-group';
const ASSISTANT_PREVIEW_SELECTOR = [
  '[aria-label="Gemini response"]',
  '[data-message-author-role="assistant"]',
  '[data-message-author-role="model"]',
  'article[data-author="assistant"]',
  'article[data-turn="assistant"]',
  'article[data-turn="model"]',
  '.model-response',
  'model-response',
  '.response-container',
].join(',');
const ASSISTANT_PREVIEW_CONTENT_SELECTOR =
  'message-content, .markdown, .markdown-main-panel, .presented-response-container, .response-content, response-element';
const ASSISTANT_PREVIEW_EXCLUDED_SELECTOR =
  'model-thoughts, .thoughts-container, .thoughts-content, deep-research-immersive-panel';

/** Reads Gemini turn text and preserves identity across DOM remounts. */
export class TimelineTurns {
  private readonly turnIdByIndex = new Map<number, string>();

  collect(
    container: HTMLElement,
    selector: string,
    previousMarkers: readonly TimelineMarker[] = [],
  ): TimelineMarker[] {
    let elements = this.filterTopLevel(Array.from(container.querySelectorAll(selector)));
    if (elements.length === 0) return [];
    const firstOffset = elements[0].offsetTop;
    elements = this.dedupeByTextAndOffset(elements, firstOffset);
    const span = Math.max(1, elements[elements.length - 1].offsetTop - firstOffset);
    const summaries = this.collectAssistantSummaries(elements, container);
    const owners = this.collectExistingTurnIdOwners(elements);
    const previousOwners = this.collectPreviousMarkerElementsById(previousMarkers);
    const usedIds = new Set<string>();
    return elements.map((element, index) => ({
      id: this.ensureTurnId(element, index, usedIds, owners, previousOwners),
      element,
      summary: this.getTurnTextCached(element),
      assistantSummary: summaries.get(element) ?? '',
      baseN: Math.max(0, Math.min(1, (element.offsetTop - firstOffset) / span)),
      starred: false,
    }));
  }
  private normalizeText(text: string | null): string {
    try {
      if (!text) return '';
      // 1. Collapse whitespace
      const collapsed = String(text).replace(/\s+/g, ' ').trim();
      // 2. Strip prefixes (You said, etc.)
      return collapsed.replace(TURN_LABEL_PREFIXES, '');
    } catch {
      return '';
    }
  }

  private hasVisuallyHiddenClass(el: Element): boolean {
    if (!(el instanceof HTMLElement) || el.classList.length === 0) return false;
    for (const cls of el.classList) {
      if (cls.toLowerCase().includes(VISUALLY_HIDDEN_CLASS_FRAGMENT)) return true;
    }
    return false;
  }

  // extractTurnText deep-clones the turn subtree, so it must not run for
  // every turn on every debounced recalc — during streaming that meant
  // re-cloning the whole conversation every 200ms. Cache per element,
  // validated against the element's current raw textContent: any in-place
  // change (user edit, late LaTeX render, injected UI) alters the raw text
  // and recomputes. WeakMap entries die with their DOM nodes; nothing is
  // persisted to storage.
  private turnTextCache = new WeakMap<HTMLElement, { raw: string; summary: string }>();

  getTurnTextCached(element: HTMLElement | null): string {
    if (!element) return '';
    const raw = element.textContent || '';
    const cached = this.turnTextCache.get(element);
    if (cached && cached.raw === raw) return cached.summary;
    const summary = this.extractTurnText(element);
    this.turnTextCache.set(element, { raw, summary });
    return summary;
  }

  private extractTurnText(element: HTMLElement | null): string {
    if (!element) return '';
    try {
      const clone = element.cloneNode(true) as HTMLElement;
      if (this.hasVisuallyHiddenClass(clone)) return '';

      // Remove visually-hidden descendants
      const descendants = clone.getElementsByTagName('*');
      for (let i = descendants.length - 1; i >= 0; i--) {
        if (this.hasVisuallyHiddenClass(descendants[i])) {
          descendants[i].remove();
        }
      }

      // Remove extension-injected UI elements (e.g. fork button)
      clone.querySelectorAll(INJECTED_UI_SELECTOR).forEach((el) => el.remove());

      // Restore original text for LaTeX-rendered elements
      clone.querySelectorAll<HTMLElement>('[data-user-latex-original]').forEach((el) => {
        el.textContent = el.dataset.userLatexOriginal ?? '';
      });

      return this.normalizeText(clone.textContent || '');
    } catch {
      return this.normalizeText(element.textContent || '');
    }
  }

  private assistantTextCache = new WeakMap<HTMLElement, { raw: string; summary: string }>();

  private getAssistantTextCached(element: HTMLElement): string {
    const raw = element.textContent || '';
    const cached = this.assistantTextCache.get(element);
    if (cached && cached.raw === raw) return cached.summary;

    const summary = this.extractAssistantText(element);
    this.assistantTextCache.set(element, { raw, summary });
    return summary;
  }

  private extractAssistantText(element: HTMLElement): string {
    try {
      const preferred = Array.from(
        element.querySelectorAll<HTMLElement>(ASSISTANT_PREVIEW_CONTENT_SELECTOR),
      ).find((candidate) => !candidate.closest(ASSISTANT_PREVIEW_EXCLUDED_SELECTOR));
      const clone = (preferred ?? element).cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          `${ASSISTANT_PREVIEW_EXCLUDED_SELECTOR}, ${INJECTED_UI_SELECTOR}, button, [role="button"]`,
        )
        .forEach((node) => node.remove());
      clone.querySelectorAll('*').forEach((node) => {
        if (this.hasVisuallyHiddenClass(node)) node.remove();
      });
      return this.normalizeText(clone.textContent || '');
    } catch {
      return this.normalizeText(element.textContent || '');
    }
  }

  /** Pair each mounted user turn with the first model response before the next user turn. */
  private collectAssistantSummaries(
    userTurns: HTMLElement[],
    conversationContainer: HTMLElement,
  ): Map<HTMLElement, string> {
    const summaries = new Map<HTMLElement, string>();
    if (!conversationContainer || userTurns.length === 0) return summaries;

    const assistantCandidates = Array.from(
      conversationContainer.querySelectorAll<HTMLElement>(ASSISTANT_PREVIEW_SELECTOR),
    ).filter(
      (candidate) =>
        !candidate.closest('deep-research-immersive-panel') &&
        !userTurns.some((userTurn) => userTurn.contains(candidate)),
    );
    const assistants = this.filterTopLevel(assistantCandidates);
    let assistantIndex = 0;

    const isBefore = (first: Node, second: Node): boolean =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    for (let index = 0; index < userTurns.length; index++) {
      const userTurn = userTurns[index];
      const nextUserTurn = userTurns[index + 1] ?? null;

      while (
        assistantIndex < assistants.length &&
        !isBefore(userTurn, assistants[assistantIndex])
      ) {
        assistantIndex += 1;
      }

      const assistant = assistants[assistantIndex];
      if (!assistant) break;
      if (nextUserTurn && !isBefore(assistant, nextUserTurn)) continue;

      const summary = this.getAssistantTextCached(assistant);
      if (summary) summaries.set(userTurn, summary);
      assistantIndex += 1;
    }
    return summaries;
  }

  /**
   * Remove selector matches nested inside another match while preserving the
   * original DOM/query order. Walking ancestors against a Set costs
   * O(matches × DOM depth), instead of comparing every pair with contains().
   */
  filterTopLevel(elements: Element[]): HTMLElement[] {
    const arr = elements.map((e) => e as HTMLElement);
    if (arr.length === 0) return arr;

    const candidates = new Set<HTMLElement>(arr);
    return arr.filter((element) => {
      let ancestor = element.parentElement;
      while (ancestor) {
        if (candidates.has(ancestor)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  /**
   * Performance-optimized deduplication with cached text normalization
   */
  private dedupeByTextAndOffset(elements: HTMLElement[], firstTurnOffset: number): HTMLElement[] {
    const seen = new Set<string>();
    const out: HTMLElement[] = [];

    for (const el of elements) {
      const normalizedText = this.getTurnTextCached(el);

      const offsetFromStart = (el.offsetTop || 0) - firstTurnOffset;
      const key = `${normalizedText}|${Math.round(offsetFromStart)}`;

      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  private collectExistingTurnIdOwners(elements: HTMLElement[]): Map<string, HTMLElement[]> {
    const owners = new Map<string, HTMLElement[]>();
    elements.forEach((el) => {
      const id = el.dataset?.turnId?.trim() || '';
      if (!id) return;
      const existing = owners.get(id);
      if (existing) {
        existing.push(el);
      } else {
        owners.set(id, [el]);
      }
    });
    return owners;
  }

  private collectPreviousMarkerElementsById(
    markers: readonly TimelineMarker[],
  ): Map<string, Set<HTMLElement>> {
    const elementsById = new Map<string, Set<HTMLElement>>();
    markers.forEach((marker) => {
      let elements = elementsById.get(marker.id);
      if (!elements) {
        elements = new Set<HTMLElement>();
        elementsById.set(marker.id, elements);
      }
      elements.add(marker.element);
    });
    return elementsById;
  }

  private shouldKeepExistingTurnId(
    id: string,
    el: HTMLElement,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
    previousMarkerElementsById: Map<string, Set<HTMLElement>>,
  ): boolean {
    if (usedIds.has(id)) return false;

    const owners = existingTurnIdOwners.get(id) ?? [];
    if (owners.length <= 1) return true;

    const previousOwners = previousMarkerElementsById.get(id);
    if (!previousOwners || previousOwners.size === 0) return owners[0] === el;
    if (previousOwners.has(el)) return true;

    return !owners.some((owner) => owner !== el && previousOwners.has(owner));
  }

  private allocateTurnId(
    el: HTMLElement,
    index: number,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
  ): string {
    const basis = this.getTurnTextCached(el) || `user-${index}`;
    const candidates = [
      this.turnIdByIndex.get(index) || '',
      makeStableTurnId(index),
      `u-${index}-${hashString(basis)}`,
    ];

    for (const candidate of candidates) {
      if (!candidate || usedIds.has(candidate)) continue;
      if (existingTurnIdOwners.has(candidate)) continue;
      return candidate;
    }

    const base = `u-${index}-${hashString(`${basis}|dedupe`)}`;
    let suffix = 0;
    let candidate = base;
    while (usedIds.has(candidate) || existingTurnIdOwners.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  private ensureTurnId(
    el: Element,
    index: number,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
    previousMarkerElementsById: Map<string, Set<HTMLElement>>,
  ): string {
    const asEl = el as HTMLElement & { dataset?: DOMStringMap & { turnId?: string } };

    // Gemini's response id is the canonical identity. It survives full reloads
    // and partial DOM windows, unlike every positional fallback.
    const serverId = readServerTurnId(asEl);
    if (serverId && !usedIds.has(serverId)) {
      try {
        if (asEl.dataset) asEl.dataset.turnId = serverId;
      } catch {}
      usedIds.add(serverId);
      this.turnIdByIndex.set(index, serverId);
      return serverId;
    }

    const existingId = asEl.dataset?.turnId?.trim() || '';
    if (
      existingId &&
      this.shouldKeepExistingTurnId(
        existingId,
        asEl,
        usedIds,
        existingTurnIdOwners,
        previousMarkerElementsById,
      )
    ) {
      usedIds.add(existingId);
      this.turnIdByIndex.set(index, existingId);
      return existingId;
    }

    const id = this.allocateTurnId(asEl, index, usedIds, existingTurnIdOwners);
    try {
      if (asEl.dataset) asEl.dataset.turnId = id;
    } catch {}
    usedIds.add(id);
    this.turnIdByIndex.set(index, id);
    return id;
  }
}
