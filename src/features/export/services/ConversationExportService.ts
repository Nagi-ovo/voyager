/**
 * Conversation Export Service
 * Unified service for exporting conversations in multiple formats
 * Uses Strategy pattern for format-specific implementations
 */
import { fetchImageViaExtensionRuntime } from '@/core/utils/runtimeImageFetch';

import { IMAGE_RENDER_EVENT_ERROR_CODE, isEventLikeImageRenderError } from '../types/errors';
import type {
  ChatTurn,
  ConversationMetadata,
  ExportFormat,
  ExportHandler,
  ExportLayout,
  ExportOptions,
  ExportResult,
} from '../types/export';
import { DOMContentExtractor } from './DOMContentExtractor';
import { DeepResearchPDFPrintService } from './DeepResearchPDFPrintService';
import { ImageExportService } from './ImageExportService';
import { MarkdownFormatter } from './MarkdownFormatter';
import { PDFPrintService } from './PDFPrintService';

/**
 * Main export service
 * Coordinates different export strategies
 */
export class ConversationExportService {
  private static readonly REPORT_JSON_FORMAT = 'gemini-voyager.report.v1' as const;

  private static readonly CHAT_JSON_FORMAT = 'gemini-voyager.chat.v1' as const;

  /**
   * Export conversation in specified format
   */
  static async export(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): Promise<ExportResult> {
    try {
      const layout: ExportLayout = options.layout ?? 'conversation';
      if (layout === 'document') {
        return await this.exportDocument(turns, metadata, options, exportHandler);
      }

      switch (options.format) {
        case 'json':
          return this.exportJSON(turns, metadata, options, exportHandler);

        case 'markdown':
          return await this.exportMarkdown(turns, metadata, options, exportHandler);

        case 'pdf':
          return await this.exportPDF(turns, metadata, options, exportHandler);

        case 'image':
          return await this.exportImage(turns, metadata, options, exportHandler);

        default:
          return {
            success: false,
            format: options.format,
            error: `Unsupported format: ${options.format}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        format: options.format,
        error: this.normalizeError(error),
      };
    }
  }

  private static normalizeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof Event !== 'undefined' && error instanceof Event) {
      return IMAGE_RENDER_EVENT_ERROR_CODE;
    }

    if (isEventLikeImageRenderError(error)) {
      return IMAGE_RENDER_EVENT_ERROR_CODE;
    }

    return String(error);
  }

  private static async exportDocument(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): Promise<ExportResult> {
    const content = this.extractDocumentContent(turns, exportHandler);

    switch (options.format) {
      case 'json':
        return this.exportDocumentJSON(content, metadata, options);
      case 'markdown':
        return await this.exportDocumentMarkdown(content, metadata, options);
      case 'pdf':
        return await this.exportDocumentPDF(content, metadata, options);
      case 'image':
        return await this.exportDocumentImage(content, metadata, options);
      default:
        return {
          success: false,
          format: options.format,
          error: `Unsupported format: ${options.format}`,
        };
    }
  }

  /**
   * Export as JSON (existing format)
   * Now extracts content with Markdown formatting using DOMContentExtractor
   * to ensure consistency with Markdown export
   */
  private static exportJSON(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): ExportResult {
    // Process turns to extract Markdown-formatted content from DOM elements
    const processedItems = turns.map((turn) => {
      let userContent = turn.user;
      let assistantContent = turn.assistant;
      let attachments = turn.attachments ?? [];

      // ChatGPT snapshots rich content while its virtual-list item is mounted.
      // Prefer that stable snapshot over a later DOM read, which may be empty.
      if (turn.userContent) {
        userContent = turn.userContent.text || userContent;
        attachments = turn.userContent.attachments;
      } else if (turn.userElement) {
        const extracted = DOMContentExtractor.extractUserContent(turn.userElement, exportHandler);
        if (extracted.text) {
          userContent = extracted.text;
        }
        attachments = extracted.attachments;
      }

      if (turn.assistantContent) {
        assistantContent = turn.assistantContent.text || assistantContent;
      } else if (turn.assistantElement) {
        const extracted = DOMContentExtractor.extractAssistantContent(
          turn.assistantElement,
          exportHandler,
        );
        if (extracted.text) {
          assistantContent = extracted.text;
        }
      }

      return {
        user: userContent,
        assistant: assistantContent,
        starred: turn.starred,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });

    const payload = {
      format: this.CHAT_JSON_FORMAT,
      url: metadata.url,
      exportedAt: metadata.exportedAt,
      count: metadata.count,
      title: metadata.title,
      items: processedItems,
    };

    const filename =
      options.filename || this.generateFilename('json', metadata.title, metadata.platform);
    this.downloadJSON(payload, filename);

    return {
      success: true,
      format: 'json' as ExportFormat,
      filename,
    };
  }

  /**
   * Export as Markdown
   */
  private static async exportMarkdown(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): Promise<ExportResult> {
    // First create a clean markdown (no inlining)
    let markdown = MarkdownFormatter.format(turns, metadata, exportHandler);

    // Strip image source attribution lines if user opted out
    if (options.includeImageSource === false) {
      markdown = markdown.replace(/\n\*Source: \[[^\]]*\]\([^)]*\)\*\n/g, '\n');
    }

    const filename =
      options.filename || this.generateFilename('md', metadata.title, metadata.platform);
    const finalFilename = await this.downloadMarkdownOrZip(markdown, filename, 'chat.md');
    return { success: true, format: 'markdown' as ExportFormat, filename: finalFilename };
  }

  /**
   * Export as PDF (using print dialog)
   */
  private static async exportPDF(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): Promise<ExportResult> {
    await PDFPrintService.export(turns, metadata, { fontSize: options.fontSize }, exportHandler);

    // Note: We can't get the actual filename from print dialog
    // User chooses filename in Save as PDF dialog
    return {
      success: true,
      format: 'pdf' as ExportFormat,
      filename: options.filename || this.generateFilename('pdf', metadata.title, metadata.platform),
    };
  }

  /**
   * Export as image (PNG)
   */
  private static async exportImage(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: ExportOptions,
    exportHandler?: ExportHandler,
  ): Promise<ExportResult> {
    const filename =
      options.filename || this.generateFilename('png', metadata.title, metadata.platform);
    await ImageExportService.export(
      turns,
      metadata,
      {
        filename,
        fontSize: options.fontSize,
        imageWidth: options.imageWidth,
      },
      exportHandler,
    );
    return { success: true, format: 'image' as ExportFormat, filename };
  }

  private static exportDocumentJSON(
    content: { markdown: string; html: string },
    metadata: ConversationMetadata,
    options: ExportOptions,
  ): ExportResult {
    const payload = {
      format: this.REPORT_JSON_FORMAT,
      url: metadata.url,
      exportedAt: metadata.exportedAt,
      title: metadata.title,
      content: {
        markdown: content.markdown,
        html: content.html,
      },
    };

    const filename =
      options.filename || this.generateFilename('json', metadata.title, metadata.platform);
    this.downloadJSON(payload, filename);
    return {
      success: true,
      format: 'json' as ExportFormat,
      filename,
    };
  }

  private static async exportDocumentMarkdown(
    content: { markdown: string; html: string },
    metadata: ConversationMetadata,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const markdown = this.composeDocumentMarkdown(content.markdown, metadata);
    const filename =
      options.filename || this.generateFilename('md', metadata.title, metadata.platform);
    const mdEntryName = filename.toLowerCase().endsWith('.md')
      ? filename.split('/').pop() || 'report.md'
      : 'report.md';

    const finalFilename = await this.downloadMarkdownOrZip(markdown, filename, mdEntryName);
    return {
      success: true,
      format: 'markdown' as ExportFormat,
      filename: finalFilename,
    };
  }

  private static async exportDocumentPDF(
    content: { markdown: string; html: string },
    metadata: ConversationMetadata,
    options: ExportOptions,
  ): Promise<ExportResult> {
    await DeepResearchPDFPrintService.export(
      {
        title: metadata.title || 'Deep Research Report',
        url: metadata.url,
        exportedAt: metadata.exportedAt,
        markdown: content.markdown,
        html: content.html,
      },
      { fontSize: options.fontSize },
    );

    return {
      success: true,
      format: 'pdf' as ExportFormat,
      filename: options.filename || this.generateFilename('pdf', metadata.title, metadata.platform),
    };
  }

  private static async exportDocumentImage(
    content: { markdown: string; html: string },
    metadata: ConversationMetadata,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const filename =
      options.filename || this.generateFilename('png', metadata.title, metadata.platform);
    await ImageExportService.exportDocument(
      {
        title: metadata.title || 'Deep Research Report',
        url: metadata.url,
        exportedAt: metadata.exportedAt,
        markdown: content.markdown,
        html: content.html,
      },
      {
        filename,
        fontSize: options.fontSize,
        imageWidth: options.imageWidth,
      },
    );

    return {
      success: true,
      format: 'image' as ExportFormat,
      filename,
    };
  }

  private static extractDocumentContent(
    turns: ChatTurn[],
    exportHandler?: ExportHandler,
  ): { markdown: string; html: string } {
    const turn =
      turns.find((item) => item.assistantElement || item.assistant.trim()) ||
      turns.find((item) => item.userElement || item.user.trim());

    if (!turn) {
      return { markdown: '', html: '' };
    }

    if (turn.assistantElement) {
      const extracted = DOMContentExtractor.extractAssistantContent(
        turn.assistantElement,
        exportHandler,
      );
      return {
        markdown: extracted.text || turn.assistant,
        html: extracted.html || this.formatPlainTextAsHtml(extracted.text || turn.assistant),
      };
    }

    if (turn.userElement) {
      const extracted = DOMContentExtractor.extractUserContent(turn.userElement, exportHandler);
      return {
        markdown: extracted.text || turn.user,
        html: extracted.html || this.formatPlainTextAsHtml(extracted.text || turn.user),
      };
    }

    const markdown = turn.assistant || turn.user || '';
    return {
      markdown,
      html: this.formatPlainTextAsHtml(markdown),
    };
  }

  private static composeDocumentMarkdown(content: string, metadata: ConversationMetadata): string {
    const sections: string[] = [];
    const title = metadata.title?.trim() || 'Deep Research Report';
    const trimmedContent = content.trim() || '_No content_';
    const startsWithHeading = this.hasLeadingMarkdownHeading(trimmedContent);

    if (!startsWithHeading) {
      sections.push(`# ${title}`);
      sections.push('');
    }

    sections.push(trimmedContent);
    sections.push('');
    sections.push('---');
    sections.push('');
    sections.push(`Source: ${metadata.url}`);
    sections.push(`Exported at: ${metadata.exportedAt}`);
    return sections.join('\n');
  }

  private static hasLeadingMarkdownHeading(content: string): boolean {
    return /^#{1,6}\s+\S/m.test(content) && /^#{1,6}\s+\S/.test(content);
  }

  private static formatPlainTextAsHtml(content: string): string {
    if (!content.trim()) return '';
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
      .split('\n\n')
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }

  private static async downloadMarkdownOrZip(
    markdown: string,
    filename: string,
    markdownEntryName: string,
  ): Promise<string> {
    const normalizedFilename = filename.toLowerCase().endsWith('.md') ? filename : `${filename}.md`;

    const imageUrls = MarkdownFormatter.extractImageUrls(markdown);

    if (imageUrls.length === 0) {
      MarkdownFormatter.download(markdown, normalizedFilename);
      return normalizedFilename;
    }

    // Load JSZip on demand: image-packaged Markdown export is a rare, click-driven
    // action, so JSZip stays out of the statically-imported content-script chunk.
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const assetsFolder = zip.folder('assets');
    const mapping = new Map<string, string>();

    const fetchedByOrder = await Promise.all(
      imageUrls.map(async (url) => {
        // For Google images, request original size (=s0) instead of the display thumbnail
        const fetchUrl = this.toOriginalSizeUrl(url);
        const fetched = await this.fetchImageForMarkdownPackaging(fetchUrl);
        if (!fetched) return null;
        return {
          url,
          blob: fetched.blob,
          contentType: fetched.contentType,
        };
      }),
    );

    let index = 1;
    for (const item of fetchedByOrder) {
      if (!item) continue;
      const extension = this.pickImageExtension(item.contentType, item.url);
      const fileName = `img-${String(index++).padStart(3, '0')}.${extension}`;
      const base64Payload = await this.blobToBase64Payload(item.blob);
      if (!base64Payload) continue;
      assetsFolder?.file(fileName, base64Payload, { base64: true });
      mapping.set(item.url, `assets/${fileName}`);
    }

    const packagedMarkdown = MarkdownFormatter.rewriteImageUrls(markdown, mapping);
    zip.file(markdownEntryName, packagedMarkdown);

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipFilename = normalizedFilename.replace(/\.md$/i, '.zip');
    const url = URL.createObjectURL(zipBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = zipFilename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      try {
        document.body.removeChild(anchor);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    }, 0);

    return zipFilename;
  }

  /**
   * Replace Google image URL size parameter with =s0 for original resolution.
   * Non-Google URLs are returned unchanged.
   */
  private static toOriginalSizeUrl(url: string): string {
    const isGoogle = url.includes('googleusercontent.com') || url.includes('ggpht.com');
    if (!isGoogle) return url;
    const GOOGLE_SIZE_PATTERN = /=[swh]\d+[^?#]*/;
    if (GOOGLE_SIZE_PATTERN.test(url)) {
      return url.replace(GOOGLE_SIZE_PATTERN, '=s0');
    }
    if (url.includes('?')) {
      const parsed = new URL(url);
      parsed.searchParams.set('s', '0');
      return parsed.toString();
    }
    return url.split(/[?#]/, 1)[0].includes('=') ? url + '-s0' : url + '=s0';
  }

  private static pickImageExtension(contentType: string | null, url: string): string {
    const byType: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    };
    if (contentType && byType[contentType]) return byType[contentType];
    const match = url.split('?')[0].match(/\.(png|jpg|jpeg|gif|webp|svg)$/i);
    if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    return 'bin';
  }

  private static blobToBase64Payload(blob: Blob): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          const commaIndex = dataUrl.indexOf(',');
          resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      } catch {
        resolve(null);
      }
    });
  }

  private static decodeDataImageUrl(url: string): { blob: Blob; contentType: string } | null {
    const commaIndex = url.indexOf(',');
    if (!url.startsWith('data:image/') || commaIndex < 0) return null;

    const metadata = url.slice('data:'.length, commaIndex);
    const contentType = metadata.split(';')[0] || 'image/png';
    const payload = url.slice(commaIndex + 1);

    try {
      let bytes: Uint8Array;
      if (metadata.includes(';base64')) {
        const binary = atob(payload);
        bytes = new Uint8Array(binary.length);
        for (let idx = 0; idx < binary.length; idx++) {
          bytes[idx] = binary.charCodeAt(idx);
        }
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }

      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);

      return {
        blob: new Blob([buffer], { type: contentType }),
        contentType,
      };
    } catch {
      return null;
    }
  }

  private static async fetchImageForMarkdownPackaging(
    url: string,
  ): Promise<{ blob: Blob; contentType: string | null } | null> {
    if (url.startsWith('data:image/')) {
      return this.decodeDataImageUrl(url);
    }

    try {
      const response = await fetch(url, { credentials: 'include', mode: 'cors' as RequestMode });
      if (response.ok) {
        return {
          blob: await response.blob(),
          contentType: response.headers.get('Content-Type'),
        };
      }
    } catch {
      /* ignore */
    }

    // Retry without credentials for servers with wildcard CORS
    // (Access-Control-Allow-Origin: * is incompatible with credentials: 'include')
    try {
      const response = await fetch(url, { credentials: 'omit', mode: 'cors' as RequestMode });
      if (response.ok) {
        return {
          blob: await response.blob(),
          contentType: response.headers.get('Content-Type'),
        };
      }
    } catch {
      /* ignore */
    }

    const runtimeImage = await fetchImageViaExtensionRuntime(url);
    if (runtimeImage) {
      const binary = atob(runtimeImage.base64);
      const length = binary.length;
      const bytes = new Uint8Array(length);
      for (let idx = 0; idx < length; idx++) bytes[idx] = binary.charCodeAt(idx);
      return {
        blob: new Blob([bytes], { type: runtimeImage.contentType }),
        contentType: runtimeImage.contentType,
      };
    }

    return null;
  }

  /**
   * Download JSON file
   */
  private static downloadJSON(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    }, 0);
  }

  /**
   * Generate filename with timestamp
   */
  private static generateFilename(extension: string, title?: string, platform?: string): string {
    const titlePart = this.sanitizeFilenamePart(title);
    if (titlePart) {
      return `${titlePart}.${extension}`;
    }

    const slug = (platform || 'gemini').toLowerCase().replace(/\s+/g, '-');
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${slug}-chat-${y}${m}${day}-${hh}${mm}${ss}.${extension}`;
  }

  private static sanitizeFilenamePart(title?: string): string {
    if (!title) return '';

    const compact = title.trim().replace(/\s+/g, ' ');
    if (!compact) return '';

    return compact
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/\.+$/g, '')
      .slice(0, 80);
  }

  /**
   * Get available export formats
   */
  static getAvailableFormats(): Array<{
    format: ExportFormat;
    label: string;
    description: string;
    recommended?: boolean;
  }> {
    return [
      {
        format: 'json' as ExportFormat,
        label: 'JSON',
        description: 'Machine-readable format for developers',
      },
      {
        format: 'markdown' as ExportFormat,
        label: 'Markdown',
        description: 'Clean, portable text format (recommended)',
        recommended: true,
      },
      {
        format: 'pdf' as ExportFormat,
        label: 'PDF',
        description: 'Print-friendly format via Save as PDF',
      },
      {
        format: 'image' as ExportFormat,
        label: 'Image',
        description: 'Single PNG image for sharing',
      },
    ];
  }
}
