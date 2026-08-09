import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import type { ChatTurn, ConversationMetadata } from '../../types/export';
import { DOMContentExtractor } from '../DOMContentExtractor';
import { PDFPrintService } from '../PDFPrintService';

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
globalThis.document = dom.window.document;
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.navigator = dom.window.navigator;

DOMContentExtractor.setExportAdapter(resolveExportAdapter());

function mockSafariUserAgent(): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, 'vendor', {
    value: 'Apple Computer, Inc.',
    configurable: true,
  });
}

describe('PDFPrintService (Safari)', () => {
  const mockMetadata: ConversationMetadata = {
    url: 'https://gemini.google.com/app/test',
    exportedAt: '2025-01-15T10:30:00.000Z',
    count: 1,
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    (window as unknown as { print: () => void }).print = vi.fn();
    mockSafariUserAgent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('triggers print even if image inlining never resolves', async () => {
    const assistantElement = document.createElement('div');
    assistantElement.innerHTML = '<img src="https://example.com/img.png" alt="x" />';

    const turns: ChatTurn[] = [
      {
        user: 'hello',
        assistant: 'world',
        starred: false,
        assistantElement,
      },
    ];

    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch);

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('export timed out')), 50);
    });

    await expect(
      Promise.race([PDFPrintService.export(turns, mockMetadata), timeout]),
    ).resolves.toBe(undefined);
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    expect((window as unknown as { print: () => void }).print).toHaveBeenCalledOnce();
  });
});
