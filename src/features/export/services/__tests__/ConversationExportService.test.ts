/**
 * ConversationExportService unit tests
 */
import { toBlob } from 'html-to-image';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import type { ChatTurn, ConversationMetadata, ExportLayout } from '../../types/export';
import { ExportFormat } from '../../types/export';
import { ConversationExportService } from '../ConversationExportService';
import { DOMContentExtractor } from '../DOMContentExtractor';
import { DeepResearchPDFPrintService } from '../DeepResearchPDFPrintService';
import { ImageExportService } from '../ImageExportService';
import { MarkdownFormatter } from '../MarkdownFormatter';
import { PDFPrintService } from '../PDFPrintService';

DOMContentExtractor.setExportAdapter(resolveExportAdapter());

vi.mock('html-to-image', () => {
  return {
    toBlob: vi.fn(),
  };
});

// Setup DOM environment

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document as unknown as Document;
global.window = dom.window as unknown as Window & typeof globalThis;

function setUserAgentVendor(userAgent: string, vendor: string): void {
  Object.defineProperty(global.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(global.navigator, 'vendor', {
    value: vendor,
    configurable: true,
  });
}

describe('ConversationExportService', () => {
  const mockMetadata: ConversationMetadata = {
    url: 'https://gemini.google.com/app/test',
    exportedAt: '2025-01-15T10:30:00.000Z',
    count: 2,
    title: 'Premier League Fantasy',
  };

  const mockTurns: ChatTurn[] = [
    {
      user: 'Test question',
      assistant: 'Test answer',
      starred: false,
    },
  ];

  // Mock DOM methods
  beforeEach(() => {
    document.body.innerHTML = '';
    setUserAgentVendor(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Google Inc.',
    );

    // Mock URL.createObjectURL
    global.URL.createObjectURL = vi.fn(() => 'blob:test');
    global.URL.revokeObjectURL = vi.fn();

    // Mock window.print
    (global.window as Window & { print: () => void }).print = vi.fn();

    // Mock document.createElement to prevent actual downloads
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const element = originalCreateElement(tagName);
      if (tagName === 'a') {
        // Mock click to prevent actual download
        element.click = vi.fn();
      }
      return element;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('export', () => {
    it('should export as JSON', async () => {
      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.JSON,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.filename).toMatch(/\.json$/);
    });

    it('should export as Markdown', async () => {
      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.MARKDOWN,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('markdown');
      expect(result.filename).toBe('Premier-League-Fantasy.md');
    });

    it('applies prompt headings only when requested for Markdown', async () => {
      const downloadSpy = vi.spyOn(MarkdownFormatter, 'download').mockImplementation(() => {});

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.MARKDOWN,
        usePromptAsTurnHeading: true,
      });

      const markdown = downloadSpy.mock.calls[0][0];
      expect(markdown).toContain('## Turn 1: Test question');
      expect(markdown).not.toContain('### 👤 User');
    });

    it('passes custom speaker labels to Markdown formatting', async () => {
      const formatSpy = vi.spyOn(MarkdownFormatter, 'format');
      const speakerLabels = { user: 'Erik', assistant: 'Nova' };

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.MARKDOWN,
        speakerLabels,
      });

      expect(formatSpy).toHaveBeenCalledWith(mockTurns, mockMetadata, {
        usePromptAsTurnHeading: undefined,
        speakerLabels,
      });
    });

    it('should export as PDF', async () => {
      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.PDF,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('pdf');
      expect((global.window as Window & { print: () => void }).print).toHaveBeenCalled();
      expect(result.filename).toBe('Premier-League-Fantasy.pdf');
    });

    it('triggers print for PDF export', async () => {
      (global.window as Window & { print: () => void }).print = vi.fn();

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.PDF,
      });

      expect((global.window as Window & { print: () => void }).print).toHaveBeenCalled();
    });

    it('passes custom speaker labels to PDF export', async () => {
      const exportSpy = vi.spyOn(PDFPrintService, 'export').mockResolvedValue(undefined);
      const speakerLabels = { user: 'Erik', assistant: 'Nova' };

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.PDF,
        fontSize: 14,
        speakerLabels,
      });

      expect(exportSpy).toHaveBeenCalledWith(mockTurns, mockMetadata, {
        fontSize: 14,
        speakerLabels,
      });
    });

    it('should export as Image', async () => {
      (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Blob(['x'], { type: 'image/png' }),
      );

      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.IMAGE,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('image');
      expect(result.filename).toBe('Premier-League-Fantasy.png');
    });

    it('passes custom speaker labels to image export', async () => {
      const exportSpy = vi.spyOn(ImageExportService, 'export').mockResolvedValue(undefined);
      const speakerLabels = { user: 'Erik', assistant: 'Nova' };

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.IMAGE,
        fontSize: 22,
        imageWidth: 960,
        speakerLabels,
      });

      expect(exportSpy).toHaveBeenCalledWith(mockTurns, mockMetadata, {
        filename: 'Premier-League-Fantasy.png',
        fontSize: 22,
        imageWidth: 960,
        speakerLabels,
      });
    });

    it('should export report markdown without turn wrappers in document layout', async () => {
      const downloadSpy = vi.spyOn(MarkdownFormatter, 'download').mockImplementation(() => {});

      const result = await ConversationExportService.export(
        [
          {
            user: '',
            assistant: '# Report title\n\nBody paragraph.',
            starred: false,
            omitEmptySections: true,
          },
        ],
        mockMetadata,
        {
          format: ExportFormat.MARKDOWN,
          layout: 'document' as ExportLayout,
          filename: 'report.md',
        },
      );

      expect(result.success).toBe(true);
      expect(result.format).toBe('markdown');
      expect(downloadSpy).toHaveBeenCalledOnce();
      const markdown = downloadSpy.mock.calls[0][0];
      expect(markdown).toContain('# Report title');
      expect(markdown).not.toContain('## Turn 1');
      expect(markdown).not.toContain('### 🤖 Assistant');
    });

    it('should avoid duplicating heading for document markdown when content already has title', async () => {
      const downloadSpy = vi.spyOn(MarkdownFormatter, 'download').mockImplementation(() => {});

      await ConversationExportService.export(
        [
          {
            user: '',
            assistant: '# Revenue Deep Research Report\n\n正文内容',
            starred: false,
            omitEmptySections: true,
          },
        ],
        {
          ...mockMetadata,
          title: 'Revenue Deep Research Report',
        },
        {
          format: ExportFormat.MARKDOWN,
          layout: 'document' as ExportLayout,
          filename: 'report.md',
        },
      );

      const markdown = downloadSpy.mock.calls[0][0];
      const titleMatches = String(markdown).match(/^# Revenue Deep Research Report$/gm) ?? [];
      expect(titleMatches).toHaveLength(1);
    });

    it('should export report JSON payload in document layout', async () => {
      const downloadSpy = vi.spyOn(
        ConversationExportService as unknown as { downloadJSON: (...args: unknown[]) => unknown },
        'downloadJSON',
      );

      const result = await ConversationExportService.export(
        [
          {
            user: '',
            assistant: 'Body paragraph.',
            starred: false,
            omitEmptySections: true,
          },
        ],
        mockMetadata,
        {
          format: ExportFormat.JSON,
          layout: 'document' as ExportLayout,
          filename: 'report.json',
        },
      );

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(downloadSpy).toHaveBeenCalledOnce();
      const payload = downloadSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.format).toBe('gemini-voyager.report.v1');
      expect(payload).toHaveProperty('content');
      expect(payload).not.toHaveProperty('items');
    });

    it('should use document PDF export path when layout is document', async () => {
      const deepResearchPdfSpy = vi
        .spyOn(DeepResearchPDFPrintService as unknown as { export: () => Promise<void> }, 'export')
        .mockResolvedValue(undefined);
      const pdfDocumentSpy = vi
        .spyOn(
          PDFPrintService as unknown as { exportDocument: () => Promise<void> },
          'exportDocument',
        )
        .mockResolvedValue(undefined);

      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.PDF,
        layout: 'document' as ExportLayout,
        fontSize: 15,
        speakerLabels: { user: 'Erik', assistant: 'Nova' },
      });

      expect(result.success).toBe(true);
      expect(deepResearchPdfSpy).toHaveBeenCalledOnce();
      expect(deepResearchPdfSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: mockMetadata.title,
          url: mockMetadata.url,
          exportedAt: mockMetadata.exportedAt,
        }),
        { fontSize: 15 },
      );
      expect(pdfDocumentSpy).not.toHaveBeenCalled();
    });

    it('should use document image export path when layout is document', async () => {
      const imageDocumentSpy = vi
        .spyOn(
          ImageExportService as unknown as { exportDocument: () => Promise<void> },
          'exportDocument',
        )
        .mockResolvedValue(undefined);

      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.IMAGE,
        layout: 'document' as ExportLayout,
        fontSize: 24,
        imageWidth: 1360,
        speakerLabels: { user: 'Erik', assistant: 'Nova' },
      });

      expect(result.success).toBe(true);
      expect(imageDocumentSpy).toHaveBeenCalledOnce();
      expect(imageDocumentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: mockMetadata.title,
          url: mockMetadata.url,
          exportedAt: mockMetadata.exportedAt,
        }),
        {
          filename: 'Premier-League-Fantasy.png',
          fontSize: 24,
          imageWidth: 1360,
        },
      );
    });

    it('should handle unsupported format', async () => {
      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: 'invalid' as ExportFormat,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported format');
    });

    it('should use custom filename if provided', async () => {
      const customFilename = 'my-export.json';
      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.JSON,
        filename: customFilename,
      });

      expect(result.success).toBe(true);
      expect(result.filename).toBe(customFilename);
    });

    it('should handle export errors gracefully', async () => {
      // Mock an error by throwing in the format method
      const invalidTurns: ChatTurn[] = [
        {
          user: 'test',
          assistant: 'test',
          starred: false,
        },
      ];

      // Mock JSON.stringify to throw
      const originalStringify = JSON.stringify;
      vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new Error('Stringify error');
      });

      const result = await ConversationExportService.export(invalidTurns, mockMetadata, {
        format: ExportFormat.JSON,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Stringify error');

      // Restore
      JSON.stringify = originalStringify;
    });

    it('normalizes image export Event errors for UI handling', async () => {
      const imageExportSpy = vi
        .spyOn(ImageExportService as unknown as { export: () => Promise<void> }, 'export')
        .mockRejectedValue(new Event('error'));

      const result = await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.IMAGE,
      });

      expect(imageExportSpy).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      expect(result.error).toBe('image_render_event_error');
    });
  });

  describe('getAvailableFormats', () => {
    it('should return all available formats', () => {
      const formats = ConversationExportService.getAvailableFormats();

      expect(formats).toHaveLength(4);
      expect(formats.map((f) => f.format)).toEqual(['json', 'markdown', 'pdf', 'image']);
    });

    it('should mark Markdown as recommended', () => {
      const formats = ConversationExportService.getAvailableFormats();
      const markdown = formats.find((f) => f.format === 'markdown');

      expect(markdown?.recommended).toBe(true);
    });

    it('should include descriptions', () => {
      const formats = ConversationExportService.getAvailableFormats();

      formats.forEach((format) => {
        expect(format.label).toBeTruthy();
        expect(format.description).toBeTruthy();
      });
    });
  });

  describe('JSON export with DOM elements', () => {
    it('should use fallback text when no DOM elements are provided', async () => {
      const turnsWithoutDom: ChatTurn[] = [
        {
          user: 'Plain text user',
          assistant: 'Plain text assistant',
          starred: false,
        },
      ];

      const downloadSpy = vi.spyOn(
        ConversationExportService as unknown as { downloadJSON: (...args: unknown[]) => unknown },
        'downloadJSON',
      );
      const result = await ConversationExportService.export(turnsWithoutDom, mockMetadata, {
        format: ExportFormat.JSON,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');

      expect(downloadSpy).toHaveBeenCalledOnce();
      const payload = downloadSpy.mock.calls[0][0] as Record<string, unknown>;
      const items = payload.items as Array<Record<string, unknown>>;

      expect(items).toHaveLength(1);
      expect(items[0].user).toBe('Plain text user');
      expect(items[0].assistant).toBe('Plain text assistant');

      expect(items[0].userElement).toBeUndefined();
    });

    it('keeps JSON roles and object shape unchanged when speaker labels are provided', async () => {
      const downloadSpy = vi.spyOn(
        ConversationExportService as unknown as { downloadJSON: (...args: unknown[]) => unknown },
        'downloadJSON',
      );

      await ConversationExportService.export(mockTurns, mockMetadata, {
        format: ExportFormat.JSON,
        speakerLabels: { user: 'Erik', assistant: 'Nova' },
      });

      const payload = downloadSpy.mock.calls[0][0] as {
        items: Array<Record<string, unknown>>;
      };
      expect(payload.items[0]).toEqual({
        user: 'Test question',
        assistant: 'Test answer',
        starred: false,
      });
      expect(payload.items[0]).not.toHaveProperty('speakerLabels');
    });

    it('includes structured attachment metadata without serializing DOM elements', async () => {
      const userElement = document.createElement('div');
      userElement.innerHTML = `
        <user-query-file-preview>
          <div data-test-id="uploaded-file">
            <button class="new-file-preview-file" aria-label="research.pdf">PDF</button>
          </div>
        </user-query-file-preview>
        <p class="query-text-line">Summarize this</p>
      `;
      const downloadSpy = vi.spyOn(
        ConversationExportService as unknown as { downloadJSON: (...args: unknown[]) => unknown },
        'downloadJSON',
      );

      const result = await ConversationExportService.export(
        [{ user: '', assistant: 'Done', starred: false, userElement }],
        mockMetadata,
        { format: ExportFormat.JSON },
      );

      expect(result.success).toBe(true);
      const payload = downloadSpy.mock.calls[0][0] as {
        items: Array<Record<string, unknown>>;
      };
      expect(payload.items[0]).toMatchObject({
        user: '📎 research.pdf\n\nSummarize this',
        attachments: [{ name: 'research.pdf', type: 'pdf' }],
      });
      expect(payload.items[0].userElement).toBeUndefined();
    });
  });

  describe('markdown zip packaging', () => {
    it('uses the normal image-packaging path on Safari', async () => {
      setUserAgentVendor(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        'Apple Computer, Inc.',
      );

      const downloadSpy = vi.spyOn(MarkdownFormatter, 'download').mockImplementation(() => {});
      const fetchSpy = vi.spyOn(
        ConversationExportService as unknown as {
          fetchImageForMarkdownPackaging: () => Promise<unknown>;
        },
        'fetchImageForMarkdownPackaging',
      );
      fetchSpy.mockResolvedValue(null);

      const turnsWithImage: ChatTurn[] = [
        {
          user: '',
          assistant: 'Summary ![chart](https://example.com/chart.png)',
          starred: false,
          omitEmptySections: true,
        },
      ];

      const result = await ConversationExportService.export(turnsWithImage, mockMetadata, {
        format: ExportFormat.MARKDOWN,
      });

      expect(result.success).toBe(true);
      expect(result.filename).toMatch(/\.zip$/);
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith('https://example.com/chart.png');
    });

    it('should assign image filenames in source order even when fetch resolves out of order', async () => {
      const imageUrls = ['https://example.com/slow.png', 'https://example.com/fast.png'];
      vi.spyOn(MarkdownFormatter, 'extractImageUrls').mockReturnValue(imageUrls);

      const rewriteSpy = vi
        .spyOn(MarkdownFormatter, 'rewriteImageUrls')
        .mockImplementation((markdown) => markdown);

      vi.spyOn(
        ConversationExportService as unknown as {
          fetchImageForMarkdownPackaging: (url: unknown) => Promise<unknown>;
        },
        'fetchImageForMarkdownPackaging',
      ).mockImplementation(async (rawUrl: unknown) => {
        const url = String(rawUrl);
        if (url.includes('slow')) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          blob: new Blob([new TextEncoder().encode(url)], { type: 'image/png' }),
          contentType: 'image/png',
        };
      });

      await (
        ConversationExportService as unknown as Record<string, (...args: unknown[]) => unknown>
      ).downloadMarkdownOrZip(
        '![a](https://example.com/slow.png)\n![b](https://example.com/fast.png)',
        'chat.md',
        'chat.md',
      );

      expect(rewriteSpy).toHaveBeenCalledOnce();
      const mapping = rewriteSpy.mock.calls[0][1] as Map<string, string>;
      expect(mapping.get('https://example.com/slow.png')).toBe('assets/img-001.png');
      expect(mapping.get('https://example.com/fast.png')).toBe('assets/img-002.png');
    });

    it('stores markdown image assets as base64 payloads for Firefox JSZip compatibility', async () => {
      const imageUrl = 'https://example.com/photo.jpg';
      vi.spyOn(MarkdownFormatter, 'extractImageUrls').mockReturnValue([imageUrl]);
      vi.spyOn(MarkdownFormatter, 'rewriteImageUrls').mockImplementation((markdown) => markdown);

      vi.spyOn(
        ConversationExportService as unknown as {
          fetchImageForMarkdownPackaging: () => Promise<unknown>;
        },
        'fetchImageForMarkdownPackaging',
      ).mockResolvedValue({
        blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
        contentType: 'image/jpeg',
      });

      let capturedAssetPayload: unknown;
      let capturedAssetOptions: unknown;
      type JSZipFileFn = (name: unknown, data?: unknown, options?: unknown) => unknown;
      const originalFile = (JSZip.prototype as unknown as { file: JSZipFileFn }).file;
      vi.spyOn(JSZip.prototype as unknown as { file: JSZipFileFn }, 'file').mockImplementation(
        function (this: unknown, name: unknown, data?: unknown, options?: unknown) {
          if (typeof name === 'string' && name.startsWith('img-')) {
            capturedAssetPayload = data;
            capturedAssetOptions = options;
          }
          return originalFile.call(this, name, data, options);
        },
      );

      const finalFilename = await (
        ConversationExportService as unknown as Record<string, (...args: unknown[]) => unknown>
      ).downloadMarkdownOrZip(`![photo](${imageUrl})`, 'chat.md', 'chat.md');

      expect(finalFilename).toBe('chat.zip');
      expect(typeof capturedAssetPayload).toBe('string');
      expect(capturedAssetPayload).toBeTruthy();
      expect(capturedAssetOptions).toMatchObject({ base64: true });
    });

    it('packages inline data images as zip assets instead of leaving base64 in markdown', async () => {
      const dataUrl = 'data:image/png;base64,aGVsbG8=';

      const finalFilename = await (
        ConversationExportService as unknown as Record<string, (...args: unknown[]) => unknown>
      ).downloadMarkdownOrZip(`![Interactive UI](${dataUrl})`, 'chat.md', 'chat.md');

      expect(finalFilename).toBe('chat.zip');

      const createObjectURLMock = global.URL.createObjectURL as unknown as {
        mock: { calls: Array<[Blob]> };
      };
      const zipBlob = createObjectURLMock.mock.calls[0][0];
      const zip = await JSZip.loadAsync(zipBlob);
      const packagedMarkdown = await zip.file('chat.md')?.async('string');
      const imageFile = zip.file('assets/img-001.png');

      expect(packagedMarkdown).toBe('![Interactive UI](assets/img-001.png)');
      expect(packagedMarkdown).not.toContain('data:image');
      expect(imageFile).not.toBeNull();
      expect(await imageFile?.async('string')).toBe('hello');
    });

    it('does not append -s0 to Google authuser query params', () => {
      const toOriginalSizeUrl = (
        ConversationExportService as unknown as Record<string, (url: string) => string>
      ).toOriginalSizeUrl;
      const result = toOriginalSizeUrl(
        'https://lh3.googleusercontent.com/gg/export-image?authuser=2',
      );
      const parsed = new URL(result);

      expect(result).not.toContain('authuser=2-s0');
      expect(parsed.searchParams.get('authuser')).toBe('2');
      expect(parsed.searchParams.get('s')).toBe('0');
    });

    it('should fallback to gv.fetchImageViaPage when direct and background fetch fail', async () => {
      const imageUrl = 'https://lh3.googleusercontent.com/export-image.png';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked'));

      const sendMessageMock = vi.fn(
        (
          message: { type?: string; url?: string },
          callback?: (response: unknown) => void,
        ): void => {
          if (message.type === 'gv.fetchImage') {
            callback?.({ ok: false, error: 'fetch_failed' });
            return;
          }
          if (message.type === 'gv.fetchImageViaPage') {
            callback?.({
              ok: true,
              base64: 'aGVsbG8=',
              contentType: 'image/png',
            });
            return;
          }
          callback?.(null);
        },
      );

      chrome.runtime.sendMessage = sendMessageMock as unknown as typeof chrome.runtime.sendMessage;

      const fetched = (await (
        ConversationExportService as unknown as Record<string, (...args: unknown[]) => unknown>
      ).fetchImageForMarkdownPackaging(imageUrl)) as { contentType: string } | null;

      expect(fetched).not.toBeNull();
      expect(fetched?.contentType).toBe('image/png');
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fetchImage', url: imageUrl },
        expect.any(Function),
      );
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fetchImageViaPage', url: imageUrl },
        expect.any(Function),
      );
    });

    it('should skip gv.fetchImageViaPage for blob urls', async () => {
      const blobUrl = 'blob:https://gemini.google.com/abc-123';
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blob fetch blocked'));

      const sendMessageMock = vi.fn(
        (
          message: { type?: string; url?: string },
          callback?: (response: unknown) => void,
        ): void => {
          if (message.type === 'gv.fetchImage') {
            callback?.({ ok: false, error: 'invalid_url' });
            return;
          }
          callback?.(null);
        },
      );
      chrome.runtime.sendMessage = sendMessageMock as unknown as typeof chrome.runtime.sendMessage;

      const fetched = await (
        ConversationExportService as unknown as Record<string, (...args: unknown[]) => unknown>
      ).fetchImageForMarkdownPackaging(blobUrl);

      expect(fetched).toBeNull();
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fetchImage', url: blobUrl },
        expect.any(Function),
      );
      expect(sendMessageMock).not.toHaveBeenCalledWith(
        { type: 'gv.fetchImageViaPage', url: blobUrl },
        expect.any(Function),
      );
    });
  });
});
