/**
 * MarkdownFormatter unit tests
 */
import { describe, expect, it } from 'vitest';

import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import type { ChatTurn, ConversationMetadata } from '../../types/export';
import { DOMContentExtractor } from '../DOMContentExtractor';
import { MarkdownFormatter } from '../MarkdownFormatter';

DOMContentExtractor.setExportAdapter(resolveExportAdapter());

describe('MarkdownFormatter', () => {
  const mockMetadata: ConversationMetadata = {
    url: 'https://gemini.google.com/app/test-conversation',
    exportedAt: '2025-01-15T10:30:00.000Z',
    count: 2,
    title: 'Test Conversation',
  };

  const mockTurns: ChatTurn[] = [
    {
      user: 'Hello, how are you?',
      assistant: 'I am doing well, thanks!',
      starred: false,
    },
    {
      user: 'Can you help me with TypeScript?',
      assistant: 'Of course! TypeScript is a superset of JavaScript...',
      starred: true,
    },
  ];

  describe('format', () => {
    it('should generate valid Markdown', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toBeTruthy();
      expect(markdown).toContain('# Test Conversation');
      expect(markdown).toContain('---');
    });

    it('should include metadata', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toContain('**Date**:');
      expect(markdown).toContain('**Turns**: 2');
      expect(markdown).toContain('[Gemini Chat]');
    });

    it('should format turns correctly', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toContain('## Turn 1');
      expect(markdown).toContain('## Turn 2 ⭐');
      expect(markdown).toContain('### 👤 User');
      expect(markdown).toContain('### 🤖 Assistant');
    });

    it('can put prompts in turn headings without repeating User sections', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata, {
        usePromptAsTurnHeading: true,
      });

      expect(markdown).toContain('## Turn 1: Hello, how are you?');
      expect(markdown).toContain('## Turn 2: Can you help me with TypeScript? ⭐');
      expect(markdown).not.toContain('### 👤 User');
      expect(markdown).toContain('### 🤖 Assistant');
    });

    it('uses a safe single-line heading without dropping uploaded media', () => {
      const markdown = MarkdownFormatter.format(
        [
          {
            user: 'Review this diagram:\n![Architecture](https://example.com/diagram.png)\nBe *brief*.',
            assistant: 'Done.',
            starred: false,
          },
        ],
        mockMetadata,
        { usePromptAsTurnHeading: true },
      );

      expect(markdown).toContain('## Turn 1: Review this diagram: Architecture Be \\*brief\\*\\.');
      expect(markdown).toContain('### 👤 User');
      expect(markdown).toContain('https://example.com/diagram.png');
    });

    it('should include user content', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toContain('Hello, how are you?');
      expect(markdown).toContain('Can you help me with TypeScript?');
    });

    it('includes uploaded file names from the live user message DOM', () => {
      const userElement = document.createElement('div');
      userElement.innerHTML = `
        <user-query-file-preview>
          <div data-test-id="uploaded-file">
            <button class="new-file-preview-file" aria-label="meeting-notes.pdf">PDF</button>
          </div>
        </user-query-file-preview>
        <p class="query-text-line">Summarize it</p>
      `;

      const markdown = MarkdownFormatter.format(
        [{ user: '', assistant: 'Done', starred: false, userElement }],
        mockMetadata,
      );

      expect(markdown).toContain('📎 meeting-notes.pdf');
      expect(markdown).toContain('Summarize it');
    });

    it('keeps uploaded file context when using prompt headings', () => {
      const userElement = document.createElement('div');
      userElement.innerHTML = `
        <user-query-file-preview>
          <div data-test-id="uploaded-file">
            <button class="new-file-preview-file" aria-label="meeting-notes.pdf">PDF</button>
          </div>
        </user-query-file-preview>
        <p class="query-text-line">Summarize it</p>
      `;

      const markdown = MarkdownFormatter.format(
        [{ user: '', assistant: 'Done', starred: false, userElement }],
        mockMetadata,
        { usePromptAsTurnHeading: true },
      );

      expect(markdown).toContain('## Turn 1: 📎 meeting\\-notes\\.pdf Summarize it');
      expect(markdown).not.toContain('### 👤 User');
    });

    it('should include assistant content', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toContain('I am doing well, thanks!');
      expect(markdown).toContain('Of course! TypeScript is a superset of JavaScript...');
    });

    it('should mark starred turns', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      const lines = markdown.split('\n');
      const turn2Line = lines.find((l) => l.startsWith('## Turn 2'));

      expect(turn2Line).toContain('⭐');
    });

    it('should include footer', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata);

      expect(markdown).toContain('Voyager');
      expect(markdown).toContain('Generated on');
    });

    it('should handle empty assistant response', () => {
      const turnsWithEmpty: ChatTurn[] = [
        {
          user: 'Test question',
          assistant: '',
          starred: false,
        },
      ];

      const markdown = MarkdownFormatter.format(turnsWithEmpty, mockMetadata);

      expect(markdown).toContain('Test question');
      expect(markdown).toContain('### 🤖 Assistant');
    });

    it('should handle special characters', () => {
      const turnsWithSpecial: ChatTurn[] = [
        {
          user: 'Test with *asterisks* and _underscores_',
          assistant: 'Response with `code` and [links]',
          starred: false,
        },
      ];

      const markdown = MarkdownFormatter.format(turnsWithSpecial, mockMetadata);

      // Should escape special characters in title but not in content
      expect(markdown).toBeTruthy();
    });

    it('uses custom speaker labels without escaping conversation content', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata, {
        speakerLabels: {
          user: 'Erik',
          assistant: 'Nova',
        },
      });

      expect(markdown).toContain('### 👤 Erik');
      expect(markdown).toContain('### 🤖 Nova');
      expect(markdown).toContain('Of course! TypeScript is a superset of JavaScript...');
    });

    it('escapes Markdown-special characters in speaker labels only', () => {
      const markdown = MarkdownFormatter.format(
        [
          {
            user: '**content stays formatted**',
            assistant: '`code stays formatted`',
            starred: false,
          },
        ],
        mockMetadata,
        {
          speakerLabels: {
            user: '# **[User](url)** `root` \\',
            assistant: '[Assistant](url)',
          },
        },
      );

      expect(markdown).toContain('### 👤 \\# \\*\\*\\[User\\]\\(url\\)\\*\\* \\`root\\` \\\\');
      expect(markdown).toContain('### 🤖 \\[Assistant\\]\\(url\\)');
      expect(markdown).toContain('**content stays formatted**');
      expect(markdown).toContain('`code stays formatted`');
    });

    it('neutralizes raw HTML in speaker labels', () => {
      const markdown = MarkdownFormatter.format(mockTurns, mockMetadata, {
        speakerLabels: {
          user: '<img src=x onerror="alert(1)">',
          assistant: 'R&D > Support',
        },
      });

      expect(markdown).toContain('### 👤 &lt;img src=x onerror="alert\\(1\\)"&gt;');
      expect(markdown).toContain('### 🤖 R&amp;D &gt; Support');
      expect(markdown).not.toContain('<img src=x');
    });
  });

  describe('generateFilename', () => {
    it('should generate filename with timestamp', () => {
      const filename = MarkdownFormatter.generateFilename();

      expect(filename).toMatch(/^gemini-chat-\d{8}-\d{6}\.md$/);
    });

    it('should have .md extension', () => {
      const filename = MarkdownFormatter.generateFilename();

      expect(filename.endsWith('.md')).toBe(true);
    });
  });

  describe('image URLs', () => {
    it('extracts and rewrites inline data images', () => {
      const dataUrl = 'data:image/png;base64,aGVsbG8=';
      const markdown = `![Interactive UI](${dataUrl})`;

      expect(MarkdownFormatter.extractImageUrls(markdown)).toEqual([dataUrl]);

      const rewritten = MarkdownFormatter.rewriteImageUrls(
        markdown,
        new Map([[dataUrl, 'assets/img-001.png']]),
      );

      expect(rewritten).toBe('![Interactive UI](assets/img-001.png)');
    });

    it('degrades inline data images for Safari markdown export', () => {
      const markdown = 'Screenshot: ![Interactive UI](data:image/png;base64,aGVsbG8=)';

      expect(MarkdownFormatter.degradeImageMarkdownForSafari(markdown)).toContain(
        '[Image unavailable in Safari export: Interactive UI]',
      );
    });
  });
});
