import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderElementToImageBlob } from '../ImageRenderService';
import { PDFPrintService } from '../PDFPrintService';

vi.mock('../ImageRenderService', () => ({
  renderElementToImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));

describe('PDFPrintService', () => {
  afterEach(() => {
    try {
      window.dispatchEvent(new Event('afterprint'));
    } catch {
      /* ignore */
    }
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    document.title = 'Gemini';
    try {
      window.history.pushState({}, '', '/');
    } catch {
      /* ignore */
    }
  });

  it('triggers print and cleans up container on afterprint', async () => {
    vi.useFakeTimers();
    window.print = vi.fn();

    const exportPromise = PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'My Chat',
    });

    await vi.advanceTimersByTimeAsync(100);
    await exportPromise;

    expect(window.print).toHaveBeenCalledOnce();
    expect(document.getElementById('gv-pdf-print-container')).toBeTruthy();

    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('gv-pdf-print-container')).toBeNull();
  });

  it('injects print rules scoped by pdf printing class with white page reset', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Scoped Print Styles',
    });

    const style = document.getElementById('gv-pdf-print-styles');
    const styleText = style?.textContent || '';

    expect(styleText).toContain('body.gv-pdf-printing > *:not(#gv-pdf-print-container)');
    expect(styleText).toContain('html,');
    expect(styleText).toContain('body {');
    expect(styleText).toContain('background: #fff !important;');
  });

  it('injects descendant display override to survive immersive-mode print rules', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Immersive Print Override',
    });

    const style = document.getElementById('gv-pdf-print-styles');
    const styleText = style?.textContent || '';

    expect(styleText).toMatch(
      /body\.gv-pdf-printing #gv-pdf-print-container \*\s*\{\s*display:\s*revert !important;/,
    );
  });

  it('restores KaTeX layout primitives after immersive-mode display override', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'KaTeX Print Layout',
    });

    const style = document.getElementById('gv-pdf-print-styles');
    const styleText = style?.textContent || '';

    expect(styleText).toContain('.katex .vlist-t');
    expect(styleText).toContain('display: inline-table !important;');
    expect(styleText).toContain('.katex .vlist-r');
    expect(styleText).toContain('display: table-row !important;');
    expect(styleText).toContain('.katex .vlist,');
    expect(styleText).toContain('.katex .vlist-s');
    expect(styleText).toContain('display: table-cell !important;');
    expect(styleText).toContain('.katex .base');
    expect(styleText).toContain('white-space: nowrap !important;');
    expect(styleText).toContain('width: min-content !important;');
    expect(styleText).toContain('.katex .vlist > span');
    expect(styleText).toContain('height: 0 !important;');
    expect(styleText).toContain('.katex .mfrac .frac-line');
    expect(styleText).toContain('.katex .sqrt > .root');
    expect(styleText).toContain('.katex svg');
    expect(styleText).toContain('fill: currentColor !important;');
    expect(styleText).toContain('position: absolute !important;');
    expect(styleText).toContain('.katex img.katex-svg');
    expect(styleText).toContain('max-width: none !important;');
    expect(styleText).toContain('object-fit: fill !important;');
    expect(styleText).toContain('.katex .hide-tail');
    expect(styleText).toContain('.gv-print-turn-text .katex');
    expect(styleText).toContain('line-height: 1.2 !important;');
  });

  it('keeps cover page centered under immersive-mode display override', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Centered Cover',
    });

    const style = document.getElementById('gv-pdf-print-styles');
    const styleText = style?.textContent || '';

    expect(styleText).toMatch(
      /body\.gv-pdf-printing #gv-pdf-print-container \.gv-print-cover-page\s*\{[\s\S]*display:\s*flex !important;/,
    );
  });

  it('reuses conversation print markup for document PDF content', async () => {
    document.title = 'Original Title';
    window.print = vi.fn();

    await PDFPrintService.exportDocument({
      title: 'Deep Research Report',
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      markdown: '# Markdown heading',
      html: '<div class="markdown-main-panel"><h2>HTML heading</h2><p>HTML body</p></div>',
    });

    const turn = document.querySelector('.gv-print-turn');
    const reportContainer = document.querySelector('.gv-print-report-content');
    const coverTitle = document.querySelector('.gv-print-cover-title');
    const turnText = document.querySelector('.gv-print-turn-text');
    expect(turn).toBeTruthy();
    expect(reportContainer).toBeNull();
    expect(coverTitle?.textContent).toContain('Deep Research Report');
    expect(turnText?.textContent).toContain('HTML heading');
    expect(turnText?.textContent).not.toContain('Markdown heading');
  });

  it('uses classed div containers instead of semantic print tags', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'No Semantic Tags',
    });

    const container = document.getElementById('gv-pdf-print-container');
    expect(container).toBeTruthy();
    expect(container?.querySelector('header, main, article, footer')).toBeNull();
  });

  it('renders uploaded file placeholders in conversation PDFs', async () => {
    window.print = vi.fn();
    const userElement = document.createElement('div');
    userElement.innerHTML = `
      <user-query-file-preview>
        <div data-test-id="uploaded-file">
          <button class="new-file-preview-file" aria-label="proposal.pdf">PDF</button>
        </div>
      </user-query-file-preview>
    `;

    await PDFPrintService.export(
      [{ user: '', assistant: 'Reviewed', starred: false, userElement }],
      {
        url: 'https://gemini.google.com/app/x',
        exportedAt: new Date().toISOString(),
        count: 1,
        title: 'Attachment',
      },
    );

    const attachment = document.querySelector('.gv-export-attachment');
    const styleText = document.getElementById('gv-pdf-print-styles')?.textContent ?? '';
    expect(attachment?.textContent).toContain('proposal.pdf');
    expect(styleText).toContain('.gv-print-turn-text .gv-export-attachment');
  });

  it('renders Mermaid SVG with print-safe scoped styles', async () => {
    window.print = vi.fn();
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
              <svg data-render-theme="dark" viewBox="0 0 640 1190"><g><text>A</text><text>B</text></g></svg>
            </div>
            <template class="gv-mermaid-light-export">
              <svg data-export-theme="light" viewBox="0 0 640 1190">
                <foreignObject width="160" height="24">
                  <div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell">
                    <span class="nodeLabel"><p>核心能力构建</p></span>
                  </div>
                </foreignObject>
              </svg>
            </template>
          </div>
        </div>
      </message-content>
    `;

    await PDFPrintService.export(
      [{ user: 'Diagram', assistant: '', starred: false, assistantElement }],
      {
        url: 'https://gemini.google.com/app/x',
        exportedAt: new Date().toISOString(),
        count: 1,
        title: 'Mermaid Export',
      },
    );

    const turnText = document.querySelector('.gv-print-turn-assistant .gv-print-turn-text');
    const styleText = document.getElementById('gv-pdf-print-styles')?.textContent ?? '';
    const mermaidImage = turnText?.querySelector<HTMLImageElement>(
      '.gv-export-mermaid img.gv-export-mermaid-image',
    );
    const dataUrl = mermaidImage?.getAttribute('src') || '';
    expect(mermaidImage).toBeTruthy();
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(turnText?.querySelector('.gv-export-mermaid svg')).toBeNull();
    expect(turnText?.querySelector('pre, code-block, .gv-mermaid-toggle')).toBeNull();
    expect(styleText).toContain('.gv-print-turn-text .gv-export-mermaid');
    expect(styleText).toContain('.gv-print-turn-text .gv-export-mermaid > img {');
    expect(styleText).toContain('display: block !important;');
    expect(styleText).toContain('break-inside: avoid;');
    expect(styleText).toContain('page-break-inside: avoid;');
    expect(styleText).toContain('max-width: 100%;');
    expect(styleText).toContain('height: auto;');
    expect(styleText).toContain('max-height: 160mm;');
    expect(styleText).toContain('object-fit: contain;');
    expect(vi.mocked(renderElementToImageBlob)).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ pixelRatio: 2 }),
    );
    expect(turnText?.textContent).not.toContain('核心能力构建');
    expect(
      turnText?.querySelector('.gv-export-mermaid')?.getAttribute('data-gv-mermaid-theme'),
    ).toBe('light');
    expect(styleText).not.toContain('.gv-export-mermaid[data-gv-mermaid-theme="dark"]');
    expect(styleText).not.toContain('background: #1f2020;');
    expect(styleText).toContain('print-color-adjust: exact;');
    expect(styleText).toContain('-webkit-print-color-adjust: exact;');
  });

  it('falls back to an isolated Mermaid SVG image when rasterization fails', async () => {
    window.print = vi.fn();
    vi.mocked(renderElementToImageBlob).mockRejectedValueOnce(
      new Error('Mermaid rasterization failed'),
    );
    const assistantElement = document.createElement('div');
    assistantElement.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
            <code-block style="display: none;">
              <div class="code-block-decoration">mermaid</div>
              <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
            </code-block>
            <div class="gv-mermaid-diagram">
              <svg aria-label="Workflow diagram" viewBox="0 0 640 480">
                <g><text>A</text><text>B</text></g>
              </svg>
            </div>
          </div>
        </div>
      </message-content>
    `;

    await PDFPrintService.export(
      [{ user: 'Diagram', assistant: '', starred: false, assistantElement }],
      {
        url: 'https://gemini.google.com/app/x',
        exportedAt: new Date().toISOString(),
        count: 1,
        title: 'Mermaid Fallback Export',
      },
    );

    const wrapper = document.querySelector<HTMLElement>(
      '.gv-print-turn-assistant .gv-export-mermaid',
    );
    const image = wrapper?.querySelector<HTMLImageElement>('img.gv-export-mermaid-image');
    expect(image?.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(image?.alt).toBe('Workflow diagram');
    expect(wrapper?.querySelector('svg')).toBeNull();
    expect(wrapper?.getAttribute('data-gv-mermaid-theme')).toBe('light');
  });

  it('normalizes metadata title suffix when page title is generic', async () => {
    document.title = 'Gemini';
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: '房贷还款方式对比分析 - Gemini',
    });

    const coverTitle = document.querySelector('.gv-print-cover-title');
    expect(coverTitle?.textContent).toBe('房贷还款方式对比分析');
  });

  it('extracts title from native sidebar by conversation id and restores page title after print', async () => {
    vi.useFakeTimers();
    document.title = 'Google Gemini';
    window.print = vi.fn();

    window.history.pushState({}, '', '/app/abc12345');
    const nativeConversation = document.createElement('div');
    nativeConversation.setAttribute('data-test-id', 'conversation');
    nativeConversation.setAttribute('jslog', 'x c_abc12345 y');
    const link = document.createElement('a');
    link.setAttribute('href', '/app/abc12345');
    const text = document.createElement('span');
    text.className = 'conversation-title-text';
    text.textContent = '房贷还款方式对比分析';
    link.appendChild(text);
    nativeConversation.appendChild(link);
    document.body.appendChild(nativeConversation);

    const exportPromise = PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/abc12345',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Untitled Conversation',
    });

    await vi.advanceTimersByTimeAsync(100);
    await exportPromise;

    const coverTitle = document.querySelector('.gv-print-cover-title');
    expect(coverTitle?.textContent).toBe('房贷还款方式对比分析');
    expect(document.title).toBe('房贷还款方式对比分析 - Gemini');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('Google Gemini');
  });

  it('keeps omitEmptySections behavior for selected exports', async () => {
    document.title = 'Original Title';
    window.print = vi.fn();

    await PDFPrintService.export(
      [
        {
          user: '',
          assistant: 'Assistant only message',
          starred: false,
          omitEmptySections: true,
        },
      ],
      {
        url: 'https://gemini.google.com/app/x',
        exportedAt: new Date().toISOString(),
        count: 1,
        title: 'Selection Export',
      },
    );

    const userSection = document.querySelector('.gv-print-turn-user');
    const assistantSection = document.querySelector('.gv-print-turn-assistant');
    expect(userSection).toBeNull();
    expect(assistantSection?.textContent).toContain('Assistant only message');
  });

  it('still calls window.print when bridge element exists but has no listener', async () => {
    window.print = vi.fn();
    const bridge = document.createElement('div');
    bridge.id = 'gv-print-bridge';
    document.body.appendChild(bridge);

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Bridge Fallback',
    });

    expect(window.print).toHaveBeenCalledOnce();
  });

  it('escapes quotes in header link href attribute', async () => {
    window.print = vi.fn();

    await PDFPrintService.export([{ user: 'u', assistant: 'a', starred: false }], {
      url: 'https://gemini.google.com/app/x" onclick="alert(1)',
      exportedAt: new Date().toISOString(),
      count: 1,
      title: 'Attribute Escape',
    });

    const link = document.querySelector('.gv-print-meta a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('onclick')).toBeNull();
    expect(link?.getAttribute('href')).toContain('" onclick="');
  });

  it('handles special CSS characters in conversation id selectors', () => {
    const conversationId = 'ab"]\\cd';
    const nativeConversation = document.createElement('div');
    nativeConversation.setAttribute('data-test-id', 'conversation');
    nativeConversation.setAttribute('jslog', `x c_${conversationId} y`);

    const link = document.createElement('a');
    link.setAttribute('href', `/app/${conversationId}`);
    const text = document.createElement('span');
    text.className = 'conversation-title-text';
    text.textContent = 'Escaped Selector Title';
    link.appendChild(text);
    nativeConversation.appendChild(link);
    document.body.appendChild(nativeConversation);

    let title: string | null = null;
    expect(() => {
      title = (
        PDFPrintService as unknown as {
          extractTitleFromNativeSidebarByConversationId: (id: unknown) => string | null;
        }
      ).extractTitleFromNativeSidebarByConversationId(conversationId);
    }).not.toThrow();
    expect(title).toBe('Escaped Selector Title');
  });
});
