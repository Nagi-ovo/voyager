/**
 * ECharts renderer for Gemini Voyager.
 *
 * Detects ECharts option code blocks rendered by Gemini (JSON/JSON5 chart
 * configurations, optionally wrapped in a JS variable assignment) and replaces
 * them with interactive canvas charts, following the same pattern as the
 * WaveDrom and Mermaid renderers. ECharts is dynamically imported to keep the
 * content-script bundle lean; the library is only fetched once a chart block
 * is detected.
 *
 * Theme notes:
 *  - The theme follows Gemini's active theme ('auto' policy): the built-in
 *    'dark' theme is used on dark pages. The modular ECharts core registers
 *    that theme and the local runtime registers only the chart/component
 *    primitives this renderer supports. The diagram panel uses the same
 *    deterministic backdrops as the WaveDrom renderer.
 *  - Parsing is JSON5-lenient (comments, trailing commas, single quotes,
 *    unquoted keys) with a brace-extraction fallback, but deliberately avoids
 *    evaluating code: LLM-generated options are untrusted input and an eval
 *    fallback would execute arbitrary code in the extension's isolated world.
 *    Options that need real JS functions (e.g. tooltip formatters) therefore
 *    fall back to plain code view instead of rendering.
 */
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { isGenericLanguageLabel } from '../mermaid/index';
import { resolveGeminiTheme } from '../wavedrom/index';
import { provideEChartsDataUrl } from './exportBridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EChartsModule = typeof import('./runtime');
type EChartsInstance = ReturnType<EChartsModule['init']>;

/** ECharts theme policy (follows the app theme). */
export type EChartsThemeMode = 'auto';

/** Resolve the effective chart render theme from the policy + app theme. */
export const resolveEChartsRenderTheme = (
  mode: EChartsThemeMode,
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

const THEME_MODE: EChartsThemeMode = 'auto';

/** Deterministic backdrop colours for the chart panel (mirrors WaveDrom). */
const PANEL_BG: Record<'light' | 'dark', string> = {
  light: '#f9fafb',
  dark: '#1a1a1a',
};

const CHART_HEIGHT = 360;

// ---------------------------------------------------------------------------
// ECharts option parsing
// ---------------------------------------------------------------------------

/**
 * Chart series types understood by the renderer. Anything outside this set is
 * not treated as an ECharts chart, so ordinary JSON output is never mistaken
 * for one (the same philosophy as the WaveDrom renderer's detection).
 */
const CHART_TYPES = new Set([
  'line',
  'bar',
  'pie',
  'scatter',
  'effectscatter',
  'radar',
  'tree',
  'treemap',
  'sunburst',
  'boxplot',
  'candlestick',
  'heatmap',
  'graph',
  'lines',
  'funnel',
  'gauge',
  'sankey',
  'parallel',
  'pictorialbar',
  'themeriver',
  'custom',
]);

/**
 * Chart types that render without any axis/coordinate-system key, so a single
 * strong feature (the series type) is enough to recognise them.
 */
const AXIS_FREE_TYPES = new Set([
  'pie',
  'gauge',
  'funnel',
  'treemap',
  'sunburst',
  'graph',
  'tree',
  'sankey',
]);

/** Coordinate systems available in the intentionally narrow modular runtime. */
const SUPPORTED_COORDINATE_SYSTEMS = new Set([
  'cartesian2d',
  'polar',
  'radar',
  'calendar',
  'parallel',
  'singleaxis',
  'matrix',
  'none',
  'view',
]);

/** Coordinate-system / structure keys that anchor axis-based charts. */
const STRUCTURE_KEYS = [
  'xAxis',
  'yAxis',
  'radar',
  'polar',
  'angleAxis',
  'radiusAxis',
  'grid',
  'timeline',
  'calendar',
  'parallel',
  'parallelAxis',
  'singleAxis',
  'matrix',
] as const;

const STRUCTURE_KEY_PATTERN = new RegExp(`["']?(?:${STRUCTURE_KEYS.join('|')})["']?\\s*:`);

/**
 * Strip JS variable-assignment wrappers and fence markers from ECharts source
 * (e.g. `option = {...}`, `const option = {...};`, `export default option;`),
 * leaving the object literal itself.
 *
 * @internal Exported for testing.
 */
export const stripEChartsAssignment = (raw: string): string => {
  let text = raw.trim();

  // Remove leading/trailing markdown code fence markers if present.
  text = text.replace(/^```(?:echarts?|chart)?\s*/i, '').replace(/\s*```$/, '');

  // Strip leading comments and variable/export assignment prefixes.
  text = text.replace(
    /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*(?:const|let|var)?\s*\w+\s*=\s*/m,
    '',
  );

  // Strip trailing export statements or semicolons.
  text = text.replace(/export\s+default\s+\w+\s*;?$/, '');
  text = text.trim().replace(/;+$/, '');

  return text;
};

/**
 * Strong-shape check: an ECharts option (or timeline `baseOption`) must carry
 * one or more known series types, plus a registered structure key for
 * axis-based charts. Unsupported coordinates are rejected across timeline and
 * responsive overrides before ECharts sees them.
 *
 * @internal Exported for testing.
 */
export const isEChartsOptionObject = (obj: unknown): obj is Record<string, unknown> => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (containsEChartsImageSource(o)) return false;
  const baseOption = o['baseOption'];
  const validationRoot =
    baseOption !== null && typeof baseOption === 'object' && !Array.isArray(baseOption)
      ? (baseOption as Record<string, unknown>)
      : o;

  const timelineOptions = Array.isArray(o['options']) ? o['options'] : [];
  const mediaOptions = Array.isArray(o['media'])
    ? o['media'].map((entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['option']
          : undefined,
      )
    : [];
  const optionLayers = [o, validationRoot, ...timelineOptions, ...mediaOptions].filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
  const hasUnsupportedRuntimeSeries = optionLayers.some((layer) => {
    // GeoComponent is deliberately absent from the extension-safe runtime.
    if ('geo' in layer) return true;

    const layerSeries = layer['series'];
    const entries = Array.isArray(layerSeries) ? layerSeries : [layerSeries];
    return entries.some((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const seriesOption = entry as Record<string, unknown>;
      const type = seriesOption['type'];
      if (
        type !== undefined &&
        (typeof type !== 'string' || !CHART_TYPES.has(type.toLowerCase()))
      ) {
        return true;
      }
      const coordinateSystem = seriesOption['coordinateSystem'];
      return (
        coordinateSystem !== undefined &&
        (typeof coordinateSystem !== 'string' ||
          !SUPPORTED_COORDINATE_SYSTEMS.has(coordinateSystem.toLowerCase()))
      );
    });
  });
  if (hasUnsupportedRuntimeSeries) return false;

  const candidateLayers =
    'series' in validationRoot
      ? [validationRoot]
      : [...timelineOptions, ...mediaOptions].filter(
          (layer): layer is Record<string, unknown> =>
            layer !== null &&
            typeof layer === 'object' &&
            !Array.isArray(layer) &&
            'series' in layer,
        );

  return candidateLayers.some((layer) => {
    const series = layer['series'];
    const seriesEntries = Array.isArray(series) ? series : [series];
    if (seriesEntries.length === 0) return false;

    const chartTypes: string[] = [];
    for (const entry of seriesEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const type = (entry as Record<string, unknown>)['type'];
      if (typeof type !== 'string') return false;
      const normalizedType = type.toLowerCase();
      if (!CHART_TYPES.has(normalizedType)) return false;
      chartTypes.push(normalizedType);
    }

    if (chartTypes.some((type) => AXIS_FREE_TYPES.has(type))) return true;
    const structureLayers = layer === validationRoot ? optionLayers : [validationRoot, layer];
    return STRUCTURE_KEYS.some((key) => structureLayers.some((entry) => key in entry));
  });
};

/**
 * JSON chart options must never trigger an implicit image request. ECharts can
 * load images from both `image://…` symbols and object properties named
 * `image` (for example `graphic.style.image`). Reject those options entirely;
 * image-backed charts are outside this renderer's deliberately narrow scope.
 */
const containsEChartsImageSource = (value: unknown, key = ''): boolean => {
  if (typeof value === 'string') {
    return key.toLowerCase() === 'image' || /^image:\/\//i.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((entry) => containsEChartsImageSource(entry));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([entryKey, entry]) =>
    containsEChartsImageSource(entry, entryKey),
  );
};

const stripTitleLinksInLayer = (option: Record<string, unknown>): Record<string, unknown> => {
  const stripLinkFields = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const safeEntry = { ...(entry as Record<string, unknown>) };
    delete safeEntry['link'];
    delete safeEntry['sublink'];
    delete safeEntry['target'];
    delete safeEntry['subtarget'];
    return safeEntry;
  };

  const title = option['title'];
  if (Array.isArray(title)) return { ...option, title: title.map(stripLinkFields) };
  if (title !== null && typeof title === 'object') {
    return { ...option, title: stripLinkFields(title) };
  }
  return option;
};

const stripDataViewInLayer = (option: Record<string, unknown>): Record<string, unknown> => {
  const stripFeature = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const toolbox = entry as Record<string, unknown>;
    const feature = toolbox['feature'];
    if (feature === null || typeof feature !== 'object' || Array.isArray(feature)) return entry;
    const safeFeature = { ...(feature as Record<string, unknown>) };
    delete safeFeature['dataView'];
    return { ...toolbox, feature: safeFeature };
  };

  const toolbox = option['toolbox'];
  if (Array.isArray(toolbox)) return { ...option, toolbox: toolbox.map(stripFeature) };
  if (toolbox !== null && typeof toolbox === 'object') {
    return { ...option, toolbox: stripFeature(toolbox) };
  }
  return option;
};

const stripSeriesNavigationInLayer = (option: Record<string, unknown>): Record<string, unknown> => {
  const stripDataNavigation = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stripDataNavigation);
    if (entry === null || typeof entry !== 'object') return entry;
    const safeEntry = { ...(entry as Record<string, unknown>) };
    delete safeEntry['link'];
    delete safeEntry['target'];
    if ('children' in safeEntry) {
      safeEntry['children'] = stripDataNavigation(safeEntry['children']);
    }
    return safeEntry;
  };

  const stripSeriesNavigation = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const safeEntry = { ...(entry as Record<string, unknown>) };
    if (safeEntry['nodeClick'] === 'link') delete safeEntry['nodeClick'];
    if ('data' in safeEntry) safeEntry['data'] = stripDataNavigation(safeEntry['data']);
    return safeEntry;
  };

  const series = option['series'];
  if (Array.isArray(series)) {
    return { ...option, series: series.map(stripSeriesNavigation) };
  }
  if (series !== null && typeof series === 'object') {
    return { ...option, series: stripSeriesNavigation(series) };
  }
  return option;
};

const forceRichTextTooltipsInLayer = (option: Record<string, unknown>): Record<string, unknown> => {
  const tooltip = option['tooltip'];
  const series = option['series'];
  const seriesEntries = Array.isArray(series) ? series : [series];
  const hasSeriesTooltip = seriesEntries.some(
    (entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'tooltip' in entry,
  );

  const forceTooltipRenderMode = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(forceTooltipRenderMode);
    return entry !== null && typeof entry === 'object'
      ? { ...(entry as Record<string, unknown>), renderMode: 'richText' }
      : entry;
  };

  const forceSeriesTooltip = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const seriesEntry = entry as Record<string, unknown>;
    return 'tooltip' in seriesEntry
      ? { ...seriesEntry, tooltip: forceTooltipRenderMode(seriesEntry['tooltip']) }
      : entry;
  };

  const safeOption = hasSeriesTooltip
    ? {
        ...option,
        series: Array.isArray(series) ? series.map(forceSeriesTooltip) : forceSeriesTooltip(series),
      }
    : option;

  if (Array.isArray(tooltip)) {
    return {
      ...safeOption,
      tooltip: forceTooltipRenderMode(tooltip),
    };
  }

  if (tooltip !== null && typeof tooltip === 'object') {
    return { ...safeOption, tooltip: forceTooltipRenderMode(tooltip) };
  }

  return hasSeriesTooltip ? { ...safeOption, tooltip: { renderMode: 'richText' } } : safeOption;
};

const enableAriaInLayer = (option: Record<string, unknown>): Record<string, unknown> => {
  const aria = option['aria'];
  return {
    ...option,
    aria:
      aria !== null && typeof aria === 'object' && !Array.isArray(aria)
        ? { ...(aria as Record<string, unknown>), enabled: true }
        : { enabled: true },
  };
};

const sanitizeEChartsOption = (
  option: Record<string, unknown>,
  backgroundColor: string,
): Record<string, unknown> => {
  const sanitizeLayer = (layer: Record<string, unknown>): Record<string, unknown> => ({
    ...enableAriaInLayer(
      forceRichTextTooltipsInLayer(
        stripSeriesNavigationInLayer(stripTitleLinksInLayer(stripDataViewInLayer(layer))),
      ),
    ),
    backgroundColor,
  });

  let safeOption = sanitizeLayer(option);
  const baseOption = option['baseOption'];
  if (baseOption !== null && typeof baseOption === 'object' && !Array.isArray(baseOption)) {
    safeOption = {
      ...safeOption,
      baseOption: sanitizeLayer(baseOption as Record<string, unknown>),
    };
  }

  const timelineOptions = option['options'];
  if (Array.isArray(timelineOptions)) {
    safeOption = {
      ...safeOption,
      options: timelineOptions.map((entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? sanitizeLayer(entry as Record<string, unknown>)
          : entry,
      ),
    };
  }

  const media = option['media'];
  if (Array.isArray(media)) {
    safeOption = {
      ...safeOption,
      media: media.map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const mediaEntry = entry as Record<string, unknown>;
        const mediaOption = mediaEntry['option'];
        return mediaOption !== null &&
          typeof mediaOption === 'object' &&
          !Array.isArray(mediaOption)
          ? {
              ...mediaEntry,
              option: sanitizeLayer(mediaOption as Record<string, unknown>),
            }
          : entry;
      }),
    };
  }
  return safeOption;
};

/**
 * Fast, synchronous content check for unlabelled / generically-labelled code
 * blocks. Uses regex only (no JSON5 parse) so the MutationObserver pass stays
 * cheap; the full parse happens later in the render path.
 *
 * @internal Exported for testing.
 */
export const isEChartsOptionCode = (code: string): boolean => {
  const trimmed = code.trim();
  if (trimmed.length < 20) return false;
  if (/["']?geo["']?\s*:/.test(trimmed)) return false;
  if (/image:\/\//i.test(trimmed) || /["']?image["']?\s*:/.test(trimmed)) return false;

  const coordinateSystems = [
    ...trimmed.matchAll(/["']?coordinateSystem["']?\s*:\s*["']([a-zA-Z0-9]+)["']/g),
  ].map((match) => match[1].toLowerCase());
  if (coordinateSystems.some((value) => !SUPPORTED_COORDINATE_SYSTEMS.has(value))) return false;

  // Fast path: top-level series key.
  if (!/["']?series["']?\s*:/.test(trimmed)) return false;

  // Any `type` value in the block must be a known chart type (axis types like
  // 'value'/'category' never match, so axis-only JSON is rejected).
  const chartTypes = [...trimmed.matchAll(/["']?type["']?\s*:\s*["']([a-zA-Z]+)["']/g)]
    .map((match) => match[1].toLowerCase())
    .filter((t) => CHART_TYPES.has(t));
  if (chartTypes.length === 0) return false;

  // Axis-free chart types are recognised by their type alone; the rest need a
  // coordinate-system key.
  if (chartTypes.some((t) => AXIS_FREE_TYPES.has(t))) return true;
  return STRUCTURE_KEY_PATTERN.test(trimmed);
};

/**
 * Parse ECharts option source into a validated option object, or null when it
 * is not a chart configuration. JSON5-lenient with a brace-extraction
 * fallback; never evaluates code.
 *
 * @internal Exported for testing.
 */
export const parseEChartsOption = async (code: string): Promise<Record<string, unknown> | null> => {
  if (!code) return null;
  const cleaned = stripEChartsAssignment(code);

  const [JSON5Mod] = await Promise.all([import('json5')]);
  const parse = JSON5Mod.default?.parse ?? JSON5Mod.parse;

  try {
    const parsed = parse(cleaned);
    if (isEChartsOptionObject(parsed)) return parsed;
  } catch {
    // Not directly parseable — fall through to the brace-extraction fallback.
  }

  // Fallback: extract the first object literal when leading text (e.g.
  // a comment or a broken assignment prefix) precedes the option.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsedSub = parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (isEChartsOptionObject(parsedSub)) return parsedSub;
    } catch {
      // Not a parseable option; the block stays in code view.
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Lazy ECharts loader
// ---------------------------------------------------------------------------

let echartsModule: EChartsModule | null = null;
let echartsLoadFailed = false;

/** @internal Exported for testing. */
export const _resetEChartsLoader = () => {
  echartsModule = null;
  echartsLoadFailed = false;
};

/**
 * Dynamically load ECharts. Result is cached after the first successful load;
 * a failed load also short-circuits further attempts. The local modular entry
 * registers supported chart/component primitives without pulling ECharts'
 * unused geo parser into the extension bundle.
 */
const loadECharts = async (): Promise<EChartsModule | null> => {
  if (echartsModule) return echartsModule;
  if (echartsLoadFailed) return null;

  try {
    echartsModule = await import('./runtime');
    return echartsModule;
  } catch (err) {
    echartsLoadFailed = true;
    console.error('[Gemini Voyager] Failed to load ECharts library:', err);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Chart instance lifecycle
// ---------------------------------------------------------------------------

/** Live chart instances by container, so teardown/resize can reach them. */
const chartInstances = new Map<HTMLElement, EChartsInstance>();

let currentModal: HTMLElement | null = null;
let closeActiveModal: (() => void) | null = null;
/** Wrapper the fullscreen chart container is moved back into on close. */
let fullscreenWrapper: HTMLElement | null = null;

/** @internal Close and clear the fullscreen modal singleton. For testing only. */
export const _closeModalForTest = () => {
  closeActiveModal?.();
  closeActiveModal = null;
};

/**
 * (Re)render an option into a container: disposes the previous instance (the
 * render theme may have changed), then inits a fresh canvas chart with the
 * deterministic panel backdrop merged under the user option.
 */
const renderChartToContainer = (
  container: HTMLElement,
  parsed: Record<string, unknown>,
  renderTheme: 'light' | 'dark',
) => {
  const existing = chartInstances.get(container);
  if (existing) {
    existing.dispose();
    chartInstances.delete(container);
  }
  if (!echartsModule) return;

  const theme = renderTheme === 'dark' ? 'dark' : undefined;
  const instance = echartsModule.init(container, theme, { renderer: 'canvas' });
  try {
    // `backgroundColor` from the chart option would otherwise paint over the
    // panel; keep the deterministic backdrop so text stays readable.
    instance.setOption(sanitizeEChartsOption(parsed, PANEL_BG[renderTheme]), true);
    chartInstances.set(container, instance);
  } catch (error) {
    // `setOption` can reject malformed LLM output or an option that requires a
    // component outside the intentionally narrow runtime. The instance is not
    // in `chartInstances` yet, so dispose it here before the outer teardown.
    instance.dispose();
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES_ID = 'gv-echarts-styles';

const createStyles = () => {
  const existing = document.getElementById(STYLES_ID);
  if (existing) return;

  const style = document.createElement('style');
  style.id = STYLES_ID;
  style.textContent = `
    .gv-echarts-wrapper {
      position: relative;
    }

    .gv-echarts-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      width: fit-content;
      margin: 8px 8px 4px auto;
      background: var(--gemini-surface-container, rgba(0,0,0,0.05));
      border-radius: 8px;
      padding: 2px;
      border: 1px solid var(--gemini-outline-variant, rgba(0,0,0,0.1));
    }

    .gv-echarts-toggle button {
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

    .gv-echarts-toggle button:hover {
      background: var(--gemini-surface-container-high, rgba(0,0,0,0.08));
    }

    .gv-echarts-toggle button.active {
      background: var(--gemini-primary, #1a73e8);
      color: white;
    }

    .gv-echarts-diagram {
      height: ${CHART_HEIGHT}px;
      padding: 16px;
      box-sizing: border-box;
      background-color: var(--gv-echarts-panel-bg, ${PANEL_BG.light});
      overflow: hidden;
    }

    .gv-echarts-toggle button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    /* Fullscreen modal */
    .gv-echarts-modal {
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

    .gv-echarts-modal.visible {
      opacity: 1;
    }

    .gv-echarts-modal-toolbar {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      gap: 8px;
      z-index: 1000000;
    }

    .gv-echarts-modal-toolbar button {
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

    .gv-echarts-modal-toolbar button:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }

    .gv-echarts-modal-card {
      border-radius: 8px;
      padding: 12px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      width: min(calc(100vw - 96px), 1200px);
      height: calc(100vh - 120px);
    }

    /* The moved chart container fills the card; canvas resizes with it. */
    .gv-echarts-modal-card .gv-echarts-diagram {
      width: 100%;
      height: 100%;
      padding: 0;
    }

    .gv-echarts-modal-hint {
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
 * Open the chart fullscreen: the chart container is *moved* into the modal
 * card (an ECharts canvas renders wherever its DOM element lives — cloning
 * would lose the live instance), resized to the card, and moved back — and
 * resized again — on close.
 */
const openFullscreen = (chartContainer: HTMLElement) => {
  if (currentModal) return;
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const modal = document.createElement('div');
  modal.className = 'gv-echarts-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', t('echartsFullscreenButton', 'Fullscreen'));

  const toolbar = document.createElement('div');
  toolbar.className = 'gv-echarts-modal-toolbar';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.innerHTML = '✕';
  const closeLabel = t('echartsCloseFullscreen', 'Close (ESC)');
  closeBtn.title = closeLabel;
  closeBtn.setAttribute('aria-label', closeLabel);

  toolbar.appendChild(closeBtn);

  const card = document.createElement('div');
  card.className = 'gv-echarts-modal-card';
  card.style.background = `var(--gv-echarts-panel-bg, ${PANEL_BG.light})`;
  card.style.setProperty(
    '--gv-echarts-panel-bg',
    chartContainer.style.getPropertyValue('--gv-echarts-panel-bg') || PANEL_BG.light,
  );

  const wrapper = chartContainer.parentElement as HTMLElement | null;
  card.appendChild(chartContainer);
  fullscreenWrapper = wrapper;

  const hint = document.createElement('div');
  hint.className = 'gv-echarts-modal-hint';
  hint.textContent = t('echartsFullscreenHint', 'Press ESC to close');

  modal.append(toolbar, card, hint);
  document.body.appendChild(modal);
  currentModal = modal;

  let closing = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let revealFrame: number | null = null;

  // Single registration point: every listener (including the document-level
  // keydown) is removed together on close, so no listener outlives the modal
  // even when it is torn down externally.
  const cleanupFns: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    target: EventTarget,
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
  ) => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    cleanupFns.push(() => target.removeEventListener(type, listener));
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
    modal.remove();
    if (currentModal === modal) currentModal = null;
    if (closeActiveModal === destroyModal) closeActiveModal = null;

    // Move the container back to its wrapper and let the canvas follow.
    if (fullscreenWrapper) {
      fullscreenWrapper.appendChild(chartContainer);
      fullscreenWrapper = null;
    }
    chartInstances.get(chartContainer)?.resize();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  const closeModal = () => {
    if (closing) return;
    closing = true;
    modal.classList.remove('visible');
    closeTimer = setTimeout(destroyModal, 300);
  };
  closeActiveModal = destroyModal;

  on(closeBtn, 'click', closeModal);
  on(modal, 'click', (e) => {
    if (e.target === modal) closeModal();
  });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Tab') {
      e.preventDefault();
      closeBtn.focus({ preventScroll: true });
    }
  });
  on(document, 'focusin', (e) => {
    if (!modal.contains(e.target as Node)) closeBtn.focus({ preventScroll: true });
  });

  closeBtn.focus({ preventScroll: true });

  // Size the canvas against the card, then fade in.
  revealFrame = requestAnimationFrame(() => {
    revealFrame = null;
    chartInstances.get(chartContainer)?.resize();
    modal.classList.add('visible');
  });
};

/** @internal Exported for lifecycle testing. */
export const _openFullscreenForTest = openFullscreen;

// ---------------------------------------------------------------------------
// Code block rendering
// ---------------------------------------------------------------------------

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
 * Keeping the native control in the renderer toolbar prevents duplicate copy
 * affordances while preserving Gemini's implementation and exact teardown.
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

let echartsEnabled = true;
let renderGeneration = 0;
let settingChangeRevision = 0;

const finishStaleRender = (codeEl: HTMLElement) => {
  codeEl.dataset.echartsProcessing = 'false';
  if (echartsEnabled && codeEl.isConnected) {
    void renderEcharts(codeEl, codeEl.textContent || '');
  }
};

const renderEcharts = async (codeEl: HTMLElement, code: string) => {
  if (!echartsEnabled || !isEChartsLanguageEligible(codeEl)) return;
  const requestedRenderTheme = resolveEChartsRenderTheme(THEME_MODE, getAppTheme());
  // Skip when nothing changed — the theme is part of the key so an explicit
  // Gemini theme switch re-renders existing charts in the new theme.
  if (codeEl.dataset.echartsCode === code && codeEl.dataset.echartsTheme === requestedRenderTheme)
    return;
  if (codeEl.dataset.echartsProcessing === 'true') return;

  codeEl.dataset.echartsProcessing = 'true';
  const generationAtStart = renderGeneration;

  try {
    const codeBlockHost = codeEl.closest('code-block') as HTMLElement;
    if (!codeBlockHost) {
      codeEl.dataset.echartsProcessing = 'false';
      return;
    }

    createStyles();

    const parsed = await parseEChartsOption(code);
    if (!parsed) {
      const latestCode = codeEl.textContent || '';
      if (
        latestCode !== code &&
        echartsEnabled &&
        generationAtStart === renderGeneration &&
        codeEl.isConnected &&
        codeBlockHost.isConnected
      ) {
        codeEl.dataset.echartsProcessing = 'false';
        void renderEcharts(codeEl, latestCode);
        return;
      }
      const wrapper = codeBlockHost.parentElement;
      if (wrapper?.classList.contains('gv-echarts-wrapper')) {
        teardownEchartsWrapper(wrapper);
      } else {
        codeEl.dataset.echartsProcessing = 'false';
      }
      return;
    }
    if (!codeEl.isConnected || !codeBlockHost.isConnected) {
      codeEl.dataset.echartsProcessing = 'false';
      return;
    }
    if (!echartsEnabled || generationAtStart !== renderGeneration) {
      finishStaleRender(codeEl);
      return;
    }
    const latestCode = codeEl.textContent || '';
    if (latestCode !== code) {
      codeEl.dataset.echartsProcessing = 'false';
      void renderEcharts(codeEl, latestCode);
      return;
    }

    const echarts = await loadECharts();
    if (!echarts) {
      const wrapper = codeBlockHost.parentElement;
      if (wrapper?.classList.contains('gv-echarts-wrapper')) {
        teardownEchartsWrapper(wrapper);
      } else {
        codeEl.dataset.echartsProcessing = 'false';
      }
      return;
    }
    if (!codeEl.isConnected || !codeBlockHost.isConnected) {
      codeEl.dataset.echartsProcessing = 'false';
      return;
    }
    if (!echartsEnabled || generationAtStart !== renderGeneration) {
      finishStaleRender(codeEl);
      return;
    }
    const latestCodeAfterLoad = codeEl.textContent || '';
    if (latestCodeAfterLoad !== code) {
      codeEl.dataset.echartsProcessing = 'false';
      void renderEcharts(codeEl, latestCodeAfterLoad);
      return;
    }
    if (!isEChartsLanguageEligible(codeEl)) {
      const wrapper = codeBlockHost.parentElement;
      if (wrapper?.classList.contains('gv-echarts-wrapper')) {
        teardownEchartsWrapper(wrapper);
      } else {
        codeEl.dataset.echartsProcessing = 'false';
      }
      return;
    }

    // Parsing and the modular runtime load are asynchronous. Re-read Gemini's
    // theme now so a switch during either await is not lost.
    const renderTheme = resolveEChartsRenderTheme(THEME_MODE, getAppTheme());
    const panelBg = PANEL_BG[renderTheme];

    // Build or reuse the wrapper.
    let wrapper = codeBlockHost.parentElement;
    if (!wrapper?.classList.contains('gv-echarts-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'gv-echarts-wrapper';
      codeBlockHost.parentElement?.insertBefore(wrapper, codeBlockHost);
      wrapper.appendChild(codeBlockHost);

      const toggleContainer = document.createElement('div');
      toggleContainer.className = 'gv-echarts-toggle';

      // Move the native copy button into the toolbar so it is not covered by
      // the overlay in Code view (same fix as the WaveDrom renderer).
      moveNativeCopyButton(codeBlockHost, toggleContainer);

      const diagramBtn = document.createElement('button');
      diagramBtn.textContent = t('echartsDiagramButton', '📊 Diagram');
      diagramBtn.className = 'active';
      diagramBtn.dataset.view = 'diagram';
      diagramBtn.setAttribute('aria-pressed', 'true');

      const codeBtn = document.createElement('button');
      codeBtn.textContent = t('echartsCodeButton', '</> Code');
      codeBtn.dataset.view = 'code';
      codeBtn.setAttribute('aria-pressed', 'false');

      const fullscreenBtn = document.createElement('button');
      fullscreenBtn.textContent = '⛶';
      fullscreenBtn.dataset.action = 'fullscreen';
      const fullscreenLabel = t('echartsFullscreenButton', 'Fullscreen');
      fullscreenBtn.title = fullscreenLabel;
      fullscreenBtn.setAttribute('aria-label', fullscreenLabel);

      toggleContainer.append(diagramBtn, codeBtn, fullscreenBtn);
      wrapper.insertBefore(toggleContainer, codeBlockHost);

      const diagramContainer = document.createElement('div');
      diagramContainer.className = 'gv-echarts-diagram';
      wrapper.appendChild(diagramContainer);
      provideEChartsDataUrl(
        diagramContainer,
        () => {
          try {
            const instance = chartInstances.get(diagramContainer);
            if (!instance) return null;
            return instance.getDataURL({
              type: 'png',
              pixelRatio: 1,
              backgroundColor:
                diagramContainer.style.getPropertyValue('--gv-echarts-panel-bg') || PANEL_BG.light,
            });
          } catch {
            return null;
          }
        },
        wrapper,
      );

      codeBlockHost.style.display = 'none';

      const updateView = (view: 'diagram' | 'code') => {
        if (view === 'diagram') {
          codeBlockHost.style.display = 'none';
          diagramContainer.style.display = 'block';
          diagramBtn.classList.add('active');
          codeBtn.classList.remove('active');
          diagramBtn.setAttribute('aria-pressed', 'true');
          codeBtn.setAttribute('aria-pressed', 'false');
          fullscreenBtn.disabled = false;
          void renderEcharts(codeEl, codeEl.textContent || '');
          // The canvas is sized 0 while hidden; resize after reveal.
          chartInstances.get(diagramContainer)?.resize();
        } else {
          codeBlockHost.style.display = '';
          diagramContainer.style.display = 'none';
          diagramBtn.classList.remove('active');
          codeBtn.classList.add('active');
          diagramBtn.setAttribute('aria-pressed', 'false');
          codeBtn.setAttribute('aria-pressed', 'true');
          fullscreenBtn.disabled = true;
        }
      };

      diagramBtn.addEventListener('click', () => updateView('diagram'));
      codeBtn.addEventListener('click', () => updateView('code'));

      fullscreenBtn.addEventListener('click', () => {
        openFullscreen(diagramContainer);
      });

      chartResizeObserver?.observe(diagramContainer);
    }

    const diagramContainer =
      (wrapper.querySelector('.gv-echarts-diagram') as HTMLElement | null) ??
      (fullscreenWrapper === wrapper
        ? (currentModal?.querySelector<HTMLElement>('.gv-echarts-diagram') ?? null)
        : null);
    if (!diagramContainer) {
      teardownEchartsWrapper(wrapper);
      return;
    }

    diagramContainer.style.setProperty('--gv-echarts-panel-bg', panelBg);
    if (diagramContainer.parentElement?.classList.contains('gv-echarts-modal-card')) {
      diagramContainer.parentElement.style.setProperty('--gv-echarts-panel-bg', panelBg);
    }
    if (diagramContainer.style.display === 'none') {
      codeEl.dataset.echartsProcessing = 'false';
      return;
    }
    renderChartToContainer(diagramContainer, parsed, renderTheme);

    codeEl.dataset.echartsCode = code;
    codeEl.dataset.echartsTheme = renderTheme;
    codeEl.dataset.echartsProcessing = 'false';
  } catch {
    const codeBlockHost = codeEl.closest('code-block') as HTMLElement;
    const wrapper = codeBlockHost?.parentElement;
    if (wrapper?.classList.contains('gv-echarts-wrapper')) {
      teardownEchartsWrapper(wrapper);
    } else {
      codeEl.dataset.echartsProcessing = 'false';
      if (codeBlockHost) codeBlockHost.style.display = '';
    }
  }
};

// ---------------------------------------------------------------------------
// Language label helpers (mirrors wavedrom module)
// ---------------------------------------------------------------------------

function getCodeBlockLanguage(codeEl: Element): string | null {
  const codeBlock = codeEl.closest('.code-block, code-block');
  if (!codeBlock) return null;
  const decoration = codeBlock.querySelector('.code-block-decoration');
  if (!decoration) return null;
  const langSpan = decoration.querySelector(':scope > span');
  const language = langSpan?.textContent?.trim().toLowerCase();
  return language || null;
}

function isEChartsLanguageEligible(codeEl: Element): boolean {
  const language = getCodeBlockLanguage(codeEl);
  return (
    !language ||
    language === 'echarts' ||
    language === 'echart' ||
    language === 'chart' ||
    isGenericLanguageLabel(language)
  );
}

// ---------------------------------------------------------------------------
// processCodeBlocks + lifecycle
// ---------------------------------------------------------------------------

/**
 * @internal Exported for testing.
 */
export const processCodeBlocks = () => {
  cleanupDetachedChartInstances();
  const codeElements = document.querySelectorAll('code[data-test-id="code-content"]');
  codeElements.forEach((codeEl) => {
    const codeText = codeEl.textContent || '';
    const language = getCodeBlockLanguage(codeEl);

    // Explicit ECharts labels always render.
    if (language === 'echarts' || language === 'echart' || language === 'chart') {
      void renderEcharts(codeEl as HTMLElement, codeText);
      return;
    }

    // Specific language labels (json, typescript, …) skip chart detection:
    // ECharts options are a niche format, and ordinary JSON output must not
    // be mistaken for a chart.
    if (language && !isGenericLanguageLabel(language)) {
      const wrapper = codeEl.closest<HTMLElement>('.gv-echarts-wrapper');
      if (wrapper) teardownEchartsWrapper(wrapper);
      return;
    }

    // Content-based detection for unlabelled / generic blocks
    // (Code snippet, 代码段, …).
    if (isEChartsOptionCode(codeText)) {
      void renderEcharts(codeEl as HTMLElement, codeText);
    } else {
      const wrapper = codeEl.closest<HTMLElement>('.gv-echarts-wrapper');
      if (wrapper) teardownEchartsWrapper(wrapper);
    }
  });
};

let observer: MutationObserver | null = null;
let pendingProcessTimer: ReturnType<typeof setTimeout> | null = null;
let chartResizeObserver: ResizeObserver | null = null;

function disposeChartContainer(container: HTMLElement): void {
  chartResizeObserver?.unobserve(container);
  chartInstances.get(container)?.dispose();
  chartInstances.delete(container);
}

function teardownEchartsWrapper(wrapper: HTMLElement): void {
  if (fullscreenWrapper === wrapper) closeActiveModal?.();

  const diagramContainer = wrapper.querySelector<HTMLElement>(':scope > .gv-echarts-diagram');
  if (diagramContainer) disposeChartContainer(diagramContainer);

  const codeBlockHost = wrapper.querySelector<HTMLElement>(':scope > code-block');
  if (!codeBlockHost) {
    wrapper.remove();
    return;
  }

  const nativeCopyBtn =
    wrapper.querySelector<HTMLElement>('.gv-echarts-toggle .buttons') ??
    wrapper.querySelector<HTMLElement>('.gv-echarts-toggle .copy-button');
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
      delete code.dataset.echartsCode;
      delete code.dataset.echartsTheme;
      delete code.dataset.echartsProcessing;
    });
  wrapper.parentElement?.insertBefore(codeBlockHost, wrapper);
  wrapper.remove();
}

const cleanupDetachedChartInstances = (): void => {
  if (fullscreenWrapper && !fullscreenWrapper.isConnected) closeActiveModal?.();
  for (const container of chartInstances.keys()) {
    if (!container.isConnected) {
      disposeChartContainer(container);
      continue;
    }
    const wrapper =
      container.closest<HTMLElement>('.gv-echarts-wrapper') ??
      (currentModal?.contains(container) ? fullscreenWrapper : null);
    if (wrapper && !wrapper.querySelector(':scope > code-block')) {
      teardownEchartsWrapper(wrapper);
    }
  }
};

const teardownRenderedEcharts = () => {
  closeActiveModal?.();
  for (const container of chartInstances.keys()) {
    disposeChartContainer(container);
  }
  document.querySelectorAll<HTMLElement>('.gv-echarts-wrapper').forEach((wrapper) => {
    teardownEchartsWrapper(wrapper);
  });
};

const disableEcharts = () => {
  echartsEnabled = false;
  renderGeneration += 1;
  observer?.disconnect();
  observer = null;
  if (pendingProcessTimer !== null) {
    clearTimeout(pendingProcessTimer);
    pendingProcessTimer = null;
  }
  chartResizeObserver?.disconnect();
  chartResizeObserver = null;
  teardownRenderedEcharts();
  document.getElementById(STYLES_ID)?.remove();
};

/** @internal Reset the renderer lifecycle between tests. */
export const _resetEchartsLifecycleForTest = () => {
  settingChangeRevision += 1;
  disableEcharts();
  echartsEnabled = true;
};

/**
 * Start the ECharts renderer (called from the content script entry point).
 * Storage calls are guarded: after an extension reload the context may be
 * invalidated, and an unguarded call would throw on the page.
 */
export const startEcharts = () => {
  const readRevision = settingChangeRevision;
  try {
    chrome.storage?.sync?.get({ [StorageKeys.ECHARTS_ENABLED]: true }, (result) => {
      if (readRevision !== settingChangeRevision) return;
      echartsEnabled = result?.[StorageKeys.ECHARTS_ENABLED] !== false;
      if (echartsEnabled) {
        initializeEcharts();
      } else {
        disableEcharts();
      }
    });
  } catch (err) {
    if (!isExtensionContextInvalidatedError(err)) {
      console.error('[Gemini Voyager] Failed to read ECharts setting:', err);
    }
  }

  try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes[StorageKeys.ECHARTS_ENABLED]) {
        settingChangeRevision += 1;
        echartsEnabled = changes[StorageKeys.ECHARTS_ENABLED].newValue !== false;
        if (echartsEnabled) {
          initializeEcharts();
        } else {
          disableEcharts();
        }
      }
    });
  } catch (err) {
    if (!isExtensionContextInvalidatedError(err)) {
      console.error('[Gemini Voyager] Failed to watch ECharts setting:', err);
    }
  }
};

const initializeEcharts = () => {
  processCodeBlocks();

  if (!observer) {
    const debouncedProcess = () => {
      if (!echartsEnabled) return;
      if (pendingProcessTimer !== null) clearTimeout(pendingProcessTimer);
      pendingProcessTimer = setTimeout(() => {
        pendingProcessTimer = null;
        if (echartsEnabled) processCodeBlocks();
      }, 1000);
    };

    observer = new MutationObserver(debouncedProcess);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      // Class changes let an explicit Gemini theme switch re-render existing
      // charts (theme-host.dark-theme / light-theme live on class attributes).
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  if (!chartResizeObserver && typeof ResizeObserver !== 'undefined') {
    chartResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const container = entry.target as HTMLElement;
        if (
          container.style.display === 'none' ||
          entry.contentRect.width <= 0 ||
          entry.contentRect.height <= 0
        ) {
          continue;
        }
        chartInstances.get(container)?.resize();
      }
    });
  }
};
