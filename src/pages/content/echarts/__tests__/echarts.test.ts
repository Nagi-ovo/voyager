import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { requestEChartsDataUrl } from '../exportBridge';
import {
  _closeModalForTest,
  _openFullscreenForTest,
  _resetEChartsLoader,
  _resetEchartsLifecycleForTest,
  isEChartsOptionCode,
  isEChartsOptionObject,
  moveNativeCopyButton,
  parseEChartsOption,
  processCodeBlocks,
  resolveEChartsRenderTheme,
  startEcharts,
  stripEChartsAssignment,
} from '../index';

// ---------------------------------------------------------------------------
// Mock dynamic imports so the loader never hits the network.
// ---------------------------------------------------------------------------

const makeFakeInstance = () => ({
  setOption: vi.fn(),
  getDataURL: vi.fn(() => 'data:image/png;base64,COMPOSITED'),
  resize: vi.fn(),
  dispose: vi.fn(),
});

vi.mock('../runtime', () => ({
  init: vi.fn(() => makeFakeInstance()),
}));

// JSON5-lenient parse: strip comments and trailing commas before the strict
// parse, which is enough fidelity to exercise the renderer's lenient path.
vi.mock('json5', () => ({
  default: {
    parse: (s: string) => {
      const cleaned = s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned);
    },
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BAR_OPTION = `{
  "xAxis": { "type": "category", "data": ["A", "B"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [1, 2] }]
}`;

const PIE_OPTION = `{
  "series": [{ "type": "pie", "data": [{ "value": 1, "name": "a" }] }]
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetEchartsLifecycleForTest();
  _resetEChartsLoader();
  _closeModalForTest();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.body.className = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.useRealTimers();
  _resetEchartsLifecycleForTest();
});

// ---------------------------------------------------------------------------
// resolveEChartsRenderTheme
// ---------------------------------------------------------------------------

describe('resolveEChartsRenderTheme', () => {
  it('follows the app theme in auto mode', () => {
    expect(resolveEChartsRenderTheme('auto', 'dark')).toBe('dark');
    expect(resolveEChartsRenderTheme('auto', 'light')).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// stripEChartsAssignment
// ---------------------------------------------------------------------------

describe('stripEChartsAssignment', () => {
  it('strips a const assignment wrapper', () => {
    expect(stripEChartsAssignment(`const option = ${PIE_OPTION};`)).toBe(PIE_OPTION);
  });

  it('strips a bare assignment wrapper', () => {
    expect(stripEChartsAssignment(`option = ${PIE_OPTION}`)).toBe(PIE_OPTION);
  });

  it('strips leading comments before the assignment', () => {
    expect(stripEChartsAssignment(`// chart config\nconst option = ${PIE_OPTION};`)).toBe(
      PIE_OPTION,
    );
  });

  it('strips a trailing export default statement', () => {
    expect(stripEChartsAssignment(`const option = ${PIE_OPTION};\nexport default option;`)).toBe(
      PIE_OPTION,
    );
  });

  it('strips markdown fence markers', () => {
    expect(stripEChartsAssignment(`\`\`\`echarts\n${PIE_OPTION}\n\`\`\``)).toBe(PIE_OPTION);
  });
});

// ---------------------------------------------------------------------------
// isEChartsOptionObject
// ---------------------------------------------------------------------------

describe('isEChartsOptionObject', () => {
  it('accepts an axis-based chart with a structure key', () => {
    expect(isEChartsOptionObject(JSON.parse(BAR_OPTION))).toBe(true);
  });

  it('accepts an axis-free chart by its type alone', () => {
    expect(isEChartsOptionObject(JSON.parse(PIE_OPTION))).toBe(true);
  });

  it('accepts a single series object', () => {
    expect(isEChartsOptionObject({ series: { type: 'pie', data: [{ value: 1 }] } })).toBe(true);
  });

  it('accepts a standard timeline option through baseOption', () => {
    expect(
      isEChartsOptionObject({
        baseOption: {
          timeline: { axisType: 'category', data: ['2025', '2026'] },
          xAxis: { type: 'category' },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [1] }],
        },
        options: [{ series: [{ data: [2] }] }],
      }),
    ).toBe(true);
  });

  it('accepts a complete chart series supplied by a responsive media option', () => {
    expect(
      isEChartsOptionObject({
        baseOption: { title: { text: 'Responsive chart' } },
        media: [
          {
            query: { maxWidth: 600 },
            option: { series: [{ type: 'pie', data: [{ value: 1 }] }] },
          },
        ],
      }),
    ).toBe(true);
  });

  it('accepts an axis structure supplied by a responsive override layer', () => {
    expect(
      isEChartsOptionObject({
        series: [{ type: 'bar', data: [1] }],
        media: [{ query: { maxWidth: 600 }, option: { xAxis: {}, yAxis: {} } }],
      }),
    ).toBe(true);
  });

  it('ignores malformed override entries while finding a responsive axis structure', () => {
    expect(
      isEChartsOptionObject({
        series: [{ type: 'bar', data: [1] }],
        options: [null],
        media: [null, { option: { xAxis: {}, yAxis: {} } }],
      }),
    ).toBe(true);
  });

  it.each([
    ['calendar', { calendar: {}, series: [{ type: 'heatmap', data: [] }] }],
    ['parallel', { parallel: {}, series: [{ type: 'parallel', data: [] }] }],
    ['parallelAxis', { parallelAxis: [], series: [{ type: 'parallel', data: [] }] }],
    ['singleAxis', { singleAxis: {}, series: [{ type: 'themeriver', data: [] }] }],
    ['matrix', { matrix: {}, series: [{ type: 'scatter', data: [] }] }],
  ])('accepts the registered %s coordinate system', (_name, option) => {
    expect(isEChartsOptionObject(option)).toBe(true);
  });

  it('rejects geo coordinates because the safe modular runtime does not register them', () => {
    expect(isEChartsOptionObject({ geo: {}, series: [{ type: 'scatter', data: [] }] })).toBe(false);
    expect(
      isEChartsOptionObject({
        geo: {},
        series: { type: 'graph', coordinateSystem: 'geo', data: [] },
      }),
    ).toBe(false);
  });

  it('rejects an unsupported explicit coordinate system before axis-free detection', () => {
    expect(
      isEChartsOptionObject({
        series: { type: 'graph', coordinateSystem: 'geo', data: [] },
      }),
    ).toBe(false);
  });

  it('rejects unsupported coordinates in timeline and responsive overrides', () => {
    expect(
      isEChartsOptionObject({
        baseOption: { timeline: {}, series: [{ type: 'graph', data: [] }] },
        options: [{ series: [{ coordinateSystem: 'geo' }] }],
      }),
    ).toBe(false);
    expect(
      isEChartsOptionObject({
        series: [{ type: 'graph', data: [] }],
        media: [{ query: { maxWidth: 500 }, option: { geo: {} } }],
      }),
    ).toBe(false);
  });

  it('rejects image-backed symbols and graphic images before they can load', () => {
    expect(
      isEChartsOptionObject({
        series: [{ type: 'pie', symbol: 'image://https://attacker.example/pixel' }],
      }),
    ).toBe(false);
    expect(
      isEChartsOptionObject({
        series: [{ type: 'pie', data: [1] }],
        graphic: [{ type: 'image', style: { image: 'https://attacker.example/pixel' } }],
      }),
    ).toBe(false);
    expect(
      isEChartsOptionObject({
        baseOption: { timeline: {}, series: [{ type: 'pie', data: [1] }] },
        options: [{ series: [{ symbol: 'image://https://attacker.example/pixel' }] }],
      }),
    ).toBe(false);
  });

  it('rejects a series entry without a chart type', () => {
    expect(isEChartsOptionObject({ series: [{ name: 'a', data: [1] }] })).toBe(false);
  });

  it('rejects an unknown chart type', () => {
    expect(isEChartsOptionObject({ series: [{ type: 'wordcloud' }] })).toBe(false);
  });

  it('rejects an axis-based type without any structure key', () => {
    expect(isEChartsOptionObject({ series: [{ type: 'bar', data: [1, 2] }] })).toBe(false);
  });

  it('rejects non-objects and arrays', () => {
    expect(isEChartsOptionObject(null)).toBe(false);
    expect(isEChartsOptionObject([BAR_OPTION])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEChartsOptionCode
// ---------------------------------------------------------------------------

describe('isEChartsOptionCode', () => {
  it('detects an axis-based chart', () => {
    expect(isEChartsOptionCode(BAR_OPTION)).toBe(true);
  });

  it('detects an axis-free chart by its type alone', () => {
    expect(isEChartsOptionCode(PIE_OPTION)).toBe(true);
  });

  it('detects a standard timeline option through baseOption', () => {
    expect(
      isEChartsOptionCode(
        JSON.stringify({
          baseOption: {
            timeline: { data: ['2025', '2026'] },
            xAxis: {},
            series: [{ type: 'bar', data: [1] }],
          },
          options: [{ series: [{ data: [2] }] }],
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['calendar', { calendar: {}, series: [{ type: 'heatmap', data: [] }] }],
    ['parallel', { parallel: {}, series: [{ type: 'parallel', data: [] }] }],
    ['parallelAxis', { parallelAxis: [], series: [{ type: 'parallel', data: [] }] }],
    ['singleAxis', { singleAxis: {}, series: [{ type: 'themeriver', data: [] }] }],
    ['matrix', { matrix: {}, series: [{ type: 'scatter', data: [] }] }],
  ])('detects the registered %s coordinate system', (_name, option) => {
    expect(isEChartsOptionCode(JSON.stringify(option))).toBe(true);
  });

  it('rejects geo coordinates because the safe modular runtime does not register them', () => {
    expect(isEChartsOptionCode('{"geo": {}, "series": [{"type": "scatter", "data": []}]}')).toBe(
      false,
    );
    expect(
      isEChartsOptionCode('{"geo": {}, "series": {"type": "graph", "coordinateSystem": "geo"}}'),
    ).toBe(false);
  });

  it('rejects an unsupported explicit coordinate system before axis-free detection', () => {
    expect(isEChartsOptionCode('{"series": {"type": "graph", "coordinateSystem": "geo"}}')).toBe(
      false,
    );
  });

  it('rejects image-backed options during the synchronous detection pass', () => {
    expect(
      isEChartsOptionCode(
        '{"series": {"type": "pie", "symbol": "image://https://attacker.example/pixel"}}',
      ),
    ).toBe(false);
    expect(
      isEChartsOptionCode(
        '{"series": {"type": "pie"}, "graphic": {"style": {"image": "https://attacker.example/pixel"}}}',
      ),
    ).toBe(false);
  });

  it('rejects plain JSON without a series key', () => {
    expect(isEChartsOptionCode('{"foo": "bar", "baz": 42}')).toBe(false);
  });

  it('rejects axis-only JSON whose types are not chart types', () => {
    expect(isEChartsOptionCode('{"xAxis": {"type": "category"}, "yAxis": {"type": "value"}}')).toBe(
      false,
    );
  });

  it('rejects a series without a type value', () => {
    expect(isEChartsOptionCode('{"series": [{"name": "a", "data": [1]}]}')).toBe(false);
  });

  it('rejects strings too short to be complete', () => {
    expect(isEChartsOptionCode('{"series":[]}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEChartsOption
// ---------------------------------------------------------------------------

describe('parseEChartsOption', () => {
  it('parses a plain JSON option', async () => {
    const parsed = await parseEChartsOption(BAR_OPTION);
    expect(parsed).toEqual(JSON.parse(BAR_OPTION));
  });

  it('keeps the full timeline option after validating baseOption', async () => {
    const option = {
      baseOption: {
        timeline: { data: ['2025', '2026'] },
        xAxis: {},
        series: [{ type: 'bar', data: [1] }],
      },
      options: [{ series: [{ data: [2] }] }],
    };

    expect(await parseEChartsOption(JSON.stringify(option))).toEqual(option);
  });

  it('parses JSON5 comments and trailing commas', async () => {
    const code = `{
  // monthly sales
  "xAxis": { "type": "category", "data": ["A", "B"], },
  "series": [{ "type": "bar", "data": [1, 2], }],
}`;
    const parsed = await parseEChartsOption(code);
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown>)['series']).toEqual([{ type: 'bar', data: [1, 2] }]);
  });

  it('extracts the object literal from a broken assignment prefix', async () => {
    // `export const` is not stripped by the assignment regex; the brace
    // extraction fallback must still find the option.
    const parsed = await parseEChartsOption(`export const option = ${PIE_OPTION};`);
    expect(parsed).toEqual(JSON.parse(PIE_OPTION));
  });

  it('returns null for non-chart JSON', async () => {
    expect(await parseEChartsOption('{"foo": "bar"}')).toBeNull();
  });

  it('returns null for unparseable input', async () => {
    expect(await parseEChartsOption('{not valid json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// moveNativeCopyButton
// ---------------------------------------------------------------------------

describe('moveNativeCopyButton', () => {
  const makeCodeBlock = (): {
    codeBlockHost: HTMLElement;
    parent: HTMLElement;
    toolbar: HTMLElement;
  } => {
    const codeBlockHost = document.createElement('code-block');
    const parent = document.createElement('div');
    parent.appendChild(codeBlockHost);
    const toolbar = document.createElement('div');
    return { codeBlockHost, parent, toolbar };
  };

  it('moves a .copy-button into the toolbar and resets its positioning', () => {
    const { codeBlockHost, toolbar } = makeCodeBlock();
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-button';
    copyBtn.style.position = 'absolute';
    copyBtn.style.top = '8px';
    codeBlockHost.appendChild(copyBtn);

    const moved = moveNativeCopyButton(codeBlockHost, toolbar);
    expect(moved).toBe(copyBtn);
    expect(toolbar.contains(copyBtn)).toBe(true);
    expect(copyBtn.style.position).toBe('static');
    expect(copyBtn.style.top).toBe('auto');
    expect(copyBtn.style.right).toBe('auto');
    // jsdom normalises the px unit on zero margins.
    expect(copyBtn.style.marginTop).toBe('0px');
  });

  it('prefers the .buttons container when present', () => {
    const { codeBlockHost, toolbar } = makeCodeBlock();
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    codeBlockHost.appendChild(buttons);
    codeBlockHost.appendChild(
      Object.assign(document.createElement('button'), { className: 'copy-button' }),
    );

    expect(moveNativeCopyButton(codeBlockHost, toolbar)).toBe(buttons);
    expect(toolbar.contains(buttons)).toBe(true);
  });

  it('returns null when no native copy button exists', () => {
    const { codeBlockHost, toolbar } = makeCodeBlock();
    expect(moveNativeCopyButton(codeBlockHost, toolbar)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processCodeBlocks language labels
// ---------------------------------------------------------------------------

describe('processCodeBlocks language labels', () => {
  const makeCodeBlock = (language: string | null, code: string): HTMLElement => {
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    if (language) {
      const span = document.createElement('span');
      span.textContent = language;
      decoration.appendChild(span);
    }
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = code;
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);
    return codeEl;
  };

  it('renders a chart under an explicit echarts label', async () => {
    makeCodeBlock('echarts', PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
  });

  it('renders a chart under an explicit echart label', async () => {
    makeCodeBlock('echart', PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
  });

  it('renders a chart under an explicit chart label', async () => {
    makeCodeBlock('chart', PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
  });

  it('does not render chart source inside a json-labelled block', async () => {
    makeCodeBlock('json', PIE_OPTION);
    processCodeBlocks();
    // The json label returns synchronously before any render is scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('renders chart source under a generic localized label', async () => {
    makeCodeBlock('代码段', BAR_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
  });

  it('renders chart source without any language label', async () => {
    makeCodeBlock(null, BAR_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
  });

  it('skips chart source inside a specific-language block', async () => {
    makeCodeBlock('typescript', PIE_OPTION);
    processCodeBlocks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('skips non-chart JSON in an unlabelled block', async () => {
    makeCodeBlock(null, '{"foo": "bar", "list": [1, 2, 3]}');
    processCodeBlocks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Render flow
// ---------------------------------------------------------------------------

describe('render flow', () => {
  const addEChartsBlock = (code: string, language = 'echarts'): HTMLElement => {
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    const span = document.createElement('span');
    span.textContent = language;
    decoration.appendChild(span);
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = code;
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);
    return codeEl;
  };

  it('inits a canvas chart with the dark theme and merged backdrop on a dark page', async () => {
    const darkHost = document.createElement('div');
    darkHost.className = 'theme-host dark-theme';
    document.body.appendChild(darkHost);
    addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const initMock = vi.mocked(echartsMod.init);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(document.querySelector('.gv-echarts-diagram'), 'dark', {
      renderer: 'canvas',
    });
    const fakeInstance = initMock.mock.results[0]?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: '#1a1a1a',
        series: [{ type: 'pie', data: [{ value: 1, name: 'a' }] }],
      }),
      true,
    );
  });

  it('keeps the renderer backdrop when the option supplies its own background', async () => {
    const darkHost = document.createElement('div');
    darkHost.className = 'theme-host dark-theme';
    document.body.appendChild(darkHost);
    addEChartsBlock(`{
      "backgroundColor": "hotpink",
      "series": [{ "type": "pie", "data": [{ "value": 1 }] }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundColor: '#1a1a1a' }),
      true,
    );
  });

  it('keeps the renderer backdrop in every timeline and responsive option layer', async () => {
    const darkHost = document.createElement('div');
    darkHost.className = 'theme-host dark-theme';
    document.body.appendChild(darkHost);
    addEChartsBlock(`{
      "backgroundColor": "top",
      "baseOption": {
        "backgroundColor": "base",
        "timeline": { "data": ["2026"] },
        "xAxis": {},
        "series": [{ "type": "bar", "data": [1] }]
      },
      "options": [{ "backgroundColor": "state", "series": [{ "data": [2] }] }],
      "media": [{ "option": { "backgroundColor": "media" } }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    const safeOption = fakeInstance.setOption.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(safeOption['backgroundColor']).toBe('#1a1a1a');
    expect((safeOption['baseOption'] as Record<string, unknown>)['backgroundColor']).toBe(
      '#1a1a1a',
    );
    expect((safeOption['options'] as Array<Record<string, unknown>>)[0]?.['backgroundColor']).toBe(
      '#1a1a1a',
    );
    const mediaOption = (safeOption['media'] as Array<Record<string, unknown>>)[0]?.[
      'option'
    ] as Record<string, unknown>;
    expect(mediaOption['backgroundColor']).toBe('#1a1a1a');
  });

  it('inits with no theme on a light page', async () => {
    const lightHost = document.createElement('div');
    lightHost.className = 'theme-host light-theme';
    document.body.appendChild(lightHost);
    addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      undefined,
      { renderer: 'canvas' },
    );
  });

  it('forces untrusted tooltip markup through the rich-text renderer', async () => {
    addEChartsBlock(`{
      "tooltip": {
        "renderMode": "html",
        "formatter": "<img src=x onerror=alert(1)>"
      },
      "series": { "type": "pie", "data": [{ "value": 1 }] }
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        tooltip: expect.objectContaining({
          formatter: '<img src=x onerror=alert(1)>',
          renderMode: 'richText',
        }),
      }),
      true,
    );
  });

  it('forces series-level tooltip formatters through the rich-text renderer', async () => {
    addEChartsBlock(`{
      "series": {
        "type": "pie",
        "tooltip": { "renderMode": "html", "formatter": "<img src=x>" },
        "data": [{ "value": 1 }]
      }
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        tooltip: { renderMode: 'richText' },
        series: expect.objectContaining({
          tooltip: {
            formatter: '<img src=x>',
            renderMode: 'richText',
          },
        }),
      }),
      true,
    );
  });

  it('forces tooltip rendering in timeline and responsive option layers', async () => {
    addEChartsBlock(`{
      "baseOption": {
        "timeline": { "data": ["2026"] },
        "xAxis": {},
        "tooltip": { "renderMode": "html", "formatter": "<b>base</b>" },
        "series": [{ "type": "bar", "data": [1] }]
      },
      "options": [{ "tooltip": { "formatter": "<b>state</b>" } }],
      "media": [{ "option": { "tooltip": { "formatter": "<b>media</b>" } } }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        aria: { enabled: true },
        baseOption: expect.objectContaining({
          aria: { enabled: true },
          tooltip: expect.objectContaining({ renderMode: 'richText' }),
        }),
        options: [
          expect.objectContaining({
            aria: { enabled: true },
            tooltip: expect.objectContaining({ renderMode: 'richText' }),
          }),
        ],
        media: [
          expect.objectContaining({
            option: expect.objectContaining({
              aria: { enabled: true },
              tooltip: expect.objectContaining({ renderMode: 'richText' }),
            }),
          }),
        ],
      }),
      true,
    );
  });

  it('removes active title links from every option layer before rendering', async () => {
    addEChartsBlock(`{
      "title": { "text": "Top", "link": "javascript:alert(1)", "target": "self" },
      "baseOption": {
        "timeline": { "data": ["2026"] },
        "xAxis": {},
        "title": { "text": "Base", "sublink": "javascript:alert(2)", "subtarget": "self" },
        "series": [{ "type": "bar", "data": [1] }]
      },
      "options": [{ "title": { "text": "State", "link": "javascript:alert(3)" } }],
      "media": [{ "option": { "title": { "text": "Media", "sublink": "javascript:alert(1)" } } }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    const safeOption = fakeInstance.setOption.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(safeOption['title']).toEqual({ text: 'Top' });
    expect((safeOption['baseOption'] as Record<string, unknown>)['title']).toEqual({
      text: 'Base',
    });
    expect((safeOption['options'] as Array<Record<string, unknown>>)[0]?.['title']).toEqual({
      text: 'State',
    });
    const mediaOption = (safeOption['media'] as Array<Record<string, unknown>>)[0]?.[
      'option'
    ] as Record<string, unknown>;
    expect(mediaOption['title']).toEqual({ text: 'Media' });
  });

  it('removes series-data navigation from every option layer', async () => {
    addEChartsBlock(`{
      "series": {
        "type": "treemap",
        "nodeClick": "link",
        "data": [{ "value": 1, "link": "javascript:alert(1)", "target": "self" }]
      },
      "baseOption": {
        "timeline": { "data": ["2026"] },
        "series": [{
          "type": "sunburst",
          "nodeClick": "link",
          "data": [{
            "value": 1,
            "link": "javascript:alert(2)",
            "children": [{ "value": 2, "link": "javascript:alert(3)", "target": "blank" }]
          }]
        }]
      },
      "options": [{
        "series": [{ "nodeClick": "link", "data": [{ "value": 3, "link": "javascript:alert(4)" }] }]
      }],
      "media": [{
        "option": {
          "series": [{ "nodeClick": "link", "data": [{ "value": 4, "target": "self" }] }]
        }
      }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    const safeOption = fakeInstance.setOption.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(safeOption['series']).toEqual({ type: 'treemap', data: [{ value: 1 }] });
    expect((safeOption['baseOption'] as Record<string, unknown>)['series']).toEqual([
      {
        type: 'sunburst',
        data: [{ value: 1, children: [{ value: 2 }] }],
      },
    ]);
    expect((safeOption['options'] as Array<Record<string, unknown>>)[0]?.['series']).toEqual([
      { data: [{ value: 3 }] },
    ]);
    const mediaOption = (safeOption['media'] as Array<Record<string, unknown>>)[0]?.[
      'option'
    ] as Record<string, unknown>;
    expect(mediaOption['series']).toEqual([{ data: [{ value: 4 }] }]);
  });

  it('removes HTML-bearing toolbox data views from every option layer', async () => {
    addEChartsBlock(`{
      "toolbox": [{ "feature": { "dataView": { "lang": ["<img src=x>"] }, "saveAsImage": {} } }],
      "baseOption": {
        "timeline": { "data": ["2026"] },
        "xAxis": {},
        "toolbox": { "feature": { "dataView": { "lang": ["<b>base</b>"] } } },
        "series": [{ "type": "bar", "data": [1] }]
      },
      "options": [{ "toolbox": { "feature": { "dataView": { "lang": ["state"] } } } }],
      "media": [{ "option": { "toolbox": { "feature": { "dataView": { "lang": ["media"] } } } } }]
    }`);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    const safeOption = fakeInstance.setOption.mock.calls[0]?.[0] as Record<string, unknown>;
    const topToolbox = (safeOption['toolbox'] as Array<Record<string, unknown>>)[0]!;
    expect(topToolbox['feature']).toEqual({ saveAsImage: {} });
    const baseToolbox = (safeOption['baseOption'] as Record<string, unknown>)['toolbox'] as Record<
      string,
      unknown
    >;
    expect(baseToolbox['feature']).toEqual({});
    const stateToolbox = (safeOption['options'] as Array<Record<string, unknown>>)[0]?.[
      'toolbox'
    ] as Record<string, unknown>;
    expect(stateToolbox['feature']).toEqual({});
    const responsiveOption = (safeOption['media'] as Array<Record<string, unknown>>)[0]?.[
      'option'
    ] as Record<string, unknown>;
    const responsiveToolbox = responsiveOption['toolbox'] as Record<string, unknown>;
    expect(responsiveToolbox['feature']).toEqual({});
  });

  it('disposes a new instance when applying the option throws', async () => {
    const echartsMod = await import('../runtime');
    const failedInstance = makeFakeInstance();
    failedInstance.setOption.mockImplementationOnce(() => {
      throw new Error('unsupported option');
    });
    vi.mocked(echartsMod.init).mockImplementationOnce(
      () => failedInstance as unknown as ReturnType<typeof echartsMod.init>,
    );
    const codeEl = addEChartsBlock(PIE_OPTION);
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;

    processCodeBlocks();

    await vi.waitFor(() => {
      expect(failedInstance.dispose).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
    expect(codeBlockHost.style.display).toBe('');
  });

  it('builds the wrapper, toggle and diagram container and hides the source', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION);
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    const wrapper = document.querySelector('.gv-echarts-wrapper') as HTMLElement;
    expect(wrapper.contains(codeBlockHost)).toBe(true);
    expect(codeBlockHost.style.display).toBe('none');
    const toggle = wrapper.querySelector('.gv-echarts-toggle') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(wrapper.firstElementChild).toBe(toggle);
    expect(getComputedStyle(toggle).position).not.toBe('absolute');
    expect(toggle.querySelector('[data-view="diagram"]')?.textContent).toContain('Diagram');
    expect(toggle.querySelector('[data-view="code"]')?.textContent).toContain('Code');
    expect(toggle.querySelector('[data-view="diagram"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(toggle.querySelector('[data-view="code"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('[data-action="fullscreen"]')?.getAttribute('aria-label')).toBe(
      'echartsFullscreenButton',
    );
    expect(wrapper.querySelector('.gv-echarts-diagram')).not.toBeNull();
    expect(codeEl.dataset.echartsCode).toBe(PIE_OPTION);
    expect(codeEl.dataset.echartsTheme).toBe('light');
    expect(codeEl.dataset.echartsProcessing).toBe('false');
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ aria: { enabled: true } }),
      true,
    );

    (toggle.querySelector('[data-view="code"]') as HTMLButtonElement).click();
    expect(toggle.querySelector('[data-view="diagram"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(toggle.querySelector('[data-view="code"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('provides a composited PNG from the live ECharts instance for export', async () => {
    addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const diagram = document.querySelector<HTMLElement>('.gv-echarts-diagram')!;
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;

    expect(requestEChartsDataUrl(diagram)).toEqual({
      handled: true,
      dataUrl: 'data:image/png;base64,COMPOSITED',
    });
    expect(fakeInstance.getDataURL).toHaveBeenCalledWith({
      type: 'png',
      pixelRatio: 1,
      backgroundColor: '#f9fafb',
    });
  });

  it('moves the native copy button into the toggle', async () => {
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    const span = document.createElement('span');
    span.textContent = 'echarts';
    decoration.appendChild(span);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    decoration.appendChild(buttons);
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = PIE_OPTION;
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);

    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-toggle')).not.toBeNull();
    });
    expect(document.querySelector('.gv-echarts-toggle')?.contains(buttons)).toBe(true);
  });

  it('re-renders with a fresh instance when the source changes', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsCode).toBe(PIE_OPTION);
    });
    const echartsMod = await import('../runtime');
    const initMock = vi.mocked(echartsMod.init);
    expect(initMock).toHaveBeenCalledTimes(1);
    const firstInstance = initMock.mock.results[0]?.value;

    const updated = `{
  "series": [{ "type": "pie", "data": [{ "value": 2, "name": "b" }] }]
}`;
    codeEl.textContent = updated;
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsCode).toBe(updated);
    });
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(firstInstance.dispose).toHaveBeenCalled();
  });

  it('renders only the latest source when it changes during async parsing', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    const latest = `{
  "series": [{ "type": "pie", "data": [{ "value": 9, "name": "latest" }] }]
}`;
    codeEl.textContent = latest;

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsCode).toBe(latest);
    });
    const echartsMod = await import('../runtime');
    const initMock = vi.mocked(echartsMod.init);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.results[0]?.value.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        series: [{ type: 'pie', data: [{ value: 9, name: 'latest' }] }],
      }),
      true,
    );
  });

  it('retries when an incomplete source becomes valid during a failed parse', async () => {
    const codeEl = addEChartsBlock('{ "series": [{ "type": "pie", "data": [');
    processCodeBlocks();
    expect(codeEl.dataset.echartsProcessing).toBe('true');

    codeEl.textContent = PIE_OPTION;

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsCode).toBe(PIE_OPTION);
    });
    const echartsMod = await import('../runtime');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledTimes(1);
  });

  it('abandons an in-flight generic render when Gemini finalizes a specific label', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION, '代码段');
    const language = codeEl.closest('code-block')!.querySelector('.code-block-decoration span')!;
    processCodeBlocks();
    expect(codeEl.dataset.echartsProcessing).toBe('true');

    language.textContent = 'json';
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsProcessing).toBe('false');
    });
    const echartsMod = await import('../runtime');
    expect(vi.mocked(echartsMod.init)).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('restores source view when a rendered option becomes invalid', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION);
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    const echartsMod = await import('../runtime');
    const instance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;

    codeEl.textContent = '{ "ordinary": true }';
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
    });
    expect(codeBlockHost.style.display).toBe('');
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it('restores source view when the block receives a specific non-ECharts label', async () => {
    const codeEl = addEChartsBlock(PIE_OPTION);
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });

    codeBlockHost.querySelector('.code-block-decoration span')!.textContent = 'json';
    processCodeBlocks();

    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
    expect(codeBlockHost.style.display).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Theme switching
// ---------------------------------------------------------------------------

describe('theme switching', () => {
  const addEChartsBlock = (code: string): HTMLElement => {
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    const span = document.createElement('span');
    span.textContent = 'echarts';
    decoration.appendChild(span);
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = code;
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);
    return codeEl;
  };

  it('re-renders an existing chart when the Gemini theme class changes', async () => {
    const host = document.createElement('div');
    host.className = 'theme-host light-theme';
    document.body.appendChild(host);
    const codeEl = addEChartsBlock(PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('light');
    });
    const echartsMod = await import('../runtime');
    const initMock = vi.mocked(echartsMod.init);
    expect(initMock).toHaveBeenCalledTimes(1);
    const lightInstance = initMock.mock.results[0]?.value;
    const diagramContainer = document.querySelector('.gv-echarts-diagram') as HTMLElement;
    document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!.click();
    const modalCard = document.querySelector('.gv-echarts-modal-card') as HTMLElement;
    expect(modalCard.style.getPropertyValue('--gv-echarts-panel-bg')).toBe('#f9fafb');

    host.className = 'theme-host dark-theme';
    // The MutationObserver debounces; a manual pass stands in for it.
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('dark');
    });
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(initMock).toHaveBeenLastCalledWith(diagramContainer, 'dark', { renderer: 'canvas' });
    expect(lightInstance.dispose).toHaveBeenCalled();
    expect(diagramContainer.style.getPropertyValue('--gv-echarts-panel-bg')).toBe('#1a1a1a');
    expect(modalCard.style.getPropertyValue('--gv-echarts-panel-bg')).toBe('#1a1a1a');
    _closeModalForTest();
  });

  it('defers a theme rerender until Code view reveals the diagram again', async () => {
    const host = document.createElement('div');
    host.className = 'theme-host light-theme';
    document.body.appendChild(host);
    const codeEl = addEChartsBlock(PIE_OPTION);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('light');
    });
    const echartsMod = await import('../runtime');
    const initMock = vi.mocked(echartsMod.init);
    const diagram = document.querySelector<HTMLElement>('.gv-echarts-diagram')!;

    document.querySelector<HTMLButtonElement>('[data-view="code"]')!.click();
    host.className = 'theme-host dark-theme';
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsProcessing).toBe('false');
    });

    expect(diagram.style.display).toBe('none');
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(requestEChartsDataUrl(diagram).dataUrl).toBe('data:image/png;base64,COMPOSITED');

    document.querySelector<HTMLButtonElement>('[data-view="diagram"]')!.click();
    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('dark');
    });
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(initMock).toHaveBeenLastCalledWith(diagram, 'dark', { renderer: 'canvas' });
  });

  it('honours an explicit light theme even when the media query is dark', async () => {
    const host = document.createElement('div');
    host.className = 'theme-host light-theme';
    document.body.appendChild(host);
    const codeEl = addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('light');
    });
    const echartsMod = await import('../runtime');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      undefined,
      { renderer: 'canvas' },
    );
  });

  it('uses the latest theme when it changes during asynchronous loading', async () => {
    const host = document.createElement('div');
    host.className = 'theme-host light-theme';
    document.body.appendChild(host);
    const codeEl = addEChartsBlock(PIE_OPTION);

    processCodeBlocks();
    host.className = 'theme-host dark-theme';

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('dark');
    });
    const echartsMod = await import('../runtime');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      'dark',
      { renderer: 'canvas' },
    );
  });
});

// ---------------------------------------------------------------------------
// Fullscreen overlay
// ---------------------------------------------------------------------------

describe('fullscreen overlay', () => {
  const addRenderedEChartsBlock = async (): Promise<HTMLElement> => {
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    const span = document.createElement('span');
    span.textContent = 'echarts';
    decoration.appendChild(span);
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = PIE_OPTION;
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);

    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    return document.querySelector('.gv-echarts-diagram') as HTMLElement;
  };

  it('moves the container into the modal, resizes it, and restores it on ESC', async () => {
    vi.useFakeTimers();
    const diagramContainer = await addRenderedEChartsBlock();
    const wrapper = diagramContainer.parentElement as HTMLElement;

    document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!.click();
    const modal = document.querySelector('.gv-echarts-modal') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(diagramContainer.parentElement?.classList.contains('gv-echarts-modal-card')).toBe(true);

    // The rAF after open resizes the canvas against the card.
    vi.runAllTimers();
    const echartsMod = await import('../runtime');
    const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
    expect(fakeInstance.resize).toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The modal removes itself after a 300 ms CSS transition.
    vi.advanceTimersByTime(400);
    expect(document.querySelector('.gv-echarts-modal')).toBeNull();
    expect(diagramContainer.parentElement).toBe(wrapper);
    expect(fakeInstance.resize).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('exposes modal semantics, traps focus, and restores the fullscreen trigger', async () => {
    await addRenderedEChartsBlock();
    const fullscreenBtn = document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!;
    fullscreenBtn.focus();
    fullscreenBtn.click();

    const modal = document.querySelector<HTMLElement>('.gv-echarts-modal')!;
    const closeBtn = modal.querySelector<HTMLButtonElement>('button')!;
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-label')).toBe('echartsFullscreenButton');
    expect(closeBtn.getAttribute('aria-label')).toBe('echartsCloseFullscreen');
    expect(document.activeElement).toBe(closeBtn);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(closeBtn);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(closeBtn);

    _closeModalForTest();
    expect(document.activeElement).toBe(fullscreenBtn);
  });

  it('opens a modal with the chart panel background colour', async () => {
    const diagramContainer = document.createElement('div');
    diagramContainer.style.setProperty('--gv-echarts-panel-bg', '#1a1a1a');
    _openFullscreenForTest(diagramContainer);
    const card = document.querySelector('.gv-echarts-modal-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.style.getPropertyValue('--gv-echarts-panel-bg')).toBe('#1a1a1a');
    expect(document.querySelector('.gv-echarts-modal-hint')).not.toBeNull();
    _closeModalForTest();
  });

  it('keeps canvas clicks available for inline ECharts interactions', async () => {
    const diagramContainer = await addRenderedEChartsBlock();

    diagramContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.gv-echarts-modal')).toBeNull();
  });

  it('disables fullscreen while the source view is visible', async () => {
    await addRenderedEChartsBlock();
    const codeBtn = document.querySelector<HTMLButtonElement>('[data-view="code"]')!;
    const fullscreenBtn = document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!;

    codeBtn.click();
    expect(fullscreenBtn.disabled).toBe(true);
    fullscreenBtn.click();

    expect(document.querySelector('.gv-echarts-modal')).toBeNull();
  });

  it('closes the fullscreen chart and disposes it when Gemini removes its host', async () => {
    const diagramContainer = await addRenderedEChartsBlock();
    const wrapper = diagramContainer.parentElement as HTMLElement;
    document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!.click();
    const echartsMod = await import('../runtime');
    const instance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;

    wrapper.remove();
    processCodeBlocks();

    expect(document.querySelector('.gv-echarts-modal')).toBeNull();
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not let an old close timer remove a newer modal', async () => {
    vi.useFakeTimers();
    await addRenderedEChartsBlock();
    document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    _closeModalForTest();

    const secondContainer = document.createElement('div');
    _openFullscreenForTest(secondContainer);
    vi.advanceTimersByTime(400);

    expect(document.querySelector('.gv-echarts-modal')).not.toBeNull();
    _closeModalForTest();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Runtime disable lifecycle
// ---------------------------------------------------------------------------

describe('runtime disable lifecycle', () => {
  const PIE_OPTION_SRC = PIE_OPTION;

  type StorageChangeListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void;

  const startEnabled = (): StorageChangeListener => {
    const storageGet = chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>;
    storageGet.mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) =>
        callback({ [StorageKeys.ECHARTS_ENABLED]: true }),
    );
    startEcharts();
    const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    return addListener.mock.calls.at(-1)?.[0] as StorageChangeListener;
  };

  const addEChartsBlock = (code = PIE_OPTION_SRC): HTMLElement => {
    const codeBlock = document.createElement('code-block');
    codeBlock.innerHTML = `
      <div class="code-block-decoration"><span>echarts</span></div>
      <pre><code data-test-id="code-content"></code></pre>
    `;
    const codeEl = codeBlock.querySelector<HTMLElement>('code')!;
    codeEl.textContent = code;
    document.body.appendChild(codeBlock);
    return codeEl;
  };

  const disable = (listener: StorageChangeListener): void => {
    listener(
      {
        [StorageKeys.ECHARTS_ENABLED]: { oldValue: true, newValue: false },
      },
      'sync',
    );
  };

  const enable = (listener: StorageChangeListener): void => {
    listener(
      {
        [StorageKeys.ECHARTS_ENABLED]: { oldValue: false, newValue: true },
      },
      'sync',
    );
  };

  it('does not let a late storage snapshot overwrite a newer disable event', async () => {
    let storageCallback: ((result: Record<string, unknown>) => void) | undefined;
    const storageGet = chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>;
    storageGet.mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        storageCallback = callback;
      },
    );
    startEcharts();
    const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    const onStorageChanged = addListener.mock.calls.at(-1)?.[0] as StorageChangeListener;
    addEChartsBlock();

    disable(onStorageChanged);
    storageCallback?.({ [StorageKeys.ECHARTS_ENABLED]: true });
    processCodeBlocks();
    await Promise.resolve();

    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('clears a queued debounced render when disabled', async () => {
    vi.useFakeTimers();
    const onStorageChanged = startEnabled();
    addEChartsBlock();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    disable(onStorageChanged);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);

    const echartsMod = await import('../runtime');
    expect(echartsMod.init).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('drops an in-flight render that resolves after disable', async () => {
    const onStorageChanged = startEnabled();
    const codeEl = addEChartsBlock();

    processCodeBlocks();
    expect(codeEl.dataset.echartsProcessing).toBe('true');
    disable(onStorageChanged);

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsProcessing).toBe('false');
    });
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('drops an in-flight render whose Gemini host detaches during async loading', async () => {
    startEnabled();
    const codeEl = addEChartsBlock();
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;

    processCodeBlocks();
    expect(codeEl.dataset.echartsProcessing).toBe('true');
    codeBlockHost.remove();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsProcessing).toBe('false');
    });
    const echartsMod = await import('../runtime');
    expect(echartsMod.init).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
  });

  it('restarts an in-flight render after a rapid disable and re-enable', async () => {
    const onStorageChanged = startEnabled();
    const codeEl = addEChartsBlock();

    processCodeBlocks();
    expect(codeEl.dataset.echartsProcessing).toBe('true');
    disable(onStorageChanged);
    enable(onStorageChanged);

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    expect(codeEl.dataset.echartsProcessing).toBe('false');
    const echartsMod = await import('../runtime');
    expect(echartsMod.init).toHaveBeenCalledTimes(1);
  });

  it('disposes and unobserves a chart whose Gemini host was removed', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    class ResizeObserverMock {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    }
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

    try {
      startEnabled();
      addEChartsBlock();
      processCodeBlocks();
      await vi.waitFor(() => {
        expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
      });
      const diagramContainer = document.querySelector('.gv-echarts-diagram') as HTMLElement;
      const echartsMod = await import('../runtime');
      const instance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;
      expect(observe).toHaveBeenCalledWith(diagramContainer);

      document.querySelector('.gv-echarts-wrapper')?.remove();
      processCodeBlocks();

      expect(unobserve).toHaveBeenCalledWith(diagramContainer);
      expect(instance.dispose).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('tears down a connected wrapper after Gemini removes only its source host', async () => {
    startEnabled();
    const codeEl = addEChartsBlock();
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    const wrapper = document.querySelector<HTMLElement>('.gv-echarts-wrapper')!;
    const echartsMod = await import('../runtime');
    const instance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;

    codeBlockHost.remove();
    expect(wrapper.isConnected).toBe(true);
    processCodeBlocks();

    expect(wrapper.isConnected).toBe(false);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not resize a chart to zero while Code view is visible', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | undefined;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

    try {
      startEnabled();
      addEChartsBlock();
      processCodeBlocks();
      await vi.waitFor(() => {
        expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
      });
      const diagram = document.querySelector<HTMLElement>('.gv-echarts-diagram')!;
      const echartsMod = await import('../runtime');
      const fakeInstance = vi.mocked(echartsMod.init).mock.results.at(-1)?.value;

      document.querySelector<HTMLButtonElement>('[data-view="code"]')!.click();
      fakeInstance.resize.mockClear();
      resizeCallback?.(
        [
          {
            target: diagram,
            contentRect: { width: 0, height: 0 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );

      expect(diagram.style.display).toBe('none');
      expect(fakeInstance.resize).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('restores rendered source and can render again after re-enable', async () => {
    const onStorageChanged = startEnabled();
    const codeEl = addEChartsBlock();
    const codeBlockHost = codeEl.closest<HTMLElement>('code-block')!;
    const decoration = codeBlockHost.querySelector<HTMLElement>('.code-block-decoration')!;
    const nativeButtons = document.createElement('div');
    nativeButtons.className = 'buttons';
    nativeButtons.setAttribute(
      'style',
      'position: absolute; top: 8px; right: 12px; margin-top: 3px; color: red;',
    );
    const beforeButtons = document.createElement('span');
    beforeButtons.textContent = 'before';
    const afterButtons = document.createElement('span');
    afterButtons.textContent = 'after';
    decoration.append(beforeButtons, nativeButtons, afterButtons);
    const originalChildren = Array.from(decoration.childNodes);
    const originalStyle = nativeButtons.getAttribute('style');

    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    expect(document.querySelector('.gv-echarts-toggle')?.contains(nativeButtons)).toBe(true);
    expect(document.getElementById('gv-echarts-styles')).not.toBeNull();

    disable(onStorageChanged);

    expect(document.querySelector('.gv-echarts-wrapper')).toBeNull();
    expect(document.getElementById('gv-echarts-styles')).toBeNull();
    expect(codeBlockHost.style.display).toBe('');
    expect(Array.from(decoration.childNodes)).toEqual(originalChildren);
    expect(nativeButtons.getAttribute('style')).toBe(originalStyle);
    expect(codeEl.dataset.echartsCode).toBeUndefined();

    enable(onStorageChanged);
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-wrapper')).not.toBeNull();
    });
    expect(document.getElementById('gv-echarts-styles')).not.toBeNull();
  });
});
