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

type WaveDromModule = typeof import('wavedrom');
type WaveSkin = { [key: string]: unknown };
type OnmlTree = [string, Record<string, unknown>, ...unknown[]];

interface WaveDromBundle {
  WaveDrom: WaveDromModule;
  waveSkinDefault: WaveSkin;
  /** Bundled dark skin with near-black fills remapped for Gemini's dark page. */
  waveSkinDarkRemapped: WaveSkin;
}

let bundleCache: WaveDromBundle | null = null;
let bundleLoadFailed = false;
let currentModal: HTMLElement | null = null;

/** @internal Exported for testing. */
export const _resetWaveDromLoader = () => {
  bundleCache = null;
  bundleLoadFailed = false;
};

/** @internal Close and clear the fullscreen modal singleton. For testing only. */
export const _closeModalForTest = () => {
  currentModal?.remove();
  currentModal = null;
};

/**
 * Dynamically load WaveDrom and its skins. Result is cached after the first
 * successful load; a failed load also short-circuits further attempts.
 */
const loadWaveDrom = async (): Promise<WaveDromBundle | null> => {
  if (bundleCache) return bundleCache;
  if (bundleLoadFailed) return null;

  try {
    const [WaveDromMod, darkMod, defaultMod] = await Promise.all([
      import('wavedrom'),
      import('wavedrom/skins/dark.js'),
      import('wavedrom/skins/default.js'),
    ]);

    const WaveDrom = WaveDromMod.default ?? (WaveDromMod as unknown as WaveDromModule);
    const waveSkinDefault = (defaultMod.default ?? defaultMod) as WaveSkin;
    const rawDarkSkin = (darkMod.default ?? darkMod) as WaveSkin;

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
 * Render WaveJSON source code into an SVG string, or null when the code is
 * not a valid waveform description. Parsing is lenient (JSON5) so hand-written
 * or LLM-generated WaveJSON with comments or trailing commas still renders.
 */
const renderWaveSvg = async (code: string, isDark: boolean): Promise<string | null> => {
  const bundle = await loadWaveDrom();
  if (!bundle) return null;

  const { WaveDrom, waveSkinDefault, waveSkinDarkRemapped } = bundle;
  const skin = isDark ? waveSkinDarkRemapped : waveSkinDefault;

  try {
    const JSON5 = await import('json5');
    const parse = JSON5.default?.parse ?? JSON5.parse;
    const parsed: unknown = parse(code.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const source = parsed as { signal?: unknown; assign?: unknown; reg?: unknown };
    const hasLanes =
      Array.isArray(source.signal) || Array.isArray(source.assign) || Array.isArray(source.reg);
    if (!hasLanes) return null;

    const tree = WaveDrom.renderAny(
      diagramIndex++,
      source as Parameters<WaveDromModule['renderAny']>[1],
      skin as Parameters<WaveDromModule['renderAny']>[2],
    );
    const svgRaw = WaveDrom.onml.stringify(tree);
    return makeResponsiveSvg(svgRaw);
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
  zoomInBtn.title = 'Zoom In';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '−';
  zoomOutBtn.title = 'Zoom Out';

  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '⊙';
  resetBtn.title = 'Reset';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.title = 'Close (ESC)';

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
  hint.textContent = 'Scroll to zoom • Drag to pan • ESC to close';

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
  const removeListeners = () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
  const closeModal = () => {
    if (closing) return;
    closing = true;
    removeListeners();
    handleMouseUp();
    modal.classList.remove('visible');
    setTimeout(() => {
      modal.remove();
      currentModal = null;
    }, 300);
  };

  zoomInBtn.addEventListener('click', zoomIn);
  zoomOutBtn.addEventListener('click', zoomOut);
  resetBtn.addEventListener('click', resetView);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', handleKeyDown);
  modal.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      scale = e.deltaY < 0 ? Math.min(scale * 1.1, 10) : Math.max(scale / 1.1, 0.1);
      applyTransform();
    },
    { passive: false },
  );
  content.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    content.classList.add('dragging');
  });
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  // Auto-fit the SVG to the viewport.
  if (svgEl) {
    const padding = 80;
    const vw = window.innerWidth - padding * 2;
    const vh = window.innerHeight - padding * 2;
    const w = svgEl.scrollWidth || svgEl.clientWidth;
    const h = svgEl.scrollHeight || svgEl.clientHeight;
    if (w > 0 && h > 0) {
      scale = Math.min(Math.max(Math.min(vw / w, vh / h), 0.1), 10);
      initialScale = scale;
      applyTransform();
    }
  }

  requestAnimationFrame(() => {
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

const renderWaveDrom = async (codeEl: HTMLElement, code: string) => {
  if (codeEl.dataset.wavedromCode === code) return;
  if (codeEl.dataset.wavedromProcessing === 'true') return;

  codeEl.dataset.wavedromProcessing = 'true';

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

    // Build or reuse the wrapper.
    let wrapper = codeBlockHost.parentElement;
    if (!wrapper?.classList.contains('gv-wavedrom-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'gv-wavedrom-wrapper';
      codeBlockHost.parentElement?.insertBefore(wrapper, codeBlockHost);
      wrapper.appendChild(codeBlockHost);

      const toggleContainer = document.createElement('div');
      toggleContainer.className = 'gv-wavedrom-toggle';

      const diagramBtn = document.createElement('button');
      diagramBtn.textContent = '〜 Diagram';
      diagramBtn.className = 'active';
      diagramBtn.dataset.view = 'diagram';

      const codeBtn = document.createElement('button');
      codeBtn.textContent = '</> Code';
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

const processCodeBlocks = () => {
  const codeElements = document.querySelectorAll('code[data-test-id="code-content"]');
  codeElements.forEach((codeEl) => {
    const codeText = codeEl.textContent || '';
    const language = getCodeBlockLanguage(codeEl);

    // Explicit language label 'wavedrom' always renders.
    if (language === 'wavedrom') {
      void renderWaveDrom(codeEl as HTMLElement, codeText);
      return;
    }

    // Specific non-generic language labels skip WaveJSON detection.
    if (language && language !== 'json' && language !== 'json5' && language !== 'code') {
      return;
    }

    // Content-based detection for unlabelled / generic blocks.
    if (isWaveJsonCode(codeText)) {
      void renderWaveDrom(codeEl as HTMLElement, codeText);
    }
  });
};

let wavedromEnabled = true;
let observer: MutationObserver | null = null;

/** Start the WaveDrom renderer (called from the content script entry point). */
export const startWaveDrom = () => {
  chrome.storage?.sync?.get({ gvWaveDromEnabled: true }, (result) => {
    wavedromEnabled = result?.gvWaveDromEnabled !== false;
    if (wavedromEnabled) {
      initializeWaveDrom();
    } else {
      console.log('[Gemini Voyager] WaveDrom rendering is disabled');
    }
  });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.gvWaveDromEnabled) {
      wavedromEnabled = changes.gvWaveDromEnabled.newValue !== false;
      if (wavedromEnabled) {
        initializeWaveDrom();
        console.log('[Gemini Voyager] WaveDrom rendering enabled');
      } else {
        observer?.disconnect();
        observer = null;
        console.log('[Gemini Voyager] WaveDrom rendering disabled');
      }
    }
  });
};

const initializeWaveDrom = () => {
  processCodeBlocks();

  if (!observer) {
    let timeout: ReturnType<typeof setTimeout>;
    const debouncedProcess = () => {
      if (!wavedromEnabled) return;
      clearTimeout(timeout);
      timeout = setTimeout(processCodeBlocks, 1000);
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
