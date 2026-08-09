import { hashString } from '@/core/utils/hash';
import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn, ConversationMetadata } from '@/features/export/types/export';

export type ChatGptMessageRole = 'user' | 'assistant';

export interface ChatGptMessageSnapshot {
  readonly id: string;
  readonly role: ChatGptMessageRole;
  readonly text: string;
  readonly element: HTMLElement;
  readonly order: number;
}

export interface MountedChatGptMessage {
  readonly snapshot: ChatGptMessageSnapshot;
  readonly host: HTMLElement;
}

export interface ConversationCollectionProgress {
  readonly messages: number;
  readonly position: number;
  readonly total: number;
}

export interface ConversationCollectionOptions {
  readonly signal: AbortSignal;
  readonly root?: ParentNode;
  readonly settleMs?: number;
  readonly maxSteps?: number;
  readonly onProgress?: (progress: ConversationCollectionProgress) => void;
}

const MESSAGE_SELECTOR = [
  '[data-message-author-role="user"]',
  '[data-message-author-role="assistant"]',
  'article[data-author="user"]',
  'article[data-author="assistant"]',
  'article[data-turn="user"]',
  'article[data-turn="assistant"]',
].join(',');

const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
const DEFAULT_SETTLE_MS = 120;
const DEFAULT_MAX_STEPS = 240;

function abortError(): DOMException {
  return new DOMException('Conversation collection was cancelled', 'AbortError');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getRole(element: HTMLElement): ChatGptMessageRole | null {
  const raw =
    element.getAttribute('data-message-author-role') ||
    element.getAttribute('data-author') ||
    element.getAttribute('data-turn');
  if (raw === 'user') return 'user';
  if (raw === 'assistant' || raw === 'model') return 'assistant';
  return null;
}

function getMessageElement(candidate: HTMLElement): HTMLElement | null {
  const directRole = getRole(candidate);
  if (candidate.hasAttribute('data-message-author-role') && directRole) return candidate;
  if (!directRole) return null;
  return (
    candidate.querySelector<HTMLElement>(`[data-message-author-role="${directRole}"]`) || candidate
  );
}

function normalizePlainText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      [
        'button',
        '[role="button"]',
        'script',
        'style',
        'svg',
        '[data-gv-chatgpt-export-owned]',
        '.katex-html',
      ].join(','),
    )
    .forEach((node) => node.remove());
  return (clone.innerText || clone.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readOrder(element: HTMLElement, fallback: number): number {
  const turn = element.closest<HTMLElement>(TURN_SELECTOR);
  const testId = turn?.getAttribute('data-testid') || '';
  const numeric = /conversation-turn-(\d+)/.exec(testId)?.[1];
  return numeric === undefined ? fallback : Number(numeric);
}

function readStableId(
  element: HTMLElement,
  role: ChatGptMessageRole,
  text: string,
  order: number,
): string {
  const turn = element.closest<HTMLElement>(TURN_SELECTOR);
  const nativeId =
    element.getAttribute('data-message-id') ||
    element.closest<HTMLElement>('[data-message-id]')?.getAttribute('data-message-id') ||
    turn?.getAttribute('data-message-id') ||
    turn?.getAttribute('data-testid') ||
    element.getAttribute('id');
  if (nativeId) return nativeId;
  return `fallback-${role}-${order}-${hashString(text)}`;
}

/**
 * Snapshot every currently mounted ChatGPT message. The returned elements are
 * detached deep clones, so later React virtualisation cannot mutate an export
 * that is already being prepared.
 */
export function collectMountedChatGptMessagesWithHosts(
  root: ParentNode = document,
): MountedChatGptMessage[] {
  const messages = new Map<string, MountedChatGptMessage>();
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR));
  candidates.forEach((candidate, index) => {
    const element = getMessageElement(candidate);
    const role = element ? getRole(element) : null;
    if (!element || !role) return;

    const text = normalizePlainText(element);
    if (!text && !element.querySelector('img, video, audio, pre, code, table, .katex')) return;
    const order = readOrder(element, index);
    const id = readStableId(element, role, text, order);
    const previous = messages.get(id);
    if (previous?.snapshot.element.hasAttribute('data-message-author-role')) return;

    messages.set(id, {
      snapshot: {
        id,
        role,
        text,
        element: element.cloneNode(true) as HTMLElement,
        order,
      },
      host: element.closest<HTMLElement>(TURN_SELECTOR) || element,
    });
  });
  return [...messages.values()].sort((left, right) => left.snapshot.order - right.snapshot.order);
}

export function collectMountedChatGptMessages(
  root: ParentNode = document,
): ChatGptMessageSnapshot[] {
  return collectMountedChatGptMessagesWithHosts(root).map(({ snapshot }) => snapshot);
}

function findScrollContainer(root: ParentNode): HTMLElement | null {
  const first = root.querySelector<HTMLElement>(MESSAGE_SELECTOR);
  for (let parent = first?.parentElement ?? null; parent && parent !== document.body; ) {
    const style = window.getComputedStyle(parent);
    if (
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      parent.scrollHeight > parent.clientHeight + 4
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  const scrolling = document.scrollingElement;
  return scrolling instanceof HTMLElement ? scrolling : null;
}

function mergeSnapshots(
  destination: Map<string, ChatGptMessageSnapshot>,
  incoming: readonly ChatGptMessageSnapshot[],
): void {
  for (const snapshot of incoming) {
    const previous = destination.get(snapshot.id);
    destination.set(snapshot.id, {
      ...snapshot,
      order: previous ? Math.min(previous.order, snapshot.order) : snapshot.order,
    });
  }
}

function emitProgress(
  options: ConversationCollectionOptions,
  messages: number,
  target: HTMLElement | null,
): void {
  options.onProgress?.({
    messages,
    position: target?.scrollTop ?? 0,
    total: target ? Math.max(0, target.scrollHeight - target.clientHeight) : 0,
  });
}

/**
 * Materialise a virtualised ChatGPT conversation from top to bottom, keeping a
 * detached snapshot of every stable message id and restoring the user's scroll
 * position afterwards.
 */
export async function collectChatGptConversation(
  options: ConversationCollectionOptions,
): Promise<ChatGptMessageSnapshot[]> {
  const root = options.root ?? document;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const collected = new Map<string, ChatGptMessageSnapshot>();
  const target = findScrollContainer(root);

  if (!target || target.scrollHeight <= target.clientHeight + 4) {
    mergeSnapshots(collected, collectMountedChatGptMessages(root));
    emitProgress(options, collected.size, null);
    return [...collected.values()].sort((left, right) => left.order - right.order);
  }

  const originalTop = target.scrollTop;
  try {
    target.scrollTop = 0;
    let stableAtTop = 0;
    let previousSize = -1;
    while (stableAtTop < 3) {
      await wait(settleMs, options.signal);
      assertNotAborted(options.signal);
      mergeSnapshots(collected, collectMountedChatGptMessages(root));
      emitProgress(options, collected.size, target);
      if (collected.size === previousSize && target.scrollTop <= 1) stableAtTop += 1;
      else stableAtTop = 0;
      previousSize = collected.size;
      target.scrollTop = 0;
    }

    let steps = 0;
    let stalled = 0;
    while (steps < maxSteps) {
      assertNotAborted(options.signal);
      mergeSnapshots(collected, collectMountedChatGptMessages(root));
      emitProgress(options, collected.size, target);

      const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
      if (target.scrollTop >= maximum - 2) {
        await wait(settleMs, options.signal);
        mergeSnapshots(collected, collectMountedChatGptMessages(root));
        break;
      }

      const previousTop = target.scrollTop;
      const step = Math.max(320, Math.floor(target.clientHeight * 0.72));
      target.scrollTop = Math.min(maximum, previousTop + step);
      await wait(settleMs, options.signal);
      stalled = target.scrollTop <= previousTop + 1 ? stalled + 1 : 0;
      if (stalled >= 3) break;
      steps += 1;
    }
  } finally {
    target.scrollTop = Math.min(
      originalTop,
      Math.max(0, target.scrollHeight - target.clientHeight),
    );
  }

  return [...collected.values()].sort((left, right) => left.order - right.order);
}

export function buildChatTurns(messages: readonly ChatGptMessageSnapshot[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        user: message.text,
        assistant: '',
        starred: false,
        omitEmptySections: true,
        userElement: message.element,
      });
      continue;
    }

    const current = turns[turns.length - 1];
    if (current && !current.assistantElement && !current.assistant) {
      current.assistant = message.text;
      current.assistantElement = message.element;
      continue;
    }
    turns.push({
      user: '',
      assistant: message.text,
      starred: false,
      omitEmptySections: true,
      assistantElement: message.element,
    });
  }
  return turns;
}

export function extractSnapshotMarkdown(message: ChatGptMessageSnapshot): string {
  const extracted =
    message.role === 'user'
      ? DOMContentExtractor.extractUserContent(message.element)
      : DOMContentExtractor.extractAssistantContent(message.element);
  return extracted.text || message.text;
}

export function getChatGptConversationTitle(
  messages: readonly ChatGptMessageSnapshot[] = [],
): string {
  const pageTitle = document.title
    .replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, '')
    .replace(/^ChatGPT\s*[|\-–—]\s*/i, '')
    .trim();
  if (pageTitle && pageTitle.toLowerCase() !== 'chatgpt') return pageTitle;
  const firstPrompt = messages.find((message) => message.role === 'user')?.text.trim();
  return firstPrompt?.slice(0, 80) || 'ChatGPT conversation';
}

export function buildConversationMetadata(
  messages: readonly ChatGptMessageSnapshot[],
): ConversationMetadata {
  return {
    url: location.href,
    exportedAt: new Date().toISOString(),
    title: getChatGptConversationTitle(messages),
    count: buildChatTurns(messages).length,
  };
}
