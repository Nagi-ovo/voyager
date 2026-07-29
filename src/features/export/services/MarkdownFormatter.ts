/**
 * Markdown formatter service
 * Converts conversation to clean, standard Markdown format
 * Following the "paper book" philosophy - content over design
 */
import {
  type ChatTurn,
  type ConversationMetadata,
  DEFAULT_EXPORT_SPEAKER_LABELS,
  type MarkdownFormatOptions,
} from '../types/export';
import { DOMContentExtractor } from './DOMContentExtractor';

/**
 * Markdown formatting service
 * Produces clean, portable Markdown following CommonMark specification
 */
export class MarkdownFormatter {
  /**
   * Fetch URL as data URL (best-effort). Returns null on failure.
   */
  private static async fetchAsDataURL(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, { credentials: 'include', mode: 'cors' as RequestMode });
      if (!resp.ok || !resp.body) return null;
      const blob = await resp.blob();
      return await new Promise<string>((resolve, reject) => {
        try {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('readAsDataURL failed'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(blob);
        } catch (e) {
          reject(e);
        }
      });
    } catch {
      return null;
    }
  }

  /**
   * Extract image URLs from Markdown (http/https, blob:, and inline data images)
   */
  static extractImageUrls(markdown: string): string[] {
    const imgRegex = /!\[[^\]]*\]\(((?:https?:\/\/|blob:|data:image\/)[^\s)]+)\)/g;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = imgRegex.exec(markdown)) !== null) {
      out.add(m[1]);
    }
    return Array.from(out);
  }

  /**
   * Rewrite Markdown image URLs using provided mapping (original -> newUrl)
   */
  static rewriteImageUrls(markdown: string, mapping: Map<string, string>): string {
    const imgRegex = /!\[([^\]]*)\]\(((?:https?:\/\/|blob:|data:image\/)[^\s)]+)\)/g;
    return markdown.replace(imgRegex, (_all, alt, url) => {
      const next = mapping.get(url);
      return next ? `![${alt}](${next})` : _all;
    });
  }

  /**
   * Replace markdown image syntax with a Safari-safe text placeholder.
   */
  static degradeImageMarkdownForSafari(markdown: string): string {
    const imgRegex = /!\[([^\]]*)\]\(((?:https?:\/\/|blob:|data:image\/)[^\s)]+)\)/g;
    return markdown.replace(imgRegex, (_all, altText) => {
      const alt = String(altText || '').trim();
      const label = alt || 'image';
      return `[Image unavailable in Safari export: ${label}]`;
    });
  }

  /**
   * Format conversation as Markdown
   */
  static format(
    turns: ChatTurn[],
    metadata: ConversationMetadata,
    options: MarkdownFormatOptions = {},
  ): string {
    const sections: string[] = [];

    // Header with metadata
    sections.push(this.formatHeader(metadata));
    sections.push(''); // Empty line

    // Divider
    sections.push('---');
    sections.push('');

    // Conversation turns
    turns.forEach((turn, index) => {
      sections.push(this.formatTurn(turn, index + 1, options));
      sections.push(''); // Empty line between turns
    });

    // Footer
    sections.push('---');
    sections.push('');
    sections.push(this.formatFooter(metadata));

    return sections.join('\n');
  }

  /**
   * Format header with conversation metadata
   */
  private static formatHeader(metadata: ConversationMetadata): string {
    const lines: string[] = [];

    // Title
    const title = metadata.title || this.extractTitleFromURL(metadata.url);
    lines.push(`# ${this.escapeMarkdown(title)}`);
    lines.push('');

    // Metadata table
    lines.push(`**Date**: ${this.formatDate(metadata.exportedAt)}`);
    lines.push(`**Turns**: ${metadata.count}`);
    lines.push(`**Source**: [Gemini Chat](${metadata.url})`);

    return lines.join('\n');
  }

  /**
   * Format a single conversation turn
   */
  private static formatTurn(turn: ChatTurn, index: number, options: MarkdownFormatOptions): string {
    const lines: string[] = [];
    const speakerLabels = options.speakerLabels ?? DEFAULT_EXPORT_SPEAKER_LABELS;
    const promptHeadingContent = options.usePromptAsTurnHeading
      ? this.formatPromptHeading(turn)
      : { hasMedia: false, text: '' };
    const promptHeading = promptHeadingContent.text;
    const omitUserSection = !!promptHeading && !promptHeadingContent.hasMedia;
    const starredSuffix = turn.starred ? ' ⭐' : '';

    lines.push(
      promptHeading
        ? `## Turn ${index}: ${promptHeading}${starredSuffix}`
        : `## Turn ${index}${starredSuffix}`,
    );
    lines.push('');

    if (!turn.omitEmptySections) {
      if (!omitUserSection) {
        lines.push(`### 👤 ${this.escapeMarkdownLabel(speakerLabels.user)}`);
        lines.push('');

        if (turn.userElement) {
          const extracted = DOMContentExtractor.extractUserContent(turn.userElement);
          if (extracted.hasImages) {
            lines.push('*[This turn includes uploaded images]*');
            lines.push('');
          }
          lines.push(extracted.text || '_No content_');
        } else {
          lines.push(this.formatContent(turn.user) || '_No content_');
        }

        lines.push('');
      }

      lines.push(`### 🤖 ${this.escapeMarkdownLabel(speakerLabels.assistant)}`);
      lines.push('');

      if (turn.assistantElement) {
        const extracted = DOMContentExtractor.extractAssistantContent(turn.assistantElement);
        const fallback = this.formatContent(turn.assistant);
        lines.push(extracted.text || fallback || '_No content_');
      } else {
        lines.push(this.formatContent(turn.assistant) || '_No content_');
      }

      return lines.join('\n');
    }

    let hasAnySection = false;

    const userFallback = this.formatContent(turn.user);
    const hasUser = !!turn.userElement || !!userFallback;
    if (hasUser && !omitUserSection) {
      lines.push(`### 👤 ${this.escapeMarkdownLabel(speakerLabels.user)}`);
      lines.push('');

      if (turn.userElement) {
        const extracted = DOMContentExtractor.extractUserContent(turn.userElement);
        if (extracted.hasImages) {
          lines.push('*[This turn includes uploaded images]*');
          lines.push('');
        }
        lines.push(extracted.text || userFallback || '_No content_');
      } else {
        lines.push(userFallback || '_No content_');
      }

      lines.push('');
      hasAnySection = true;
    }

    const assistantFallback = this.formatContent(turn.assistant);
    const hasAssistant = !!turn.assistantElement || !!assistantFallback;
    if (hasAssistant) {
      lines.push(`### 🤖 ${this.escapeMarkdownLabel(speakerLabels.assistant)}`);
      lines.push('');

      if (turn.assistantElement) {
        const extracted = DOMContentExtractor.extractAssistantContent(turn.assistantElement);
        lines.push(extracted.text || assistantFallback || '_No content_');
      } else {
        lines.push(assistantFallback || '_No content_');
      }

      hasAnySection = true;
    }

    if (!hasAnySection) {
      lines.push('_No content_');
    }

    return lines.join('\n');
  }

  private static formatPromptHeading(turn: ChatTurn): { hasMedia: boolean; text: string } {
    const fallback = this.formatContent(turn.user);
    const domContent = turn.userElement
      ? DOMContentExtractor.extractUserContent(turn.userElement)
      : null;
    const extracted = domContent?.text || fallback;

    if (!extracted) return { hasMedia: false, text: '' };

    const singleLine = extracted
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      hasMedia: domContent?.hasImages === true || /!\[[^\]]*\]\([^)]*\)/.test(extracted),
      text: singleLine ? this.escapeMarkdown(singleLine) : '',
    };
  }

  /**
   * Format content with proper Markdown syntax
   * Preserves code blocks, lists, and other formatting
   */
  private static formatContent(content: string): string {
    if (!content) return '';

    // Content is already mostly plain text from DOM extraction
    // We just need to ensure proper escaping and structure

    let formatted = content.trim();

    // Detect and preserve code blocks (already formatted by Gemini)
    // The extractAssistantText already gives us clean text
    // We'll just ensure proper indentation for code

    return formatted;
  }

  /**
   * Format footer
   */
  private static formatFooter(metadata: ConversationMetadata): string {
    return [
      `*Exported from [Voyager](https://github.com/Nagi-ovo/voyager)*`,
      `*Generated on ${this.formatDate(metadata.exportedAt)}*`,
    ].join('  \n'); // Two spaces for line break
  }

  /**
   * Extract title from URL
   */
  private static extractTitleFromURL(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;

      // Extract from Gemini URL pattern
      // e.g., /app/conversation-id or /chat/conversation-id
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
   * Format date in readable format
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

  /**
   * Escape special Markdown characters
   */
  private static escapeMarkdown(text: string): string {
    // Escape special characters that could break Markdown
    return text.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
  }

  private static escapeMarkdownLabel(text: string): string {
    const escapedHtml = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return this.escapeMarkdown(escapedHtml);
  }

  /**
   * Generate filename for Markdown export
   */
  static generateFilename(): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `gemini-chat-${y}${m}${day}-${hh}${mm}${ss}.md`;
  }

  /**
   * Download Markdown file
   */
  static download(content: string, filename?: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || this.generateFilename();
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
}
