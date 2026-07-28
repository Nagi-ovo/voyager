import { toBlob } from 'html-to-image';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderElementToImageBlob } from '../ImageRenderService';

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(),
}));

describe('ImageRenderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('[data-gv-test-style]').forEach((element) => element.remove());
  });

  it('renders element to blob directly when primary render succeeds', async () => {
    const target = document.createElement('div');
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    const result = await renderElementToImageBlob(target);

    expect(result).toBe(blob);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ pixelRatio: 1.2, skipFonts: true }),
    );
  });

  it('uses the requested pixel ratio', async () => {
    const target = document.createElement('div');
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target, { pixelRatio: 2 });

    expect(toBlob).toHaveBeenCalledWith(target, expect.objectContaining({ pixelRatio: 2 }));
  });

  it('embeds fonts for math content so KaTeX radicals render correctly', async () => {
    const target = document.createElement('div');
    target.innerHTML = '<span class="math-inline" data-math="\\sqrt{x}">sqrt</span>';
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    expect(toBlob).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ fontEmbedCSS: expect.any(String), skipFonts: false }),
    );
  });

  it('passes scoped KaTeX font CSS instead of scanning page stylesheets', async () => {
    const style = document.createElement('style');
    style.dataset.gvTestStyle = 'katex-font';
    style.textContent = `
      @font-face {
        font-family: KaTeX_Main;
        src:
          url(data:font/woff2;base64,AAAA) format("woff2"),
          url(https://example.com/katex-main.woff) format("woff");
      }

      .katex {
        font-family: KaTeX_Main;
      }
    `;
    document.head.appendChild(style);

    const target = document.createElement('div');
    target.innerHTML = '<span class="katex"><span class="base">x</span></span>';
    document.body.appendChild(target);
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    const options = (toBlob as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      fontEmbedCSS?: string;
      skipFonts?: boolean;
    };
    expect(options.skipFonts).toBe(false);
    expect(options.fontEmbedCSS).toContain('font-family: KaTeX_Main');
    expect(options.fontEmbedCSS).toContain('data:font/woff2;base64,AAAA');
    expect(options.fontEmbedCSS).not.toContain('katex-main.woff');
  });

  it('inlines KaTeX radical SVG layout before rendering', async () => {
    const target = document.createElement('div');
    target.innerHTML = `
      <span class="katex">
        <span class="sqrt">
          <span class="svg-align">
            <span class="hide-tail">
              <svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"></path></svg>
              <img class="katex-svg" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" />
            </span>
          </span>
        </span>
      </span>
    `;
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    const wrapper = target.querySelector('.hide-tail') as HTMLElement | null;
    const aligner = target.querySelector('.svg-align') as HTMLElement | null;
    const svg = target.querySelector('svg') as SVGSVGElement | null;
    const img = target.querySelector('img.katex-svg') as HTMLImageElement | null;
    const path = target.querySelector('path') as SVGPathElement | null;

    // Regression guard (#789): .hide-tail must stay inline-block so it shares
    // a line box with the KaTeX pstrut; `block` drops the radical ~3em down.
    expect(wrapper?.style.getPropertyValue('display')).toBe('inline-block');
    expect(wrapper?.style.getPropertyPriority('display')).toBe('important');
    expect(wrapper?.style.getPropertyValue('overflow')).toBe('hidden');
    expect(wrapper?.style.getPropertyValue('position')).toBe('relative');
    expect(wrapper?.style.getPropertyValue('width')).toBe('100%');
    expect(aligner?.style.getPropertyValue('text-align')).toBe('left');
    expect(svg?.style.getPropertyValue('display')).toBe('block');
    expect(svg?.style.getPropertyValue('fill')).toBe('currentColor');
    expect(svg?.style.getPropertyValue('height')).toBe('inherit');
    expect(svg?.style.getPropertyValue('position')).toBe('absolute');
    expect(svg?.style.getPropertyValue('stroke')).toBe('currentColor');
    expect(svg?.style.getPropertyValue('width')).toBe('100%');
    expect(img?.style.getPropertyValue('display')).toBe('block');
    expect(img?.style.getPropertyValue('height')).toBe('inherit');
    expect(img?.style.getPropertyValue('margin')).toBe('0px');
    expect(img?.style.getPropertyValue('max-width')).toBe('none');
    expect(img?.style.getPropertyValue('object-fit')).toBe('fill');
    expect(img?.style.getPropertyValue('position')).toBe('absolute');
    expect(img?.style.getPropertyValue('width')).toBe('100%');
    expect(path?.style.getPropertyValue('stroke')).toBe('none');
  });

  it('inlines KaTeX vlist layout before rendering radical formulas', async () => {
    const target = document.createElement('div');
    target.innerHTML = `
      <span class="katex">
        <span class="base">
          <span class="sqrt">
            <span class="root">3</span>
            <span class="vlist-t vlist-t2">
              <span class="vlist-r">
                <span class="vlist">
                  <span style="top: -0.9em;">
                    <span class="pstrut"></span>
                    <span class="mord">x</span>
                  </span>
                </span>
                <span class="vlist-s"> </span>
              </span>
            </span>
          </span>
        </span>
      </span>
    `;
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    const katex = target.querySelector('.katex') as HTMLElement | null;
    const base = target.querySelector('.base') as HTMLElement | null;
    const vlistTable = target.querySelector('.vlist-t') as HTMLElement | null;
    const vlistRow = target.querySelector('.vlist-r') as HTMLElement | null;
    const vlist = target.querySelector('.vlist') as HTMLElement | null;
    const vlistSpan = target.querySelector('.vlist > span') as HTMLElement | null;
    const pstrut = target.querySelector('.pstrut') as HTMLElement | null;
    const spacer = target.querySelector('.vlist-s') as HTMLElement | null;
    const root = target.querySelector('.sqrt > .root') as HTMLElement | null;

    expect(katex?.style.getPropertyValue('line-height')).toBe('1.2');
    expect(base?.style.getPropertyValue('display')).toBe('inline-block');
    expect(base?.style.getPropertyValue('white-space')).toBe('nowrap');
    expect(base?.style.getPropertyValue('width')).toBe('min-content');
    expect(vlistTable?.style.getPropertyValue('display')).toBe('inline-table');
    expect(vlistTable?.style.getPropertyValue('border-collapse')).toBe('collapse');
    expect(vlistTable?.style.getPropertyValue('table-layout')).toBe('fixed');
    expect(vlistRow?.style.getPropertyValue('display')).toBe('table-row');
    expect(vlist?.style.getPropertyValue('display')).toBe('table-cell');
    expect(vlist?.style.getPropertyValue('vertical-align')).toBe('bottom');
    expect(vlistSpan?.style.getPropertyValue('display')).toBe('block');
    expect(vlistSpan?.style.getPropertyValue('height')).toBe('0px');
    expect(pstrut?.style.getPropertyValue('overflow')).toBe('hidden');
    expect(pstrut?.style.getPropertyValue('width')).toBe('0px');
    expect(spacer?.style.getPropertyValue('display')).toBe('table-cell');
    expect(spacer?.style.getPropertyValue('min-width')).toBe('2px');
    expect(root?.style.getPropertyValue('margin-left')).toBe('0.2777777778em');
    expect(root?.style.getPropertyValue('margin-right')).toBe('-0.5555555556em');
    expect(root?.style.getPropertyPriority('margin-left')).toBe('important');
  });

  it('inlines Mermaid foreignObject label colors before rendering', async () => {
    const style = document.createElement('style');
    style.dataset.gvTestStyle = 'mermaid-label';
    style.textContent = `
      .nodeLabel,
      .ordinaryLabel {
        color: rgb(204, 204, 204);
        fill: rgb(204, 204, 204);
      }
    `;
    document.head.appendChild(style);

    const target = document.createElement('div');
    target.innerHTML = `
      <div class="gv-export-mermaid" data-gv-mermaid-theme="dark">
        <svg xmlns="http://www.w3.org/2000/svg">
          <foreignObject>
            <div xmlns="http://www.w3.org/1999/xhtml">
              <span class="nodeLabel">Analysis</span>
            </div>
          </foreignObject>
        </svg>
      </div>
      <svg xmlns="http://www.w3.org/2000/svg">
        <foreignObject>
          <div xmlns="http://www.w3.org/1999/xhtml">
            <span class="ordinaryLabel">Untouched</span>
          </div>
        </foreignObject>
      </svg>
    `;
    document.body.appendChild(target);
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    const label = target.querySelector<HTMLElement>('.nodeLabel');
    const ordinaryLabel = target.querySelector<HTMLElement>('.ordinaryLabel');
    expect(label?.style.getPropertyValue('color')).toBe('rgb(204, 204, 204)');
    expect(label?.style.getPropertyValue('fill')).toBe('rgb(204, 204, 204)');
    expect(label?.style.getPropertyValue('-webkit-text-fill-color')).toBe('rgb(204, 204, 204)');
    expect(label?.style.getPropertyPriority('color')).toBe('important');
    expect(ordinaryLabel?.style.getPropertyValue('color')).toBe('');
    expect(ordinaryLabel?.style.getPropertyValue('fill')).toBe('');
    expect(ordinaryLabel?.style.getPropertyValue('-webkit-text-fill-color')).toBe('');
  });

  it('retries when shouldRetry returns true and later succeeds', async () => {
    const target = document.createElement('div');
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Event('error'))
      .mockResolvedValueOnce(blob);

    const result = await renderElementToImageBlob(target, {
      maxAttempts: 2,
      retryDelayMs: 0,
      shouldRetry: (error) => error instanceof Event,
    });

    expect(result).toBe(blob);
    expect(toBlob).toHaveBeenCalledTimes(2);
  });

  it('falls back to sanitized clone when resource rendering fails', async () => {
    const target = document.createElement('div');
    const image = document.createElement('img');
    image.src = 'https://example.com/fail.png';
    target.appendChild(image);
    document.body.appendChild(target);

    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Failed to fetch resource'))
      .mockResolvedValueOnce(blob);

    const result = await renderElementToImageBlob(target, {
      enableSanitizedFallback: true,
    });

    expect(result).toBe(blob);
    expect(toBlob).toHaveBeenCalledTimes(2);

    const secondTarget = (toBlob as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondTarget).not.toBe(target);
    expect((secondTarget as HTMLElement).querySelector('img')).toBeNull();
  });

  it('strips XML-illegal control characters before rendering', async () => {
    const target = document.createElement('div');
    target.textContent = 'hello\x01world\x08test';
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    const result = await renderElementToImageBlob(target);

    expect(result).toBe(blob);
    expect(target.textContent).toBe('helloworldtest');
  });

  it('preserves valid whitespace characters (tab, LF, CR) during rendering', async () => {
    const target = document.createElement('div');
    target.textContent = 'line1\tindented\nline2\rline3';
    const blob = new Blob(['ok'], { type: 'image/png' });
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(blob);

    await renderElementToImageBlob(target);

    expect(target.textContent).toBe('line1\tindented\nline2\rline3');
  });

  it('uses fallback render root with non-zero width for zero-size targets', async () => {
    const target = document.createElement('div');
    target.textContent = 'fallback';
    document.body.appendChild(target);

    let callCount = 0;
    (toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (node: HTMLElement) => {
        callCount += 1;
        if (callCount === 1) {
          return null;
        }
        const width = Number.parseInt(node.style.width || '0', 10);
        if (width > 0) {
          return new Blob(['ok'], { type: 'image/png' });
        }
        return null;
      },
    );

    const result = await renderElementToImageBlob(target, {
      enableSanitizedFallback: true,
      shouldFallback: () => true,
    });

    expect(result).toBeInstanceOf(Blob);
    expect(toBlob).toHaveBeenCalledTimes(2);
    const secondTarget = (toBlob as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(Number.parseInt((secondTarget as HTMLElement).style.width || '0', 10)).toBeGreaterThan(
      0,
    );
  });
});
