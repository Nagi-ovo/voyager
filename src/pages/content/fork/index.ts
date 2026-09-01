/**
 * Conversation Fork Feature
 *
 * Allows users to fork/branch a conversation at any user message.
 * When forking, the conversation up to that point is exported as markdown
 * and pasted into a new Gemini conversation. Both conversations are linked
 * via fork indicators for easy navigation between branches.
 */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { generateUniqueId } from '@/core/utils/hash';

import { getTranslationSync } from '../../../utils/i18n';
import { historyTimestampStore } from '../timestamp/historyTimestamps';
import { setInputText } from '../utils/inputHelper';
import { ForkNodesService } from './ForkNodesService';
import { buildBranchDisplayNodes, resolveForkPlan } from './branching';
import { collectForkChatPairs } from './chatPairs';
import { composeForkInputWithContext } from './forkContext';
import type { ForkNode } from './forkTypes';
import { type ForkExtractedTurn, buildForkMarkdown } from './markdown';
import { getLegacyTurnIndex, makeTurnId, normalizeTurnId } from './turnId';

// ============================================================================
// Constants
// ============================================================================

const STYLE_ID = 'gemini-voyager-fork-style';
const FORK_BTN_CLASS = 'gv-fork-btn';
const FORK_CONFIRM_CLASS = 'gv-fork-confirm';
const FORK_INDICATOR_CLASS = 'gv-fork-indicator';
const FORK_INDICATOR_GROUP_CLASS = 'gv-fork-indicator-group';
const FORK_INDICATOR_ITEM_CLASS = 'gv-fork-indicator-item';
const FORK_INDICATOR_DELETE_CLASS = 'gv-fork-indicator-delete';
const FORK_MANUAL_UPLOAD_HINT_CLASS = 'gv-fork-manual-upload-hint';
const FORK_MANUAL_UPLOAD_TIMER_CLASS = 'gv-fork-manual-upload-timer';
const PENDING_FORK_KEY = 'gvPendingFork';

const FORK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`;

const OBSERVER_DEBOUNCE_MS = 500;
const CONVERSATION_VERIFY_TIMEOUT_MS = 4000;
const CONVERSATION_EXISTENCE_CACHE_TTL_MS = 30000;

const conversationExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();

// ============================================================================
// Styles
// ============================================================================

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${FORK_BTN_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: transparent;
      color: var(--gv-fork-btn-color, #5f6368);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.15s, transform 0.15s, background-color 0.15s;
      position: absolute;
      top: 9px;
      right: calc(100% + 8px);
      z-index: 1;
      white-space: nowrap;
      height: 22px;
      box-sizing: border-box;
    }
    .${FORK_BTN_CLASS}:hover {
      opacity: 1;
      background-color: var(--gv-fork-btn-hover-bg, rgba(0, 0, 0, 0.06));
    }
    .${FORK_BTN_CLASS} svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }

    /* Reveal on hover/focus without affecting message layout */
    .user-query-bubble-with-background:hover .${FORK_BTN_CLASS},
    .user-query-container:hover .${FORK_BTN_CLASS},
    user-query:hover .${FORK_BTN_CLASS},
    user-query-content:hover .${FORK_BTN_CLASS},
    .user-query-bubble-with-background:focus-within .${FORK_BTN_CLASS},
    .user-query-container:focus-within .${FORK_BTN_CLASS},
    user-query:focus-within .${FORK_BTN_CLASS},
    user-query-content:focus-within .${FORK_BTN_CLASS},
    .${FORK_BTN_CLASS}:hover,
    .${FORK_BTN_CLASS}:focus-visible {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    html[dir="rtl"] .${FORK_BTN_CLASS},
    body[dir="rtl"] .${FORK_BTN_CLASS},
    body.gv-rtl .${FORK_BTN_CLASS} {
      right: auto;
      left: calc(100% + 8px);
    }

    /* Confirmation dialog */
    .${FORK_CONFIRM_CLASS} {
      z-index: 9999;
      background: var(--gv-fork-confirm-bg, #fff);
      color: var(--gv-fork-confirm-color, #202124);
      border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      white-space: nowrap;
      font-size: 13px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
    }
    .${FORK_CONFIRM_CLASS} p {
      margin: 0 0 8px 0;
    }
    .${FORK_CONFIRM_CLASS} .gv-fork-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .${FORK_CONFIRM_CLASS} button {
      padding: 4px 12px;
      border-radius: 4px;
      border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
      cursor: pointer;
      font-size: 12px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      background: transparent;
      color: inherit;
    }
    .${FORK_CONFIRM_CLASS} button.gv-fork-primary {
      background: var(--gv-fork-primary-bg, #1a73e8);
      color: #fff;
      border-color: transparent;
    }
    .${FORK_CONFIRM_CLASS} button.gv-fork-primary:hover {
      background: var(--gv-fork-primary-hover-bg, #1765cc);
    }
    .${FORK_CONFIRM_CLASS} button.gv-fork-secondary {
      background: var(--gv-fork-secondary-bg, rgba(26, 115, 232, 0.08));
      color: var(--gv-fork-secondary-color, #1a73e8);
      border-color: var(--gv-fork-secondary-border, rgba(26, 115, 232, 0.22));
    }
    .${FORK_CONFIRM_CLASS} button.gv-fork-secondary:hover {
      background: var(--gv-fork-secondary-hover-bg, rgba(26, 115, 232, 0.14));
    }

    .${FORK_MANUAL_UPLOAD_HINT_CLASS} {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 9999;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      max-width: 340px;
      padding: 12px 14px;
      border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
      border-radius: 8px;
      background: var(--gv-fork-confirm-bg, #fff);
      color: var(--gv-fork-confirm-color, #202124);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
      font-size: 13px;
      line-height: 1.4;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
    }
    .${FORK_MANUAL_UPLOAD_HINT_CLASS} span {
      flex: 1;
      min-width: 0;
    }
    .${FORK_MANUAL_UPLOAD_TIMER_CLASS} {
      display: block;
      margin-top: 6px;
      color: var(--gv-fork-secondary-color, #1a73e8);
      font-size: 14px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
    }
    .${FORK_MANUAL_UPLOAD_HINT_CLASS} button {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 16px;
      line-height: 20px;
    }

    /* Fork branch indicator group */
    .${FORK_INDICATOR_GROUP_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .${FORK_INDICATOR_ITEM_CLASS} {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .${FORK_INDICATOR_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      background: var(--gv-fork-indicator-bg, rgba(26, 115, 232, 0.06));
      color: var(--gv-fork-indicator-color, #1a73e8);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      border: 1px solid var(--gv-fork-indicator-border, rgba(26, 115, 232, 0.28));
      transition: background-color 0.15s, color 0.15s, border-color 0.15s;
    }
    .${FORK_INDICATOR_CLASS}:hover {
      background: var(--gv-fork-indicator-hover-bg, rgba(26, 115, 232, 0.16));
    }
    .${FORK_INDICATOR_CLASS}.gv-current {
      background: var(--gv-fork-indicator-current-bg, #1a73e8);
      color: var(--gv-fork-indicator-current-color, #fff);
      border-color: var(--gv-fork-indicator-current-bg, #1a73e8);
      cursor: default;
    }
    .${FORK_INDICATOR_DELETE_CLASS} {
      position: absolute;
      top: -5px;
      right: -5px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid transparent;
      background: #ea4335;
      color: #fff;
      cursor: pointer;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.8);
      transition: opacity 0.15s, transform 0.15s;
    }
    .${FORK_INDICATOR_ITEM_CLASS}:hover .${FORK_INDICATOR_DELETE_CLASS},
    .${FORK_INDICATOR_ITEM_CLASS}:focus-within .${FORK_INDICATOR_DELETE_CLASS} {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    .${FORK_INDICATOR_DELETE_CLASS}:disabled {
      opacity: 0.6;
      cursor: default;
      pointer-events: none;
    }

    /* Dark mode */
    html[dark] .${FORK_BTN_CLASS},
    body.dark-theme .${FORK_BTN_CLASS} {
      --gv-fork-btn-color: #9aa0a6;
      --gv-fork-btn-hover-bg: rgba(255, 255, 255, 0.08);
    }
    html[dark] .${FORK_CONFIRM_CLASS},
    body.dark-theme .${FORK_CONFIRM_CLASS},
    html[dark] .${FORK_MANUAL_UPLOAD_HINT_CLASS},
    body.dark-theme .${FORK_MANUAL_UPLOAD_HINT_CLASS} {
      --gv-fork-confirm-bg: #292a2d;
      --gv-fork-confirm-color: #e8eaed;
      --gv-fork-confirm-border: rgba(255, 255, 255, 0.12);
    }
    html[dark] .${FORK_CONFIRM_CLASS} button.gv-fork-primary,
    body.dark-theme .${FORK_CONFIRM_CLASS} button.gv-fork-primary {
      --gv-fork-primary-bg: #8ab4f8;
      color: #202124;
    }
    html[dark] .${FORK_CONFIRM_CLASS} button.gv-fork-primary:hover,
    body.dark-theme .${FORK_CONFIRM_CLASS} button.gv-fork-primary:hover {
      --gv-fork-primary-hover-bg: #aecbfa;
    }
    html[dark] .${FORK_CONFIRM_CLASS} button.gv-fork-secondary,
    body.dark-theme .${FORK_CONFIRM_CLASS} button.gv-fork-secondary {
      --gv-fork-secondary-bg: rgba(138, 180, 248, 0.12);
      --gv-fork-secondary-color: #8ab4f8;
      --gv-fork-secondary-border: rgba(138, 180, 248, 0.28);
      --gv-fork-secondary-hover-bg: rgba(138, 180, 248, 0.2);
    }
    html[dark] .${FORK_INDICATOR_CLASS},
    body.dark-theme .${FORK_INDICATOR_CLASS} {
      --gv-fork-indicator-bg: rgba(138, 180, 248, 0.12);
      --gv-fork-indicator-color: #8ab4f8;
      --gv-fork-indicator-border: rgba(138, 180, 248, 0.28);
      --gv-fork-indicator-hover-bg: rgba(138, 180, 248, 0.2);
      --gv-fork-indicator-current-bg: #8ab4f8;
      --gv-fork-indicator-current-color: #202124;
    }
    html[dark] .${FORK_INDICATOR_DELETE_CLASS},
    body.dark-theme .${FORK_INDICATOR_DELETE_CLASS} {
      background: #f28b82;
      color: #202124;
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// Helpers
// ============================================================================

function extractConversationIdFromUrl(): string | null {
  const appMatch = window.location.pathname.match(/\/app\/([^/?#]+)/);
  if (appMatch?.[1]) return appMatch[1];
  const gemMatch = window.location.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
  return gemMatch?.[1] || null;
}

function resolveCurrentConversationTurnId(turnId: string): string | null {
  const conversationId = extractConversationIdFromUrl();
  if (!conversationId) return normalizeTurnId(turnId);
  return historyTimestampStore.resolveCanonicalTurnId(conversationId, turnId);
}

function isSameCurrentConversationTurn(left: string, right: string): boolean {
  const resolvedLeft = resolveCurrentConversationTurnId(left);
  return resolvedLeft !== null && resolvedLeft === resolveCurrentConversationTurnId(right);
}

function getNewConversationUrlForCurrentAccount(): string {
  const accountPrefix = window.location.pathname.match(/^\/u\/\d+(?=\/)/)?.[0] || '';
  return `${window.location.origin}${accountPrefix}/app`;
}

function getConversationTitle(): string {
  const conversationId = extractConversationIdFromUrl();
  if (conversationId) {
    const escapedId = conversationId.replace(/"/g, '\\"');
    const link = document.querySelector<HTMLAnchorElement>(
      `[data-test-id="conversation"][jslog*="c_${escapedId}"] a, a[href*="/app/${escapedId}"]`,
    );
    if (link?.textContent?.trim()) return link.textContent.trim();
  }
  return document.title || 'Untitled';
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .trim()
    // oxlint-disable-next-line no-control-regex -- control characters are illegal in filenames and must be matched to be stripped
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .replace(/^\.+$/, '');
  return cleaned || 'fork';
}

function buildForkMarkdownFilename(title: string): string {
  return `gemini-voyager-fork-${sanitizeFilenamePart(title)}-${Date.now()}.md`;
}

function downloadMarkdownFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();

  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

function formatTranslation(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => {
    return result.split(`{${key}}`).join(value);
  }, template);
}

function ensureTurnId(el: HTMLElement, index: number): string {
  const stableId = makeTurnId(el, index);
  const current = el.dataset?.turnId || '';
  if (normalizeTurnId(current) !== stableId) {
    el.dataset.turnId = stableId;
  }
  return stableId;
}

function resolveUserMessageHost(userEl: HTMLElement): HTMLElement {
  const preferred =
    userEl.querySelector<HTMLElement>('.user-query-bubble-with-background') ||
    userEl.querySelector<HTMLElement>('user-query-content .user-query-bubble-with-background') ||
    userEl.querySelector<HTMLElement>('.user-query-bubble-container');
  return preferred || userEl;
}

function findUserCopyButtonAnchor(userEl: HTMLElement): HTMLElement | null {
  const copyButton =
    userEl.querySelector<HTMLElement>('button[data-test-id="copy-button"]') ||
    userEl
      .querySelector<HTMLElement>(
        'button mat-icon[fonticon="content_copy"], button mat-icon[data-mat-icon-name="content_copy"]',
      )
      ?.closest<HTMLElement>('button');

  if (!copyButton) return null;
  return copyButton.parentElement || copyButton;
}

function resolveForkButtonHost(userEl: HTMLElement): HTMLElement {
  return findUserCopyButtonAnchor(userEl) || resolveUserMessageHost(userEl);
}

function extractConversationIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    const appMatch = url.pathname.match(/\/app\/([^/?#]+)/);
    if (appMatch?.[1]) return appMatch[1];
    const gemMatch = url.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
    return gemMatch?.[1] || null;
  } catch {
    return null;
  }
}

function findSidebarConversationLinkById(conversationId: string): HTMLAnchorElement | null {
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"], a[href*="/gem/"]'),
  );
  for (const link of links) {
    if (extractConversationIdFromHref(link.href) === conversationId) return link;
  }
  return null;
}

function triggerNativeClick(target: HTMLElement): void {
  const options = { bubbles: true, cancelable: true, view: window };
  target.dispatchEvent(new MouseEvent('pointerdown', options));
  target.dispatchEvent(new MouseEvent('mousedown', options));
  target.dispatchEvent(new MouseEvent('mouseup', options));
  target.dispatchEvent(new MouseEvent('click', options));
}

function navigateToForkConversation(node: ForkNode): void {
  if (!node.conversationId) return;
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId === node.conversationId) return;

  const sidebarLink = findSidebarConversationLinkById(node.conversationId);
  if (sidebarLink) {
    triggerNativeClick(sidebarLink);
    return;
  }

  const fallbackUrl =
    node.conversationUrl ||
    `${window.location.origin}/app/${encodeURIComponent(node.conversationId)}`;
  window.location.assign(fallbackUrl);
}

function collectSidebarConversationIds(): Set<string> {
  const ids = new Set<string>();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"], a[href*="/gem/"]');
  links.forEach((link) => {
    const id = extractConversationIdFromHref(link.href);
    if (id) ids.add(id);
  });
  return ids;
}

async function getPreferredLanguage(): Promise<string | undefined> {
  try {
    const syncResult = await browser.storage.sync.get(StorageKeys.LANGUAGE);
    const syncLanguage = syncResult?.[StorageKeys.LANGUAGE];
    if (typeof syncLanguage === 'string' && syncLanguage.trim()) return syncLanguage;
  } catch {
    // Ignore sync storage failures.
  }

  try {
    const localResult = await browser.storage.local.get(StorageKeys.LANGUAGE);
    const localLanguage = localResult?.[StorageKeys.LANGUAGE];
    if (typeof localLanguage === 'string' && localLanguage.trim()) return localLanguage;
  } catch {
    // Ignore local storage failures.
  }

  return undefined;
}

async function checkConversationExists(
  node: ForkNode,
  sidebarConversationIds: Set<string>,
): Promise<boolean> {
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId && node.conversationId === currentConversationId) return true;
  if (sidebarConversationIds.has(node.conversationId)) {
    conversationExistenceCache.set(node.conversationId, { exists: true, checkedAt: Date.now() });
    return true;
  }

  const cached = conversationExistenceCache.get(node.conversationId);
  const now = Date.now();
  if (cached && now - cached.checkedAt <= CONVERSATION_EXISTENCE_CACHE_TTL_MS) {
    return cached.exists;
  }

  if (!node.conversationUrl) {
    conversationExistenceCache.set(node.conversationId, { exists: false, checkedAt: now });
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERSATION_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(node.conversationUrl, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include',
      signal: controller.signal,
    });
    const responseConversationId = extractConversationIdFromHref(response.url);
    const exists =
      response.ok && !!responseConversationId && node.conversationId === responseConversationId;
    conversationExistenceCache.set(node.conversationId, { exists, checkedAt: now });
    return exists;
  } catch {
    // If verification fails for network/CSP reasons, keep node to avoid destructive false positives.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function pruneDeletedNodesFromGroup(
  groupNodes: ForkNode[],
  sidebarConversationIds: Set<string>,
): Promise<ForkNode[]> {
  const cleaned: ForkNode[] = [];

  for (const node of groupNodes) {
    const exists = await checkConversationExists(node, sidebarConversationIds);
    if (exists) {
      cleaned.push(node);
      continue;
    }

    try {
      await ForkNodesService.removeForkNode(node.conversationId, node.turnId, node.forkGroupId);
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) {
        console.error('[Fork] Failed to prune deleted fork node:', error);
      }
    }
  }

  return cleaned;
}

function clearInjectedForkIndicators(): void {
  document.querySelectorAll(`.${FORK_INDICATOR_GROUP_CLASS}`).forEach((el) => el.remove());
}

function hasOrDedupForkIndicatorGroup(hostEl: HTMLElement): boolean {
  const groups = Array.from(hostEl.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_GROUP_CLASS}`));
  if (groups.length === 0) return false;
  if (groups.length > 1) {
    for (let i = 1; i < groups.length; i++) {
      groups[i].remove();
    }
  }
  return true;
}

/**
 * Extract conversation content up to and including the given user turn index.
 *
 * Step 1: Extract turns 0..N with both user and assistant content when available.
 * Step 2: Remove the last assistant response to let users continue from the last user turn.
 */
function extractConversationUpToTurn(userTurnIndex: number, sourceTurnId: string): string {
  const pairs = collectForkChatPairs();
  if (pairs.length === 0) return '';

  const sourceIndex = pairs.findIndex((pair) =>
    isSameCurrentConversationTurn(pair.turnId, sourceTurnId),
  );
  const targetIndex = sourceIndex >= 0 ? sourceIndex : userTurnIndex;
  const turns: ForkExtractedTurn[] = [];
  for (let i = 0; i <= targetIndex && i < pairs.length; i++) {
    turns.push({
      user: pairs[i].user || '',
      assistant: pairs[i].assistant || '',
    });
  }

  return buildForkMarkdown(getConversationTitle(), turns, true);
}

// ============================================================================
// Fork Button Injection
// ============================================================================

let observer: MutationObserver | null = null;
let observerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let storageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let manualUploadHintTimer: ReturnType<typeof setTimeout> | null = null;
let manualUploadCountdownTimer: ReturnType<typeof setInterval> | null = null;
let activeConfirm: HTMLElement | null = null;

function dismissConfirm(): void {
  if (activeConfirm) {
    activeConfirm.remove();
    activeConfirm = null;
  }
}

function onDocumentClick(e: MouseEvent): void {
  if (activeConfirm && !activeConfirm.contains(e.target as Node)) {
    dismissConfirm();
  }
}

function scheduleForkIndicatorRefresh(): void {
  if (storageRefreshTimer) clearTimeout(storageRefreshTimer);
  storageRefreshTimer = setTimeout(() => {
    clearInjectedForkIndicators();
    void injectForkIndicators();
    storageRefreshTimer = null;
  }, OBSERVER_DEBOUNCE_MS);
}

function clearManualUploadHint(): void {
  if (manualUploadHintTimer) {
    clearTimeout(manualUploadHintTimer);
    manualUploadHintTimer = null;
  }
  if (manualUploadCountdownTimer) {
    clearInterval(manualUploadCountdownTimer);
    manualUploadCountdownTimer = null;
  }
  document.querySelectorAll(`.${FORK_MANUAL_UPLOAD_HINT_CLASS}`).forEach((el) => el.remove());
}

function injectForkButtons(): void {
  const pairs = collectForkChatPairs();

  pairs.forEach((pair, index) => {
    const userEl = pair.userElement;
    ensureTurnId(userEl, index);
    const hostEl = resolveForkButtonHost(userEl);

    const existingButton = userEl.querySelector<HTMLElement>(`.${FORK_BTN_CLASS}`);
    if (existingButton) {
      hostEl.style.position = hostEl.style.position || 'relative';
      if (existingButton.parentElement !== hostEl) {
        hostEl.appendChild(existingButton);
      }
      return;
    }

    const btn = document.createElement('button');
    btn.className = FORK_BTN_CLASS;
    btn.title = getTranslationSync('forkConversation');
    btn.innerHTML = `${FORK_ICON}<span>${getTranslationSync('forkConversation')}</span>`;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      showForkConfirmation(btn, userEl, index);
    });

    // Add at the end of the user message container
    hostEl.style.position = hostEl.style.position || 'relative';
    hostEl.appendChild(btn);
  });
}

function showForkConfirmation(btn: HTMLElement, userEl: HTMLElement, turnIndex: number): void {
  dismissConfirm();

  const confirm = document.createElement('div');
  confirm.className = FORK_CONFIRM_CLASS;
  confirm.innerHTML = `
    <p>${getTranslationSync('forkConfirm')}</p>
    <div class="gv-fork-actions">
      <button class="gv-fork-cancel">${getTranslationSync('forkCancel')}</button>
      <button class="gv-fork-secondary">${getTranslationSync('forkMarkdownBtn')}</button>
      <button class="gv-fork-primary">${getTranslationSync('forkConfirmBtn')}</button>
    </div>
  `;

  const cancelBtn = confirm.querySelector('.gv-fork-cancel')!;
  const markdownBtn = confirm.querySelector('.gv-fork-secondary')!;
  const confirmBtn = confirm.querySelector('.gv-fork-primary')!;

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    dismissConfirm();
  });
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    dismissConfirm();
    void executeFork(userEl, turnIndex, 'paste');
  });
  markdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    dismissConfirm();
    void executeFork(userEl, turnIndex, 'fileUpload');
  });

  // Prevent clicks inside the dialog from bubbling to parent handlers
  confirm.addEventListener('click', (e) => e.stopPropagation());

  // Position near the fork button using fixed positioning
  const btnRect = btn.getBoundingClientRect();
  confirm.style.position = 'fixed';
  confirm.style.top = `${btnRect.top - 4}px`;
  confirm.style.left = `${btnRect.right}px`;
  confirm.style.transform = 'translateY(-100%)';

  document.body.appendChild(confirm);
  activeConfirm = confirm;
}

type PendingForkMode = 'paste' | 'fileUpload';

async function executeFork(
  userEl: HTMLElement,
  turnIndex: number,
  mode: PendingForkMode,
): Promise<void> {
  const conversationId = extractConversationIdFromUrl();
  if (!conversationId) {
    console.warn('[Fork] No conversation ID found');
    return;
  }

  const turnId = ensureTurnId(userEl, turnIndex);
  if (getLegacyTurnIndex(turnId) !== null) {
    console.warn('[Fork] Stable turn identity is not available yet');
    return;
  }
  const markdown = extractConversationUpToTurn(turnIndex, turnId);
  if (!markdown.trim()) {
    console.warn('[Fork] No content extracted');
    return;
  }

  // Open new window IMMEDIATELY to preserve user gesture context.
  // Firefox and Safari block window.open() that follows async operations.
  const newWindow = window.open(getNewConversationUrlForCurrentAccount(), '_blank');
  if (!newWindow) {
    console.warn('[Fork] Failed to open new window (popup blocked?)');
    return;
  }

  // Async work: resolve language and fork group (safe now, window already opened)
  const preferredLanguage = await getPreferredLanguage();
  const markdownWithContext = composeForkInputWithContext(markdown, preferredLanguage);
  const markdownFilename =
    mode === 'fileUpload' ? buildForkMarkdownFilename(getConversationTitle()) : undefined;

  let forkGroupId = generateUniqueId('fork');
  let sourceForkIndex = 0;
  let nextForkIndex = 1;

  try {
    const conversationNodes = await ForkNodesService.getForConversation(conversationId);
    const candidateGroupIds = Array.from(
      new Set(
        conversationNodes
          .filter((node) => isSameCurrentConversationTurn(node.turnId, turnId))
          .map((node) => node.forkGroupId),
      ),
    );

    const groups: Record<string, ForkNode[]> = {};
    for (const groupId of candidateGroupIds) {
      groups[groupId] = await ForkNodesService.getGroup(groupId);
    }

    const plan = resolveForkPlan(
      conversationId,
      turnId,
      conversationNodes,
      groups,
      () => generateUniqueId('fork'),
      resolveCurrentConversationTurnId,
    );

    forkGroupId = plan.forkGroupId;
    sourceForkIndex = plan.sourceForkIndex;
    nextForkIndex = plan.nextForkIndex;
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.error('[Fork] Failed to resolve fork group, using default:', error);
    }
  }

  // Store pending fork data in extension storage (cross-tab accessible).
  // sessionStorage is per-tab and its copy semantics with window.open() vary by browser.
  const pendingFork: PendingForkData = {
    sourceConversationId: conversationId,
    sourceTurnId: turnId,
    sourceUrl: window.location.href,
    sourceTitle: getConversationTitle(),
    forkGroupId,
    sourceForkIndex,
    nextForkIndex,
    markdown: markdownWithContext,
    mode,
    filename: markdownFilename,
    createdAt: Date.now(),
  };

  try {
    await browser.storage.local.set({ [PENDING_FORK_KEY]: pendingFork });
    if (mode === 'fileUpload' && markdownFilename) {
      downloadMarkdownFile(markdownWithContext, markdownFilename);
    }
  } catch (e) {
    console.error('[Fork] Failed to save pending fork:', e);
  }
}

// ============================================================================
// Pending Fork Handling (New Conversation)
// ============================================================================

interface PendingForkData {
  sourceConversationId: string;
  sourceTurnId: string;
  sourceUrl: string;
  sourceTitle: string;
  forkGroupId: string;
  sourceForkIndex: number;
  nextForkIndex: number;
  markdown: string;
  mode: PendingForkMode;
  filename?: string;
  createdAt?: number;
}

const PENDING_FORK_PASTE_STALE_MS = 60000;
const PENDING_FORK_FILE_UPLOAD_STALE_MS = 120000;

function getPendingForkTtl(mode: PendingForkMode): number {
  return mode === 'fileUpload' ? PENDING_FORK_FILE_UPLOAD_STALE_MS : PENDING_FORK_PASTE_STALE_MS;
}

function getPendingForkRemainingMs(pendingFork: PendingForkData): number {
  const createdAt = pendingFork.createdAt ?? Date.now();
  return Math.max(0, createdAt + getPendingForkTtl(pendingFork.mode) - Date.now());
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getInputText(input: HTMLElement): string {
  return input instanceof HTMLTextAreaElement ? input.value : (input.textContent ?? '');
}

function buildManualUploadPrompt(pendingFork: PendingForkData): string {
  return formatTranslation(getTranslationSync('forkManualUploadPrompt'), {
    filename: pendingFork.filename || 'MD',
  });
}

async function readPendingFork(): Promise<PendingForkData | null> {
  try {
    const result = await browser.storage.local.get(PENDING_FORK_KEY);
    const parsed = result[PENDING_FORK_KEY] as Partial<PendingForkData> | undefined;
    if (!parsed) return null;
    const mode: PendingForkMode = parsed.mode === 'fileUpload' ? 'fileUpload' : 'paste';

    // Discard stale data (e.g. from a previous failed fork)
    if (parsed.createdAt && Date.now() - parsed.createdAt > getPendingForkTtl(mode)) {
      await browser.storage.local.remove(PENDING_FORK_KEY);
      return null;
    }

    const pendingFork: PendingForkData = {
      sourceConversationId: parsed.sourceConversationId || '',
      sourceTurnId: parsed.sourceTurnId || '',
      sourceUrl: parsed.sourceUrl || '',
      sourceTitle: parsed.sourceTitle || '',
      forkGroupId: parsed.forkGroupId || '',
      sourceForkIndex: Number.isFinite(parsed.sourceForkIndex) ? parsed.sourceForkIndex! : 0,
      nextForkIndex: Number.isFinite(parsed.nextForkIndex) ? parsed.nextForkIndex! : 1,
      markdown: parsed.markdown || '',
      mode,
      filename: typeof parsed.filename === 'string' ? parsed.filename : undefined,
      createdAt: parsed.createdAt,
    };

    if (
      !pendingFork.sourceConversationId ||
      !pendingFork.sourceTurnId ||
      !pendingFork.forkGroupId ||
      !pendingFork.markdown.trim()
    ) {
      await browser.storage.local.remove(PENDING_FORK_KEY);
      return null;
    }

    return pendingFork;
  } catch {
    return null;
  }
}

function checkAndHandlePendingFork(): void {
  // Only handle on a new conversation page (no conversation ID yet)
  const currentConvId = extractConversationIdFromUrl();
  if (currentConvId) return;

  // Clean up legacy sessionStorage data (from versions before this fix)
  try {
    sessionStorage.removeItem(PENDING_FORK_KEY);
  } catch {
    // Ignore
  }

  void handlePendingForkFromStorage();
}

async function handlePendingForkFromStorage(): Promise<void> {
  // The opener tab writes to storage.local after async work, which may take a moment.
  // Try immediately, then retry once after a short delay.
  let pendingFork = await readPendingFork();
  if (!pendingFork) {
    await new Promise((r) => setTimeout(r, 2000));
    pendingFork = await readPendingFork();
  }
  if (!pendingFork) return;

  // Clear immediately so other tabs don't pick it up
  try {
    await browser.storage.local.remove(PENDING_FORK_KEY);
  } catch {
    // Ignore
  }

  // Re-check: still on a new conversation page?
  if (extractConversationIdFromUrl()) return;

  const remainingMs = getPendingForkRemainingMs(pendingFork);
  if (remainingMs <= 0) return;

  if (pendingFork.mode === 'fileUpload') {
    showManualUploadHint(pendingFork, remainingMs);
    void prefillManualUploadPrompt(pendingFork);
    watchForNewConversation(pendingFork, remainingMs);
    return;
  }

  // Wait for the input field to be available
  const input = await waitForElement('rich-textarea [contenteditable="true"]', 10000);
  if (!input) {
    console.warn('[Fork] Input field not found');
    return;
  }

  setInputText(input, pendingFork.markdown);

  // Watch for URL change (conversation created after submission)
  watchForNewConversation(pendingFork, remainingMs);
}

async function prefillManualUploadPrompt(pendingFork: PendingForkData): Promise<void> {
  const input = await waitForElement('rich-textarea [contenteditable="true"]', 10000);
  if (!input || getInputText(input).trim()) return;
  setInputText(input, buildManualUploadPrompt(pendingFork));
}

function showManualUploadHint(pendingFork: PendingForkData, remainingMs: number): void {
  clearManualUploadHint();

  const notice = document.createElement('div');
  notice.className = FORK_MANUAL_UPLOAD_HINT_CLASS;
  notice.setAttribute('role', 'status');

  const message = document.createElement('span');
  message.textContent = formatTranslation(getTranslationSync('forkManualUploadHint'), {
    filename: pendingFork.filename || 'MD',
  });

  const timer = document.createElement('strong');
  timer.className = FORK_MANUAL_UPLOAD_TIMER_CLASS;
  timer.setAttribute('aria-live', 'polite');
  timer.textContent = formatCountdown(remainingMs);
  message.appendChild(timer);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '\u00d7';
  closeButton.title = getTranslationSync('forkCancel');
  closeButton.setAttribute('aria-label', getTranslationSync('forkCancel'));
  closeButton.addEventListener('click', () => clearManualUploadHint());

  notice.appendChild(message);
  notice.appendChild(closeButton);
  document.body.appendChild(notice);

  const expiresAt = Date.now() + remainingMs;
  manualUploadCountdownTimer = setInterval(() => {
    const nextRemainingMs = Math.max(0, expiresAt - Date.now());
    timer.textContent = formatCountdown(nextRemainingMs);
    if (nextRemainingMs <= 0) {
      clearManualUploadHint();
    }
  }, 1000);
  manualUploadHintTimer = setTimeout(clearManualUploadHint, remainingMs);
}

function waitForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing && existing.getBoundingClientRect().height > 0) {
      resolve(existing);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && el.getBoundingClientRect().height > 0) {
        resolve(el);
        return;
      }
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

function watchForNewConversation(pendingFork: PendingForkData, timeoutMs: number): void {
  let lastUrl = window.location.href;
  let stopped = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const stopWatching = () => {
    if (stopped) return;
    stopped = true;
    urlObserver.disconnect();
    window.removeEventListener('popstate', onUrlChange);
    window.removeEventListener('hashchange', onUrlChange);
    if (pollInterval) clearInterval(pollInterval);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    clearManualUploadHint();
  };

  const checkUrl = async () => {
    if (stopped) return;
    const currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    const newConvId = extractConversationIdFromUrl();
    if (!newConvId) return;

    // New conversation created! Create fork nodes for both sides
    stopWatching();

    try {
      // Create fork node for the SOURCE conversation (original, index 0)
      const sourceNode: ForkNode = {
        turnId: pendingFork.sourceTurnId,
        conversationId: pendingFork.sourceConversationId,
        conversationUrl: pendingFork.sourceUrl,
        conversationTitle: pendingFork.sourceTitle,
        forkGroupId: pendingFork.forkGroupId,
        forkIndex: pendingFork.sourceForkIndex,
        createdAt: Date.now(),
      };
      await ForkNodesService.addForkNode(sourceNode);

      // Create fork node for the NEW conversation (fork)
      // Use the first user turn ID in the new conversation
      const newNode: ForkNode = {
        turnId: 'u-0', // First user turn in new conversation
        conversationId: newConvId,
        conversationUrl: currentUrl,
        conversationTitle: getConversationTitle(),
        forkGroupId: pendingFork.forkGroupId,
        forkIndex: pendingFork.nextForkIndex,
        createdAt: Date.now(),
      };
      await ForkNodesService.addForkNode(newNode);

      // Inject fork indicators in the new conversation
      setTimeout(() => injectForkIndicators(), 1000);
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) {
        console.error('[Fork] Failed to create fork nodes:', error);
      }
    }
  };

  // Use a MutationObserver on the URL (via popstate + polling)
  const urlObserver = new MutationObserver(() => void checkUrl());
  urlObserver.observe(document, { subtree: true, childList: true });

  // Also listen to popstate and hashchange
  const onUrlChange = () => void checkUrl();
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  // Poll as fallback (SPA navigation may not trigger popstate)
  pollInterval = setInterval(() => {
    void checkUrl();
  }, 500);

  // Cleanup when the fork window expires
  cleanupTimer = setTimeout(stopWatching, timeoutMs);
}

// ============================================================================
// Fork Indicator UI
// ============================================================================

async function injectForkIndicators(): Promise<void> {
  const conversationId = extractConversationIdFromUrl();
  if (!conversationId) return;

  let forkNodes: ForkNode[];
  try {
    forkNodes = await ForkNodesService.getForConversation(conversationId);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.error('[Fork] Failed to get fork nodes:', error);
    }
    return;
  }

  if (forkNodes.length === 0) return;

  // Build a map of normalized turnId -> forkGroupIds
  const turnForkMap = new Map<string, Set<string>>();
  for (const node of forkNodes) {
    const normalizedTurnId = resolveCurrentConversationTurnId(node.turnId);
    if (!normalizedTurnId) continue;
    if (!turnForkMap.has(normalizedTurnId)) {
      turnForkMap.set(normalizedTurnId, new Set<string>());
    }
    turnForkMap.get(normalizedTurnId)?.add(node.forkGroupId);
  }

  const pairs = collectForkChatPairs();
  const sidebarConversationIds = collectSidebarConversationIds();
  if (conversationId) sidebarConversationIds.add(conversationId);

  for (let index = 0; index < pairs.length; index++) {
    const userEl = pairs[index].userElement;
    const mountedTurnId = ensureTurnId(userEl, index);
    if (getLegacyTurnIndex(mountedTurnId) !== null) continue;
    const turnId = resolveCurrentConversationTurnId(mountedTurnId);
    if (!turnId) continue;
    const hostEl = resolveUserMessageHost(userEl);
    const forkGroupIds = turnForkMap.get(turnId);
    if (!forkGroupIds || forkGroupIds.size === 0) continue;

    if (hasOrDedupForkIndicatorGroup(hostEl)) continue;

    const groupNodesList: ForkNode[][] = [];
    for (const forkGroupId of forkGroupIds) {
      try {
        const groupNodes = await ForkNodesService.getGroup(forkGroupId);
        if (groupNodes.length === 0) continue;
        const cleanedGroupNodes = await pruneDeletedNodesFromGroup(
          groupNodes,
          sidebarConversationIds,
        );
        if (cleanedGroupNodes.length > 0) groupNodesList.push(cleanedGroupNodes);
      } catch {
        // Ignore single group failure and continue rendering available groups.
      }
    }
    if (groupNodesList.length === 0) continue;

    const displayNodes = buildBranchDisplayNodes(groupNodesList);
    if (displayNodes.length < 2) continue;

    // Re-check after async group loading to avoid duplicate render in concurrent injections.
    if (hasOrDedupForkIndicatorGroup(hostEl)) continue;

    const group = document.createElement('div');
    group.className = FORK_INDICATOR_GROUP_CLASS;

    for (let displayIndex = 0; displayIndex < displayNodes.length; displayIndex++) {
      const node = displayNodes[displayIndex];
      const branchNumber = displayIndex + 1;
      const isCurrent = node.conversationId === conversationId;
      const item = document.createElement('div');
      item.className = FORK_INDICATOR_ITEM_CLASS;

      const indicator = document.createElement('button');
      indicator.className = `${FORK_INDICATOR_CLASS}${isCurrent ? ' gv-current' : ''}`;
      indicator.type = 'button';
      indicator.textContent = String(branchNumber);
      indicator.title = `${getTranslationSync('forkBranch')} ${branchNumber}${
        isCurrent ? ` - ${getTranslationSync('forkCurrent')}` : ''
      }`;

      if (isCurrent) {
        indicator.setAttribute('aria-current', 'true');
        indicator.disabled = true;
      } else {
        indicator.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          navigateToForkConversation(node);
        });
      }
      item.appendChild(indicator);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = FORK_INDICATOR_DELETE_CLASS;
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = getTranslationSync('forkDeleteData');
      deleteBtn.setAttribute('aria-label', getTranslationSync('forkDeleteData'));
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const confirmed = window.confirm(getTranslationSync('forkDeleteDataConfirm'));
        if (!confirmed) return;

        deleteBtn.disabled = true;
        try {
          await ForkNodesService.removeForkNode(node.conversationId, node.turnId, node.forkGroupId);
        } catch (error) {
          if (!isExtensionContextInvalidatedError(error)) {
            console.error('[Fork] Failed to delete fork branch data:', error);
          }
        } finally {
          clearInjectedForkIndicators();
          void injectForkIndicators();
        }
      });
      item.appendChild(deleteBtn);
      group.appendChild(item);
    }

    hostEl.style.position = hostEl.style.position || 'relative';
    hostEl.appendChild(group);
  }
}

// ============================================================================
// Language Update
// ============================================================================

function updateForkButtonTexts(): void {
  const buttons = document.querySelectorAll<HTMLElement>(`.${FORK_BTN_CLASS}`);
  buttons.forEach((btn) => {
    btn.title = getTranslationSync('forkConversation');
    const span = btn.querySelector('span');
    if (span) span.textContent = getTranslationSync('forkConversation');
  });

  // Update indicator titles (sequence numbers stay the same, language labels change)
  const indicators = document.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_CLASS}`);
  indicators.forEach((ind) => {
    const branchNumber = ind.textContent?.trim();
    if (!branchNumber) return;
    const isCurrent = ind.classList.contains('gv-current');
    ind.title = `${getTranslationSync('forkBranch')} ${branchNumber}${
      isCurrent ? ` - ${getTranslationSync('forkCurrent')}` : ''
    }`;
  });

  const deleteButtons = document.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_DELETE_CLASS}`);
  deleteButtons.forEach((btn) => {
    btn.title = getTranslationSync('forkDeleteData');
    btn.setAttribute('aria-label', getTranslationSync('forkDeleteData'));
  });
}

// ============================================================================
// Module Entry Point
// ============================================================================

export function startFork(): () => void {
  injectStyles();

  // Check for pending fork data (new conversation paste)
  checkAndHandlePendingFork();

  // Inject fork buttons and indicators
  const setup = () => {
    injectForkButtons();
    void injectForkIndicators();
  };

  // Initial injection with delay to let DOM settle
  setTimeout(setup, 1000);

  // MutationObserver for dynamically loaded messages
  observer = new MutationObserver(() => {
    if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      injectForkButtons();
      void injectForkIndicators();
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Dismiss confirm dialog on click outside
  document.addEventListener('click', onDocumentClick);

  // Language change listener
  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ) => {
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      updateForkButtonTexts();
    }
    if (areaName === 'local' && changes[StorageKeys.FORK_NODES]) {
      scheduleForkIndicatorRefresh();
    }
  };
  browser.storage.onChanged.addListener(onStorageChanged);

  // Cleanup function
  return () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (observerDebounceTimer) {
      clearTimeout(observerDebounceTimer);
      observerDebounceTimer = null;
    }
    if (storageRefreshTimer) {
      clearTimeout(storageRefreshTimer);
      storageRefreshTimer = null;
    }
    clearManualUploadHint();
    dismissConfirm();
    document.removeEventListener('click', onDocumentClick);
    browser.storage.onChanged.removeListener(onStorageChanged);

    // Remove injected elements
    document.querySelectorAll(`.${FORK_BTN_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`.${FORK_INDICATOR_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`.${FORK_INDICATOR_GROUP_CLASS}`).forEach((el) => el.remove());
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  };
}
