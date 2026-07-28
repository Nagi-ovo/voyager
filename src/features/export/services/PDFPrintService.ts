/**
 * PDF Print Service
 * Implements elegant "paper book" style PDF export using browser's print function
 * Philosophy: Content over design, readability over fidelity
 */
import { isSafari } from '@/core/utils/browser';

import type { ChatTurn, ConversationMetadata } from '../types/export';
import { DOMContentExtractor } from './DOMContentExtractor';
import { buildKatexExportStyles } from './katexExportStyles';
import { buildMermaidExportStyles } from './mermaidExportStyles';
import { isolateMermaidSvgImages, rasterizeMermaidSvgImages } from './mermaidSvgImage';

export interface PrintableDocumentContent {
  title: string;
  url: string;
  exportedAt: string;
  markdown: string;
  html: string;
}

/**
 * PDF print service using browser's native print dialog
 * Injects optimized styles for paper-friendly output
 */
export class PDFPrintService {
  private static PRINT_STYLES_ID = 'gv-pdf-print-styles';
  private static PRINT_CONTAINER_ID = 'gv-pdf-print-container';
  private static PRINT_BODY_CLASS = 'gv-pdf-printing';
  private static CLEANUP_FALLBACK_DELAY_MS = 60_000;
  private static INLINE_FETCH_TIMEOUT_MS = 2_000;
  private static INLINE_DECODE_TIMEOUT_MS = 1_000;
  private static cleanupFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private static originalDocumentTitle: string | null = null;

  /**
   * Export conversation as PDF using browser print
   */
  static async export(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options?: { fontSize?: number },
  ): Promise<void> {
    await this.exportInternal(turns, metadata, false, options?.fontSize);
  }

  static async exportDocument(content: PrintableDocumentContent): Promise<void> {
    const metadata: ConversationMetadata = {
      url: content.url,
      exportedAt: content.exportedAt,
      count: 1,
      title: content.title,
    };

    const htmlContainer = document.createElement('div');
    htmlContainer.innerHTML = content.html.trim();
    const fallbackFromHtml = this.extractPlainTextFromHtml(content.html);
    const assistant = fallbackFromHtml || content.markdown.trim() || 'No content';
    const turns: ChatTurn[] = [
      {
        user: '',
        assistant,
        starred: false,
        omitEmptySections: true,
        assistantElement: htmlContainer,
      },
    ];

    await this.exportInternal(turns, metadata, true);
  }

  private static async exportInternal(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    preferMetadataTitle: boolean,
    fontSize?: number,
  ): Promise<void> {
    // Ensure we don't leave a previous export container around (e.g. if a prior export failed)
    this.cleanup();

    const safari = isSafari();

    // Create print container
    const container = this.createPrintContainer(turns, metadata, preferMetadataTitle);
    if (safari) {
      isolateMermaidSvgImages(container);
    } else {
      await rasterizeMermaidSvgImages(container);
    }
    document.body.appendChild(container);

    // Remove existing print styles so we can re-inject with new font size
    const existingStyles = document.getElementById(this.PRINT_STYLES_ID);
    if (existingStyles) existingStyles.remove();

    // Inject print styles
    this.injectPrintStyles(fontSize);
    document.body.classList.add(this.PRINT_BODY_CLASS);

    // Keep print header/footer title aligned with conversation title in print dialog output.
    this.originalDocumentTitle = document.title;
    const printDialogTitle = this.getPrintDialogTitle(metadata, preferMetadataTitle);
    if (printDialogTitle) {
      document.title = printDialogTitle;
    }

    // Inline images as data URLs (best-effort) to avoid auth-bound links failing in print.
    // Safari is very strict about `window.print()` being called with a user gesture; awaiting here
    // may cause the print dialog to be blocked. So on Safari we do not await.
    const inlineImagesPromise = this.inlineImages(container).catch(() => {
      /* ignore */
    });

    if (safari) {
      this.forceStyleFlush(container);
      this.triggerPrint();
      this.registerCleanupHandlers();
      void inlineImagesPromise;
      return;
    }

    await inlineImagesPromise;
    await this.delay(100);
    this.triggerPrint();
    this.registerCleanupHandlers();
  }

  private static triggerPrint(): void {
    try {
      window.print();
    } catch {
      // Ignore: some environments (tests/iframes) may not support printing
    }
  }

  private static forceStyleFlush(container: HTMLElement): void {
    try {
      // Force a synchronous style/layout flush so the print-only DOM is "real" before printing.
      // (Helps on Safari/WebKit where style application can lag behind DOM insertion.)
      container.getBoundingClientRect();
    } catch {
      /* ignore */
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeoutUnref(resolve, ms);
    });
  }

  private static registerCleanupHandlers(): void {
    // Prefer afterprint (reliable when supported); keep a fallback timer in case it never fires.
    const cleanupNow = (): void => {
      this.cleanup();
    };

    try {
      window.addEventListener('afterprint', cleanupNow, { once: true });
    } catch {
      /* ignore */
    }

    if (this.cleanupFallbackTimer !== null) {
      clearTimeout(this.cleanupFallbackTimer);
    }
    this.cleanupFallbackTimer = this.setTimeoutUnref(() => {
      this.cleanup();
    }, this.CLEANUP_FALLBACK_DELAY_MS);
  }

  private static setTimeoutUnref(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, ms);
    // Node.js timers support unref(), which avoids keeping the process alive in tests.
    if (
      typeof handle === 'object' &&
      handle !== null &&
      'unref' in handle &&
      typeof (handle as { unref?: unknown }).unref === 'function'
    ) {
      (handle as { unref: () => void }).unref();
    }
    return handle;
  }

  /**
   * Create HTML container for printing
   */
  private static createPrintContainer(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    preferMetadataTitle: boolean,
  ): HTMLElement {
    const container = document.createElement('div');
    container.id = this.PRINT_CONTAINER_ID;
    container.className = 'gv-print-only';

    // Build HTML content
    container.innerHTML = `
      <div class="gv-print-document">
        ${this.renderHeader(metadata, preferMetadataTitle)}
        ${this.renderContent(turns)}
        ${this.renderFooter(metadata)}
      </div>
    `;
    return container;
  }

  private static extractPlainTextFromHtml(html: string): string {
    const trimmed = html.trim();
    if (!trimmed) return '';
    const container = document.createElement('div');
    container.innerHTML = trimmed;
    container.querySelectorAll('script, style, template').forEach((element) => element.remove());
    return this.normalizeWhitespace(container.textContent || '');
  }

  private static normalizeWhitespace(text: string): string {
    return text
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Convert <img src> links in container to data URLs (best-effort)
   */
  private static async inlineImages(container: HTMLElement): Promise<void> {
    const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    if (imgs.length === 0) return;
    const toDataUrl = async (url: string): Promise<string | null> => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutHandle = this.setTimeoutUnref(() => {
        try {
          controller?.abort();
        } catch {
          /* ignore */
        }
      }, this.INLINE_FETCH_TIMEOUT_MS);

      try {
        const init: RequestInit = { credentials: 'include', mode: 'cors' as RequestMode };
        if (controller) init.signal = controller.signal;

        const resp = await fetch(url, init);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        const data = await new Promise<string>((resolve, reject) => {
          try {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('readAsDataURL failed'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(blob);
          } catch (e) {
            reject(e);
          }
        });
        return data;
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    await Promise.all(
      imgs.map(async (img) => {
        let src = img.getAttribute('src') || '';
        // Handle both http(s) and blob: URLs (watermark-removed images use blob: URLs)
        if (!/^(https?:\/\/|blob:)/i.test(src)) return;
        // For Google images, request original size (=s0) instead of thumbnail
        if (
          (src.includes('googleusercontent.com') || src.includes('ggpht.com')) &&
          !src.startsWith('blob:')
        ) {
          const sizePattern = /=[swh]\d+[^?#]*/;
          src = sizePattern.test(src) ? src.replace(sizePattern, '=s0') : src + '=s0';
        }
        const data = await toDataUrl(src);
        if (data) {
          try {
            img.src = data;
          } catch {}
        }
      }),
    );

    // Attempt to wait for image decoding
    type DecodableImage = HTMLImageElement & { decode?: () => Promise<void> };
    await Promise.all(
      imgs.map(async (img) => {
        const decode = (img as DecodableImage).decode;
        if (typeof decode !== 'function') return;

        try {
          await Promise.race([
            decode.call(img).catch(() => {
              /* ignore */
            }),
            this.delay(this.INLINE_DECODE_TIMEOUT_MS),
          ]);
        } catch {
          /* ignore */
        }
      }),
    );
  }

  /**
   * Get conversation title from page
   */
  private static getConversationTitle(): string {
    // Strategy 1: Get from active conversation in Gemini Voyager Folder UI (most accurate)
    try {
      // Prefer the folder row that is marked as selected for the current conversation
      const activeFolderTitle =
        document.querySelector(
          '.gv-folder-conversation.gv-folder-conversation-selected .gv-conversation-title',
        ) || document.querySelector('.gv-folder-conversation-selected .gv-conversation-title');

      if (activeFolderTitle?.textContent?.trim()) {
        return activeFolderTitle.textContent.trim();
      }
    } catch (error) {
      console.debug('[PDF Export] Failed to get title from Folder Manager:', error);
    }

    // Strategy 1b: Get from Gemini native sidebar via current conversation ID
    try {
      const conversationId = this.extractConversationIdFromURL(window.location.href);
      if (conversationId) {
        const byId = this.extractTitleFromNativeSidebarByConversationId(conversationId);
        if (byId) return byId;
      }
    } catch (error) {
      console.debug('[PDF Export] Failed to get title from native sidebar by id:', error);
    }

    // Strategy 2: Try to get from page title
    const titleElement = document.querySelector('title');
    if (titleElement) {
      const title = titleElement.textContent?.trim();
      if (this.isMeaningfulConversationTitle(title)) {
        return title;
      }
    }

    // Strategy 3: Try to get from sidebar conversation list
    try {
      const selectors = [
        'mat-list-item.mdc-list-item--activated [mat-line]',
        'mat-list-item[aria-current="page"] [mat-line]',
        '.conversation-list-item.active .conversation-title',
        '.active-conversation .title',
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const title = element?.textContent?.trim();
        if (this.isMeaningfulConversationTitle(title)) {
          return title;
        }
      }
    } catch (error) {
      console.debug('[PDF Export] Failed to get title from sidebar:', error);
    }

    // Strategy 4: URL fallback
    const conversationId = this.extractConversationIdFromURL(window.location.href);
    if (conversationId) {
      return `Conversation ${conversationId.slice(0, 8)}`;
    }

    return 'Untitled Conversation';
  }

  private static isMeaningfulConversationTitle(title: string | null | undefined): title is string {
    const t = (title || '').trim();
    if (!t) return false;
    if (
      t === 'Untitled Conversation' ||
      t === 'Gemini' ||
      t === 'Google Gemini' ||
      t === 'Google AI Studio' ||
      t === 'New chat'
    ) {
      return false;
    }
    if (t.startsWith('Gemini -') || t.startsWith('Google AI Studio -')) return false;
    return true;
  }

  private static isGemLabel(text: string | null | undefined): boolean {
    const t = (text || '').trim().toLowerCase();
    return t === 'gem' || t === 'gems';
  }

  private static extractConversationIdFromURL(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const appMatch = urlObj.pathname.match(/\/app\/([^/?#]+)/);
      if (appMatch?.[1]) return appMatch[1];
      const gemMatch = urlObj.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
      if (gemMatch?.[1]) return gemMatch[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  private static extractTitleFromLinkText(link?: HTMLAnchorElement | null): string | null {
    if (!link) return null;
    const text = (link.innerText || '').trim();
    if (!text) return null;
    const parts = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !this.isGemLabel(s))
      .filter((s) => s.length >= 2);
    if (parts.length === 0) return null;
    return parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]) || null;
  }

  private static extractTitleFromConversationElement(conversationEl: HTMLElement): string | null {
    const scope =
      (conversationEl.closest('[data-test-id="conversation"]') as HTMLElement) || conversationEl;
    const bySelector = scope.querySelector(
      '.gds-label-l, .conversation-title-text, [data-test-id="conversation-title"], h3',
    );
    const selectorTitle = bySelector?.textContent?.trim();
    if (this.isMeaningfulConversationTitle(selectorTitle) && !this.isGemLabel(selectorTitle)) {
      return selectorTitle;
    }

    const link = scope.querySelector(
      'a[href*="/app/"], a[href*="/gem/"]',
    ) as HTMLAnchorElement | null;
    const ariaTitle = link?.getAttribute('aria-label')?.trim();
    if (this.isMeaningfulConversationTitle(ariaTitle) && !this.isGemLabel(ariaTitle)) {
      return ariaTitle;
    }
    const linkTitle = link?.getAttribute('title')?.trim();
    if (this.isMeaningfulConversationTitle(linkTitle) && !this.isGemLabel(linkTitle)) {
      return linkTitle;
    }
    const fromLinkText = this.extractTitleFromLinkText(link);
    if (this.isMeaningfulConversationTitle(fromLinkText)) {
      return fromLinkText;
    }

    const label = scope.querySelector('.gds-body-m, .gds-label-m, .subtitle');
    const labelText = label?.textContent?.trim();
    if (this.isMeaningfulConversationTitle(labelText) && !this.isGemLabel(labelText)) {
      return labelText;
    }

    const raw = scope.textContent?.trim() || '';
    if (!raw) return null;
    const firstLine =
      raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)[0] || raw;
    if (this.isMeaningfulConversationTitle(firstLine) && !this.isGemLabel(firstLine)) {
      return firstLine.slice(0, 80);
    }

    return null;
  }

  private static extractTitleFromNativeSidebarByConversationId(
    conversationId: string,
  ): string | null {
    const escapedConversationId = this.escapeCssAttributeValue(conversationId);
    const byJslog = document.querySelector(
      `[data-test-id="conversation"][jslog*="c_${escapedConversationId}"]`,
    ) as HTMLElement | null;
    if (byJslog) {
      const title = this.extractTitleFromConversationElement(byJslog);
      if (title) return title;
    }

    const byHrefLink = document.querySelector(
      `[data-test-id="conversation"] a[href*="${escapedConversationId}"]`,
    ) as HTMLElement | null;
    if (byHrefLink) {
      const title = this.extractTitleFromConversationElement(byHrefLink);
      if (title) return title;
    }

    return null;
  }

  /**
   * Render document header with cover page
   */
  private static renderHeader(
    metadata: ConversationMetadata,
    preferMetadataTitle: boolean,
  ): string {
    const metadataTitle = this.normalizeConversationTitle(metadata.title);
    const pageConversationTitle = this.normalizeConversationTitle(this.getConversationTitle());
    const conversationTitle = preferMetadataTitle
      ? metadataTitle || pageConversationTitle || 'Untitled Conversation'
      : pageConversationTitle || metadataTitle || 'Untitled Conversation';
    // For PDF, avoid repeating the same title in smaller text under the H1.
    // Always derive a neutral "source" label from the URL instead of using metadata.title.
    const urlTitle = this.extractTitleFromURL(metadata.url);
    const date = this.formatDate(metadata.exportedAt);
    const turnsCount = metadata.count;

    return `
      <div class="gv-print-header gv-print-cover-page">
        <div class="gv-print-cover-content">
          <h1 class="gv-print-cover-title">${this.escapeHTML(conversationTitle)}</h1>
          <div class="gv-print-meta">
            <p>${date}</p>
            <p><a href="${this.escapeAttribute(metadata.url)}">${this.escapeHTML(urlTitle)}</a></p>
            <p>${turnsCount} conversation turns</p>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render conversation content
   */
  private static renderContent(turns: ChatTurn[]): string {
    return `
      <div class="gv-print-content">
        ${turns.map((turn, index) => this.renderTurn(turn, index + 1)).join('\n')}
      </div>
    `;
  }

  /**
   * Render a single turn
   */
  private static renderTurn(turn: ChatTurn, index: number): string {
    const starredClass = turn.starred ? 'gv-print-turn-starred' : '';

    const userContent = turn.userElement
      ? DOMContentExtractor.extractUserContent(turn.userElement).html || '<em>No content</em>'
      : this.formatContent(turn.user) || '<em>No content</em>';

    const assistantContent = turn.assistantElement
      ? DOMContentExtractor.extractAssistantContent(turn.assistantElement).html ||
        '<em>No content</em>'
      : this.formatContent(turn.assistant) || '<em>No content</em>';

    if (!turn.omitEmptySections) {
      return `
      <div class="gv-print-turn ${starredClass}">
        <div class="gv-print-turn-header">
          <span class="gv-print-turn-number">Turn ${index}</span>
          ${turn.starred ? '<span class="gv-print-star">⭐</span>' : ''}
        </div>

        <div class="gv-print-turn-user">
          <div class="gv-print-turn-label">👤 User</div>
          <div class="gv-print-turn-text">${userContent}</div>
        </div>

        <div class="gv-print-turn-assistant">
          <div class="gv-print-turn-label">🤖 Assistant</div>
          <div class="gv-print-turn-text">${assistantContent}</div>
        </div>
      </div>
    `;
    }

    const hasUser = !!turn.userElement || !!turn.user.trim();
    const hasAssistant = !!turn.assistantElement || !!turn.assistant.trim();

    return `
      <div class="gv-print-turn ${starredClass}">
        <div class="gv-print-turn-header">
          <span class="gv-print-turn-number">Turn ${index}</span>
          ${turn.starred ? '<span class="gv-print-star">⭐</span>' : ''}
        </div>

        ${
          hasUser
            ? `
        <div class="gv-print-turn-user">
          <div class="gv-print-turn-label">👤 User</div>
          <div class="gv-print-turn-text">${userContent}</div>
        </div>
        `
            : ''
        }

        ${
          hasAssistant
            ? `
          <div class="gv-print-turn-assistant">
            <div class="gv-print-turn-label">🤖 Assistant</div>
            <div class="gv-print-turn-text">${assistantContent}</div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  /**
   * Format content for HTML output
   */
  private static formatContent(content: string): string {
    if (!content) return '<em>No content</em>';

    // Escape HTML but preserve line breaks
    let formatted = this.escapeHTML(content);

    // Convert double line breaks to paragraphs
    formatted = formatted
      .split('\n\n')
      .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('');

    return formatted;
  }

  /**
   * Render footer
   */
  private static renderFooter(metadata: ConversationMetadata): string {
    return `
      <div class="gv-print-footer">
        <p>Exported from <a href="https://github.com/Nagi-ovo/voyager">Voyager</a> • ${metadata.count} conversation turns</p>
        <p>Generated on ${this.formatDate(metadata.exportedAt)}</p>
      </div>
    `;
  }

  /**
   * Inject print-optimized styles
   */
  private static injectPrintStyles(fontSize?: number): void {
    // Check if already injected
    if (document.getElementById(this.PRINT_STYLES_ID)) return;

    const basePt = fontSize ?? 11;
    const codePt = Math.max(basePt - 2, 6);
    const footerPt = Math.max(basePt - 2, 6);

    const style = document.createElement('style');
    style.id = this.PRINT_STYLES_ID;
    style.textContent = `
      /* Hide print container on screen */
      .gv-print-only {
        display: none;
      }

      /* Show print container when printing */
      @media print {
        /* Hide everything except print container */
        body.${this.PRINT_BODY_CLASS} > *:not(#${this.PRINT_CONTAINER_ID}) {
          display: none !important;
          visibility: hidden !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} {
          display: block !important;
          visibility: visible !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID},
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} * {
          visibility: visible !important;
        }

        /* Force white print canvas to avoid dark-theme background leaks on trailing pages */
        html,
        body {
          background: #fff !important;
        }

        body.${this.PRINT_BODY_CLASS} {
          background: #fff !important;
        }

        /* Gemini immersive-mode print CSS may force descendants to display:none */
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} * {
          display: revert !important;
        }

        ${buildKatexExportStyles(`body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID}`, true)}

        /* Preserve KaTeX layout primitives after the global display override above.
           Without these, sub/sup scripts (e.g. x_1) may become misaligned in PDF print. */
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex-display,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex-display > .katex,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex-display > .katex > .katex-html {
          display: block !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .base,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .strut,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist > span > span,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .mspace,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .mfrac .frac-line,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .rule,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .hline,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .hdashline,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .overline .overline-line,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .underline .underline-line,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .nulldelimiter,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .clap > .fix,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .llap > .fix,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .rlap > .fix,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .mtable .vertical-separator,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .mtable .arraycolsep,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .cd-vert-arrow,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .cd-label-left,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .cd-label-right {
          display: inline-block !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist-t {
          display: inline-table !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist-r {
          display: table-row !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist-s {
          display: table-cell !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vlist > span,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .katex-html > .newline,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .overlay,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex svg,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .stretchy {
          display: block !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .vbox,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .hbox,
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .katex .thinbox {
          display: inline-flex !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .gv-print-turn-text .katex {
          line-height: 1.2 !important;
        }

        /* Keep key layouts after the global descendant display override above */
        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .gv-print-cover-page {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .gv-print-turn-header {
          display: flex !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .gv-print-turn-text img {
          display: block !important;
        }

        /* Reset page styles */
        @page {
          margin: 2cm;
          size: A4;
        }

        /* Document container */
        .gv-print-document {
          font-family: Georgia, 'Times New Roman', serif;
          font-size: ${basePt}pt;
          line-height: 1.6;
          color: #000;
          background: #fff;
          max-width: 100%;
        }

        /* Cover Page Header */
        .gv-print-cover-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          page-break-after: always;
          margin: 0;
          padding: 0;
          border: none;
        }

        .gv-print-cover-content {
          text-align: center;
          max-width: 80%;
        }

        .gv-print-cover-title {
          font-size: 36pt;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin: 0 0 1.5em 0;
          color: oklch(0.7227 0.1920 149.5793);
          line-height: 1.2;
          word-wrap: break-word;
        }

        .gv-print-meta {
          font-size: 12pt;
          color: #666;
          line-height: 2;
          margin-top: 0.5em;
        }

        .gv-print-meta p {
          margin: 0.3em 0;
        }

        .gv-print-meta a {
          color: #666;
          text-decoration: none;
        }

        .gv-print-meta a:after {
          content: none !important;
        }

        /* Content */
        .gv-print-content {
          margin: 2em 0;
        }

        /* Turn */
        .gv-print-turn {
          margin-bottom: 2em;
          page-break-inside: avoid;
        }

        .gv-print-turn-header {
          display: flex;
          align-items: center;
          gap: 0.5em;
          margin-bottom: 0.5em;
          font-size: 12pt;
          font-weight: bold;
          color: #555;
        }

        .gv-print-turn-starred .gv-print-turn-header {
          color: #d97706;
        }

        .gv-print-star {
          font-size: 14pt;
        }

        /* Turn sections */
        .gv-print-turn-user,
        .gv-print-turn-assistant {
          margin: 1em 0;
        }

        .gv-print-turn-label {
          font-weight: 600;
          font-size: ${basePt}pt;
          margin-bottom: 0.5em;
          color: #222;
        }

        .gv-print-turn-text {
          padding-left: 1em;
          border-left: 3px solid #e5e7eb;
          color: #1a1a1a;
        }

        /* Constrain images to avoid oversized visuals */
        .gv-print-turn-text img {
          max-width: 60%;
          height: auto;
          display: block;
          margin: 0.5em 0;
          page-break-inside: avoid;
        }

        .gv-print-turn-text .gv-export-attachment {
          display: flex;
          align-items: center;
          gap: 0.55em;
          width: fit-content;
          max-width: 100%;
          margin: 0.5em 0;
          padding: 0.55em 0.75em;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          background: #f8fafc;
          page-break-inside: avoid;
        }

        .gv-print-turn-text .gv-export-attachment-icon {
          flex: none;
        }

        .gv-print-turn-text .gv-export-attachment-name {
          overflow-wrap: anywhere;
        }

        ${buildMermaidExportStyles('.gv-print-turn-text', {
          containerMargin: '1em auto',
          avoidContainerBreak: true,
          diagramSelector: '> img',
          importantDisplay: true,
          preservePrintBackground: true,
          diagramMaxHeight: '160mm',
        })}

        .gv-print-turn-assistant .gv-print-turn-text {
          border-left-color: #93c5fd;
        }

        .gv-print-turn-text p {
          margin: 0.5em 0;
        }

        .gv-print-turn-text em {
          color: #666;
        }

        /* Code blocks (if any) */
        .gv-print-turn-text code,
        .gv-print-turn-text pre {
          font-family: 'Courier New', monospace;
          font-size: ${codePt}pt;
          background: #f5f5f5;
          padding: 0.2em 0.4em;
          border-radius: 3px;
        }

        .gv-print-turn-text pre {
          padding: 0.75em;
          border-left: 3px solid #d1d5db;
          overflow-x: auto;
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        /* Math formulas */
        .gv-print-turn-text .math-inline,
        .gv-print-turn-text .math-block,
        .gv-print-turn-text [data-math] {
          page-break-inside: avoid;
        }

        .gv-print-turn-text .math-block {
          display: block;
          margin: 1em 0;
          text-align: center;
          overflow-x: auto;
        }

        .gv-print-turn-text .math-inline {
          display: inline;
        }

        /* Footer */
        .gv-print-footer {
          margin-top: 2em;
          padding-top: 1em;
          border-top: 1px solid #ccc;
          font-size: ${footerPt}pt;
          color: #666;
          text-align: center;
        }

        .gv-print-footer p {
          margin: 0.25em 0;
        }

        /* Links */
        a {
          color: #2563eb;
          text-decoration: none;
        }

        /* Hide Gemini inline source/citation chips (render as link icons) */
        sources-carousel-inline,
        source-inline-chips,
        source-inline-chip,
        .source-inline-chip-container {
          display: none !important;
        }

        a[href]:after {
          content: " (" attr(href) ")";
          font-size: ${footerPt}pt;
          color: #666;
        }

        /* Utilities */
        strong {
          font-weight: 600;
        }
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Cleanup print container and styles
   */
  private static cleanup(): void {
    if (this.cleanupFallbackTimer !== null) {
      try {
        clearTimeout(this.cleanupFallbackTimer);
      } catch {
        /* ignore */
      }
      this.cleanupFallbackTimer = null;
    }

    const container = document.getElementById(this.PRINT_CONTAINER_ID);
    if (container) {
      container.remove();
    }

    try {
      document.body.classList.remove(this.PRINT_BODY_CLASS);
    } catch {
      /* ignore */
    }

    if (this.originalDocumentTitle !== null) {
      try {
        document.title = this.originalDocumentTitle;
      } catch {
        /* ignore */
      }
      this.originalDocumentTitle = null;
    }

    // Keep styles for potential reuse
    // They don't affect screen display anyway

    // Notify other UI components (export button, folder manager) that printing ended.
    // Gemini may re-render parts of the DOM during print, removing plugin-injected elements.
    // This event gives them a chance to detect the loss and re-inject.
    try {
      window.dispatchEvent(new CustomEvent('gv-print-cleanup'));
    } catch {
      /* ignore */
    }
  }

  /**
   * Helper: Extract title from URL
   */
  private static extractTitleFromURL(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const match = pathname.match(/\/(app|chat)\/([^/]+)/);
      if (match) {
        const id = match[2];
        return `Gemini Conversation ${id.substring(0, 8)}`;
      }
      return 'Gemini Conversation';
    } catch {
      return 'Gemini Conversation';
    }
  }

  /**
   * Helper: Format date
   */
  private static formatDate(isoString: string): string {
    try {
      const date = new Date(isoString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  }

  private static normalizeConversationTitle(rawTitle: string | undefined): string {
    if (!rawTitle) return '';
    const normalized = rawTitle
      .trim()
      .replace(/\s+-\s+Gemini$/i, '')
      .replace(/\s+-\s+Google Gemini$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return this.isMeaningfulConversationTitle(normalized) ? normalized : '';
  }

  private static getPrintDialogTitle(
    metadata: ConversationMetadata,
    preferMetadataTitle: boolean,
  ): string {
    const metadataTitle = this.normalizeConversationTitle(metadata.title);
    const conversationTitle = this.normalizeConversationTitle(this.getConversationTitle());

    if (preferMetadataTitle) {
      return metadataTitle || conversationTitle || 'Gemini Conversation';
    }

    const base = conversationTitle || metadataTitle;
    if (!base) return 'Gemini Conversation';
    return `${base} - Gemini`;
  }

  /**
   * Helper: Escape HTML
   */
  private static escapeHTML(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private static escapeCssAttributeValue(value: string): string {
    const escape = globalThis.CSS?.escape;
    if (typeof escape === 'function') {
      return escape(value);
    }
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private static escapeAttribute(text: string): string {
    return this.escapeHTML(text).replace(/"/g, '&quot;');
  }
}
