import {
  DOMContentExtractor,
  type ExtractedContent,
} from '@/features/export/services/DOMContentExtractor';
import type { SiteAdapter } from '@/features/plugins/types';

import { resolveConversationRoot } from '../../conversationDom';
import type { ExportPlatformAdapter } from './contract';

function extractConversationId(): string | null {
  const appMatch = window.location.pathname.match(/\/app\/([^/?#]+)/);
  if (appMatch?.[1]) return appMatch[1];
  return window.location.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/)?.[1] ?? null;
}

function isMeaningfulTitle(value: string | null | undefined): value is string {
  const title = (value || '').trim();
  if (!title) return false;
  if (
    ['Untitled Conversation', 'Gemini', 'Google Gemini', 'Google AI Studio', 'New chat'].includes(
      title,
    )
  ) {
    return false;
  }
  return !(title.startsWith('Gemini -') || title.startsWith('Google AI Studio -'));
}

function escapeCss(value: string): string {
  return globalThis.CSS?.escape?.(value) ?? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function extractTitleFromConversationElement(element: HTMLElement): string | null {
  const scope = (element.closest('[data-test-id="conversation"]') as HTMLElement) || element;
  const heading = scope.querySelector(
    '.gds-label-l, .conversation-title-text, [data-test-id="conversation-title"], h3',
  );
  const headingText = heading?.textContent?.trim();
  if (isMeaningfulTitle(headingText)) return headingText;

  const link = scope.querySelector(
    'a[href*="/app/"], a[href*="/gem/"]',
  ) as HTMLAnchorElement | null;
  const ariaLabel = link?.getAttribute('aria-label')?.trim();
  if (isMeaningfulTitle(ariaLabel)) return ariaLabel;
  const linkTitle = link?.getAttribute('title')?.trim();
  return isMeaningfulTitle(linkTitle) ? linkTitle : null;
}

function extractConversationTitle(): string {
  try {
    const active =
      document.querySelector(
        '.gv-folder-conversation.gv-folder-conversation-selected .gv-conversation-title',
      ) || document.querySelector('.gv-folder-conversation-selected .gv-conversation-title');
    if (active?.textContent?.trim()) return active.textContent.trim();
  } catch {
    /* ignore */
  }

  try {
    const conversationId = extractConversationId();
    if (conversationId) {
      const escapedId = escapeCss(conversationId);
      const element =
        (document.querySelector(
          `[data-test-id="conversation"][jslog*="c_${escapedId}"]`,
        ) as HTMLElement) ||
        (document.querySelector(
          `[data-test-id="conversation"] a[href*="${escapedId}"]`,
        ) as HTMLElement);
      if (element) {
        const title = extractTitleFromConversationElement(element);
        if (title) return title;
      }
    }
  } catch {
    /* ignore */
  }

  const pageTitle = document.title?.trim();
  if (isMeaningfulTitle(pageTitle)) return pageTitle;

  try {
    for (const selector of [
      'mat-list-item.mdc-list-item--activated [mat-line]',
      'mat-list-item[aria-current="page"] [mat-line]',
    ]) {
      const title = document.querySelector(selector)?.textContent?.trim();
      if (isMeaningfulTitle(title)) return title;
    }
  } catch {
    /* ignore */
  }

  const conversationId = extractConversationId();
  return conversationId ? `Conversation ${conversationId.slice(0, 8)}` : 'Untitled Conversation';
}

const ROOT_CANDIDATES = [
  '#chat-history',
  'infinite-scroller.chat-history',
  'chat-window-content',
  'main',
];

function resolveRoot(userSelectors: string[], doc: Document = document): HTMLElement {
  return resolveConversationRoot({ userSelectors, doc });
}

function extractUserImage(element: HTMLElement): NodeListOf<HTMLImageElement> {
  return element.querySelectorAll('user-query-file-preview img, .preview-image');
}

function extractUserText(textLines: NodeListOf<HTMLElement>, textParts: string[]): void {
  textLines.forEach((line) => {
    const raw = line.dataset?.userLatexOriginal ?? line.textContent ?? '';
    const text = DOMContentExtractor.normalizeText(raw);
    if (text) textParts.push(text);
  });
}

function getUserAttachmentCandidates(element: HTMLElement): HTMLElement[] | undefined {
  const uploadedFiles = Array.from(
    element.querySelectorAll<HTMLElement>('user-query-file-preview [data-test-id="uploaded-file"]'),
  );
  if (uploadedFiles.length > 0) return uploadedFiles;

  const filePreviews = Array.from(
    element.querySelectorAll<HTMLElement>('user-query-file-preview .new-file-preview-file'),
  );
  return filePreviews.length > 0 ? filePreviews : undefined;
}

function emitImage(
  image: HTMLImageElement,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages'>,
  processedImageSrcs?: Set<string>,
  fallbackAlt = 'Image',
): void {
  const src = image.getAttribute('src') || image.src || '';
  if (!src || src === 'about:blank' || processedImageSrcs?.has(src)) return;

  processedImageSrcs?.add(src);
  flags.hasImages = true;
  const alt = image.alt || fallbackAlt;
  htmlParts.push(
    `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
  );
  textParts.push(`\n![${alt.replace(/\]/g, '\\]')}](${src})\n`);
}

function extractAssistantImage(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  _DEBUG?: boolean,
  processedImageSrcs?: Set<string>,
): boolean | undefined {
  const searchImageContainers = child.querySelectorAll(
    '.attachment-container.search-images .image-container[data-full-size-image-uri]',
  );
  if (searchImageContainers.length > 0) {
    for (const container of Array.from(searchImageContainers)) {
      const image = container.querySelector<HTMLImageElement>('img.image');
      const src = image?.src || '';
      if (!image || !src || src === 'about:blank' || processedImageSrcs?.has(src)) continue;

      processedImageSrcs?.add(src);
      flags.hasImages = true;
      const alt = image.alt || 'Search result image';
      htmlParts.push(
        `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
      );
      const sourceUrl = container.querySelector<HTMLAnchorElement>('a.source')?.href || '';
      const fullSizeUri = container.getAttribute('data-full-size-image-uri') || '';
      const linkUrl = fullSizeUri || sourceUrl;
      const linkLabel =
        container.querySelector('.source .label')?.textContent?.trim() || sourceUrl || linkUrl;
      const imageMarkdown = `![${alt.replace(/\]/g, '\\]')}](${src})`;
      textParts.push(
        linkUrl
          ? `\n${imageMarkdown}\n*Source: [${linkLabel}](${linkUrl})*\n`
          : `\n${imageMarkdown}\n`,
      );
    }
    return true;
  }

  const generatedImages = child.querySelectorAll<HTMLImageElement>(
    'generated-image img, single-image img, .attachment-container.generated-images img',
  );
  if (generatedImages.length > 0) {
    generatedImages.forEach((image) =>
      emitImage(image, htmlParts, textParts, flags, processedImageSrcs, 'Generated image'),
    );
    return true;
  }

  if (
    child.querySelector(
      '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
    ) &&
    DOMContentExtractor.processYouTubeCovers(child, htmlParts, textParts, flags)
  ) {
    return true;
  }

  // The generic walker used to own this fallback. Keep it in Gemini's adapter
  // so standalone generated-UI screenshots and future plain images survive the
  // platform split without teaching the shared extractor about Gemini DOM.
  if (tagName === 'img') {
    emitImage(child as HTMLImageElement, htmlParts, textParts, flags, processedImageSrcs);
    return true;
  }
}

function extractFormula(
  child: Element,
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  htmlParts: string[],
  textParts: string[],
  _DEBUG: boolean,
): boolean | undefined {
  if (!child.classList.contains('math-block') && !child.hasAttribute('data-math')) return;
  const latex = child.getAttribute('data-math') || '';
  if (!latex) return;

  flags.hasFormulas = true;
  const clonedFormula = (child as HTMLElement).cloneNode(true) as HTMLElement;
  if (!clonedFormula.hasAttribute('data-math')) clonedFormula.setAttribute('data-math', latex);
  htmlParts.push(clonedFormula.outerHTML);
  textParts.push(`\n$$\n${latex}\n$$\n`);
  return true;
}

function extractCodeBlock(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
  _DEBUG?: boolean,
): boolean | undefined {
  if (child.querySelector('.gv-mermaid-wrapper')) return;

  // Descendant code blocks belong to the shared DOM-order traversal. Claiming
  // their parent here drops prose and sibling blocks around the first match.
  if (tagName !== 'code-block' && !child.classList.contains('code-block')) return;

  const codeContent = DOMContentExtractor.extractCodeBlock(child as HTMLElement);
  if (codeContent.text) {
    flags.hasCode = true;
    htmlParts.push(codeContent.html);
    textParts.push(`\n${codeContent.text}\n`);
  }
  return true;
}

function extractInlineFormula(
  element: Element,
  htmlParts: string[],
  textParts: string[],
): boolean | undefined {
  if (!element.classList.contains('math-inline') && !element.hasAttribute('data-math')) return;
  const latex = element.getAttribute('data-math') || '';
  if (!latex) return;

  const clonedFormula = (element as HTMLElement).cloneNode(true) as HTMLElement;
  if (!clonedFormula.hasAttribute('data-math')) clonedFormula.setAttribute('data-math', latex);
  htmlParts.push(clonedFormula.outerHTML);
  textParts.push(`$${latex}$`);
  return true;
}

export function buildGeminiAdapter(site: SiteAdapter): ExportPlatformAdapter {
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
      return configured
        ? [configured, ...defaults.filter((item) => item !== configured)]
        : defaults;
    },
    getAssistantSelectors: () => [
      '[aria-label="Gemini response"]',
      '[data-message-author-role="assistant"]',
      '[data-message-author-role="model"]',
      'article[data-author="assistant"]',
      'article[data-turn="assistant"]',
      'article[data-turn="model"]',
      '.model-response, model-response',
      '.response-container',
      'div[role="listitem"]:not([data-user="true"])',
    ],
    getConversationRootCandidates: () => ROOT_CANDIDATES,
    extractConversationTitle,
    extractConversationIdFromUrl: extractConversationId,
    shouldPreloadHistory: () => true,
    resolveConversationRoot: resolveRoot,
    extractUserImage,
    extractUserText,
    getUserAttachmentCandidates,
    extractAssistantImage,
    extractFormula,
    extractCodeBlock,
    extractInlineFormula,
  };
}
