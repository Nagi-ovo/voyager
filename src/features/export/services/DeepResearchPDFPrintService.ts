import { isSafari } from '@/core/utils/browser';

import type { PrintableDocumentContent } from './PDFPrintService';
import { buildKatexExportStyles } from './katexExportStyles';
import { buildMermaidExportStyles } from './mermaidExportStyles';
import { isolateMermaidSvgImages } from './mermaidSvgImage';

/**
 * Dedicated PDF print path for Deep Research reports.
 * Keeps report printing isolated from the regular conversation PDF flow.
 */
export class DeepResearchPDFPrintService {
  private static PRINT_STYLES_ID = 'gv-deep-research-pdf-print-styles';
  private static PRINT_CONTAINER_ID = 'gv-deep-research-pdf-print-container';
  private static PRINT_BODY_CLASS = 'gv-deep-research-pdf-printing';
  private static PRINT_SAFARI_BODY_CLASS = 'gv-deep-research-pdf-safari-printing';
  private static CLEANUP_FALLBACK_DELAY_MS = 60_000;
  private static INLINE_FETCH_TIMEOUT_MS = 2_000;
  private static INLINE_DECODE_TIMEOUT_MS = 1_000;
  private static cleanupFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private static originalDocumentTitle: string | null = null;

  static async export(
    content: PrintableDocumentContent,
    options?: { fontSize?: number },
  ): Promise<void> {
    this.cleanup();

    const container = this.createPrintContainer(content);
    document.body.appendChild(container);
    this.injectPrintStyles(options?.fontSize);
    document.body.classList.add(this.PRINT_BODY_CLASS);

    this.originalDocumentTitle = document.title;
    const title = this.normalizeTitle(content.title) || 'Deep Research Report';
    document.title = title;

    const safari = isSafari();
    const inlineImagesPromise = this.inlineImages(container).catch(() => {
      /* ignore */
    });

    if (safari) {
      document.body.classList.add(this.PRINT_SAFARI_BODY_CLASS);
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
      /* ignore */
    }
  }

  private static forceStyleFlush(container: HTMLElement): void {
    try {
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

  private static setTimeoutUnref(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, ms);
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

  private static registerCleanupHandlers(): void {
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

  private static cleanup(): void {
    if (this.cleanupFallbackTimer !== null) {
      clearTimeout(this.cleanupFallbackTimer);
      this.cleanupFallbackTimer = null;
    }

    try {
      document.body.classList.remove(this.PRINT_BODY_CLASS);
      document.body.classList.remove(this.PRINT_SAFARI_BODY_CLASS);
    } catch {
      /* ignore */
    }

    const container = document.getElementById(this.PRINT_CONTAINER_ID);
    if (container) {
      container.remove();
    }

    const style = document.getElementById(this.PRINT_STYLES_ID);
    if (style) {
      style.remove();
    }

    if (this.originalDocumentTitle !== null) {
      try {
        document.title = this.originalDocumentTitle;
      } catch {
        /* ignore */
      }
      this.originalDocumentTitle = null;
    }

    // Notify other UI components that printing ended (mirrors PDFPrintService).
    try {
      window.dispatchEvent(new CustomEvent('gv-print-cleanup'));
    } catch {
      /* ignore */
    }
  }

  private static createPrintContainer(content: PrintableDocumentContent): HTMLElement {
    const container = document.createElement('div');
    container.id = this.PRINT_CONTAINER_ID;
    container.className = 'gv-print-only gv-deep-research-print-only';

    const sanitizedHtml = this.sanitizePrintableHtml(content.html);
    const fallbackText = this.extractPlainTextFromHtml(content.html) || content.markdown.trim();
    const bodyHtml = sanitizedHtml || this.formatPlainTextAsHtml(fallbackText || 'No content');
    const title = this.normalizeTitle(content.title) || 'Deep Research Report';
    const date = this.formatDate(content.exportedAt);

    container.innerHTML = `
      <div class="gv-dr-print-document">
        <div class="gv-dr-print-cover-page">
          <div class="gv-dr-print-cover-content">
            <h1 class="gv-dr-print-cover-title">${this.escapeHTML(title)}</h1>
            <div class="gv-dr-print-meta">
              <p>${this.escapeHTML(date)}</p>
              <p><a href="${this.escapeAttribute(content.url)}">${this.escapeHTML(content.url)}</a></p>
              <p>Deep Research Report</p>
            </div>
          </div>
        </div>
        <div class="gv-dr-print-content">
          <div class="gv-dr-print-report">${bodyHtml}</div>
        </div>
        <div class="gv-dr-print-footer">
          <p>Exported from <a href="https://github.com/Nagi-ovo/voyager">Voyager</a></p>
          <p>Generated on ${this.escapeHTML(date)}</p>
        </div>
      </div>
    `;

    return container;
  }

  private static sanitizePrintableHtml(html: string): string {
    const trimmed = html.trim();
    if (!trimmed) return '';

    const container = document.createElement('div');
    container.innerHTML = trimmed;
    isolateMermaidSvgImages(container);
    container.querySelectorAll('script, style, template').forEach((element) => element.remove());

    const elements = Array.from(container.querySelectorAll<HTMLElement>('*'));
    elements.forEach((element) => {
      const attributes = Array.from(element.attributes);
      attributes.forEach((attribute) => {
        if (attribute.name.toLowerCase().startsWith('on')) {
          element.removeAttribute(attribute.name);
        }
      });
    });

    return container.innerHTML.trim();
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

  private static formatPlainTextAsHtml(text: string): string {
    if (!text.trim()) return '';
    const escaped = this.escapeHTML(text);
    return escaped
      .split('\n\n')
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }

  private static normalizeTitle(title: string): string {
    return title
      .trim()
      .replace(/\s+-\s+Gemini$/i, '')
      .replace(/\s+-\s+Google Gemini$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

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

  private static injectPrintStyles(fontSize?: number): void {
    if (document.getElementById(this.PRINT_STYLES_ID)) return;

    const basePt = fontSize ?? 11;
    const coverTitlePt = Math.round(basePt * (36 / 11));
    const metaPt = Math.max(basePt + 1, 10);
    const codePt = Math.max(basePt - 2, 8);
    const footerPt = Math.max(basePt - 2, 8);

    const style = document.createElement('style');
    style.id = this.PRINT_STYLES_ID;
    style.textContent = `
      .gv-deep-research-print-only {
        display: none;
      }

      @media print {
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

        html,
        body {
          background: #fff !important;
        }

        body.${this.PRINT_BODY_CLASS} {
          background: #fff !important;
        }

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

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} .gv-dr-print-report .katex {
          line-height: 1.2 !important;
        }

        body.${this.PRINT_BODY_CLASS} #${this.PRINT_CONTAINER_ID} {
          font-family: Georgia, 'Times New Roman', serif;
          color: #000;
          background: #fff;
        }

        @page {
          margin: 2cm;
          size: A4;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-cover-page {
          min-height: calc(297mm - 4cm);
          position: relative;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          page-break-after: always;
          margin: 0;
          padding: 0;
          border: none;
          text-align: center;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-cover-content {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 80%;
          max-width: 80%;
          box-sizing: border-box;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-cover-title {
          font-size: ${coverTitlePt}pt;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin: 0 0 1.5em 0;
          color: oklch(0.7227 0.1920 149.5793);
          line-height: 1.2;
          word-wrap: break-word;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-meta {
          font-size: ${metaPt}pt;
          color: #666;
          line-height: 2;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-meta p {
          margin: 0.3em 0;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-meta a {
          color: #666;
          text-decoration: none;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-meta a:after {
          content: none !important;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-content {
          margin: 2em 0;
          line-height: 1.65;
          font-size: ${basePt}pt;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report p {
          margin: 0.5em 0;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report img {
          max-width: 100%;
          height: auto;
          display: block;
          margin: 0.75em 0;
          page-break-inside: avoid;
        }

        ${buildMermaidExportStyles(`body.${this.PRINT_BODY_CLASS} .gv-dr-print-report`, {
          containerMaxWidth: true,
          avoidContainerBreak: true,
          diagramSelector: '> img',
          diagramMargin: '0.75em auto',
          avoidDiagramBreak: true,
          preservePrintBackground: true,
          diagramMaxHeight: '160mm',
        })}

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report pre,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report code {
          font-family: 'Courier New', monospace;
          font-size: ${codePt}pt;
          background: #f5f5f5;
          border-radius: 3px;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report pre {
          padding: 0.75em;
          border-left: 3px solid #d1d5db;
          overflow-x: auto;
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report .math-inline,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report .math-block,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report [data-math] {
          page-break-inside: avoid;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-footer {
          margin-top: 2em;
          padding-top: 1em;
          border-top: 1px solid #ccc;
          font-size: ${footerPt}pt;
          color: #666;
          text-align: center;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-footer p {
          margin: 0.25em 0;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report sources-carousel-inline,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report source-inline-chips,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report source-inline-chip,
        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report .source-inline-chip-container {
          display: none !important;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report a {
          color: #2563eb;
          text-decoration: none;
        }

        body.${this.PRINT_BODY_CLASS} .gv-dr-print-report a[href]:after {
          content: " (" attr(href) ")";
          font-size: 9pt;
          color: #666;
        }

        body.${this.PRINT_BODY_CLASS}.${this.PRINT_SAFARI_BODY_CLASS} .gv-dr-print-cover-page {
          min-height: auto !important;
          position: static !important;
          display: block !important;
          padding: 0 0 1.25em 0 !important;
          border-bottom: 1px solid #e5e7eb !important;
          text-align: left !important;
        }

        body.${this.PRINT_BODY_CLASS}.${this.PRINT_SAFARI_BODY_CLASS} .gv-dr-print-cover-content {
          position: static !important;
          top: auto !important;
          left: auto !important;
          transform: none !important;
          width: 100% !important;
          max-width: 100% !important;
        }

        body.${this.PRINT_BODY_CLASS}.${this.PRINT_SAFARI_BODY_CLASS} .gv-dr-print-content {
          break-before: auto !important;
          page-break-before: auto !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  private static async inlineImages(container: HTMLElement): Promise<void> {
    const images = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    if (images.length === 0) return;

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
        const response = await fetch(url, init);
        if (!response.ok) return null;
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          try {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('readAsDataURL failed'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(blob);
          } catch (error) {
            reject(error);
          }
        });
        return dataUrl;
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    await Promise.all(
      images.map(async (image) => {
        const src = image.getAttribute('src') || '';
        if (!/^(https?:\/\/|blob:)/i.test(src)) return;
        const dataUrl = await toDataUrl(src);
        if (dataUrl) {
          try {
            image.src = dataUrl;
          } catch {
            /* ignore */
          }
        }
      }),
    );

    type DecodableImage = HTMLImageElement & { decode?: () => Promise<void> };
    await Promise.all(
      images.map(async (image) => {
        const decode = (image as DecodableImage).decode;
        if (typeof decode !== 'function') return;
        try {
          await Promise.race([
            decode.call(image).catch(() => {
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

  private static escapeHTML(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private static escapeAttribute(text: string): string {
    return this.escapeHTML(text).replace(/"/g, '&quot;');
  }
}
