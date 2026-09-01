import { StorageKeys } from '@/core/types/common';
import { getVoyagerBuildTarget } from '@/core/utils/browser';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { getAssistantTurnSelectors } from '@/core/utils/selectors';

import { ResponseCompletionDetector } from './detector';

const LOG_PREFIX = '[ResponseNotification]';
const PAGE_OBSERVER_SOURCE = 'gemini-voyager-response-complete-observer';
const PAGE_OBSERVER_SCRIPT_ID = 'gv-response-complete-observer-script';
const FOREGROUND_TOAST_ID = 'gv-response-complete-toast';
const FOREGROUND_TOAST_TEXT_KEY = 'responseCompleteForegroundToast';
const FOREGROUND_TOAST_TEXT_FALLBACK = 'New response completed';
const FOREGROUND_TOAST_TRANSFORM_HIDDEN = 'translate(-50%, 10px)';
const FOREGROUND_TOAST_TRANSFORM_VISIBLE = 'translate(-50%, 0)';
const FOREGROUND_TOAST_DEFAULT_BOTTOM_PX = 148;
const FOREGROUND_TOAST_MIN_EDGE_GAP_PX = 24;
const FOREGROUND_TOAST_BOTTOM_GAP_FROM_PROMPT_PX = 22;
const FOREGROUND_TOAST_MIN_BOTTOM_PX = 96;
const FOREGROUND_TOAST_Z_INDEX = '2147483647';
const FOREGROUND_TOAST_MIN_WIDTH_PX = 150;
const FOREGROUND_TOAST_MAX_WIDTH_PX = 280;
const FOREGROUND_TOAST_MAX_VIEWPORT_WIDTH_PERCENT = 78;
const EVALUATE_DEBOUNCE_MS = 250;
const STARTUP_DELAY_MS = 1000;
const FOREGROUND_TOAST_VISIBLE_MS = 3200;
const MAX_FINGERPRINT_TEXT_LENGTH = 400;
const MAX_NOTIFICATION_TITLE_LENGTH = 80;
const MAX_NOTIFICATION_PROMPT_LENGTH = 140;
const LATEST_RESPONSE_VISIBLE_MARGIN_PX = 96;
const BOTTOM_SCROLL_THRESHOLD_PX = 160;
const PROMPT_SELECTORS = 'rich-textarea, textarea, [contenteditable="true"], div[role="textbox"]';
// Anchored to the start, so it only strips leading invisible characters and can
// never split an emoji sequence in the label body.
const TURN_LABEL_PREFIXES =
  // oxlint-disable-next-line no-misleading-character-class
  /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]*(?:you said|you wrote|user message|your prompt|you asked)[:\s]*/i;
const VISUALLY_HIDDEN_CLASS_FRAGMENT = 'visually-hidden';
const INJECTED_UI_SELECTOR = '.gv-fork-btn, .gv-fork-confirm, .gv-fork-indicator-group';
const PROMPT_CONTAINER_MAX_PARENT_DEPTH = 10;
const PROMPT_CONTAINER_MIN_WIDTH_PX = 280;
const PROMPT_CONTAINER_MIN_HEIGHT_PX = 44;
const PROMPT_CONTAINER_MAX_HEIGHT_PX = 260;
const PROMPT_CONTAINER_VIEWPORT_BOTTOM_TOLERANCE_PX = 8;
const PROMPT_CONTAINER_BOTTOM_TARGET_OFFSET_PX = 72;
const PROMPT_CONTAINER_WIDTH_SCORE_LIMIT_PX = 900;
const PROMPT_CONTAINER_WIDTH_SCORE_DIVISOR = 10;
const PROMPT_CONTAINER_BORDER_RADIUS_SCORE_LIMIT_PX = 36;
const PROMPT_CONTAINER_BORDER_RADIUS_SCORE_MULTIPLIER = 4;
const PROMPT_CONTAINER_BOTTOM_SCORE_BASE = 220;
const PROMPT_CONTAINER_DEPTH_PENALTY_MULTIPLIER = 8;
const PROMPT_CONTAINER_FULL_WIDTH_RATIO = 0.95;
const PROMPT_CONTAINER_FULL_WIDTH_PENALTY = 180;
const COMPLETION_ACTION_MAX_PARENT_DEPTH = 4;

const GENERATING_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '.mat-mdc-progress-spinner',
  '.mat-progress-spinner',
  'button[aria-label*="Stop"]',
  'button[aria-label*="Cancel"]',
  'button[aria-label*="停止"]',
  'button[aria-label*="取消"]',
  'button[data-test-id*="stop"]',
  'button[data-test-id*="cancel"]',
] as const;

const COMPLETION_ACTION_SELECTORS = [
  '[data-test-id="copy-button"]',
  '[data-test-id="more-menu-button"]',
  'button[aria-label^="Copy"]',
  'button[aria-label*="Copy response"]',
  'button[aria-label*="Good response"]',
  'button[aria-label*="Bad response"]',
  'button[aria-label*="复制"]',
  'button[aria-label*="更多"]',
  'mat-icon[fonticon="content_copy"]',
  'mat-icon[fonticon="thumb_up"]',
  'mat-icon[fonticon="thumb_down"]',
] as const;

const USER_PROMPT_SELECTORS = [
  '[data-message-author-role="user"]',
  '[data-testid*="user"]',
  '[data-test-id*="user"]',
  '[class*="user-query"]',
  '[class*="userQuery"]',
  'user-query',
] as const;

let enabled = false;
let observer: MutationObserver | null = null;
let evaluateTimer: number | null = null;
let startupTimer: number | null = null;
let pageObserverInjected = false;
let activeNetworkRequestCount = 0;
let hasPendingBackgroundCompletion = false;
let hasDeferredForegroundCompletion = false;
let toastHideTimer: number | null = null;
let latestCompletedResponse: HTMLElement | null = null;
const foregroundToastArmedConversationKeys = new Set<string>();
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

const detector = new ResponseCompletionDetector();

function getI18nMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage?.(key) || fallback;
  } catch {
    return fallback;
  }
}

function getForegroundToastText(): string {
  return getI18nMessage(FOREGROUND_TOAST_TEXT_KEY, FOREGROUND_TOAST_TEXT_FALLBACK);
}

function getConversationKey(): string {
  return `${location.pathname}${location.search}`;
}

function shouldNotifyForBackgroundCompletion(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

function isPromptInteractionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(PROMPT_SELECTORS);
}

function markCompletionNotificationArmed(): void {
  foregroundToastArmedConversationKeys.add(getConversationKey());
}

function shouldSuppressWithoutPromptInteraction(): boolean {
  const conversationKey = getConversationKey();
  if (foregroundToastArmedConversationKeys.delete(conversationKey)) return false;
  return true;
}

function handlePromptInteraction(event: Event): void {
  if (!isPromptInteractionTarget(event.target)) return;
  markCompletionNotificationArmed();
}

function getPromptContainerRect(): DOMRect | null {
  const promptElements = Array.from(document.querySelectorAll<HTMLElement>(PROMPT_SELECTORS));
  let bestRect: DOMRect | null = null;
  let bestScore = -Infinity;

  for (const promptElement of promptElements) {
    let current: HTMLElement | null = promptElement;

    for (let depth = 0; current && depth < PROMPT_CONTAINER_MAX_PARENT_DEPTH; depth += 1) {
      const rect = current.getBoundingClientRect();
      const isVisible =
        rect.width > PROMPT_CONTAINER_MIN_WIDTH_PX &&
        rect.height >= PROMPT_CONTAINER_MIN_HEIGHT_PX &&
        rect.height <= PROMPT_CONTAINER_MAX_HEIGHT_PX &&
        rect.top > 0 &&
        rect.bottom <= window.innerHeight + PROMPT_CONTAINER_VIEWPORT_BOTTOM_TOLERANCE_PX &&
        rect.right > 0 &&
        rect.left < window.innerWidth;

      if (isVisible) {
        const style = window.getComputedStyle(current);
        const borderRadius = Number.parseFloat(style.borderTopLeftRadius || '0');
        const distanceFromBottom = Math.abs(
          window.innerHeight - rect.bottom - PROMPT_CONTAINER_BOTTOM_TARGET_OFFSET_PX,
        );
        const widthScore =
          Math.min(rect.width, PROMPT_CONTAINER_WIDTH_SCORE_LIMIT_PX) /
          PROMPT_CONTAINER_WIDTH_SCORE_DIVISOR;
        const roundedScore =
          Math.min(borderRadius, PROMPT_CONTAINER_BORDER_RADIUS_SCORE_LIMIT_PX) *
          PROMPT_CONTAINER_BORDER_RADIUS_SCORE_MULTIPLIER;
        const bottomScore = Math.max(0, PROMPT_CONTAINER_BOTTOM_SCORE_BASE - distanceFromBottom);
        const depthPenalty = depth * PROMPT_CONTAINER_DEPTH_PENALTY_MULTIPLIER;
        const fullPagePenalty =
          rect.width > window.innerWidth * PROMPT_CONTAINER_FULL_WIDTH_RATIO
            ? PROMPT_CONTAINER_FULL_WIDTH_PENALTY
            : 0;
        const score = widthScore + roundedScore + bottomScore - depthPenalty - fullPagePenalty;

        if (score > bestScore) {
          bestScore = score;
          bestRect = rect;
        }
      }

      current = current.parentElement;
    }
  }

  return bestRect;
}

function getDocumentScrollRoot(): HTMLElement {
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

function getScrollRoot(anchor: Element | null = null): HTMLElement {
  let current = anchor?.parentElement ?? null;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const hasScrollableOverflow = /auto|scroll|overlay/.test(style.overflowY);
    if (
      hasScrollableOverflow &&
      current.scrollHeight - current.clientHeight > BOTTOM_SCROLL_THRESHOLD_PX
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return getDocumentScrollRoot();
}

function getRemainingScrollDistance(anchor: Element | null = null): number {
  const scrollRoot = getScrollRoot(anchor);
  return Math.max(0, scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight);
}

function isLatestResponseVisible(response: HTMLElement): boolean {
  const rect = response.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return false;

  return (
    rect.bottom >= LATEST_RESPONSE_VISIBLE_MARGIN_PX &&
    rect.top <= window.innerHeight - LATEST_RESPONSE_VISIBLE_MARGIN_PX
  );
}

function shouldShowForegroundCompletionToast(response: HTMLElement | null): boolean {
  if (!response) return false;
  if (isLatestResponseVisible(response)) return false;
  return getRemainingScrollDistance(response) > BOTTOM_SCROLL_THRESHOLD_PX;
}

function scrollToLatestResponse(): void {
  const target = latestCompletedResponse ?? getLatestAssistantResponse();

  if (target) {
    target.scrollIntoView({
      block: 'end',
      behavior: 'smooth',
    });
    hideForegroundCompletionToast();
    return;
  }

  const scrollRoot = getScrollRoot();
  scrollRoot.scrollTo({
    top: scrollRoot.scrollHeight,
    behavior: 'smooth',
  });
  hideForegroundCompletionToast();
}

function ensureForegroundToast(): HTMLDivElement {
  const existing = document.getElementById(FOREGROUND_TOAST_ID);
  if (existing instanceof HTMLDivElement) return existing;

  const toast = document.createElement('div');
  toast.id = FOREGROUND_TOAST_ID;
  toast.textContent = getForegroundToastText();
  toast.setAttribute('role', 'button');
  toast.setAttribute('aria-live', 'polite');
  toast.tabIndex = 0;
  toast.addEventListener('click', scrollToLatestResponse);
  toast.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    scrollToLatestResponse();
  });
  Object.assign(toast.style, {
    position: 'fixed',
    left: '50%',
    bottom: `${FOREGROUND_TOAST_DEFAULT_BOTTOM_PX}px`,
    transform: FOREGROUND_TOAST_TRANSFORM_HIDDEN,
    zIndex: FOREGROUND_TOAST_Z_INDEX,
    minWidth: `${FOREGROUND_TOAST_MIN_WIDTH_PX}px`,
    maxWidth: `min(${FOREGROUND_TOAST_MAX_VIEWPORT_WIDTH_PERCENT}vw, ${FOREGROUND_TOAST_MAX_WIDTH_PX}px)`,
    boxSizing: 'border-box',
    padding: '10px 24px',
    borderRadius: '999px',
    background: 'rgba(232, 240, 254, 0.96)',
    color: '#1f1f1f',
    fontSize: '16px',
    lineHeight: '22px',
    fontWeight: '400',
    textAlign: 'center',
    boxShadow: '0 18px 48px rgba(60, 64, 67, 0.18)',
    opacity: '0',
    cursor: 'pointer',
    pointerEvents: 'auto',
    transition: 'opacity 180ms ease, transform 180ms ease',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  document.body.appendChild(toast);
  return toast;
}

function hideForegroundCompletionToast(): void {
  const toast = document.getElementById(FOREGROUND_TOAST_ID);
  if (!(toast instanceof HTMLDivElement)) return;

  toast.style.opacity = '0';
  toast.style.transform = FOREGROUND_TOAST_TRANSFORM_HIDDEN;
}

function showForegroundCompletionToast(): void {
  const toast = ensureForegroundToast();
  const promptRect = getPromptContainerRect();
  if (promptRect !== null) {
    const centerX = Math.min(
      window.innerWidth - FOREGROUND_TOAST_MIN_EDGE_GAP_PX,
      Math.max(FOREGROUND_TOAST_MIN_EDGE_GAP_PX, promptRect.left + promptRect.width / 2),
    );
    const bottom = Math.max(
      FOREGROUND_TOAST_MIN_BOTTOM_PX,
      window.innerHeight - promptRect.top + FOREGROUND_TOAST_BOTTOM_GAP_FROM_PROMPT_PX,
    );
    toast.style.left = `${centerX}px`;
    toast.style.bottom = `${bottom}px`;
  } else {
    toast.style.left = '50%';
    toast.style.bottom = `${FOREGROUND_TOAST_DEFAULT_BOTTOM_PX}px`;
  }

  const toastText = getForegroundToastText();
  toast.textContent = toastText;
  toast.setAttribute('aria-label', toastText);
  toast.style.opacity = '1';
  toast.style.transform = FOREGROUND_TOAST_TRANSFORM_VISIBLE;

  if (toastHideTimer !== null) {
    clearTimeout(toastHideTimer);
  }
  toastHideTimer = window.setTimeout(() => {
    toastHideTimer = null;
    hideForegroundCompletionToast();
  }, FOREGROUND_TOAST_VISIBLE_MS);
}

function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function hasGeneratingIndicator(): boolean {
  return GENERATING_SELECTORS.some((selector) => {
    try {
      return Array.from(document.querySelectorAll(selector)).some(isElementVisible);
    } catch {
      return false;
    }
  });
}

function getLatestAssistantResponse(): HTMLElement | null {
  const selector = getAssistantTurnSelectors().join(', ');
  const responses = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) =>
    element.textContent?.trim(),
  );
  return responses.at(-1) ?? null;
}

function hasCompletionActions(response: HTMLElement): boolean {
  let current: HTMLElement | null = response;
  for (let depth = 0; current && depth < COMPLETION_ACTION_MAX_PARENT_DEPTH; depth += 1) {
    const hasActions = COMPLETION_ACTION_SELECTORS.some((selector) => {
      try {
        return !!current?.querySelector(selector);
      } catch {
        return false;
      }
    });
    if (hasActions) return true;
    current = current.parentElement;
  }

  return false;
}

function getResponseFingerprint(response: HTMLElement): string | null {
  const text = response.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return null;

  const boundedText =
    text.length > MAX_FINGERPRINT_TEXT_LENGTH ? text.slice(-MAX_FINGERPRINT_TEXT_LENGTH) : text;
  return `${text.length}:${boundedText}`;
}

function normalizeNotificationText(text: string | null | undefined, maxLength: number): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim().replace(TURN_LABEL_PREFIXES, '');
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function getConversationTitle(): string {
  const titleFromDocument = normalizeNotificationText(
    document.title.replace(/\s*[-|]\s*Gemini\s*$/i, '').replace(/\s*[-|]\s*Google\s*$/i, ''),
    MAX_NOTIFICATION_TITLE_LENGTH,
  );
  if (titleFromDocument && !/^gemini$/i.test(titleFromDocument)) return titleFromDocument;

  const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, [role="heading"]'))
    .map((element) => normalizeNotificationText(element.textContent, MAX_NOTIFICATION_TITLE_LENGTH))
    .find((text) => text && !/^gemini$/i.test(text));

  return heading ?? '';
}

function isInsideAssistantResponse(element: Element): boolean {
  const selector = getAssistantTurnSelectors().join(', ');
  try {
    return !!element.closest(selector);
  } catch {
    return false;
  }
}

function hasVisuallyHiddenClass(element: Element): boolean {
  if (!(element instanceof HTMLElement) || element.classList.length === 0) return false;
  return Array.from(element.classList).some((className) =>
    className.toLowerCase().includes(VISUALLY_HIDDEN_CLASS_FRAGMENT),
  );
}

function getVisibleElementText(element: HTMLElement): string {
  try {
    const clone = element.cloneNode(true) as HTMLElement;
    if (hasVisuallyHiddenClass(clone)) return '';

    Array.from(clone.getElementsByTagName('*')).forEach((descendant) => {
      if (hasVisuallyHiddenClass(descendant)) descendant.remove();
    });
    clone.querySelectorAll(INJECTED_UI_SELECTOR).forEach((descendant) => descendant.remove());
    clone.querySelectorAll<HTMLElement>('[data-user-latex-original]').forEach((descendant) => {
      descendant.textContent = descendant.dataset.userLatexOriginal ?? '';
    });

    return clone.textContent ?? '';
  } catch {
    return element.textContent ?? '';
  }
}

function getLatestUserPrompt(): string {
  const candidates: HTMLElement[] = [];

  for (const selector of USER_PROMPT_SELECTORS) {
    try {
      candidates.push(...Array.from(document.querySelectorAll<HTMLElement>(selector)));
    } catch {
      // Ignore selectors that do not match the current Gemini DOM.
    }
  }

  const promptTexts = candidates
    .filter((element) => !isInsideAssistantResponse(element) && !isPromptInteractionTarget(element))
    .map((element) =>
      normalizeNotificationText(getVisibleElementText(element), MAX_NOTIFICATION_PROMPT_LENGTH),
    )
    .filter((text) => text.length > 0);

  return promptTexts.at(-1) ?? '';
}

async function sendCompletionNotification(): Promise<boolean> {
  try {
    const response = (await chrome.runtime?.sendMessage?.({
      type: 'gv.responseComplete.notify',
      payload: {
        conversationUrl: location.href,
        conversationTitle: getConversationTitle(),
        userPrompt: getLatestUserPrompt(),
      },
    })) as { ok?: boolean } | undefined;

    return response?.ok === true;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return false;
    }
    console.warn(LOG_PREFIX, 'Failed to send completion notification:', error);
    return false;
  }
}

function queueDeferredForegroundCompletion(): void {
  hasDeferredForegroundCompletion = true;
}

function flushDeferredForegroundCompletion(): void {
  if (!enabled || !hasDeferredForegroundCompletion || shouldNotifyForBackgroundCompletion()) {
    return;
  }

  hasDeferredForegroundCompletion = false;
  latestCompletedResponse = getLatestAssistantResponse();
  if (shouldShowForegroundCompletionToast(latestCompletedResponse)) {
    showForegroundCompletionToast();
  }
}

async function notifyOrQueueForegroundFallback(): Promise<void> {
  const notified = await sendCompletionNotification();
  if (!notified) {
    queueDeferredForegroundCompletion();
  }
}

async function notifyLatestCompletedResponseNow(): Promise<void> {
  const latestResponse = getLatestAssistantResponse();
  const decision = detector.notifyImmediately({
    conversationKey: getConversationKey(),
    hasCompletedResponse: !!latestResponse && hasCompletionActions(latestResponse),
    isGenerating: hasGeneratingIndicator(),
    responseFingerprint: latestResponse ? getResponseFingerprint(latestResponse) : null,
    now: Date.now(),
  });

  if (decision.type !== 'notify') return;

  latestCompletedResponse = latestResponse;
  await notifyOrQueueForegroundFallback();
}

function injectPageObserver(): void {
  if (pageObserverInjected) return;
  if (getVoyagerBuildTarget() === 'safari') {
    pageObserverInjected = true;
    return;
  }
  if (document.getElementById(PAGE_OBSERVER_SCRIPT_ID)) {
    pageObserverInjected = true;
    return;
  }

  try {
    const script = document.createElement('script');
    script.id = PAGE_OBSERVER_SCRIPT_ID;
    script.src = chrome.runtime.getURL('response-complete-observer.js');
    script.async = false;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
    pageObserverInjected = true;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }
    console.warn(LOG_PREFIX, 'Failed to inject page observer:', error);
  }
}

function handlePageObserverMessage(event: MessageEvent): void {
  if (!enabled || event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    payload?: { requestId?: number; duration?: number; shouldNotify?: boolean };
  } | null;
  if (!data || data.source !== PAGE_OBSERVER_SOURCE) return;

  if (data.type === 'request-start') {
    activeNetworkRequestCount += 1;
    detector.update({
      conversationKey: getConversationKey(),
      hasCompletedResponse: false,
      isGenerating: true,
      responseFingerprint: null,
      now: Date.now(),
    });
    return;
  }

  if (data.type !== 'request-complete') return;

  activeNetworkRequestCount = Math.max(0, activeNetworkRequestCount - 1);
  hasPendingBackgroundCompletion =
    hasPendingBackgroundCompletion || data.payload?.shouldNotify === true;
  if (activeNetworkRequestCount > 0) return;
  if (!hasPendingBackgroundCompletion) return;
  hasPendingBackgroundCompletion = false;
  if (!shouldNotifyForBackgroundCompletion()) {
    scheduleEvaluate(0);
    return;
  }

  void notifyLatestCompletedResponseNow();
}

function evaluate(): void {
  evaluateTimer = null;
  if (!enabled) return;

  const latestResponse = getLatestAssistantResponse();
  const decision = detector.update({
    conversationKey: getConversationKey(),
    hasCompletedResponse: !!latestResponse && hasCompletionActions(latestResponse),
    isGenerating: hasGeneratingIndicator(),
    responseFingerprint: latestResponse ? getResponseFingerprint(latestResponse) : null,
    now: Date.now(),
  });

  if (decision.type === 'notify') {
    latestCompletedResponse = latestResponse;
    if (shouldNotifyForBackgroundCompletion()) {
      void notifyOrQueueForegroundFallback();
      return;
    }
    if (shouldSuppressWithoutPromptInteraction()) return;
    if (shouldShowForegroundCompletionToast(latestResponse)) {
      showForegroundCompletionToast();
    }
  }
}

function scheduleEvaluate(delay = EVALUATE_DEBOUNCE_MS): void {
  if (!enabled) return;
  if (evaluateTimer !== null) {
    clearTimeout(evaluateTimer);
  }
  evaluateTimer = window.setTimeout(evaluate, delay);
}

function startObserver(): void {
  if (observer || !document.body) return;

  injectPageObserver();
  window.addEventListener('message', handlePageObserverMessage);
  window.addEventListener('focus', flushDeferredForegroundCompletion);
  document.addEventListener('visibilitychange', flushDeferredForegroundCompletion);
  document.addEventListener('input', handlePromptInteraction, true);
  document.addEventListener('keydown', handlePromptInteraction, true);
  observer = new MutationObserver(() => scheduleEvaluate());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'aria-label', 'data-test-id', 'class'],
  });
  scheduleEvaluate(STARTUP_DELAY_MS);
}

function stopObserver(): void {
  window.removeEventListener('message', handlePageObserverMessage);
  window.removeEventListener('focus', flushDeferredForegroundCompletion);
  document.removeEventListener('visibilitychange', flushDeferredForegroundCompletion);
  document.removeEventListener('input', handlePromptInteraction, true);
  document.removeEventListener('keydown', handlePromptInteraction, true);
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (evaluateTimer !== null) {
    clearTimeout(evaluateTimer);
    evaluateTimer = null;
  }
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (toastHideTimer !== null) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  hideForegroundCompletionToast();
  activeNetworkRequestCount = 0;
  hasPendingBackgroundCompletion = false;
  hasDeferredForegroundCompletion = false;
  latestCompletedResponse = null;
  detector.reset();
}

function reconcile(): void {
  if (enabled) {
    if (document.body) {
      startObserver();
      return;
    }

    if (startupTimer === null) {
      startupTimer = window.setTimeout(() => {
        startupTimer = null;
        reconcile();
      }, EVALUATE_DEBOUNCE_MS);
    }
    return;
  }

  stopObserver();
}

async function loadEnabledSetting(): Promise<void> {
  try {
    const result = await chrome.storage?.sync?.get({
      [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
    });
    enabled = result?.[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] === true;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }
    console.warn(LOG_PREFIX, 'Failed to load setting:', error);
  }
}

function setupStorageListener(): void {
  if (storageListener) return;

  storageListener = (changes, areaName) => {
    if (areaName !== 'sync') return;
    const change = changes[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED];
    if (!change) return;

    enabled = change.newValue === true;
    reconcile();
  };

  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }
    console.warn(LOG_PREFIX, 'Failed to attach storage listener:', error);
  }
}

function cleanup(): void {
  enabled = false;
  stopObserver();
  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {}
    storageListener = null;
  }
}

export async function startResponseCompleteNotification(): Promise<() => void> {
  setupStorageListener();
  await loadEnabledSetting();
  reconcile();
  return cleanup;
}
