/* Background service worker - handles cross-origin image fetch, popup opening, and sync */
import browser from 'webextension-polyfill';

import {
  type AccountPlatform,
  type AccountScope,
  accountIsolationService,
  detectAccountPlatformFromUrl,
  extractRouteUserIdFromUrl,
} from '@/core/services/AccountIsolationService';
import { googleDriveSyncService } from '@/core/services/GoogleDriveSyncService';
import {
  HighlightAnnotationError,
  getHighlightAccountHash,
  highlightAnnotationService,
} from '@/core/services/HighlightAnnotationService';
import { highlightDriveSyncCoordinator } from '@/core/services/HighlightDriveSyncCoordinator';
import { exportBackupableSyncSettings } from '@/core/services/SettingsBackupService';
import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import type {
  HighlightAccountScope,
  HighlightCreateInput,
  HighlightPlatform,
  HighlightStoredAccountScope,
  HighlightUpdatePatch,
} from '@/core/types/highlight';
import type { PromptItem, SyncAccountScope, SyncMode, SyncProvider } from '@/core/types/sync';
import {
  getVoyagerBuildTarget,
  isFirefox,
  supportsExtensionNotifications,
} from '@/core/utils/browser';
import { getNativeOpenConversationUrl } from '@/core/utils/nativeOpenConversation';
import { hasNotificationsPermission } from '@/core/utils/notificationsPermission';
import { getPromptNameConflictIds } from '@/core/utils/promptName';
import {
  SAFARI_CLIPBOARD_IMAGE_COPY_REQUEST,
  SAFARI_NATIVE_APP_ID,
  copySafariNativeImagePng,
} from '@/core/utils/safariNativeClipboard';
import {
  SAFARI_NOTIFICATION_PERMISSION_REQUEST,
  deliverSafariNativeNotification,
  prepareSafariNativeNotifications,
} from '@/core/utils/safariNativeNotifications';
import { WATERMARK_STORAGE_KEYS, resolveWatermarkSettings } from '@/core/utils/watermarkSettings';
import {
  isRemoteAnnouncementRuntimeMessage,
  startRemoteAnnouncementBackgroundService,
} from '@/features/announcements/background';
import {
  HighlightImportExportService,
  highlightImportExportService,
} from '@/features/backup/services/HighlightImportExportService';
import { PromptImportExportService } from '@/features/backup/services/PromptImportExportService';
import { computeNudgeDomains, normalizeIconResourcePath } from '@/features/plugins/promptNudge';
import {
  partitionPluginOriginPatterns,
  pluginsToOriginPatterns,
} from '@/features/plugins/runtime/siteRegistration';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import { listPluginManifests } from '@/features/plugins/sources/defaultSources';
import { loadPluginState } from '@/features/plugins/storage/pluginState';
import type { PluginManifest } from '@/features/plugins/types';
import { startStorageQuotaWarningBackgroundService } from '@/features/storageQuotaWarning/background';
import type { ForkNode, ForkNodesData } from '@/pages/content/fork/forkTypes';
import {
  filterTimelineHierarchyByRouteScope,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '@/pages/content/timeline/hierarchyStorage';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';
import { getTranslation } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { resolveOptionalHighlightSetting } from './highlightOptionalSetting';
import { isHandledBackgroundRuntimeMessage } from './runtimeMessageRouting';
import { injectWatermarkInterceptorIntoOpenTabs } from './watermarkOpenTabs';

const CUSTOM_CONTENT_SCRIPT_ID = 'gv-custom-content-script';
const PLUGIN_CONTENT_SCRIPT_ID = 'gv-plugin-content-script';
const PLUGIN_EMBEDDED_CONTENT_SCRIPT_ID = 'gv-plugin-embedded-content-script';
const CLAUDE_USAGE_MAIN_SCRIPT_ID = 'gv-plugin-claude-usage-main';
const CUSTOM_WEBSITE_KEY = 'gvPromptCustomWebsites';
const FETCH_INTERCEPTOR_SCRIPT_ID = 'gv-fetch-interceptor';
const RESPONSE_COMPLETE_OBSERVER_SCRIPT_ID = 'gv-response-complete-observer';
const RESPONSE_COMPLETE_NOTIFICATION_DEDUP_MS = 3000;
const RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_KEY =
  'responseCompleteNotificationMessage' satisfies TranslationKey;
const RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_FALLBACK = 'Gemini response complete';
const RESPONSE_COMPLETE_NOTIFICATION_TITLE = 'Gemini Voyager';
const RESPONSE_COMPLETE_NOTIFICATION_TITLE_SEPARATOR = ' - ';
const RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_SEPARATOR = ': ';
const RESPONSE_COMPLETE_NOTIFICATION_TITLE_MAX_LENGTH = 120;
const RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_MAX_LENGTH = 220;
const RESPONSE_COMPLETE_NOTIFICATION_ICON = 'icon-128.png';
const RESPONSE_COMPLETE_NOTIFICATION_ID_PREFIX = 'gv-response-complete-';
const RESPONSE_COMPLETE_UNKNOWN_TAB_ID = 'unknown';
const GENERATED_UI_CAPTURE_PERMISSION_ORIGINS = ['<all_urls>'];
const RESPONSE_COMPLETE_TURN_LABEL_PREFIXES =
  /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]*(?:you said|you wrote|user message|your prompt|you asked)[:\s]*/i;
const RETIRED_TAB_TITLE_UPDATE_SETTING = { [StorageKeys.TAB_TITLE_UPDATE_ENABLED]: false };

const responseCompleteNotificationLastShown = new Map<string, number>();
const responseCompleteNotificationTargets = new Map<
  string,
  { conversationUrl?: string; tabId?: number }
>();
let nativeOpenConversationPort: ReturnType<typeof browser.runtime.connectNative> | null = null;
const remoteAnnouncementService = startRemoteAnnouncementBackgroundService();
startStorageQuotaWarningBackgroundService();

async function disableRetiredTabTitleUpdateSetting(): Promise<void> {
  try {
    const stored = await chrome.storage.sync.get(RETIRED_TAB_TITLE_UPDATE_SETTING);
    if (stored[StorageKeys.TAB_TITLE_UPDATE_ENABLED] !== false) {
      await chrome.storage.sync.set(RETIRED_TAB_TITLE_UPDATE_SETTING);
    }
  } catch (error) {
    console.warn('[Background] Failed to disable retired tab-title sync setting:', error);
  }
}

/**
 * Resolve the new optional Highlight default exactly once.
 *
 * Existing explicit choices always win. Users with live saved highlights keep
 * the feature enabled; users who never used it start with the feature disabled.
 */
async function migrateOptionalHighlightSetting(): Promise<void> {
  try {
    const stored = await chrome.storage.sync.get(StorageKeys.HIGHLIGHT_ENABLED);
    const storedValue = stored[StorageKeys.HIGHLIGHT_ENABLED];
    if (typeof storedValue === 'boolean') return;

    const hasExistingHighlights = (await highlightAnnotationService.getAllAccounts()).length > 0;
    const resolution = resolveOptionalHighlightSetting(storedValue, hasExistingHighlights);
    if (!resolution.shouldPersist) return;
    await chrome.storage.sync.set({
      [StorageKeys.HIGHLIGHT_ENABLED]: resolution.enabled,
    });
  } catch (error) {
    console.warn('[Background] Failed to migrate optional Highlight setting:', error);
  }
}

// Gemini domains where the watermark fetch interceptor should run.
const GEMINI_FETCH_INTERCEPTOR_MATCHES = [
  'https://gemini.google.com/*',
  'https://aistudio.google.com/*',
  'https://aistudio.google.cn/*',
];

const GEMINI_RESPONSE_COMPLETE_OBSERVER_MATCHES = [
  ...GEMINI_FETCH_INTERCEPTOR_MATCHES,
  'https://business.gemini.google/*',
];

interface ResponseCompleteNotificationDetails {
  conversationUrl?: string;
  conversationTitle?: string;
  userPrompt?: string;
}

async function getInternalI18nMessage(key: TranslationKey, fallback: string): Promise<string> {
  try {
    return await getTranslation(key);
  } catch {
    // Keep Chrome's extension locale as a last resort if storage-backed i18n fails.
  }

  try {
    return chrome.i18n?.getMessage?.(key) || fallback;
  } catch {
    return fallback;
  }
}

async function openSettingsPageFallback(sourceTabId?: number): Promise<void> {
  if (typeof sourceTabId === 'number') {
    const url = chrome.runtime.getURL(`src/pages/options/index.html?sourceTabId=${sourceTabId}`);
    await chrome.tabs.create({ url });
    return;
  }

  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/options/index.html') });
}

function getTabDedupKey(
  tabId: number | undefined,
  tabUrl: string | undefined,
  conversationUrl?: string,
): string {
  return `${tabId ?? RESPONSE_COMPLETE_UNKNOWN_TAB_ID}:${conversationUrl ?? tabUrl ?? ''}`;
}

function normalizeNotificationText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(RESPONSE_COMPLETE_TURN_LABEL_PREFIXES, '');
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

async function showResponseCompleteNotification(
  sender: chrome.runtime.MessageSender,
  details: ResponseCompleteNotificationDetails,
): Promise<boolean> {
  const useSafariNativeNotification = getVoyagerBuildTarget() === 'safari';
  if (!useSafariNativeNotification && !supportsExtensionNotifications()) return false;

  const setting = await chrome.storage.sync.get({
    [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
  });
  if (setting[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] !== true) return false;

  // "notifications" is an optional permission (granted from the popup toggle);
  // the namespace check above is not reliable across grant/revoke, so verify
  // explicitly before attempting to create a notification.
  if (!useSafariNativeNotification && !(await hasNotificationsPermission())) return false;

  const conversationUrl = details.conversationUrl;
  const dedupKey = getTabDedupKey(sender.tab?.id, sender.tab?.url, conversationUrl);
  const now = Date.now();
  const lastShown = responseCompleteNotificationLastShown.get(dedupKey) ?? 0;
  if (now - lastShown < RESPONSE_COMPLETE_NOTIFICATION_DEDUP_MS) {
    return true;
  }

  responseCompleteNotificationLastShown.set(dedupKey, now);
  const notificationMessage = await getInternalI18nMessage(
    RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_KEY,
    RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_FALLBACK,
  );
  const conversationTitle = normalizeNotificationText(
    details.conversationTitle,
    RESPONSE_COMPLETE_NOTIFICATION_TITLE_MAX_LENGTH -
      RESPONSE_COMPLETE_NOTIFICATION_TITLE.length -
      RESPONSE_COMPLETE_NOTIFICATION_TITLE_SEPARATOR.length,
  );
  const userPrompt = normalizeNotificationText(
    details.userPrompt,
    RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_MAX_LENGTH -
      notificationMessage.length -
      RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_SEPARATOR.length,
  );

  try {
    const notificationId = `${RESPONSE_COMPLETE_NOTIFICATION_ID_PREFIX}${sender.tab?.id ?? RESPONSE_COMPLETE_UNKNOWN_TAB_ID}-${now}`;
    const title = conversationTitle
      ? `${RESPONSE_COMPLETE_NOTIFICATION_TITLE}${RESPONSE_COMPLETE_NOTIFICATION_TITLE_SEPARATOR}${conversationTitle}`
      : RESPONSE_COMPLETE_NOTIFICATION_TITLE;
    const message = userPrompt
      ? `${notificationMessage}${RESPONSE_COMPLETE_NOTIFICATION_MESSAGE_SEPARATOR}${userPrompt}`
      : notificationMessage;

    if (useSafariNativeNotification) {
      return await deliverSafariNativeNotification({
        id: notificationId,
        title,
        body: message,
        url: conversationUrl,
      });
    }

    responseCompleteNotificationTargets.set(notificationId, {
      conversationUrl,
      tabId: sender.tab?.id,
    });
    await browser.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(RESPONSE_COMPLETE_NOTIFICATION_ICON),
      title,
      message,
    });
    return true;
  } catch (error) {
    console.warn('[Background] Failed to show response completion notification:', error);
    return false;
  }
}

async function focusOrOpenConversation(url: URL): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    const match = tabs.find((tab) => {
      if (typeof tab.url !== 'string' || typeof tab.id !== 'number') return false;
      try {
        const tabUrl = new URL(tab.url);
        return tabUrl.origin === url.origin && tabUrl.pathname === url.pathname;
      } catch {
        return false;
      }
    });

    if (match && typeof match.id === 'number') {
      const tab = await browser.tabs.update(match.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await browser.windows.update(tab.windowId, { focused: true });
      }
      return;
    }
  } catch {
    // Fall through to opening a fresh tab.
  }

  await browser.tabs.create({ url: url.toString() });
}

// App-dispatched messages (SFSafariApplication.dispatchMessage) are delivered
// only through a native-messaging port the background opens first — they never
// arrive via runtime.onMessage. See "Messaging between the app and JavaScript
// in a Safari web extension" in the Apple docs.
function connectNativeOpenConversationPort(): void {
  try {
    const port = browser.runtime.connectNative(SAFARI_NATIVE_APP_ID);
    nativeOpenConversationPort = port;
    port.onMessage.addListener((message: unknown) => {
      const url = getNativeOpenConversationUrl(message);
      if (url) void focusOrOpenConversation(url);
    });
    port.onDisconnect.addListener(() => {
      if (nativeOpenConversationPort === port) nativeOpenConversationPort = null;
      setTimeout(connectNativeOpenConversationPort, 1000);
    });
  } catch {
    // Native host unavailable (extension running without the containing app);
    // notification clicks fall back to the app's openWindow path.
    nativeOpenConversationPort = null;
  }
}

if (getVoyagerBuildTarget() === 'safari') {
  connectNativeOpenConversationPort();
}

function getResponseCompleteNotificationTabId(notificationId: string): number | undefined {
  const match = new RegExp(`^${RESPONSE_COMPLETE_NOTIFICATION_ID_PREFIX}(\\d+)-`).exec(
    notificationId,
  );
  if (!match) return undefined;
  const tabId = Number(match[1]);
  return Number.isFinite(tabId) ? tabId : undefined;
}

async function openResponseCompleteNotification(notificationId: string): Promise<void> {
  const target = responseCompleteNotificationTargets.get(notificationId);
  responseCompleteNotificationTargets.delete(notificationId);

  try {
    await browser.notifications.clear(notificationId);
  } catch {}

  const tabId = target?.tabId ?? getResponseCompleteNotificationTabId(notificationId);
  if (typeof tabId === 'number') {
    try {
      const tab = await browser.tabs.update(tabId, { active: true });
      if (typeof tab.windowId === 'number') {
        await browser.windows.update(tab.windowId, { focused: true });
      }
      return;
    } catch {
      // Fall through to opening the saved URL if the tab was closed.
    }
  }

  if (target?.conversationUrl) {
    await browser.tabs.create({ url: target.conversationUrl });
  }
}

chrome.notifications?.onClicked?.addListener?.((notificationId) => {
  if (!notificationId.startsWith(RESPONSE_COMPLETE_NOTIFICATION_ID_PREFIX)) return;
  void openResponseCompleteNotification(notificationId);
});

function isStarredMessagesData(value: unknown): value is StarredMessagesData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { messages?: unknown };
  if (typeof data.messages !== 'object' || data.messages === null) return false;
  const messages = data.messages as Record<string, unknown>;
  return Object.values(messages).every((v) => Array.isArray(v));
}

function isForkNodesData(value: unknown): value is ForkNodesData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { nodes?: unknown; groups?: unknown };
  return (
    typeof data.nodes === 'object' &&
    data.nodes !== null &&
    typeof data.groups === 'object' &&
    data.groups !== null
  );
}

function isSyncAccountScope(value: unknown): value is SyncAccountScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.accountKey === 'string' &&
    typeof scope.accountId === 'number' &&
    Number.isFinite(scope.accountId) &&
    (typeof scope.routeUserId === 'string' || scope.routeUserId === null)
  );
}

function toSyncAccountScope(scope: AccountScope): SyncAccountScope {
  return {
    accountKey: scope.accountKey,
    accountId: scope.accountId,
    routeUserId: scope.routeUserId,
  };
}

function isHighlightPlatform(value: unknown): value is HighlightPlatform {
  return value === 'gemini' || value === 'aistudio';
}

function isHighlightAccountScope(value: unknown): value is HighlightAccountScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    isHighlightPlatform(scope.platform) &&
    typeof scope.accountKey === 'string' &&
    typeof scope.accountId === 'number' &&
    Number.isFinite(scope.accountId) &&
    (typeof scope.routeUserId === 'string' || scope.routeUserId === null)
  );
}

function isHighlightStoredAccountScope(value: unknown): value is HighlightStoredAccountScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return isHighlightPlatform(scope.platform) && typeof scope.accountHash === 'string';
}

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.tab || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  try {
    return sender.url.startsWith(chrome.runtime.getURL(''));
  } catch {
    return false;
  }
}

async function resolveHighlightAccountScope(
  sender: chrome.runtime.MessageSender,
  payload: Record<string, unknown> | undefined,
): Promise<HighlightAccountScope> {
  if (isHighlightAccountScope(payload?.scope)) return payload.scope;

  const pageUrl =
    (typeof payload?.pageUrl === 'string' && payload.pageUrl) ||
    (typeof payload?.conversationUrl === 'string' && payload.conversationUrl) ||
    sender.tab?.url ||
    null;
  const detectedPlatform = detectAccountPlatformFromUrl(pageUrl);
  const platform = isHighlightPlatform(payload?.platform)
    ? payload.platform
    : detectedPlatform === 'aistudio'
      ? 'aistudio'
      : 'gemini';
  const scope = await accountIsolationService.resolveAccountScope({ pageUrl });
  return {
    platform,
    accountKey: scope.accountKey,
    accountId: scope.accountId,
    routeUserId: scope.routeUserId,
  };
}

function shouldKeepHighlightTombstones(platform: HighlightPlatform): boolean {
  // Gemini records may already exist in Drive even when the user temporarily
  // turns sync off. A compact tombstone prevents a later pull from reviving a
  // deletion. AI Studio has no highlight Drive sync, so it can hard-delete.
  return platform === 'gemini';
}

async function isHighlightCloudSyncRequested(
  platform: 'gemini' | 'aistudio',
  explicitlyIncluded: boolean,
): Promise<boolean> {
  if (platform !== 'gemini') return false;
  if (explicitlyIncluded) return true;
  try {
    const stored = await chrome.storage.local.get({
      [StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED]: true,
    });
    return stored[StorageKeys.HIGHLIGHT_CLOUD_SYNC_ENABLED] !== false;
  } catch {
    return false;
  }
}

async function notifyHighlightChanged(
  scope: HighlightStoredAccountScope,
  conversationId?: string,
): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const targets = tabs.filter((tab) => {
      if (typeof tab.id !== 'number' || !tab.url) return false;
      try {
        const hostname = new URL(tab.url).hostname;
        return (
          hostname === 'gemini.google.com' ||
          hostname === 'aistudio.google.com' ||
          hostname === 'aistudio.google.cn'
        );
      } catch {
        return false;
      }
    });
    await Promise.allSettled(
      targets.map((tab) =>
        chrome.tabs.sendMessage(tab.id as number, {
          type: 'gv.highlight.changed',
          payload: { ...scope, conversationId },
        }),
      ),
    );
  } catch {
    // Storage listeners and route reloads remain safe fallbacks.
  }
}

function highlightErrorResponse(error: unknown): { ok: false; error: string; code?: string } {
  if (error instanceof HighlightAnnotationError) {
    return { ok: false, error: error.message, code: error.code };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function resolveAccountScopeForMessage(
  sender: chrome.runtime.MessageSender,
  platform: AccountPlatform,
  explicitScope?: SyncAccountScope,
): Promise<SyncAccountScope | null> {
  const enabled = await accountIsolationService.isIsolationEnabled({
    platform,
    pageUrl: sender.tab?.url ?? null,
  });
  if (!enabled) return null;
  if (explicitScope) return explicitScope;

  const resolved = await accountIsolationService.resolveAccountScope({
    pageUrl: sender.tab?.url ?? null,
  });
  return toSyncAccountScope(resolved);
}

function matchesRouteScope(url: string, routeUserId: string | null): boolean {
  if (!routeUserId) return true;
  const routeFromUrl = extractRouteUserIdFromUrl(url);
  return routeFromUrl === null || routeFromUrl === routeUserId;
}

function filterStarredByRouteScope(
  data: StarredMessagesData,
  routeUserId: string | null,
): StarredMessagesData {
  if (!routeUserId) return data;

  const filteredEntries = Object.entries(data.messages).map(([conversationId, messages]) => {
    const filteredMessages = messages.filter((message) =>
      matchesRouteScope(message.conversationUrl, routeUserId),
    );
    return [conversationId, filteredMessages] as const;
  });

  const filteredMessages = Object.fromEntries(
    filteredEntries.filter((entry) => entry[1].length > 0),
  );
  return { messages: filteredMessages };
}

function filterForkNodesByRouteScope(
  data: ForkNodesData,
  routeUserId: string | null,
): ForkNodesData {
  if (!routeUserId) return data;

  const filteredNodes: Record<string, ForkNode[]> = {};
  for (const [conversationId, nodes] of Object.entries(data.nodes)) {
    const filtered = nodes.filter((node) => matchesRouteScope(node.conversationUrl, routeUserId));
    if (filtered.length > 0) {
      filteredNodes[conversationId] = filtered;
    }
  }

  const filteredGroups: Record<string, string[]> = {};
  for (const nodes of Object.values(filteredNodes)) {
    for (const node of nodes) {
      if (!filteredGroups[node.forkGroupId]) {
        filteredGroups[node.forkGroupId] = [];
      }
      const key = `${node.conversationId}:${node.turnId}`;
      if (!filteredGroups[node.forkGroupId].includes(key)) {
        filteredGroups[node.forkGroupId].push(key);
      }
    }
  }

  return {
    nodes: filteredNodes,
    groups: filteredGroups,
  };
}

/**
 * Register the fetch interceptor script into MAIN world
 * This allows intercepting fetch calls made by the page itself
 */
async function doRegisterFetchInterceptor(injectOpenTabs: boolean): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;

  // Safari ships the interceptor as a static MAIN-world content script. A
  // dynamic copy can outlive a rebuilt temporary extension and win the
  // double-injection guard with stale code.
  if (getVoyagerBuildTarget() === 'safari') {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [FETCH_INTERCEPTOR_SCRIPT_ID] });
    } catch {
      // No-op if an older Safari build never registered it.
    }
    return;
  }

  // The fetch interceptor only matters for the download path. Preview-time
  // watermark removal happens in the content script and never touches fetch.
  const result = await chrome.storage.sync.get([...WATERMARK_STORAGE_KEYS]);
  const { download: downloadEnabled } = resolveWatermarkSettings(result);

  try {
    // Always unregister first to update settings
    await chrome.scripting.unregisterContentScripts({ ids: [FETCH_INTERCEPTOR_SCRIPT_ID] });
  } catch {
    // No-op if script was not registered
  }

  if (!downloadEnabled) {
    console.log('[Background] Fetch interceptor not registered (download path disabled)');
    return;
  }

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: FETCH_INTERCEPTOR_SCRIPT_ID,
        js: ['fetchInterceptor.js'],
        matches: GEMINI_FETCH_INTERCEPTOR_MATCHES,
        world: 'MAIN',
        runAt: 'document_start',
        persistAcrossSessions: true,
      },
    ]);
    console.log('[Background] Fetch interceptor registered for MAIN world');
    if (injectOpenTabs) {
      await injectWatermarkInterceptorIntoOpenTabs(GEMINI_FETCH_INTERCEPTOR_MATCHES);
    }
  } catch (error) {
    console.error('[Background] Failed to register fetch interceptor:', error);
  }
}

// Serialize startup and storage-triggered syncs so rapid toggle changes cannot
// leave an older registration result as the final state.
let fetchInterceptorRegistrationQueue: Promise<void> = Promise.resolve();

function registerFetchInterceptor(injectOpenTabs = false): Promise<void> {
  const next = fetchInterceptorRegistrationQueue.then(() =>
    doRegisterFetchInterceptor(injectOpenTabs),
  );
  fetchInterceptorRegistrationQueue = next.catch(() => {});
  return next;
}

async function unregisterResponseCompleteObserver(): Promise<void> {
  if (!chrome.scripting?.unregisterContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [RESPONSE_COMPLETE_OBSERVER_SCRIPT_ID],
    });
  } catch {
    // No-op if script was not registered
  }
}

async function syncResponseCompleteObserverRegistration(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;

  await unregisterResponseCompleteObserver();

  // Firefox supports the MAIN world for registered content scripts only in
  // newer versions than this extension's Firefox minimum. Safari already has
  // this observer as a manifest MAIN-world script so page CSP cannot block it.
  if (isFirefox() || getVoyagerBuildTarget() === 'safari') return;

  const setting = await chrome.storage.sync.get({
    [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: false,
  });
  if (setting[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] !== true) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: RESPONSE_COMPLETE_OBSERVER_SCRIPT_ID,
        js: ['response-complete-observer.js'],
        matches: GEMINI_RESPONSE_COMPLETE_OBSERVER_MATCHES,
        world: 'MAIN',
        runAt: 'document_start',
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    console.error('[Background] Failed to register response complete observer:', error);
  }
}

const MANIFEST_DEFAULT_DOMAINS = new Set(
  [
    ...(chrome.runtime.getManifest().host_permissions || []),
    ...(chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches || []) || []),
  ]
    .map(patternToDomain)
    .filter((d): d is string => !!d),
);

// Domains targeted by plugins. Granting one of these (when a user
// enables a plugin) must NOT also register it as a Prompt-Manager "custom
// website", so we exclude them from the permissions.onAdded → custom-website
// merge below. Populated asynchronously from the cached catalog (see
// refreshPluginSiteDomains).
let pluginSiteDomains = new Set<string>();

async function loadPluginCatalog(): Promise<readonly PluginManifest[]> {
  try {
    return await listPluginManifests();
  } catch {
    return [];
  }
}

async function refreshPluginSiteDomains(): Promise<void> {
  const catalog = await loadPluginCatalog();
  pluginSiteDomains = new Set(
    pluginsToOriginPatterns(catalog)
      .map(patternToDomain)
      .filter((d): d is string => !!d),
  );
}

function patternToDomain(pattern: string | undefined): string | null {
  if (!pattern) return null;
  try {
    const withoutScheme = pattern.replace(/^[^:]+:\/\//, '');
    const hostPart = withoutScheme.replace(/\/.*$/, '').replace(/^\*\./, '');
    if (!hostPart || hostPart === '*') return null;
    return hostPart;
  } catch {
    return null;
  }
}

function toMatchPatterns(domain: string): string[] {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');

  if (!normalized) return [];
  return [`https://*.${normalized}/*`, `http://*.${normalized}/*`];
}

function toRelativeExtensionPath(resource: string): string {
  try {
    const url = new URL(resource);
    if (url.protocol === 'moz-extension:') {
      return url.pathname.replace(/^\/+/, '');
    }
  } catch {
    // Not an absolute extension URL; fall through.
  }

  return resource.replace(/^\/+/, '');
}

function extractDomainsFromOrigins(origins?: string[]): string[] {
  if (!Array.isArray(origins)) return [];
  const domains = origins
    .map(patternToDomain)
    .filter((d): d is string => !!d)
    .filter((d) => !MANIFEST_DEFAULT_DOMAINS.has(d))
    .filter((d) => !pluginSiteDomains.has(d));
  return Array.from(new Set(domains));
}

async function filterGrantedOrigins(patterns: string[]): Promise<string[]> {
  const granted: string[] = [];

  for (const origin of patterns) {
    try {
      const hasPermission = await browser.permissions.contains({ origins: [origin] });
      if (hasPermission) {
        granted.push(origin);
      }
    } catch (error) {
      console.warn('[Background] Failed to check permission for', origin, error);
    }
  }

  return granted;
}

async function syncCustomContentScripts(domains?: string[]): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;

  const manifestContentScript = chrome.runtime.getManifest().content_scripts?.[0];
  if (!manifestContentScript) return;

  const domainList =
    domains ??
    (
      await chrome.storage.sync.get({
        [CUSTOM_WEBSITE_KEY]: [],
      })
    )[CUSTOM_WEBSITE_KEY];

  const matchPatterns = Array.from(
    new Set((Array.isArray(domainList) ? domainList : []).flatMap(toMatchPatterns).filter(Boolean)),
  );

  const grantedMatches = await filterGrantedOrigins(matchPatterns);

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_CONTENT_SCRIPT_ID] });
  } catch {
    // No-op if script was not registered
  }

  if (!grantedMatches.length) return;

  const runAt =
    manifestContentScript.run_at === 'document_start'
      ? 'document_start'
      : manifestContentScript.run_at === 'document_end'
        ? 'document_end'
        : 'document_idle';

  const jsResources = isFirefox()
    ? (manifestContentScript.js || []).map(toRelativeExtensionPath)
    : manifestContentScript.js || [];
  const cssResources = isFirefox()
    ? manifestContentScript.css?.map(toRelativeExtensionPath)
    : manifestContentScript.css;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: CUSTOM_CONTENT_SCRIPT_ID,
        js: jsResources,
        css: cssResources,
        matches: grantedMatches,
        allFrames: manifestContentScript.all_frames,
        runAt,
        persistAcrossSessions: true,
      },
    ]);
    console.log('[Background] Custom content scripts registered for', grantedMatches);
  } catch (error) {
    console.error('[Background] Failed to register custom content scripts:', error);
  }
}

/**
 * Plugin ecosystem — dynamic content-script registration.
 *
 * Mirrors syncCustomContentScripts: derive the origins of currently-ENABLED
 * plugins, keep only those the user has already granted host permission
 * for, and (re)register the content script for them. The content script runs
 * `startPluginHost()`, which mounts the enabled plugin on the page.
 *
 * Plugin enable-state is the single source of truth (storage.local); permissions
 * and registrations are derived from it.
 */
async function getEnabledPluginOrigins(): Promise<string[]> {
  let state: unknown = {};
  try {
    const stored = await chrome.storage.local.get({ [StorageKeys.PLUGINS_STATE]: {} });
    state = stored?.[StorageKeys.PLUGINS_STATE];
  } catch {
    return [];
  }
  const enabledIds = new Set<string>();
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    for (const [id, entry] of Object.entries(state as Record<string, { enabled?: boolean }>)) {
      if (entry && entry.enabled === true) enabledIds.add(id);
    }
  }
  const catalog = await loadPluginCatalog();
  const enabledPlugins = catalog.filter((plugin) => enabledIds.has(plugin.id));
  return pluginsToOriginPatterns(enabledPlugins);
}

/**
 * A live Voyager content script answers this ping. Orphaned scripts (extension
 * updated/reloaded underneath the page) have an invalidated runtime and cannot
 * respond, so they correctly read as "not injected".
 */
async function hasLiveVoyagerContentScript(tabId: number, frameId?: number): Promise<boolean> {
  try {
    const message = { type: 'gv.content.ping' };
    const response = (
      frameId === undefined
        ? await browser.tabs.sendMessage(tabId, message)
        : await browser.tabs.sendMessage(tabId, message, { frameId })
    ) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function getMatchingFrameIds(tabId: number, matches: readonly string[]): Promise<number[]> {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    return frames.flatMap((frame) =>
      typeof frame.result === 'string' && matchesAnyPattern(frame.result, matches)
        ? [frame.frameId]
        : [],
    );
  } catch {
    // Never substitute the parent frame for an unresolvable companion frame.
    // The persistent registration will cover it on the next navigation/reload.
    return [];
  }
}

async function injectPluginScriptIntoOpenTabs(
  tabMatches: string[],
  frameMatches: string[] | undefined,
  jsResources: string[],
  cssResources: string[] | undefined,
): Promise<void> {
  if (!chrome.scripting?.executeScript || !tabMatches.length) return;
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: tabMatches });
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const frameIds = frameMatches ? await getMatchingFrameIds(tab.id, frameMatches) : [0];
      const missingFrameIds: number[] = [];
      for (const frameId of frameIds) {
        // insertCSS APPENDS a fresh copy on every call. Check every matching
        // frame independently so an already-live Claude parent does not prevent
        // first-time injection into its artifact child frame.
        if (!(await hasLiveVoyagerContentScript(tab.id, frameId))) missingFrameIds.push(frameId);
      }
      if (!missingFrameIds.length) continue;
      const target = { tabId: tab.id, frameIds: missingFrameIds };
      if (cssResources?.length) {
        await chrome.scripting.insertCSS({ target, files: cssResources });
      }
      if (jsResources.length) {
        await chrome.scripting.executeScript({ target, files: jsResources });
      }
    } catch {
      // Tab may be discarded or disallow injection — ignore; reload will cover it.
    }
  }
}

// Serialized: concurrent syncs (storage listener + permission events) would
// otherwise race the ping-then-inject sequence and double-inject.
let pluginContentScriptSyncQueue: Promise<void> = Promise.resolve();

function syncPluginContentScripts(): Promise<void> {
  const next = pluginContentScriptSyncQueue.then(() => doSyncPluginContentScripts());
  pluginContentScriptSyncQueue = next.catch(() => {});
  return next;
}

async function doSyncPluginContentScripts(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;

  const manifestContentScript = chrome.runtime.getManifest().content_scripts?.[0];
  if (!manifestContentScript) return;

  const origins = await getEnabledPluginOrigins();
  const grantedMatches = await filterGrantedOrigins(origins);

  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [
        PLUGIN_CONTENT_SCRIPT_ID,
        PLUGIN_EMBEDDED_CONTENT_SCRIPT_ID,
        CLAUDE_USAGE_MAIN_SCRIPT_ID,
      ],
    });
  } catch {
    // No-op if the script was not registered.
  }

  if (!grantedMatches.length) return;

  const runAt =
    manifestContentScript.run_at === 'document_start'
      ? 'document_start'
      : manifestContentScript.run_at === 'document_end'
        ? 'document_end'
        : 'document_idle';

  const jsResources = isFirefox()
    ? (manifestContentScript.js || []).map(toRelativeExtensionPath)
    : manifestContentScript.js || [];
  const cssResources = isFirefox()
    ? manifestContentScript.css?.map(toRelativeExtensionPath)
    : manifestContentScript.css;
  const { topFrameOrigins, embeddedFrameOrigins } = partitionPluginOriginPatterns(grantedMatches);

  try {
    const registrations: chrome.scripting.RegisteredContentScript[] = [];
    if (topFrameOrigins.length) {
      registrations.push({
        id: PLUGIN_CONTENT_SCRIPT_ID,
        js: jsResources,
        css: cssResources,
        matches: topFrameOrigins,
        allFrames: false,
        runAt,
        persistAcrossSessions: true,
      });
    }
    if (embeddedFrameOrigins.length) {
      registrations.push({
        id: PLUGIN_EMBEDDED_CONTENT_SCRIPT_ID,
        js: jsResources,
        css: cssResources,
        matches: embeddedFrameOrigins,
        allFrames: true,
        runAt,
        persistAcrossSessions: true,
      });
    }
    if (registrations.length) {
      await chrome.scripting.registerContentScripts(registrations);
    }
    // Inject into already-open matching tabs so the user sees the effect without
    // a manual reload.
    await injectPluginScriptIntoOpenTabs(topFrameOrigins, undefined, jsResources, cssResources);
    if (embeddedFrameOrigins.length) {
      await injectPluginScriptIntoOpenTabs(
        grantedMatches,
        embeddedFrameOrigins,
        jsResources,
        cssResources,
      );
    }
  } catch (error) {
    console.error('[Background] Failed to register plugin content scripts:', error);
  }
}

// --- Prompt Manager discovery nudge (Chrome/Edge only) ----------------------
// On plugin-capable third-party sites (ChatGPT / Claude) Voyager has no host
// access until the user turns the Prompt Manager on, so it stays at "No access
// needed" and cannot run any code on the page. To still hint that Voyager
// supports the site, paint a small dot on the toolbar icon while the user is on
// such a site and has not enabled it yet. declarativeContent matches the URL
// inside Chrome (no host permission, preserves "No access needed") and only
// exposes SetIcon (no badge action), so the dot is baked into the icon via
// OffscreenCanvas. chrome.declarativeContent is absent on Firefox/Safari, where
// this whole feature safely no-ops.
const NUDGE_ICON_SIZES = [16, 32] as const;
const NUDGE_DOT_COLOR = '#e5484d';
let cachedNudgeIcon: { [size: string]: ImageData } | null = null;

function collectBaseIconCandidates(): string[] {
  const manifest = chrome.runtime.getManifest() as {
    action?: { default_icon?: string | { [key: string]: string } };
    icons?: { [key: string]: string };
  };
  const candidates = new Set<string>();
  const actionIcon = manifest.action?.default_icon;
  if (typeof actionIcon === 'string') {
    candidates.add(normalizeIconResourcePath(actionIcon));
  } else if (actionIcon) {
    for (const value of Object.values(actionIcon)) {
      candidates.add(normalizeIconResourcePath(value));
    }
  }
  if (manifest.icons) {
    for (const value of Object.values(manifest.icons)) {
      candidates.add(normalizeIconResourcePath(value));
    }
  }
  return Array.from(candidates);
}

async function loadBaseIconBitmap(): Promise<ImageBitmap | null> {
  for (const candidate of collectBaseIconCandidates()) {
    try {
      const response = await fetch(chrome.runtime.getURL(candidate));
      if (!response.ok) continue;
      return await createImageBitmap(await response.blob());
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function buildNudgeIcon(): Promise<{ [size: string]: ImageData } | null> {
  if (cachedNudgeIcon) return cachedNudgeIcon;
  if (typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await loadBaseIconBitmap();
  if (!bitmap) return null;

  const icon: { [size: string]: ImageData } = {};
  for (const size of NUDGE_ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0, size, size);

    const radius = size * 0.24;
    const cx = size - radius - size * 0.04;
    const cy = radius + size * 0.04;
    // White ring keeps the dot legible on any icon background.
    ctx.beginPath();
    ctx.arc(cx, cy, radius + Math.max(1, size * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = NUDGE_DOT_COLOR;
    ctx.fill();

    icon[String(size)] = ctx.getImageData(0, 0, size, size);
  }
  bitmap.close();
  cachedNudgeIcon = icon;
  return icon;
}

async function getEnabledCustomWebsites(): Promise<Set<string>> {
  try {
    const stored = await browser.storage.sync.get({ [CUSTOM_WEBSITE_KEY]: [] });
    const value = stored[CUSTOM_WEBSITE_KEY];
    if (!Array.isArray(value)) return new Set();
    return new Set(value.map((domain) => String(domain).toLowerCase()));
  } catch {
    return new Set();
  }
}

async function syncPromptNudgeIcon(): Promise<void> {
  if (!chrome.declarativeContent?.onPageChanged) return;

  const removeAll = () =>
    new Promise<void>((resolve) => {
      chrome.declarativeContent.onPageChanged.removeRules(undefined, () => resolve());
    });

  try {
    const enabled = await getEnabledCustomWebsites();
    const nudgeDomains = computeNudgeDomains(pluginSiteDomains, enabled);

    await removeAll();
    if (nudgeDomains.length === 0) return;

    const icon = await buildNudgeIcon();
    if (!icon) return;

    const conditions = nudgeDomains.flatMap((domain) => [
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostEquals: domain, schemes: ['https'] },
      }),
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostSuffix: `.${domain}`, schemes: ['https'] },
      }),
    ]);

    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions,
        actions: [new chrome.declarativeContent.SetIcon({ imageData: icon })],
      },
    ]);
  } catch (error) {
    console.warn('[Background] Failed to sync Prompt Manager nudge icon:', error);
  }
}

// Initial sync for persisted permissions
void disableRetiredTabTitleUpdateSetting();
void migrateOptionalHighlightSetting();
void cleanupLegacyGeneratedUiCapturePermission();
void syncCustomContentScripts();
void syncPluginContentScripts();
void refreshPluginSiteDomains().then(() => {
  void syncPromptNudgeIcon();
});

// Initial fetch interceptor registration
void registerFetchInterceptor();

// Initial response completion observer registration
void syncResponseCompleteObserverRegistration();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;

  if (
    Object.prototype.hasOwnProperty.call(changes, StorageKeys.TAB_TITLE_UPDATE_ENABLED) &&
    changes[StorageKeys.TAB_TITLE_UPDATE_ENABLED]?.newValue !== false
  ) {
    void disableRetiredTabTitleUpdateSetting();
  }

  if (Object.prototype.hasOwnProperty.call(changes, CUSTOM_WEBSITE_KEY)) {
    const newValue = changes[CUSTOM_WEBSITE_KEY]?.newValue;
    const domains = Array.isArray(newValue) ? newValue : [];
    void syncCustomContentScripts(domains);
    // Enabling/disabling a site flips whether it should still show the nudge dot.
    void syncPromptNudgeIcon();
  }

  // Re-register fetch interceptor when any watermark-related key changes.
  // (Only the download flag actually affects registration, but we also watch
  // the legacy key so a one-time migration write triggers re-registration.)
  if (WATERMARK_STORAGE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
    void registerFetchInterceptor(true);
  }

  if (
    Object.prototype.hasOwnProperty.call(
      changes,
      StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED,
    )
  ) {
    void syncResponseCompleteObserverRegistration();
  }
});

// Plugin ecosystem: re-reconcile dynamic registration when the set of enabled
// plugins changes. Plugin state lives in storage.local (not sync).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (Object.prototype.hasOwnProperty.call(changes, StorageKeys.PLUGINS_STATE)) {
    void syncPluginContentScripts();
  }
});

chrome.permissions.onAdded.addListener(({ origins }) => {
  void (async () => {
    // Refresh the plugin-site set FIRST so a freshly-granted plugin origin
    // (e.g. claude.ai / chatgpt.com) is reliably excluded from the Prompt-Manager
    // custom-website list. Otherwise onAdded can fire before the initial async
    // refresh has populated `pluginSiteDomains`, racing a plugin site into the
    // custom-website list.
    await refreshPluginSiteDomains();

    const domains = extractDomainsFromOrigins(origins);
    if (domains.length) {
      try {
        const current = await browser.storage.sync.get({ [CUSTOM_WEBSITE_KEY]: [] });
        const existing = Array.isArray(current[CUSTOM_WEBSITE_KEY])
          ? current[CUSTOM_WEBSITE_KEY]
          : [];
        const merged = Array.from(new Set([...existing, ...domains]));
        if (merged.length !== existing.length) {
          await browser.storage.sync.set({ [CUSTOM_WEBSITE_KEY]: merged });
        }
      } catch (error) {
        console.warn('[Background] Failed to persist domains from permissions.onAdded:', error);
      }
    }

    // A granted origin may belong to an enabled plugin — (re)register both the
    // custom-website and the plugin content scripts for newly-granted origins.
    await syncCustomContentScripts();
    await syncPluginContentScripts();
    // The freshly-granted site is now enabled, so it should no longer be nudged.
    await syncPromptNudgeIcon();
  })();
});

chrome.permissions.onRemoved.addListener(() => {
  void syncCustomContentScripts();
  // Keep plugin content-script registrations in sync when a site's host
  // permission is revoked from the browser UI — filterGrantedOrigins will now
  // drop the revoked origin, so the stale plugin registration is removed.
  void syncPluginContentScripts();
  // A revoked plugin site becomes eligible for the nudge dot again.
  void syncPromptNudgeIcon();
});

/**
 * Centralized starred messages management to prevent race conditions.
 * All read-modify-write operations are serialized through this background script.
 */
class StarredMessagesManager {
  private operationQueue: Promise<unknown> = Promise.resolve();

  /**
   * Serialize all operations to prevent race conditions
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationQueue.then(operation, operation);
    this.operationQueue = promise.catch(() => {}); // Prevent error propagation
    return promise;
  }

  private async getFromStorage(): Promise<StarredMessagesData> {
    try {
      const result = await chrome.storage.local.get([StorageKeys.TIMELINE_STARRED_MESSAGES]);
      const starred = result[StorageKeys.TIMELINE_STARRED_MESSAGES];
      return isStarredMessagesData(starred) ? starred : { messages: {} };
    } catch (error) {
      console.error('[Background] Failed to get starred messages:', error);
      return { messages: {} };
    }
  }

  private async saveToStorage(data: StarredMessagesData): Promise<void> {
    await chrome.storage.local.set({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: data });
  }

  async addStarredMessage(message: StarredMessage): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (!data.messages[message.conversationId]) {
        data.messages[message.conversationId] = [];
      }

      // Check if message already exists
      const exists = data.messages[message.conversationId].some((m) => m.turnId === message.turnId);

      if (!exists) {
        // Truncate content to save storage space
        // Popup is ~360px wide with line-clamp-2, showing ~50-60 chars max
        const MAX_CONTENT_LENGTH = 60;
        const truncatedMessage: StarredMessage = {
          ...message,
          content:
            message.content.length > MAX_CONTENT_LENGTH
              ? message.content.slice(0, MAX_CONTENT_LENGTH) + '...'
              : message.content,
        };
        data.messages[message.conversationId].push(truncatedMessage);
        await this.saveToStorage(data);
        return true;
      }
      return false;
    });
  }

  async removeStarredMessage(conversationId: string, turnId: string): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (data.messages[conversationId]) {
        const initialLength = data.messages[conversationId].length;
        data.messages[conversationId] = data.messages[conversationId].filter(
          (m) => m.turnId !== turnId,
        );

        if (data.messages[conversationId].length < initialLength) {
          // Remove conversation key if no messages left
          if (data.messages[conversationId].length === 0) {
            delete data.messages[conversationId];
          }

          await this.saveToStorage(data);
          return true;
        }
      }
      return false;
    });
  }

  async getAllStarredMessages(): Promise<StarredMessagesData> {
    return this.getFromStorage();
  }

  async getStarredMessagesForConversation(conversationId: string): Promise<StarredMessage[]> {
    const data = await this.getFromStorage();
    return data.messages[conversationId] || [];
  }

  async isMessageStarred(conversationId: string, turnId: string): Promise<boolean> {
    const messages = await this.getStarredMessagesForConversation(conversationId);
    return messages.some((m) => m.turnId === turnId);
  }

  async reconcileConversationIds(
    targetConversationId: string,
    sourceConversationIds: string[],
    conversationUrl?: string,
  ): Promise<StarredMessage[]> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      const uniqueConversationIds = Array.from(
        new Set([targetConversationId, ...sourceConversationIds]),
      ).filter(Boolean);

      const mergedMessages = new Map<string, StarredMessage>();

      for (const conversationId of uniqueConversationIds) {
        const messages = data.messages[conversationId] || [];
        for (const message of messages) {
          const normalizedMessage: StarredMessage = {
            ...message,
            conversationId: targetConversationId,
            conversationUrl: conversationUrl || message.conversationUrl,
          };
          const existing = mergedMessages.get(message.turnId);
          if (!existing || normalizedMessage.starredAt >= existing.starredAt) {
            mergedMessages.set(message.turnId, normalizedMessage);
          }
        }
      }

      if (mergedMessages.size > 0) {
        data.messages[targetConversationId] = Array.from(mergedMessages.values());
      } else {
        delete data.messages[targetConversationId];
      }

      for (const conversationId of uniqueConversationIds) {
        if (conversationId !== targetConversationId) {
          delete data.messages[conversationId];
        }
      }

      await this.saveToStorage(data);
      return data.messages[targetConversationId] || [];
    });
  }
}

const starredMessagesManager = new StarredMessagesManager();

/**
 * Centralized fork nodes management to prevent race conditions.
 * All read-modify-write operations are serialized through this background script.
 */
class ForkNodesManager {
  private operationQueue: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationQueue.then(operation, operation);
    this.operationQueue = promise.catch(() => {});
    return promise;
  }

  private async getFromStorage(): Promise<ForkNodesData> {
    try {
      const result = await chrome.storage.local.get([StorageKeys.FORK_NODES]);
      const forkNodes = result[StorageKeys.FORK_NODES];
      return isForkNodesData(forkNodes) ? forkNodes : { nodes: {}, groups: {} };
    } catch (error) {
      console.error('[Background] Failed to get fork nodes:', error);
      return { nodes: {}, groups: {} };
    }
  }

  private async saveToStorage(data: ForkNodesData): Promise<void> {
    await chrome.storage.local.set({ [StorageKeys.FORK_NODES]: data });
  }

  async addForkNode(node: ForkNode): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (!data.nodes[node.conversationId]) {
        data.nodes[node.conversationId] = [];
      }

      const exists = data.nodes[node.conversationId].some(
        (n) => n.turnId === node.turnId && n.forkGroupId === node.forkGroupId,
      );

      if (!exists) {
        data.nodes[node.conversationId].push(node);

        // Update group index
        if (!data.groups[node.forkGroupId]) {
          data.groups[node.forkGroupId] = [];
        }
        const groupKey = `${node.conversationId}:${node.turnId}`;
        if (!data.groups[node.forkGroupId].includes(groupKey)) {
          data.groups[node.forkGroupId].push(groupKey);
        }

        await this.saveToStorage(data);
        return true;
      }
      return false;
    });
  }

  async removeForkNode(
    conversationId: string,
    turnId: string,
    forkGroupId: string,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (data.nodes[conversationId]) {
        const initialLength = data.nodes[conversationId].length;
        data.nodes[conversationId] = data.nodes[conversationId].filter(
          (n) => !(n.turnId === turnId && n.forkGroupId === forkGroupId),
        );

        if (data.nodes[conversationId].length < initialLength) {
          if (data.nodes[conversationId].length === 0) {
            delete data.nodes[conversationId];
          }

          // Update group index
          if (data.groups[forkGroupId]) {
            const groupKey = `${conversationId}:${turnId}`;
            data.groups[forkGroupId] = data.groups[forkGroupId].filter((k) => k !== groupKey);
            if (data.groups[forkGroupId].length === 0) {
              delete data.groups[forkGroupId];
            }
          }

          await this.saveToStorage(data);
          return true;
        }
      }
      return false;
    });
  }

  async getAllForkNodes(): Promise<ForkNodesData> {
    return this.getFromStorage();
  }

  async getForConversation(conversationId: string): Promise<ForkNode[]> {
    const data = await this.getFromStorage();
    return data.nodes[conversationId] || [];
  }

  async getGroup(forkGroupId: string): Promise<ForkNode[]> {
    const data = await this.getFromStorage();
    const groupKeys = data.groups[forkGroupId] || [];
    const nodes: ForkNode[] = [];

    for (const key of groupKeys) {
      const [convId, turnId] = key.split(':');
      const convNodes = data.nodes[convId] || [];
      const match = convNodes.find((n) => n.turnId === turnId && n.forkGroupId === forkGroupId);
      if (match) nodes.push(match);
    }

    return nodes.sort((a, b) => a.forkIndex - b.forkIndex);
  }
}

const forkNodesManager = new ForkNodesManager();

// Generated UI screenshots are best-effort; export continues when Chrome denies capture.
function captureVisibleTab(windowId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      const error = chrome.runtime.lastError?.message;
      if (error || !dataUrl) {
        reject(new Error(error || 'capture_failed'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

async function ensureGeneratedUiCapturePermission(): Promise<boolean> {
  if (!browser.permissions?.contains || !browser.permissions?.request) return false;
  try {
    if (await browser.permissions.contains({ origins: GENERATED_UI_CAPTURE_PERMISSION_ORIGINS })) {
      return true;
    }
    return await browser.permissions.request({ origins: GENERATED_UI_CAPTURE_PERMISSION_ORIGINS });
  } catch (error) {
    console.warn('[Background] Generated UI screenshot permission request failed:', error);
    return false;
  }
}

async function cleanupLegacyGeneratedUiCapturePermission(): Promise<void> {
  const key = StorageKeys.GENERATED_UI_CAPTURE_PERMISSION_CLEANUP_DONE;
  try {
    const stored = await chrome.storage.local.get({ [key]: false });
    if (stored[key] === true || !browser.permissions?.getAll || !browser.permissions?.remove) {
      return;
    }

    const current = await browser.permissions.getAll();
    const removed = current.origins?.includes('<all_urls>')
      ? await browser.permissions.remove({ origins: GENERATED_UI_CAPTURE_PERMISSION_ORIGINS })
      : false;
    await chrome.storage.local.set({ [key]: true });

    if (removed) {
      await syncCustomContentScripts();
      await syncPluginContentScripts();
    }
  } catch (error) {
    console.warn('[Background] Failed to clean up legacy generated UI capture permission:', error);
  }
}

type RuntimeImageMessage = {
  type: 'gv.fetchImage' | 'gv.fetchImageViaPage';
  url?: unknown;
};

type RuntimeImageSender = {
  tab?: { id?: number };
};

function isRuntimeImageMessage(message: unknown): message is RuntimeImageMessage {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return type === 'gv.fetchImage' || type === 'gv.fetchImageViaPage';
}

async function handleRuntimeImageMessage(
  message: RuntimeImageMessage,
  sender: RuntimeImageSender,
): Promise<Record<string, unknown>> {
  const url = String(message.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid_url' };
  }

  if (message.type === 'gv.fetchImageViaPage') {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: false, error: 'invalid' };
    if (!chrome.scripting?.executeScript) {
      return { ok: false, error: 'scripting_api_unavailable' };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        func: async (imageUrl: string) => {
          const safeFetch = async (credentials: RequestCredentials) => {
            try {
              const response = await fetch(imageUrl, { credentials });
              return response.ok ? await response.blob() : null;
            } catch {
              return null;
            }
          };

          const blob = (await safeFetch('include')) || (await safeFetch('omit'));
          if (!blob) return null;

          return await new Promise<{ contentType: string; base64: string } | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = String(reader.result || '');
              const commaIndex = dataUrl.indexOf(',');
              resolve(
                commaIndex < 0
                  ? null
                  : {
                      contentType: blob.type || 'application/octet-stream',
                      base64: dataUrl.substring(commaIndex + 1),
                    },
              );
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        },
        args: [url],
      });
      const result = results?.[0]?.result as { contentType: string; base64: string } | null;
      return result?.base64
        ? {
            ok: true,
            contentType: result.contentType,
            base64: result.base64,
            data: `data:${result.contentType};base64,${result.base64}`,
          }
        : { ok: false, error: 'page_fetch_failed' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const fetchWithFallback = async (credentials: RequestCredentials) => {
    try {
      return await fetch(url, { credentials, redirect: 'follow' });
    } catch {
      return null;
    }
  };
  let response = await fetchWithFallback('include');
  if (!response?.ok) response = await fetchWithFallback('omit');
  if (!response?.ok) {
    return { ok: false, error: response ? `HTTP ${response.status}` : 'fetch_failed' };
  }
  const blob = await response.blob();
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  const contentType = blob.type || 'image/png';
  return {
    ok: true,
    data: `data:${contentType};base64,${base64}`,
    contentType,
    base64,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isHandledBackgroundRuntimeMessage(message)) return undefined;

  if (getVoyagerBuildTarget() === 'safari' && isRuntimeImageMessage(message)) {
    void handleRuntimeImageMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }
  (async () => {
    try {
      if (isRuntimeImageMessage(message)) {
        sendResponse(await handleRuntimeImageMessage(message, sender));
        return;
      }

      if (message?.type === 'gv.generatedUi.ensureCapturePermission') {
        sendResponse({ ok: await ensureGeneratedUiCapturePermission() });
        return;
      }

      if (message?.type === 'gv.generatedUi.captureVisibleTab') {
        const windowId = sender.tab?.windowId;
        if (typeof windowId !== 'number' || !chrome.tabs?.captureVisibleTab) {
          sendResponse({ ok: false, error: 'capture_unavailable' });
          return;
        }

        try {
          const dataUrl = await captureVisibleTab(windowId);
          sendResponse({ ok: true, dataUrl });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === 'gv.account.resolve') {
        const payload = message.payload as {
          pageUrl?: string;
          routeUserId?: string | null;
          email?: string | null;
          platform?: AccountPlatform;
        };
        const resolvedPlatform =
          payload?.platform ??
          detectAccountPlatformFromUrl(payload?.pageUrl ?? sender.tab?.url ?? null);
        const scope = await accountIsolationService.resolveAccountScope({
          pageUrl: payload?.pageUrl ?? sender.tab?.url ?? null,
          routeUserId: payload?.routeUserId ?? null,
          email: payload?.email ?? null,
        });
        sendResponse({
          ok: true,
          scope,
          enabled: await accountIsolationService.isIsolationEnabled({
            platform: resolvedPlatform,
            pageUrl: payload?.pageUrl ?? sender.tab?.url ?? null,
          }),
        });
        return;
      }

      if (message?.type === 'gv.responseComplete.notify') {
        const ok = await showResponseCompleteNotification(sender, {
          conversationUrl:
            typeof message.payload?.conversationUrl === 'string'
              ? message.payload.conversationUrl
              : undefined,
          conversationTitle:
            typeof message.payload?.conversationTitle === 'string'
              ? message.payload.conversationTitle
              : undefined,
          userPrompt:
            typeof message.payload?.userPrompt === 'string'
              ? message.payload.userPrompt
              : undefined,
        });
        sendResponse({ ok });
        return;
      }

      if (message?.type === SAFARI_NOTIFICATION_PERMISSION_REQUEST) {
        const granted =
          getVoyagerBuildTarget() === 'safari' && (await prepareSafariNativeNotifications());
        await browser.storage.sync.set({
          [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: granted,
        });
        sendResponse({ ok: true, granted });
        return;
      }

      if (message?.type === SAFARI_CLIPBOARD_IMAGE_COPY_REQUEST) {
        const pngBase64 =
          typeof message.payload?.pngBase64 === 'string' ? message.payload.pngBase64 : '';
        const copied =
          getVoyagerBuildTarget() === 'safari' &&
          pngBase64.length > 0 &&
          (await copySafariNativeImagePng(pngBase64));
        sendResponse({ ok: true, copied });
        return;
      }

      if (isRemoteAnnouncementRuntimeMessage(message)) {
        if (message.type === 'gv.remoteAnnouncement.getPending') {
          sendResponse({
            ok: true,
            announcements: await remoteAnnouncementService.getPendingAnnouncements(),
          });
          return;
        }

        const id = typeof message.payload?.id === 'string' ? message.payload.id : '';
        if (id) await remoteAnnouncementService.acknowledgeAnnouncement(id);
        sendResponse({ ok: true });
        return;
      }

      // Highlight annotations are always account-scoped. This is intentionally
      // independent from the optional account-isolation setting used by legacy
      // sync data so annotations can never leak between /u/<index> routes.
      if (message && message.type && message.type.startsWith('gv.highlight.')) {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        try {
          switch (message.type) {
            case 'gv.highlight.listAll': {
              if (!isTrustedExtensionPageSender(sender)) {
                throw new HighlightAnnotationError(
                  'INVALID_SCOPE',
                  'Global highlight access is restricted to extension pages',
                );
              }
              const records = await highlightAnnotationService.getAllAccounts({
                includeDeleted: payload.includeDeleted === true,
              });
              sendResponse({ ok: true, records });
              return;
            }
            case 'gv.highlight.list': {
              const scope = await resolveHighlightAccountScope(sender, payload);
              await highlightAnnotationService.claimLegacyDefaultHighlights(scope);
              const records =
                typeof payload.conversationId === 'string'
                  ? await highlightAnnotationService.getConversation(
                      scope,
                      payload.conversationId,
                      { includeDeleted: payload.includeDeleted === true },
                    )
                  : await highlightAnnotationService.getAll(scope, {
                      includeDeleted: payload.includeDeleted === true,
                    });
              sendResponse({ ok: true, records });
              return;
            }
            case 'gv.highlight.create': {
              const scope = await resolveHighlightAccountScope(sender, payload);
              const input = (payload.input ?? payload) as HighlightCreateInput;
              const result = await highlightAnnotationService.add(scope, input);
              await notifyHighlightChanged(
                { platform: scope.platform, accountHash: getHighlightAccountHash(scope) },
                result.record.conversationId,
              );
              sendResponse({ ok: true, ...result });
              return;
            }
            case 'gv.highlight.update': {
              if (
                typeof payload.conversationId !== 'string' ||
                typeof payload.id !== 'string' ||
                !payload.patch ||
                typeof payload.patch !== 'object'
              ) {
                throw new HighlightAnnotationError(
                  'VALIDATION_FAILED',
                  'Highlight update payload is invalid',
                );
              }
              const scope = await resolveHighlightAccountScope(sender, payload);
              const record = await highlightAnnotationService.update(
                scope,
                payload.conversationId,
                payload.id,
                payload.patch as HighlightUpdatePatch,
              );
              await notifyHighlightChanged(record, record.conversationId);
              sendResponse({ ok: true, record });
              return;
            }
            case 'gv.highlight.updateStored': {
              if (!isTrustedExtensionPageSender(sender)) {
                throw new HighlightAnnotationError(
                  'INVALID_SCOPE',
                  'Stored highlight access is restricted to extension pages',
                );
              }
              if (
                !isHighlightStoredAccountScope(payload) ||
                typeof payload.conversationId !== 'string' ||
                typeof payload.id !== 'string' ||
                !payload.patch ||
                typeof payload.patch !== 'object'
              ) {
                throw new HighlightAnnotationError(
                  'VALIDATION_FAILED',
                  'Stored highlight update payload is invalid',
                );
              }
              const record = await highlightAnnotationService.update(
                payload,
                payload.conversationId,
                payload.id,
                payload.patch as HighlightUpdatePatch,
              );
              await notifyHighlightChanged(record, record.conversationId);
              sendResponse({ ok: true, record });
              return;
            }
            case 'gv.highlight.delete': {
              if (typeof payload.conversationId !== 'string' || typeof payload.id !== 'string') {
                throw new HighlightAnnotationError(
                  'VALIDATION_FAILED',
                  'Highlight delete payload is invalid',
                );
              }
              const scope = await resolveHighlightAccountScope(sender, payload);
              const result = await highlightAnnotationService.remove(
                scope,
                payload.conversationId,
                payload.id,
                { tombstone: shouldKeepHighlightTombstones(scope.platform) },
              );
              await notifyHighlightChanged(
                { platform: scope.platform, accountHash: getHighlightAccountHash(scope) },
                payload.conversationId,
              );
              sendResponse({ ok: true, ...result });
              return;
            }
            case 'gv.highlight.deleteStored': {
              if (!isTrustedExtensionPageSender(sender)) {
                throw new HighlightAnnotationError(
                  'INVALID_SCOPE',
                  'Stored highlight access is restricted to extension pages',
                );
              }
              if (
                !isHighlightStoredAccountScope(payload) ||
                typeof payload.conversationId !== 'string' ||
                typeof payload.id !== 'string'
              ) {
                throw new HighlightAnnotationError(
                  'VALIDATION_FAILED',
                  'Stored highlight delete payload is invalid',
                );
              }
              const result = await highlightAnnotationService.remove(
                payload,
                payload.conversationId,
                payload.id,
                { tombstone: shouldKeepHighlightTombstones(payload.platform) },
              );
              await notifyHighlightChanged(payload, payload.conversationId);
              sendResponse({ ok: true, ...result });
              return;
            }
            case 'gv.highlight.export': {
              const scope = await resolveHighlightAccountScope(sender, payload);
              const format = payload.format === 'markdown' ? 'markdown' : 'json';
              const result =
                format === 'markdown'
                  ? await highlightImportExportService.exportToMarkdown(scope)
                  : await highlightImportExportService.exportToJSON(scope);
              if (!result.success) {
                sendResponse(highlightErrorResponse(result.error));
                return;
              }
              sendResponse({
                ok: true,
                data: result.data,
                filename:
                  format === 'markdown'
                    ? HighlightImportExportService.generateMarkdownFilename()
                    : HighlightImportExportService.generateExportFilename(),
              });
              return;
            }
            case 'gv.highlight.import': {
              const scope = await resolveHighlightAccountScope(sender, payload);
              const result = await highlightImportExportService.importFromJSON(
                scope,
                typeof payload.data === 'string' ? payload.data : '',
              );
              if (!result.success) {
                sendResponse(highlightErrorResponse(result.error));
                return;
              }
              await notifyHighlightChanged({
                platform: scope.platform,
                accountHash: getHighlightAccountHash(scope),
              });
              sendResponse({ ok: true, stats: result.data });
              return;
            }
            case 'gv.highlight.clearAll': {
              const scope = await resolveHighlightAccountScope(sender, payload);
              const result = await highlightAnnotationService.clearAll(scope);
              await notifyHighlightChanged({
                platform: scope.platform,
                accountHash: getHighlightAccountHash(scope),
              });
              sendResponse({ ok: true, removed: result.removed });
              return;
            }
            case 'gv.highlight.clearAllAccounts': {
              if (!isTrustedExtensionPageSender(sender)) {
                throw new HighlightAnnotationError(
                  'INVALID_SCOPE',
                  'Global highlight cleanup is restricted to extension pages',
                );
              }
              const result = await highlightAnnotationService.clearAllAccounts();
              await Promise.allSettled(
                result.accounts.map(({ accountScope }) => notifyHighlightChanged(accountScope)),
              );
              sendResponse({ ok: true, removed: result.removed });
              return;
            }
          }
        } catch (error) {
          sendResponse(highlightErrorResponse(error));
          return;
        }
      }

      // Handle starred messages operations
      if (message && message.type && message.type.startsWith('gv.starred.')) {
        switch (message.type) {
          case 'gv.starred.add': {
            const added = await starredMessagesManager.addStarredMessage(message.payload);
            sendResponse({ ok: true, added });
            return;
          }
          case 'gv.starred.remove': {
            const removed = await starredMessagesManager.removeStarredMessage(
              message.payload.conversationId,
              message.payload.turnId,
            );
            sendResponse({ ok: true, removed });
            return;
          }
          case 'gv.starred.getAll': {
            const data = await starredMessagesManager.getAllStarredMessages();
            sendResponse({ ok: true, data });
            return;
          }
          case 'gv.starred.getForConversation': {
            const messages = await starredMessagesManager.getStarredMessagesForConversation(
              message.payload.conversationId,
            );
            sendResponse({ ok: true, messages });
            return;
          }
          case 'gv.starred.isStarred': {
            const isStarred = await starredMessagesManager.isMessageStarred(
              message.payload.conversationId,
              message.payload.turnId,
            );
            sendResponse({ ok: true, isStarred });
            return;
          }
          case 'gv.starred.reconcileConversationIds': {
            const messages = await starredMessagesManager.reconcileConversationIds(
              message.payload.targetConversationId,
              Array.isArray(message.payload.sourceConversationIds)
                ? message.payload.sourceConversationIds
                : [],
              typeof message.payload.conversationUrl === 'string'
                ? message.payload.conversationUrl
                : undefined,
            );
            sendResponse({ ok: true, messages });
            return;
          }
        }
      }

      // Handle fork nodes operations
      if (message && message.type && message.type.startsWith('gv.fork.')) {
        switch (message.type) {
          case 'gv.fork.add': {
            const added = await forkNodesManager.addForkNode(message.payload);
            sendResponse({ ok: true, added });
            return;
          }
          case 'gv.fork.remove': {
            const removed = await forkNodesManager.removeForkNode(
              message.payload.conversationId,
              message.payload.turnId,
              message.payload.forkGroupId,
            );
            sendResponse({ ok: true, removed });
            return;
          }
          case 'gv.fork.getAll': {
            const data = await forkNodesManager.getAllForkNodes();
            sendResponse({ ok: true, data });
            return;
          }
          case 'gv.fork.getForConversation': {
            const nodes = await forkNodesManager.getForConversation(message.payload.conversationId);
            sendResponse({ ok: true, nodes });
            return;
          }
          case 'gv.fork.getGroup': {
            const nodes = await forkNodesManager.getGroup(message.payload.forkGroupId);
            sendResponse({ ok: true, nodes });
            return;
          }
        }
      }

      // Handle sync operations
      if (message && message.type && message.type.startsWith('gv.sync.')) {
        switch (message.type) {
          case 'gv.sync.authenticate': {
            const interactive = message.payload?.interactive !== false;
            const success = await googleDriveSyncService.authenticate(interactive);
            sendResponse({ ok: success, state: await googleDriveSyncService.getState() });
            return;
          }
          case 'gv.sync.signOut': {
            await googleDriveSyncService.signOut();
            sendResponse({ ok: true, state: await googleDriveSyncService.getState() });
            return;
          }
          case 'gv.sync.upload': {
            const {
              folders,
              prompts,
              interactive,
              platform: rawPlatform,
              accountScope: rawScope,
              timelineHierarchyAccountScope: rawTimelineHierarchyScope,
              highlightAccountScope: rawHighlightScope,
              includeHighlights,
            } = message.payload as {
              folders: FolderData;
              prompts: PromptItem[];
              interactive?: boolean;
              platform?: 'gemini' | 'aistudio';
              accountScope?: unknown;
              timelineHierarchyAccountScope?: unknown;
              highlightAccountScope?: unknown;
              includeHighlights?: boolean;
            };
            const platform = rawPlatform || 'gemini';
            const syncHighlights = await isHighlightCloudSyncRequested(
              platform,
              includeHighlights === true,
            );
            const accountScope = await resolveAccountScopeForMessage(
              sender,
              platform,
              isSyncAccountScope(rawScope) ? rawScope : undefined,
            );
            const timelineHierarchyAccountScope =
              platform === 'gemini' && isSyncAccountScope(rawTimelineHierarchyScope)
                ? rawTimelineHierarchyScope
                : null;
            const highlightAccountScope =
              platform === 'gemini' && isSyncAccountScope(rawHighlightScope)
                ? rawHighlightScope
                : (timelineHierarchyAccountScope ??
                  (isSyncAccountScope(rawScope) ? rawScope : null));
            const shouldSyncHighlights = syncHighlights && highlightAccountScope !== null;
            // Also get Gemini-only timeline data from local storage
            const starredDataRaw =
              platform !== 'aistudio' ? await starredMessagesManager.getAllStarredMessages() : null;
            const forksDataRaw =
              platform !== 'aistudio' ? await forkNodesManager.getAllForkNodes() : null;
            const timelineHierarchyRaw =
              platform !== 'aistudio'
                ? await chrome.storage.local.get(
                    getTimelineHierarchyStorageKeysToRead(
                      timelineHierarchyAccountScope?.accountKey,
                    ),
                  )
                : null;
            const starredData =
              starredDataRaw && accountScope
                ? filterStarredByRouteScope(starredDataRaw, accountScope.routeUserId)
                : starredDataRaw;
            const forksData =
              forksDataRaw && accountScope
                ? filterForkNodesByRouteScope(forksDataRaw, accountScope.routeUserId)
                : forksDataRaw;
            const timelineHierarchyDataRaw =
              platform !== 'aistudio' && timelineHierarchyRaw
                ? resolveTimelineHierarchyDataForStorageScope(
                    timelineHierarchyRaw as Record<string, unknown>,
                    timelineHierarchyAccountScope?.accountKey,
                    timelineHierarchyAccountScope?.routeUserId ?? null,
                  )
                : null;
            const timelineHierarchyData =
              timelineHierarchyDataRaw && timelineHierarchyAccountScope
                ? filterTimelineHierarchyByRouteScope(
                    timelineHierarchyDataRaw,
                    timelineHierarchyAccountScope.routeUserId,
                  )
                : timelineHierarchyDataRaw;
            const settingsPayload = await exportBackupableSyncSettings();
            const pluginState = await loadPluginState();
            const success = await googleDriveSyncService.upload(
              folders,
              prompts,
              starredData,
              interactive !== false,
              platform,
              forksData,
              timelineHierarchyData,
              accountScope,
              timelineHierarchyAccountScope,
              settingsPayload.data,
              pluginState,
            );
            if (success && shouldSyncHighlights && highlightAccountScope) {
              const highlightResult = await highlightDriveSyncCoordinator.push(
                highlightAccountScope,
                interactive !== false,
              );
              if (!highlightResult.ok) {
                sendResponse({
                  ok: false,
                  error: highlightResult.error ?? 'Highlight upload failed',
                  partial: true,
                  state: await googleDriveSyncService.getState(),
                });
                return;
              }
              await notifyHighlightChanged({
                platform: 'gemini',
                accountHash: getHighlightAccountHash({
                  ...highlightAccountScope,
                  platform: 'gemini',
                }),
              });
            }
            sendResponse({
              ok: success,
              highlights: syncHighlights
                ? { synced: success && shouldSyncHighlights, skipped: !shouldSyncHighlights }
                : undefined,
              state: await googleDriveSyncService.getState(),
            });
            return;
          }
          case 'gv.sync.download': {
            const interactive = message.payload?.interactive !== false;
            const platform = (message.payload?.platform as 'gemini' | 'aistudio') || 'gemini';
            const syncHighlights = await isHighlightCloudSyncRequested(
              platform,
              message.payload?.includeHighlights === true,
            );
            const rawScope = message.payload?.accountScope;
            const rawTimelineHierarchyScope = message.payload?.timelineHierarchyAccountScope;
            const rawHighlightScope = message.payload?.highlightAccountScope;
            const accountScope = await resolveAccountScopeForMessage(
              sender,
              platform,
              isSyncAccountScope(rawScope) ? rawScope : undefined,
            );
            const timelineHierarchyAccountScope =
              platform === 'gemini' && isSyncAccountScope(rawTimelineHierarchyScope)
                ? rawTimelineHierarchyScope
                : null;
            const highlightAccountScope =
              platform === 'gemini' && isSyncAccountScope(rawHighlightScope)
                ? rawHighlightScope
                : (timelineHierarchyAccountScope ??
                  (isSyncAccountScope(rawScope) ? rawScope : null));
            const shouldSyncHighlights = syncHighlights && highlightAccountScope !== null;
            const data = await googleDriveSyncService.download(
              interactive,
              platform,
              accountScope,
              timelineHierarchyAccountScope,
            );
            let highlightSyncResult: { synced: boolean; count: number; empty: boolean } | undefined;
            if (shouldSyncHighlights && highlightAccountScope) {
              const highlightResult = await highlightDriveSyncCoordinator.pull(
                highlightAccountScope,
                interactive,
              );
              if (!highlightResult.ok) {
                sendResponse({
                  ok: false,
                  error: highlightResult.error ?? 'Highlight download failed',
                  partial: data !== null,
                  state: await googleDriveSyncService.getState(),
                });
                return;
              }
              await notifyHighlightChanged({
                platform: 'gemini',
                accountHash: getHighlightAccountHash({
                  ...highlightAccountScope,
                  platform: 'gemini',
                }),
              });
              highlightSyncResult = {
                synced: true,
                count: highlightResult.count,
                empty: highlightResult.empty === true,
              };
            }
            // NOTE: We intentionally do NOT save to storage here.
            // The caller (Popup) is responsible for merging with local data and saving.
            // This prevents data loss from overwriting local changes.
            console.log(
              `[Background] Downloaded data for ${platform}, returning to caller for merge`,
            );
            sendResponse({
              ok: true,
              data,
              highlights:
                highlightSyncResult ??
                (syncHighlights ? { synced: false, skipped: !shouldSyncHighlights } : undefined),
              state: await googleDriveSyncService.getState(),
            });
            return;
          }
          // Prompts-only cloud merge, run END-TO-END in the background so the
          // operation survives the extension popup closing when the Google
          // account picker steals focus during interactive auth. Merging in the
          // popup meant a first-time account selection abandoned the merge and
          // the user had to click again.
          case 'gv.sync.pullPromptsMerge': {
            const { interactive, accountScope: rawScope } = (message.payload ?? {}) as {
              interactive?: boolean;
              accountScope?: unknown;
            };
            const accountScope = await resolveAccountScopeForMessage(
              sender,
              'gemini',
              isSyncAccountScope(rawScope) ? rawScope : undefined,
            );
            const payload = await googleDriveSyncService.downloadPromptsOnly(
              accountScope,
              interactive !== false,
            );
            const validated = PromptImportExportService.validatePayload(payload);
            if (!validated.success) {
              sendResponse({
                ok: true,
                empty: true,
                state: await googleDriveSyncService.getState(),
              });
              return;
            }
            const merged = await PromptImportExportService.importFromPayload(validated.data);
            sendResponse({
              ok: merged.success,
              imported: merged.success ? merged.data.imported : 0,
              duplicates: merged.success ? merged.data.duplicates : 0,
              nameConflicts: merged.success ? merged.data.nameConflicts : 0,
              state: await googleDriveSyncService.getState(),
            });
            return;
          }
          case 'gv.sync.pushPromptsMerge': {
            const { interactive, accountScope: rawScope } = (message.payload ?? {}) as {
              interactive?: boolean;
              accountScope?: unknown;
            };
            const accountScope = await resolveAccountScopeForMessage(
              sender,
              'gemini',
              isSyncAccountScope(rawScope) ? rawScope : undefined,
            );
            // Merge cloud into local first so both sides converge to the union.
            const cloudPayload = await googleDriveSyncService.downloadPromptsOnly(
              accountScope,
              interactive !== false,
            );
            const validated = PromptImportExportService.validatePayload(cloudPayload);
            if (validated.success) {
              const merged = await PromptImportExportService.importFromPayload(validated.data);
              if (!merged.success) {
                sendResponse({
                  ok: false,
                  state: await googleDriveSyncService.getState(),
                });
                return;
              }
            }
            const localResult = await PromptImportExportService.loadPrompts();
            const localPrompts = localResult.success ? localResult.data : [];
            const uploaded = await googleDriveSyncService.uploadPromptsOnly(
              localPrompts,
              accountScope,
              interactive !== false,
            );
            sendResponse({
              ok: uploaded,
              count: localPrompts.length,
              nameConflicts: getPromptNameConflictIds(localPrompts).size,
              state: await googleDriveSyncService.getState(),
            });
            return;
          }
          case 'gv.sync.getState': {
            sendResponse({ ok: true, state: await googleDriveSyncService.getState() });
            return;
          }
          case 'gv.sync.setMode': {
            const mode = message.payload?.mode as SyncMode;
            if (mode) {
              await googleDriveSyncService.setMode(mode);
            }
            sendResponse({ ok: true, state: await googleDriveSyncService.getState() });
            return;
          }
          case 'gv.sync.setProvider': {
            const provider = message.payload?.provider as SyncProvider;
            if (provider === 'googleDrive' || provider === 'icloud') {
              await googleDriveSyncService.setProvider(provider);
            }
            sendResponse({ ok: true, state: await googleDriveSyncService.getState() });
            return;
          }
        }
      }

      // Handle popup opening request
      if (message && message.type === 'gv.openPopup') {
        try {
          await chrome.action.openPopup();
          sendResponse({ ok: true });
        } catch (e) {
          console.warn('[GV] Failed to open popup programmatically:', e);
          try {
            await openSettingsPageFallback(sender.tab?.id);
            sendResponse({ ok: true, fallback: 'options' });
          } catch (fallbackError) {
            sendResponse({
              ok: false,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
          }
        }
        return;
      }

      // Handle sync to IDE (bypasses page CSP)
      if (message?.type === 'gv.syncToIDE') {
        const url = String(message.url || '');
        const data = message.data || [];
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            mode: 'cors',
            body: JSON.stringify(data),
          });

          if (!response.ok) {
            sendResponse({ ok: false, error: `HTTP ${response.status}` });
          } else {
            const result = await response.json();
            sendResponse({ ok: true, data: result });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // Handle check sync server status (bypasses page CSP)
      if (message?.type === 'gv.checkSyncStatus') {
        const url = String(message.url || '');
        const timeout = Number(message.timeout || 200);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
          });
          sendResponse({ ok: response.ok });
        } catch {
          sendResponse({ ok: false });
        } finally {
          clearTimeout(timeoutId);
        }
        return;
      }
    } catch (e) {
      try {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } catch {}
    }
  })();
  return true; // keep channel open for async sendResponse
});

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa on service worker context is available
  return btoa(binary);
}
