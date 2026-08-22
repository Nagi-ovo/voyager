import browser from 'webextension-polyfill';

import type { ChatTurn } from '@/features/export/types/export';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { insertTextIntoChatInput } from '@/pages/content/chatInput';
import type { AppLanguage } from '@/utils/language';

import { getTemporaryHandoffCopy } from './i18n';
import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
  PENDING_HANDOFF_KEY,
  PENDING_HANDOFF_STORAGE_PREFIX,
  PENDING_HANDOFF_TAB_KEY,
  PENDING_HANDOFF_TTL_MS,
} from './storage';

export { PENDING_HANDOFF_KEY, PENDING_HANDOFF_TAB_KEY } from './storage';

export type HandoffDelivery =
  | { readonly mode: 'inline'; readonly text: string }
  | {
      readonly mode: 'attachment';
      readonly directive: string;
      readonly attachment: string;
      readonly filename: string;
    };

export interface HandoffPlan {
  readonly delivery: HandoffDelivery;
  readonly transcript: string;
  readonly backupFilename: string;
}

interface PendingHandoff {
  readonly delivery: HandoffDelivery;
  readonly draft?: string;
  readonly storedAt: number;
  readonly accountScope: string;
  readonly deliveredRoute?: string;
}

export type HandoffResult =
  | 'ready'
  | 'leave-failed'
  | 'composer-missing'
  | 'delivery-failed'
  | 'storage-failed'
  | 'account-mismatch';

export type PendingHandoffResult = 'ready' | 'delivery-failed' | 'account-mismatch' | null;

export const CHATGPT_TEMP_TOGGLE_SELECTOR = [
  '[data-testid="temporary-chat-toggle"]',
  'button[aria-label*="temporary chat" i]',
  'button[aria-label*="临时聊天"]',
  'button[aria-label*="暫時聊天"]',
].join(',');
const CHATGPT_COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'form[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
  'form[data-testid*="composer" i] [contenteditable="true"][role="textbox"]',
] as const;
const CHATGPT_GENERIC_COMPOSER_SELECTOR = 'main form [contenteditable="true"][role="textbox"]';
export const CHATGPT_SEND_CONTROL_SELECTOR = [
  'button[data-testid="send-button"]',
  'button[data-testid="composer-submit-button"]',
].join(',');
export const CHATGPT_COMPOSER_SELECTOR = [
  ...CHATGPT_COMPOSER_SELECTORS,
  CHATGPT_GENERIC_COMPOSER_SELECTOR,
].join(',');
export const CHATGPT_NEW_CHAT_SELECTOR =
  'a[data-testid="create-new-chat-button"], a[href="/"], a[href^="/u/"][href$="/"]';
const INLINE_THRESHOLD = 5_000;
let activeHandoffOperations = 0;
let internalNavigationClicks = 0;
let fallbackFilenameSequence = 0;
let pageUnloading = false;
let deliveredPendingToken: string | null = null;
let recoveryCancellationRevision = 0;

export function markHandoffPageUnloading(): void {
  pageUnloading = true;
}

export function markHandoffPageActive(): void {
  pageUnloading = false;
}

export function isHandoffPageUnloading(): boolean {
  return pageUnloading;
}

function abortError(): DOMException {
  return new DOMException('Temporary chat handoff cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function wait(scope: PluginScope, ms: number): Promise<void> {
  if (scope.signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let stopTimer: Dispose | null = null;
    let stopAbort: Dispose | null = null;
    const settle = (action: () => void): void => {
      void stopTimer?.();
      void stopAbort?.();
      action();
    };
    stopTimer = scope.timer(() => settle(resolve), ms);
    stopAbort = scope.on(scope.signal, 'abort', () => settle(() => reject(abortError())));
  });
}

export function isTemporaryChat(): boolean {
  try {
    if (new URL(location.href).searchParams.get('temporary-chat') === 'true') return true;
  } catch {
    // A malformed host URL is not evidence of temporary mode.
  }
  const toggle = document.querySelector<HTMLElement>(CHATGPT_TEMP_TOGGLE_SELECTOR);
  if (!toggle) return false;
  const label =
    `${toggle.getAttribute('aria-label') || ''} ${toggle.textContent || ''}`.toLowerCase();
  const pressed = toggle.getAttribute('aria-pressed');
  return (
    pressed === 'true' ||
    label.includes('close temporary') ||
    label.includes('turn off temporary') ||
    label.includes('关闭临时') ||
    label.includes('關閉暫時')
  );
}

function turnContent(turn: ChatTurn, role: 'user' | 'assistant'): string {
  if (role === 'user') return (turn.userContent?.text || turn.user || '').trim();
  return (turn.assistantContent?.text || turn.assistant || '').trim();
}

export function buildHandoffTranscript(
  turns: readonly ChatTurn[],
  language: AppLanguage = 'en',
): string {
  const copy = getTemporaryHandoffCopy(language);
  const sections: string[] = [];
  for (const turn of turns) {
    const user = turnContent(turn, 'user');
    const assistant = turnContent(turn, 'assistant');
    if (user) sections.push(`## ${copy.userRole}\n\n${user}`);
    if (assistant) sections.push(`## ChatGPT\n\n${assistant}`);
  }
  return sections.join('\n\n');
}

export function buildHandoffBackup(
  transcript: string,
  draft: string | undefined,
  language: AppLanguage = 'en',
): string {
  if (!draft?.trim()) return transcript;
  const heading = `## ${getTemporaryHandoffCopy(language).unsentDraftHeading}`;
  return `${transcript}\n\n${heading}\n\n${draft}`;
}

function randomFilenameNonce(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 12);
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36))
      .join('')
      .slice(0, 12);
  } catch {
    fallbackFilenameSequence += 1;
    return fallbackFilenameSequence.toString(36).padStart(4, '0');
  }
}

export function createHandoffFilename(now = new Date(), nonce = randomFilenameNonce()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);
  const safeNonce = nonce.replace(/[^a-z0-9]/gi, '').slice(0, 12) || randomFilenameNonce();
  return `chatgpt-temporary-handoff-${timestamp}-${safeNonce}.md`;
}

export function planHandoff(
  turns: readonly ChatTurn[],
  language: AppLanguage = 'en',
  filename = createHandoffFilename(),
): HandoffPlan {
  const copy = getTemporaryHandoffCopy(language);
  const transcript = buildHandoffTranscript(turns, language);

  const delivery: HandoffDelivery =
    transcript.length <= INLINE_THRESHOLD
      ? {
          mode: 'inline',
          text: `${copy.handoffTitle}\n\n${copy.inlineInstruction}\n\n${copy.transcriptStart}\n\n${transcript}\n\n${copy.transcriptEnd}`,
        }
      : {
          mode: 'attachment',
          directive: `${copy.handoffTitle}\n\n${copy.attachmentInstruction}`,
          attachment: transcript,
          filename,
        };
  return { delivery, transcript, backupFilename: filename };
}

export function downloadHandoffBackup(transcript: string, filename: string): void {
  const blob = new Blob([transcript], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readAccountScope(): string {
  try {
    const routeAccount = /^\/u\/([^/]+)(?:\/|$)/.exec(new URL(location.href).pathname)?.[1];
    return routeAccount ? `route:${routeAccount}` : 'route:default';
  } catch {
    return 'route:default';
  }
}

function readHandoffRoute(): string {
  try {
    return new URL(location.href).pathname || '/';
  } catch {
    return '/';
  }
}

export function getChatGptNewChatPath(): string {
  try {
    const pathname = new URL(location.href).pathname;
    const customGpt = /^(\/u\/[^/]+)?\/g\/([^/]+)/.exec(pathname);
    if (customGpt) return `${customGpt[1] || ''}/g/${customGpt[2]}/`;
    const accountPrefix = /^\/u\/[^/]+/.exec(pathname)?.[0];
    return accountPrefix ? `${accountPrefix}/` : '/';
  } catch {
    return '/';
  }
}

function readPendingTabToken(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_HANDOFF_TAB_KEY);
    return token && /^[a-z0-9-]{4,80}$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

function pendingStorageKey(token: string): string {
  return `${PENDING_HANDOFF_STORAGE_PREFIX}${token}`;
}

function shouldSweepPendingHandoff(value: unknown, now: number): boolean {
  if (!value || typeof value !== 'object') return true;
  const storedAt = (value as Partial<PendingHandoff>).storedAt;
  return (
    typeof storedAt !== 'number' ||
    !Number.isFinite(storedAt) ||
    now - storedAt > PENDING_HANDOFF_TTL_MS ||
    storedAt > now + 5_000
  );
}

async function sweepExpiredPendingHandoffs(now = Date.now()): Promise<void> {
  const stored = await browser.storage.local.get();
  const expiredKeys = Object.entries(stored)
    .filter(
      ([key, value]) =>
        key.startsWith(PENDING_HANDOFF_STORAGE_PREFIX) && shouldSweepPendingHandoff(value, now),
    )
    .map(([key]) => key);
  if (expiredKeys.length > 0) await browser.storage.local.remove(expiredKeys);
}

function ensurePendingTabToken(): string {
  const existing = readPendingTabToken();
  if (existing) return existing;
  const token = `${Date.now().toString(36)}-${randomFilenameNonce()}`;
  sessionStorage.setItem(PENDING_HANDOFF_TAB_KEY, token);
  return token;
}

export async function discardPendingHandoff(): Promise<void> {
  const token = readPendingTabToken();
  deliveredPendingToken = null;
  try {
    sessionStorage.removeItem(PENDING_HANDOFF_TAB_KEY);
    // Remove the legacy page-owned payload left by earlier revisions of this PR.
    sessionStorage.removeItem(PENDING_HANDOFF_KEY);
  } catch {
    // Storage can be unavailable in locked-down browsing contexts.
  }
  if (!token) return;
  const storageKey = pendingStorageKey(token);
  let removed = false;
  try {
    await browser.storage.local.remove(storageKey);
    removed = true;
  } catch {
    // The tab token is already invalidated, so a later plugin lifecycle cannot replay it.
  }
  if (!removed) return;
  try {
    await browser.runtime.sendMessage({
      type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
      payload: { storageKey },
    });
  } catch {
    // A stale alarm only attempts to remove the already-deleted storage key.
  }
}

async function writePending(
  delivery: HandoffDelivery,
  accountScope: string,
  draft?: string,
): Promise<PendingHandoff> {
  try {
    deliveredPendingToken = null;
    await sweepExpiredPendingHandoffs();
    const token = ensurePendingTabToken();
    const storageKey = pendingStorageKey(token);
    const storedAt = Date.now();
    const pending = {
      delivery,
      ...(draft ? { draft } : {}),
      storedAt,
      accountScope,
    } satisfies PendingHandoff;
    await browser.storage.local.set({
      [storageKey]: pending,
    });
    const scheduled = (await browser.runtime.sendMessage({
      type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
      payload: { storageKey, expiresAt: storedAt + PENDING_HANDOFF_TTL_MS },
    })) as { ok?: unknown } | undefined;
    if (scheduled?.ok !== true) throw new Error('Unable to schedule pending handoff expiry');
    // Do not retain full transcripts written by earlier revisions in page storage.
    sessionStorage.removeItem(PENDING_HANDOFF_KEY);
    return pending;
  } catch (error) {
    await discardPendingHandoff();
    throw error;
  }
}

async function markPendingDelivered(pending: PendingHandoff): Promise<void> {
  const token = readPendingTabToken();
  if (!token) return;
  const storageKey = pendingStorageKey(token);
  try {
    const stored = await browser.storage.local.get(storageKey);
    const current = stored[storageKey] as Partial<PendingHandoff> | undefined;
    if (current?.storedAt !== pending.storedAt) return;
    await browser.storage.local.set({
      [storageKey]: { ...pending, deliveredRoute: readHandoffRoute() } satisfies PendingHandoff,
    });
    if (readPendingTabToken() === token) deliveredPendingToken = token;
  } catch {
    // Delivery already succeeded. Invalidate recovery rather than risk replaying it on another route.
    await discardPendingHandoff();
  }
}

async function readPending(): Promise<PendingHandoff | null> {
  try {
    const token = readPendingTabToken();
    if (!token) {
      sessionStorage.removeItem(PENDING_HANDOFF_KEY);
      return null;
    }
    const key = pendingStorageKey(token);
    const result = await browser.storage.local.get(key);
    const parsed = result[key] as Partial<PendingHandoff> | undefined;
    if (
      !parsed ||
      typeof parsed.storedAt !== 'number' ||
      !Number.isFinite(parsed.storedAt) ||
      typeof parsed.accountScope !== 'string' ||
      (parsed.draft !== undefined && typeof parsed.draft !== 'string') ||
      (parsed.deliveredRoute !== undefined && typeof parsed.deliveredRoute !== 'string') ||
      !parsed.delivery
    ) {
      await discardPendingHandoff();
      return null;
    }
    if (shouldSweepPendingHandoff(parsed, Date.now())) {
      await discardPendingHandoff();
      return null;
    }
    const delivery = parsed.delivery;
    const draft = parsed.draft;
    if (parsed.deliveredRoute) deliveredPendingToken = token;
    else if (deliveredPendingToken === token) deliveredPendingToken = null;
    if (delivery.mode === 'inline' && typeof delivery.text === 'string') {
      return {
        delivery,
        draft,
        storedAt: parsed.storedAt,
        accountScope: parsed.accountScope,
        deliveredRoute: parsed.deliveredRoute,
      };
    }
    if (
      delivery.mode === 'attachment' &&
      typeof delivery.directive === 'string' &&
      typeof delivery.attachment === 'string' &&
      typeof delivery.filename === 'string'
    ) {
      return {
        delivery,
        draft,
        storedAt: parsed.storedAt,
        accountScope: parsed.accountScope,
        deliveredRoute: parsed.deliveredRoute,
      };
    }
    await discardPendingHandoff();
    return null;
  } catch {
    await discardPendingHandoff();
    return null;
  }
}

export function discardDeliveredPendingHandoff(): void {
  const token = readPendingTabToken();
  if (!token || token !== deliveredPendingToken) return;
  cancelPendingHandoffRecovery();
}

export function cancelPendingHandoffRecovery(): void {
  if (internalNavigationClicks > 0) return;
  recoveryCancellationRevision += 1;
  if (activeHandoffOperations === 0) void discardPendingHandoff();
}

function clickForHandoffNavigation(target: HTMLElement): void {
  internalNavigationClicks += 1;
  try {
    target.click();
  } finally {
    internalNavigationClicks -= 1;
  }
}

function dispatchPaste(input: HTMLElement, text: string | null, file: File | null): boolean {
  if (typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') return false;
  try {
    const transfer = new DataTransfer();
    if (text) transfer.setData('text/plain', text);
    if (file) transfer.items.add(file);
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    const validText = !text || event.clipboardData?.getData('text/plain') === text;
    const validFile = !file || (event.clipboardData?.files.length ?? 0) > 0;
    if (!validText || !validFile) return false;
    input.focus();
    input.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

const COMPOSER_BLOCK_TAGS = new Set([
  'ADDRESS',
  'BLOCKQUOTE',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'P',
  'PRE',
]);

function readComposerDomText(root: HTMLElement): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    const block = COMPOSER_BLOCK_TAGS.has(node.tagName);
    if (block && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
    node.childNodes.forEach(visit);
    if (block && !parts[parts.length - 1]?.endsWith('\n')) parts.push('\n');
  };
  root.childNodes.forEach(visit);
  return parts.join('');
}

function readComposerText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
  return readComposerDomText(input);
}

function normalizeComposerText(text: string): string {
  return text
    .replace(/[\u200b\u00a0]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

function hasComposerSegment(input: HTMLElement, text: string): boolean {
  const existing = normalizeComposerText(readComposerText(input));
  const expected = normalizeComposerText(text);
  if (!expected) return true;
  return (
    existing === expected ||
    existing.startsWith(`${expected}\n`) ||
    existing.endsWith(`\n${expected}`) ||
    existing.includes(`\n${expected}\n`)
  );
}

function hasOrderedComposerSegments(input: HTMLElement, first: string, second: string): boolean {
  const existing = normalizeComposerText(readComposerText(input));
  const expectedFirst = normalizeComposerText(first);
  const expectedSecond = normalizeComposerText(second);
  if (!expectedSecond) return hasComposerSegment(input, first);
  const firstIndex = existing.indexOf(expectedFirst);
  if (firstIndex < 0) return false;
  const remainder = existing.slice(firstIndex + expectedFirst.length);
  const following = remainder.startsWith('\n') ? remainder.slice(1) : remainder;
  return following === expectedSecond || following.startsWith(`${expectedSecond}\n`);
}

type ComposerInsertionPlacement = 'start' | 'end';

function placeComposerCaret(input: HTMLElement, placement: ComposerInsertionPlacement): void {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const offset = placement === 'start' ? 0 : input.value.length;
    input.setSelectionRange(offset, offset);
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(placement === 'start');
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertComposerText(
  input: HTMLElement,
  text: string,
  placement: ComposerInsertionPlacement,
): boolean {
  input.focus();
  const existing = readComposerText(input).trim();
  placeComposerCaret(input, placement);
  const insertion = existing ? (placement === 'start' ? `${text}\n\n` : `\n\n${text}`) : text;
  if (!insertTextIntoChatInput(insertion, input)) return false;
  return hasComposerSegment(input, text);
}

function ensureComposerText(
  input: HTMLElement,
  text: string,
  placement: ComposerInsertionPlacement,
): boolean {
  if (hasComposerSegment(input, text)) return true;
  return insertComposerText(input, text, placement);
}

function hasAttachmentPreview(input: HTMLElement, filename: string): boolean {
  if (!input.isConnected) return false;
  const root = input.closest('form');
  if (!root?.isConnected) return false;
  const normalizedFilename = filename.trim().toLowerCase();
  if (!normalizedFilename) return false;

  const fileInputs = root.querySelectorAll<HTMLInputElement>('input[type="file"]');
  if (
    Array.from(fileInputs).some((fileInput) =>
      Array.from(fileInput.files || []).some(
        (candidate) => candidate.name.toLowerCase() === normalizedFilename,
      ),
    )
  ) {
    return true;
  }

  const labelledPreview = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-testid*="attachment" i], [data-testid*="file" i], [aria-label], [title]',
    ),
  ).some((candidate) => {
    const label =
      `${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`
        .trim()
        .toLowerCase();
    return label.includes(normalizedFilename);
  });
  return labelledPreview || (root.textContent || '').toLowerCase().includes(normalizedFilename);
}

export function hasCurrentComposerAttachments(): boolean {
  const input = currentComposer();
  const root = input?.closest('form');
  if (!root?.isConnected) return false;

  const fileInputs = root.querySelectorAll<HTMLInputElement>('input[type="file"]');
  if (Array.from(fileInputs).some((fileInput) => (fileInput.files?.length ?? 0) > 0)) return true;

  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-attachment-id], [data-file-id], [data-testid]'),
  ).some((candidate) => {
    if (candidate.matches('input, button, label, [hidden], [aria-hidden="true"]')) return false;
    if (candidate.hasAttribute('data-attachment-id') || candidate.hasAttribute('data-file-id')) {
      return true;
    }
    const testId = candidate.dataset.testid?.toLowerCase() || '';
    return (
      /(attachment|file)/.test(testId) && !/(add|button|input|menu|picker|upload)/.test(testId)
    );
  });
}

async function dispatchAttachmentAndVerify(
  scope: PluginScope,
  input: HTMLElement,
  file: File,
  isCancelled: () => boolean,
): Promise<HTMLElement | null> {
  if (isCancelled()) return null;
  if (hasAttachmentPreview(input, file.name)) return input;
  if (!dispatchPaste(input, null, file)) return null;
  if (isCancelled()) return null;
  const immediateComposer = currentComposer();
  if (immediateComposer && hasAttachmentPreview(immediateComposer, file.name)) {
    return immediateComposer;
  }

  const deadline = Date.now() + 1_200;
  while (Date.now() < deadline) {
    await wait(scope, 60);
    if (isCancelled()) return null;
    const liveComposer = currentComposer();
    if (liveComposer && hasAttachmentPreview(liveComposer, file.name)) return liveComposer;
  }
  return null;
}

async function deliverOnce(
  scope: PluginScope,
  input: HTMLElement,
  delivery: HandoffDelivery,
  draft?: string,
  isCancelled: () => boolean = () => false,
): Promise<HTMLElement | null> {
  if (isCancelled()) return null;
  let deliveryInput = input;
  let initialText = normalizeComposerText(readComposerText(deliveryInput));
  const expectedDraft = draft ? normalizeComposerText(draft) : '';
  let draftAlreadyPresent = expectedDraft.length > 0 && initialText === expectedDraft;
  let delivered: boolean;
  if (delivery.mode === 'inline') {
    delivered = ensureComposerText(
      deliveryInput,
      delivery.text,
      draftAlreadyPresent ? 'start' : 'end',
    );
  } else {
    const file = new File([delivery.attachment], delivery.filename, { type: 'text/markdown' });
    const liveInput = await dispatchAttachmentAndVerify(scope, deliveryInput, file, isCancelled);
    if (!liveInput) return null;
    if (isCancelled()) return null;
    deliveryInput = liveInput;
    initialText = normalizeComposerText(readComposerText(deliveryInput));
    draftAlreadyPresent = expectedDraft.length > 0 && initialText === expectedDraft;
    delivered = ensureComposerText(
      deliveryInput,
      delivery.directive,
      draftAlreadyPresent ? 'start' : 'end',
    );
  }

  const deliveryText = delivery.mode === 'inline' ? delivery.text : delivery.directive;
  const draftPreserved =
    !expectedDraft ||
    hasOrderedComposerSegments(deliveryInput, deliveryText, draft!) ||
    insertComposerText(deliveryInput, draft!, 'end');
  return delivered && draftPreserved && !isCancelled() ? deliveryInput : null;
}

function isDeliveryComplete(
  input: HTMLElement,
  delivery: HandoffDelivery,
  draft?: string,
): boolean {
  if (!input.isConnected) return false;
  const handoffPresent =
    delivery.mode === 'inline'
      ? hasComposerSegment(input, delivery.text)
      : hasAttachmentPreview(input, delivery.filename) &&
        hasComposerSegment(input, delivery.directive);
  if (!handoffPresent) return false;
  if (!draft?.trim()) return true;
  const deliveryText = delivery.mode === 'inline' ? delivery.text : delivery.directive;
  return hasOrderedComposerSegments(input, deliveryText, draft);
}

function isUsableComposer(candidate: HTMLElement): boolean {
  return (
    candidate.isConnected &&
    !candidate.matches('[hidden], [aria-hidden="true"], [aria-disabled="true"]') &&
    !candidate.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}

function pickComposer(candidates: readonly HTMLElement[]): HTMLElement | null {
  const usable = candidates.filter(isUsableComposer);
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const rect = usable[index].getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return usable[index];
  }
  return usable[usable.length - 1] || null;
}

function currentComposer(): HTMLElement | null {
  for (const selector of CHATGPT_COMPOSER_SELECTORS) {
    const candidate = pickComposer(Array.from(document.querySelectorAll<HTMLElement>(selector)));
    if (candidate) return candidate;
  }

  return pickComposer(
    Array.from(document.querySelectorAll<HTMLElement>(CHATGPT_GENERIC_COMPOSER_SELECTOR)).filter(
      (candidate) => candidate.closest('form')?.querySelector(CHATGPT_SEND_CONTROL_SELECTOR),
    ),
  );
}

async function findComposer(scope: PluginScope, timeoutMs: number): Promise<HTMLElement | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (scope.signal.aborted) return null;
    const input = currentComposer();
    if (input) return input;
    await wait(scope, 120);
  }
  return null;
}

async function waitForNormalComposer(
  scope: PluginScope,
  attempts: number,
): Promise<HTMLElement | null> {
  let previous: HTMLElement | null = null;
  let stableChecks = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isTemporaryChat()) {
      const composer = currentComposer();
      stableChecks = composer && composer === previous ? stableChecks + 1 : composer ? 1 : 0;
      previous = composer;
      if (composer && stableChecks >= 3) return composer;
    } else {
      previous = null;
      stableChecks = 0;
    }
    await wait(scope, 100);
  }
  return null;
}

export async function leaveTemporaryChat(scope: PluginScope): Promise<HTMLElement | null> {
  const toggle = document.querySelector<HTMLElement>(CHATGPT_TEMP_TOGGLE_SELECTOR);
  if (toggle) {
    clickForHandoffNavigation(toggle);
    const composer = await waitForNormalComposer(scope, 16);
    if (composer) return composer;
  }

  const newChat = document.querySelector<HTMLElement>(CHATGPT_NEW_CHAT_SELECTOR);
  const newChatPath = getChatGptNewChatPath();
  if (newChat && newChatPath === '/') clickForHandoffNavigation(newChat);
  else location.assign(newChatPath);

  return await waitForNormalComposer(scope, 30);
}

export async function handoffTemporaryChat(
  scope: PluginScope,
  delivery: HandoffDelivery,
  preservedDraft?: string,
): Promise<HandoffResult> {
  activeHandoffOperations += 1;
  const cancellationRevisionAtStart = recoveryCancellationRevision;
  const handoffWasCancelled = (): boolean =>
    cancellationRevisionAtStart !== recoveryCancellationRevision;
  let abortedByPageUnload = scope.signal.aborted && isHandoffPageUnloading();
  const rememberAbortReason = (): void => {
    abortedByPageUnload = isHandoffPageUnloading();
  };
  scope.signal.addEventListener('abort', rememberAbortReason, { once: true });
  try {
    const accountScope = readAccountScope();
    const temporaryComposer = currentComposer();
    const composerDraft =
      preservedDraft ?? (temporaryComposer ? readComposerText(temporaryComposer) : '');
    const pendingDraft = composerDraft.trim() ? composerDraft : undefined;
    let pending: PendingHandoff;
    try {
      pending = await writePending(delivery, accountScope, pendingDraft);
    } catch {
      return 'storage-failed';
    }
    if (handoffWasCancelled()) throw abortError();
    if (scope.signal.aborted) throw abortError();
    const input = await leaveTemporaryChat(scope);
    if (handoffWasCancelled()) throw abortError();
    if (!input) {
      if (!isTemporaryChat()) return 'composer-missing';
      await discardPendingHandoff();
      return 'leave-failed';
    }
    if (readAccountScope() !== accountScope) {
      await discardPendingHandoff();
      return 'account-mismatch';
    }
    if (scope.signal.aborted) throw abortError();
    const deliveredInput = await deliverOnce(
      scope,
      input,
      delivery,
      pendingDraft,
      handoffWasCancelled,
    );
    if (handoffWasCancelled()) throw abortError();
    if (!deliveredInput || !isDeliveryComplete(deliveredInput, delivery, pendingDraft)) {
      return 'delivery-failed';
    }
    await markPendingDelivered(pending);
    if (handoffWasCancelled()) throw abortError();
    return 'ready';
  } catch (error) {
    if (isAbortError(error) && !abortedByPageUnload) await discardPendingHandoff();
    throw error;
  } finally {
    scope.signal.removeEventListener('abort', rememberAbortReason);
    activeHandoffOperations -= 1;
  }
}

export async function pendingAttachmentPreviewReady(): Promise<boolean> {
  const pending = await readPending();
  if (!pending || pending.delivery.mode !== 'attachment' || isTemporaryChat()) return false;
  const input = currentComposer();
  return !!input && hasAttachmentPreview(input, pending.delivery.filename);
}

export async function resumePendingHandoff(scope: PluginScope): Promise<PendingHandoffResult> {
  const recoveryRevisionAtStart = recoveryCancellationRevision;
  const recoveryWasCancelled = (): boolean =>
    recoveryRevisionAtStart !== recoveryCancellationRevision;
  let abortedByPageUnload = scope.signal.aborted && isHandoffPageUnloading();
  const rememberAbortReason = (): void => {
    abortedByPageUnload = isHandoffPageUnloading();
  };
  scope.signal.addEventListener('abort', rememberAbortReason, { once: true });
  try {
    while (activeHandoffOperations > 0) {
      if (scope.signal.aborted) throw abortError();
      if (recoveryWasCancelled()) return null;
      await wait(scope, 120);
    }
    if (scope.signal.aborted) throw abortError();
    if (recoveryWasCancelled()) return null;
    const pending = await readPending();
    if (recoveryWasCancelled()) return null;
    if (!pending) return null;
    if (
      Date.now() - pending.storedAt > PENDING_HANDOFF_TTL_MS ||
      pending.storedAt > Date.now() + 5_000
    ) {
      await discardPendingHandoff();
      return null;
    }
    if (pending.accountScope !== readAccountScope()) {
      await discardPendingHandoff();
      return 'account-mismatch';
    }
    if (pending.deliveredRoute && pending.deliveredRoute !== readHandoffRoute()) {
      await discardPendingHandoff();
      return null;
    }
    if (isTemporaryChat()) return null;
    const input = await findComposer(scope, 6_000);
    if (recoveryWasCancelled()) return null;
    if (!input) return null;
    if (pending.deliveredRoute && isDeliveryComplete(input, pending.delivery, pending.draft)) {
      return null;
    }
    if (scope.signal.aborted) throw abortError();
    if (recoveryWasCancelled()) return null;
    const deliveredInput = await deliverOnce(
      scope,
      input,
      pending.delivery,
      pending.draft,
      recoveryWasCancelled,
    );
    if (recoveryWasCancelled()) return null;
    if (!deliveredInput || !isDeliveryComplete(deliveredInput, pending.delivery, pending.draft)) {
      return 'delivery-failed';
    }
    await markPendingDelivered(pending);
    return pending.deliveredRoute ? null : 'ready';
  } catch (error) {
    if (isAbortError(error) && !abortedByPageUnload) await discardPendingHandoff();
    throw error;
  } finally {
    scope.signal.removeEventListener('abort', rememberAbortReason);
  }
}

export function readCurrentComposerDraft(): string | undefined {
  const input = currentComposer();
  if (!input) return undefined;
  const draft = readComposerText(input);
  return draft.trim() ? draft : undefined;
}
