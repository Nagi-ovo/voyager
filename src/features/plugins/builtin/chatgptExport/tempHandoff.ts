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
}

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

function writePending(delivery: HandoffDelivery): void {
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ delivery, storedAt: Date.now() } satisfies PendingHandoff),
  );
}

function readPending(): PendingHandoff | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (typeof parsed.storedAt !== 'number' || !parsed.delivery) return null;
    const delivery = parsed.delivery;
    if (delivery.mode === 'inline' && typeof delivery.text === 'string') {
      return { delivery, storedAt: parsed.storedAt };
    }
    if (
      delivery.mode === 'attachment' &&
      typeof delivery.directive === 'string' &&
      typeof delivery.attachment === 'string' &&
      typeof delivery.filename === 'string'
    ) {
      return { delivery, storedAt: parsed.storedAt };
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

function insertComposerText(input: HTMLElement, text: string): void {
  input.focus();
  if (dispatchPaste(input, text, null)) return;
  const inserted = document.execCommand?.('insertText', false, text) === true;
  if (!inserted) input.textContent = text;
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
  );
}

async function deliver(input: HTMLElement, delivery: HandoffDelivery): Promise<void> {
  if (delivery.mode === 'inline') {
    insertComposerText(input, delivery.text);
    return;
  }
  insertComposerText(input, delivery.directive);
  const file = new File([delivery.attachment], delivery.filename, { type: 'text/markdown' });
  if (dispatchPaste(input, null, file)) return;
  input.replaceChildren();
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  insertComposerText(input, `${delivery.directive}\n\n${delivery.attachment}`);
}

async function findComposer(scope: PluginScope, timeoutMs: number): Promise<HTMLElement | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (scope.signal.aborted) return null;
    const input = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (input) return input;
    await wait(scope, 120);
  }
  return null;
}

export async function leaveTemporaryChat(scope: PluginScope): Promise<boolean> {
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
  if (toggle) {
    toggle.click();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (!isTemporaryChat()) return true;
      await wait(scope, 100);
    }
  }

  const newChat = document.querySelector<HTMLElement>(NEW_CHAT_SELECTOR);
  if (newChat) newChat.click();
  else location.assign('/');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isTemporaryChat() && document.querySelector(COMPOSER_SELECTOR)) return true;
    await wait(scope, 100);
  }
  return !isTemporaryChat();
}

export async function handoffTemporaryChat(
  scope: PluginScope,
  delivery: HandoffDelivery,
): Promise<'ready' | 'leave-failed' | 'composer-missing'> {
  try {
    writePending(delivery);
  } catch {
    // The live same-page path still works without the reload safety net.
  }
  const left = await leaveTemporaryChat(scope);
  if (!left) {
    clearPending();
    return 'leave-failed';
  }
  const input = await findComposer(scope, 6_000);
  if (!input) return 'composer-missing';
  await deliver(input, delivery);
  clearPending();
  return 'ready';
}

export async function resumePendingHandoff(scope: PluginScope): Promise<boolean> {
  const pending = readPending();
  if (!pending) return false;
  if (Date.now() - pending.storedAt > PENDING_TTL_MS) {
    clearPending();
    return false;
  }
  if (isTemporaryChat()) return false;
  const input = await findComposer(scope, 6_000);
  if (!input) return false;
  await deliver(input, pending.delivery);
  clearPending();
  return true;
}
