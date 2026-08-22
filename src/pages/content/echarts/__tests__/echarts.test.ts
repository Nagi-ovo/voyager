import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

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
  resize: vi.fn(),
  dispose: vi.fn(),
});

vi.mock('echarts', () => ({
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
    const echartsMod = await import('echarts');
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

  it('inits with no theme on a light page', async () => {
    const lightHost = document.createElement('div');
    lightHost.className = 'theme-host light-theme';
    document.body.appendChild(lightHost);
    addEChartsBlock(PIE_OPTION);
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-echarts-diagram')).not.toBeNull();
    });
    const echartsMod = await import('echarts');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      undefined,
      { renderer: 'canvas' },
    );
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
    expect(toggle.querySelector('[data-view="diagram"]')?.textContent).toContain('Diagram');
    expect(toggle.querySelector('[data-view="code"]')?.textContent).toContain('Code');
    expect(wrapper.querySelector('.gv-echarts-diagram')).not.toBeNull();
    expect(codeEl.dataset.echartsCode).toBe(PIE_OPTION);
    expect(codeEl.dataset.echartsTheme).toBe('light');
    expect(codeEl.dataset.echartsProcessing).toBe('false');
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
    const echartsMod = await import('echarts');
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
    const echartsMod = await import('echarts');
    const initMock = vi.mocked(echartsMod.init);
    expect(initMock).toHaveBeenCalledTimes(1);
    const lightInstance = initMock.mock.results[0]?.value;

    host.className = 'theme-host dark-theme';
    // The MutationObserver debounces; a manual pass stands in for it.
    processCodeBlocks();

    await vi.waitFor(() => {
      expect(codeEl.dataset.echartsTheme).toBe('dark');
    });
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(initMock).toHaveBeenLastCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      'dark',
      { renderer: 'canvas' },
    );
    expect(lightInstance.dispose).toHaveBeenCalled();
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
    const echartsMod = await import('echarts');
    expect(vi.mocked(echartsMod.init)).toHaveBeenCalledWith(
      document.querySelector('.gv-echarts-diagram'),
      undefined,
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

    diagramContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const modal = document.querySelector('.gv-echarts-modal') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(diagramContainer.parentElement?.classList.contains('gv-echarts-modal-card')).toBe(true);

    // The rAF after open resizes the canvas against the card.
    vi.runAllTimers();
    const echartsMod = await import('echarts');
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

  it('opens a modal with the supplied panel background colour', async () => {
    _openFullscreenForTest(document.createElement('div'), '#1a1a1a');
    const card = document.querySelector('.gv-echarts-modal-card') as HTMLElement;
    expect(card).not.toBeNull();
    // jsdom normalises #1a1a1a → rgb(26,26,26)
    expect(card.style.background).toBe('rgb(26, 26, 26)');
    expect(document.querySelector('.gv-echarts-modal-hint')).not.toBeNull();
    _closeModalForTest();
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

    const echartsMod = await import('echarts');
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
