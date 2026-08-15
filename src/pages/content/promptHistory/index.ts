/**
 * Prompt History Module (#923)
 *
 * Saves the user's prompts into a local history whenever they send a new
 * prompt or edit a previous one — regardless of whether Gemini actually
 * processes the request. Gemini can swallow prompts on error (e.g. offline),
 * so this feature guarantees the user can recover them afterwards.
 *
 * - Detects "send" via click/submit on the send button + input going
 *   non-empty → empty (same mechanism as draftSave).
 * - Detects "edit" via clicking an edit/update action on a previous turn.
 * - Renders a floating trigger + panel to browse, copy, or re-insert
 *   recorded prompts.
 *
 * ARCHITECTURE mirrors draftSave: listeners only exist while enabled, storage
 * changes re-arm the feature dynamically, and everything is torn down on
 * cleanup.
 */
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { getTranslationSync } from '@/utils/i18n';

import { insertTextIntoChatInput, findChatInput } from '../chatInput/index';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';
import { stripInstructionBlock } from '../folderProject/instructionBlock';
import { watchRouteChanges } from '../utils/routeWatcher';
import {
  addPromptHistory,
  clearPromptHistory,
  getPromptHistory,
  removePromptHistoryItem,
  type PromptHistoryItem,
} from './storage';

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = '[PromptHistory]';

/** Interval to detect that a message was sent (ms). */
const SEND_CHECK_INTERVAL_MS = 1000;

/** Keep a send intent only long enough to cover SPA navigation. */
const SEND_INTENT_TIMEOUT_MS = 2000;

const SEND_BUTTON_SELECTOR = [
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[data-tooltip*="Send"]',
  'button[data-tooltip*="send"]',
  '[data-send-button]',
  '.send-button',
].join(', ');

/** Selectors for the "edit previous prompt" / "update" action buttons. */
const EDIT_BUTTON_SELECTOR = [
  'button[aria-label*="Edit"]',
  'button[aria-label*="edit"]',
  'button[aria-label*="Update"]',
  'button[aria-label*="update"]',
  'button[data-tooltip*="Edit"]',
  '[data-edit-button]',
].join(', ');

const INPUT_SELECTORS = [
  'rich-textarea [contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  '.input-area textarea',
  'textarea[placeholder*="Ask"]',
] as const;

// ============================================================================
// State
// ============================================================================

let isEnabled = false;
let observer: MutationObserver | null = null;
let sendCheckTimer: ReturnType<typeof setInterval> | null = null;
let stopRouteWatcher: (() => void) | null = null;
let currentPath = '';
let lastCapturedPath = '';
let sendIntentTimer: number | null = null;
let pendingSendPath: string | null = null;
let sendIntentListener: ((event: Event) => void) | null = null;
let clickIntentListener: ((event: Event) => void) | null = null;
let inputListener: ((event: Event) => void) | null = null;
let attachedInput: HTMLElement | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let trigger: HTMLButtonElement | null = null;
let panel: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelOpen = false;
let panelCleanup: (() => void) | null = null;

// ============================================================================
// Helpers
// ============================================================================

function getConversationPath(): string {
  return window.location.pathname;
}

function findChatInputEl(): HTMLElement | null {
  for (const selector of INPUT_SELECTORS) {
    const els = document.querySelectorAll(selector);
    for (const el of Array.from(els)) {
      if (el.getBoundingClientRect().height > 0) {
        return el as HTMLElement;
      }
    }
  }
  return null;
}

function getInputText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement) {
    return input.value;
  }
  return input.innerText ?? input.textContent ?? '';
}

function isInputEffectivelyEmpty(input: HTMLElement): boolean {
  const text = getInputText(input).trim();
  if (text.length === 0) return true;

  const richTextarea = input.closest('rich-textarea');
  const placeholders = [
    input.getAttribute('data-placeholder'),
    input.getAttribute('aria-placeholder'),
    input.getAttribute('placeholder'),
    richTextarea?.getAttribute('data-placeholder'),
    richTextarea?.getAttribute('aria-placeholder'),
    richTextarea?.getAttribute('placeholder'),
  ].filter((v): v is string => Boolean(v));

  return placeholders.some((p) => p.trim() === text);
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function copyText(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    return new Promise<void>((resolve) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {}
      ta.remove();
      resolve();
    });
  }
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================================================
// Capture logic
// ============================================================================

function capturePrompt(content: string, type: 'sent' | 'edited'): void {
  const path = getConversationPath();
  const cleaned = stripInstructionBlock(content).trim();
  if (!cleaned) return;
  lastCapturedPath = path;
  void addPromptHistory(cleaned, type, path);
}

function clearSendIntent(): void {
  pendingSendPath = null;
  if (sendIntentTimer !== null) {
    window.clearTimeout(sendIntentTimer);
    sendIntentTimer = null;
  }
}

function markSendIntent(): void {
  pendingSendPath = getConversationPath();
  if (sendIntentTimer !== null) window.clearTimeout(sendIntentTimer);
  sendIntentTimer = window.setTimeout(clearSendIntent, SEND_INTENT_TIMEOUT_MS);
}

function handleInputChange(input: HTMLElement): void {
  const content = stripInstructionBlock(getInputText(input)).trim();
  if (!content && pendingSendPath) {
    const sentPath = pendingSendPath;
    clearSendIntent();
    return;
  }
  pendingSendPath = null;
}

// ============================================================================
// Send / Edit detection
// ============================================================================

function startSendDetection(): void {
  if (sendCheckTimer) return;

  let wasNonEmpty = false;
  let observedPath = currentPath || getConversationPath();

  sendCheckTimer = setInterval(() => {
    const path = getConversationPath();
    if (path !== observedPath) {
      observedPath = path;
      wasNonEmpty = false;
      return;
    }

    const input = findChatInputEl();
    if (!input) return;

    const empty = isInputEffectivelyEmpty(input);

    if (wasNonEmpty && empty) {
      // Input went from non-empty to empty — a message was sent.
      const content = lastInputContent;
      if (content) {
        capturePrompt(content, 'sent');
      }
      lastInputContent = '';
      clearSendIntent();
      wasNonEmpty = false;
    } else if (!empty) {
      lastInputContent = getInputText(input);
      wasNonEmpty = true;
    }
  }, SEND_CHECK_INTERVAL_MS);
}

function stopSendDetection(): void {
  if (sendCheckTimer) {
    clearInterval(sendCheckTimer);
    sendCheckTimer = null;
  }
}

function startSendIntentDetection(): void {
  if (sendIntentListener) return;

  sendIntentListener = (event) => {
    if (event.type === 'submit') {
      const form = event.target;
      if (form instanceof HTMLFormElement && attachedInput && form.contains(attachedInput)) {
        const content = getInputText(attachedInput);
        if (content.trim()) {
          capturePrompt(content, 'sent');
          lastInputContent = '';
        }
        markSendIntent();
      }
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest(SEND_BUTTON_SELECTOR);
    if (!button || !attachedInput) return;

    const composer = button.closest('form, .text-input-field, ms-prompt-input-wrapper');
    if (!composer || composer.contains(attachedInput)) {
      const content = getInputText(attachedInput);
      if (content.trim()) {
        capturePrompt(content, 'sent');
        lastInputContent = '';
      }
      markSendIntent();
    }
  };

  document.addEventListener('click', sendIntentListener, true);
  document.addEventListener('submit', sendIntentListener, true);
}

function stopSendIntentDetection(): void {
  if (sendIntentListener) {
    document.removeEventListener('click', sendIntentListener, true);
    document.removeEventListener('submit', sendIntentListener, true);
    sendIntentListener = null;
  }
  clearSendIntent();
}

function startEditDetection(): void {
  if (clickIntentListener) return;

  clickIntentListener = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const editBtn = target.closest(EDIT_BUTTON_SELECTOR);
    if (!editBtn) return;

    // Find the user prompt text near the edit button.
    const turn = editBtn.closest(
      'user-query, .user-query-bubble-with-background, [data-message-author-role="user"], model-response',
    );
    if (!turn) return;
    const content = turn.textContent ?? '';
    if (content.trim()) {
      capturePrompt(content, 'edited');
    }
  };

  document.addEventListener('click', clickIntentListener, true);
}

function stopEditDetection(): void {
  if (clickIntentListener) {
    document.removeEventListener('click', clickIntentListener, true);
    clickIntentListener = null;
  }
}

// ============================================================================
// Input monitoring
// ============================================================================

let lastInputContent = '';

function attachInputListener(input: HTMLElement): void {
  if (attachedInput === input) return;
  detachInputListener();

  inputListener = () => handleInputChange(input);
  input.addEventListener('input', inputListener, { capture: true });
  attachedInput = input;
}

function detachInputListener(): void {
  if (attachedInput && inputListener) {
    attachedInput.removeEventListener('input', inputListener, { capture: true });
  }
  attachedInput = null;
  inputListener = null;
}

function setupObserver(): void {
  if (observer) return;

  observer = new MutationObserver(() => {
    const input = findChatInputEl();
    if (input) {
      attachInputListener(input);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function disconnectObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ============================================================================
// Panel UI
// ============================================================================

function getTriggerPosition(): { right: number; top: number } {
  const right = 18;
  const top = 80;
  return { right, top };
}

function renderHistoryList(): void {
  const list = listEl;
  if (!list) return;
  void getPromptHistory().then((items) => {
    list.innerHTML = '';
    if (items.length === 0) {
      const empty = createEl('div', 'gv-ph-empty');
      empty.textContent = getTranslationSync('promptHistoryEmpty');
      list.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
      const row = createEl('div', 'gv-ph-item');

      const meta = createEl('div', 'gv-ph-item-meta');
      const badge = createEl('span', `gv-ph-badge gv-ph-badge-${item.type}`);
      badge.textContent =
        item.type === 'sent'
          ? getTranslationSync('promptHistorySent')
          : getTranslationSync('promptHistoryEdited');
      const time = createEl('span', 'gv-ph-time');
      time.textContent = formatTime(item.timestamp);
      meta.append(badge, time);

      const text = createEl('div', 'gv-ph-item-text');
      text.textContent = item.content;

      const actions = createEl('div', 'gv-ph-item-actions');
      const copyBtn = createEl('button', 'gv-ph-action');
      copyBtn.textContent = getTranslationSync('promptHistoryCopy');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void copyText(item.content).then(() =>
          setNotice(getTranslationSync('promptHistoryCopied'), 'ok'),
        );
      });

      const insertBtn = createEl('button', 'gv-ph-action gv-ph-action-primary');
      insertBtn.textContent = getTranslationSync('promptHistoryInsert');
      insertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandInputCollapseIfNeeded();
        if (insertTextIntoChatInput(item.content)) {
          setNotice(getTranslationSync('promptHistoryInserted'), 'ok');
          closePanel();
        } else {
          setNotice(getTranslationSync('promptHistoryInsertFailed'), 'error');
        }
      });

      const delBtn = createEl('button', 'gv-ph-action gv-ph-action-danger');
      delBtn.textContent = getTranslationSync('promptHistoryDelete');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void removePromptHistoryItem(item.id).then(() => renderHistoryList());
      });

      actions.append(copyBtn, insertBtn, delBtn);
      row.append(meta, text, actions);
      frag.appendChild(row);
    }
    list.appendChild(frag);
  });
}

function setNotice(message: string, kind: 'ok' | 'error'): void {
  if (!panel) return;
  let notice = panel.querySelector<HTMLDivElement>('.gv-ph-notice');
  if (!notice) {
    notice = createEl('div', 'gv-ph-notice');
    panel.appendChild(notice);
  }
  notice.textContent = message;
  notice.className = `gv-ph-notice gv-ph-notice-${kind}`;
  window.clearTimeout((notice as HTMLDivElement & { _t?: number })._t);
  (notice as HTMLDivElement & { _t?: number })._t = window.setTimeout(() => {
    notice?.remove();
  }, 1600);
}

function closePanel(): void {
  if (!panel) return;
  panelOpen = false;
  panel.classList.add('gv-hidden');
}

function togglePanel(): void {
  if (!panel) return;
  panelOpen = !panelOpen;
  panel.classList.toggle('gv-hidden', !panelOpen);
  if (panelOpen) {
    renderHistoryList();
  }
}

function setupPanel(): void {
  if (panelCleanup) return;

  const id = 'gv-ph-root';
  if (document.getElementById(id)) return;

  trigger = createEl('button', 'gv-ph-trigger');
  trigger.id = id;
  trigger.setAttribute('aria-label', 'Prompt History');
  const icon = document.createElement('span');
  icon.className = 'gv-ph-trigger-icon';
  icon.textContent = '🕘';
  trigger.appendChild(icon);
  const pos = getTriggerPosition();
  trigger.style.right = `${pos.right}px`;
  trigger.style.top = `${pos.top}px`;
  document.body.appendChild(trigger);

  panel = createEl('div', 'gv-ph-panel gv-hidden');
  panel.setAttribute('role', 'dialog');

  const header = createEl('div', 'gv-ph-header');
  const title = createEl('div', 'gv-ph-title');
  title.textContent = getTranslationSync('promptHistoryTitle');
  const clearBtn = createEl('button', 'gv-ph-action');
  clearBtn.textContent = getTranslationSync('promptHistoryClear');
  clearBtn.addEventListener('click', () => {
    void clearPromptHistory().then(() => renderHistoryList());
  });
  header.append(title, clearBtn);

  listEl = createEl('div', 'gv-ph-list');

  panel.append(header, listEl);
  document.body.appendChild(panel);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });

  const onPointerDown = (ev: PointerEvent) => {
    if (!panelOpen) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.gv-ph-panel')) return;
    if (target.closest('.gv-ph-trigger')) return;
    closePanel();
  };
  window.addEventListener('pointerdown', onPointerDown, { capture: true });

  const onKeyDown = (ev: Event) => {
    if (!panelOpen) return;
    if ((ev as KeyboardEvent).key !== 'Escape') return;
    closePanel();
  };
  window.addEventListener('keydown', onKeyDown, { passive: true });

  panelCleanup = () => {
    window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    window.removeEventListener('keydown', onKeyDown);
    trigger?.remove();
    panel?.remove();
    trigger = null;
    panel = null;
    listEl = null;
    panelOpen = false;
  };
}

function teardownPanel(): void {
  panelCleanup?.();
  panelCleanup = null;
}

// ============================================================================
// Feature enable / disable
// ============================================================================

function enableFeature(): void {
  if (isEnabled) return;

  isEnabled = true;
  currentPath = getConversationPath();
  lastInputContent = '';

  const input = findChatInputEl();
  if (input) {
    attachInputListener(input);
  }

  setupObserver();
  startSendDetection();
  startSendIntentDetection();
  startEditDetection();
  setupPanel();

  // Re-render the panel content whenever history changes from any tab.
  chrome.storage?.onChanged?.addListener(handleHistoryStorageChange);
}

function handleHistoryStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== 'local') return;
  if (!(StorageKeys.PROMPT_HISTORY_ITEMS in changes)) return;
  if (panelOpen) {
    renderHistoryList();
  }
}

function disableFeature(): void {
  if (!isEnabled) return;

  isEnabled = false;

  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {}
    storageListener = null;
  }

  try {
    chrome.storage?.onChanged?.removeListener(handleHistoryStorageChange);
  } catch {}

  detachInputListener();
  disconnectObserver();
  stopSendDetection();
  stopSendIntentDetection();
  stopEditDetection();
  teardownPanel();
  pendingSendPath = null;
  lastInputContent = '';
}

function startUrlWatcher(): void {
  if (stopRouteWatcher) return;

  currentPath = getConversationPath();

  stopRouteWatcher = watchRouteChanges(() => {
    const newPath = getConversationPath();
    if (newPath !== currentPath) {
      currentPath = newPath;
      lastInputContent = '';
      clearSendIntent();
    }
  });
}

function stopUrlWatcher(): void {
  stopRouteWatcher?.();
  stopRouteWatcher = null;
}

// ============================================================================
// Settings
// ============================================================================

async function loadEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.sync?.get) {
        resolve(false);
        return;
      }
      chrome.storage.sync.get({ [StorageKeys.PROMPT_HISTORY_ENABLED]: true }, (result) => {
        resolve(result?.[StorageKeys.PROMPT_HISTORY_ENABLED] !== false);
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        resolve(false);
        return;
      }
      console.warn(LOG_PREFIX, 'Failed to load settings:', error);
      resolve(false);
    }
  });
}

function setupStorageListener(): void {
  if (storageListener) return;

  storageListener = (changes, areaName) => {
    if (areaName !== 'sync') return;
    if (!(StorageKeys.PROMPT_HISTORY_ENABLED in changes)) return;

    const newValue = changes[StorageKeys.PROMPT_HISTORY_ENABLED].newValue === true;

    if (newValue && !isEnabled) {
      enableFeature();
    } else if (!newValue && isEnabled) {
      disableFeature();
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.warn(LOG_PREFIX, 'Failed to setup storage listener:', error);
  }
}

function cleanup(): void {
  disableFeature();

  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {}
    storageListener = null;
  }
  stopUrlWatcher();
}

// ============================================================================
// Public API
// ============================================================================

export async function startPromptHistory(): Promise<() => void> {
  setupStorageListener();
  startUrlWatcher();

  const enabled = await loadEnabled();
  if (enabled) {
    enableFeature();
  }

  return cleanup;
}
