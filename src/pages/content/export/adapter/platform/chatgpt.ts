import {
  DOMContentExtractor,
  type ExtractedContent,
} from '@/features/export/services/DOMContentExtractor';
import type { SiteAdapter } from '@/features/plugins/types';

import {
  buildChatGptTurnsForSelection,
  chatgptCollectTurnContainers,
  resolveChatGptSelectionRoles,
} from '../chatgpt';
import type { ExportPlatformAdapter } from './contract';

function extractTitle(): string {
  const title = document.title?.trim();
  if (title && title !== 'ChatGPT' && title !== 'New chat') return title;

  const active = document.querySelector(
    'nav a[aria-current="page"], #stage-slideover-sidebar a[aria-current="page"]',
  );
  const activeTitle = active?.textContent?.trim();
  if (activeTitle) return activeTitle;

  const conversationId = extractId();
  return conversationId ? `Conversation ${conversationId.slice(0, 8)}` : 'Untitled Conversation';
}

function extractId(): string | null {
  return window.location.pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
}

const ROOT_CANDIDATES = ['main', '[role="main"]'];

function resolveRoot(_userSelectors: string[], doc: Document = document): HTMLElement {
  for (const selector of ROOT_CANDIDATES) {
    const element = doc.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  return doc.body as HTMLElement;
}

function extractUserImage(element: HTMLElement): NodeListOf<HTMLImageElement> {
  return element.querySelectorAll('img');
}

function getUserAttachmentCandidates(element: HTMLElement): HTMLElement[] | undefined {
  return Array.from(element.querySelectorAll<HTMLElement>('[role="group"][aria-label]')).filter(
    (candidate) => {
      const name = candidate.getAttribute('aria-label')?.trim();
      const buttonName = candidate
        .querySelector<HTMLElement>('[data-default-action] button[aria-label]')
        ?.getAttribute('aria-label')
        ?.trim();
      return !!name && name === buttonName;
    },
  );
}

function extractUserText(
  _textLines: NodeListOf<HTMLElement>,
  textParts: string[],
  element: HTMLElement,
): void {
  const contentOnly = element.cloneNode(true) as HTMLElement;
  getUserAttachmentCandidates(contentOnly)?.forEach((candidate) => candidate.remove());
  const fallback = DOMContentExtractor.normalizeText(contentOnly.textContent || '');
  if (fallback) textParts.push(fallback);
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
  if (tagName !== 'img') return;
  const image = child as HTMLImageElement;
  if (image.getAttribute('aria-hidden') === 'true') return true;

  const src = image.getAttribute('src') || image.src || '';
  if (src && src !== 'about:blank' && !processedImageSrcs?.has(src)) {
    processedImageSrcs?.add(src);
    flags.hasImages = true;
    const alt = image.getAttribute('alt')?.trim() || 'Image';
    htmlParts.push(
      `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
    );
    textParts.push(`\n![${alt.replace(/\]/g, '\\]')}](${src})\n`);
  }
  return true;
}

export function chatgptExtractFormula(
  child: Element,
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  htmlParts: string[],
  textParts: string[],
): boolean | undefined {
  if (!child.classList.contains('katex-display') && !child.classList.contains('katex')) return;
  const source = child.closest('[data-math-source]') ?? child.closest('[role="math"]');
  const latex = (
    source?.getAttribute('data-math-source') ||
    source?.getAttribute('aria-label') ||
    ''
  ).trim();
  if (!latex) return;

  flags.hasFormulas = true;
  htmlParts.push(
    `<div class="math-block" data-math="${DOMContentExtractor.escapeHtmlAttribute(latex)}">${child.outerHTML}</div>`,
  );
  textParts.push(`\n$$\n${latex}\n$$\n`);
  return true;
}

function extractCodeBlock(
  child: Element,
  htmlParts: string[],
  textParts: string[],
  flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  tagName?: string,
): boolean | undefined {
  if (tagName !== 'pre') return;
  const codeElement = child.querySelector('code') || child;
  const code = codeElement.textContent || '';
  const className = (codeElement.getAttribute('class') || '').toLowerCase();
  const language = className.match(/language-([a-z0-9]+)/i)?.[1] ?? '';
  if (code.trim()) {
    flags.hasCode = true;
    htmlParts.push(
      `<pre><code class="language-${language}">${DOMContentExtractor.escapeHtml(code)}</code></pre>`,
    );
    textParts.push(`\n\`\`\`${language}\n${code}\n\`\`\`\n`);
    (child as Element & { processedByGV?: boolean }).processedByGV = true;
    if (codeElement !== child) {
      (codeElement as Element & { processedByGV?: boolean }).processedByGV = true;
    }
  }
  return true;
}

export function chatgptExtractInlineFormula(
  element: Element,
  htmlParts: string[],
  textParts: string[],
): boolean | undefined {
  if (!element.classList.contains('katex-display') && !element.classList.contains('katex')) return;
  const source = element.closest('[data-math-source]') ?? element.closest('[role="math"]');
  const latex = (
    source?.getAttribute('data-math-source') ||
    source?.getAttribute('aria-label') ||
    ''
  ).trim();
  if (!latex) return;

  const display =
    element.classList.contains('katex-display') || element.closest('.katex-display') != null;
  htmlParts.push(
    `<span class="${display ? 'math-block' : 'math-inline'}" data-math="${DOMContentExtractor.escapeHtmlAttribute(latex)}">${element.outerHTML}</span>`,
  );
  textParts.push(display ? `\n$$\n${latex}\n$$\n` : `$${latex}$`);
  return true;
}

export function buildChatGptAdapter(site: SiteAdapter): ExportPlatformAdapter {
  return {
    site,
    getUserSelectors: () => [site.selectors.userTurn],
    getAssistantSelectors: () => [site.selectors.assistantTurn],
    getConversationRootCandidates: () => ROOT_CANDIDATES,
    extractConversationTitle: extractTitle,
    extractConversationIdFromUrl: extractId,
    shouldPreloadHistory: () => false,
    resolveConversationRoot: resolveRoot,
    extractUserImage,
    extractUserText,
    getUserAttachmentCandidates,
    extractAssistantImage,
    extractFormula: chatgptExtractFormula,
    extractCodeBlock,
    extractInlineFormula: chatgptExtractInlineFormula,
    collectTurnContainers: chatgptCollectTurnContainers,
    buildTurnsForSelection: buildChatGptTurnsForSelection,
    resolveSelectionRoles: resolveChatGptSelectionRoles,
  };
}
