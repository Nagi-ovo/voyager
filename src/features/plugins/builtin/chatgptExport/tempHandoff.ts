import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';

import type { ChatGptMessageSnapshot } from './conversation';
import { extractSnapshotMarkdown } from './conversation';

export type HandoffDelivery =
  | { readonly mode: 'inline'; readonly text: string }
  | {
      readonly mode: 'attachment';
      readonly directive: string;
      readonly attachment: string;
      readonly filename: string;
    };

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

const TEMP_TOGGLE_SELECTOR = [
  '[data-testid="temporary-chat-toggle"]',
  'button[aria-label*="temporary chat" i]',
  'button[aria-label*="临时聊天"]',
  'button[aria-label*="暫時聊天"]',
].join(',');
const COMPOSER_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
const NEW_CHAT_SELECTOR =
  'a[data-testid="create-new-chat-button"], a[href="/"][data-testid*="new" i]';
const PENDING_KEY = 'gv-chatgpt-export-pending-handoff';
const PENDING_TTL_MS = 60_000;
const INLINE_THRESHOLD = 5_000;
let activeHandoffOperations = 0;

function wait(scope: PluginScope, ms: number): Promise<void> {
  if (scope.signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    let stopTimer: Dispose | null = null;
    let stopAbort: Dispose | null = null;
    const settle = (action: () => void): void => {
      void stopTimer?.();
      void stopAbort?.();
      action();
    };
    stopTimer = scope.timer(() => settle(resolve), ms);
    stopAbort = scope.on(scope.signal, 'abort', () =>
      settle(() => reject(new DOMException('Cancelled', 'AbortError'))),
    );
  });
}

export function isTemporaryChat(): boolean {
  try {
    if (new URL(location.href).searchParams.get('temporary-chat') === 'true') return true;
  } catch {
    // A malformed host URL is not evidence of temporary mode.
  }
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
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

export function buildHandoffTranscript(messages: readonly ChatGptMessageSnapshot[]): string {
  return messages
    .map((message) => {
      const heading = message.role === 'user' ? '## User' : '## ChatGPT';
      const content = extractSnapshotMarkdown(message).trim() || '_(empty message)_';
      return `${heading}\n\n${content}`;
    })
    .join('\n\n');
}

export function planHandoff(messages: readonly ChatGptMessageSnapshot[]): HandoffDelivery {
  const transcript = buildHandoffTranscript(messages);
  const chinese = /^zh(?:-|_|$)/i.test(navigator.language);
  const title = chinese ? '[从临时对话继续]' : '[Continue from a temporary chat]';
  const inlineInstruction = chinese
    ? '下面是刚才临时对话的完整记录。请把它当作当前对话的既有上下文，保持原来的语气、约束和任务状态，从最后一条消息自然继续。'
    : 'The complete temporary-chat transcript follows. Treat it as the existing context for this chat, preserve its tone, constraints and task state, and continue naturally from the last message.';
  const attachmentInstruction = chinese
    ? '已附上刚才临时对话的 Markdown 记录。请先完整读取附件，把它当作当前对话的既有上下文，再从最后一条消息自然继续。'
    : 'The attached Markdown file contains the complete temporary chat. Read it first, treat it as the existing context, and continue naturally from its final message.';

  if (transcript.length <= INLINE_THRESHOLD) {
    return {
      mode: 'inline',
      text: `${title}\n\n${inlineInstruction}\n\n--- TRANSCRIPT START ---\n\n${transcript}\n\n--- TRANSCRIPT END ---`,
    };
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    mode: 'attachment',
    directive: `${title}\n\n${attachmentInstruction}`,
    attachment: transcript,
    filename: `chatgpt-temporary-handoff-${stamp}.md`,
  };
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

function writePending(delivery: HandoffDelivery, accountScope: string): void {
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ delivery, storedAt: Date.now(), accountScope } satisfies PendingHandoff),
  );
}

function readPending(): PendingHandoff | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (
      typeof parsed.storedAt !== 'number' ||
      typeof parsed.accountScope !== 'string' ||
      !parsed.delivery
    ) {
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
    return null;
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage can be unavailable in locked-down browsing contexts.
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

function insertComposerText(input: HTMLElement, text: string): boolean {
  input.focus();
  const inserted = document.execCommand?.('insertText', false, text) === true;
  if (inserted && readComposerText(input).includes(text)) {
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
    return true;
  }

  const existing = readComposerText(input).trim();
  const next = existing ? `${existing}\n\n${text}` : text;
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) input.value = next;
  else input.textContent = next;
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
  );
  return readComposerText(input).includes(text);
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

async function dispatchAttachmentAndVerify(input: HTMLElement, file: File): Promise<boolean> {
  const alreadyVisible = hasAttachmentPreview(input, file.name);
  if (!dispatchPaste(input, null, file)) return false;
  if (!alreadyVisible && hasAttachmentPreview(input, file.name)) return true;

  const deadline = Date.now() + 1_200;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    if (!alreadyVisible && hasAttachmentPreview(input, file.name)) return true;
  }
  return false;
}

async function deliver(input: HTMLElement, delivery: HandoffDelivery): Promise<boolean> {
  if (delivery.mode === 'inline') {
    return insertComposerText(input, delivery.text);
  }
  const file = new File([delivery.attachment], delivery.filename, { type: 'text/markdown' });
  if (!(await dispatchAttachmentAndVerify(input, file))) return false;
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
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
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
      clearPending();
      return 'leave-failed';
    }
    if (readAccountScope() !== accountScope) {
      clearPending();
      return 'account-mismatch';
    }
    const delivered = await deliver(input, delivery);
    if (!delivered) return 'delivery-failed';
    clearPending();
    return 'ready';
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
  if (Date.now() - pending.storedAt > PENDING_TTL_MS) {
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
  const delivered = await deliver(input, pending.delivery);
  if (!delivered) return 'delivery-failed';
  clearPending();
  return 'ready';
}
