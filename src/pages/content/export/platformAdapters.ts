/**
 * Export Platform Adapters
 *
 * Each adapter extends the plugin system's SiteAdapter with export-specific
 * behavior (title extraction, conversation root, history preloading).
 *
 * The single entry point is `resolveExportAdapter()` — every platform-
 * specific decision in the export pipeline flows through it.
 */
import { buildConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { SiteAdapter } from '@/features/plugins/types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ExportPlatformAdapter {
  /** The underlying plugin-site adapter (selectors, theme, capabilities). */
  readonly site: SiteAdapter;

  /** CSS selectors that match user message elements. */
  getUserSelectors(): string[];

  /** CSS selectors that match assistant response elements. */
  getAssistantSelectors(): string[];

  /** Ordered list of CSS selectors for the conversation scroll container. */
  getConversationRootCandidates(): string[];

  /** Extract a human-readable title for the current conversation. */
  extractConversationTitle(): string;

  /** Extract a stable conversation id from the current URL, or null. */
  extractConversationIdFromUrl(): string | null;

  /** Whether the platform lazy-loads history and needs the "click top node" preload loop. */
  shouldPreloadHistory(): boolean;

  /**
   * CSS selectors for conversation images. Used by DOMContentExtractor to
   * find <img> elements in user/assistant content. Empty array = fall back to
   * the generic DOM walker (which is what Gemini's own extraction uses).
   */
  getImageSelectors(): string[];
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

function geminiExtractConversationTitle(): string {
  // Strategy 1: Voyager Folder UI
  try {
    const active =
      document.querySelector(
        '.gv-folder-conversation.gv-folder-conversation-selected .gv-conversation-title',
      ) || document.querySelector('.gv-folder-conversation-selected .gv-conversation-title');
    if (active?.textContent?.trim()) return active.textContent.trim();
  } catch {
    /* ignore */
  }

  // Strategy 2: native sidebar via conversation id
  try {
    const cid = geminiExtractConversationId();
    if (cid) {
      const esc = escapeCss(cid);
      const el =
        (document.querySelector(
          `[data-test-id="conversation"][jslog*="c_${esc}"]`,
        ) as HTMLElement) ||
        (document.querySelector(`[data-test-id="conversation"] a[href*="${esc}"]`) as HTMLElement);
      if (el) {
        const title = extractTitleFromGeminiConversationEl(el);
        if (title) return title;
      }
    }
  } catch {
    /* ignore */
  }

  // Strategy 3: page <title>
  const pageTitle = document.title?.trim();
  if (isMeaningfulTitle(pageTitle)) return pageTitle;

  // Strategy 4: sidebar active item
  try {
    for (const sel of [
      'mat-list-item.mdc-list-item--activated [mat-line]',
      'mat-list-item[aria-current="page"] [mat-line]',
    ]) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (isMeaningfulTitle(t)) return t;
    }
  } catch {
    /* ignore */
  }

  // Strategy 5: URL fallback
  const cid = geminiExtractConversationId();
  return cid ? `Conversation ${cid.slice(0, 8)}` : 'Untitled Conversation';
}

function geminiExtractConversationId(): string | null {
  const m1 = window.location.pathname.match(/\/app\/([^/?#]+)/);
  if (m1?.[1]) return m1[1];
  const m2 = window.location.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
  return m2?.[1] ?? null;
}

function extractTitleFromGeminiConversationEl(el: HTMLElement): string | null {
  const scope = (el.closest('[data-test-id="conversation"]') as HTMLElement) || el;
  const heading = scope.querySelector(
    '.gds-label-l, .conversation-title-text, [data-test-id="conversation-title"], h3',
  );
  const t = heading?.textContent?.trim();
  if (isMeaningfulTitle(t)) return t;
  const link = scope.querySelector(
    'a[href*="/app/"], a[href*="/gem/"]',
  ) as HTMLAnchorElement | null;
  const aria = link?.getAttribute('aria-label')?.trim();
  if (isMeaningfulTitle(aria)) return aria;
  const title = link?.getAttribute('title')?.trim();
  if (isMeaningfulTitle(title)) return title;
  return null;
}

function isMeaningfulTitle(t: string | null | undefined): t is string {
  const s = (t || '').trim();
  if (!s) return false;
  if (
    ['Untitled Conversation', 'Gemini', 'Google Gemini', 'Google AI Studio', 'New chat'].includes(s)
  )
    return false;
  if (s.startsWith('Gemini -') || s.startsWith('Google AI Studio -')) return false;
  return true;
}

function escapeCss(v: string): string {
  return globalThis.CSS?.escape?.(v) ?? v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const GEMINI_ROOT_CANDIDATES = [
  '#chat-history',
  'infinite-scroller.chat-history',
  'chat-window-content',
  'main',
];

function buildGeminiAdapter(site: SiteAdapter): ExportPlatformAdapter {
  return {
    site,
    getUserSelectors() {
      const configured = (() => {
        try {
          return (
            localStorage.getItem('geminiTimelineUserTurnSelector') ||
            localStorage.getItem('geminiTimelineUserTurnSelectorAuto') ||
            ''
          );
        } catch {
          return '';
        }
      })();
      const defaults = [
        '.user-query-bubble-with-background',
        '.user-query-bubble-container',
        '.user-query-container',
        'user-query-content .user-query-bubble-with-background',
        'div[aria-label="User message"]',
        'article[data-author="user"]',
        'article[data-turn="user"]',
        '[data-message-author-role="user"]',
        'div[role="listitem"][data-user="true"]',
      ];
      return configured ? [configured, ...defaults.filter((s) => s !== configured)] : defaults;
    },
    getAssistantSelectors() {
      return [
        '[aria-label="Gemini response"]',
        '[data-message-author-role="assistant"]',
        '[data-message-author-role="model"]',
        'article[data-author="assistant"]',
        'article[data-turn="assistant"]',
        'article[data-turn="model"]',
        '.model-response, model-response',
        '.response-container',
        'div[role="listitem"]:not([data-user="true"])',
      ];
    },
    getConversationRootCandidates: () => GEMINI_ROOT_CANDIDATES,
    extractConversationTitle: geminiExtractConversationTitle,
    extractConversationIdFromUrl: geminiExtractConversationId,
    shouldPreloadHistory: () => true,
    getImageSelectors: () => [],
  };
}

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

function chatgptExtractTitle(): string {
  const title = document.title?.trim();
  if (title && title !== 'ChatGPT' && title !== 'New chat') return title;

  const active = document.querySelector(
    'nav a[aria-current="page"], #stage-slideover-sidebar a[aria-current="page"]',
  );
  const text = active?.textContent?.trim();
  if (text) return text;

  const cid = chatgptExtractId();
  return cid ? `Conversation ${cid.slice(0, 8)}` : 'Untitled Conversation';
}

function chatgptExtractId(): string | null {
  return window.location.pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
}

function buildChatGptAdapter(site: SiteAdapter): ExportPlatformAdapter {
  return {
    site,
    getUserSelectors: () => [site.selectors.userTurn],
    getAssistantSelectors: () => [site.selectors.assistantTurn],
    getConversationRootCandidates: () => ['main', '[role="main"]'],
    extractConversationTitle: chatgptExtractTitle,
    extractConversationIdFromUrl: chatgptExtractId,
    shouldPreloadHistory: () => false,
    getImageSelectors: () => ['img'],
  };
}

// ---------------------------------------------------------------------------
// Registry & Resolver
// ---------------------------------------------------------------------------

const registry = SiteRegistry.createDefault();

/**
 * Resolve the export adapter for the current page.
 * Reuses the plugin system's SiteRegistry for URL matching.
 * Falls back to Gemini for unknown hosts (preserves existing behaviour).
 */
export function resolveExportAdapter(): ExportPlatformAdapter {
  const site = registry.resolveByUrl(window.location.href);

  switch (site?.id) {
    case 'chatgpt':
      return buildChatGptAdapter(site);
    default:
      // Gemini / AI Studio / unknown — use Gemini adapter with the resolved
      // site adapter (or a minimal fallback if registry has no match).
      return buildGeminiAdapter(site ?? registry.resolveByUrl('https://gemini.google.com/')!);
  }
}
