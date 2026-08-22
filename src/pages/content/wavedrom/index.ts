/**
 * WaveDrom renderer for Gemini Voyager.
 *
 * Detects WaveJSON code blocks rendered by Gemini and replaces them with
 * interactive SVG timing diagrams, following the same pattern as the Mermaid
 * renderer. WaveDrom is dynamically imported to keep the content-script bundle
 * lean; the library is only fetched once a WaveJSON block is detected.
 *
 * Theme notes (ported from AionUi):
 *  - The bundled dark skin paints wave strokes in pure white, so the diagram
 *    backdrop must always pair with the selected skin. Resolving it through a
 *    CSS variable is unsafe when that variable falls back to the wrong value.
 *  - The dark skin's multi-bit fill classes (s6, s8–s15) are near-black and
 *    disappear on Gemini's dark page. They are remapped to mid-tone colours.
 *  - The default theme mode is 'light': the light diagram (dark strokes on a
 *    light backdrop) is readable on any Gemini theme and sidesteps the dark
 *    skin's white-stroke contrast issues entirely.
 */
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { isGenericLanguageLabel } from '../mermaid/index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** WaveDrom theme policy (mirrors AionUi's WaveThemeMode). */
export type WaveThemeMode = 'auto' | 'light';

/** Resolve the effective diagram render theme from the policy + app theme. */
export const resolveWaveRenderTheme = (
  mode: WaveThemeMode,
  appTheme: 'light' | 'dark',
): 'light' | 'dark' => (mode === 'auto' ? appTheme : 'light');

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/**
 * Resolve an i18n string with a safe fallback. Content scripts must not throw
 * when the extension context is invalidated mid-flight, hence the guard.
 */
const t = (key: string, fallback: string): string => {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hardcoded to 'light': the light diagram stays readable on any Gemini theme.
 * Flip to 'auto' to restore theme-following (and the dark skin's issues).
 */
const WAVEDROM_THEME_MODE: WaveThemeMode = 'light';

/**
 * Deterministic backdrop colours paired to the skin.
 * Using the exact colour values instead of CSS tokens avoids the failure mode
 * where a token resolves to the wrong value (e.g. white strokes on white).
 */
const PANEL_BG: Record<'light' | 'dark', string> = {
  light: '#f9fafb',
  dark: '#1a1a1a',
};

/**
 * The bundled dark skin's near-black fill classes (gap + multi-bit labels).
 * Remapped to mid-tone colours visible on the dark Gemini page.
 */
const DARK_SKIN_FILL_REMAP: Record<string, string> = {
  s6: '#4a4a4a', // gap (no signal)
  s8: '#5c5c5c', // multi-bit value '2'
  s9: '#3050b8', // '3'
  s10: '#4a8a2a', // '4'
  s11: '#b04a3a', // '5'
  s12: '#1a8a90', // '6'
  s13: '#8a3a8a', // '7'
  s14: '#7a7a7a', // '8'
  s15: '#7a4ac0', // '9'
};

// ---------------------------------------------------------------------------
// Dark-skin fill remap
// ---------------------------------------------------------------------------

/**
 * Replace the near-black `fill` values of the bundled dark skin's s6/s8–s15
 * classes with the dark-page-visible palette above.
 *
 * @internal Exported for testing.
 */
export const remapDarkSkinStyle = (styleText: string): string => {
  let remapped = styleText;
  for (const [className, fill] of Object.entries(DARK_SKIN_FILL_REMAP)) {
    remapped = remapped.replace(new RegExp(`\\.${className}\\{[^}]*\\}`, 'g'), (rule) =>
      rule.replace(/fill:\s*#[0-9a-fA-F]{3,8}/, `fill: ${fill}`),
    );
  }
  return remapped;
};

// ---------------------------------------------------------------------------
// Lazy WaveDrom loader
// ---------------------------------------------------------------------------

type WaveSkin = import('wavedrom').WaveSkin;
type OnmlTree = import('wavedrom').OnmlTree;
type WaveSource = import('wavedrom').WaveSource;

/** The subset of the WaveDrom API used by this renderer. */
interface WaveDromAPI {
  renderAny: (index: number, source: WaveSource, waveSkin?: WaveSkin) => OnmlTree;
  onml: { stringify: (tree: OnmlTree) => string };
}

interface WaveDromBundle {
  WaveDrom: WaveDromAPI;
  waveSkinDefault: WaveSkin;
  /** Bundled dark skin with near-black fills remapped for Gemini's dark page. */
  waveSkinDarkRemapped: WaveSkin;
}

let bundleCache: WaveDromBundle | null = null;
let bundleLoadFailed = false;
let currentModal: HTMLElement | null = null;
/**
 * Teardown for the active fullscreen modal, registered at open time so the
 * singleton can be destroyed from anywhere (tests, context loss) without
 * leaking document-level listeners.
 */
let closeActiveModal: (() => void) | null = null;

/** @internal Exported for testing. */
export const _resetWaveDromLoader = () => {
  bundleCache = null;
  bundleLoadFailed = false;
};

/** @internal Close and clear the fullscreen modal singleton. For testing only. */
export const _closeModalForTest = () => {
  closeActiveModal?.();
  closeActiveModal = null;
};

/**
 * Normalise a dynamically-imported CJS module to its `module.exports` object.
 * Bundlers wrap CJS `module.exports` as the namespace `.default`; the skins
 * files export skin *collections* (`{ default: <tree> }` / `{ dark: <tree> }`),
 * never a bare ONML tree — renderAny reads `skin.default` (or the first named
 * key) before indexing into the tree, so a bare array would select the first
 * node ('svg') and throw.
 */
const asCjsExports = <T>(mod: unknown): T => {
  const exports = (mod as { default?: T }).default;
  return exports !== undefined ? exports : (mod as T);
};

/**
 * Dynamically load WaveDrom and its skins. Result is cached after the first
 * successful load; a failed load also short-circuits further attempts.
 */
const loadWaveDrom = async (): Promise<WaveDromBundle | null> => {
  if (bundleCache) return bundleCache;
  if (bundleLoadFailed) return null;

  try {
    const [renderAnyMod, stringifyMod, darkMod, defaultMod] = await Promise.all([
      import('wavedrom/render-any'),
      import('onml/stringify.js'),
      import('wavedrom/skins/dark.js'),
      import('wavedrom/skins/default.js'),
    ]);

    const renderAny = asCjsExports<WaveDromAPI['renderAny']>(renderAnyMod);
    const stringify = asCjsExports<WaveDromAPI['onml']['stringify']>(stringifyMod);
    const WaveDrom: WaveDromAPI = { renderAny, onml: { stringify } };
    const waveSkinDefault = asCjsExports<WaveSkin>(defaultMod);
    const rawDarkSkin = asCjsExports<WaveSkin>(darkMod);

    // Remap the dark skin once; renderAny copies the style text verbatim so
    // remapping the shared tree covers every diagram surface.
    const waveSkinDarkRemapped = remapWaveSkinDark(rawDarkSkin);

    bundleCache = { WaveDrom, waveSkinDefault, waveSkinDarkRemapped };
    return bundleCache;
  } catch (err) {
    bundleLoadFailed = true;
    console.error('[Gemini Voyager] Failed to load WaveDrom library:', err);
    return null;
  }
};

/** Apply the fill remap to the bundled dark-skin OnmlTree. */
const remapWaveSkinDark = (rawSkin: WaveSkin): WaveSkin => {
  const original = rawSkin.dark as unknown as OnmlTree | undefined;
  if (!original) return rawSkin;
  const styleElement = original[2];
  if (
    Array.isArray(styleElement) &&
    styleElement[0] === 'style' &&
    typeof styleElement[2] === 'string'
  ) {
    const tree = [...original] as OnmlTree;
    tree[2] = [styleElement[0], styleElement[1], remapDarkSkinStyle(styleElement[2])];
    return { dark: tree as unknown as Record<string, unknown> };
  }
  return rawSkin;
};

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

let diagramIndex = 0;

/**
 * Strip fixed pixel `width`/`height` attributes from an SVG root that already
 * carries a `viewBox`, then inject `width="100%" height="100%"` so the diagram
 * fills its container (fullscreen overlay card).
 *
 * @internal Exported for testing.
 */
export const makeResponsiveSvg = (svg: string): string => {
  // Only rewrite the opening <svg …> tag.
  return svg.replace(/^(<svg\b[^>]*\bviewBox="[^"]*"[^>]*)>/, (match, attrs: string) => {
    const cleaned = attrs.replace(/\s+width="[^"]*"/g, '').replace(/\s+height="[^"]*"/g, '');
    return `${cleaned} width="100%" height="100%">`;
  });
};

/**
 * Render WaveJSON source code into a sanitised SVG string, or null when the
 * code is not a valid waveform description. Parsing is lenient (JSON5) so
 * hand-written or LLM-generated WaveJSON with comments or trailing commas
 * still renders.
 *
 * @internal Exported for testing.
 */
export const renderWaveSvg = async (code: string, isDark: boolean): Promise<string | null> => {
  const bundle = await loadWaveDrom();
  if (!bundle) return null;

  const { WaveDrom, waveSkinDefault, waveSkinDarkRemapped } = bundle;
  const skin = isDark ? waveSkinDarkRemapped : waveSkinDefault;

  try {
    const [JSON5Mod, DOMPurifyMod] = await Promise.all([import('json5'), import('dompurify')]);
    const parse = JSON5Mod.default?.parse ?? JSON5Mod.parse;
    const DOMPurify = DOMPurifyMod.default ?? DOMPurifyMod;
    const parsed: unknown = parse(code.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const source = parsed as WaveSource;
    const hasLanes =
      Array.isArray(source.signal) || Array.isArray(source.assign) || Array.isArray(source.reg);
    if (!hasLanes) return null;

    const tree = WaveDrom.renderAny(diagramIndex++, source, skin);
    const svgRaw = WaveDrom.onml.stringify(tree);
    // The SVG markup is library-generated from parsed WaveJSON, but the markup
    // still crosses innerHTML twice (inline container + fullscreen overlay), so
    // sanitise once here. The bundled dark-skin <style> block survives DOMPurify.
    const svgSanitized = DOMPurify.sanitize(svgRaw);
    return makeResponsiveSvg(svgSanitized);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// WaveJSON detection
// ---------------------------------------------------------------------------

/**
 * Return true when a code block is a WaveJSON timing diagram.
 * Requires a minimum length (to skip streaming/incomplete content) and
 * the presence of a `signal`, `assign`, or `reg` key (lenient JSON5 parse).
 *
 * @internal Exported for testing.
 */
export const isWaveJsonCode = (code: string): boolean => {
  const trimmed = code.trim();
  if (trimmed.length < 20) return false;
  // Fast path: the three top-level WaveJSON keys.
  if (!/["']?(signal|assign|reg)["']?\s*:/.test(trimmed)) return false;
  // Must look like a JSON object.
  if (!trimmed.startsWith('{')) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES_ID = 'gv-wavedrom-styles';

const createStyles = (panelBg: string) => {
  const existing = document.getElementById(STYLES_ID);
  if (existing) return;

  const style = document.createElement('style');
  style.id = STYLES_ID;
  style.textContent = `
    .gv-wavedrom-wrapper {
      position: relative;
    }

    .gv-wavedrom-toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--gemini-surface-container, rgba(0,0,0,0.05));
      border-radius: 8px;
      padding: 2px;
      border: 1px solid var(--gemini-outline-variant, rgba(0,0,0,0.1));
    }

    .gv-wavedrom-toggle button {
      padding: 4px 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Google Sans', sans-serif;
      transition: all 0.2s ease;
      background: transparent;
      color: var(--gemini-on-surface-variant, #666);
    }

    .gv-wavedrom-toggle button:hover {
      background: var(--gemini-surface-container-high, rgba(0,0,0,0.08));
    }

    .gv-wavedrom-toggle button.active {
      background: var(--gemini-primary, #1a73e8);
      color: white;
    }

    .gv-wavedrom-diagram {
      padding: 16px;
      overflow-x: auto;
      background-color: ${panelBg};
      cursor: zoom-in;
    }

    .gv-wavedrom-diagram svg {
      max-width: 100%;
      height: auto;
    }

    /* Fullscreen modal */
    .gv-wavedrom-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.9);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .gv-wavedrom-modal.visible {
      opacity: 1;
    }

    .gv-wavedrom-modal-toolbar {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      gap: 8px;
      z-index: 1000000;
    }

    .gv-wavedrom-modal-toolbar button {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.2);
      color: white;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .gv-wavedrom-modal-toolbar button:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }

    .gv-wavedrom-modal-content {
      position: relative;
      cursor: grab;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: calc(100vw - 80px);
      max-height: calc(100vh - 80px);
    }

    .gv-wavedrom-modal-content.dragging {
      cursor: grabbing;
    }

    /* SVG fills the overlay card (fix for fixed pixel width/height roots). */
    .gv-wavedrom-modal-content svg {
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
    }

    .gv-wavedrom-modal-hint {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      font-family: 'Google Sans', sans-serif;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
};

// ---------------------------------------------------------------------------
// Fullscreen overlay
// ---------------------------------------------------------------------------

/**
 * Read the intrinsic diagram size from the SVG `viewBox`.
 * The rendered width/height are forced to 100% by the overlay, so scrollWidth
 * reflects the container, not the diagram — only the viewBox carries the real
 * aspect/size needed for auto-fitting.
 *
 * @internal Exported for testing.
 */
export const parseViewBoxSize = (svgEl: SVGSVGElement): { w: number; h: number } | null => {
  const vb = svgEl.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return null;
  return { w: vb[2], h: vb[3] };
};

/**
 * Scale factor that fits an intrinsic diagram size into a viewport, clamped to
 * the 0.1–10 zoom range (1 when the inputs are unusable).
 *
 * @internal Exported for testing.
 */
export const computeAutoFitScale = (
  intrinsicW: number,
  intrinsicH: number,
  viewportW: number,
  viewportH: number,
): number => {
  if (intrinsicW <= 0 || intrinsicH <= 0 || viewportW <= 0 || viewportH <= 0) return 1;
  return Math.min(Math.max(Math.min(viewportW / intrinsicW, viewportH / intrinsicH), 0.1), 10);
};

const openFullscreen = (svgHtml: string, panelBg: string) => {
  if (currentModal) return;

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  const modal = document.createElement('div');
  modal.className = 'gv-wavedrom-modal';

  const toolbar = document.createElement('div');
  toolbar.className = 'gv-wavedrom-modal-toolbar';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.innerHTML = '+';
  zoomInBtn.title = t('wavedromZoomIn', 'Zoom In');

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '−';
  zoomOutBtn.title = t('wavedromZoomOut', 'Zoom Out');

  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '⊙';
  resetBtn.title = t('wavedromResetView', 'Reset');

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.title = t('wavedromCloseFullscreen', 'Close (ESC)');

  toolbar.append(zoomInBtn, zoomOutBtn, resetBtn, closeBtn);

  // Card with explicit backdrop so the skin's white strokes are always visible.
  const card = document.createElement('div');
  card.dataset.testid = 'wavedrom-zoom-card';
  card.style.background = panelBg;
  card.style.borderRadius = '8px';
  card.style.padding = '12px';
  card.style.flexShrink = '0';

  const content = document.createElement('div');
  content.className = 'gv-wavedrom-modal-content';
  // The markup was sanitised with DOMPurify before it was inserted into the
  // diagram container, so this innerHTML only re-inserts already-safe markup.
  content.innerHTML = svgHtml;

  // Ensure the SVG fills the card (fix: remove fixed pixel w/h if viewBox present).
  const svgEl = content.querySelector('svg');
  if (svgEl?.hasAttribute('viewBox')) {
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
  }

  card.appendChild(content);

  const hint = document.createElement('div');
  hint.className = 'gv-wavedrom-modal-hint';
  hint.textContent = t('wavedromFullscreenHint', 'Scroll to zoom • Drag to pan • ESC to close');

  modal.append(toolbar, card, hint);
  document.body.appendChild(modal);
  currentModal = modal;

  let initialScale = 1;

  const applyTransform = () => {
    content.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  const zoomIn = () => {
    scale = Math.min(scale * 1.2, 10);
    applyTransform();
  };
  const zoomOut = () => {
    scale = Math.max(scale / 1.2, 0.1);
    applyTransform();
  };
  const resetView = () => {
    scale = initialScale;
    translateX = 0;
    translateY = 0;
    applyTransform();
  };

  let closing = false;
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    applyTransform();
  };
  const handleMouseUp = () => {
    isDragging = false;
    content.classList.remove('dragging');
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let revealFrame: number | null = null;

  // Single registration point: every listener (including the document-level
  // keydown/mousemove/mouseup) is removed together on close, so no listener
  // outlives the modal even when it is torn down externally.
  const cleanupFns: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    target: EventTarget,
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, opts);
    cleanupFns.push(() => target.removeEventListener(type, listener, opts));
  };
  const removeListeners = () => {
    cleanupFns.splice(0).forEach((remove) => remove());
  };

  const destroyModal = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (revealFrame !== null) {
      cancelAnimationFrame(revealFrame);
      revealFrame = null;
    }
    removeListeners();
    handleMouseUp();
    modal.remove();
    if (currentModal === modal) currentModal = null;
    if (closeActiveModal === destroyModal) closeActiveModal = null;
  };
  const closeModal = () => {
    if (closing) return;
    closing = true;
    removeListeners();
    handleMouseUp();
    modal.classList.remove('visible');
    closeTimer = setTimeout(destroyModal, 300);
  };
  closeActiveModal = destroyModal;

  on(zoomInBtn, 'click', zoomIn);
  on(zoomOutBtn, 'click', zoomOut);
  on(resetBtn, 'click', resetView);
  on(closeBtn, 'click', closeModal);
  on(modal, 'click', (e) => {
    if (e.target === modal) closeModal();
  });
  on(document, 'keydown', handleKeyDown);
  on(
    modal,
    'wheel',
    (e) => {
      e.preventDefault();
      scale = e.deltaY < 0 ? Math.min(scale * 1.1, 10) : Math.max(scale / 1.1, 0.1);
      applyTransform();
    },
    { passive: false },
  );
  on(content, 'mousedown', (e) => {
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    content.classList.add('dragging');
  });
  on(document, 'mousemove', handleMouseMove);
  on(document, 'mouseup', handleMouseUp);

  // Auto-fit the SVG to the viewport from its intrinsic viewBox size.
  if (svgEl) {
    const padding = 80;
    const vw = window.innerWidth - padding * 2;
    const vh = window.innerHeight - padding * 2;
    const intrinsic = parseViewBoxSize(svgEl);
    const w = intrinsic?.w ?? (svgEl.scrollWidth || svgEl.clientWidth);
    const h = intrinsic?.h ?? (svgEl.scrollHeight || svgEl.clientHeight);
    if (w > 0 && h > 0) {
      const fitScale = computeAutoFitScale(w, h, vw, vh);
      // Give the SVG a definite pixel box before zooming: the overlay forces
      // width/height to 100%, which resolves against an auto-sized flex item,
      // so the browser would otherwise fall back to the default
      // replaced-element viewport (300×150) while the scale is computed from
      // the viewBox.
      svgEl.style.width = `${w * fitScale}px`;
      svgEl.style.height = `${h * fitScale}px`;
      scale = 1;
      initialScale = 1;
      applyTransform();
    }
  }

  revealFrame = requestAnimationFrame(() => {
    revealFrame = null;
    modal.classList.add('visible');
  });
};

/** @internal Exported for lifecycle testing. */
export const _openFullscreenForTest = openFullscreen;

// ---------------------------------------------------------------------------
// Code block rendering
// ---------------------------------------------------------------------------

/**
 * Resolve Gemini's active theme from the page state.
 * @internal Exported for testing.
 */
export const resolveGeminiTheme = (doc: Document, prefersDark: boolean): 'light' | 'dark' => {
  if (doc.querySelector('.theme-host.dark-theme')) return 'dark';
  if (doc.querySelector('.theme-host.light-theme')) return 'light';
  if (
    doc.body.classList.contains('dark-theme') ||
    doc.documentElement.classList.contains('dark') ||
    doc.body.getAttribute('data-theme') === 'dark'
  )
    return 'dark';
  if (
    doc.body.classList.contains('light-theme') ||
    doc.documentElement.classList.contains('light') ||
    doc.body.getAttribute('data-theme') === 'light'
  )
    return 'light';
  return prefersDark ? 'dark' : 'light';
};

const getAppTheme = (): 'light' | 'dark' =>
  resolveGeminiTheme(document, window.matchMedia('(prefers-color-scheme: dark)').matches);

interface NativeControlPlacement {
  parent: Node | null;
  nextSibling: Node | null;
  styleAttribute: string | null;
}

const nativeControlPlacements = new WeakMap<HTMLElement, NativeControlPlacement>();

/**
 * Move Gemini's native code-block copy button into the toggle toolbar.
 * The toolbar overlays the code block in Code view, so a native copy button
 * left in place gets covered. Mirrors the Mermaid renderer's approach.
 *
 * @returns the moved button, or null when no native copy button was found.
 * @internal Exported for testing.
 */
export const moveNativeCopyButton = (
  codeBlockHost: HTMLElement,
  target: HTMLElement,
): HTMLElement | null => {
  const nativeCopyBtn =
    codeBlockHost.querySelector('.buttons') || codeBlockHost.querySelector('.copy-button');
  if (!nativeCopyBtn) return null;
  const nativeCopyElement = nativeCopyBtn as HTMLElement;
  if (!nativeControlPlacements.has(nativeCopyElement)) {
    nativeControlPlacements.set(nativeCopyElement, {
      parent: nativeCopyElement.parentNode,
      nextSibling: nativeCopyElement.nextSibling,
      styleAttribute: nativeCopyElement.getAttribute('style'),
    });
  }
  // Reset positioning that might conflict with the toolbar layout.
  nativeCopyElement.style.position = 'static';
  nativeCopyElement.style.top = 'auto';
  nativeCopyElement.style.right = 'auto';
  nativeCopyElement.style.marginTop = '0';
  target.appendChild(nativeCopyElement);
  return nativeCopyElement;
};

const restoreNativeCopyButton = (nativeCopyElement: HTMLElement): boolean => {
  const placement = nativeControlPlacements.get(nativeCopyElement);
  if (!placement) return false;

  if (placement.styleAttribute === null) nativeCopyElement.removeAttribute('style');
  else nativeCopyElement.setAttribute('style', placement.styleAttribute);

  if (placement.parent) {
    const insertionPoint =
      placement.nextSibling?.parentNode === placement.parent ? placement.nextSibling : null;
    placement.parent.insertBefore(nativeCopyElement, insertionPoint);
  }
  nativeControlPlacements.delete(nativeCopyElement);
  return true;
};

let wavedromEnabled = true;
let renderGeneration = 0;

const renderWaveDrom = async (codeEl: HTMLElement, code: string) => {
  if (!wavedromEnabled) return;
  if (codeEl.dataset.wavedromCode === code) return;
  if (codeEl.dataset.wavedromProcessing === 'true') return;

  codeEl.dataset.wavedromProcessing = 'true';
  const generationAtStart = renderGeneration;

  try {
    const codeBlockHost = codeEl.closest('code-block') as HTMLElement;
    if (!codeBlockHost) {
      codeEl.dataset.wavedromProcessing = 'false';
      return;
    }

    const appTheme = getAppTheme();
    const renderTheme = resolveWaveRenderTheme(WAVEDROM_THEME_MODE, appTheme);
    const panelBg = PANEL_BG[renderTheme];

    createStyles(panelBg);

    const svg = await renderWaveSvg(code, renderTheme === 'dark');
    if (!svg) {
      codeEl.dataset.wavedromProcessing = 'false';
      return;
    }
    if (!wavedromEnabled || generationAtStart !== renderGeneration) {
      codeEl.dataset.wavedromProcessing = 'false';
      return;
    }
    const latestCode = codeEl.textContent || '';
    if (latestCode !== code) {
      codeEl.dataset.wavedromProcessing = 'false';
      void renderWaveDrom(codeEl, latestCode);
      return;
    }

    // Build or reuse the wrapper.
    let wrapper = codeBlockHost.parentElement;
    if (!wrapper?.classList.contains('gv-wavedrom-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'gv-wavedrom-wrapper';
      codeBlockHost.parentElement?.insertBefore(wrapper, codeBlockHost);
      wrapper.appendChild(codeBlockHost);

      const toggleContainer = document.createElement('div');
      toggleContainer.className = 'gv-wavedrom-toggle';

      // Move the native copy button into the toolbar so it is not covered by
      // the overlay in Code view (same fix as the Mermaid renderer).
      moveNativeCopyButton(codeBlockHost, toggleContainer);

      const diagramBtn = document.createElement('button');
      diagramBtn.textContent = t('wavedromDiagramButton', '〜 Diagram');
      diagramBtn.className = 'active';
      diagramBtn.dataset.view = 'diagram';

      const codeBtn = document.createElement('button');
      codeBtn.textContent = t('wavedromCodeButton', '</> Code');
      codeBtn.dataset.view = 'code';

      toggleContainer.append(diagramBtn, codeBtn);
      wrapper.appendChild(toggleContainer);

      const diagramContainer = document.createElement('div');
      diagramContainer.className = 'gv-wavedrom-diagram';
      wrapper.appendChild(diagramContainer);

      codeBlockHost.style.display = 'none';

      const updateView = (view: 'diagram' | 'code') => {
        if (view === 'diagram') {
          codeBlockHost.style.display = 'none';
          diagramContainer.style.display = 'block';
          diagramBtn.classList.add('active');
          codeBtn.classList.remove('active');
        } else {
          codeBlockHost.style.display = '';
          diagramContainer.style.display = 'none';
          diagramBtn.classList.remove('active');
          codeBtn.classList.add('active');
        }
      };

      diagramBtn.addEventListener('click', () => updateView('diagram'));
      codeBtn.addEventListener('click', () => updateView('code'));

      diagramContainer.addEventListener('click', () => {
        const svgEl = diagramContainer.querySelector('svg');
        if (svgEl) openFullscreen(diagramContainer.innerHTML, panelBg);
      });
    }

    // Update the backdrop if the render theme changed.
    const diagramContainer = wrapper.querySelector('.gv-wavedrom-diagram') as HTMLElement | null;
    if (!diagramContainer) {
      codeEl.dataset.wavedromProcessing = 'false';
      return;
    }
    diagramContainer.style.backgroundColor = panelBg;
    diagramContainer.innerHTML = svg;

    codeEl.dataset.wavedromCode = code;
    codeEl.dataset.wavedromProcessing = 'false';
    console.log('[Gemini Voyager] WaveDrom diagram rendered');
  } catch {
    codeEl.dataset.wavedromProcessing = 'false';
    const codeBlockHost = codeEl.closest('code-block') as HTMLElement;
    if (codeBlockHost) codeBlockHost.style.display = '';
  }
};

// ---------------------------------------------------------------------------
// Language label helpers (mirrors mermaid module)
// ---------------------------------------------------------------------------

const getCodeBlockLanguage = (codeEl: Element): string | null => {
  const codeBlock = codeEl.closest('.code-block, code-block');
  if (!codeBlock) return null;
  const decoration = codeBlock.querySelector('.code-block-decoration');
  if (!decoration) return null;
  const langSpan = decoration.querySelector(':scope > span');
  const language = langSpan?.textContent?.trim().toLowerCase();
  return language || null;
};

// ---------------------------------------------------------------------------
// processCodeBlocks + lifecycle
// ---------------------------------------------------------------------------

/**
 * @internal Exported for testing.
 */
export const processCodeBlocks = () => {
  const codeElements = document.querySelectorAll('code[data-test-id="code-content"]');
  codeElements.forEach((codeEl) => {
    const codeText = codeEl.textContent || '';
    const language = getCodeBlockLanguage(codeEl);

    // Explicit WaveDrom labels always render.
    if (language === 'wavedrom' || language === 'wavejson') {
      void renderWaveDrom(codeEl as HTMLElement, codeText);
      return;
    }

    // Specific language labels (json, typescript, …) skip WaveJSON detection:
    // WaveJSON is a niche format, and ordinary JSON output must not be
    // mistaken for a timing diagram.
    if (language && !isGenericLanguageLabel(language)) {
      return;
    }

    // Content-based detection for unlabelled / generic blocks
    // (Code snippet, 代码段, …).
    if (isWaveJsonCode(codeText)) {
      void renderWaveDrom(codeEl as HTMLElement, codeText);
    }
  });
};

let observer: MutationObserver | null = null;
let pendingProcessTimer: ReturnType<typeof setTimeout> | null = null;

const teardownRenderedWaveDrom = () => {
  closeActiveModal?.();
  document.querySelectorAll<HTMLElement>('.gv-wavedrom-wrapper').forEach((wrapper) => {
    const codeBlockHost = wrapper.querySelector<HTMLElement>(':scope > code-block');
    if (!codeBlockHost) {
      wrapper.remove();
      return;
    }

    const nativeCopyBtn =
      wrapper.querySelector<HTMLElement>('.gv-wavedrom-toggle .buttons') ??
      wrapper.querySelector<HTMLElement>('.gv-wavedrom-toggle .copy-button');
    if (nativeCopyBtn && !restoreNativeCopyButton(nativeCopyBtn)) {
      // A wrapper can survive an extension hot reload while the module-level
      // WeakMap cannot. Preserve the control in that recovery case even though
      // its pre-reload sibling position is no longer knowable.
      (codeBlockHost.querySelector('.code-block-decoration') ?? codeBlockHost).appendChild(
        nativeCopyBtn,
      );
    }

    codeBlockHost.style.display = '';
    codeBlockHost
      .querySelectorAll<HTMLElement>('code[data-test-id="code-content"]')
      .forEach((code) => {
        delete code.dataset.wavedromCode;
        delete code.dataset.wavedromProcessing;
      });
    wrapper.parentElement?.insertBefore(codeBlockHost, wrapper);
    wrapper.remove();
  });
};

const disableWaveDrom = () => {
  wavedromEnabled = false;
  renderGeneration += 1;
  observer?.disconnect();
  observer = null;
  if (pendingProcessTimer !== null) {
    clearTimeout(pendingProcessTimer);
    pendingProcessTimer = null;
  }
  teardownRenderedWaveDrom();
  document.getElementById(STYLES_ID)?.remove();
};

/** @internal Reset the renderer lifecycle between tests. */
export const _resetWaveDromLifecycleForTest = () => {
  disableWaveDrom();
  wavedromEnabled = true;
};

/**
 * Start the WaveDrom renderer (called from the content script entry point).
 * Storage calls are guarded: after an extension reload the context may be
 * invalidated, and an unguarded call would throw on the page.
 */
export const startWaveDrom = () => {
  try {
    chrome.storage?.sync?.get({ [StorageKeys.WAVEDROM_ENABLED]: true }, (result) => {
      wavedromEnabled = result?.[StorageKeys.WAVEDROM_ENABLED] !== false;
      if (wavedromEnabled) {
        initializeWaveDrom();
      } else {
        disableWaveDrom();
        console.log('[Gemini Voyager] WaveDrom rendering is disabled');
      }
    });
  } catch (err) {
    if (!isExtensionContextInvalidatedError(err)) {
      console.error('[Gemini Voyager] Failed to read WaveDrom setting:', err);
    }
  }

  try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes[StorageKeys.WAVEDROM_ENABLED]) {
        wavedromEnabled = changes[StorageKeys.WAVEDROM_ENABLED].newValue !== false;
        if (wavedromEnabled) {
          initializeWaveDrom();
          console.log('[Gemini Voyager] WaveDrom rendering enabled');
        } else {
          disableWaveDrom();
          console.log('[Gemini Voyager] WaveDrom rendering disabled');
        }
      }
    });
  } catch (err) {
    if (!isExtensionContextInvalidatedError(err)) {
      console.error('[Gemini Voyager] Failed to watch WaveDrom setting:', err);
    }
  }
};

const initializeWaveDrom = () => {
  processCodeBlocks();

  if (!observer) {
    const debouncedProcess = () => {
      if (!wavedromEnabled) return;
      if (pendingProcessTimer !== null) clearTimeout(pendingProcessTimer);
      pendingProcessTimer = setTimeout(() => {
        pendingProcessTimer = null;
        if (wavedromEnabled) processCodeBlocks();
      }, 1000);
    };

    observer = new MutationObserver(debouncedProcess);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  console.log('[Gemini Voyager] WaveDrom integration started');
};
