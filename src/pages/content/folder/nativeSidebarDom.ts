import { GEM_CONFIG } from './gemConfig';

/** Current native sidebar state, read again after asynchronous collection waits. */
export interface NativeSidebarReadContext {
  sidebar: HTMLElement | null;
  accountIsolationEnabled: boolean;
  isDestroyed: boolean;
}

export interface NativeConversationInfo {
  id: string;
  title: string;
  url: string;
}

// The lr26 sidebar fills conversation rows lazily (see #725).
const AI_ORG_COLLECT_TIMEOUT_MS = 3000;
const AI_ORG_COLLECT_POLL_MS = 150;

function debug(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') {
      console[level]('[FolderManager]', ...args);
    }
  } catch {
    // localStorage may be unavailable in private browsing.
  }
}

export function getNativeConversationRoot(sidebar: HTMLElement | null): ParentNode {
  return sidebar?.isConnected ? sidebar : document;
}

export function getNativeConversationElements(sidebar: HTMLElement | null): NodeListOf<Element> {
  return getNativeConversationRoot(sidebar).querySelectorAll('[data-test-id="conversation"]');
}

export function extractNativeDragTitle(element: HTMLElement, conversationId?: string): string {
  const title =
    extractNativeConversationTitle(element) ||
    (conversationId ? syncConversationTitleFromNative(conversationId) : null);

  return title || 'Untitled';
}

export function extractConversationId(element: HTMLElement): string {
  // Strategy 1: Extract from jslog attribute
  // This is the preferred method as it follows the internal ID format
  const jslog = element.getAttribute('jslog');
  if (jslog) {
    // Match conversation ID - it appears in quotes like ["c_3456c77162722c1a",...]
    const match = jslog.match(/[",[]c_([a-f0-9]+)[",\]]/);
    if (match) {
      const conversationId = `c_${match[1]}`;
      debug('log', 'Extracted conversation ID:', conversationId, 'from jslog:', jslog);
      return conversationId;
    }
    // Fallback: match without surrounding characters
    const simpleMatch = jslog.match(/c_[a-f0-9]+/);
    if (simpleMatch) {
      debug('log', 'Extracted conversation ID (simple):', simpleMatch[0]);
      return simpleMatch[0];
    }
  }

  // Strategy 2: Extract from href (fallback when jslog is missing/broken)
  // This ensures we can still identify conversations even if Gemini UI changes traits
  const link = element.querySelector(
    'a[href*="/app/"], a[href*="/gem/"]',
  ) as HTMLAnchorElement | null;
  if (link) {
    const href = link.href;
    // Try /app/<hexId>
    let match = href.match(/\/app\/([^/?#]+)/);
    if (match && match[1]) {
      // Enforce c_ prefix to match jslog format standard
      return `c_${match[1]}`;
    }
    // Try /gem/<gemId>/<hexId>
    match = href.match(/\/gem\/[^/]+\/([^/?#]+)/);
    if (match && match[1]) {
      return `c_${match[1]}`;
    }
  }

  // Fallback: generate unique ID from element attributes
  // Use multiple attributes to ensure uniqueness
  const title = extractNativeConversationTitle(element) || '';
  const index = Array.from(element.parentElement?.children || []).indexOf(element);

  // Generate unique ID combining title, index, random, and timestamp
  const uniqueString = `${title}_${index}_${Math.random()}_${Date.now()}`;
  const fallbackId = `conv_${hashString(uniqueString)}`;
  debug('warn', 'Could not extract ID from jslog or href, using fallback:', fallbackId);
  return fallbackId;
}

export function extractConversationData(
  element: HTMLElement,
  accountIsolationEnabled: boolean,
): {
  url: string;
  isGem: boolean;
  gemId?: string;
} {
  // Try to extract from jslog first
  const jslog = element.getAttribute('jslog');
  let hexId: string | null = null;

  if (jslog) {
    const match = jslog.match(/[",[]c_([a-f0-9]+)[",\]]/);
    if (match) {
      hexId = match[1];
      debug('log', 'Extracted hex ID from jslog:', hexId);
    }
  }

  // Try to extract from href if jslog failed
  if (!hexId) {
    const link = element.querySelector(
      'a[href*="/app/"], a[href*="/gem/"]',
    ) as HTMLAnchorElement | null;
    if (link) {
      const href = link.href;
      // Try /app/<hexId>
      let match = href.match(/\/app\/([^/?#]+)/);
      if (match && match[1]) {
        hexId = match[1];
      } else {
        // Try /gem/<gemId>/<hexId>
        match = href.match(/\/gem\/[^/]+\/([^/?#]+)/);
        if (match && match[1]) {
          hexId = match[1];
        }
      }
    }
  }

  if (!hexId) {
    return { url: window.location.href, isGem: false };
  }

  const origin = window.location.origin;
  const currentUrl = new URL(window.location.href);
  const searchParams = currentUrl.searchParams.toString();

  let url: string;

  if (accountIsolationEnabled) {
    // In hard isolation mode, intentionally do not persist the /u/{num} account index;
    // only store the path that is intrinsic to the conversation itself.
    // At navigation time we rebuild the correct /u/{num} segment based on the
    // current window/account context, so that URLs stay valid even if the
    // account index changes (e.g. saved with /u/1, later browsing under /u/2).
    url = `${origin}/app/${hexId}`;
  } else {
    // Backward-compatible behavior: preserve the current /u/{num} segment
    // when hard isolation is disabled, matching legacy URL structure.
    const currentPath = window.location.pathname;
    const userMatch = currentPath.match(/\/u\/(\d+)\//);

    if (userMatch) {
      url = `${origin}/u/${userMatch[1]}/app/${hexId}`;
    } else {
      url = `${origin}/app/${hexId}`;
    }
  }

  if (searchParams) {
    url += `?${searchParams}`;
  }

  debug('log', 'Built conversation URL:', url);
  return { url, isGem: false, gemId: undefined };
}

/**
 * Extract conversation ID from a DOM element
 * Used for handling removed/added conversations in MutationObserver
 *
 * @param element - The conversation element to extract ID from
 * @returns The conversation ID (hex only, without 'c_' prefix) or undefined if not found
 *
 * @remarks
 * This method attempts two extraction strategies:
 * 1. From jslog attribute (e.g., jslog="c_abc123def456")
 * 2. From href in anchor tags (e.g., /app/abc123def456 or /gem/xxx/abc123def456)
 */
export function extractConversationIdFromElement(element: Element): string | undefined {
  // Strategy 1: Extract from jslog attribute
  const jslog = element.getAttribute('jslog');
  if (jslog) {
    const match = jslog.match(/c_([a-f0-9]{8,})/i);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Strategy 2: Extract from href
  const link = element.querySelector(
    'a[href*="/app/"], a[href*="/gem/"]',
  ) as HTMLAnchorElement | null;
  if (link) {
    const href = link.href;
    const appMatch = href.match(/\/app\/([^/?#]+)/);
    const gemMatch = href.match(/\/gem\/[^/]+\/([^/?#]+)/);
    return appMatch?.[1] || gemMatch?.[1];
  }

  return undefined;
}

/**
 * Find native conversation element by conversation ID
 */
export function findNativeConversationElement(
  sidebar: HTMLElement | null,
  conversationId: string,
): HTMLElement | null {
  const targetId = normalizeConversationId(conversationId);
  if (!targetId) return null;

  // Try multiple strategies to find the conversation
  const allConversations = getNativeConversationElements(sidebar);

  for (const conv of allConversations) {
    const id = extractConversationIdFromElement(conv) || extractConversationId(conv as HTMLElement);
    if (normalizeConversationId(id) === targetId) {
      return conv as HTMLElement;
    }
  }

  return null;
}

// Map a ⋮ trigger button to its conversation list item. Handles the current
// UI (trigger nested inside `[data-test-id="conversation"]`) and the older
// sibling layout (`.conversation-actions-container` next to the item).
export function findConversationElementForTrigger(trigger: HTMLElement): HTMLElement | null {
  const direct = trigger.closest('[data-test-id="conversation"]') as HTMLElement | null;
  if (direct) return direct;

  const actionsContainer = trigger.closest('.conversation-actions-container');
  if (actionsContainer) {
    let sibling = actionsContainer.previousElementSibling;
    while (sibling) {
      if (sibling.getAttribute('data-test-id') === 'conversation') {
        return sibling as HTMLElement;
      }
      sibling = sibling.previousElementSibling;
    }
  }

  const historyItem = trigger.closest('[data-test-id^="history-item"]') as HTMLElement | null;
  if (historyItem) return historyItem;

  return null;
}

export function extractNativeConversationId(conversationEl: HTMLElement): string | null {
  // Support both /app/<hexId> and /gem/<gemId>/<hexId>
  const scope =
    (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;

  // Get all conversation links
  const links = scope.querySelectorAll('a[href*="/app/"], a[href*="/gem/"]');

  if (links.length === 0) {
    debug('warn', 'extractId: no conversation link found under scope');
    // Fallback to jslog parsing on the conversation element tree
    const hex = extractHexIdFromJslog(scope);
    if (hex) return hex;
    return null;
  }

  // If there are multiple links, try to find the most specific one
  let link: Element;
  if (links.length > 1) {
    debug(
      'warn',
      `extractId: found ${links.length} links, attempting to select the most appropriate one`,
    );

    // Strategy 1: Find the link with the smallest bounding box (most likely the actual conversation item)
    let minArea = Infinity;
    let bestLink = links[0];

    for (const l of Array.from(links)) {
      const rect = l.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > 0 && area < minArea) {
        minArea = area;
        bestLink = l;
      }
    }

    // If all links have the same size, fall back to the first one
    link = minArea < Infinity ? bestLink : links[0];
    debug('log', 'extractId: selected link with area', minArea);
  } else {
    link = links[0];
  }

  const href = link.getAttribute('href') || '';
  debug('log', 'extractId: found link href', href);

  // Try /app/<hexId>
  let match = href.match(/\/app\/([^/?#]+)/);
  if (match && match[1]) {
    debug('log', 'extractId: extracted from /app/', match[1]);
    return match[1];
  }
  // Try /gem/<gemId>/<hexId>
  match = href.match(/\/gem\/[^/]+\/([^/?#]+)/);
  if (match && match[1]) {
    debug('log', 'extractId: extracted from /gem/', match[1]);
    return match[1];
  }
  debug('warn', 'extractId: failed to extract id from href');
  return null;
}

export function extractNativeConversationTitle(conversationEl: HTMLElement): string | null {
  const scope =
    (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
  // 1) Known title selectors
  const titleEl = scope.querySelector(
    '.title-text, .gds-label-l, .conversation-title-text, [data-test-id="conversation-title"], h3',
  );
  let title = titleEl?.textContent?.trim() || null;
  if (title && !isGemLabel(title)) {
    debug('log', 'extractTitle(selectors):', title);
    return title;
  }

  // 2) Link attributes
  const link = scope.querySelector(
    'a[href*="/app/"], a[href*="/gem/"]',
  ) as HTMLAnchorElement | null;
  const aria = link?.getAttribute('aria-label')?.trim();
  if (aria && !isGemLabel(aria)) {
    debug('log', 'extractTitle(link aria-label):', aria);
    return aria;
  }
  const linkTitle = link?.getAttribute('title')?.trim();
  if (linkTitle && !isGemLabel(linkTitle)) {
    debug('log', 'extractTitle(link title attr):', linkTitle);
    return linkTitle;
  }

  // 3) Parse visible text from link (ignore icons and gem labels)
  const fromLinkText = extractTitleFromLinkText(link || undefined);
  if (fromLinkText) {
    debug('log', 'extractTitle(link text):', fromLinkText);
    return fromLinkText;
  }

  // 4) Fallbacks on common labels
  title = extractFallbackTitle(scope);
  if (title && !isGemLabel(title)) {
    debug('log', 'extractTitle(fallback):', title);
    return title;
  }

  debug('log', 'extractTitle: null');
  return null;
}

/**
 * Build a conversationId → native title lookup table with ONE sidebar scan.
 *
 * Mirrors the per-row matching semantics of `syncConversationTitleFromNative`
 * (`jslog.includes(id)` and `link.href.includes(id)`): every `c_<hex>` id a
 * row's jslog mentions and the id extracted from the row's link href are all
 * registered, in both prefixed (`c_<hex>`) and bare (`<hex>`) forms, so
 * callers can look up either id shape. First title-bearing row wins — same
 * as the old first-match-in-DOM-order behavior.
 */
export function buildNativeConversationTitleMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const conversations = document.querySelectorAll('[data-test-id="conversation"]');
    for (const convEl of Array.from(conversations)) {
      const element = convEl as HTMLElement;
      const title = extractNativeConversationTitle(element);
      if (!title) continue;

      const register = (rawId: string | null | undefined): void => {
        const hex = normalizeConversationId(rawId);
        if (!hex) return;
        if (!map.has(hex)) map.set(hex, title);
        const prefixed = `c_${hex}`;
        if (!map.has(prefixed)) map.set(prefixed, title);
      };

      const jslog = element.getAttribute('jslog');
      if (jslog) {
        for (const match of jslog.matchAll(/c_([a-f0-9]{8,})/gi)) {
          register(match[1]);
        }
      }

      const link = element.querySelector(
        'a[href*="/app/"], a[href*="/gem/"]',
      ) as HTMLAnchorElement | null;
      if (link) {
        register(extractConversationIdFromHref(link.href));
      }
    }
  } catch (e) {
    debug('log', 'Error building native title map:', e);
  }
  return map;
}

export function lookupNativeConversationTitle(
  map: Map<string, string> | null,
  conversationId: string,
): string | null {
  if (!map) return null;

  const direct = map.get(conversationId);
  if (direct) return direct;

  const normalized = normalizeConversationId(conversationId);
  if (normalized) {
    const byHex = map.get(normalized);
    if (byHex) return byHex;
  }
  return null;
}

export function syncConversationTitleFromNative(conversationId: string): string | null {
  try {
    // Try to find the conversation in the native sidebar by its ID
    const conversations = document.querySelectorAll('[data-test-id="conversation"]');
    for (const convEl of Array.from(conversations)) {
      // Check if this conversation matches the ID
      const jslog = convEl.getAttribute('jslog');
      if (jslog && jslog.includes(conversationId)) {
        // Found the matching conversation, extract its current title
        const currentTitle = extractNativeConversationTitle(convEl as HTMLElement);
        if (currentTitle) {
          debug('log', 'Synced title from native:', currentTitle);
          return currentTitle;
        }
      }

      // Also check by href
      const link = convEl.querySelector(
        'a[href*="/app/"], a[href*="/gem/"]',
      ) as HTMLAnchorElement | null;
      if (link && link.href.includes(conversationId)) {
        const currentTitle = extractNativeConversationTitle(convEl as HTMLElement);
        if (currentTitle) {
          debug('log', 'Synced title from native (by href):', currentTitle);
          return currentTitle;
        }
      }
    }
  } catch (e) {
    debug('log', 'Error syncing title from native:', e);
  }
  return null;
}

function extractHexIdFromJslog(scope: HTMLElement): string | null {
  try {
    const tryParse = (val: string | null | undefined): string | null => {
      if (!val) return null;
      // Typical pattern inside jslog: c_<hex>
      const m = val.match(/c_([a-f0-9]{8,})/i);
      return m?.[1] || null;
    };

    // Check on scope itself
    const fromSelf = tryParse(scope.getAttribute('jslog'));
    if (fromSelf) {
      debug('log', 'extractId(jslog self):', fromSelf);
      return fromSelf;
    }

    // Search descendants with jslog
    const nodes = scope.querySelectorAll('[jslog]');
    for (const n of Array.from(nodes)) {
      const found = tryParse(n.getAttribute('jslog'));
      if (found) {
        debug('log', 'extractId(jslog descendant):', found);
        return found;
      }
    }
  } catch (e) {
    debug('warn', 'extractHexIdFromJslog error:', e);
  }
  debug('warn', 'extractId(jslog): not found');
  return null;
}

export function buildConversationUrlFromId(
  hexId: string,
  accountIsolationEnabled: boolean,
): string {
  // Mirror extractConversationData's account-scope semantics: preserve the
  // current /u/<index>/ segment for multi-account users so jslog-fallback
  // URLs don't open in the wrong account. Under hard account isolation the
  // /u/<index> segment is intentionally NOT persisted (navigation rebuilds
  // it from the live page context).
  let accountPrefix = '';
  try {
    if (!accountIsolationEnabled) {
      const userMatch = window.location.pathname.match(/\/u\/(\d+)\//);
      if (userMatch) {
        accountPrefix = `/u/${userMatch[1]}`;
      }
    }
  } catch (e) {
    debug('log', 'Failed to extract account prefix:', e);
  }

  try {
    const path = window.location.pathname;
    const gemMatch = path.match(/\/gem\/([^/]+)/);
    if (gemMatch && gemMatch[1]) {
      const gemId = gemMatch[1];
      return `https://gemini.google.com${accountPrefix}/gem/${gemId}/${hexId}`;
    }
  } catch (e) {
    debug('log', 'Failed to extract gem URL:', e);
  }
  return `https://gemini.google.com${accountPrefix}/app/${hexId}`;
}

export function extractFallbackTitle(conversationEl: HTMLElement): string | null {
  try {
    const scope =
      (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
    // Prefer explicit attributes if present
    const aria = scope.getAttribute('aria-label');
    if (aria && aria.trim()) {
      debug('log', 'fallbackTitle(aria-label):', aria.trim());
      return aria.trim();
    }
    const titleAttr = scope.getAttribute('title');
    if (titleAttr && titleAttr.trim()) {
      debug('log', 'fallbackTitle(title attr):', titleAttr.trim());
      return titleAttr.trim();
    }
    // Try a common inner label
    const label = scope.querySelector('.gds-body-m, .gds-label-m, .subtitle');
    const labelText = label?.textContent?.trim();
    if (labelText && !isGemLabel(labelText)) {
      debug('log', 'fallbackTitle(label-ish):', labelText);
      return labelText;
    }
    // Fall back to trimmed text content (first line, clipped)
    const raw = scope.textContent?.trim() || '';
    if (raw) {
      const firstLine =
        raw
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)[0] || raw;
      const clipped = firstLine.slice(0, 80);
      debug('log', 'fallbackTitle(textContent):', clipped);
      return clipped;
    }
  } catch (e) {
    debug('warn', 'extractFallbackTitle error:', e);
  }
  return null;
}

function isGemLabel(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const simple = t.toLowerCase();
  // Generic labels we want to ignore
  if (simple === 'gem' || simple === 'gems') return true;
  // Known Gem names (English)
  for (const g of GEM_CONFIG) {
    if (simple === g.name.toLowerCase()) return true;
  }
  return false;
}

function extractTitleFromLinkText(link?: HTMLAnchorElement | null): string | null {
  if (!link) return null;
  // Get visible textual lines from the link
  const text = (link.innerText || '').trim();
  if (!text) return null;
  const parts = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !isGemLabel(s))
    .filter((s) => s.length >= 2);
  debug('log', 'extractTitleFromLinkText parts:', parts);
  if (parts.length === 0) return null;
  // Heuristic: pick the longest part
  const best = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]);
  return best || null;
}

export function extractNativeConversationUrl(
  conversationEl: HTMLElement,
  accountIsolationEnabled: boolean,
): string | null {
  const scope =
    (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
  const link = scope.querySelector('a[href*="/app/"], a[href*="/gem/"]');
  if (!link) {
    debug('warn', 'extractUrl: no conversation link found under scope');
    // Fallback: construct from extracted id (via jslog) if possible
    const hex = extractHexIdFromJslog(scope);
    if (hex) {
      const fullFromJslog = buildConversationUrlFromId(hex, accountIsolationEnabled);
      debug('log', 'extractUrl(jslog fallback):', fullFromJslog);
      return fullFromJslog;
    }
    return null;
  }
  const href = link.getAttribute('href');
  if (!href) {
    debug('warn', 'extractUrl: link has no href');
    return null;
  }
  const full = href.startsWith('http') ? href : `https://gemini.google.com${href}`;
  debug('log', 'extractUrl:', full);
  return full;
}

export function getCurrentHexIdFromLocation(): string | null {
  try {
    const path = window.location.pathname || '';
    // Match /app/<hex> or /gem/<gemId>/<hex>
    const m = path.match(/\/(?:app|gem\/[^/]+)\/([a-f0-9]+)/i);
    return m ? m[1] : null;
  } catch (e) {
    debug('log', 'Failed to get current hex ID from location:', e);
    return null;
  }
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function normalizeConversationId(value: string | null | undefined): string | null {
  const normalized = String(value || '')
    .trim()
    .replace(/^c_/i, '');
  return normalized || null;
}

export function resolveConversationRouteId(
  href: string | null | undefined,
  fallbackId: string | null | undefined,
): string | null {
  return extractConversationIdFromHref(href) ?? normalizeConversationId(fallbackId);
}

function extractConversationIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;

  try {
    const parsed = new URL(href, window.location.origin);
    const appMatch = parsed.pathname.match(/\/app\/([^/?#]+)/);
    if (appMatch?.[1]) {
      return normalizeConversationId(appMatch[1]);
    }

    const gemMatch = parsed.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
    if (gemMatch?.[1]) {
      return normalizeConversationId(gemMatch[1]);
    }
  } catch (error) {
    debug('log', 'Failed to extract conversation id from href:', error);
  }

  return null;
}

/**
 * Extract conversation info from the current page URL and top-bar title.
 * Used exclusively for the top-right conversation header menu (not sidebar).
 *
 * Returns null ONLY when the URL does not contain a valid conversation ID,
 * in which case injection is skipped entirely.
 * Title always has a fallback — never returns null for title.
 */
export function extractConversationInfoFromPage(): NativeConversationInfo | null {
  // --- Robust URL parsing ---
  let path: string;
  try {
    path = window.location.pathname;
  } catch {
    debug('warn', 'extractConversationInfoFromPage: failed to read location.pathname');
    return null;
  }

  // Support multi-user prefix /u/<n>/, /app/<hexId>, and /gem/<gemId>/<hexId>
  const hexMatch = path.match(/\/(?:app|gem\/[^/?#]+)\/([a-f0-9]{8,})/i);
  if (!hexMatch?.[1]) {
    debug('log', 'extractConversationInfoFromPage: no valid conversation ID in URL');
    return null;
  }
  const id = hexMatch[1];
  const url = window.location.href;

  // --- Defensive title extraction ---
  // Gemini generates titles asynchronously; the DOM element may not be ready yet.
  // Try multiple selectors, then fallback to document.title, then to a default string.
  const titleSelectors = [
    '.conversation-title-container [data-test-id="conversation-title"]',
    'top-bar-actions [data-test-id="conversation-title"]',
    '.top-bar-actions [data-test-id="conversation-title"]',
    '.conversation-title-container .conversation-title.gds-title-m',
    'top-bar-actions .conversation-title.gds-title-m',
  ];

  // Placeholder strings Gemini shows before the chat is auto-titled.
  // Must cover every locale Gemini supports — the DOM text is localized
  // even though the brand name "Gemini" is not.
  const DISALLOWED_TITLES = new Set([
    '',
    'Gemini',
    'Google Gemini',
    'New chat', // en
    '新对话', // zh-CN
    '新對話', // zh-TW
    '新しいチャット', // ja
    '새 채팅', // ko
    'Nuevo chat', // es
    'Nouveau chat', // fr
    'Novo chat', // pt
    'Новый чат', // ru
    'محادثة جديدة', // ar
  ]);

  let title: string | null = null;
  for (const sel of titleSelectors) {
    try {
      const el = document.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && !DISALLOWED_TITLES.has(text)) {
        title = text;
        break;
      }
    } catch {
      // Continue to next selector
    }
  }

  // Fallback 1: document.title (Gemini sets "Title - Gemini" format)
  if (!title) {
    try {
      const docTitle = document.title?.trim();
      if (docTitle) {
        const cleaned = docTitle.replace(/\s*[-–—]\s*Gemini\s*$/i, '').trim();
        if (cleaned && !DISALLOWED_TITLES.has(cleaned)) {
          title = cleaned;
        }
      }
    } catch {
      // Continue to default
    }
  }

  // Fallback 2: safe default — never return empty/null title
  if (!title) {
    title = 'Untitled';
  }

  debug('log', 'extractConversationInfoFromPage:', { id, title, url });
  return { id, title, url };
}

export function findNativeConversationLinkById(conversationId: string): HTMLAnchorElement | null {
  const normalizedId = normalizeConversationId(conversationId);
  if (!normalizedId) return null;

  const byJslog = document.querySelector(
    `[data-test-id="conversation"][jslog*="c_${normalizedId}"] a[href]`,
  ) as HTMLAnchorElement | null;
  if (byJslog && extractConversationIdFromHref(byJslog.href) === normalizedId) {
    return byJslog;
  }

  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      '[data-test-id="conversation"] a[href], a[data-test-id="conversation"][href]',
    ),
  );

  for (const link of links) {
    if (extractConversationIdFromHref(link.href) === normalizedId) {
      return link;
    }
  }

  return null;
}

export function triggerNativeConversationClick(target: HTMLElement): void {
  const options = { bubbles: true, cancelable: true };
  target.dispatchEvent(new MouseEvent('pointerdown', options));
  target.dispatchEvent(new MouseEvent('mousedown', options));
  target.dispatchEvent(new MouseEvent('mouseup', options));
  target.dispatchEvent(new MouseEvent('click', options));
}

/**
 * Get the conversation ID from current URL
 */
export function getCurrentConversationId(): string | null {
  const url = window.location.href;
  const appMatch = url.match(/\/app\/([^/?#]+)/);
  const gemMatch = url.match(/\/gem\/[^/]+\/([^/?#]+)/);
  return appMatch?.[1] || gemMatch?.[1] || null;
}

/**
 * Check if conversation still exists in DOM
 * Returns true if conversation found, false if definitely deleted
 * In case of errors, conservatively returns true to avoid false deletions
 */
export function isConversationInDOM(
  sidebar: HTMLElement | null,
  conversationId: string,
  ignoreHiddenRows = false,
): boolean {
  if (!sidebar) {
    debug('warn', 'Sidebar container not available for DOM check');
    return true; // Conservative: assume conversation exists if we can't check
  }

  try {
    const matchingRows = new Set<HTMLElement>();
    sidebar
      .querySelectorAll<HTMLElement>(`[data-test-id="conversation"][jslog*="c_${conversationId}"]`)
      .forEach((row) => matchingRows.add(row));
    sidebar
      .querySelectorAll<HTMLAnchorElement>(
        `[data-test-id="conversation"] a[href*="${conversationId}"]`,
      )
      .forEach((link) => {
        const row = link.closest('[data-test-id="conversation"]');
        if (row instanceof HTMLElement) matchingRows.add(row);
      });

    const existingRow = Array.from(matchingRows).find(
      (row) => !ignoreHiddenRows || isRenderedNativeConversationRow(row),
    );
    if (existingRow) {
      debug('log', `Found conversation ${conversationId} in DOM`);
      return true;
    }

    if (matchingRows.size > 0) {
      debug('log', `Ignored hidden stale native row for conversation ${conversationId}`);
    }

    // Not found in DOM
    debug('log', `Conversation ${conversationId} not found in DOM`);
    return false;
  } catch (error) {
    debug('warn', `DOM check failed for ${conversationId}:`, error);
    // Conservative approach: if we can't check, assume it still exists
    // This prevents accidental deletion during DOM reconstruction
    return true;
  }
}

function isRenderedNativeConversationRow(row: HTMLElement): boolean {
  // A collapsed/temporarily hidden sidebar is not evidence that Gemini
  // removed the conversation. Only the row's own state can identify a
  // stale virtualized template; ancestor visibility belongs to sidebar UI
  // lifecycle and must be treated conservatively.
  if (row.hidden || row.getAttribute('aria-hidden') === 'true') return false;

  const style = window.getComputedStyle(row);
  return !(
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.contentVisibility === 'hidden'
  );
}

/**
 * A conversation row is "populated" once Gemini fills in its link. The lr26
 * sidebar virtualizes rows: `[data-test-id="conversation"]` elements exist as
 * empty stubs (no link, no title) while collapsed or mid-render, and only gain
 * an `<a href>` once actually rendered. We use the link as the populated signal.
 */
function isPopulatedConversationEl(el: HTMLElement): boolean {
  return !!el.querySelector('a[href*="/app/"], a[href*="/gem/"]');
}

/** Synchronous extraction over the currently-populated sidebar rows. */
function collectPopulatedConversations(
  sidebar: HTMLElement | null,
  accountIsolationEnabled: boolean,
): Array<{ id: string; title: string; url: string }> {
  const results: Array<{ id: string; title: string; url: string }> = [];
  const seen = new Set<string>();
  const conversationEls = getNativeConversationElements(sidebar);

  for (const el of Array.from(conversationEls)) {
    const htmlEl = el as HTMLElement;
    if (!isPopulatedConversationEl(htmlEl)) continue; // skip virtualized stub
    const id = extractNativeConversationId(htmlEl);
    const url = extractNativeConversationUrl(htmlEl, accountIsolationEnabled);
    if (!id || !url) continue;
    if (seen.has(id)) continue; // collapsed rail can emit duplicate rows
    seen.add(id);
    const title = extractNativeConversationTitle(htmlEl) || 'Untitled';
    results.push({ id, title, url });
  }

  return results;
}

/**
 * Poll until at least one sidebar conversation row is populated, or timeout.
 * Returns true if a populated row was found.
 */
async function waitForPopulatedSidebarConversations(
  getContext: () => NativeSidebarReadContext,
): Promise<boolean> {
  const hasPopulated = () =>
    Array.from(getNativeConversationElements(getContext().sidebar)).some((el) =>
      isPopulatedConversationEl(el as HTMLElement),
    );

  if (hasPopulated()) return true;

  const deadline = Date.now() + AI_ORG_COLLECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, AI_ORG_COLLECT_POLL_MS));
    if (getContext().isDestroyed) return false;
    if (hasPopulated()) return true;
  }
  return false;
}

/**
 * Collect all conversation titles and URLs from the native sidebar DOM.
 * Waits for the virtualized rows to populate before reading them — otherwise
 * the list comes back empty and the AI-organize prompt has nothing to work
 * with (see #725).
 */
export async function collectAllSidebarConversations(
  getContext: () => NativeSidebarReadContext,
): Promise<Array<{ id: string; title: string; url: string }>> {
  await waitForPopulatedSidebarConversations(getContext);
  const { sidebar, accountIsolationEnabled } = getContext();
  return collectPopulatedConversations(sidebar, accountIsolationEnabled);
}
