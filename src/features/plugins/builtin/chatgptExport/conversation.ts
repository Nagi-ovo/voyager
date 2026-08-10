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
const TOP_STABLE_SAMPLES = 10;
const BOTTOM_STABLE_SAMPLES = 3;
const TOP_LOADING_SELECTOR = '[aria-busy="true"], [data-testid*="loading"]';
const GENERATION_ACTIVE_SELECTOR =
  '[data-testid="stop-button"], button[data-testid*="stop" i], button[aria-label*="stop generating" i]';
let fallbackIdentitySequence = 0;
const fallbackIdentities = new WeakMap<HTMLElement, { role: ChatGptMessageRole; id: string }>();

class IncompleteConversationCollectionError extends Error {
  constructor(readonly messageCount: number) {
    super(
      `Conversation collection stopped before reaching the end (${messageCount} messages found)`,
    );
    this.name = 'IncompleteConversationCollectionError';
  }
}

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
  if (numeric !== undefined) return Number(numeric);
  return readVirtualPosition(turn || element)?.order ?? fallback;
}

function readVirtualPosition(host: HTMLElement): { key: string; order?: number } | null {
  const explicit =
    host.getAttribute('data-index') ||
    host.getAttribute('data-message-index') ||
    host.getAttribute('aria-posinset');
  if (explicit) {
    const numeric = Number(explicit);
    return {
      key: `index-${explicit}`,
      order: Number.isFinite(numeric) ? numeric : undefined,
    };
  }

  for (let parent = host.parentElement; parent && parent !== document.body; ) {
    const style = window.getComputedStyle(parent);
    if (
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      parent.scrollHeight > parent.clientHeight + 4
    ) {
      const offset = host.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      const globalOffset = Math.round(offset + parent.scrollTop);
      return { key: `offset-${globalOffset}`, order: globalOffset };
    }
    parent = parent.parentElement;
  }
  return null;
}

function readStableId(element: HTMLElement, role: ChatGptMessageRole): string {
  const turn = element.closest<HTMLElement>(TURN_SELECTOR);
  const nativeId =
    element.getAttribute('data-message-id') ||
    element.closest<HTMLElement>('[data-message-id]')?.getAttribute('data-message-id') ||
    turn?.getAttribute('data-message-id') ||
    turn?.getAttribute('data-testid') ||
    element.getAttribute('id');
  if (nativeId) return nativeId;

  const host = turn || element;
  const virtualPosition = readVirtualPosition(host);
  if (virtualPosition) return `fallback-${role}-${virtualPosition.key}`;

  // Outside a measurable virtual scroller, keep an identity only for this
  // concrete DOM host. The ID must not change while a response is streaming.
  const previous = fallbackIdentities.get(host);
  if (previous?.role === role) return previous.id;
  fallbackIdentitySequence += 1;
  const id = `fallback-${role}-${fallbackIdentitySequence}`;
  fallbackIdentities.set(host, { role, id });
  return id;
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
    const id = readStableId(element, role);
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

async function waitForStableBottom(
  root: ParentNode,
  target: HTMLElement | null,
  collected: Map<string, ChatGptMessageSnapshot>,
  options: ConversationCollectionOptions,
  settleMs: number,
): Promise<void> {
  const requiredSamples = settleMs === 0 ? 3 : BOTTOM_STABLE_SAMPLES;
  const maximumSamples =
    settleMs === 0 ? 50 : Math.max(requiredSamples, Math.ceil(120_000 / settleMs));
  let stableSamples = 0;
  let samples = 0;
  let previousSignature = '';

  while (stableSamples < requiredSamples) {
    await wait(settleMs, options.signal);
    assertNotAborted(options.signal);
    if (target) target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
    const mounted = collectMountedChatGptMessages(root);
    mergeSnapshots(collected, mounted);
    emitProgress(options, collected.size, target);
    const signature = `${target?.scrollHeight ?? 0}:${mounted
      .map(({ id, text }) => `${id}:${text}`)
      .join('|')}`;
    const generationActive = root.querySelector(GENERATION_ACTIVE_SELECTOR) !== null;
    if (!generationActive && signature === previousSignature) stableSamples += 1;
    else stableSamples = 0;
    previousSignature = signature;
    samples += 1;
    if (samples >= maximumSamples && stableSamples < requiredSamples) {
      throw new IncompleteConversationCollectionError(collected.size);
    }
  }
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
    await waitForStableBottom(root, null, collected, options, settleMs);
    return [...collected.values()].sort((left, right) => left.order - right.order);
  }

  const originalTop = target.scrollTop;
  try {
    target.scrollTop = 0;
    let stableAtTop = 0;
    let topSamples = 0;
    let previousTopSignature = '';
    const requiredTopSamples = settleMs === 0 ? 3 : TOP_STABLE_SAMPLES;
    const maximumTopSamples =
      settleMs === 0 ? 50 : Math.max(requiredTopSamples, Math.ceil(15_000 / settleMs));
    while (stableAtTop < requiredTopSamples) {
      await wait(settleMs, options.signal);
      assertNotAborted(options.signal);
      const mounted = collectMountedChatGptMessages(root);
      mergeSnapshots(collected, mounted);
      emitProgress(options, collected.size, target);
      const topSignature = `${target.scrollHeight}:${mounted
        .map(({ id, text }) => `${id}:${text}`)
        .join('|')}`;
      const historyLoading = target.querySelector(TOP_LOADING_SELECTOR) !== null;
      if (!historyLoading && topSignature === previousTopSignature && target.scrollTop <= 1) {
        stableAtTop += 1;
      } else stableAtTop = 0;
      previousTopSignature = topSignature;
      target.scrollTop = 0;
      topSamples += 1;
      if (topSamples >= maximumTopSamples && stableAtTop < requiredTopSamples) {
        throw new IncompleteConversationCollectionError(collected.size);
      }
    }

    let steps = 0;
    let stalled = 0;
    while (steps < maxSteps) {
      assertNotAborted(options.signal);
      mergeSnapshots(collected, collectMountedChatGptMessages(root));
      emitProgress(options, collected.size, target);

      const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
      if (target.scrollTop >= maximum - 2) {
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

    // Always merge the window produced by the final scroll assignment. If the
    // safety limit or a stalled scroller stops us above the bottom, fail
    // explicitly instead of presenting a partial export as complete.
    mergeSnapshots(collected, collectMountedChatGptMessages(root));
    emitProgress(options, collected.size, target);
    let finalMaximum = Math.max(0, target.scrollHeight - target.clientHeight);
    if (target.scrollTop < finalMaximum - 2) {
      throw new IncompleteConversationCollectionError(collected.size);
    }
    await waitForStableBottom(root, target, collected, options, settleMs);
    finalMaximum = Math.max(0, target.scrollHeight - target.clientHeight);
    if (target.scrollTop < finalMaximum - 2) {
      throw new IncompleteConversationCollectionError(collected.size);
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
