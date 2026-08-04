/**
 * Export Platform Adapters
 *
 * Each adapter extends the plugin system's SiteAdapter with export-specific
 * behavior (title extraction, conversation root, history preloading).
 *
 * The single entry point is `resolveExportAdapter()` — every platform-
 * specific decision in the export pipeline flows through it.
 */
import {
  DOMContentExtractor,
  ExtractedContent,
} from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn, ExportHandler } from '@/features/export/types/export';
import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { SiteAdapter } from '@/features/plugins/types';

import { resolveConversationRoot } from '../conversationDom';
import { buildChatGptTurnsForSelection, chatgptCollectTurnContainers } from './chatgpt';
import type { ChatGptTurnContainer } from './type';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
export interface ExportPlatformAdapter {
  /** The underlying plugin-site adapter (selectors, theme, capabilities). */
  readonly site: SiteAdapter;

  /** CSS selectors that match user message elements. */
  getUserSelectors: () => string[];

  /** CSS selectors that match assistant response elements. */
  getAssistantSelectors: () => string[];

  /** Ordered list of CSS selectors for the conversation scroll container. */
  getConversationRootCandidates: () => string[];

  /** Extract a human-readable title for the current conversation. */
  extractConversationTitle: () => string;

  /** Extract a stable conversation id from the current URL, or null. */
  extractConversationIdFromUrl: () => string | null;

  /** Whether the platform lazy-loads history and needs the "click top node" preload loop. */
  shouldPreloadHistory: () => boolean;

  resolveConversationRoot: (userSelectors: string[], doc: Document) => HTMLElement;

  /**
   * CSS selectors for conversation images. Used by DOMContentExtractor to
   * find <img> elements in user/assistant content. Empty array = fall back to
   * the generic DOM walker (which is what Gemini's own extraction uses).
   */
  extractUserImage: (element: HTMLElement) => NodeListOf<HTMLImageElement>;

  extractAssistantImage: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
    processedImageSrcs?: ReadonlySet<string>,
  ) => boolean | undefined;

  extractFormula: (
    child: Element,
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    htmlParts: string[],
    textParts: string[],
    DEBUG: boolean,
  ) => boolean | undefined;

  extractCodeBlock: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
  ) => boolean | undefined;

  /**
   * Returns the platform's stable, ordered top-level message containers.
   * ChatGPT uses data-turn-id-container; Gemini currently uses its legacy flow.
   */
  collectTurnContainers?: () => ChatGptTurnContainer[];

  /**
   * Builds export-ready turns from stable platform message IDs. Virtualized
   * platforms may scroll and extract each selected message before returning.
   */
  buildTurnsForSelection?: (
    selectedMessageIds: ReadonlySet<string>,
    exportHandler: ExportHandler,
  ) => Promise<ChatTurn[]>;
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
  return !(s.startsWith('Gemini -') || s.startsWith('Google AI Studio -'));
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

function geminiResolveConversationRoot(
  userSelectors: string[],
  doc: Document = document,
): HTMLElement {
  return resolveConversationRoot({ userSelectors, doc });
}

function geminiExtractUserImage(element: HTMLElement): NodeListOf<HTMLImageElement> {
  const ImageSelector = 'user-query-file-preview img, .preview-image';
  return element.querySelectorAll(ImageSelector);
}

function geminiExtractAssistantImage(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  DEBUG?: boolean,
  processedImageSrcs?: ReadonlySet<string>,
): boolean | undefined {
  {
    const searchImageContainers = child.querySelectorAll(
      '.attachment-container.search-images .image-container[data-full-size-image-uri]',
    );
    if (searchImageContainers.length > 0) {
      for (const container of Array.from(searchImageContainers)) {
        const fullSizeUri = container.getAttribute('data-full-size-image-uri') || '';
        const imgEl = container.querySelector('img.image') as HTMLImageElement | null;
        if (!imgEl) continue;
        // Use the Google-cached thumbnail (gstatic.com) as the downloadable src.
        // The full-size URI points to arbitrary third-party domains that are blocked
        // by both CORS and Gemini's CSP, so it's only usable as an attribution link.
        const src = imgEl.src || '';
        if (!src || src === 'about:blank') continue;
        const alt = imgEl.alt || 'Search result image';
        const sourceLink = container.querySelector('a.source') as HTMLAnchorElement | null;
        const sourceUrl = sourceLink?.href || '';
        const sourceLabel = container.querySelector('.source .label')?.textContent?.trim() || '';

        flags.hasImages = true;
        htmlParts.push(
          `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
        );
        const mdAlt = alt.replace(/\]/g, '\\]');
        // Link to the full-size image or source when available
        const linkUrl = fullSizeUri || sourceUrl;
        const linkLabel = sourceLabel || (sourceUrl ? sourceUrl : '');
        if (linkUrl) {
          textParts.push(
            `\n![${mdAlt}](${src})\n*Source: [${linkLabel || linkUrl}](${linkUrl})*\n`,
          );
        } else {
          textParts.push(`\n![${mdAlt}](${src})\n`);
        }
      }
      if (DEBUG)
        console.log(
          '[DOMContentExtractor] Extracted',
          searchImageContainers.length,
          'search result images',
        );
      return true;
    }
  }

  // Generated images (model-generated images in assistant responses)
  // These are typically wrapped in: <p> > <div.attachment-container.generated-images> >
  //   <response-element> > <generated-image> > <single-image> > ... > <img>
  // Also handle standalone generated-image / single-image custom elements
  {
    const generatedImgs = child.querySelectorAll(
      'generated-image img, single-image img, .attachment-container.generated-images img',
    );
    if (generatedImgs.length > 0) {
      for (const img of Array.from(generatedImgs)) {
        const imgEl = img as HTMLImageElement;
        const src = imgEl.src || imgEl.getAttribute('src') || '';
        if (!src || src === 'about:blank') continue;
        const alt = imgEl.alt || 'Generated image';
        flags.hasImages = true;
        htmlParts.push(
          `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
        );
        const mdAlt = alt.replace(/\]/g, '\\]');
        textParts.push(`\n![${mdAlt}](${src})\n`);
      }
      if (DEBUG)
        console.log('[DOMContentExtractor] Extracted', generatedImgs.length, 'generated images');
      return true;
    }
  }

  // YouTube video cards — export the cover thumbnail (linked to the video).
  // The <iframe> player can't be exported, so the cover image stands in.
  if (
    child.querySelector(
      '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
    )
  ) {
    if (DOMContentExtractor.processYouTubeCovers(child, htmlParts, textParts, flags)) {
      return true;
    }
  }
}

function geminiExtractFormula(
  child: Element,
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  htmlParts: string[],
  textParts: string[],
  DEBUG: boolean,
): boolean | undefined {
  if (child.classList.contains('math-block') || child.hasAttribute('data-math')) {
    const latex = child.getAttribute('data-math') || '';
    if (latex) {
      if (DEBUG) console.log('[DOMContentExtractor] Found math-block, latex:', latex);
      flags.hasFormulas = true;
      // For HTML output: preserve the rendered formula HTML for PDF export
      // Clone the element to preserve its rendered content
      const clonedFormula = (child as HTMLElement).cloneNode(true) as HTMLElement;
      // Ensure data-math attribute is preserved for potential re-rendering
      if (!clonedFormula.hasAttribute('data-math')) {
        clonedFormula.setAttribute('data-math', latex);
      }
      htmlParts.push(clonedFormula.outerHTML);
      // For text output: use Markdown format
      textParts.push(`\n$$\n${latex}\n$$\n`);
      return true;
    }
  }
}

function geminiExtractCodeBlock(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  DEBUG?: boolean,
): boolean | undefined {
  const codeBlock = child.querySelector('code-block');
  if (tagName === 'code-block' || child.classList.contains('code-block') || codeBlock) {
    if (DEBUG) console.log('[DOMContentExtractor] Found code block!');
    const elementToExtract = (codeBlock || child) as HTMLElement;
    const codeContent = DOMContentExtractor.extractCodeBlock(elementToExtract);
    if (DEBUG) console.log('[DOMContentExtractor] Code content:', codeContent.text);
    if (codeContent.text) {
      flags.hasCode = true;
      htmlParts.push(codeContent.html);
      textParts.push(`\n${codeContent.text}\n`);
    }
    return true;
  }
}

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
    resolveConversationRoot: geminiResolveConversationRoot,
    extractUserImage: geminiExtractUserImage,
    extractAssistantImage: geminiExtractAssistantImage,
    extractFormula: geminiExtractFormula,
    extractCodeBlock: geminiExtractCodeBlock,
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

const CHATGPT_ROOT_CANDIDATES = ['main', '[role="main"]'];

function chatgptResolveConversationRoot(
  userSelectors: string[],
  doc: Document = document,
): HTMLElement {
  for (const selector of CHATGPT_ROOT_CANDIDATES) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (el) return el;
  }
  return doc.body as HTMLElement;
}

function chatgptExtractUserImage(element: HTMLElement): NodeListOf<HTMLImageElement> {
  const ImageSelector = 'img';
  return element.querySelectorAll(ImageSelector);
}

function chatgptExtractAssistantImage(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  DEBUG?: boolean,
  processedImageSrcs?: ReadonlySet<string>,
): boolean | undefined {
  if (tagName === 'img') {
    const img = child as HTMLImageElement;
    if (img.getAttribute('aria-hidden') === 'true') return true;

    const src = img.getAttribute('src') || img.src || '';
    if (src && src !== 'about:blank' && !processedImageSrcs?.has(src)) {
      flags.hasImages = true;
      const altRaw = img.getAttribute('alt') || '';
      const alt = altRaw.trim() || 'Image';
      htmlParts.push(
        `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
      );
      const mdAlt = alt.replace(/\]/g, '\\]');
      textParts.push(`\n![${mdAlt}](${src})\n`);
    }
    return true;
  }
}

function chatgptExtractFormula(
  child: Element,
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  htmlParts: string[],
  textParts: string[],
) {
  if (child.classList.contains('katex-display') || child.classList.contains('katex')) {
    const latex = DOMContentExtractor.extractKatexLatex(child as HTMLElement);
    if (latex) {
      flags.hasFormulas = true;
      htmlParts.push(
        `<div class="math-block" data-math="${DOMContentExtractor.escapeHtml(latex)}">${child.outerHTML}</div>`,
      );
      textParts.push(`\n$$\n${latex}\n$$\n`);
      return true;
    }
  }
}

function chatgptExtractCodeBlock(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  DEBUG?: boolean,
): boolean | undefined {
  if (tagName === 'pre') {
    const codeEl = child.querySelector('code') || child;
    const code = codeEl.textContent || '';
    const className = (codeEl.getAttribute('class') || '').toLowerCase();
    const langMatch = className.match(/language-([a-z0-9]+)/i);
    const language = langMatch?.[1] ?? '';
    if (code.trim()) {
      flags.hasCode = true;
      htmlParts.push(
        `<pre><code class="language-${language}">${DOMContentExtractor.escapeHtml(code)}</code></pre>`,
      );
      textParts.push(`\n\`\`\`${language}\n${code}\n\`\`\`\n`);
      // Mark so the altCodeBlocks post-processing skips this element.
      (child as Element & { processedByGV?: boolean }).processedByGV = true;
      if (codeEl !== child) {
        (codeEl as Element & { processedByGV?: boolean }).processedByGV = true;
      }
    }
    return true;
  }
}

function buildChatGptAdapter(site: SiteAdapter): ExportPlatformAdapter {
  return {
    site,
    getUserSelectors: () => [site.selectors.userTurn],
    getAssistantSelectors: () => [site.selectors.assistantTurn],
    getConversationRootCandidates: () => CHATGPT_ROOT_CANDIDATES,
    extractConversationTitle: chatgptExtractTitle,
    extractConversationIdFromUrl: chatgptExtractId,
    shouldPreloadHistory: () => false, // 预加载也没用，所以关了
    resolveConversationRoot: chatgptResolveConversationRoot,
    extractUserImage: chatgptExtractUserImage,
    extractAssistantImage: chatgptExtractAssistantImage,
    extractFormula: chatgptExtractFormula,
    extractCodeBlock: chatgptExtractCodeBlock,
    collectTurnContainers: chatgptCollectTurnContainers,
    buildTurnsForSelection: buildChatGptTurnsForSelection,
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
  const site: SiteAdapter | null = registry.resolveByUrl(window.location.href);

  switch (site?.id) {
    case 'chatgpt':
      return buildChatGptAdapter(site);
    default:
      return buildGeminiAdapter(site ?? registry.resolveByUrl('https://gemini.google.com/')!);
  }
}
