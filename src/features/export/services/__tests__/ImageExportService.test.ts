import { toBlob } from 'html-to-image';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurn, ConversationMetadata } from '../../types/export';
import { ImageExportService } from '../ImageExportService';

vi.mock('html-to-image', () => {
  return {
    toBlob: vi.fn(),
  };
});

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

describe('ImageExportService', () => {
  const mockMetadata: ConversationMetadata = {
    url: 'https://gemini.google.com/app/test',
    exportedAt: '2026-01-01T00:00:00.000Z',
    count: 1,
    title: 'Test',
  };

  const mockTurns: ChatTurn[] = [
    {
      user: 'Hello',
      assistant: 'World',
      starred: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setUserAgentVendor(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Google Inc.',
    );
    global.URL.createObjectURL = vi.fn(() => 'blob:test');
    global.URL.revokeObjectURL = vi.fn();

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      const el = originalCreateElement(tagName);
      if (tagName === 'a') {
        el.click = vi.fn();
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders via html-to-image and downloads a png', async () => {
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob(['x'], { type: 'image/png' }),
    );

    await ImageExportService.export(mockTurns, mockMetadata, { filename: 'chat.png' });

    expect(toBlob).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        pixelRatio: 1.2,
      }),
    );
    expect(global.URL.createObjectURL).toHaveBeenCalledOnce();
    const anchors = document.querySelectorAll('a');
    expect(anchors.length).toBeGreaterThan(0);
    expect((anchors[0] as HTMLAnchorElement).download).toBe('chat.png');
  });

  it('renders conversation to blob without downloading', async () => {
    const blob = new Blob(['blob'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(blob);

    const result = await ImageExportService.renderConversationBlob(mockTurns, mockMetadata, {});

    expect(result).toBe(blob);
    expect(toBlob).toHaveBeenCalled();
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('renders uploaded file placeholders in image exports', async () => {
    let renderedAttachmentText = '';
    let renderedStyles = '';
    const userElement = document.createElement('div');
    userElement.innerHTML = `
      <user-query-file-preview>
        <div data-test-id="uploaded-file">
          <button class="new-file-preview-file" aria-label="proposal.pdf">PDF</button>
        </div>
      </user-query-file-preview>
    `;
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        renderedAttachmentText = node.querySelector('.gv-export-attachment')?.textContent ?? '';
        renderedStyles = node.parentElement?.querySelector('style')?.textContent ?? '';
        return new Blob(['x'], { type: 'image/png' });
      },
    );

    await ImageExportService.renderConversationBlob(
      [{ user: '', assistant: 'Reviewed', starred: false, userElement }],
      mockMetadata,
      {},
    );

    expect(renderedAttachmentText).toContain('proposal.pdf');
    expect(renderedStyles).toContain('.gv-image-export-content .gv-export-attachment');
    expect(renderedStyles).toContain('.gv-image-export-doc a {');
    expect(renderedStyles).toContain('color: #2563eb !important;');
  });

  it('renders Mermaid SVG with scoped image export styles', async () => {
    let renderedTarget: HTMLElement | null = null;
    let renderedStyles = '';
    const assistantElement = document.createElement('div');
    assistantElement.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="dark">
            <code-block style="display: none;">
              <div class="code-block-decoration">mermaid</div>
              <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
            </code-block>
            <div class="gv-mermaid-toggle"><button>Diagram</button></div>
            <div class="gv-mermaid-diagram">
              <svg data-render-theme="dark" viewBox="0 0 120 80"><g><text>A</text><text>B</text></g></svg>
            </div>
            <template class="gv-mermaid-light-export"><svg data-export-theme="light" viewBox="0 0 120 80"><g><text>A</text><text>B</text></g></svg></template>
          </div>
        </div>
      </message-content>
    `;
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        renderedTarget = node;
        renderedStyles = node.parentElement?.querySelector('style')?.textContent ?? '';
        return new Blob(['x'], { type: 'image/png' });
      },
    );

    await ImageExportService.renderConversationBlob(
      [{ user: 'Diagram', assistant: '', starred: false, assistantElement }],
      mockMetadata,
      {},
    );

    const target = renderedTarget as HTMLElement | null;
    const mermaidImage = target?.querySelector<HTMLImageElement>(
      '.gv-image-export-content .gv-export-mermaid > img.gv-export-mermaid-image',
    );
    expect(mermaidImage?.src).toMatch(/^data:image\/png;base64,/);
    expect(target?.querySelector('.gv-image-export-content .gv-export-mermaid svg')).toBeNull();
    expect(target?.querySelector('pre, code-block, .gv-mermaid-toggle')).toBeNull();
    expect(renderedStyles).toContain('.gv-image-export-content .gv-export-mermaid');
    expect(renderedStyles).toContain('.gv-image-export-content .gv-export-mermaid > img {');
    expect(renderedStyles).toContain('max-width: 100%;');
    expect(renderedStyles).toContain('height: auto;');
    expect(
      target
        ?.querySelector('.gv-image-export-content .gv-export-mermaid')
        ?.getAttribute('data-gv-mermaid-theme'),
    ).toBe('light');
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(renderedStyles).not.toContain('.gv-export-mermaid[data-gv-mermaid-theme="dark"]');
    expect(renderedStyles).not.toContain('background: #1f2020;');
  });

  it('retries transient image render failures on Chrome and succeeds', async () => {
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Event('error'))
      .mockResolvedValueOnce(new Blob(['ok'], { type: 'image/png' }));

    await ImageExportService.export(mockTurns, mockMetadata, { filename: 'retry.png' });

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(global.URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('does not retry non-retryable render failures on Chrome', async () => {
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('canvas too large'),
    );

    await expect(
      ImageExportService.export(mockTurns, mockMetadata, { filename: 'fail.png' }),
    ).rejects.toThrow('canvas too large');

    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('uses larger typography and media sizing for mobile readability', async () => {
    let capturedStyle = '';
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        capturedStyle =
          (node.parentElement?.querySelector('style') as HTMLStyleElement | null)?.textContent ??
          '';
        return new Blob(['x'], { type: 'image/png' });
      },
    );

    await ImageExportService.export(mockTurns, mockMetadata, { filename: 'readable.png' });

    expect(capturedStyle).toContain('font-size: 20px;');
    expect(capturedStyle).toContain('line-height: 1.9;');
    expect(capturedStyle).toContain('font-size: 50px;');
    expect(capturedStyle).toContain('max-width: 100%;');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex .base');
    expect(capturedStyle).toContain('white-space: nowrap;');
    expect(capturedStyle).toContain('width: min-content;');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex .vlist > span');
    expect(capturedStyle).toContain('height: 0;');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex .mfrac .frac-line');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex .sqrt > .root');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex svg');
    expect(capturedStyle).toContain('fill: currentColor;');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex img.katex-svg');
    expect(capturedStyle).toContain('max-width: none;');
    expect(capturedStyle).toContain('object-fit: fill;');
    expect(capturedStyle).toContain('.gv-image-export-doc .katex .hide-tail');
  });

  it('retries image render without img elements on Safari when primary render fails', async () => {
    setUserAgentVendor(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Apple Computer, Inc.',
    );

    const assistantElement = document.createElement('div');
    assistantElement.innerHTML =
      '<p>Body</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAgMBgA9N4FoAAAAASUVORK5CYII=" alt="img" />';

    const turnsWithImage: ChatTurn[] = [
      {
        user: '',
        assistant: 'fallback',
        starred: false,
        assistantElement,
      },
    ];

    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        if (node.querySelector('img')) {
          throw new Error('image blocked');
        }
        return new Blob(['ok'], { type: 'image/png' });
      },
    );

    await ImageExportService.export(turnsWithImage, mockMetadata, { filename: 'safari.png' });

    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(global.URL.createObjectURL).toHaveBeenCalledOnce();

    const firstTarget = (toBlob as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HTMLElement;
    const secondTarget = (toBlob as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as HTMLElement;
    expect(firstTarget.querySelector('img')).not.toBeNull();
    expect(secondTarget.querySelector('img')).toBeNull();
  });

  it('applies custom width and font size for document image exports', async () => {
    let capturedWidth = '';
    let capturedFontSize = '';
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        const container = node.parentElement as HTMLElement | null;
        capturedWidth = container?.style.width ?? '';
        capturedFontSize = container?.style.fontSize ?? '';
        return new Blob(['x'], { type: 'image/png' });
      },
    );

    await ImageExportService.exportDocument(
      {
        title: 'Report',
        url: 'https://gemini.google.com/app/report',
        exportedAt: '2026-01-01T00:00:00.000Z',
        markdown: 'Body',
        html: '<p>Body</p>',
      },
      {
        filename: 'report.png',
        fontSize: 24,
        imageWidth: 1360,
      },
    );

    expect(capturedWidth).toBe('1360px');
    expect(capturedFontSize).toBe('24px');
  });

  it('applies scoped Mermaid sizing to document image exports', async () => {
    let renderedTarget: HTMLElement | null = null;
    let renderedStyles = '';
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        renderedTarget = node;
        renderedStyles = node.parentElement?.querySelector('style')?.textContent ?? '';
        return new Blob(['x'], { type: 'image/png' });
      },
    );

    await ImageExportService.renderDocumentBlob({
      title: 'Report',
      url: 'https://gemini.google.com/app/report',
      exportedAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Diagram',
      html: '<div class="gv-export-mermaid" data-gv-mermaid-theme="light"><svg viewBox="0 0 120 80"></svg></div>',
    });

    const target = renderedTarget as HTMLElement | null;
    expect(
      target?.querySelector(
        '.gv-image-export-report-content .gv-export-mermaid > img.gv-export-mermaid-image',
      ),
    ).toBeTruthy();
    expect(
      target?.querySelector('.gv-image-export-report-content .gv-export-mermaid svg'),
    ).toBeNull();
    expect(renderedStyles).toContain('.gv-image-export-report-content .gv-export-mermaid');
    expect(renderedStyles).toContain('.gv-image-export-report-content .gv-export-mermaid > img {');
    expect(renderedStyles).toContain('max-width: 100%;');
    expect(renderedStyles).toContain('height: auto;');
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(renderedStyles).toContain('.gv-image-export-doc a {');
    expect(renderedStyles).toContain('color: #2563eb !important;');
    expect(renderedStyles).not.toContain('.gv-export-mermaid[data-gv-mermaid-theme="dark"]');
    expect(renderedStyles).not.toContain('background: #1f2020;');
  });

  it('fetches blob: image URLs so dom-to-image can rasterize generated images', async () => {
    // Reproduces the "export to image misses generated images" issue: Gemini
    // renders generated images with blob: URLs that don't survive the
    // dom-to-image SVG sandbox. inlineImages must fetch them — previously the
    // blob: branch was short-circuited by the `^https?:` guard. The end-to-end
    // chain (fetch → Response.blob → FileReader.readAsDataURL) depends on
    // jsdom polyfills that vary between local and CI runs, so we assert only
    // the load-bearing fact: our code DID call fetch with the blob URL.
    const assistantElement = document.createElement('div');
    assistantElement.innerHTML =
      '<message-content><div class="markdown"><p>Look:</p><img src="blob:https://gemini.google.com/abc" alt="plain" /></div></message-content>';

    const turns: ChatTurn[] = [
      { user: 'show me', assistant: 'here', starred: false, assistantElement },
    ];

    const fetchedUrls: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      fetchedUrls.push(String(url));
      return new Response(new Blob(['fake'], { type: 'image/png' }), { status: 200 });
    }) as unknown as typeof fetch;

    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob(['x'], { type: 'image/png' }),
    );

    try {
      await ImageExportService.export(turns, mockMetadata, { filename: 'gen.png' });
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchedUrls).toContain('blob:https://gemini.google.com/abc');
  });

  it('leaves data: image URLs untouched (no extra fetch round-trips)', async () => {
    const assistantElement = document.createElement('div');
    assistantElement.innerHTML =
      '<message-content><div class="markdown"><img src="data:image/png;base64,UFJFMQ==" alt="inline" /></div></message-content>';

    const turns: ChatTurn[] = [
      { user: 'inline', assistant: 'ok', starred: false, assistantElement },
    ];

    const fetchSpy = vi.fn(async () => new Response(new Blob([]), { status: 200 }));
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;

    (toBlob as unknown as ReturnType<typeof vi.fn>).mockReset();
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob(['x'], { type: 'image/png' }),
    );

    try {
      await ImageExportService.export(turns, mockMetadata, { filename: 'pass.png' });
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const capturedContainer = (toBlob as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HTMLElement;
    const img = capturedContainer.querySelector('img') as HTMLImageElement | null;
    expect(img?.getAttribute('src') || img?.src).toBe('data:image/png;base64,UFJFMQ==');
  });
});
