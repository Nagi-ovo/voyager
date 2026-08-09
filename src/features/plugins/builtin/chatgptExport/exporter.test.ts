import { afterEach, describe, expect, it, vi } from 'vitest';

import { PDFPrintService } from '@/features/export/services/PDFPrintService';
import type { ConversationMetadata } from '@/features/export/types/export';

import { collectMountedChatGptMessages } from './conversation';
import {
  buildChatGptExportFilename,
  exportChatGptConversation,
  formatChatGptMarkdown,
} from './exporter';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ChatGPT export formats', () => {
  const metadata: ConversationMetadata = {
    url: 'https://chatgpt.com/c/abc',
    exportedAt: '2026-08-09T12:34:00.000Z',
    count: 1,
    title: 'Export test',
  };

  it('writes ChatGPT source metadata and rich message headings in Markdown', () => {
    document.body.innerHTML = `
      <section data-testid="conversation-turn-0">
        <div data-message-author-role="user" data-message-id="u-1"><p>Hello</p></div>
      </section>
      <section data-testid="conversation-turn-1">
        <div data-message-author-role="assistant" data-message-id="a-1"><pre><code>const x = 1;</code></pre></div>
      </section>
    `;

    const markdown = formatChatGptMarkdown(collectMountedChatGptMessages(), metadata);

    expect(markdown).toContain('**Source**: [ChatGPT](https://chatgpt.com/c/abc)');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('## ChatGPT');
    expect(markdown).toContain('const x = 1;');
    expect(markdown).not.toContain('Gemini Chat');
  });

  it('names full and selected exports distinctly', () => {
    expect(buildChatGptExportFilename(metadata, 'markdown', false)).toMatch(
      /^chatgpt-Export-test-\d{8}-\d{4}\.md$/,
    );
    expect(buildChatGptExportFilename(metadata, 'pdf', true)).toMatch(
      /^chatgpt-Export-test-selected-\d{8}-\d{4}\.pdf$/,
    );
  });

  it('exports a structured JSON payload with selection and message identity intact', async () => {
    document.body.innerHTML = `
      <section data-testid="conversation-turn-0">
        <div data-message-author-role="user" data-message-id="u-1"><p>Hello</p></div>
      </section>
      <section data-testid="conversation-turn-1">
        <div data-message-author-role="assistant" data-message-id="a-1"><p>Hi there</p></div>
      </section>
    `;
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const filename = await exportChatGptConversation({
      format: 'json',
      messages: collectMountedChatGptMessages(),
      metadata,
      selected: true,
    });
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const payloadText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsText(blob);
    });

    expect(filename).toMatch(/^chatgpt-Export-test-selected-\d{8}-\d{4}\.json$/);
    expect(JSON.parse(payloadText)).toEqual({
      format: 'voyager.chatgpt.conversation.v1',
      url: metadata.url,
      title: metadata.title,
      exportedAt: metadata.exportedAt,
      selected: true,
      count: 2,
      messages: [
        { id: 'u-1', role: 'user', content: 'Hello' },
        { id: 'a-1', role: 'assistant', content: 'Hi there' },
      ],
    });
  });

  it('delegates PDF rendering to the rich export service with cloned message DOM', async () => {
    document.body.innerHTML = `
      <section data-testid="conversation-turn-0">
        <div data-message-author-role="user" data-message-id="u-1"><p>Hello</p></div>
      </section>
      <section data-testid="conversation-turn-1">
        <div data-message-author-role="assistant" data-message-id="a-1">
          <h3>Result</h3><pre><code>const x = 1;</code></pre><img src="data:image/png;base64,AA==" alt="result">
        </div>
      </section>
    `;
    const messages = collectMountedChatGptMessages();
    const exportPdf = vi.spyOn(PDFPrintService, 'export').mockResolvedValue(undefined);

    const filename = await exportChatGptConversation({
      format: 'pdf',
      messages,
      metadata,
      selected: true,
      fontSize: 12,
    });

    expect(filename).toMatch(/^chatgpt-Export-test-selected-\d{8}-\d{4}\.pdf$/);
    expect(exportPdf).toHaveBeenCalledOnce();
    const [turns, receivedMetadata, options] = exportPdf.mock.calls[0];
    expect(receivedMetadata).toBe(metadata);
    expect(options).toEqual({
      fontSize: 12,
      speakerLabels: { user: 'User', assistant: 'ChatGPT' },
      appearance: 'chatgpt',
      documentTitle: filename.replace(/\.pdf$/i, ''),
    });
    expect(turns[0].userElement?.querySelector('p')?.textContent).toBe('Hello');
    expect(turns[0].assistantElement?.querySelector('code')?.textContent).toBe('const x = 1;');
    expect(turns[0].assistantElement?.querySelector('img')?.getAttribute('alt')).toBe('result');
  });
});
