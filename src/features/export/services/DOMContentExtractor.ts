/**
 * DOM Content Extractor
 * Extracts rich content from Gemini's DOM structure preserving formatting
 */
import type { ExportAttachment } from '../types/export';

export interface ExtractedContent {
  text: string;
  html: string;
  attachments: ExportAttachment[];
  hasImages: boolean;
  hasFormulas: boolean;
  hasTables: boolean;
  hasCode: boolean;
}

export interface ExtractedTurn {
  user: ExtractedContent;
  assistant: ExtractedContent;
  starred: boolean;
}

/**
 * Extracts structured content from Gemini's DOM
 * Preserves formatting including LaTeX formulas, code blocks, tables, etc.
 */

/**
 * querySelector variant that skips elements nested inside model-thoughts / thoughts-container.
 * When the user expands Gemini's "thinking" section, a second `message-content` element
 * appears *before* the real response in DOM order.  A plain `querySelector` would match
 * the thinking panel first, causing exports to grab the wrong content.
 */
function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

const MERMAID_WRAPPER_SELECTOR = '.gv-mermaid-wrapper';
const MERMAID_RENDERED_SVG_SELECTOR = '.gv-mermaid-diagram svg';
const MERMAID_LIGHT_EXPORT_TEMPLATE_SELECTOR = 'template.gv-mermaid-light-export';
const MERMAID_EXPORT_CLASS = 'gv-export-mermaid';
const MERMAID_THEME_ATTRIBUTE = 'data-gv-mermaid-theme';

type ExportCodeBlock =
  | { kind: 'mermaid'; element: HTMLElement }
  | { kind: 'code'; element: HTMLElement };

export class DOMContentExtractor {
  private static DEBUG = false;
  /**
   * Extract user query content
   */
  static extractUserContent(element: HTMLElement): ExtractedContent {
    const result: ExtractedContent = {
      text: '',
      html: '',
      attachments: [],
      hasImages: false,
      hasFormulas: false,
      hasTables: false,
      hasCode: false,
    };

    // Check for images
    const images = element.querySelectorAll('user-query-file-preview img, .preview-image');
    result.hasImages = images.length > 0;

    const attachments = this.extractUserAttachments(element);
    result.attachments = attachments;

    // Extract text from query-text-line paragraphs
    const textLines = element.querySelectorAll('.query-text-line');
    const textParts: string[] = [];
    textLines.forEach((line) => {
      const el = line as HTMLElement;
      const raw = el.dataset?.userLatexOriginal ?? line.textContent ?? '';
      const text = this.normalizeText(raw);
      if (text) textParts.push(text);
    });
    result.text = textParts.join('\n');

    // Build HTML representation
    const htmlParts: string[] = [];

    // Add image markdown
    const imageMarkdown: string[] = [];
    images.forEach((img, index) => {
      const src = (img as HTMLImageElement).src;
      const alt = (img as HTMLImageElement).alt || `Uploaded image ${index + 1}`;
      htmlParts.push(`<img src="${src}" alt="${alt}" />`);
      imageMarkdown.push(`![${alt}](${src})`);
    });

    attachments.forEach((attachment) => {
      htmlParts.push(
        `<div class="gv-export-attachment"><span class="gv-export-attachment-icon" aria-hidden="true">📄</span><span class="gv-export-attachment-name">${this.escapeHtml(attachment.name)}</span></div>`,
      );
    });

    // Combine image markdown and text
    const allTextParts: string[] = [];
    if (imageMarkdown.length > 0) {
      allTextParts.push(imageMarkdown.join('\n\n'));
    }
    if (attachments.length > 0) {
      allTextParts.push(attachments.map(({ name }) => `📎 ${name}`).join('\n'));
    }
    if (textParts.length > 0) {
      allTextParts.push(textParts.join('\n'));
    }
    result.text = allTextParts.join('\n\n');

    // Add text paragraphs to HTML
    textParts.forEach((text) => {
      htmlParts.push(`<p>${this.escapeHtml(text)}</p>`);
    });

    result.html = htmlParts.join('\n');

    return result;
  }

  /**
   * Extract assistant response content with rich formatting
   */
  static extractAssistantContent(element: HTMLElement): ExtractedContent {
    if (this.DEBUG)
      console.log('[DOMContentExtractor] extractAssistantContent called, element:', element);

    const result: ExtractedContent = {
      text: '',
      html: '',
      attachments: [],
      hasImages: false,
      hasFormulas: false,
      hasTables: false,
      hasCode: false,
    };

    // Find message-content first (contains main text and formulas)
    // Use queryOutsideThoughts to avoid matching the message-content inside
    // the expanded thinking/reasoning panel.
    let messageContent = queryOutsideThoughts(element, 'message-content');

    if (!messageContent) {
      // Try markdown container
      messageContent = queryOutsideThoughts(
        element,
        '.markdown-main-panel, ' + '.markdown, ' + '.model-response-text',
      );
    }

    // If still not found, check if element itself is a valid container
    if (!messageContent) {
      if (
        element.classList.contains('markdown') ||
        element.tagName.toLowerCase() === 'message-content'
      ) {
        messageContent = element;
      }
    }

    if (!messageContent) {
      // Last resort: use element directly
      console.warn('[DOMContentExtractor] Response container not found, using element directly');
      messageContent = element;
    }

    if (this.DEBUG)
      console.log(
        '[DOMContentExtractor] Using container:',
        messageContent.tagName,
        messageContent.className,
      );

    // Don't clone! Angular custom elements may lose content when cloned
    // Instead, skip model-thoughts during processNodes
    const htmlParts: string[] = [];
    const textParts: string[] = [];

    // STRATEGY CHANGE: Instead of recursing through DOM (which misses Angular-rendered elements),
    // process the .markdown div directly and then search for response-elements
    const markdownDiv = messageContent.querySelector('.markdown, .markdown-main-panel');

    if (this.DEBUG) {
      console.log('[DOMContentExtractor] messageContent tagName:', messageContent.tagName);
      console.log('[DOMContentExtractor] messageContent className:', messageContent.className);
      console.log('[DOMContentExtractor] markdownDiv found?', !!markdownDiv);
    }

    if (markdownDiv) {
      if (this.DEBUG) {
        console.log('[DOMContentExtractor] markdownDiv tagName:', markdownDiv.tagName);
        console.log('[DOMContentExtractor] markdownDiv className:', markdownDiv.className);
        console.log(
          '[DOMContentExtractor] markdownDiv innerHTML preview:',
          (markdownDiv as HTMLElement).innerHTML.substring(0, 300),
        );
      }

      // First, process all direct children of markdown that are NOT response-element
      this.processNodes(markdownDiv, htmlParts, textParts, result);

      // Note: response-element contents are processed by processNodes recursion above
    } else {
      // Fallback to old method
      if (this.DEBUG) console.log('[DOMContentExtractor] No markdown div found, using fallback');
      this.processNodes(messageContent, htmlParts, textParts, result);
    }

    // Additionally, look for code blocks and tables at the element level
    // These might be siblings to message-content in response-element containers
    // IMPORTANT: Angular may use Shadow DOM, so we need to search both light DOM and shadow DOM
    if (this.DEBUG) {
      console.log(
        '[DOMContentExtractor] Searching for code blocks in:',
        element.tagName,
        element.className,
      );
      console.log(
        '[DOMContentExtractor] Element HTML preview:',
        element.outerHTML.substring(0, 200),
      );
    }

    // Helper function to search in both light DOM and shadow DOM
    const searchAll = (root: Element, selector: string): Element[] => {
      const results: Element[] = [];

      // Search in light DOM
      results.push(...Array.from(root.querySelectorAll(selector)));

      // Search in shadow DOM recursively
      const searchShadow = (el: Element) => {
        const shadowRoot = el.shadowRoot;
        if (shadowRoot) {
          console.log(`[DOMContentExtractor] Searching in Shadow DOM of`, el.tagName);
          results.push(...Array.from(shadowRoot.querySelectorAll(selector)));
        }

        // Recursively check children for shadow roots
        Array.from(el.children).forEach(searchShadow);
      };

      searchShadow(root);
      return results;
    };

    // Also search for raw code elements regardless of presence of code-block
    const altCodeBlocks = searchAll(messageContent, 'pre > code, [data-test-id="code-content"]');
    if (this.DEBUG)
      console.log(
        '[DOMContentExtractor] Found',
        altCodeBlocks.length,
        'raw code elements with alternative selector',
      );
    altCodeBlocks.forEach((codeEl, idx) => {
      // Avoid duplicates if already processed
      if ((codeEl as Element & { processedByGV?: boolean }).processedByGV) return;
      // Skip if inside a code-block (already handled by processNodes)
      if (codeEl.closest && codeEl.closest('code-block')) return;
      if (this.DEBUG)
        console.log(
          `[DOMContentExtractor] Processing raw code element ${idx + 1}/${altCodeBlocks.length}`,
        );
      const extracted = this.extractCodeFromCodeElement(codeEl as HTMLElement);
      if (extracted.text) {
        (codeEl as Element & { processedByGV?: boolean }).processedByGV = true;
        result.hasCode = true;
        htmlParts.push(extracted.html);
        textParts.push(`\n${extracted.text}\n`);
      }
    });
    // Note: tables and code-blocks were already processed via processNodes()

    // YouTube covers not reached by processNodes (e.g. attachment areas rendered
    // outside the markdown container). Deduped via the processedByGV marker.
    this.processYouTubeCovers(messageContent, htmlParts, textParts, result);

    result.html = htmlParts.join('\n');
    // Clean up multiple newlines but preserve intentional spacing
    let combinedText = textParts
      .join('')
      .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
      .trim();
    // Last-chance fallback: if no structured text captured, use plain innerText
    if (!combinedText) {
      const fallbackContainer =
        (messageContent as HTMLElement) ||
        queryOutsideThoughts<HTMLElement>(element, 'message-content') ||
        (element as HTMLElement);
      try {
        const plain =
          (fallbackContainer as HTMLElement).innerText || fallbackContainer.textContent || '';
        combinedText = this.normalizeText(plain);
      } catch {
        /* ignore */
      }
    }
    result.text = combinedText;

    return result;
  }

  /**
   * Extract non-image uploads from Gemini's user-query-file-preview elements.
   * Image previews are already exported as images above, so they are not duplicated.
   */
  private static extractUserAttachments(element: HTMLElement): ExportAttachment[] {
    const uploadedFiles = Array.from(
      element.querySelectorAll<HTMLElement>(
        'user-query-file-preview [data-test-id="uploaded-file"]',
      ),
    );
    const candidates =
      uploadedFiles.length > 0
        ? uploadedFiles
        : Array.from(
            element.querySelectorAll<HTMLElement>('user-query-file-preview .new-file-preview-file'),
          );
    const attachments: ExportAttachment[] = [];
    const seen = new Set<string>();

    candidates.forEach((candidate) => {
      const labelledElement = candidate.matches('[aria-label]')
        ? candidate
        : candidate.querySelector<HTMLElement>('[aria-label]');
      const name =
        labelledElement?.getAttribute('aria-label')?.trim() ||
        candidate.getAttribute('title')?.trim() ||
        this.normalizeText(candidate.textContent ?? '').replace(
          /^(?:PDF|DOCX?|PPTX?|XLSX?|CSV|TXT|ZIP|FILE)\s+/i,
          '',
        );

      if (!name) return;

      const type = name.match(/\.([a-z0-9]{1,12})$/i)?.[1].toLowerCase() ?? 'file';
      const preview = candidate.closest('user-query-file-preview') ?? candidate;
      const isImage =
        /^(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(type) &&
        !!preview.querySelector('img');
      const key = `${name}\u0000${type}`;

      if (isImage || seen.has(key)) return;

      seen.add(key);
      attachments.push({ name, type });
    });

    return attachments;
  }

  /**
   * Process DOM nodes recursively
   */
  private static processNodes(
    container: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  ): void {
    const children = Array.from(container.children);
    if (this.DEBUG)
      console.log(
        `[DOMContentExtractor] processNodes: ${children.length} children in`,
        container.tagName,
        container.className,
      );

    // Check for Shadow DOM
    const shadowRoot = container.shadowRoot;
    if (shadowRoot) {
      if (this.DEBUG)
        console.log('[DOMContentExtractor] Found Shadow DOM! Processing shadow children');
      this.processNodes(shadowRoot as unknown as Element, htmlParts, textParts, flags);
    }

    for (const child of children) {
      const tagName = child.tagName.toLowerCase();
      if (this.DEBUG)
        console.log('[DOMContentExtractor] Processing child:', tagName, child.className);

      // Skip certain elements
      if (this.shouldSkipElement(child)) {
        if (this.DEBUG) console.log('[DOMContentExtractor] Skipping element:', tagName);
        continue;
      }

      // Canvas Export Section (Injected Canvas document content)
      if (child.classList.contains('gv-canvas-export-section')) {
        const headingEl = child.querySelector('h3');
        const contentEl = child.querySelector('.gv-canvas-content');
        const headingText = headingEl?.textContent || 'Canvas Document';
        const contentText = contentEl?.textContent || '';

        htmlParts.push(
          `<div class="gv-canvas-export-section"><h3>${this.escapeHtml(headingText)}</h3><pre style="white-space: pre-wrap;">${this.escapeHtml(contentText)}</pre></div>`,
        );
        textParts.push(`\n### ${headingText}\n\n${contentText}\n`);
        continue;
      }

      // Images
      if (tagName === 'img') {
        const img = child as HTMLImageElement;
        const src = img.getAttribute('src') || img.src || '';
        if (src && src !== 'about:blank') {
          flags.hasImages = true;
          const altRaw = img.getAttribute('alt') || '';
          const alt = altRaw.trim() || 'Image';
          htmlParts.push(
            `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
          );
          const mdAlt = alt.replace(/\]/g, '\\]');
          textParts.push(`\n![${mdAlt}](${src})\n`);
        }
        continue;
      }

      // Math block (display formula) - check both class and data-math attribute
      if (child.classList.contains('math-block') || child.hasAttribute('data-math')) {
        const latex = child.getAttribute('data-math') || '';
        if (latex) {
          if (this.DEBUG) console.log('[DOMContentExtractor] Found math-block, latex:', latex);
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
          continue;
        }
      }

      const exportCodeBlocks = this.findExportCodeBlocks(child);
      const directExportCodeBlock = exportCodeBlocks.find(({ element }) => element === child);
      if (directExportCodeBlock) {
        const content =
          directExportCodeBlock.kind === 'mermaid'
            ? this.extractMermaidContent(directExportCodeBlock.element)
            : this.extractCodeBlock(directExportCodeBlock.element);
        if (content) {
          htmlParts.push(content.html);
        }
        if (content?.text) {
          flags.hasCode = true;
          textParts.push(`\n${content.text}\n`);
        }
        continue;
      }

      // Traverse containers that own export blocks instead of consuming only their first
      // descendant. This keeps prose, code, and Mermaid output in DOM order.
      if (tagName !== 'ul' && tagName !== 'ol' && exportCodeBlocks.length > 0) {
        this.processNodes(child, htmlParts, textParts, flags);
        continue;
      }

      // Table block (check for nested table-block first)
      const tableBlock = child.querySelector('table-block');
      if (tagName === 'table-block' || tableBlock || child.querySelector('table')) {
        if (this.DEBUG) console.log('[DOMContentExtractor] Found table block!');
        const elementToExtract = (tableBlock || child) as HTMLElement;
        const tableContent = this.extractTable(elementToExtract);
        if (this.DEBUG) console.log('[DOMContentExtractor] Table content:', tableContent.text);
        if (tableContent.text) {
          // Only add if table was successfully extracted
          flags.hasTables = true;
          htmlParts.push(tableContent.html);
          textParts.push(`\n${tableContent.text}\n`);
        }
        continue;
      }

      // Search result images (web images found by Gemini)
      // Structure: <div.attachment-container.search-images> > <response-element> >
      //   <single-image> > <div.image-container[data-full-size-image-uri]> > ... > <img>
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
            const sourceLabel =
              container.querySelector('.source .label')?.textContent?.trim() || '';

            flags.hasImages = true;
            htmlParts.push(
              `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
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
          if (this.DEBUG)
            console.log(
              '[DOMContentExtractor] Extracted',
              searchImageContainers.length,
              'search result images',
            );
          continue;
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
              `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
            );
            const mdAlt = alt.replace(/\]/g, '\\]');
            textParts.push(`\n![${mdAlt}](${src})\n`);
          }
          if (this.DEBUG)
            console.log(
              '[DOMContentExtractor] Extracted',
              generatedImgs.length,
              'generated images',
            );
          continue;
        }
      }

      // YouTube video cards — export the cover thumbnail (linked to the video).
      // The <iframe> player can't be exported, so the cover image stands in.
      if (
        child.querySelector(
          '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
        )
      ) {
        if (this.processYouTubeCovers(child, htmlParts, textParts, flags)) {
          continue;
        }
      }

      // Horizontal rule
      if (tagName === 'hr') {
        htmlParts.push('<hr>');
        textParts.push('\n---\n');
        continue;
      }

      // Paragraph with possible inline formulas
      if (tagName === 'p') {
        const processed = this.processInlineContent(child as HTMLElement);
        if (processed.hasFormulas) flags.hasFormulas = true;
        htmlParts.push(`<p>${processed.html}</p>`);
        textParts.push(`${processed.text}\n`);
        continue;
      }

      // Headings
      if (/^h[1-6]$/.test(tagName)) {
        const text = this.extractTextWithInlineFormulas(child as HTMLElement);
        const level = tagName[1];
        htmlParts.push(`<h${level}>${text.html}</h${level}>`);
        textParts.push(`\n${'#'.repeat(parseInt(level))} ${text.text}\n`);
        continue;
      }

      // Lists
      if (tagName === 'ul' || tagName === 'ol') {
        const listContent = this.extractList(child as HTMLElement);
        if (listContent.hasFormulas) flags.hasFormulas = true;
        if (listContent.hasCode) flags.hasCode = true;
        htmlParts.push(listContent.html);
        textParts.push(`\n${listContent.text}\n`);
        continue;
      }

      // Generic containers - recurse into children
      if (
        tagName === 'response-element' ||
        tagName === 'div' ||
        tagName === 'section' ||
        tagName === 'article' ||
        tagName === 'generated-image' ||
        tagName === 'single-image' ||
        child.classList.contains('horizontal-scroll-wrapper') ||
        child.classList.contains('table-block-component')
      ) {
        if (this.DEBUG)
          console.log('[DOMContentExtractor] Recursing into container:', tagName, child.className);
        // Recursively process children instead of extracting text directly
        this.processNodes(child, htmlParts, textParts, flags);
        continue;
      }

      // Default: extract text content for unknown inline elements
      const text = this.normalizeText(child.textContent || '');
      if (text) {
        // Only add text if it's not already processed by parent
        htmlParts.push(`<span>${this.escapeHtml(text)}</span>`);
        textParts.push(text);
      }
    }
  }

  /**
   * Extract YouTube video cover thumbnails as clickable cover images.
   *
   * Gemini renders a video as
   *   `.attachment-container.youtube > … > youtube-block > single-video > … > img.thumbnail`
   * plus an `<iframe>` player that can't be exported. The custom elements
   * (youtube-block / single-video / default-player) stop processNodes' generic
   * recursion, so the cover is otherwise dropped. Here we emit the cover image
   * linked to the watch URL so it survives Markdown / PDF / image exports.
   *
   * Deduped across call sites via a `processedByGV` marker on the <img>.
   * Returns true if at least one cover was emitted.
   */
  private static processYouTubeCovers(
    scope: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  ): boolean {
    const thumbs = scope.querySelectorAll<HTMLImageElement>(
      '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
    );
    const videoIdFrom = (u: string | null | undefined): string => {
      const m = (u || '').match(/(?:\/vi\/|[?&]v=|youtu\.be\/|embed\/)([\w-]{11})/);
      return m ? m[1] : '';
    };
    let emitted = false;
    for (const imgEl of Array.from(thumbs)) {
      const marked = imgEl as Element & { processedByGV?: boolean };
      if (marked.processedByGV) continue;
      let src = imgEl.src || imgEl.getAttribute('src') || '';
      if (!src || src === 'about:blank') continue;
      marked.processedByGV = true;

      const card =
        imgEl.closest('single-video, youtube-block, .attachment-container.youtube') ||
        imgEl.parentElement ||
        scope;
      let videoId = videoIdFrom(src);
      if (!videoId) {
        const ref = card.querySelector('a[href*="youtu"], iframe[src*="youtube"]') as
          | HTMLAnchorElement
          | HTMLIFrameElement
          | null;
        videoId = videoIdFrom(
          (ref as HTMLAnchorElement | null)?.href || (ref as HTMLIFrameElement | null)?.src,
        );
      }
      // Prefer a stable cover URL when we know the id and the live src isn't a ytimg URL.
      if (videoId && !/ytimg\.com|img\.youtube\.com/.test(src)) {
        src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }
      const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
      const titleRaw =
        (imgEl.alt && imgEl.alt.trim()) ||
        card.querySelector('.video-title, [class*="title"]')?.textContent?.trim() ||
        'YouTube video';
      const title = this.normalizeText(titleRaw);

      flags.hasImages = true;
      const imgHtml = `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(title)}" />`;
      htmlParts.push(
        watchUrl ? `<a href="${this.escapeHtmlAttribute(watchUrl)}">${imgHtml}</a>` : imgHtml,
      );
      const mdAlt = title.replace(/\]/g, '\\]');
      textParts.push(
        watchUrl ? `\n[![${mdAlt}](${src})](${watchUrl})\n` : `\n![${mdAlt}](${src})\n`,
      );
      emitted = true;
    }
    return emitted;
  }

  /**
   * Check if element should be skipped
   */
  private static shouldSkipElement(element: Element): boolean {
    // Skip buttons, tooltips, and action elements
    if (
      element.tagName === 'BUTTON' ||
      element.tagName === 'MAT-ICON' ||
      // Gemini inline sources/citation chips (appear as link icons in export/print)
      element.tagName === 'SOURCES-CAROUSEL-INLINE' ||
      element.tagName === 'SOURCE-INLINE-CHIPS' ||
      element.tagName === 'SOURCE-INLINE-CHIP' ||
      // Generated image overlay controls (share, copy, download buttons)
      element.tagName === 'SHARE-BUTTON' ||
      element.tagName === 'COPY-BUTTON' ||
      element.tagName === 'DOWNLOAD-GENERATED-IMAGE-BUTTON'
    ) {
      return true;
    }

    // Skip model thoughts completely (including the toggle button)
    if (element.tagName === 'MODEL-THOUGHTS' || element.classList.contains('model-thoughts')) {
      return true;
    }

    // Skip action buttons and controls
    if (
      element.classList.contains('copy-button') ||
      element.classList.contains('action-button') ||
      element.classList.contains('table-footer') ||
      element.classList.contains('export-sheets-button') ||
      element.classList.contains('thoughts-header') ||
      // Gemini inline source/citation container
      element.classList.contains('source-inline-chip-container') ||
      // NanoBanana watermark remover indicator (🍌 emoji)
      element.classList.contains('nanobanana-indicator') ||
      // Generated image overlay controls (share/copy/download buttons)
      element.classList.contains('generated-image-controls') ||
      element.classList.contains('hide-from-message-actions')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Process inline content (text with inline formulas)
   */
  private static processInlineContent(element: HTMLElement): {
    html: string;
    text: string;
    hasFormulas: boolean;
  } {
    let hasFormulas = false;
    const htmlParts: string[] = [];
    const textParts: string[] = [];

    // Process all child nodes including text nodes
    const processNode = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (text.trim()) {
          htmlParts.push(this.escapeHtml(text));
          textParts.push(text);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;

        if (this.shouldSkipElement(el)) {
          return;
        }

        // Inline formula - check both class and data-math attribute
        if (el.classList.contains('math-inline') || el.hasAttribute('data-math')) {
          const latex = el.getAttribute('data-math') || '';
          if (latex) {
            hasFormulas = true;
            // For HTML output: preserve the rendered formula HTML for PDF export
            const clonedFormula = (el as HTMLElement).cloneNode(true) as HTMLElement;
            // Ensure data-math attribute is preserved
            if (!clonedFormula.hasAttribute('data-math')) {
              clonedFormula.setAttribute('data-math', latex);
            }
            htmlParts.push(clonedFormula.outerHTML);
            // For text output: use Markdown format
            textParts.push(`$${latex}$`);
            return;
          }
        }

        // Emphasis
        if (el.tagName === 'I' || el.tagName === 'EM') {
          const text = this.normalizeText(el.textContent || '');
          htmlParts.push(`<em>${this.escapeHtml(text)}</em>`);
          textParts.push(`*${text}*`);
          return;
        }

        // Strong
        if (el.tagName === 'B' || el.tagName === 'STRONG') {
          const text = this.normalizeText(el.textContent || '');
          htmlParts.push(`<strong>${this.escapeHtml(text)}</strong>`);
          textParts.push(`**${text}**`);
          return;
        }

        // Code
        if (el.tagName === 'CODE' && !el.closest('pre')) {
          const text = this.normalizeText(el.textContent || '');
          htmlParts.push(`<code>${this.escapeHtml(text)}</code>`);
          textParts.push(`\`${text}\``);
          return;
        }

        // Inline images
        if (el.tagName === 'IMG') {
          const imgEl = el as HTMLImageElement;
          const src = imgEl.src || imgEl.getAttribute('src') || '';
          if (src && src !== 'about:blank') {
            const alt = imgEl.alt || 'Image';
            htmlParts.push(
              `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
            );
            const mdAlt = alt.replace(/\]/g, '\\]');
            textParts.push(`![${mdAlt}](${src})`);
          }
          return;
        }

        // Recurse for other elements
        Array.from(el.childNodes).forEach(processNode);
      }
    };

    Array.from(element.childNodes).forEach(processNode);

    return {
      html: htmlParts.join(''),
      text: textParts.join(''),
      hasFormulas,
    };
  }

  /**
   * Extract text with inline formulas
   */
  private static extractTextWithInlineFormulas(element: HTMLElement): {
    html: string;
    text: string;
  } {
    const processed = this.processInlineContent(element);
    return { html: processed.html, text: processed.text };
  }

  /**
   * Extract Mermaid content for rich and text exports.
   * Rendered SVG is preferred, with source HTML as a safe fallback.
   */
  private static extractMermaidContent(
    wrapper: HTMLElement,
  ): { html: string; text: string } | null {
    const renderedSvg = wrapper.querySelector<SVGSVGElement>(MERMAID_RENDERED_SVG_SELECTOR);
    const lightExportSvg = wrapper
      .querySelector<HTMLTemplateElement>(MERMAID_LIGHT_EXPORT_TEMPLATE_SELECTOR)
      ?.content.querySelector<SVGSVGElement>('svg');
    const codeBlock = wrapper.querySelector<HTMLElement>('code-block, .code-block');
    const codeContent = codeBlock
      ? this.extractCodeBlock(codeBlock, 'mermaid')
      : { html: '', text: '' };
    const renderedTheme = wrapper.getAttribute(MERMAID_THEME_ATTRIBUTE);
    const svg =
      renderedTheme === 'light' ? renderedSvg : renderedTheme === 'dark' ? lightExportSvg : null;

    if (svg) {
      const exportContainer = document.createElement('div');
      exportContainer.className = MERMAID_EXPORT_CLASS;
      exportContainer.setAttribute(MERMAID_THEME_ATTRIBUTE, 'light');
      exportContainer.appendChild(svg.cloneNode(true));
      return { html: exportContainer.outerHTML, text: codeContent.text };
    }

    return codeContent.text ? codeContent : null;
  }

  /**
   * Find top-level Mermaid and ordinary code blocks in DOM order.
   * Hidden source blocks inside Mermaid wrappers and nested code-block shells are excluded.
   */
  private static findExportCodeBlocks(container: Element): ExportCodeBlock[] {
    const selector = `${MERMAID_WRAPPER_SELECTOR}, code-block, .code-block`;
    const elements = [
      ...(container.matches(selector) ? [container as HTMLElement] : []),
      ...Array.from(container.querySelectorAll<HTMLElement>(selector)),
    ];

    return elements.flatMap((element): ExportCodeBlock[] => {
      if (element.matches(MERMAID_WRAPPER_SELECTOR)) {
        return [{ kind: 'mermaid', element }];
      }
      if (element.closest(MERMAID_WRAPPER_SELECTOR)) return [];
      if (element.parentElement?.closest('code-block, .code-block')) return [];
      return [{ kind: 'code', element }];
    });
  }

  /**
   * Extract code block content
   */
  private static extractCodeBlock(
    element: HTMLElement,
    languageOverride?: string,
  ): { html: string; text: string } {
    const codeElement = element.querySelector('code[role="text"], code');
    const code = codeElement?.textContent || '';

    // Try to detect language from class or label
    let language = languageOverride ?? '';
    const langLabel = languageOverride ? null : element.querySelector('.code-block-decoration');
    if (langLabel) {
      language = this.normalizeText(langLabel.textContent || '').toLowerCase();
    }

    return {
      html: `<pre><code class="language-${language}">${this.escapeHtml(code)}</code></pre>`,
      text: `\`\`\`${language}\n${code}\n\`\`\``,
    };
  }

  /**
   * Extract code directly from a <code> element (fallback path)
   */
  private static extractCodeFromCodeElement(codeEl: HTMLElement): { html: string; text: string } {
    const code = codeEl.textContent || '';
    // Try to infer language from class names like "language-python"
    let language = '';
    const className = (codeEl.getAttribute('class') || '').toLowerCase();
    const langMatch = className.match(/language-([a-z0-9]+)/i);
    if (langMatch) {
      language = langMatch[1];
    } else {
      // Try to find a nearby header label inside a surrounding code-block component
      const parentBlock = codeEl.closest('code-block') as HTMLElement | null;
      if (parentBlock) {
        const label = parentBlock.querySelector('.code-block-decoration');
        if (label) {
          language = this.normalizeText(label.textContent || '').toLowerCase();
        }
      }
    }
    return {
      html: `<pre><code class="language-${language}">${this.escapeHtml(code)}</code></pre>`,
      text: `\`\`\`${language}\n${code}\n\`\`\``,
    };
  }

  /**
   * Extract table content
   */
  private static extractTable(element: HTMLElement): { html: string; text: string } {
    // Accept either a container that holds a <table>, or a <table> element itself
    let table: HTMLTableElement | null = null;
    if (element.tagName && element.tagName.toLowerCase() === 'table') {
      table = element as HTMLTableElement;
    } else {
      table = element.querySelector('table') as HTMLTableElement | null;
    }
    if (!table) {
      return { html: '', text: '' };
    }

    // Extract HTML (clean version)
    const cleanTable = table.cloneNode(true) as HTMLElement;
    this.stripExportArtifacts(cleanTable);

    // Convert to Markdown
    const rows: string[][] = [];
    const headerCells = Array.from(table.querySelectorAll('thead tr td, thead tr th'));
    if (headerCells.length > 0) {
      rows.push(headerCells.map((cell) => this.normalizeText(cell.textContent || '')));
    }

    const bodyRows = table.querySelectorAll('tbody tr');
    bodyRows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td, th'));
      rows.push(cells.map((cell) => this.normalizeText(cell.textContent || '')));
    });

    // Build Markdown table
    const markdownLines: string[] = [];
    if (rows.length > 0) {
      // Header
      markdownLines.push('| ' + rows[0].join(' | ') + ' |');
      markdownLines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
      // Body
      for (let i = 1; i < rows.length; i++) {
        markdownLines.push('| ' + rows[i].join(' | ') + ' |');
      }
    } else {
      // Fallback: treat first tbody row as header if no thead present
      const firstBodyRow = table.querySelector('tbody tr');
      if (firstBodyRow) {
        const header = Array.from(firstBodyRow.querySelectorAll('td, th')).map((cell) =>
          this.normalizeText(cell.textContent || ''),
        );
        if (header.length > 0) {
          markdownLines.push('| ' + header.join(' | ') + ' |');
          markdownLines.push('| ' + header.map(() => '---').join(' | ') + ' |');
          const rest = Array.from(table.querySelectorAll('tbody tr')).slice(1);
          rest.forEach((row) => {
            const cells = Array.from(row.querySelectorAll('td, th')).map((cell) =>
              this.normalizeText(cell.textContent || ''),
            );
            markdownLines.push('| ' + cells.join(' | ') + ' |');
          });
        }
      }
    }

    return {
      html: cleanTable.outerHTML,
      text: markdownLines.join('\n'),
    };
  }

  /**
   * Extract list content with support for nested lists
   */
  private static extractList(
    element: HTMLElement,
    depth: number = 0,
  ): { html: string; text: string; hasFormulas: boolean; hasCode: boolean } {
    const isOrdered = element.tagName === 'OL';
    const items = Array.from(element.querySelectorAll(':scope > li'));
    const indent = '  '.repeat(depth); // 2 spaces per level

    const textLines: string[] = [];
    let hasFormulas = false;
    let hasCode = false;
    items.forEach((item, index) => {
      const prefix = isOrdered ? `${index + 1}. ` : '- ';
      const continuationIndent = indent + ' '.repeat(prefix.length);
      let hasItemContent = false;
      let proseNodes: Node[] = [];

      const ensureItemMarker = (): void => {
        if (!hasItemContent) {
          textLines.push(indent + prefix.trimEnd());
          hasItemContent = true;
        }
      };

      const flushProse = (): void => {
        if (proseNodes.length === 0) return;

        const proseContainer = document.createElement('div');
        proseNodes.forEach((node) => proseContainer.appendChild(node.cloneNode(true)));
        proseNodes = [];

        const processed = this.processInlineContent(proseContainer);
        if (processed.hasFormulas) hasFormulas = true;
        const prose = this.normalizeText(processed.text || proseContainer.textContent || '');
        if (!prose) return;

        textLines.push((hasItemContent ? continuationIndent : indent + prefix) + prose);
        hasItemContent = true;
      };

      const processItemNodes = (nodes: Node[]): void => {
        nodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            proseNodes.push(node);
            return;
          }

          const child = node as HTMLElement;
          if (child.tagName === 'UL' || child.tagName === 'OL') {
            flushProse();
            const nestedResult = this.extractList(child, depth + 1);
            if (nestedResult.hasFormulas) hasFormulas = true;
            if (nestedResult.hasCode) hasCode = true;
            if (nestedResult.text) {
              ensureItemMarker();
              textLines.push(nestedResult.text);
            }
            return;
          }

          const exportCodeBlocks = this.findExportCodeBlocks(child);
          const directExportCodeBlock = exportCodeBlocks.find(({ element }) => element === child);
          if (directExportCodeBlock) {
            flushProse();
            const content =
              directExportCodeBlock.kind === 'mermaid'
                ? this.extractMermaidContent(directExportCodeBlock.element)
                : this.extractCodeBlock(directExportCodeBlock.element);
            if (!content?.text) return;

            ensureItemMarker();
            hasCode = true;
            textLines.push(
              content.text
                .split('\n')
                .map((line) => continuationIndent + line)
                .join('\n'),
            );
            return;
          }

          if (exportCodeBlocks.length > 0 || child.querySelector('ul, ol')) {
            flushProse();
            processItemNodes(Array.from(child.childNodes));
            return;
          }

          proseNodes.push(node);
        });
      };

      processItemNodes(Array.from(item.childNodes));

      flushProse();
      if (!hasItemContent) {
        textLines.push(indent + prefix);
      }
    });

    const cleanList = element.cloneNode(true) as HTMLElement;
    this.stripExportArtifacts(cleanList);
    cleanList.querySelectorAll<HTMLElement>(MERMAID_WRAPPER_SELECTOR).forEach((wrapper) => {
      const content = this.extractMermaidContent(wrapper);
      if (!content) return;

      const replacement = document.createElement('div');
      replacement.innerHTML = content.html;
      if (replacement.firstElementChild) {
        wrapper.replaceWith(replacement.firstElementChild);
      }
    });
    cleanList.querySelectorAll<HTMLElement>('code-block, .code-block').forEach((codeBlock) => {
      if (codeBlock.closest(MERMAID_WRAPPER_SELECTOR)) return;
      if (codeBlock.parentElement?.closest('code-block, .code-block')) return;

      const content = this.extractCodeBlock(codeBlock);
      const replacement = document.createElement('div');
      replacement.innerHTML = content.html;
      if (replacement.firstElementChild) {
        codeBlock.replaceWith(replacement.firstElementChild);
      }
    });

    return {
      hasFormulas,
      hasCode,
      html: cleanList.outerHTML,
      text: textLines.join('\n'),
    };
  }

  /**
   * Strip non-content UI artifacts from exported HTML fragments.
   * Best-effort: safe to call multiple times.
   */
  private static stripExportArtifacts(root: HTMLElement): void {
    const selector = [
      'button',
      'mat-icon',
      'model-thoughts',
      'sources-carousel-inline',
      'source-inline-chips',
      'source-inline-chip',
      'share-button',
      'copy-button',
      'download-generated-image-button',
      '.model-thoughts',
      '.copy-button',
      '.action-button',
      '.table-footer',
      '.export-sheets-button',
      '.thoughts-header',
      '.source-inline-chip-container',
      '.nanobanana-indicator',
      '.generated-image-controls',
      '.hide-from-message-actions',
    ].join(',');

    root.querySelectorAll(selector).forEach((el) => el.remove());
  }

  /**
   * Normalize whitespace in text
   */
  private static normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Escape HTML special characters
   */
  private static escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape HTML for attribute context.
   */
  private static escapeHtmlAttribute(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&#39;');
  }
}
