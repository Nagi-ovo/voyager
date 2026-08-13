import browser from 'webextension-polyfill';

import type { ChatTurn } from '@/features/export/types/export';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { insertTextIntoChatInput } from '@/pages/content/chatInput';
import type { AppLanguage } from '@/utils/language';

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
  readonly storedAt: number;
  readonly accountScope: string;
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
const CHATGPT_SEND_CONTROL_SELECTOR = [
  'button[data-testid="send-button"]',
  'button[data-testid="composer-submit-button"]',
].join(',');
export const CHATGPT_COMPOSER_SELECTOR = [
  ...CHATGPT_COMPOSER_SELECTORS,
  CHATGPT_GENERIC_COMPOSER_SELECTOR,
].join(',');
const NEW_CHAT_SELECTOR =
  'a[data-testid="create-new-chat-button"], a[href="/"][data-testid*="new" i]';
export const PENDING_HANDOFF_KEY = 'gv-chatgpt-temporary-handoff-pending';
export const PENDING_HANDOFF_TAB_KEY = 'gv-chatgpt-temporary-handoff-tab';
const PENDING_TTL_MS = 60_000;
const INLINE_THRESHOLD = 5_000;
let activeHandoffOperations = 0;
let fallbackFilenameSequence = 0;

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

export function buildHandoffTranscript(turns: readonly ChatTurn[]): string {
  const sections: string[] = [];
  for (const turn of turns) {
    const user = turnContent(turn, 'user');
    const assistant = turnContent(turn, 'assistant');
    if (user) sections.push(`## User\n\n${user}`);
    if (assistant) sections.push(`## ChatGPT\n\n${assistant}`);
  }
  return sections.join('\n\n');
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
  const transcript = buildHandoffTranscript(turns);
  const chinese = language === 'zh' || language === 'zh_TW';
  const title = chinese ? '[从临时对话继续]' : '[Continue from a temporary chat]';
  const inlineInstruction = chinese
    ? '下面是刚才临时对话的完整记录。请把它当作当前对话的既有上下文，保持原来的语气、约束和任务状态，从最后一条消息自然继续。'
    : 'The complete temporary-chat transcript follows. Treat it as the existing context for this chat, preserve its tone, constraints and task state, and continue naturally from the last message.';
  const attachmentInstruction = chinese
    ? '已附上刚才临时对话的 Markdown 记录。请先完整读取附件，把它当作当前对话的既有上下文，再从最后一条消息自然继续。'
    : 'The attached Markdown file contains the complete temporary chat. Read it first, treat it as the existing context, and continue naturally from its final message.';

  const delivery: HandoffDelivery =
    transcript.length <= INLINE_THRESHOLD
      ? {
          mode: 'inline',
          text: `${title}\n\n${inlineInstruction}\n\n--- TRANSCRIPT START ---\n\n${transcript}\n\n--- TRANSCRIPT END ---`,
        }
      : {
          mode: 'attachment',
          directive: `${title}\n\n${attachmentInstruction}`,
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

export function getChatGptNewChatPath(): string {
  try {
    const accountPrefix = /^\/u\/[^/]+/.exec(new URL(location.href).pathname)?.[0];
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
  return `${PENDING_HANDOFF_KEY}:${token}`;
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
  try {
    sessionStorage.removeItem(PENDING_HANDOFF_TAB_KEY);
    // Remove the legacy page-owned payload left by earlier revisions of this PR.
    sessionStorage.removeItem(PENDING_HANDOFF_KEY);
  } catch {
    // Storage can be unavailable in locked-down browsing contexts.
  }
  if (!token) return;
  try {
    await browser.storage.local.remove(pendingStorageKey(token));
  } catch {
    // The tab token is already invalidated, so a later plugin lifecycle cannot replay it.
  }
}

async function writePending(delivery: HandoffDelivery, accountScope: string): Promise<void> {
  const token = ensurePendingTabToken();
  try {
    await browser.storage.local.set({
      [pendingStorageKey(token)]: {
        delivery,
        storedAt: Date.now(),
        accountScope,
      } satisfies PendingHandoff,
    });
    // Do not retain full transcripts written by earlier revisions in page storage.
    sessionStorage.removeItem(PENDING_HANDOFF_KEY);
  } catch (error) {
    await discardPendingHandoff();
    throw error;
  }
}

async function readPending(): Promise<PendingHandoff | null> {
  const token = readPendingTabToken();
  if (!token) {
    try {
      sessionStorage.removeItem(PENDING_HANDOFF_KEY);
    } catch {
      // Best-effort legacy cleanup only.
    }
    return null;
  }
  try {
    const key = pendingStorageKey(token);
    const result = await browser.storage.local.get(key);
    const parsed = result[key] as Partial<PendingHandoff> | undefined;
    if (
      !parsed ||
      typeof parsed.storedAt !== 'number' ||
      !Number.isFinite(parsed.storedAt) ||
      typeof parsed.accountScope !== 'string' ||
      !parsed.delivery
    ) {
      await discardPendingHandoff();
      return null;
    }
    const delivery = parsed.delivery;
    if (delivery.mode === 'inline' && typeof delivery.text === 'string') {
      return { delivery, storedAt: parsed.storedAt, accountScope: parsed.accountScope };
    }
    if (
      delivery.mode === 'attachment' &&
      typeof delivery.directive === 'string' &&
      typeof delivery.attachment === 'string' &&
      typeof delivery.filename === 'string'
    ) {
      return { delivery, storedAt: parsed.storedAt, accountScope: parsed.accountScope };
    }
    await discardPendingHandoff();
    return null;
  } catch {
    await discardPendingHandoff();
    return null;
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
    .replace(/\s+/g, ' ')
    .trim();
}

function placeComposerCaretAtEnd(input: HTMLElement): void {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertComposerText(input: HTMLElement, text: string): boolean {
  input.focus();
  const existing = readComposerText(input).trim();
  placeComposerCaretAtEnd(input);
  if (!insertTextIntoChatInput(existing ? `\n\n${text}` : text, input)) return false;
  const expected = normalizeComposerText(text);
  return expected.length > 0 && normalizeComposerText(readComposerText(input)).includes(expected);
}

function hasAttachmentPreview(input: HTMLElement, filename: string): boolean {
  const root = input.closest('form') || document.body;
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

async function dispatchAttachmentAndVerify(
  scope: PluginScope,
  input: HTMLElement,
  file: File,
): Promise<boolean> {
  if (hasAttachmentPreview(input, file.name)) return true;
  if (!dispatchPaste(input, null, file)) return false;
  if (hasAttachmentPreview(input, file.name)) return true;

  const deadline = Date.now() + 1_200;
  while (Date.now() < deadline) {
    await wait(scope, 60);
    if (hasAttachmentPreview(input, file.name)) return true;
  }
  return false;
}

async function deliver(
  scope: PluginScope,
  input: HTMLElement,
  delivery: HandoffDelivery,
): Promise<boolean> {
  if (delivery.mode === 'inline') return insertComposerText(input, delivery.text);
  const file = new File([delivery.attachment], delivery.filename, { type: 'text/markdown' });
  if (!(await dispatchAttachmentAndVerify(scope, input, file))) return false;
  return insertComposerText(input, delivery.directive);
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
    toggle.click();
    const composer = await waitForNormalComposer(scope, 16);
    if (composer) return composer;
  }

  const newChat = document.querySelector<HTMLElement>(NEW_CHAT_SELECTOR);
  const newChatPath = getChatGptNewChatPath();
  if (newChat && newChatPath === '/') newChat.click();
  else location.assign(newChatPath);

  return await waitForNormalComposer(scope, 30);
}

export async function handoffTemporaryChat(
  scope: PluginScope,
  delivery: HandoffDelivery,
): Promise<HandoffResult> {
  activeHandoffOperations += 1;
  try {
    const accountScope = readAccountScope();
    try {
      await writePending(delivery, accountScope);
    } catch {
      return 'storage-failed';
    }
    if (scope.signal.aborted) throw abortError();
    const input = await leaveTemporaryChat(scope);
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
    const delivered = await deliver(scope, input, delivery);
    if (!delivered) return 'delivery-failed';
    await discardPendingHandoff();
    return 'ready';
  } catch (error) {
    if (isAbortError(error)) await discardPendingHandoff();
    throw error;
  } finally {
    activeHandoffOperations -= 1;
  }
}

export async function resumePendingHandoff(scope: PluginScope): Promise<PendingHandoffResult> {
  try {
    while (activeHandoffOperations > 0) {
      if (scope.signal.aborted) throw abortError();
      await wait(scope, 120);
    }
    if (scope.signal.aborted) throw abortError();
    const pending = await readPending();
    if (!pending) return null;
    if (Date.now() - pending.storedAt > PENDING_TTL_MS || pending.storedAt > Date.now() + 5_000) {
      await discardPendingHandoff();
      return null;
    }
    if (pending.accountScope !== readAccountScope()) {
      await discardPendingHandoff();
      return 'account-mismatch';
    }
    if (isTemporaryChat()) return null;
    const input = await findComposer(scope, 6_000);
    if (!input) return null;
    if (scope.signal.aborted) throw abortError();
    const delivered = await deliver(scope, input, pending.delivery);
    if (!delivered) return 'delivery-failed';
    await discardPendingHandoff();
    return 'ready';
  } catch (error) {
    if (isAbortError(error)) await discardPendingHandoff();
    throw error;
  }
}
