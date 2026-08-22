/**
 * Prompt History (#923)
 *
 * Captures the user's current composer text at the send/update intent, before
 * Gemini can clear or swallow it. The feature is opt-in and keeps all runtime
 * listeners removable so it can be disabled and re-enabled without a reload.
 */
import { LoggerService } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { getTranslationSync } from '@/utils/i18n';

import { findChatInput, insertTextIntoChatInput } from '../chatInput/index';
import { stripInstructionBlockPreservingWhitespace } from '../folderProject/instructionBlock';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';
import {
  findClosestSendActionButton,
  findInputForSendActionButton,
  isSendKeyboardEvent,
  isUpdateActionButton,
} from '../sendBehavior/sendButton';
import { watchRouteChanges } from '../utils/routeWatcher';
import {
  type PromptHistoryItem,
  type PromptHistoryType,
  addPromptHistory,
  clearPromptHistory,
  getPromptHistory,
  getPromptHistoryAccountScope,
  isPromptHistoryStorageKeyForAccount,
  removePromptHistoryItem,
} from './storage';

const logger = LoggerService.getInstance().createChild('PromptHistory');
const ROOT_ID = 'gv-ph-root';
const PANEL_ID = 'gv-ph-panel';
const TITLE_ID = 'gv-ph-title';
const CONFIRM_CLASS = 'gv-ph-confirm';
const CAPTURE_DEDUPLICATION_WINDOW_MS = 10_000;
const PROMPT_INPUT_SELECTOR = '[contenteditable="true"], textarea';
const EDIT_CONTAINER_SELECTOR = 'chat-message, .query-content.edit-mode, .edit-container';
const MAIN_COMPOSER_SELECTOR =
  '.text-input-field, .input-area, ms-prompt-input-wrapper, ms-prompt-input, ms-chat-turn-input';
const VOYAGER_UI_SELECTOR = '.gv-ph-panel, .gv-pm-panel, .gv-pm-confirm, [role="dialog"]';

let isEnabled = false;
let ctrlEnterSendEnabled = false;
let enabledSettingRevision = 0;
let ctrlEnterSettingRevision = 0;
let stopRouteWatcher: (() => void) | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let clickListener: ((event: MouseEvent) => void) | null = null;
let submitListener: ((event: SubmitEvent) => void) | null = null;
let keydownListener: ((event: KeyboardEvent) => void) | null = null;
let trigger: HTMLButtonElement | null = null;
let panel: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let panelOpen = false;
let panelCleanup: (() => void) | null = null;
let confirmCleanup: ((restoreFocus?: boolean) => void) | null = null;
let globalNoticeTimer: number | null = null;
let renderRevision = 0;
const recentCaptures = new Map<string, number>();

function getConversationPath(): string {
  return window.location.pathname;
}

function getCurrentAccountScope(): string {
  return getPromptHistoryAccountScope(getConversationPath());
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function readInputText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement) return input.value;
  return input.innerText ?? input.textContent ?? '';
}

function isVoyagerInput(input: HTMLElement): boolean {
  return Boolean(input.closest(VOYAGER_UI_SELECTOR));
}

function isPromptInput(input: HTMLElement): boolean {
  if (isVoyagerInput(input)) return false;
  if (input.closest(EDIT_CONTAINER_SELECTOR)) return true;
  if (input.closest(MAIN_COMPOSER_SELECTOR)) return true;
  return findChatInput({ requireVisible: false }) === input;
}

function promptTypeForInput(input: HTMLElement): PromptHistoryType {
  return input.closest(EDIT_CONTAINER_SELECTOR) ? 'edited' : 'sent';
}

function inputFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const input = target.closest<HTMLElement>(PROMPT_INPUT_SELECTOR);
  return input && isPromptInput(input) ? input : null;
}

function findFormPromptInput(form: HTMLFormElement): HTMLElement | null {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    form.contains(active) &&
    active.matches(PROMPT_INPUT_SELECTOR) &&
    isPromptInput(active)
  ) {
    return active;
  }
  return (
    Array.from(form.querySelectorAll<HTMLElement>(PROMPT_INPUT_SELECTOR)).find(isPromptInput) ??
    null
  );
}

function showGlobalStorageError(): void {
  let notice = document.querySelector<HTMLDivElement>('.gv-ph-global-notice');
  if (!notice) {
    notice = createEl('div', 'gv-ph-global-notice');
    notice.setAttribute('role', 'alert');
    document.body.appendChild(notice);
  }
  notice.textContent = getTranslationSync('promptHistoryStorageFailed');
  if (globalNoticeTimer !== null) window.clearTimeout(globalNoticeTimer);
  globalNoticeTimer = window.setTimeout(() => {
    notice?.remove();
    globalNoticeTimer = null;
  }, 5000);
}

function reportStorageError(error: unknown): void {
  if (isExtensionContextInvalidatedError(error)) return;
  logger.warn('Prompt history storage operation failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  if (panelOpen) {
    setNotice(getTranslationSync('promptHistoryStorageFailed'), 'error');
  } else {
    showGlobalStorageError();
  }
}

function capturePrompt(input: HTMLElement, type = promptTypeForInput(input)): void {
  const content = stripInstructionBlockPreservingWhitespace(readInputText(input)).trim();
  if (!content) return;
  const path = getConversationPath();
  const accountScope = getPromptHistoryAccountScope(path);
  const fingerprint = `${accountScope}\u0000${path}\u0000${type}\u0000${content}`;
  const now = Date.now();
  const previousCapture = recentCaptures.get(fingerprint);
  if (
    previousCapture !== undefined &&
    now - previousCapture >= 0 &&
    now - previousCapture < CAPTURE_DEDUPLICATION_WINDOW_MS
  ) {
    return;
  }
  recentCaptures.set(fingerprint, now);
  for (const [key, timestamp] of recentCaptures) {
    if (now - timestamp >= CAPTURE_DEDUPLICATION_WINDOW_MS) recentCaptures.delete(key);
  }
  void addPromptHistory(content, type, path, accountScope).catch((error) => {
    if (recentCaptures.get(fingerprint) === now) recentCaptures.delete(fingerprint);
    reportStorageError(error);
  });
}

function startCaptureListeners(): void {
  if (clickListener || submitListener || keydownListener) return;

  clickListener = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? findClosestSendActionButton(target) : null;
    if (!button) return;
    const input = findInputForSendActionButton(button);
    if (!input || !isPromptInput(input)) return;
    capturePrompt(input, isUpdateActionButton(button) ? 'edited' : promptTypeForInput(input));
  };

  submitListener = (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    const input = findFormPromptInput(form);
    if (!input) return;
    const submitter = event.submitter;
    const type =
      submitter instanceof HTMLButtonElement && isUpdateActionButton(submitter)
        ? 'edited'
        : promptTypeForInput(input);
    capturePrompt(input, type);
  };

  keydownListener = (event) => {
    if (!isSendKeyboardEvent(event, ctrlEnterSendEnabled)) return;
    const input = inputFromTarget(event.target);
    if (input) capturePrompt(input);
  };

  document.addEventListener('click', clickListener, true);
  document.addEventListener('submit', submitListener, true);
  document.addEventListener('keydown', keydownListener, true);
}

function stopCaptureListeners(): void {
  if (clickListener) document.removeEventListener('click', clickListener, true);
  if (submitListener) document.removeEventListener('submit', submitListener, true);
  if (keydownListener) document.removeEventListener('keydown', keydownListener, true);
  clickListener = null;
  submitListener = null;
  keydownListener = null;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected');
    } finally {
      textarea.remove();
    }
  }
}

function formatTime(timestamp: number): string {
  const locale = document.documentElement.lang || chrome.i18n?.getUILanguage?.() || undefined;
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function setNotice(message: string, kind: 'ok' | 'error'): void {
  if (!panel) return;
  let notice = panel.querySelector<HTMLDivElement>('.gv-ph-notice');
  if (!notice) {
    notice = createEl('div', 'gv-ph-notice');
    panel.appendChild(notice);
  }
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  notice.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  notice.textContent = message;
  notice.className = `gv-ph-notice gv-ph-notice-${kind}`;
  window.clearTimeout((notice as HTMLDivElement & { _t?: number })._t);
  (notice as HTMLDivElement & { _t?: number })._t = window.setTimeout(() => {
    notice?.remove();
  }, 2000);
}

function renderHistoryItems(items: PromptHistoryItem[]): void {
  const list = listEl;
  if (!list) return;
  list.replaceChildren();
  if (items.length === 0) {
    const empty = createEl('div', 'gv-ph-empty');
    empty.textContent = getTranslationSync('promptHistoryEmpty');
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const row = createEl('article', 'gv-ph-item');
    const meta = createEl('div', 'gv-ph-item-meta');
    const badge = createEl('span', `gv-ph-badge gv-ph-badge-${item.type}`);
    badge.textContent = getTranslationSync(
      item.type === 'sent' ? 'promptHistorySent' : 'promptHistoryEdited',
    );
    const time = createEl('time', 'gv-ph-time');
    time.dateTime = new Date(item.timestamp).toISOString();
    time.textContent = formatTime(item.timestamp);
    meta.append(badge, time);

    const text = createEl('div', 'gv-ph-item-text');
    text.textContent = item.content;

    const actions = createEl('div', 'gv-ph-item-actions');
    const copyButton = createEl('button', 'gv-ph-action');
    copyButton.type = 'button';
    copyButton.textContent = getTranslationSync('promptHistoryCopy');
    copyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void copyText(item.content)
        .then(() => setNotice(getTranslationSync('promptHistoryCopied'), 'ok'))
        .catch(() => setNotice(getTranslationSync('promptHistoryCopyFailed'), 'error'));
    });

    const insertButton = createEl('button', 'gv-ph-action gv-ph-action-primary');
    insertButton.type = 'button';
    insertButton.textContent = getTranslationSync('promptHistoryInsert');
    insertButton.addEventListener('click', (event) => {
      event.stopPropagation();
      expandInputCollapseIfNeeded();
      if (insertTextIntoChatInput(item.content)) {
        setNotice(getTranslationSync('promptHistoryInserted'), 'ok');
        closePanel(false);
      } else {
        setNotice(getTranslationSync('promptHistoryInsertFailed'), 'error');
      }
    });

    const deleteButton = createEl('button', 'gv-ph-action gv-ph-action-danger');
    deleteButton.type = 'button';
    deleteButton.textContent = getTranslationSync('promptHistoryDelete');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void removePromptHistoryItem(item.id, item.accountScope)
        .then(() => renderHistoryList())
        .catch(reportStorageError);
    });

    actions.append(copyButton, insertButton, deleteButton);
    row.append(meta, text, actions);
    fragment.appendChild(row);
  });
  list.appendChild(fragment);
}

function renderHistoryList(): void {
  const list = listEl;
  if (!list) return;
  const revision = ++renderRevision;
  const accountScope = getCurrentAccountScope();
  list.setAttribute('aria-busy', 'true');
  void getPromptHistory(accountScope)
    .then((items) => {
      if (revision !== renderRevision || accountScope !== getCurrentAccountScope()) return;
      renderHistoryItems(items);
    })
    .catch(reportStorageError)
    .finally(() => {
      if (revision === renderRevision) list.removeAttribute('aria-busy');
    });
}

function closePanel(restoreFocus = false): void {
  if (!panel) return;
  confirmCleanup?.(false);
  panelOpen = false;
  panel.classList.add('gv-hidden');
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

function openPanel(): void {
  if (!panel) return;
  panelOpen = true;
  panel.classList.remove('gv-hidden');
  trigger?.setAttribute('aria-expanded', 'true');
  renderHistoryList();
  panel.focus();
}

function togglePanel(): void {
  if (panelOpen) closePanel(true);
  else openPanel();
}

function showClearConfirmation(anchor: HTMLButtonElement): void {
  if (document.body.querySelector('.gv-pm-confirm')) return;
  const accountScope = getCurrentAccountScope();
  const confirm = createEl('div', `gv-pm-confirm ${CONFIRM_CLASS}`);
  confirm.setAttribute('role', 'alertdialog');
  confirm.setAttribute('aria-modal', 'true');
  const message = createEl('span');
  message.id = 'gv-ph-clear-confirm-message';
  message.textContent = getTranslationSync('promptHistoryClearConfirm');
  confirm.setAttribute('aria-labelledby', message.id);
  const yes = createEl('button', 'gv-pm-confirm-yes');
  yes.type = 'button';
  yes.textContent = getTranslationSync('promptHistoryClear');
  const no = createEl('button');
  no.type = 'button';
  no.textContent = getTranslationSync('promptHistoryCancel');
  confirm.append(message, yes, no);
  document.body.appendChild(confirm);

  const anchorRect = anchor.getBoundingClientRect();
  const width = confirm.offsetWidth || 240;
  const height = confirm.offsetHeight || 40;
  const side: 'left' | 'right' =
    anchorRect.right + width + 10 > window.innerWidth ? 'left' : 'right';
  const rawLeft = side === 'right' ? anchorRect.right + 10 : anchorRect.left - width - 10;
  const left = Math.min(Math.max(8, rawLeft), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(
    Math.max(8, anchorRect.top - 6),
    Math.max(8, window.innerHeight - height - 8),
  );
  confirm.style.top = `${top}px`;
  confirm.style.left = `${left}px`;
  confirm.setAttribute('data-side', side);

  const cleanupConfirm = (restoreFocus = true) => {
    confirm.remove();
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('keydown', onKeyDown);
    confirmCleanup = null;
    if (restoreFocus) anchor.focus();
  };
  const onOutside = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(`.${CONFIRM_CLASS}`)) cleanupConfirm();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      cleanupConfirm();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [yes, no];
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + buttons.length) % buttons.length
      : (currentIndex + 1) % buttons.length;
    event.preventDefault();
    buttons[nextIndex].focus();
  };
  confirmCleanup = cleanupConfirm;
  window.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('keydown', onKeyDown);

  no.addEventListener('click', (event) => {
    event.stopPropagation();
    cleanupConfirm();
  });
  yes.addEventListener('click', (event) => {
    event.stopPropagation();
    yes.disabled = true;
    no.disabled = true;
    void clearPromptHistory(accountScope)
      .then(() => {
        cleanupConfirm(false);
        if (accountScope === getCurrentAccountScope()) renderHistoryList();
      })
      .catch((error) => {
        yes.disabled = false;
        no.disabled = false;
        reportStorageError(error);
      });
  });
  no.focus();
}

function setupPanel(): void {
  if (panelCleanup || document.getElementById(ROOT_ID)) return;

  trigger = createEl('button', 'gv-ph-trigger');
  trigger.id = ROOT_ID;
  trigger.type = 'button';
  trigger.setAttribute('aria-label', getTranslationSync('promptHistoryTitle'));
  trigger.setAttribute('aria-controls', PANEL_ID);
  trigger.setAttribute('aria-expanded', 'false');
  const icon = createEl('span', 'gv-ph-trigger-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🕘';
  trigger.appendChild(icon);

  panel = createEl('div', 'gv-ph-panel gv-hidden');
  panel.id = PANEL_ID;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', TITLE_ID);

  const header = createEl('div', 'gv-ph-header');
  const title = createEl('h2', 'gv-ph-title');
  title.id = TITLE_ID;
  title.textContent = getTranslationSync('promptHistoryTitle');
  const clearButton = createEl('button', 'gv-ph-action');
  clearButton.type = 'button';
  clearButton.textContent = getTranslationSync('promptHistoryClear');
  clearButton.addEventListener('click', () => showClearConfirmation(clearButton));
  header.append(title, clearButton);

  listEl = createEl('div', 'gv-ph-list');
  panel.append(header, listEl);
  document.body.append(trigger, panel);

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePanel();
  });

  const onPointerDown = (event: PointerEvent) => {
    if (!panelOpen) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.gv-ph-panel, .gv-ph-trigger, .gv-pm-confirm')) return;
    closePanel(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!panelOpen || event.key !== 'Escape' || confirmCleanup) return;
    closePanel(true);
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown);

  panelCleanup = () => {
    confirmCleanup?.(false);
    window.removeEventListener('pointerdown', onPointerDown, true);
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

function enableFeature(): void {
  if (isEnabled) return;
  isEnabled = true;
  startCaptureListeners();
  setupPanel();
}

function disableFeature(): void {
  if (!isEnabled) return;
  isEnabled = false;
  stopCaptureListeners();
  teardownPanel();
  recentCaptures.clear();
  renderRevision++;
}

function reconcileEnabled(enabled: boolean): void {
  if (enabled) enableFeature();
  else disableFeature();
}

function startUrlWatcher(): void {
  if (stopRouteWatcher) return;
  let currentPath = getConversationPath();
  stopRouteWatcher = watchRouteChanges(() => {
    const nextPath = getConversationPath();
    if (nextPath === currentPath) return;
    const previousScope = getPromptHistoryAccountScope(currentPath);
    const nextScope = getPromptHistoryAccountScope(nextPath);
    currentPath = nextPath;
    renderRevision++;
    if (previousScope !== nextScope) closePanel(false);
    else if (panelOpen) renderHistoryList();
  });
}

function loadSettings(): Promise<{ enabled: boolean; ctrlEnterSendEnabled: boolean }> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.sync?.get) {
        resolve({ enabled: false, ctrlEnterSendEnabled: false });
        return;
      }
      chrome.storage.sync.get(
        {
          [StorageKeys.PROMPT_HISTORY_ENABLED]: false,
          [StorageKeys.CTRL_ENTER_SEND]: false,
        },
        (result) => {
          const error = chrome.runtime?.lastError;
          if (error) {
            logger.warn('Failed to load prompt history settings', { message: error.message });
            resolve({ enabled: false, ctrlEnterSendEnabled: false });
            return;
          }
          resolve({
            enabled: result?.[StorageKeys.PROMPT_HISTORY_ENABLED] === true,
            ctrlEnterSendEnabled: result?.[StorageKeys.CTRL_ENTER_SEND] === true,
          });
        },
      );
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) {
        logger.warn('Failed to load prompt history settings', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      resolve({ enabled: false, ctrlEnterSendEnabled: false });
    }
  });
}

function setupStorageListener(): void {
  if (storageListener) return;
  storageListener = (changes, areaName) => {
    if (areaName === 'sync') {
      if (StorageKeys.CTRL_ENTER_SEND in changes) {
        ctrlEnterSettingRevision++;
        ctrlEnterSendEnabled = changes[StorageKeys.CTRL_ENTER_SEND].newValue === true;
      }
      if (StorageKeys.PROMPT_HISTORY_ENABLED in changes) {
        enabledSettingRevision++;
        reconcileEnabled(changes[StorageKeys.PROMPT_HISTORY_ENABLED].newValue === true);
      }
      return;
    }
    if (areaName !== 'local' || !panelOpen) return;
    const accountScope = getCurrentAccountScope();
    if (
      Object.keys(changes).some((key) => isPromptHistoryStorageKeyForAccount(key, accountScope))
    ) {
      renderHistoryList();
    }
  };
  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('Failed to listen for prompt history settings', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function cleanup(): void {
  disableFeature();
  stopRouteWatcher?.();
  stopRouteWatcher = null;
  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {}
    storageListener = null;
  }
  if (globalNoticeTimer !== null) window.clearTimeout(globalNoticeTimer);
  globalNoticeTimer = null;
  document.querySelector('.gv-ph-global-notice')?.remove();
  ctrlEnterSendEnabled = false;
  enabledSettingRevision = 0;
  ctrlEnterSettingRevision = 0;
}

export async function startPromptHistory(): Promise<() => void> {
  setupStorageListener();
  startUrlWatcher();
  const enabledRevisionBeforeLoad = enabledSettingRevision;
  const ctrlEnterRevisionBeforeLoad = ctrlEnterSettingRevision;
  const settings = await loadSettings();
  if (ctrlEnterRevisionBeforeLoad === ctrlEnterSettingRevision) {
    ctrlEnterSendEnabled = settings.ctrlEnterSendEnabled;
  }
  if (enabledRevisionBeforeLoad === enabledSettingRevision) {
    reconcileEnabled(settings.enabled);
  }
  return cleanup;
}
