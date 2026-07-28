import {
  buildConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';

import {
  filterOutDeepResearchImmersiveNodes,
  resolveConversationRoot,
} from '../export/conversationDom';
import { getLegacyTurnIndex, makeTurnId, normalizeTurnId } from '../fork/turnId';
import { historyTimestampStore } from '../timestamp/historyTimestamps';

const USER_SELECTORS = [
  '.user-query-bubble-with-background',
  '.user-query-bubble-container',
  '.user-query-container',
  'user-query-content .user-query-bubble-with-background',
  'div[aria-label="User message"]',
  'article[data-author="user"]',
  'article[data-turn="user"]',
  '[data-message-author-role="user"]',
  'div[role="listitem"][data-user="true"]',
] as const;

const ASSISTANT_SELECTORS = [
  '[aria-label="Gemini response"]',
  '[data-message-author-role="assistant"]',
  '[data-message-author-role="model"]',
  'article[data-author="assistant"]',
  'article[data-turn="assistant"]',
  'article[data-turn="model"]',
  '.model-response',
  'model-response',
  '.response-container',
  'div[role="listitem"]:not([data-user="true"])',
] as const;

const ASSISTANT_CONTENT_SELECTORS = [
  'message-content',
  '.markdown-main-panel',
  '.markdown',
  '.response-content',
  'response-element',
] as const;

const THOUGHTS_SELECTOR = 'model-thoughts, .thoughts-container, .thoughts-content';

export interface HighlightTurnDom {
  turnId: string;
  userElement: HTMLElement;
  assistantHost: HTMLElement;
  assistantRoot: HTMLElement;
}

export interface HighlightSelectionContext extends HighlightTurnDom {
  conversationId: string;
  conversationUrl: string;
  conversationTitle?: string;
}

function filterTopLevel(elements: HTMLElement[]): HTMLElement[] {
  const candidates = new Set<Element>(elements);
  return elements.filter((element) => {
    let parent = element.parentElement;
    while (parent) {
      if (candidates.has(parent)) return false;
      parent = parent.parentElement;
    }
    return true;
  });
}

function isBefore(left: Node, right: Node): boolean {
  return Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function getUserSelectors(): string[] {
  let configured = '';
  try {
    configured =
      localStorage.getItem('geminiTimelineUserTurnSelector') ||
      localStorage.getItem('geminiTimelineUserTurnSelectorAuto') ||
      '';
  } catch {}
  if (configured) {
    try {
      document.querySelector(configured);
    } catch {
      configured = '';
    }
  }
  return configured
    ? [configured, ...USER_SELECTORS.filter((selector) => selector !== configured)]
    : [...USER_SELECTORS];
}

function getTopLevelMatches(root: HTMLElement, selectors: readonly string[]): HTMLElement[] {
  const matchesBySelector = selectors.flatMap((selector) => {
    try {
      return Array.from(root.querySelectorAll<HTMLElement>(selector));
    } catch {
      return [];
    }
  });
  const matches = filterOutDeepResearchImmersiveNodes(
    Array.from(new Set(matchesBySelector)),
  ).filter((element) => !element.closest(THOUGHTS_SELECTOR));
  return filterTopLevel(matches);
}

function getAssistantMatches(root: HTMLElement): HTMLElement[] {
  const specific = getTopLevelMatches(root, ASSISTANT_SELECTORS.slice(0, -1));
  return specific.length > 0
    ? specific
    : getTopLevelMatches(root, [ASSISTANT_SELECTORS[ASSISTANT_SELECTORS.length - 1]]);
}

function findAssistantRootForTarget(host: HTMLElement, target?: Node): HTMLElement {
  for (const selector of ASSISTANT_CONTENT_SELECTORS) {
    const candidates = Array.from(host.querySelectorAll<HTMLElement>(selector));
    const candidate = candidates.find(
      (element) =>
        !element.closest(THOUGHTS_SELECTOR) &&
        (!target || element === target || element.contains(target)),
    );
    if (candidate) return candidate;
  }
  return host;
}

function getConversationTitle(users: HTMLElement[]): string | undefined {
  const title = document.title.trim();
  if (title && title !== 'Gemini' && title !== 'Google Gemini' && !title.startsWith('Gemini -')) {
    return title;
  }

  const firstUserText = users[0]?.textContent?.replace(/\s+/g, ' ').trim();
  if (!firstUserText) return undefined;
  return firstUserText.length > 80 ? `${firstUserText.slice(0, 77)}...` : firstUserText;
}

export function collectHighlightTurns(): HighlightTurnDom[] {
  const userSelectors = getUserSelectors();
  const root = resolveConversationRoot({ userSelectors, doc: document });
  const users = getTopLevelMatches(root, userSelectors);
  const assistants = getAssistantMatches(root);
  const turns: HighlightTurnDom[] = [];
  let assistantIndex = 0;

  users.forEach((userElement, index) => {
    const nextUser = users[index + 1];
    while (
      assistantIndex < assistants.length &&
      !isBefore(userElement, assistants[assistantIndex])
    ) {
      assistantIndex += 1;
    }
    const candidate = assistants[assistantIndex];
    const assistantHost =
      candidate && (!nextUser || isBefore(candidate, nextUser)) ? candidate : null;
    if (!assistantHost) return;
    assistantIndex += 1;

    const turnId = makeTurnId(userElement, index);
    userElement.dataset.turnId = turnId;
    turns.push({
      turnId,
      userElement,
      assistantHost,
      assistantRoot: findAssistantRootForTarget(assistantHost),
    });
  });

  return turns;
}

export function getHighlightSelectionContext(range: Range): HighlightSelectionContext | null {
  if (range.collapsed) return null;
  const target =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!target || target.closest(THOUGHTS_SELECTOR)) return null;

  const turns = collectHighlightTurns();
  const turn = turns.find(
    ({ assistantHost }) => assistantHost === target || assistantHost.contains(target),
  );
  if (!turn) return null;
  const stableTurnId = resolveMountedHighlightTurnId(turn.turnId);
  if (!stableTurnId) return null;

  const assistantRoot = findAssistantRootForTarget(turn.assistantHost, target);
  if (
    (!assistantRoot.contains(range.startContainer) && assistantRoot !== range.startContainer) ||
    (!assistantRoot.contains(range.endContainer) && assistantRoot !== range.endContainer)
  ) {
    return null;
  }

  const users = turns.map(({ userElement }) => userElement);
  const conversationUrl = `${location.origin}${location.pathname}${location.search}`;
  return {
    ...turn,
    turnId: stableTurnId,
    assistantRoot,
    conversationId: buildConversationIdFromUrl(conversationUrl),
    conversationUrl,
    conversationTitle: getConversationTitle(users),
  };
}

export function findHighlightTurn(turnId: string): HighlightTurnDom | null {
  const normalized = resolveStoredHighlightTurnId(turnId);
  if (!normalized) return null;
  return (
    collectHighlightTurns().find(
      (turn) => resolveMountedHighlightTurnId(turn.turnId) === normalized,
    ) ?? null
  );
}

/** Resolve persisted ids, including verified legacy aliases. */
export function resolveStoredHighlightTurnId(turnId: string): string | null {
  const nativeConversationId = extractConversationIdFromUrl(window.location.href);
  if (!nativeConversationId) return normalizeTurnId(turnId);
  return historyTimestampStore.resolveCanonicalTurnId(nativeConversationId, turnId);
}

/** A live positional fallback is never proof of full-conversation identity. */
export function resolveMountedHighlightTurnId(turnId: string): string | null {
  if (getLegacyTurnIndex(turnId) !== null) return null;
  return resolveStoredHighlightTurnId(turnId);
}

export function findScrollableAncestor(element: HTMLElement): HTMLElement {
  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return (
    (document.scrollingElement as HTMLElement | null) ?? document.documentElement ?? document.body
  );
}
