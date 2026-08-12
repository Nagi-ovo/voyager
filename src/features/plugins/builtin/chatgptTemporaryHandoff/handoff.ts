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
  | 'account-mismatch';

export type PendingHandoffResult = 'ready' | 'delivery-failed' | 'account-mismatch' | null;

export const CHATGPT_TEMP_TOGGLE_SELECTOR = [
  '[data-testid="temporary-chat-toggle"]',
  'button[aria-label*="temporary chat" i]',
  'button[aria-label*="临时聊天"]',
  'button[aria-label*="暫時聊天"]',
].join(',');
const COMPOSER_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
const NEW_CHAT_SELECTOR =
  'a[data-testid="create-new-chat-button"], a[href="/"][data-testid*="new" i]';
export const PENDING_HANDOFF_KEY = 'gv-chatgpt-temporary-handoff-pending';
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

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_HANDOFF_KEY);
  } catch {
    // Storage can be unavailable in locked-down browsing contexts.
  }
}

function writePending(delivery: HandoffDelivery, accountScope: string): void {
  sessionStorage.setItem(
    PENDING_HANDOFF_KEY,
    JSON.stringify({ delivery, storedAt: Date.now(), accountScope } satisfies PendingHandoff),
  );
}

function readPending(): PendingHandoff | null {
  try {
    const raw = sessionStorage.getItem(PENDING_HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (
      typeof parsed.storedAt !== 'number' ||
      !Number.isFinite(parsed.storedAt) ||
      typeof parsed.accountScope !== 'string' ||
      !parsed.delivery
    ) {
      clearPending();
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
    clearPending();
    return null;
  } catch {
    clearPending();
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

function readComposerText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
  return input.textContent || '';
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
  return (
    insertTextIntoChatInput(existing ? `\n\n${text}` : text, input) &&
    readComposerText(input).includes(text)
  );
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

function currentComposer(excluded?: HTMLElement): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)).find(
      (candidate) => candidate !== excluded,
    ) || null
  );
}

async function findComposer(
  scope: PluginScope,
  timeoutMs: number,
  excluded?: HTMLElement,
): Promise<HTMLElement | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (scope.signal.aborted) return null;
    const input = currentComposer(excluded);
    if (input) return input;
    await wait(scope, 120);
  }
  return null;
}

export async function leaveTemporaryChat(scope: PluginScope): Promise<HTMLElement | null> {
  const temporaryComposer = currentComposer() || undefined;
  const toggle = document.querySelector<HTMLElement>(CHATGPT_TEMP_TOGGLE_SELECTOR);
  if (toggle) {
    toggle.click();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (!isTemporaryChat()) {
        const replacement = currentComposer(temporaryComposer);
        if (replacement) return replacement;
      }
      await wait(scope, 100);
    }
  }

  const newChat = document.querySelector<HTMLElement>(NEW_CHAT_SELECTOR);
  const newChatPath = getChatGptNewChatPath();
  if (newChat && newChatPath === '/') newChat.click();
  else location.assign(newChatPath);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isTemporaryChat()) {
      const replacement = currentComposer(temporaryComposer);
      if (replacement) return replacement;
    }
    await wait(scope, 100);
  }
  return null;
}

export async function handoffTemporaryChat(
  scope: PluginScope,
  delivery: HandoffDelivery,
): Promise<HandoffResult> {
  activeHandoffOperations += 1;
  try {
    const accountScope = readAccountScope();
    try {
      writePending(delivery, accountScope);
    } catch {
      // The live same-page path still works without the reload safety net.
    }
    const input = await leaveTemporaryChat(scope);
    if (!input) {
      if (!isTemporaryChat()) return 'composer-missing';
      clearPending();
      return 'leave-failed';
    }
    if (readAccountScope() !== accountScope) {
      clearPending();
      return 'account-mismatch';
    }
    const delivered = await deliver(scope, input, delivery);
    if (!delivered) return 'delivery-failed';
    clearPending();
    return 'ready';
  } catch (error) {
    if (isAbortError(error)) clearPending();
    throw error;
  } finally {
    activeHandoffOperations -= 1;
  }
}

export async function resumePendingHandoff(scope: PluginScope): Promise<PendingHandoffResult> {
  while (activeHandoffOperations > 0) {
    if (scope.signal.aborted) return null;
    await wait(scope, 120);
  }
  const pending = readPending();
  if (!pending) return null;
  if (Date.now() - pending.storedAt > PENDING_TTL_MS || pending.storedAt > Date.now() + 5_000) {
    clearPending();
    return null;
  }
  if (pending.accountScope !== readAccountScope()) {
    clearPending();
    return 'account-mismatch';
  }
  if (isTemporaryChat()) return null;
  const input = await findComposer(scope, 6_000);
  if (!input) return null;
  const delivered = await deliver(scope, input, pending.delivery);
  if (!delivered) return 'delivery-failed';
  clearPending();
  return 'ready';
}
