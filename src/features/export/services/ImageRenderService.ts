const TRANSPARENT_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const DEFAULT_OFFSCREEN_LEFT = '-100000px';
const DEFAULT_SANITIZE_SELECTOR = 'img, video, iframe, canvas, svg image';
const DEFAULT_RENDER_WIDTH = 720;
const MATH_RENDER_SELECTOR = '.katex, .math-inline, .math-block, [data-math]';
const MERMAID_FOREIGN_OBJECT_SELECTOR = '.gv-export-mermaid svg foreignObject';
const MERMAID_FOREIGN_OBJECT_STYLE_PROPERTIES = ['color', 'fill'] as const;
const WEBKIT_TEXT_FILL_COLOR_PROPERTY = '-webkit-text-fill-color';
const FONT_FACE_RULE_TYPE = 5;
const WOFF2_SOURCE_RE = /url\((["']?)([^"')]+)\1\)\s*format\((["']?)woff2\3\)/i;

/**
 * XML 1.0 §2.2 legal chars: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 * html-to-image serializes DOM into SVG (XML 1.0). Control characters outside the legal set
 * cause the serialization to fail silently (img error Event).
 */
const XML_ILLEGAL_CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function setStyle(element: HTMLElement | SVGElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

function stripXmlIllegalChars(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (XML_ILLEGAL_CONTROL_CHAR_RE.test(node.data)) {
      node.data = node.data.replace(XML_ILLEGAL_CONTROL_CHAR_RE, '');
    }
  }
}

function inlineKatexLayoutStyles(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.katex').forEach((element) => {
    setStyle(element, 'line-height', '1.2');
    setStyle(element, 'text-indent', '0');
  });

  root.querySelectorAll<HTMLElement>('.katex .base').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
    setStyle(element, 'position', 'relative');
    setStyle(element, 'white-space', 'nowrap');
    setStyle(element, 'width', 'min-content');
  });

  root.querySelectorAll<HTMLElement>('.katex .strut').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist-t').forEach((element) => {
    setStyle(element, 'border-collapse', 'collapse');
    setStyle(element, 'display', 'inline-table');
    setStyle(element, 'table-layout', 'fixed');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist-r').forEach((element) => {
    setStyle(element, 'display', 'table-row');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist').forEach((element) => {
    setStyle(element, 'display', 'table-cell');
    setStyle(element, 'position', 'relative');
    setStyle(element, 'vertical-align', 'bottom');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist > span').forEach((element) => {
    setStyle(element, 'display', 'block');
    setStyle(element, 'height', '0');
    setStyle(element, 'position', 'relative');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist > span > span').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist > span > .pstrut').forEach((element) => {
    setStyle(element, 'overflow', 'hidden');
    setStyle(element, 'width', '0');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist-t2').forEach((element) => {
    setStyle(element, 'margin-right', '-2px');
  });

  root.querySelectorAll<HTMLElement>('.katex .vlist-s').forEach((element) => {
    setStyle(element, 'display', 'table-cell');
    setStyle(element, 'font-size', '1px');
    setStyle(element, 'min-width', '2px');
    setStyle(element, 'vertical-align', 'bottom');
    setStyle(element, 'width', '2px');
  });

  root.querySelectorAll<HTMLElement>('.katex .vbox').forEach((element) => {
    setStyle(element, 'align-items', 'baseline');
    setStyle(element, 'display', 'inline-flex');
    setStyle(element, 'flex-direction', 'column');
  });

  root.querySelectorAll<HTMLElement>('.katex .hbox').forEach((element) => {
    setStyle(element, 'display', 'inline-flex');
    setStyle(element, 'flex-direction', 'row');
    setStyle(element, 'width', '100%');
  });

  root.querySelectorAll<HTMLElement>('.katex .thinbox').forEach((element) => {
    setStyle(element, 'display', 'inline-flex');
    setStyle(element, 'flex-direction', 'row');
    setStyle(element, 'max-width', '0');
    setStyle(element, 'width', '0');
  });

  root.querySelectorAll<HTMLElement>('.katex .mfrac > span > span').forEach((element) => {
    setStyle(element, 'text-align', 'center');
  });

  root
    .querySelectorAll<HTMLElement>(
      '.katex .mfrac .frac-line, .katex .overline .overline-line, .katex .underline .underline-line, .katex .hline, .katex .hdashline',
    )
    .forEach((element) => {
      const lineStyle = element.classList.contains('hdashline') ? 'dashed' : 'solid';
      setStyle(element, 'border-bottom-style', lineStyle);
      setStyle(element, 'display', 'inline-block');
      setStyle(element, 'min-height', '1px');
      setStyle(element, 'width', '100%');
    });

  root.querySelectorAll<HTMLElement>('.katex .mspace').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
  });

  root.querySelectorAll<HTMLElement>('.katex .rule').forEach((element) => {
    setStyle(element, 'border', '0 solid');
    setStyle(element, 'display', 'inline-block');
    setStyle(element, 'min-height', '1px');
    setStyle(element, 'position', 'relative');
  });

  root.querySelectorAll<HTMLElement>('.katex .sqrt > .root').forEach((element) => {
    setStyle(element, 'margin-left', '0.2777777778em');
    setStyle(element, 'margin-right', '-0.5555555556em');
  });

  root.querySelectorAll<HTMLElement>('.katex .nulldelimiter').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
    setStyle(element, 'width', '0.12em');
  });
}

function inlineKatexSvgStyles(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.katex .stretchy').forEach((element) => {
    setStyle(element, 'display', 'block');
    setStyle(element, 'overflow', 'hidden');
    setStyle(element, 'position', 'relative');
    setStyle(element, 'width', '100%');
  });

  // KaTeX's own stylesheet leaves .hide-tail at the `.vlist > span > span`
  // inline-block display; forcing `block` breaks it onto its own line below
  // the pstrut, dropping the radical glyph ~3em under the radicand (#789).
  root.querySelectorAll<HTMLElement>('.katex .hide-tail').forEach((element) => {
    setStyle(element, 'display', 'inline-block');
    setStyle(element, 'overflow', 'hidden');
    setStyle(element, 'position', 'relative');
    setStyle(element, 'width', '100%');
  });

  root.querySelectorAll<HTMLElement>('.katex .svg-align').forEach((element) => {
    setStyle(element, 'text-align', 'left');
  });

  root.querySelectorAll<SVGSVGElement>('.katex svg').forEach((svg) => {
    setStyle(svg, 'display', 'block');
    setStyle(svg, 'fill', 'currentColor');
    setStyle(svg, 'height', 'inherit');
    setStyle(svg, 'position', 'absolute');
    setStyle(svg, 'stroke', 'currentColor');
    setStyle(svg, 'width', '100%');
  });

  root.querySelectorAll<SVGPathElement>('.katex svg path').forEach((path) => {
    setStyle(path, 'stroke', 'none');
  });

  root.querySelectorAll<HTMLImageElement>('.katex img.katex-svg').forEach((img) => {
    setStyle(img, 'display', 'block');
    setStyle(img, 'height', 'inherit');
    setStyle(img, 'margin', '0');
    setStyle(img, 'max-width', 'none');
    setStyle(img, 'object-fit', 'fill');
    setStyle(img, 'position', 'absolute');
    setStyle(img, 'width', '100%');
  });
}

function inlineMermaidForeignObjectStyles(root: HTMLElement): void {
  root
    .querySelectorAll<SVGForeignObjectElement>(MERMAID_FOREIGN_OBJECT_SELECTOR)
    .forEach((foreignObject) => {
      foreignObject.querySelectorAll<HTMLElement>('*').forEach((element) => {
        const computedStyle = getComputedStyle(element);
        MERMAID_FOREIGN_OBJECT_STYLE_PROPERTIES.forEach((property) => {
          const value = computedStyle.getPropertyValue(property);
          if (value) setStyle(element, property, value);
        });
        const color = computedStyle.getPropertyValue('color');
        if (color) setStyle(element, WEBKIT_TEXT_FILL_COLOR_PROPERTY, color);
      });
    });
}

function hasMathContent(target: HTMLElement): boolean {
  return target.matches(MATH_RENDER_SELECTOR) || !!target.querySelector(MATH_RENDER_SELECTOR);
}

function normalizeFontFamily(font: string): string {
  return font.trim().replace(/^["']|["']$/g, '');
}

function collectUsedFontFamilies(root: HTMLElement): Set<string> {
  const fonts = new Set<string>();
  [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].forEach((element) => {
    const fontFamily = element.style.fontFamily || getComputedStyle(element).fontFamily;
    fontFamily
      .split(',')
      .map(normalizeFontFamily)
      .forEach((font) => {
        if (font) fonts.add(font);
      });
  });
  return fonts;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('readAsDataURL failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

async function resolveFontUrlAsDataUrl(url: string, baseUrl: string | null): Promise<string> {
  if (/^data:/i.test(url)) return url;

  const resolvedUrl = baseUrl ? new URL(url, baseUrl).href : new URL(url, document.baseURI).href;
  const response = await fetch(resolvedUrl);
  if (!response.ok) {
    throw new Error(`Font fetch failed (${response.status})`);
  }
  return await blobToDataUrl(await response.blob());
}

type FontFaceRuleData = {
  baseUrl: string | null;
  display: string;
  family: string;
  stretch: string;
  style: string;
  weight: string;
  src: string;
};

async function inlineWoff2Source(rule: FontFaceRuleData): Promise<string | null> {
  const match = WOFF2_SOURCE_RE.exec(rule.src);
  const fontUrl = match?.[2];
  if (!fontUrl) return null;

  try {
    const dataUrl = await resolveFontUrlAsDataUrl(fontUrl, rule.baseUrl);
    const declarations = [
      `font-family: ${rule.family}`,
      rule.style ? `font-style: ${rule.style}` : '',
      rule.weight ? `font-weight: ${rule.weight}` : '',
      rule.stretch ? `font-stretch: ${rule.stretch}` : '',
      rule.display ? `font-display: ${rule.display}` : '',
      `src: url(${dataUrl}) format("woff2")`,
    ].filter(Boolean);
    return `@font-face { ${declarations.join('; ')}; }`;
  } catch {
    return null;
  }
}

async function buildKatexFontEmbedCss(target: HTMLElement): Promise<string> {
  const usedFonts = collectUsedFontFamilies(target);
  if (usedFonts.size === 0) return '';

  const rules: FontFaceRuleData[] = [];

  Array.from(target.ownerDocument.styleSheets).forEach((sheet) => {
    let cssRules: CSSRuleList | undefined;
    try {
      cssRules = sheet.cssRules;
    } catch {
      return;
    }

    Array.from(cssRules || []).forEach((rule) => {
      if (rule.type !== FONT_FACE_RULE_TYPE || !('style' in rule)) return;

      const fontRule = rule as CSSFontFaceRule;
      const family = normalizeFontFamily(fontRule.style.getPropertyValue('font-family'));
      if (!family.startsWith('KaTeX_') || !usedFonts.has(family)) return;

      rules.push({
        baseUrl: fontRule.parentStyleSheet?.href ?? sheet.href ?? target.ownerDocument.baseURI,
        display: fontRule.style.getPropertyValue('font-display'),
        family,
        stretch: fontRule.style.getPropertyValue('font-stretch'),
        style: fontRule.style.getPropertyValue('font-style'),
        weight: fontRule.style.getPropertyValue('font-weight'),
        src: fontRule.style.getPropertyValue('src'),
      });
    });
  });

  const inlinedRules = await Promise.all(rules.map((rule) => inlineWoff2Source(rule)));
  return inlinedRules.filter((rule): rule is string => Boolean(rule)).join('\n');
}

export type RenderElementToImageBlobOptions = {
  pixelRatio?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  enableSanitizedFallback?: boolean;
  sanitizeSelector?: string;
  shouldFallback?: (error: unknown) => boolean;
};

export function isImageResourceRenderError(error: unknown): boolean {
  if (error instanceof Event) return true;
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('image') ||
    message.includes('fetch') ||
    message.includes('decode') ||
    message.includes('resource') ||
    message.includes('taint') ||
    message.includes('canvas')
  );
}

async function renderTargetToBlob(target: HTMLElement, pixelRatio: number): Promise<Blob> {
  stripXmlIllegalChars(target);
  inlineKatexLayoutStyles(target);
  inlineKatexSvgStyles(target);
  inlineMermaidForeignObjectStyles(target);
  const containsMath = hasMathContent(target);
  const { toBlob } = await import('html-to-image');
  const blob = await toBlob(target, {
    cacheBust: true,
    pixelRatio,
    backgroundColor: '#ffffff',
    skipFonts: !containsMath,
    fontEmbedCSS: containsMath ? await buildKatexFontEmbedCss(target) : undefined,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    onImageErrorHandler: () => undefined,
  });

  if (!blob) {
    const rect = target.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    throw new Error(`Image render failed (${width}x${height})`);
  }

  return blob;
}

function sanitizeClone(target: HTMLElement, selector: string): HTMLElement {
  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(selector).forEach((element) => element.remove());
  return clone;
}

function resolveRenderableWidth(target: HTMLElement): number {
  let current: HTMLElement | null = target;
  let depth = 0;
  while (current && depth < 12) {
    const width = Math.round(current.getBoundingClientRect().width);
    if (Number.isFinite(width) && width > 24) {
      return width;
    }
    current = current.parentElement;
    depth += 1;
  }

  const viewportWidth = Math.round(globalThis.innerWidth || 0);
  if (viewportWidth > 24) {
    const preferred = Math.round(viewportWidth * 0.8);
    return Math.max(360, Math.min(preferred, 1200));
  }

  return DEFAULT_RENDER_WIDTH;
}

async function renderUsingSanitizedClone(
  target: HTMLElement,
  selector: string,
  pixelRatio: number,
): Promise<Blob> {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = DEFAULT_OFFSCREEN_LEFT;
  container.style.top = '0';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';

  const renderRoot = document.createElement('div');
  renderRoot.style.display = 'block';
  renderRoot.style.width = `${resolveRenderableWidth(target)}px`;
  renderRoot.style.background = '#ffffff';

  const clone = sanitizeClone(target, selector);
  renderRoot.appendChild(clone);
  container.appendChild(renderRoot);
  document.body.appendChild(container);

  try {
    return await renderTargetToBlob(renderRoot, pixelRatio);
  } finally {
    container.remove();
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renderElementToImageBlob(
  target: HTMLElement,
  options: RenderElementToImageBlobOptions = {},
): Promise<Blob> {
  const pixelRatio = Math.max(1, options.pixelRatio ?? 1.2);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const shouldRetry = options.shouldRetry ?? (() => false);

  let primaryError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await renderTargetToBlob(target, pixelRatio);
    } catch (error) {
      primaryError = error;
      const canRetry = attempt < maxAttempts && shouldRetry(error);
      if (!canRetry) break;
      if (retryDelayMs > 0) {
        await delay(retryDelayMs * attempt);
      }
    }
  }

  if (!options.enableSanitizedFallback) {
    throw primaryError;
  }

  const shouldFallback = options.shouldFallback ?? isImageResourceRenderError;
  if (!shouldFallback(primaryError)) {
    throw primaryError;
  }

  return await renderUsingSanitizedClone(
    target,
    options.sanitizeSelector ?? DEFAULT_SANITIZE_SELECTOR,
    pixelRatio,
  );
}
