/* Prompt Manager content module
 * - Injects a floating trigger button using the extension icon
 * - Opens a small anchored panel above the trigger (default)
 * - Panel supports: i18n language switch, add prompt, tag chips, search, copy
 * - Optional lock to pin panel position; when locked, panel is draggable and persisted
 */
import 'katex/dist/katex.min.css';
import type { marked as MarkedFn } from 'marked';
import browser from 'webextension-polyfill';

import { createChevronDownIcon, createStarIcon } from '@/core/icons/folderIcons';
import {
  createArrowLeftIcon,
  createBracesIcon,
  createDownloadIcon,
  createFileTextIcon,
  createLayoutGridIcon,
  createListIcon,
  createLockIcon,
  createLockOpenIcon,
  createMoonIcon,
  createSunIcon,
} from '@/core/icons/promptManagerIcons';
import {
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { logger } from '@/core/services/LoggerService';
import { promptStorageService } from '@/core/services/StorageService';
import { type StorageKey, StorageKeys } from '@/core/types/common';
import {
  type HighlightAccountScope,
  type HighlightRecordV1,
  getHighlightColorHex,
} from '@/core/types/highlight';
import { isSafari, shouldShowSafariUpdateReminder } from '@/core/utils/browser';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { migrateFromLocalStorage } from '@/core/utils/storageMigration';
import { shouldShowUpdateReminderForCurrentVersion } from '@/core/utils/updateReminder';
import { compareVersions } from '@/core/utils/version';
import {
  type SavedLibraryFilter,
  type SavedLibraryItem,
  buildSavedLibraryItemUrl,
  filterSavedLibraryItems,
  toSavedLibraryItems,
} from '@/features/savedLibrary/model';
import { getCurrentLanguage, getTranslationSync, initI18n, setCachedLanguage } from '@/utils/i18n';
import {
  APP_LANGUAGES,
  APP_LANGUAGE_LABELS,
  type AppLanguage,
  isAppLanguage,
  normalizeLanguage,
} from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import { hasUnreadChangelog, openChangelog, showChangelogModalDirect } from '../changelog/index';
import { insertTextIntoChatInput } from '../chatInput/index';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';
import { StarredMessagesService } from '../timeline/StarredMessagesService';
import type { StarredMessage } from '../timeline/starredTypes';
import { extractPlainTitle } from './compactTitle';
import { activatePromptText } from './promptClickAction';
import { getPromptNameConflictIds, isPromptNameTaken, normalizePromptName } from './promptName';
import { getScrollHintState } from './scrollHint';
import { formatStarredMessageTime } from './starredLibrary';
import { sanitizeSelectedTags } from './tagFilterState';

type PromptItem = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  /**
   * Required for newly saved prompts. It remains optional in the stored type
   * so legacy prompts keep rendering without a destructive migration.
   */
  name?: string;
};

type PanelPosition = { top: number; left: number };
type TriggerPosition = { bottom: number; right: number };
type PMPanelView = 'prompts' | 'starred';

function isPMPanelView(value: unknown): value is PMPanelView {
  return value === 'prompts' || value === 'starred';
}

const STORAGE_KEYS = {
  items: StorageKeys.PROMPT_ITEMS,
  locked: StorageKeys.PROMPT_PANEL_LOCKED,
  position: StorageKeys.PROMPT_PANEL_POSITION,
  triggerPos: StorageKeys.PROMPT_TRIGGER_POSITION,
  selectedTags: StorageKeys.PROMPT_SELECTED_TAGS,
  language: StorageKeys.LANGUAGE, // reuse global language key
  theme: StorageKeys.PROMPT_THEME,
} as const;

const ID = {
  trigger: 'gv-pm-trigger',
  panel: 'gv-pm-panel',
} as const;

const LATEST_VERSION_CACHE_KEY = 'gvLatestVersionCache';
const LATEST_VERSION_MAX_AGE = 1000 * 60 * 60 * 6; // 6 hours
const SPONSOR_HEART_PATH_16 =
  'M7.655 14.916h-.002l-.006-.003l-.018-.01a22 22 0 0 1-3.744-2.584C2.045 10.731 0 8.35 0 5.5C0 2.836 2.086 1 4.25 1C5.797 1 7.153 1.802 8 3.02C8.847 1.802 10.203 1 11.75 1C13.914 1 16 2.836 16 5.5c0 2.85-2.044 5.231-3.886 6.818a22 22 0 0 1-3.433 2.414a7 7 0 0 1-.31.17l-.018.01l-.008.004a.75.75 0 0 1-.69 0';

type PMTheme = 'light' | 'dark';
type PMViewMode = 'compact' | 'comfortable';

async function resolveCurrentHighlightScope(): Promise<HighlightAccountScope> {
  const context = detectAccountContextFromDocument(window.location.href, document);
  const resolved = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    routeUserId: context.routeUserId,
    email: context.email,
  });
  return {
    platform: window.location.hostname.startsWith('aistudio.') ? 'aistudio' : 'gemini',
    accountKey: resolved.accountKey,
    accountId: resolved.accountId,
    routeUserId: resolved.routeUserId,
  };
}

async function loadCurrentAccountHighlightRecords(): Promise<HighlightRecordV1[]> {
  try {
    const scope = await resolveCurrentHighlightScope();
    const response = (await browser.runtime.sendMessage({
      type: 'gv.highlight.list',
      payload: { scope, includeDeleted: false },
    })) as { ok?: boolean; records?: HighlightRecordV1[]; error?: string } | undefined;
    if (!response?.ok) throw new Error(response?.error || 'Failed to load highlights');
    return Array.isArray(response.records) ? response.records : [];
  } catch (error) {
    logger.warn('[PromptManager] Failed to load highlights', { error: String(error) });
    throw error;
  }
}

async function removeStoredHighlight(item: SavedLibraryItem): Promise<boolean> {
  if (item.kind !== 'highlight' || !item.accountHash || !item.platform) return false;
  try {
    const scope = await resolveCurrentHighlightScope();
    const response = (await browser.runtime.sendMessage({
      type: 'gv.highlight.delete',
      payload: {
        scope,
        conversationId: item.conversationId,
        id: item.id,
      },
    })) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch (error) {
    logger.warn('[PromptManager] Failed to remove highlight', { error: String(error) });
    return false;
  }
}

function navigateToSavedLibraryItem(item: SavedLibraryItem): boolean {
  let target: URL;
  try {
    target = new URL(buildSavedLibraryItemUrl(item), window.location.href);
  } catch (error) {
    logger.warn('[PromptManager] Blocked invalid saved item URL', { error: String(error) });
    return false;
  }
  if (target.origin !== window.location.origin) {
    window.open(target.href, '_blank', 'noopener,noreferrer');
    return true;
  }

  window.history.pushState(
    window.history.state,
    '',
    `${target.pathname}${target.search}${target.hash}`,
  );
  window.dispatchEvent(
    typeof PopStateEvent === 'function'
      ? new PopStateEvent('popstate', { state: window.history.state })
      : new Event('popstate'),
  );
  return true;
  window.dispatchEvent(new Event('hashchange'));
}

function detectPageTheme(): PMTheme {
  if (
    document.querySelector('.theme-host.dark-theme') ||
    document.body.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark') ||
    document.body.getAttribute('data-theme') === 'dark'
  ) {
    return 'dark';
  }
  if (
    document.querySelector('.theme-host.light-theme') ||
    document.body.classList.contains('light-theme') ||
    document.documentElement.classList.contains('light') ||
    document.body.getAttribute('data-theme') === 'light'
  ) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getRuntimeUrl(path: string): string {
  // Try the standard Web Extensions API first (mainly for Firefox)
  try {
    return browser.runtime.getURL(path);
  } catch {
    const win = window as Window & { chrome?: { runtime?: { getURL?: (path: string) => string } } };
    return win.chrome?.runtime?.getURL?.(path) || path;
  }
}

// Use centralized i18n system
function createI18n() {
  return {
    t: (key: TranslationKey): string => getTranslationSync(key),
    set: async (lang: AppLanguage) => {
      try {
        // Check if extension context is still valid
        if (!browser.runtime?.id) {
          // Extension context invalidated, skip
          return;
        }
        setCachedLanguage(lang);
        await browser.storage.sync.set({ language: lang });
        return;
      } catch (e) {
        try {
          await browser.storage.local.set({ language: lang });
          return;
        } catch (localError) {
          // Silently ignore extension context errors
          if (
            isExtensionContextInvalidatedError(e) ||
            isExtensionContextInvalidatedError(localError)
          ) {
            return;
          }
          console.warn('[PromptManager] Failed to set language:', e, localError);
        }
      }
    },
    get: async (): Promise<AppLanguage> => await getCurrentLanguage(),
  };
}

function uid(): string {
  // FNV-1a-ish hash over timestamp + rand
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Storage adapter - uses chrome.storage.local for cross-domain data sharing
 * Falls back to localStorage if chrome.storage is unavailable
 */
const pmLogger = logger.createChild('PromptManager');

const normalizeVersionString = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  return trimmed ? trimmed.replace(/^v/i, '') : null;
};

async function readStorage<T>(key: StorageKey, fallback: T): Promise<T> {
  const result = await promptStorageService.get<T>(key);
  if (result.success) {
    return result.data;
  }
  pmLogger.debug(`Key not found: ${key}, using fallback`);
  return fallback;
}

async function writeStorage<T>(key: StorageKey, value: T): Promise<void> {
  const result = await promptStorageService.set(key, value);
  if (!result.success) {
    pmLogger.error(`Failed to write key: ${key}`, {
      error: result.error?.message || 'Unknown error',
      errorDetails: result.error,
    });
  }
}

async function getLatestVersionCached(): Promise<string | null> {
  try {
    if (!browser.runtime?.id) return null;

    const now = Date.now();
    const cache = await browser.storage.local.get(LATEST_VERSION_CACHE_KEY);
    const cached = cache?.[LATEST_VERSION_CACHE_KEY] as
      | { version?: string; fetchedAt?: number }
      | undefined;
    if (
      cached &&
      cached.version &&
      cached.fetchedAt &&
      now - cached.fetchedAt < LATEST_VERSION_MAX_AGE
    ) {
      return cached.version;
    }

    const resp = await fetch('https://api.github.com/repos/Nagi-ovo/voyager/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const candidate =
      typeof data.tag_name === 'string'
        ? data.tag_name
        : typeof data.name === 'string'
          ? data.name
          : null;

    if (candidate) {
      await browser.storage.local.set({
        [LATEST_VERSION_CACHE_KEY]: { version: candidate, fetchedAt: now },
      });
      return candidate;
    }
  } catch (error) {
    pmLogger.debug('Latest version check failed', { error });
  }
  return null;
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function elFromHTML(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createSponsorHeartIcon(size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', SPONSOR_HEART_PATH_16);
  svg.appendChild(path);

  return svg;
}

function renderSupportLinkLabel(link: HTMLAnchorElement, label: string): void {
  const labelEl = createEl('span', 'gv-pm-support-label');
  labelEl.textContent = label;
  link.replaceChildren(createSponsorHeartIcon(), labelEl);
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function collectAllTags(items: PromptItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) for (const t of it.tags || []) set.add(String(t).toLowerCase());
  return Array.from(set).sort();
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

function computeAnchoredPosition(
  trigger: HTMLElement,
  panel: HTMLElement,
): { top: number; left: number } {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const pad = 8;
  const panelW = Math.min(380, Math.max(300, panel.getBoundingClientRect().width || 320));
  const tentativeLeft = Math.min(vw - panelW - pad, Math.max(pad, rect.left + rect.width - panelW));
  const top = Math.max(pad, rect.top - (panel.getBoundingClientRect().height || 360) - 10);
  return { top, left: Math.round(tentativeLeft) };
}

export async function startPromptManager(): Promise<{ destroy: () => void }> {
  let marked!: typeof MarkedFn;
  let DOMPurify!: typeof import('dompurify').default;

  // Lazily load marked + the KaTeX extension only when a markdown preview is
  // actually rendered. marked-katex-extension pulls in the ~265 KB KaTeX chunk,
  // so doing this at startup would load KaTeX on every Gemini/AI Studio page even
  // when the user never opens the prompt panel. Cached after the first call.
  let markdownReady: Promise<void> | null = null;
  const ensureMarkdown = (): Promise<void> => {
    if (!markdownReady) {
      markdownReady = (async () => {
        const [markedModule, katexModule, domPurifyModule] = await Promise.all([
          import('marked'),
          import('marked-katex-extension'),
          import('dompurify'),
        ]);
        marked = markedModule.marked;
        const { default: markedKatex } = katexModule;
        DOMPurify = domPurifyModule.default;
        try {
          // markdown config: single newlines as <br> and KaTeX inline/display math
          marked.use(
            markedKatex({
              throwOnError: false,
              output: 'html',
              trust: true, // Trust the rendering environment (content script context)
              strict: false, // Disable strict mode checks including quirks mode detection
            }),
          );
          marked.setOptions({ breaks: true });
        } catch {}
      })();
    }
    return markdownReady;
  };

  try {
    // Check if the prompt manager should be hidden & changelog badge state
    let pmHiddenByUser = false;
    let changelogBadgeActive = false;
    let promptInsertOnClick = false;

    try {
      const result = await browser.storage.sync.get({ gvHidePromptManager: false });
      pmHiddenByUser = result?.gvHidePromptManager === true;
    } catch (error) {
      pmLogger.warn(
        'Failed to check hide prompt manager setting, continuing with default behavior',
        { error },
      );
    }

    function downloadTextFile(data: string, filename: string, mimeType: string): void {
      const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
      });
      promptInsertOnClick = result?.[StorageKeys.PROMPT_INSERT_ON_CLICK] === true;
    } catch (error) {
      pmLogger.warn('Failed to check prompt click mode setting, falling back to copy behavior', {
        error,
      });
    }

    // Check changelog badge mode
    try {
      const [modeRes, unread] = await Promise.all([
        browser.storage.local.get(StorageKeys.CHANGELOG_NOTIFY_MODE),
        hasUnreadChangelog(),
      ]);
      const notifyMode = modeRes?.[StorageKeys.CHANGELOG_NOTIFY_MODE];
      changelogBadgeActive = notifyMode === 'badge' && unread;
    } catch {
      // Ignore errors
    }

    // Monkey patch console.warn to suppress KaTeX quirks mode warning in content script
    const originalWarn = console.warn;
    console.warn = function (...args) {
      const message = args[0];
      if (
        typeof message === 'string' &&
        (message.includes("KaTeX doesn't work in quirks mode") ||
          message.includes('unicodeTextInMathMode') ||
          message.includes('LaTeX-incompatible input and strict mode'))
      ) {
        return;
      }
      return originalWarn.apply(console, args);
    };

    // Migrate data from localStorage to chrome.storage.local (one-time migration)
    try {
      const keysToMigrate = [
        STORAGE_KEYS.items,
        STORAGE_KEYS.locked,
        STORAGE_KEYS.position,
        STORAGE_KEYS.triggerPos,
      ];

      const migrationResult = await migrateFromLocalStorage(keysToMigrate, promptStorageService, {
        deleteAfterMigration: false, // Keep localStorage as backup
        skipExisting: true, // Skip if already migrated
      });

      if (migrationResult.migratedKeys.length > 0) {
        pmLogger.info('Migrated prompt data from localStorage to chrome.storage.local', {
          migratedKeys: migrationResult.migratedKeys,
        });
      }

      if (migrationResult.errors.length > 0) {
        pmLogger.warn('Some keys failed to migrate', { errors: migrationResult.errors });
      }
    } catch (migrationError) {
      pmLogger.error('Migration failed, continuing with current storage', { migrationError });
      // Continue even if migration fails - data will still work from current storage
    }

    // marked + KaTeX now load lazily via ensureMarkdown() on first preview render.

    // Initialize centralized i18n system
    await initI18n();
    const i18n = createI18n();

    // Prevent duplicate injection
    if (document.getElementById(ID.trigger)) {
      return { destroy: () => {} };
    }

    // Trigger button
    const trigger = createEl('button', 'gv-pm-trigger');
    trigger.id = ID.trigger;
    trigger.setAttribute('aria-label', 'Prompt Manager');
    const img = document.createElement('img');
    img.width = 24;
    img.height = 24;
    img.alt = 'pm';
    img.src = getRuntimeUrl('icon-32.png');
    img.addEventListener(
      'error',
      () => {
        // dev fallback
        const devUrl = getRuntimeUrl('icon-32.png');
        if (img.src !== devUrl) img.src = devUrl;
      },
      { once: true },
    );
    trigger.appendChild(img);
    if (changelogBadgeActive) {
      trigger.classList.add('gv-pm-trigger-new');
    }
    if (pmHiddenByUser && !changelogBadgeActive) {
      trigger.style.display = 'none';
    }
    document.body.appendChild(trigger);
    // Helper: place trigger near a target element (e.g. Gemini FAB touch target)
    function placeTriggerNextToHost(): void {
      try {
        const candidates = Array.from(
          document.querySelectorAll('span.mat-mdc-button-touch-target'),
        ) as HTMLElement[];
        if (!candidates.length) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pick = candidates
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.width > 0 && x.r.height > 0)
          // choose the element closest to bottom-right corner
          .sort((a, b) => a.r.bottom + a.r.right - (b.r.bottom + b.r.right))
          .reduce((_, x) => x, undefined as { el: HTMLElement; r: DOMRect } | undefined);
        if (!pick) return;
        const r = pick.r;
        const th = trigger.getBoundingClientRect().height || 36;
        const gap = 10;
        const right = Math.max(6, Math.round(vw - r.left + gap));
        const bottom = Math.max(6, Math.round(vh - (r.top + r.height / 2 + th / 2)));
        trigger.style.right = `${right}px`;
        trigger.style.bottom = `${bottom}px`;
      } catch {}
    }

    // Helper: constrain trigger position to viewport bounds
    function constrainTriggerPosition(): void {
      try {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = trigger.getBoundingClientRect();
        const tw = rect.width || 44;
        const th = rect.height || 44;
        const minPad = 6;

        // Parse current position
        const currentRight = parseFloat(trigger.style.right || '18') || 18;
        const currentBottom = parseFloat(trigger.style.bottom || '18') || 18;

        // Calculate constraints (ensure at least minPad from edges)
        const maxRight = vw - tw - minPad;
        const maxBottom = vh - th - minPad;

        // Constrain position
        const right = Math.max(minPad, Math.min(currentRight, maxRight));
        const bottom = Math.max(minPad, Math.min(currentBottom, maxBottom));

        trigger.style.right = `${Math.round(right)}px`;
        trigger.style.bottom = `${Math.round(bottom)}px`;
      } catch {}
    }

    // Restore trigger position if saved; otherwise place next to host button
    try {
      const pos = await readStorage<TriggerPosition | null>(STORAGE_KEYS.triggerPos, null);
      if (pos && Number.isFinite(pos.bottom) && Number.isFinite(pos.right)) {
        trigger.style.bottom = `${Math.max(6, Math.round(pos.bottom))}px`;
        trigger.style.right = `${Math.max(6, Math.round(pos.right))}px`;
        // Constrain position after restore to handle window resize/split screen
        requestAnimationFrame(constrainTriggerPosition);
      } else {
        // defer a bit to wait for host DOM
        placeTriggerNextToHost();
        requestAnimationFrame(placeTriggerNextToHost);
        window.setTimeout(placeTriggerNextToHost, 350);
      }
    } catch {
      placeTriggerNextToHost();
    }

    // Panel root
    const panel = createEl('div', 'gv-pm-panel gv-hidden');
    panel.id = ID.panel;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    document.body.appendChild(panel);

    // Build panel DOM
    const header = createEl('div', 'gv-pm-header');
    const dragHandle = createEl('div', 'gv-pm-drag');

    const titleRow = createEl('div', 'gv-pm-title-row');
    const title = createEl('div', 'gv-pm-title');
    const titleText = document.createElement('span');
    titleText.textContent = 'Voyager';
    title.appendChild(titleText);

    const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
    const currentVersionNormalized = normalizeVersionString(manifestVersion);
    const versionBadge = document.createElement('span');
    versionBadge.className = 'gv-pm-version';
    versionBadge.style.cursor = 'pointer';
    versionBadge.title = manifestVersion
      ? `${i18n.t('extensionVersion')} ${manifestVersion}`
      : i18n.t('extensionVersion');
    versionBadge.textContent = manifestVersion ?? '...';

    // Version badge always opens changelog modal
    versionBadge.addEventListener('click', async (e) => {
      e.stopPropagation();
      closePanel();
      // The user explicitly asked for release notes: if the modal cannot
      // open (chunk load blocked, missing notes for this version, …) fall
      // back to the GitHub releases page instead of silently doing nothing,
      // and log the error so site-specific failures (e.g. on Claude/ChatGPT
      // custom websites) are diagnosable from the console.
      const openReleasesFallback = () => {
        window.open('https://github.com/Nagi-ovo/voyager/releases', '_blank', 'noopener');
      };
      // If badge was active, clear it
      if (changelogBadgeActive) {
        changelogBadgeActive = false;
        trigger.classList.remove('gv-pm-trigger-new');
        versionBadge.classList.remove('gv-pm-version-outdated');
        let shown = false;
        try {
          shown = await showChangelogModalDirect();
        } catch (error) {
          logger.error('Changelog modal failed to open', { error: String(error) });
        }
        if (!shown) openReleasesFallback();
        if (pmHiddenByUser) {
          trigger.style.display = 'none';
        }
      } else {
        let shown = false;
        try {
          shown = await openChangelog();
        } catch (error) {
          logger.error('Changelog modal failed to open', { error: String(error) });
        }
        if (!shown) openReleasesFallback();
      }
    });

    // Show NEW mark on version badge when changelog badge is active
    if (changelogBadgeActive) {
      versionBadge.classList.add('gv-pm-version-outdated');
    }

    // Theme toggle
    const themeToggle = createEl('button', 'gv-pm-theme-toggle');
    themeToggle.setAttribute('type', 'button');
    let currentPMTheme: PMTheme = detectPageTheme();

    function applyPMTheme(theme: PMTheme) {
      currentPMTheme = theme;
      panel.setAttribute('data-gv-theme', theme);
      themeToggle.classList.toggle('gv-pm-theme-dark', theme === 'dark');
      themeToggle.replaceChildren(theme === 'dark' ? createMoonIcon(11) : createSunIcon(11));
      themeToggle.title = theme === 'dark' ? i18n.t('pm_theme_light') : i18n.t('pm_theme_dark');
      themeToggle.setAttribute('aria-label', themeToggle.title);
    }

    applyPMTheme(currentPMTheme);

    // Load saved theme preference
    (async () => {
      try {
        const result = await browser.storage.sync.get(STORAGE_KEYS.theme);
        const saved = result[STORAGE_KEYS.theme];
        if (saved === 'light' || saved === 'dark') {
          applyPMTheme(saved);
        }
      } catch {
        // Ignore — keep detected theme
      }
    })();

    themeToggle.addEventListener('click', async () => {
      const newTheme: PMTheme = currentPMTheme === 'dark' ? 'light' : 'dark';
      // Enable smooth color transition on all panel children
      panel.classList.add('gv-pm-transitioning');
      applyPMTheme(newTheme);
      setTimeout(() => panel.classList.remove('gv-pm-transitioning'), 450);
      try {
        await browser.storage.sync.set({ [STORAGE_KEYS.theme]: newTheme });
      } catch {
        try {
          await browser.storage.local.set({ [STORAGE_KEYS.theme]: newTheme });
        } catch {
          // Ignore
        }
      }
    });

    titleRow.appendChild(title);
    titleRow.appendChild(themeToggle);
    titleRow.appendChild(versionBadge);

    // Check for newer version on GitHub (visual indicator only, no link)
    (async () => {
      const isSafariBrowser = isSafari();
      const safariUpdateReminderEnabled = isSafariBrowser && shouldShowSafariUpdateReminder();

      if (isSafariBrowser && !safariUpdateReminderEnabled) return;

      const shouldShowUpdateNotification = shouldShowUpdateReminderForCurrentVersion({
        currentVersion: currentVersionNormalized,
        isSafariBrowser,
        safariReminderEnabled: safariUpdateReminderEnabled,
      });
      if (!shouldShowUpdateNotification) return;

      const latest = await getLatestVersionCached();
      const latestNormalized = normalizeVersionString(latest);
      const hasUpdate =
        currentVersionNormalized && latestNormalized
          ? compareVersions(latestNormalized, currentVersionNormalized) > 0
          : false;

      if (!hasUpdate || !latestNormalized) return;

      versionBadge.classList.add('gv-pm-version-outdated');
      versionBadge.title = `${i18n.t('latestVersionLabel')}: v${latestNormalized}`;
    })();

    const controls = createEl('div', 'gv-pm-controls');

    const langSel = createEl('select', 'gv-pm-lang');
    for (const lang of APP_LANGUAGES) {
      const opt = createEl('option');
      opt.value = lang;
      opt.textContent = APP_LANGUAGE_LABELS[lang];
      langSel.appendChild(opt);
    }
    // Set initial language value asynchronously
    i18n
      .get()
      .then((lang) => {
        langSel.value = lang;
      })
      .catch(() => {
        langSel.value = 'en';
      });

    const lockBtn = createEl('button', 'gv-pm-lock');
    lockBtn.setAttribute('type', 'button');
    lockBtn.setAttribute('aria-pressed', 'false');
    lockBtn.appendChild(createLockOpenIcon(15));
    lockBtn.title = i18n.t('pm_lock');

    const addBtn = createEl('button', 'gv-pm-add');
    addBtn.textContent = i18n.t('pm_add');

    const viewModeBtn = createEl('button', 'gv-pm-view-mode');
    viewModeBtn.setAttribute('type', 'button');
    // Icon, title, and aria-label are set in applyViewModeUI() below.

    controls.appendChild(langSel);
    controls.appendChild(addBtn);
    controls.appendChild(lockBtn);
    header.appendChild(dragHandle);
    header.appendChild(titleRow);
    header.appendChild(controls);

    // Search wrap hosts the search input and, on its right edge, the
    // compact/comfortable view-mode toggle. Keeping the toggle here instead of
    // the header controls row prevents the "Voyager" title from being squeezed
    // into ellipsis, and keeps it adjacent to the list it governs.
    const searchWrap = createEl('div', 'gv-pm-search');
    const searchInput = createEl('input') as HTMLInputElement;
    searchInput.type = 'search';
    searchInput.placeholder = i18n.t('pm_search_placeholder');
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(viewModeBtn);

    const savedToolbar = createEl('div', 'gv-pm-saved-toolbar gv-hidden');
    const savedFilterGroup = createEl('div', 'gv-pm-saved-filters');
    savedFilterGroup.setAttribute('role', 'group');
    const savedFilterButtons = new Map<SavedLibraryFilter, HTMLButtonElement>();
    for (const value of ['all', 'starred', 'highlights'] as const) {
      const button = createEl('button', 'gv-pm-saved-filter');
      button.setAttribute('type', 'button');
      button.addEventListener('click', () => {
        savedFilter = value;
        applySavedFilterUI();
        renderStarredList();
      });
      savedFilterButtons.set(value, button);
      savedFilterGroup.appendChild(button);
    }
    savedToolbar.appendChild(savedFilterGroup);

    const tagsWrapOuter = createEl('div', 'gv-pm-tags-wrap');
    const tagsWrap = createEl('div', 'gv-pm-tags');
    const tagsScrollHint = createEl('div', 'gv-pm-tags-scroll-hint');
    tagsScrollHint.setAttribute('aria-hidden', 'true');
    tagsScrollHint.textContent = '▼';
    tagsWrapOuter.appendChild(tagsWrap);
    tagsWrapOuter.appendChild(tagsScrollHint);

    const list = createEl('div', 'gv-pm-list');

    const footer = createEl('div', 'gv-pm-footer');
    // Primary view switch: the previous local backup slot now opens the
    // Saved Library. Its return action lives in the dedicated saved footer.
    const backupBtn = createEl('button', 'gv-pm-backup-btn');
    backupBtn.setAttribute('type', 'button');

    // Primary actions container
    const primaryActions = createEl('div', 'gv-pm-footer-actions');
    primaryActions.appendChild(backupBtn);

    // Saved Library keeps its two top-level actions in the footer. Export
    // formats are disclosed only after the user asks to export.
    const savedFooterActions = createEl('div', 'gv-pm-saved-footer-actions gv-hidden');
    const promptManagerBtn = createEl(
      'button',
      'gv-pm-saved-footer-button gv-pm-saved-footer-primary',
    );
    promptManagerBtn.setAttribute('type', 'button');
    const promptManagerLabel = createEl('span', 'gv-pm-saved-footer-label');
    promptManagerBtn.append(createArrowLeftIcon(15), promptManagerLabel);

    const savedExportWrap = createEl('div', 'gv-pm-saved-export-wrap');
    const savedExportTrigger = createEl(
      'button',
      'gv-pm-saved-footer-button gv-pm-saved-export-trigger',
    );
    savedExportTrigger.setAttribute('type', 'button');
    savedExportTrigger.setAttribute('aria-haspopup', 'menu');
    savedExportTrigger.setAttribute('aria-expanded', 'false');
    const savedExportLabel = createEl('span', 'gv-pm-saved-footer-label');
    savedExportTrigger.append(createDownloadIcon(15), savedExportLabel, createChevronDownIcon(14));

    const savedExportMenu = createEl('div', 'gv-pm-saved-export-menu gv-hidden');
    savedExportMenu.setAttribute('role', 'menu');
    const exportJsonBtn = createEl('button', 'gv-pm-saved-export-option');
    exportJsonBtn.setAttribute('type', 'button');
    exportJsonBtn.setAttribute('role', 'menuitem');
    exportJsonBtn.append(createBracesIcon(15), document.createTextNode('JSON'));
    const exportMarkdownBtn = createEl('button', 'gv-pm-saved-export-option');
    exportMarkdownBtn.setAttribute('type', 'button');
    exportMarkdownBtn.setAttribute('role', 'menuitem');
    exportMarkdownBtn.append(createFileTextIcon(15), document.createTextNode('Markdown'));
    savedExportMenu.append(exportJsonBtn, exportMarkdownBtn);
    savedExportWrap.append(savedExportTrigger, savedExportMenu);
    savedFooterActions.append(promptManagerBtn, savedExportWrap);

    // Secondary actions container
    const secondaryActions = createEl('div', 'gv-pm-footer-secondary');

    const settingsBtn = createEl('button', 'gv-pm-settings');
    settingsBtn.textContent = i18n.t('pm_settings');
    settingsBtn.title = i18n.t('pm_settings_tooltip');

    const supportLink = document.createElement('a');
    supportLink.className = 'gv-pm-support';
    supportLink.target = '_blank';
    supportLink.rel = 'noreferrer';
    supportLink.title = i18n.t('sponsorMe');

    secondaryActions.appendChild(settingsBtn);
    secondaryActions.appendChild(supportLink);

    footer.appendChild(primaryActions);
    footer.appendChild(savedFooterActions);
    footer.appendChild(secondaryActions);

    const addForm = elFromHTML(
      `<form class="gv-pm-add-form gv-hidden">
        <input class="gv-pm-input-name" type="text" maxlength="60" required aria-required="true" placeholder="${escapeHtml(
          i18n.t('pm_name_placeholder') || 'Name',
        )}" />
        <textarea class="gv-pm-input-text" placeholder="${escapeHtml(
          i18n.t('pm_prompt_placeholder') || 'Prompt text',
        )}" rows="3"></textarea>
        <input class="gv-pm-input-tags" type="text" placeholder="${escapeHtml(
          i18n.t('pm_tags_placeholder') || 'Tags (comma separated)',
        )}" />
        <div class="gv-pm-add-actions">
          <span class="gv-pm-inline-hint" aria-live="polite"></span>
          <button type="submit" class="gv-pm-save">${escapeHtml(i18n.t('pm_save') || 'Save')}</button>
          <button type="button" class="gv-pm-cancel">${escapeHtml(
            i18n.t('pm_cancel') || 'Cancel',
          )}</button>
        </div>
      </form>`,
    );

    // Notice as floating toast (not in footer layout)
    const notice = createEl('div', 'gv-pm-notice');

    panel.appendChild(header);
    panel.appendChild(searchWrap);
    panel.appendChild(savedToolbar);
    panel.appendChild(tagsWrapOuter);
    panel.appendChild(addForm);
    panel.appendChild(list);
    panel.appendChild(footer);
    panel.appendChild(notice);

    // State
    let items: PromptItem[] = await readStorage<PromptItem[]>(STORAGE_KEYS.items, []);
    let open = false;
    // Restore the tag filter saved in a previous session (#729), reconciled
    // against the tags that still exist so a deleted/renamed tag can't strand
    // the list on a chip-less filter. Local-only on purpose — see
    // STORAGE_KEYS.selectedTags / tagFilterState.ts.
    let selectedTags: Set<string> = new Set<string>(
      sanitizeSelectedTags(
        await readStorage<string[]>(STORAGE_KEYS.selectedTags, []),
        collectAllTags(items),
      ),
    );
    let locked = !!(await readStorage<boolean>(STORAGE_KEYS.locked, false));
    let savedPos = await readStorage<PanelPosition | null>(STORAGE_KEYS.position, null);
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };
    let draggingTrigger = false;
    let editingId: string | null = null;
    let expandedItems: Set<string> = new Set<string>(); // Track expanded prompt items
    let viewMode: PMViewMode = 'compact';
    let panelView: PMPanelView = 'prompts';
    let promptSearchValue = '';
    let starredSearchValue = '';
    let starredMessages: StarredMessage[] = [];
    let highlightRecords: HighlightRecordV1[] = [];
    let savedFilter: SavedLibraryFilter = 'all';
    let starredLoading = false;
    let starredLoadError = false;
    let savedExportMenuOpen = false;

    function setNotice(text: string, kind: 'ok' | 'err' = 'ok') {
      notice.textContent = text || '';
      notice.classList.toggle('ok', kind === 'ok');
      notice.classList.toggle('err', kind === 'err');
      if (text) {
        window.setTimeout(() => {
          if (notice.textContent === text) notice.textContent = '';
        }, 1800);
      }
    }

    function setInlineHint(text: string, kind: 'ok' | 'err' = 'err'): void {
      const hint = addForm.querySelector('.gv-pm-inline-hint') as HTMLSpanElement | null;
      if (!hint) return;
      hint.textContent = text || '';
      hint.classList.toggle('ok', kind === 'ok');
      hint.classList.toggle('err', kind === 'err');
    }

    function syncTagScrollHint(): void {
      const { isOverflowing, showHint } = getScrollHintState(
        tagsWrap.scrollTop,
        tagsWrap.clientHeight,
        tagsWrap.scrollHeight,
      );
      tagsWrapOuter.classList.toggle('gv-pm-tags-scrollable', isOverflowing);
      tagsWrapOuter.classList.toggle('gv-pm-tags-scroll-end', !showHint);
    }

    /* Fast, interactive hover tooltip for compact rows.
     *
     * Opens ~250 ms after mouseenter. Closes ~150 ms after mouseleave — long
     * enough for the user to cross the gap onto the tooltip itself, where
     * they can read the full prompt and scroll long content. Entering the
     * tooltip cancels any pending hide; leaving the tooltip schedules one.
     * A singleton element is reused across rows. */
    const TOOLTIP_OPEN_DELAY_MS = 250;
    const TOOLTIP_HIDE_GRACE_MS = 150;
    let tooltipEl: HTMLDivElement | null = null;
    let tooltipOpenTimer: number | null = null;
    let tooltipHideTimer: number | null = null;
    let tooltipTargetHovered = false;
    let tooltipSelfHovered = false;

    function clearOpenTimer(): void {
      if (tooltipOpenTimer !== null) {
        window.clearTimeout(tooltipOpenTimer);
        tooltipOpenTimer = null;
      }
    }

    function clearHideTimer(): void {
      if (tooltipHideTimer !== null) {
        window.clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      }
    }

    function actuallyHideTooltip(): void {
      clearOpenTimer();
      clearHideTimer();
      tooltipTargetHovered = false;
      tooltipSelfHovered = false;
      if (tooltipEl) {
        tooltipEl.classList.remove('gv-pm-tooltip-visible');
      }
    }

    // External callers (closePanel, destroy, scroll listeners) want a hard
    // dismiss; row/tooltip mouse handlers use scheduleHide with grace.
    const hideTooltip = actuallyHideTooltip;

    function scheduleHide(): void {
      clearHideTimer();
      tooltipHideTimer = window.setTimeout(() => {
        tooltipHideTimer = null;
        if (!tooltipSelfHovered && !tooltipTargetHovered) {
          actuallyHideTooltip();
        }
      }, TOOLTIP_HIDE_GRACE_MS);
    }

    function ensureTooltipEl(): HTMLDivElement {
      if (tooltipEl) return tooltipEl;
      const el = document.createElement('div');
      el.className = 'gv-pm-tooltip';
      el.setAttribute('role', 'tooltip');
      // Entering the tooltip cancels any pending hide; leaving schedules it.
      // This is what lets the user glide from row → gap → tooltip and scroll.
      el.addEventListener('mouseenter', () => {
        tooltipSelfHovered = true;
        clearHideTimer();
      });
      el.addEventListener('mouseleave', () => {
        tooltipSelfHovered = false;
        scheduleHide();
      });
      document.body.appendChild(el);
      tooltipEl = el;
      return el;
    }

    function showTooltip(target: HTMLElement, fullText: string): void {
      const el = ensureTooltipEl();
      // Reset scroll so each open starts at the top of the content.
      el.scrollTop = 0;
      el.textContent = fullText;
      el.setAttribute('data-gv-theme', panel.getAttribute('data-gv-theme') || '');

      // Position: prefer above the target, fall back to below if clipped.
      // Measurement requires the element to be laid out, so reveal first then
      // adjust; CSS keeps it invisible until the `-visible` class is applied.
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.visibility = 'hidden';
      el.classList.add('gv-pm-tooltip-visible');
      const targetRect = target.getBoundingClientRect();
      const tipRect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      let left = targetRect.left;
      if (left + tipRect.width > vw - pad) left = vw - pad - tipRect.width;
      if (left < pad) left = pad;

      let top = targetRect.top - tipRect.height - 6;
      if (top < pad) {
        top = targetRect.bottom + 6;
        if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - pad - tipRect.height);
      }

      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.visibility = '';
    }

    function attachPromptTooltip(target: HTMLElement, fullText: string, _host: HTMLElement): void {
      target.addEventListener('mouseenter', () => {
        tooltipTargetHovered = true;
        clearHideTimer();
        clearOpenTimer();
        tooltipOpenTimer = window.setTimeout(() => {
          tooltipOpenTimer = null;
          if (tooltipTargetHovered) showTooltip(target, fullText);
        }, TOOLTIP_OPEN_DELAY_MS);
      });
      target.addEventListener('mouseleave', () => {
        tooltipTargetHovered = false;
        // Cancel a pending open (user left before it showed) — otherwise give
        // them the grace window to cross onto the tooltip.
        if (tooltipOpenTimer !== null) {
          clearOpenTimer();
          actuallyHideTooltip();
          return;
        }
        scheduleHide();
      });
      // A click/press activates the prompt; dismiss the hover preview immediately.
      target.addEventListener('mousedown', actuallyHideTooltip);
    }

    // Dismiss on scroll or panel-wide events so the tooltip never ends up
    // orphaned when the list scrolls under it. Exception: scrolling *inside*
    // the tooltip itself (long prompts now paginate within max-height) must
    // keep it open — otherwise the interactive preview is useless.
    const tooltipScrollTargets: Array<HTMLElement | Window> = [list, window];
    const onTooltipDismiss = (ev: Event) => {
      const t = ev.target as Node | null;
      if (tooltipEl && t && (t === tooltipEl || tooltipEl.contains(t))) return;
      actuallyHideTooltip();
    };
    for (const target of tooltipScrollTargets) {
      target.addEventListener('scroll', onTooltipDismiss, { passive: true, capture: true });
    }

    function applyViewModeUI(): void {
      panel.setAttribute('data-gv-view', viewMode);
      const isCompact = viewMode === 'compact';
      viewModeBtn.classList.toggle('gv-pm-view-mode-compact', isCompact);
      viewModeBtn.replaceChildren(isCompact ? createLayoutGridIcon(15) : createListIcon(15));
      // Tooltip describes the action the click will perform, not the current state.
      const nextTip = isCompact
        ? i18n.t('pm_view_comfortable') || 'Switch to comfortable view'
        : i18n.t('pm_view_compact') || 'Switch to compact list';
      viewModeBtn.title = nextTip;
      viewModeBtn.setAttribute('aria-label', nextTip);
      viewModeBtn.setAttribute('aria-pressed', isCompact ? 'true' : 'false');
    }

    applyViewModeUI();

    // Load saved view mode preference. Prefer sync (follows theme pattern),
    // but fall back to local — keeps symmetry with the write path, which
    // writes to local when sync is unavailable (Safari, sync-disabled
    // profiles). Without this fallback, those environments lose the user's
    // choice on every reload.
    (async () => {
      let saved: unknown = null;
      try {
        const result = await browser.storage.sync.get(StorageKeys.PROMPT_VIEW_MODE);
        saved = result[StorageKeys.PROMPT_VIEW_MODE];
      } catch {
        // Fall through to local
      }
      if (saved !== 'compact' && saved !== 'comfortable') {
        try {
          const result = await browser.storage.local.get(StorageKeys.PROMPT_VIEW_MODE);
          saved = result[StorageKeys.PROMPT_VIEW_MODE];
        } catch {
          // Keep default on failure
        }
      }
      if (saved === 'compact' || saved === 'comfortable') {
        viewMode = saved;
        applyViewModeUI();
        renderList();
      }
    })();

    viewModeBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (panelView !== 'prompts') return;
      viewMode = viewMode === 'compact' ? 'comfortable' : 'compact';
      applyViewModeUI();
      renderList();
      try {
        await browser.storage.sync.set({ [StorageKeys.PROMPT_VIEW_MODE]: viewMode });
      } catch {
        try {
          await browser.storage.local.set({ [StorageKeys.PROMPT_VIEW_MODE]: viewMode });
        } catch {
          // Ignore persistence failures; UI state still updates.
        }
      }
      try {
        (ev.currentTarget as HTMLButtonElement)?.blur?.();
      } catch {}
    });

    function applySavedFilterUI(): void {
      const labels: Record<SavedLibraryFilter, TranslationKey> = {
        all: 'savedLibraryAll',
        starred: 'savedLibraryStars',
        highlights: 'savedLibraryHighlights',
      };
      savedFilterButtons.forEach((button, value) => {
        button.textContent = i18n.t(labels[value]);
        button.classList.toggle('active', value === savedFilter);
        button.setAttribute('aria-pressed', value === savedFilter ? 'true' : 'false');
      });
      savedFilterGroup.setAttribute('aria-label', i18n.t('pm_starred_library'));
      exportJsonBtn.title = `${i18n.t('pm_export')} JSON`;
      exportJsonBtn.setAttribute('aria-label', exportJsonBtn.title);
      exportMarkdownBtn.title = `${i18n.t('pm_export')} Markdown`;
      exportMarkdownBtn.setAttribute('aria-label', exportMarkdownBtn.title);
      promptManagerLabel.textContent = i18n.t('pm_open_prompt_manager');
      promptManagerBtn.title = i18n.t('pm_open_prompt_manager');
      promptManagerBtn.setAttribute('aria-label', promptManagerBtn.title);
      savedExportLabel.textContent = i18n.t('pm_export_format');
      savedExportTrigger.title = i18n.t('pm_export_format');
      savedExportTrigger.setAttribute('aria-label', savedExportTrigger.title);
      savedExportMenu.setAttribute('aria-label', i18n.t('pm_export_format'));
    }

    function setSavedExportMenuOpen(nextOpen: boolean, focusFirst = false): void {
      savedExportMenuOpen = nextOpen && panelView === 'starred';
      savedExportMenu.classList.toggle('gv-hidden', !savedExportMenuOpen);
      savedExportTrigger.setAttribute('aria-expanded', savedExportMenuOpen ? 'true' : 'false');
      savedExportWrap.classList.toggle('gv-pm-saved-export-open', savedExportMenuOpen);
      if (savedExportMenuOpen && focusFirst) {
        exportJsonBtn.focus();
      }
    }

    function applyPanelViewUI(): void {
      const isStarredView = panelView === 'starred';
      panel.setAttribute('data-gv-panel-view', panelView);
      titleText.textContent = isStarredView ? i18n.t('pm_starred_library') : 'Voyager';
      backupBtn.replaceChildren(
        createStarIcon(15),
        document.createTextNode(i18n.t('pm_starred_library')),
      );
      backupBtn.title = i18n.t('pm_starred_library');
      backupBtn.setAttribute('aria-label', backupBtn.title);
      searchInput.placeholder = isStarredView
        ? i18n.t('savedLibrarySearchPlaceholder')
        : i18n.t('pm_search_placeholder');
      addBtn.classList.toggle('gv-hidden', isStarredView);
      viewModeBtn.classList.toggle('gv-hidden', isStarredView);
      tagsWrapOuter.classList.toggle('gv-hidden', isStarredView);
      savedToolbar.classList.toggle('gv-hidden', !isStarredView);
      primaryActions.classList.toggle('gv-hidden', isStarredView);
      savedFooterActions.classList.toggle('gv-hidden', !isStarredView);
      secondaryActions.classList.toggle('gv-hidden', isStarredView);
      if (!isStarredView) setSavedExportMenuOpen(false);
      if (isStarredView) {
        addForm.classList.add('gv-hidden');
        editingId = null;
        hideTooltip();
      }
      applySavedFilterUI();
    }

    function renderActiveList(): void {
      if (panelView === 'starred') renderStarredList();
      else renderList();
    }

    async function persistPanelView(nextView: PMPanelView): Promise<void> {
      try {
        await browser.storage.sync.set({ [StorageKeys.PROMPT_PANEL_VIEW]: nextView });
      } catch {
        try {
          await browser.storage.local.set({ [StorageKeys.PROMPT_PANEL_VIEW]: nextView });
        } catch {
          // Ignore persistence failures; the visible panel state still updates.
        }
      }
    }

    async function loadStarredMessages(): Promise<void> {
      starredLoading = true;
      starredLoadError = false;
      renderStarredList();
      try {
        [starredMessages, highlightRecords] = await Promise.all([
          StarredMessagesService.getAllStarredMessagesSorted(),
          loadCurrentAccountHighlightRecords(),
        ]);
      } catch (error) {
        console.warn('[PromptManager] Failed to load saved library:', error);
        starredLoadError = true;
        starredMessages = [];
        highlightRecords = [];
        setNotice(i18n.t('pm_starred_load_error'), 'err');
      } finally {
        starredLoading = false;
        renderStarredList();
      }
    }

    async function exportHighlights(format: 'json' | 'markdown'): Promise<void> {
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'gv.highlight.export',
          payload: { format, scope: await resolveCurrentHighlightScope() },
        })) as { ok?: boolean; data?: string; filename?: string; error?: string } | undefined;
        if (!response?.ok || typeof response.data !== 'string') {
          throw new Error(response?.error || 'Highlight export failed');
        }
        downloadTextFile(
          response.data,
          response.filename || `gemini-voyager-highlights.${format === 'json' ? 'json' : 'md'}`,
          format === 'json' ? 'application/json' : 'text/markdown',
        );
      } catch (error) {
        logger.warn('[PromptManager] Failed to export highlights', { error: String(error) });
        setNotice(i18n.t('promptExportError'), 'err');
      }
    }

    function switchPanelView(nextView: PMPanelView): void {
      if (panelView === nextView) return;
      if (panelView === 'starred') starredSearchValue = searchInput.value || '';
      else promptSearchValue = searchInput.value || '';
      panelView = nextView;
      void persistPanelView(nextView);
      searchInput.value = panelView === 'starred' ? starredSearchValue : promptSearchValue;
      applyPanelViewUI();
      if (panelView === 'starred') {
        void loadStarredMessages();
      } else {
        renderTags();
        renderList();
        requestAnimationFrame(syncTagScrollHint);
      }
    }

    function getStarredEmptyText(query: string): string {
      if (starredLoadError) return i18n.t('pm_starred_load_error');
      if (query) return i18n.t('pm_starred_no_results');
      if (savedFilter === 'highlights') return i18n.t('savedLibraryNoHighlights');
      if (savedFilter === 'starred') return i18n.t('noStarredMessages');
      return i18n.t('savedLibraryEmpty');
    }

    function renderStarredList(): void {
      hideTooltip();
      const savedScrollTop = list.scrollTop;
      const query = (searchInput.value || '').trim();
      const filtered = filterSavedLibraryItems(
        toSavedLibraryItems(starredMessages, highlightRecords),
        savedFilter,
        query,
      );
      list.innerHTML = '';

      if (starredLoading) {
        const loading = createEl('div', 'gv-pm-empty gv-pm-starred-empty');
        loading.textContent = i18n.t('loading') || 'Loading...';
        list.appendChild(loading);
        return;
      }

      if (starredLoadError || filtered.length === 0) {
        const empty = createEl('div', 'gv-pm-empty gv-pm-starred-empty');
        empty.textContent = getStarredEmptyText(query);
        list.appendChild(empty);
        return;
      }

      const frag = document.createDocumentFragment();
      for (const item of filtered) {
        const row = createEl('button', 'gv-pm-starred-item');
        row.setAttribute('type', 'button');
        row.setAttribute('dir', 'auto');
        row.title = i18n.t('pm_starred_open');
        row.addEventListener('click', (event) => {
          event.preventDefault();
          void (async () => {
            await persistPanelView('starred');
            if (navigateToSavedLibraryItem(item)) closePanel();
          })();
        });

        const icon = createEl('span', 'gv-pm-starred-icon');
        if (item.kind === 'starred') icon.appendChild(createStarIcon(16, true));
        icon.classList.toggle('gv-pm-highlight-icon', item.kind === 'highlight');
        if (item.kind === 'highlight') {
          icon.setAttribute('data-highlight-color', item.color || 'yellow');
          icon.style.backgroundColor = getHighlightColorHex(item.color || 'yellow');
        }
        icon.setAttribute('aria-hidden', 'true');

        const body = createEl('span', 'gv-pm-starred-body');
        const title = createEl('span', 'gv-pm-starred-title');
        title.textContent =
          (item.conversationTitle && item.conversationTitle.trim()) ||
          i18n.t('pm_starred_untitled');
        const content = createEl('span', 'gv-pm-starred-content');
        content.textContent = item.content || '';
        let note: HTMLSpanElement | null = null;
        if (item.note) {
          note = createEl('span', 'gv-pm-highlight-note');
          note.textContent = item.note;
        }
        const meta = createEl('span', 'gv-pm-starred-meta');
        meta.textContent = `${
          item.kind === 'starred' ? i18n.t('savedLibraryStars') : i18n.t('savedLibraryHighlights')
        } · ${formatStarredMessageTime(item.savedAt)}`;
        body.appendChild(title);
        body.appendChild(content);
        if (note) body.appendChild(note);
        body.appendChild(meta);

        const removeBtn = createEl('button', 'gv-pm-starred-remove');
        removeBtn.setAttribute('type', 'button');
        const removeLabel =
          item.kind === 'starred' ? i18n.t('removeFromStarred') : i18n.t('pm_delete');
        removeBtn.title = removeLabel;
        removeBtn.setAttribute('aria-label', removeLabel);
        removeBtn.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const removed =
            item.kind === 'starred'
              ? await StarredMessagesService.removeStarredMessage(
                  item.conversationId,
                  item.turnId,
                ).then(() => true)
              : await removeStoredHighlight(item);
          if (!removed) {
            setNotice(i18n.t('highlightDeleteFailed'), 'err');
            return;
          }
          if (item.kind === 'starred') {
            starredMessages = starredMessages.filter(
              (message) =>
                message.conversationId !== item.conversationId || message.turnId !== item.turnId,
            );
          } else {
            highlightRecords = highlightRecords.filter((record) => record.id !== item.id);
          }
          renderStarredList();
          setNotice(i18n.t('pm_deleted') || 'Deleted', 'ok');
        });

        row.appendChild(icon);
        row.appendChild(body);
        row.appendChild(removeBtn);
        frag.appendChild(row);
      }
      list.appendChild(frag);
      const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(savedScrollTop, maxScroll);
    }

    // Restore the last Prompt Manager sub-view. This mirrors the compact /
    // comfortable preference so a starred-message navigation does not drop the
    // user back into the prompt list after the Gemini route changes.
    (async () => {
      let saved: unknown = null;
      try {
        const result = await browser.storage.sync.get(StorageKeys.PROMPT_PANEL_VIEW);
        saved = result[StorageKeys.PROMPT_PANEL_VIEW];
      } catch {
        // Fall through to local
      }
      if (!isPMPanelView(saved)) {
        try {
          const result = await browser.storage.local.get(StorageKeys.PROMPT_PANEL_VIEW);
          saved = result[StorageKeys.PROMPT_PANEL_VIEW];
        } catch {
          // Keep default on failure
        }
      }
      if (isPMPanelView(saved) && saved !== panelView) {
        panelView = saved;
        searchInput.value = panelView === 'starred' ? starredSearchValue : promptSearchValue;
        applyPanelViewUI();
        if (panelView === 'starred' && open) void loadStarredMessages();
        else renderActiveList();
      }
    })();

    // Fire-and-forget: the in-memory Set drives the UI; a failed write just
    // means the filter isn't restored next session. Never blocks a click.
    function persistSelectedTags(): void {
      void writeStorage(STORAGE_KEYS.selectedTags, Array.from(selectedTags));
    }

    function renderTags(): void {
      const all = collectAllTags(items);
      // Self-heal: if a previously selected tag's prompts were all deleted or
      // retagged this session, drop it so the filter can't get stuck on a
      // chip-less ghost tag that hides every prompt. Persist only on a real
      // change to avoid redundant writes on every render.
      const valid = sanitizeSelectedTags(Array.from(selectedTags), all);
      if (valid.length !== selectedTags.size) {
        selectedTags = new Set(valid);
        persistSelectedTags();
      }
      tagsWrap.innerHTML = '';
      const allBtn = createEl('button', 'gv-pm-tag');
      allBtn.textContent = i18n.t('pm_all_tags') || 'All';
      allBtn.classList.toggle('active', selectedTags.size === 0);
      allBtn.addEventListener('click', () => {
        selectedTags = new Set();
        persistSelectedTags();
        renderTags();
        renderList();
      });
      tagsWrap.appendChild(allBtn);
      for (const tag of all) {
        const btn = createEl('button', 'gv-pm-tag');
        btn.textContent = tag;
        btn.classList.toggle('active', selectedTags.has(tag));
        btn.addEventListener('click', () => {
          if (selectedTags.has(tag)) selectedTags.delete(tag);
          else selectedTags.add(tag);
          persistSelectedTags();
          renderTags();
          renderList();
        });
        tagsWrap.appendChild(btn);
      }
      requestAnimationFrame(syncTagScrollHint);
    }

    function renderList(): void {
      if (panelView !== 'prompts') {
        renderStarredList();
        return;
      }
      // Rebuilding the list destroys every row's DOM. Any pending hover-open
      // timer would fire against a detached target (getBoundingClientRect()
      // returns zeros → tooltip mispositioned) and any visible tooltip would
      // display stale content. Close it up front so every re-render starts
      // from a clean state.
      hideTooltip();

      // Preserve the user's scroll position across the wipe-and-rebuild.
      // Without this, actions like expand/collapse, search, tag filter,
      // view-mode toggle, and cloud-sync updates all snap the list back to
      // the top — most painful on the expand button, which fires a re-render
      // right as the user is reading further down the list.
      const savedScrollTop = list.scrollTop;

      const q = (searchInput.value || '').trim().toLowerCase();
      const selectedTagList = Array.from(selectedTags);
      const nameConflictIds = getPromptNameConflictIds(items);
      const filtered = items.filter((it) => {
        const okTag =
          selectedTagList.length === 0 || selectedTagList.every((t) => it.tags.includes(t));
        if (!okTag) return false;
        if (!q) return true;
        // Include the user-authored name so searching for the label shown in
        // compact mode always finds the prompt even when the Markdown body
        // doesn't contain that string.
        return (
          it.text.toLowerCase().includes(q) ||
          it.tags.some((t) => t.includes(q)) ||
          (it.name ? it.name.toLowerCase().includes(q) : false)
        );
      });
      list.innerHTML = '';
      if (filtered.length === 0) {
        const empty = createEl('div', 'gv-pm-empty');
        empty.textContent = i18n.t('pm_empty') || 'No prompts yet';
        list.appendChild(empty);
        // Nothing to scroll back to; avoid setting scrollTop on an empty list.
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of filtered) {
        const row = createEl('div', 'gv-pm-item');

        // Create text container with expand/collapse functionality
        const textContainer = createEl('div', 'gv-pm-item-text-container');
        const textBtn = createEl('button', 'gv-pm-item-text');

        // Compact mode collapses each prompt to a single-line plaintext title
        // to maximize density; expanding promotes the row back to the rich
        // Markdown preview used in comfortable mode.
        const isExpanded = expandedItems.has(it.id);
        const compactCollapsed = viewMode === 'compact' && !isExpanded;
        if (compactCollapsed) {
          row.classList.add('gv-pm-item-compact');
        }

        // Render Markdown + KaTeX preview (sanitized)
        const md = document.createElement('div');
        md.className = 'gv-md';

        if (compactCollapsed) {
          md.classList.add('gv-pm-compact-title');
          // User-authored `name` takes precedence so prompts can be labeled
          // independently of their Markdown body.
          md.textContent = (it.name && it.name.trim()) || extractPlainTitle(it.text);
          // Attach a lightweight, fast-opening hover tooltip for peek.
          attachPromptTooltip(textBtn, it.text, panel);
        } else {
          // Apply collapsed class if not expanded (comfortable mode: 5-line clamp)
          if (!isExpanded) {
            md.classList.add('gv-md-collapsed');
          }
        }

        // Insert element into DOM first, then render to ensure KaTeX can detect document mode correctly
        textBtn.appendChild(md);

        if (!compactCollapsed) {
          // Defer rendering to next frame to ensure element is fully attached
          requestAnimationFrame(() => {
            void ensureMarkdown()
              .then(() => {
                const out = marked.parse(it.text as string);
                if (typeof out === 'string') {
                  md.innerHTML = DOMPurify.sanitize(out);
                } else {
                  return out.then((html: string) => {
                    md.innerHTML = DOMPurify.sanitize(html);
                  });
                }
              })
              .catch(() => {
                md.textContent = it.text;
              });
          });
        }

        textBtn.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          void activatePromptText(it.text, promptInsertOnClick, {
            copyText,
            expandInputCollapseIfNeeded,
            insertTextIntoChatInput,
          }).then((result) => {
            setNotice(
              result === 'inserted'
                ? i18n.t('pm_inserted') || 'Inserted'
                : i18n.t('pm_copied') || 'Copied',
              'ok',
            );
          });
        });
        textBtn.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          void activatePromptText(it.text, promptInsertOnClick, {
            copyText,
            expandInputCollapseIfNeeded,
            insertTextIntoChatInput,
          }).then((result) => {
            setNotice(
              result === 'inserted'
                ? i18n.t('pm_inserted') || 'Inserted'
                : i18n.t('pm_copied') || 'Copied',
              'ok',
            );
          });
        });

        // Add expand/collapse button
        const expandBtn = createEl('button', 'gv-pm-expand-btn');
        expandBtn.innerHTML = isExpanded ? '▲' : '▼';
        expandBtn.title = isExpanded
          ? i18n.t('pm_collapse') || 'Collapse'
          : i18n.t('pm_expand') || 'Expand';
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedItems.has(it.id)) {
            expandedItems.delete(it.id);
          } else {
            expandedItems.add(it.id);
          }
          renderList();
        });

        textContainer.appendChild(textBtn);
        // In compact mode the expand button is moved into the right-side
        // actions cluster (see below) so all right-aligned controls form a
        // single group and can't overlap each other. In comfortable mode
        // it stays inline with the text for progressive disclosure.
        if (!compactCollapsed) {
          textContainer.appendChild(expandBtn);
        }

        // Edit button
        const editBtn = createEl('button', 'gv-pm-edit');
        editBtn.setAttribute('aria-label', i18n.t('pm_edit') || 'Edit');
        //editBtn.textContent = '✏️';
        editBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Start inline edit using the add form fields
          (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = it.name ?? '';
          (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = it.text;
          (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = (
            it.tags || []
          ).join(', ');
          addForm.classList.remove('gv-hidden');
          (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).focus();
          editingId = it.id;
        });
        const bottom = createEl('div', 'gv-pm-bottom');
        const meta = createEl('div', 'gv-pm-item-meta');
        if (nameConflictIds.has(it.id)) {
          row.classList.add('gv-pm-item-name-conflict');
          const conflict = createEl('span', 'gv-pm-chip gv-pm-name-conflict');
          conflict.textContent =
            i18n.t('pm_name_conflict_badge') || 'Duplicate name — rename to use /';
          meta.appendChild(conflict);
        }
        for (const t of it.tags) {
          const chip = createEl('span', 'gv-pm-chip');
          chip.textContent = t;
          chip.addEventListener('click', () => {
            if (selectedTags.has(t)) selectedTags.delete(t);
            else selectedTags.add(t);
            renderTags();
            renderList();
          });
          meta.appendChild(chip);
        }
        // Actions container at row bottom-right
        const actions = createEl('div', 'gv-pm-actions');
        const del = createEl('button', 'gv-pm-del');
        del.title = i18n.t('pm_delete') || 'Delete';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          // inline confirm popover (floating)
          if (document.body.querySelector('.gv-pm-confirm')) return; // one at a time
          const pop = document.createElement('div');
          pop.className = 'gv-pm-confirm';
          const msg = document.createElement('span');
          msg.textContent = i18n.t('pm_delete_confirm') || 'Delete this prompt?';
          const yes = document.createElement('button');
          yes.className = 'gv-pm-confirm-yes';
          yes.textContent = i18n.t('pm_delete') || 'Delete';
          const no = document.createElement('button');
          no.textContent = i18n.t('pm_cancel') || 'Cancel';
          pop.appendChild(msg);
          pop.appendChild(yes);
          pop.appendChild(no);
          document.body.appendChild(pop);
          // position near button
          const r = del.getBoundingClientRect();
          const vw = window.innerWidth;
          const side: 'left' | 'right' = r.right + 220 > vw ? 'left' : 'right';
          const top = Math.max(8, r.top + window.scrollY - 6);
          const left =
            side === 'right'
              ? r.right + window.scrollX + 10
              : r.left + window.scrollX - pop.offsetWidth - 10;
          pop.style.top = `${Math.round(top)}px`;
          pop.style.left = `${Math.round(Math.max(8, left))}px`;
          pop.setAttribute('data-side', side);
          const cleanup = () => {
            try {
              pop.remove();
            } catch {}
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('click', onOutside, true);
          };
          const onOutside = (ev: MouseEvent) => {
            const t = ev.target as HTMLElement;
            if (!t.closest('.gv-pm-confirm')) cleanup();
          };
          const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') cleanup();
          };
          window.addEventListener('click', onOutside, true);
          window.addEventListener('keydown', onKey, { passive: true });
          no.addEventListener('click', (ev) => {
            ev.stopPropagation();
            cleanup();
          });
          yes.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            items = items.filter((x) => x.id !== it.id);
            await writeStorage(STORAGE_KEYS.items, items);
            cleanup();
            renderTags();
            renderList();
            setNotice(i18n.t('pm_deleted') || 'Deleted', 'ok');
          });
        });

        // Append text container instead of textBtn
        row.appendChild(textContainer);

        // In compact mode, expand sits at the left of edit/del so the cluster
        // reads [chip] [▼] [✎] [🗑] from left to right — one cohesive group.
        if (compactCollapsed) {
          actions.appendChild(expandBtn);
        }
        actions.appendChild(editBtn);
        actions.appendChild(del);
        bottom.appendChild(meta);
        bottom.appendChild(actions);
        row.appendChild(bottom);
        frag.appendChild(row);
      }
      list.appendChild(frag);
      // Restore scroll position after the DOM is laid out. Clamped to the
      // new scrollHeight so a re-filter that shrinks the list doesn't leave
      // us at an impossible offset.
      const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(savedScrollTop, maxScroll);
      // KaTeX rendered during Markdown step, no post-typeset needed
    }

    function openPanel(): void {
      open = true;
      panel.classList.remove('gv-hidden');
      if (locked && savedPos) {
        // Clamp the saved position to the current viewport. Without this, a
        // panel pinned on a wider screen renders past the edge after the user
        // narrows the window — and since dragging/the unlock button are gated
        // on `!locked`, the user gets stuck. See #635.
        const pad = 8;
        const rect = panel.getBoundingClientRect();
        const panelW = rect.width || 320;
        const panelH = rect.height || 360;
        const left = Math.max(pad, Math.min(savedPos.left, window.innerWidth - panelW - pad));
        const top = Math.max(pad, Math.min(savedPos.top, window.innerHeight - panelH - pad));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
      } else {
        // measure after making visible
        const pos = computeAnchoredPosition(trigger, panel);
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
      }
      requestAnimationFrame(syncTagScrollHint);
    }

    function closePanel(): void {
      open = false;
      panel.classList.add('gv-hidden');
      setSavedExportMenuOpen(false);
      hideTooltip();
    }

    function applyLockUI(): void {
      lockBtn.classList.toggle('active', locked);
      lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
      lockBtn.replaceChildren(locked ? createLockIcon(15) : createLockOpenIcon(15));
      lockBtn.title = locked ? i18n.t('pm_unlock') || 'Unlock' : i18n.t('pm_lock') || 'Lock';
      lockBtn.setAttribute('aria-label', lockBtn.title);
      panel.classList.toggle('gv-locked', locked);
    }

    function refreshUITexts(): void {
      // Keep custom icon + label
      addBtn.textContent = i18n.t('pm_add');
      renderSupportLinkLabel(supportLink, i18n.t('sponsorMe'));
      supportLink.title = i18n.t('sponsorMe');
      i18n.get().then((lang) => {
        supportLink.href =
          lang === 'zh'
            ? 'https://voyager.nagi.fun/guide/sponsor.html'
            : `https://voyager.nagi.fun/${lang}/guide/sponsor.html`;
      });

      settingsBtn.textContent = i18n.t('pm_settings');
      settingsBtn.title = i18n.t('pm_settings_tooltip');
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).placeholder =
        i18n.t('pm_name_placeholder');
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).placeholder =
        i18n.t('pm_prompt_placeholder');
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).placeholder =
        i18n.t('pm_tags_placeholder');
      (addForm.querySelector('.gv-pm-save') as HTMLButtonElement).textContent = i18n.t('pm_save');
      (addForm.querySelector('.gv-pm-cancel') as HTMLButtonElement).textContent =
        i18n.t('pm_cancel');
      applyLockUI();
      applyViewModeUI();
      applyPanelViewUI();
      renderTags();
      renderActiveList();
    }

    function onReposition(): void {
      if (!open) return;
      if (locked) {
        // Don't re-anchor when locked, but do keep the panel inside the viewport
        // so a window resize can't strand the unlock button off-screen (#635).
        const pad = 8;
        const rect = panel.getBoundingClientRect();
        const left = Math.max(pad, Math.min(rect.left, window.innerWidth - rect.width - pad));
        const top = Math.max(pad, Math.min(rect.top, window.innerHeight - rect.height - pad));
        if (left !== rect.left || top !== rect.top) {
          panel.style.left = `${Math.round(left)}px`;
          panel.style.top = `${Math.round(top)}px`;
        }
        return;
      }
      const pos = computeAnchoredPosition(trigger, panel);
      panel.style.left = `${pos.left}px`;
      panel.style.top = `${pos.top}px`;
    }

    function beginDrag(ev: PointerEvent): void {
      if (locked) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      try {
        panel.setPointerCapture?.(ev.pointerId);
      } catch {}
    }

    async function endDrag(_ev: PointerEvent): Promise<void> {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      savedPos = { left: rect.left, top: rect.top };
      await writeStorage(STORAGE_KEYS.position, savedPos);
    }

    function onDragMove(ev: PointerEvent): void {
      if (dragging) {
        const x = ev.clientX - dragOffset.x;
        const y = ev.clientY - dragOffset.y;
        panel.style.left = `${Math.round(x)}px`;
        panel.style.top = `${Math.round(y)}px`;
      } else if (draggingTrigger) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = trigger.getBoundingClientRect();
        const w = rect.width || 36;
        const h = rect.height || 36;
        const right = Math.max(6, Math.min(vw - 6 - w, vw - ev.clientX - w / 2));
        const bottom = Math.max(6, Math.min(vh - 6 - h, vh - ev.clientY - h / 2));
        trigger.style.right = `${Math.round(right)}px`;
        trigger.style.bottom = `${Math.round(bottom)}px`;
      }
    }

    // Events
    trigger.addEventListener('click', async () => {
      // Suppress click after a drag gesture
      if (triggerWasDragged) {
        triggerWasDragged = false;
        return;
      }

      // When changelog badge is active, open changelog modal instead of prompt manager
      if (changelogBadgeActive) {
        changelogBadgeActive = false;
        trigger.classList.remove('gv-pm-trigger-new');
        versionBadge.classList.remove('gv-pm-version-outdated');
        try {
          await showChangelogModalDirect();
        } catch {
          // Ignore errors
        }
        // If PM was hidden by user, hide trigger again after changelog closes
        if (pmHiddenByUser) {
          trigger.style.display = 'none';
        }
        return;
      }

      if (open) closePanel();
      else {
        openPanel();
        if (panelView === 'starred') void loadStarredMessages();
        else {
          renderTags();
          renderList();
        }
      }
    });

    // Handle window resize - constrain trigger and reposition panel
    // Handle window resize - constrain trigger and reposition panel
    const onWindowResize = () => {
      constrainTriggerPosition();
      onReposition();
      syncTagScrollHint();
    };
    window.addEventListener('resize', onWindowResize, { passive: true });

    window.addEventListener('scroll', onReposition, { passive: true });
    tagsWrap.addEventListener('scroll', syncTagScrollHint, { passive: true });

    // Close when clicking outside of the manager (panel/trigger/confirm are exceptions)
    const onWindowPointerDown = (ev: PointerEvent) => {
      if (!open) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (savedExportMenuOpen && !target.closest('.gv-pm-saved-export-wrap')) {
        setSavedExportMenuOpen(false);
      }
      if (target.closest(`#${ID.panel}`)) return;
      if (target.closest(`#${ID.trigger}`)) return;
      if (target.closest('.gv-pm-confirm')) return;
      // The hover-preview tooltip lives on document.body so users can
      // interact with it (scroll long prompts, select text). Without this
      // exclusion, clicking its scrollbar would be treated as an outside
      // click and close the whole panel.
      if (target.closest('.gv-pm-tooltip')) return;
      closePanel();
    };
    window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });

    // Close on Escape
    const onWindowKeyDown = (ev: KeyboardEvent) => {
      if (!open) return;
      if (ev.key !== 'Escape') return;
      if (savedExportMenuOpen) {
        setSavedExportMenuOpen(false);
        savedExportTrigger.focus();
        return;
      }
      closePanel();
    };
    window.addEventListener('keydown', onWindowKeyDown, { passive: true });

    lockBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      locked = !locked;
      await writeStorage(STORAGE_KEYS.locked, locked);
      applyLockUI();
      try {
        (ev.currentTarget as HTMLButtonElement)?.blur?.();
      } catch {}
      if (locked) {
        const rect = panel.getBoundingClientRect();
        savedPos = { left: rect.left, top: rect.top };
        await writeStorage(STORAGE_KEYS.position, savedPos);
      } else {
        onReposition();
      }
    });
    panel.addEventListener('pointerdown', (ev: PointerEvent) => {
      const target = ev.target as HTMLElement;
      if (target.closest('.gv-pm-drag')) beginDrag(ev);
    });
    window.addEventListener('pointermove', onDragMove, { passive: true });
    window.addEventListener('pointerup', endDrag, { passive: true });

    // Trigger drag (always draggable)
    let triggerDragStartPos: { x: number; y: number } | null = null;
    let triggerWasDragged = false;
    trigger.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (typeof ev.button === 'number' && ev.button !== 0) return;
      draggingTrigger = true;
      triggerWasDragged = false;
      triggerDragStartPos = { x: ev.clientX, y: ev.clientY };
      try {
        trigger.setPointerCapture?.(ev.pointerId);
      } catch {}
    });

    const onTriggerDragEnd = async (ev: PointerEvent) => {
      if (draggingTrigger) {
        draggingTrigger = false;
        // Only save if the trigger actually moved (threshold: 5px)
        if (triggerDragStartPos) {
          const dx = Math.abs(ev.clientX - triggerDragStartPos.x);
          const dy = Math.abs(ev.clientY - triggerDragStartPos.y);
          if (dx > 5 || dy > 5) {
            triggerWasDragged = true;
            const r = parseFloat((trigger.style.right || '').replace('px', '')) || 18;
            const b = parseFloat((trigger.style.bottom || '').replace('px', '')) || 18;
            await writeStorage(STORAGE_KEYS.triggerPos, { right: r, bottom: b });
          }
        }
        triggerDragStartPos = null;
      }
    };
    window.addEventListener('pointerup', onTriggerDragEnd, { passive: true });

    langSel.addEventListener('change', async () => {
      const next = langSel.value;
      if (!isAppLanguage(next)) return;
      await i18n.set(next);
      refreshUITexts();
    });

    // Listen to external language changes (popup/options)
    // Note: The centralized i18n system already handles storage changes,
    // we just need to update the UI when language changes
    const storageChangeHandler = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      // Handle language changes from sync storage
      const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
      if (area === 'sync' && typeof nextRaw === 'string') {
        try {
          langSel.value = normalizeLanguage(nextRaw);
        } catch {}
        refreshUITexts();
      }
      // Handle hide prompt manager setting changes
      if (area === 'sync' && changes?.gvHidePromptManager) {
        const shouldHide = changes.gvHidePromptManager.newValue === true;
        pmHiddenByUser = shouldHide;
        pmLogger.info('Hide prompt manager setting changed', { shouldHide });
        if (shouldHide && !changelogBadgeActive) {
          // Hide trigger and panel
          trigger.style.display = 'none';
          panel.classList.add('gv-hidden');
          open = false;
        } else {
          // Show trigger
          trigger.style.display = '';
        }
      }
      if (area === 'sync' && changes[StorageKeys.PROMPT_INSERT_ON_CLICK]) {
        promptInsertOnClick = changes[StorageKeys.PROMPT_INSERT_ON_CLICK].newValue === true;
      }
      if ((area === 'sync' || area === 'local') && changes[StorageKeys.PROMPT_VIEW_MODE]) {
        const nextMode = changes[StorageKeys.PROMPT_VIEW_MODE].newValue;
        if ((nextMode === 'compact' || nextMode === 'comfortable') && nextMode !== viewMode) {
          viewMode = nextMode;
          applyViewModeUI();
          renderActiveList();
        }
      }
      if ((area === 'sync' || area === 'local') && changes[StorageKeys.PROMPT_PANEL_VIEW]) {
        const nextView = changes[StorageKeys.PROMPT_PANEL_VIEW].newValue;
        if (isPMPanelView(nextView) && nextView !== panelView) {
          if (panelView === 'starred') starredSearchValue = searchInput.value || '';
          else promptSearchValue = searchInput.value || '';
          panelView = nextView;
          searchInput.value = panelView === 'starred' ? starredSearchValue : promptSearchValue;
          applyPanelViewUI();
          if (panelView === 'starred' && open) void loadStarredMessages();
          else renderActiveList();
        }
      }
      // Handle changelog notify mode changes (dynamic badge update)
      if (
        area === 'local' &&
        (changes[StorageKeys.CHANGELOG_NOTIFY_MODE] ||
          changes[StorageKeys.CHANGELOG_DISMISSED_VERSION])
      ) {
        void (async () => {
          try {
            const [modeRes, unread] = await Promise.all([
              browser.storage.local.get(StorageKeys.CHANGELOG_NOTIFY_MODE),
              hasUnreadChangelog(),
            ]);
            const mode = modeRes?.[StorageKeys.CHANGELOG_NOTIFY_MODE];
            const shouldBadge = mode === 'badge' && unread;

            if (shouldBadge && !changelogBadgeActive) {
              changelogBadgeActive = true;
              trigger.classList.add('gv-pm-trigger-new');
              trigger.style.display = '';
              versionBadge.classList.toggle('gv-pm-version-outdated', changelogBadgeActive);
            } else if (!shouldBadge && changelogBadgeActive) {
              changelogBadgeActive = false;
              trigger.classList.remove('gv-pm-trigger-new');
              versionBadge.classList.toggle('gv-pm-version-outdated', changelogBadgeActive);
              if (pmHiddenByUser) {
                trigger.style.display = 'none';
              }
            }
          } catch {
            // Ignore errors
          }
        })();
      }
      // Handle prompt data changes from cloud sync (local storage)
      if (area === 'local' && changes?.gvPromptItems) {
        pmLogger.info('Prompt data changed in chrome.storage.local, reloading...');
        const newItems = changes.gvPromptItems.newValue;
        if (Array.isArray(newItems)) {
          items = newItems;
          renderTags();
          renderActiveList();
          setNotice(i18n.t('syncSuccess') || 'Synced', 'ok');
        }
      }
      if (
        area === 'local' &&
        (changes[StorageKeys.TIMELINE_STARRED_MESSAGES] ||
          Object.keys(changes).some((key) => key.startsWith('gvAnnotation:'))) &&
        panelView === 'starred'
      ) {
        void loadStarredMessages();
      }
    };

    try {
      browser.storage.onChanged.addListener(storageChangeHandler);
    } catch {}

    addBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      editingId = null;
      // Reset every field before opening so state from a cancelled edit cannot
      // leak into a new prompt.
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = '';
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = '';
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = '';
      setInlineHint('');
      addForm.classList.remove('gv-hidden');
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement)?.focus();
    });

    settingsBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        // Check if extension context is still valid
        if (!browser.runtime?.id) {
          // Extension context invalidated, show fallback message
          setNotice(
            i18n.t('pm_settings_fallback') || '请点击浏览器工具栏中的扩展图标打开设置',
            'err',
          );
          return;
        }

        // Send message to background to open popup
        const response = (await browser.runtime.sendMessage({ type: 'gv.openPopup' })) as {
          ok?: boolean;
        };
        if (!response?.ok) {
          // If programmatic opening failed, show a helpful message
          setNotice(
            i18n.t('pm_settings_fallback') || '请点击浏览器工具栏中的扩展图标打开设置',
            'err',
          );
        }
      } catch (err) {
        // Silently handle extension context errors
        if (isExtensionContextInvalidatedError(err)) {
          setNotice(
            i18n.t('pm_settings_fallback') || '请点击浏览器工具栏中的扩展图标打开设置',
            'err',
          );
          return;
        }
        console.warn('[PromptManager] Failed to open settings:', err);
        setNotice(
          i18n.t('pm_settings_fallback') || '请点击浏览器工具栏中的扩展图标打开设置',
          'err',
        );
      }
    });

    (addForm.querySelector('.gv-pm-cancel') as HTMLButtonElement).addEventListener(
      'click',
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        editingId = null;
        addForm.classList.add('gv-hidden');
      },
    );
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = addForm.querySelector('.gv-pm-input-name') as HTMLInputElement;
      const name = normalizePromptName(nameInput.value);
      const text = (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value;
      const tagsRaw = (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value;
      const tags = dedupeTags((tagsRaw || '').split(',').map((s) => s.trim()));
      if (!name) {
        setInlineHint(i18n.t('pm_name_required') || 'Prompt name is required', 'err');
        nameInput.focus();
        return;
      }
      if (isPromptNameTaken(items, name, editingId)) {
        setInlineHint(i18n.t('pm_name_duplicate') || 'Prompt name already exists', 'err');
        nameInput.focus();
        return;
      }
      if (!text.trim()) return;
      if (editingId) {
        const dup = items.some(
          (x) => x.id !== editingId && x.text.trim().toLowerCase() === text.trim().toLowerCase(),
        );
        if (dup) {
          setInlineHint(i18n.t('pm_duplicate') || 'Duplicate prompt', 'err');
          return;
        }
        const target = items.find((x) => x.id === editingId);
        if (target) {
          target.text = text;
          target.tags = tags;
          target.name = name;
          target.updatedAt = Date.now();
          await writeStorage(STORAGE_KEYS.items, items);
          setNotice(i18n.t('pm_saved') || 'Saved', 'ok');
        }
        editingId = null;
      } else {
        // prevent duplicates (case-insensitive, same text)
        const exists = items.some((x) => x.text.trim().toLowerCase() === text.trim().toLowerCase());
        if (exists) {
          setInlineHint(i18n.t('pm_duplicate') || 'Duplicate prompt', 'err');
          return;
        }
        const it: PromptItem = { id: uid(), name, text, tags, createdAt: Date.now() };
        items = [it, ...items];
        await writeStorage(STORAGE_KEYS.items, items);
      }
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = '';
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = '';
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = '';
      setInlineHint('');
      addForm.classList.add('gv-hidden');
      renderTags();
      renderList();
    });

    searchInput.addEventListener('input', () => {
      if (panelView === 'starred') starredSearchValue = searchInput.value || '';
      else promptSearchValue = searchInput.value || '';
      renderActiveList();
    });

    backupBtn.addEventListener('click', () => {
      switchPanelView('starred');
    });
    promptManagerBtn.addEventListener('click', () => switchPanelView('prompts'));
    savedExportTrigger.addEventListener('click', (event) => {
      const nextOpen = !savedExportMenuOpen;
      setSavedExportMenuOpen(nextOpen, nextOpen && event.detail === 0);
    });
    savedExportMenu.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const options = [exportJsonBtn, exportMarkdownBtn];
      const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      options[(currentIndex + direction + options.length) % options.length].focus();
    });
    exportJsonBtn.addEventListener('click', () => {
      setSavedExportMenuOpen(false);
      void exportHighlights('json');
    });
    exportMarkdownBtn.addEventListener('click', () => {
      setSavedExportMenuOpen(false);
      void exportHighlights('markdown');
    });

    // Initialize
    refreshUITexts();

    // Return destroy function
    return {
      destroy: () => {
        try {
          window.removeEventListener('resize', onWindowResize);
          window.removeEventListener('scroll', onReposition);
          window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });
          window.removeEventListener('keydown', onWindowKeyDown);
          window.removeEventListener('pointermove', onDragMove);
          window.removeEventListener('pointerup', endDrag);
          window.removeEventListener('pointerup', onTriggerDragEnd);
          tagsWrap.removeEventListener('scroll', syncTagScrollHint);

          chrome.storage?.onChanged?.removeListener(storageChangeHandler);

          // Tear down the fast-tooltip singleton: cancel pending timer, remove
          // the DOM element, and detach the capture-phase scroll listeners
          // attached to `list` and `window`. Without this, every re-init (SPA
          // nav / extension reload) would leak an orphan tooltip + listener.
          hideTooltip();
          if (tooltipEl) {
            try {
              tooltipEl.remove();
            } catch {}
            tooltipEl = null;
          }
          for (const target of tooltipScrollTargets) {
            try {
              target.removeEventListener('scroll', onTooltipDismiss, { capture: true });
            } catch {}
          }

          trigger.remove();
          panel.remove();
          document.querySelectorAll('.gv-pm-confirm').forEach((el) => el.remove());
        } catch (e) {
          console.error('[PromptManager] Destroy error:', e);
        }
      },
    };
  } catch (err) {
    try {
      if (isExtensionContextInvalidatedError(err)) {
        return { destroy: () => {} };
      }
      console.error('Prompt Manager init failed', err);
    } catch {}
    return { destroy: () => {} };
  }
}

export default { startPromptManager };
