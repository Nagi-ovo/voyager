import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';

import {
  filterOutDeepResearchImmersiveNodes,
  resolveConversationRoot,
} from '../export/conversationDom';
import { makeTurnId } from './turnId';

export interface ForkChatPair {
  turnId: string;
  user: string;
  assistant: string;
  userElement: HTMLElement;
}

function normalizeText(text: string | null): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

function filterTopLevel(elements: Element[]): HTMLElement[] {
  const arr = elements.map((element) => element as HTMLElement);
  const out: HTMLElement[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    let isDescendant = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const other = arr[j];
      if (other.contains(el)) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) out.push(el);
  }
  return out;
}

function dedupeByTextAndOffset(elements: HTMLElement[], firstTurnOffset: number): HTMLElement[] {
  const seen = new Set<string>();
  const out: HTMLElement[] = [];
  for (const el of elements) {
    const offsetFromStart = (el.offsetTop || 0) - firstTurnOffset;
    const key = `${normalizeText(el.textContent || '')}|${Math.round(offsetFromStart)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

function getUserSelectors(): string[] {
  const configured = (() => {
    try {
      return (
        localStorage.getItem('geminiTimelineUserTurnSelector') ||
        localStorage.getItem('geminiTimelineUserTurnSelectorAuto') ||
        ''
      );
    } catch {
      return '';
    }
  })();

  const defaults = [
    '.user-query-bubble-with-background',
    '.user-query-bubble-container',
    '.user-query-container',
    'user-query-content .user-query-bubble-with-background',
    'div[aria-label="User message"]',
    'article[data-author="user"]',
    'article[data-turn="user"]',
    '[data-message-author-role="user"]',
    'div[role="listitem"][data-user="true"]',
  ];
  return configured
    ? [configured, ...defaults.filter((selector) => selector !== configured)]
    : defaults;
}

function getAssistantSelectors(): string[] {
  return [
    '[aria-label="Gemini response"]',
    '[data-message-author-role="assistant"]',
    '[data-message-author-role="model"]',
    'article[data-author="assistant"]',
    'article[data-turn="assistant"]',
    'article[data-turn="model"]',
    '.model-response, model-response',
    '.response-container',
    'div[role="listitem"]:not([data-user="true"])',
  ];
}

function pickAssistantExportElement(assistantHost: HTMLElement): HTMLElement {
  return (
    queryOutsideThoughts<HTMLElement>(assistantHost, 'message-content') ||
    queryOutsideThoughts<HTMLElement>(assistantHost, '.markdown, .markdown-main-panel') ||
    (assistantHost.closest('.presented-response-container') as HTMLElement | null) ||
    queryOutsideThoughts<HTMLElement>(
      assistantHost,
      '.presented-response-container, .response-content',
    ) ||
    queryOutsideThoughts<HTMLElement>(assistantHost, 'response-element') ||
    assistantHost
  );
}

export function collectForkChatPairs(): ForkChatPair[] {
  const userSelectors = getUserSelectors();
  const assistantSelectors = getAssistantSelectors();
  const root = resolveConversationRoot({ userSelectors, doc: document });

  const userNodesRaw = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  if (userNodesRaw.length === 0) return [];

  let users = filterTopLevel(userNodesRaw);
  if (users.length === 0) return [];

  const firstOffset = users[0].offsetTop || 0;
  users = dedupeByTextAndOffset(users, firstOffset);
  const userOffsets = users.map((el) => el.offsetTop || 0);

  const assistantNodesRaw = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))),
  );
  const assistants = filterTopLevel(assistantNodesRaw);
  const assistantOffsets = assistants.map((el) => el.offsetTop || 0);

  const pairs: ForkChatPair[] = [];

  for (let i = 0; i < users.length; i++) {
    const userEl = users[i];
    const turnId = makeTurnId(userEl, i);
    userEl.dataset.turnId = turnId;

    const userExtracted = DOMContentExtractor.extractUserContent(userEl).text;
    const userText = userExtracted || normalizeText(userEl.innerText || userEl.textContent || '');

    const start = userOffsets[i];
    const end = i + 1 < userOffsets.length ? userOffsets[i + 1] : Number.POSITIVE_INFINITY;

    let assistantHost: HTMLElement | null = null;
    let bestOff = Number.POSITIVE_INFINITY;

    for (let k = 0; k < assistants.length; k++) {
      const off = assistantOffsets[k];
      if (off >= start && off < end && off < bestOff) {
        bestOff = off;
        assistantHost = assistants[k];
      }
    }

    if (!assistantHost) {
      let sib: HTMLElement | null = userEl;
      for (let step = 0; step < 8 && sib; step++) {
        sib = sib.nextElementSibling as HTMLElement | null;
        if (!sib) break;
        if (sib.matches(userSelectors.join(','))) break;
        if (sib.matches(assistantSelectors.join(','))) {
          assistantHost = sib;
          break;
        }
      }
    }

    let assistantText = '';
    if (assistantHost) {
      const assistantExportEl = pickAssistantExportElement(assistantHost);
      const extracted = DOMContentExtractor.extractAssistantContent(assistantExportEl).text;
      assistantText =
        extracted ||
        normalizeText(assistantExportEl.innerText || assistantExportEl.textContent || '');
    }

    if (userText || assistantText) {
      pairs.push({
        turnId,
        user: userText,
        assistant: assistantText,
        userElement: userEl,
      });
    }
  }

  return pairs;
}
