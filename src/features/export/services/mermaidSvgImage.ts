import { renderElementToImageBlob } from './ImageRenderService';

const MERMAID_EXPORT_SELECTOR = '.gv-export-mermaid';
export const MERMAID_EXPORT_IMAGE_CLASS = 'gv-export-mermaid-image';
const MERMAID_PRINT_PIXEL_RATIO = 2;
const MERMAID_PRINT_MAX_WIDTH = 720;
const MERMAID_PRINT_MIN_WIDTH = 360;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('readAsDataURL failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

function getSvgRenderWidth(svg: SVGSVGElement): number {
  const viewBoxWidth = Number(svg.getAttribute('viewBox')?.trim().split(/\s+/)[2]);
  const preferredWidth =
    Number.isFinite(viewBoxWidth) && viewBoxWidth > 0 ? viewBoxWidth : MERMAID_PRINT_MAX_WIDTH;
  return Math.round(
    Math.min(MERMAID_PRINT_MAX_WIDTH, Math.max(MERMAID_PRINT_MIN_WIDTH, preferredWidth)),
  );
}

function createMermaidImage(svg: SVGSVGElement, src: string): HTMLImageElement {
  const image = document.createElement('img');
  image.className = MERMAID_EXPORT_IMAGE_CLASS;
  image.alt = svg.getAttribute('aria-label') || 'Mermaid diagram';
  const width = svg.getAttribute('width') || svg.style.width;
  if (width) image.style.width = width;
  if (svg.style.maxWidth) image.style.maxWidth = svg.style.maxWidth;
  image.src = src;
  return image;
}

function createIsolatedMermaidSvgImage(svg: SVGSVGElement): HTMLImageElement | null {
  try {
    const cleanSvg = svg.cloneNode(true) as SVGSVGElement;
    cleanSvg.querySelectorAll('script, template').forEach((element) => element.remove());

    const svgElements: Element[] = [cleanSvg, ...Array.from(cleanSvg.querySelectorAll('*'))];
    svgElements.forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        if (attribute.name.toLowerCase().startsWith('on')) {
          element.removeAttribute(attribute.name);
        }
      });
    });

    const serializedSvg = new XMLSerializer().serializeToString(cleanSvg);
    return createMermaidImage(
      svg,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializedSvg)}`,
    );
  } catch {
    return null;
  }
}

/**
 * Isolate Mermaid's embedded SVG styles from host-page CSS while keeping the
 * diagram as scalable SVG data rather than rasterizing it.
 */
export function isolateMermaidSvgImages(container: ParentNode): void {
  const svgs = Array.from(
    container.querySelectorAll<SVGSVGElement>(`${MERMAID_EXPORT_SELECTOR} svg`),
  );

  svgs.forEach((svg) => {
    const image = createIsolatedMermaidSvgImage(svg);
    if (image) svg.replaceWith(image);
  });
}

/**
 * Browser PDF renderers can drop Mermaid SVG text nodes. Render only the diagram
 * to a high-resolution PNG first, leaving the rest of the PDF as native text.
 */
export async function rasterizeMermaidSvgImages(container: ParentNode): Promise<void> {
  const svgs = Array.from(
    container.querySelectorAll<SVGSVGElement>(`${MERMAID_EXPORT_SELECTOR} svg`),
  );

  for (const svg of svgs) {
    const stage = document.createElement('div');
    const wrapper = svg.closest<HTMLElement>(MERMAID_EXPORT_SELECTOR);
    const renderTarget = (wrapper?.cloneNode(true) ?? svg.cloneNode(true)) as HTMLElement;
    const renderSvg = renderTarget.matches('svg')
      ? (renderTarget as unknown as SVGSVGElement)
      : renderTarget.querySelector<SVGSVGElement>('svg');
    if (!renderSvg) continue;

    const renderWidth = getSvgRenderWidth(svg);
    Object.assign(stage.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: `${renderWidth}px`,
      background: '#ffffff',
      color: '#333333',
      zIndex: '-1',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    Object.assign(renderTarget.style, {
      display: 'block',
      width: `${renderWidth}px`,
      maxWidth: 'none',
      background: '#ffffff',
    } as Partial<CSSStyleDeclaration>);
    renderSvg.style.setProperty('display', 'block', 'important');
    renderSvg.style.setProperty('width', '100%', 'important');
    renderSvg.style.setProperty('height', 'auto', 'important');
    renderSvg.style.setProperty('max-width', 'none', 'important');

    stage.appendChild(renderTarget);
    document.body.appendChild(stage);

    try {
      const blob = await renderElementToImageBlob(renderTarget, {
        pixelRatio: MERMAID_PRINT_PIXEL_RATIO,
        maxAttempts: 2,
        retryDelayMs: 120,
        shouldRetry: () => true,
      });
      svg.replaceWith(createMermaidImage(svg, await blobToDataUrl(blob)));
    } catch {
      const image = createIsolatedMermaidSvgImage(svg);
      if (image) svg.replaceWith(image);
    } finally {
      stage.remove();
    }
  }
}
