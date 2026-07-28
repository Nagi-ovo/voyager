import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepResearchPDFPrintService } from '../DeepResearchPDFPrintService';

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

describe('DeepResearchPDFPrintService', () => {
  afterEach(() => {
    try {
      window.dispatchEvent(new Event('afterprint'));
    } catch {
      /* ignore */
    }
    document.body.classList.remove('gv-deep-research-pdf-printing');
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    document.title = 'Gemini';
    vi.useRealTimers();
  });

  it('uses isolated report print container and restores page state after print', async () => {
    document.title = 'Gemini';
    window.print = vi.fn();

    await DeepResearchPDFPrintService.export({
      title: 'Deep Research Report',
      url: 'https://gemini.google.com/app/abc12345',
      exportedAt: new Date().toISOString(),
      markdown: '# Markdown title\n\nMarkdown body',
      html: '<div class="markdown-main-panel"><h2>HTML title</h2><p>HTML body</p></div>',
    });

    const container = document.getElementById('gv-deep-research-pdf-print-container');
    const report = container?.querySelector('.gv-dr-print-report');
    expect(window.print).toHaveBeenCalledOnce();
    expect(container).toBeTruthy();
    expect(report?.textContent).toContain('HTML title');
    expect(document.title).toBe('Deep Research Report');
    expect(document.body.classList.contains('gv-deep-research-pdf-printing')).toBe(true);

    window.dispatchEvent(new Event('afterprint'));

    expect(document.getElementById('gv-deep-research-pdf-print-container')).toBeNull();
    expect(document.getElementById('gv-deep-research-pdf-print-styles')).toBeNull();
    expect(document.body.classList.contains('gv-deep-research-pdf-printing')).toBe(false);
    expect(document.title).toBe('Gemini');
  });

  it('injects print rules scoped by deep research body class', async () => {
    window.print = vi.fn();

    await DeepResearchPDFPrintService.export({
      title: 'Report',
      url: 'https://gemini.google.com/app/abc12345',
      exportedAt: new Date().toISOString(),
      markdown: 'Body',
      html: '<p>Body</p>',
    });

    const style = document.getElementById('gv-deep-research-pdf-print-styles');
    const styleText = style?.textContent || '';

    expect(styleText).toContain(
      'body.gv-deep-research-pdf-printing > *:not(#gv-deep-research-pdf-print-container)',
    );
    expect(styleText).toContain('display: none !important;');
    expect(styleText).toContain(
      'body.gv-deep-research-pdf-printing #gv-deep-research-pdf-print-container *',
    );
    expect(styleText).toContain('display: revert !important;');
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
    expect(styleText).toContain('.gv-dr-print-report .katex');
    expect(styleText).toContain('line-height: 1.2 !important;');
    expect(styleText).toContain('body.gv-deep-research-pdf-printing .gv-dr-print-cover-page');
    expect(styleText).toContain('display: flex !important;');
    expect(styleText).toContain('align-items: center !important;');
    expect(styleText).toContain('justify-content: center !important;');
    expect(styleText).toContain('min-height: calc(297mm - 4cm);');
    expect(styleText).toContain('position: relative;');
    expect(styleText).toContain('position: absolute;');
    expect(styleText).toContain('transform: translate(-50%, -50%);');
    expect(styleText).toContain('html,');
    expect(styleText).toContain('body {');
    expect(styleText).toContain('background: #fff !important;');
  });

  it('isolates Mermaid SVG styles in a sanitized data image', async () => {
    window.print = vi.fn();

    await DeepResearchPDFPrintService.export({
      title: 'Report',
      url: 'https://gemini.google.com/app/abc12345',
      exportedAt: new Date().toISOString(),
      markdown: 'Body',
      html: `
        <style>.outer-style { color: red; }</style>
        <p class="outer-style" onclick="alert('unsafe')">Body</p>
        <span class="katex">x</span>
        <div class="gv-export-mermaid" data-gv-mermaid-theme="light">
          <svg viewBox="0 0 120 80" width="100%" style="max-width: 640px" onclick="alert('unsafe')">
            <style>.node { fill: red; }</style>
            <script>alert('unsafe')</script>
            <template><g></g></template>
            <g onload="alert('unsafe')"><text>Diagram</text></g>
          </svg>
        </div>
      `,
    });

    const report = document.querySelector('.gv-dr-print-report');
    const mermaidImage = report?.querySelector<HTMLImageElement>('.gv-export-mermaid img');
    const dataUrl = mermaidImage?.getAttribute('src') || '';
    const serializedSvg = decodeURIComponent(dataUrl.split(',')[1] || '');
    const styleText =
      document.getElementById('gv-deep-research-pdf-print-styles')?.textContent || '';

    expect(mermaidImage).toBeTruthy();
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(mermaidImage?.style.width).toBe('100%');
    expect(mermaidImage?.style.maxWidth).toBe('640px');
    expect(serializedSvg).toContain('<style>.node { fill: red; }</style>');
    expect(serializedSvg).not.toContain('<script');
    expect(serializedSvg).not.toContain('<template');
    expect(serializedSvg).not.toMatch(/\son[a-z]+=/i);
    expect(report?.querySelector('style')).toBeNull();
    expect(report?.querySelector('p')?.getAttribute('onclick')).toBeNull();
    expect(report?.querySelector('.katex')?.textContent).toBe('x');
    expect(report?.querySelector('.gv-export-mermaid')?.getAttribute('data-gv-mermaid-theme')).toBe(
      'light',
    );
    expect(styleText).toContain('.gv-dr-print-report .gv-export-mermaid > img');
    expect(styleText).toContain('margin: 0.75em auto;');
    expect(styleText).not.toContain('.gv-export-mermaid[data-gv-mermaid-theme="dark"]');
    expect(styleText).not.toContain('background: #1f2020;');
    expect(styleText).toContain('print-color-adjust: exact;');
    expect(styleText).toContain('-webkit-print-color-adjust: exact;');
    expect(styleText).toContain('page-break-inside: avoid;');
    expect(styleText).toContain('max-height: 160mm;');
    expect(styleText).toContain('object-fit: contain;');
  });

  it('applies Safari-only print override class and style rules', async () => {
    setUserAgentVendor(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Apple Computer, Inc.',
    );
    window.print = vi.fn();

    await DeepResearchPDFPrintService.export({
      title: 'Report',
      url: 'https://gemini.google.com/app/abc12345',
      exportedAt: new Date().toISOString(),
      markdown: 'Body',
      html: '<p>Body</p>',
    });

    expect(document.body.classList.contains('gv-deep-research-pdf-safari-printing')).toBe(true);

    const style = document.getElementById('gv-deep-research-pdf-print-styles');
    const styleText = style?.textContent || '';
    expect(styleText).toContain(
      'body.gv-deep-research-pdf-printing.gv-deep-research-pdf-safari-printing .gv-dr-print-cover-page',
    );
    expect(styleText).toContain('position: static !important;');
    expect(styleText).toContain('transform: none !important;');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.classList.contains('gv-deep-research-pdf-safari-printing')).toBe(false);
  });

  it('applies custom font size to deep research PDF print styles', async () => {
    window.print = vi.fn();

    await DeepResearchPDFPrintService.export(
      {
        title: 'Report',
        url: 'https://gemini.google.com/app/abc12345',
        exportedAt: new Date().toISOString(),
        markdown: 'Body',
        html: '<p>Body</p>',
      },
      { fontSize: 15 },
    );

    const style = document.getElementById('gv-deep-research-pdf-print-styles');
    const styleText = style?.textContent || '';
    expect(styleText).toContain('font-size: 15pt;');
    expect(styleText).toContain('font-size: 49pt;');
    expect(styleText).toContain('font-size: 16pt;');
    expect(styleText).toContain('font-size: 13pt;');
  });
});
