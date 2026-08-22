import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  _closeModalForTest,
  _openFullscreenForTest,
  _resetWaveDromLifecycleForTest,
  _resetWaveDromLoader,
  computeAutoFitScale,
  isWaveJsonCode,
  makeResponsiveSvg,
  moveNativeCopyButton,
  parseViewBoxSize,
  processCodeBlocks,
  remapDarkSkinStyle,
  renderWaveSvg,
  resolveGeminiTheme,
  resolveWaveRenderTheme,
  startWaveDrom,
} from '../index';

// ---------------------------------------------------------------------------
// Mock dynamic imports so the loader never hits the network.
// ---------------------------------------------------------------------------

// Realistic dark skin tree with the bundled near-black fills (same shape as
// the real skin — the module-level remap must rewrite these values).
const DARK_SKIN_STYLE =
  '.s6{fill:#000000;stroke:none;fill-opacity:1}' +
  '.s8{color:#000;fill:#000;fill-opacity:1;stroke:none}' +
  '.s9{color:#000;fill:#0010c0;fill-opacity:1;stroke:none}' +
  '.s10{color:#000;fill:#2d6500;fill-opacity:1;stroke:none}' +
  '.s11{color:#000;fill:#870500;fill-opacity:1;stroke:none}' +
  '.s12{color:#000;fill:#007a80;fill-opacity:1;stroke:none}' +
  '.s13{color:#000;fill:#680066;fill-opacity:1;stroke:none}' +
  '.s14{color:#000;fill:#5f5f5f;fill-opacity:1;stroke:none}' +
  '.s15{color:#000;fill:#2e005e;fill-opacity:1;stroke:none}';

const MOCK_DARK_SKIN_TREE = [
  'svg',
  {},
  ['style', {}, DARK_SKIN_STYLE],
  ['defs', {}, ''],
  ['g', {}, ''],
];

vi.mock('wavedrom/render-any', () => ({
  default: vi.fn(() => ['svg', {}, '']),
}));

vi.mock('onml/stringify.js', () => ({
  default: vi.fn(() => '<svg viewBox="0 0 100 50"><g/></svg>'),
}));

// Mock shapes mirror what the runtime sees after CJS interop: the bundler
// wraps each skins file's module.exports as the namespace `.default`, so the
// loader receives `{ default: <collection> }`. renderAny reads `skin.default`
// / the first named key before indexing the tree, so a skin must always be a
// *collection* — a bare tree would select the first node and throw.
vi.mock('wavedrom/skins/dark.js', () => ({
  default: { dark: MOCK_DARK_SKIN_TREE },
}));

vi.mock('wavedrom/skins/default.js', () => ({
  default: { default: ['svg', {}, ['style', {}, ''], '', ''] },
}));

vi.mock('json5', () => ({
  default: { parse: (s: string) => JSON.parse(s) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetWaveDromLifecycleForTest();
  _resetWaveDromLoader();
  _closeModalForTest();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.body.className = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.useRealTimers();
  _resetWaveDromLifecycleForTest();
});

// ---------------------------------------------------------------------------
// resolveWaveRenderTheme
// ---------------------------------------------------------------------------

describe('resolveWaveRenderTheme', () => {
  it('follows the app theme in auto mode', () => {
    expect(resolveWaveRenderTheme('auto', 'dark')).toBe('dark');
    expect(resolveWaveRenderTheme('auto', 'light')).toBe('light');
  });

  it('stays light in light-only mode regardless of the app theme', () => {
    expect(resolveWaveRenderTheme('light', 'dark')).toBe('light');
    expect(resolveWaveRenderTheme('light', 'light')).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// remapDarkSkinStyle
// ---------------------------------------------------------------------------

describe('remapDarkSkinStyle', () => {
  it('rewrites near-black s6 fill to mid-tone', () => {
    const result = remapDarkSkinStyle('.s6{fill:#000000;stroke:none}');
    expect(result).toContain('fill: #4a4a4a');
    expect(result).not.toContain('#000000');
  });

  it('rewrites all targeted classes', () => {
    const result = remapDarkSkinStyle(DARK_SKIN_STYLE);
    expect(result).toContain('fill: #4a4a4a'); // s6
    expect(result).toContain('fill: #5c5c5c'); // s8
    expect(result).toContain('fill: #3050b8'); // s9
    expect(result).toContain('fill: #4a8a2a'); // s10
    expect(result).toContain('fill: #b04a3a'); // s11
    expect(result).toContain('fill: #1a8a90'); // s12
    expect(result).toContain('fill: #8a3a8a'); // s13
    expect(result).toContain('fill: #7a7a7a'); // s14
    expect(result).toContain('fill: #7a4ac0'); // s15
  });

  it('does not contain any of the original near-black fills', () => {
    const result = remapDarkSkinStyle(DARK_SKIN_STYLE);
    expect(result).not.toMatch(
      /(\.s[0-9]+)\{[^}]*fill:\s*#(?:000000|000|0010c0|2d6500|870500|007a80|680066|5f5f5f|2e005e)/,
    );
  });

  it('leaves the light skin (no matching classes) unchanged', () => {
    const lightStyle = '.s0{fill:#ffffff}.s1{stroke:#000000}';
    expect(remapDarkSkinStyle(lightStyle)).toBe(lightStyle);
  });
});

// ---------------------------------------------------------------------------
// remapDarkSkinStyle on real bundled skin
// ---------------------------------------------------------------------------

describe('remapDarkSkinStyle against the real bundled dark skin', () => {
  it('remaps every near-black fill of the real bundled dark skin', async () => {
    const actual =
      await vi.importActual<typeof import('wavedrom/skins/dark.js')>('wavedrom/skins/dark.js');
    const tree = actual.default.dark as unknown as [string, unknown, [string, unknown, string]];
    const remapped = remapDarkSkinStyle(tree[2][2]);
    expect(remapped).toContain('fill: #4a4a4a');
    expect(remapped).toContain('fill: #3050b8');
    expect(remapped).toContain('fill: #7a4ac0');
    expect(remapped).not.toMatch(
      /(\.s[0-9]+)\{[^}]*fill:\s*#(?:000000|000|0010c0|2d6500|870500|007a80|680066|5f5f5f|2e005e)/,
    );
  });
});

// ---------------------------------------------------------------------------
// makeResponsiveSvg
// ---------------------------------------------------------------------------

describe('makeResponsiveSvg', () => {
  it('replaces fixed pixel dimensions with 100% on SVGs that have a viewBox', () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200" viewBox="0 0 800 200"><g/></svg>';
    const result = makeResponsiveSvg(input);
    expect(result).toContain('width="100%"');
    expect(result).toContain('height="100%"');
    expect(result).not.toMatch(/width="800"/);
    expect(result).not.toMatch(/height="200"/);
  });

  it('leaves SVGs without a viewBox untouched', () => {
    const input = '<svg width="800" height="200"><g/></svg>';
    expect(makeResponsiveSvg(input)).toBe(input);
  });

  it('preserves all other attributes', () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" id="foo" width="100" height="50" viewBox="0 0 100 50"><g/></svg>';
    const result = makeResponsiveSvg(input);
    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result).toContain('id="foo"');
    expect(result).toContain('viewBox="0 0 100 50"');
  });
});

// ---------------------------------------------------------------------------
// isWaveJsonCode
// ---------------------------------------------------------------------------

describe('isWaveJsonCode', () => {
  it('detects a minimal valid WaveJSON object', () => {
    expect(isWaveJsonCode('{"signal": [{"name":"clk","wave":"p..."}]}')).toBe(true);
  });

  it('detects assign-based WaveJSON', () => {
    expect(isWaveJsonCode('{"assign": [["out",["and","a","b"]]]}')).toBe(true);
  });

  it('detects reg-based WaveJSON', () => {
    expect(isWaveJsonCode('{"reg": [{"bits":8}]}')).toBe(true);
  });

  it('rejects plain JSON without signal/assign/reg', () => {
    expect(isWaveJsonCode('{"foo": "bar", "baz": 42}')).toBe(false);
  });

  it('rejects Mermaid code', () => {
    expect(isWaveJsonCode('graph LR\n  A-->B\n  B-->C')).toBe(false);
  });

  it('rejects strings too short to be complete', () => {
    expect(isWaveJsonCode('{"signal":[{}')).toBe(false);
  });

  it('rejects non-object JSON', () => {
    expect(isWaveJsonCode('[{"signal": []}]')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveGeminiTheme
// ---------------------------------------------------------------------------

describe('resolveGeminiTheme', () => {
  const make = (html: string): Document => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = html;
    return doc;
  };

  it('returns dark for an explicit .theme-host.dark-theme element', () => {
    const doc = make('<div class="theme-host dark-theme"></div>');
    expect(resolveGeminiTheme(doc, false)).toBe('dark');
  });

  it('returns light for an explicit .theme-host.light-theme element', () => {
    const doc = make('<div class="theme-host light-theme"></div>');
    expect(resolveGeminiTheme(doc, true)).toBe('light');
  });

  it('falls back to the media query when no explicit marker is present', () => {
    expect(resolveGeminiTheme(document.implementation.createHTMLDocument(), true)).toBe('dark');
    expect(resolveGeminiTheme(document.implementation.createHTMLDocument(), false)).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// Fullscreen overlay backdrop
// ---------------------------------------------------------------------------

describe('_openFullscreenForTest', () => {
  it('opens a modal with the supplied panel background colour', () => {
    _openFullscreenForTest('<svg viewBox="0 0 100 50"><g/></svg>', '#1a1a1a');
    const card = document.querySelector('[data-testid="wavedrom-zoom-card"]') as HTMLElement;
    expect(card).not.toBeNull();
    // jsdom normalises #1a1a1a → rgb(26,26,26)
    expect(card.style.background).toBe('rgb(26, 26, 26)');
  });

  it('injects width/height 100% on SVG roots that carry a viewBox', () => {
    _openFullscreenForTest(
      '<svg viewBox="0 0 800 200" width="800" height="200"><g/></svg>',
      '#f9fafb',
    );
    const svgEl = document.querySelector('[data-testid="wavedrom-zoom-card"] svg') as SVGSVGElement;
    expect(svgEl.getAttribute('width')).toBe('100%');
    expect(svgEl.getAttribute('height')).toBe('100%');
  });

  it('closes on ESC', () => {
    vi.useFakeTimers();
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    // Flush the rAF that adds the 'visible' class.
    vi.runAllTimers();
    expect(document.querySelector('.gv-wavedrom-modal')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The modal removes itself after a 300 ms CSS transition.
    vi.advanceTimersByTime(400);
    expect(document.querySelector('.gv-wavedrom-modal')).toBeNull();
    vi.useRealTimers();
  });

  it('tears down completely when closed externally and can reopen', () => {
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    expect(document.querySelector('.gv-wavedrom-modal')).not.toBeNull();
    _closeModalForTest();
    expect(document.querySelector('.gv-wavedrom-modal')).toBeNull();
    // A fresh modal must open again without interference from stale listeners.
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    expect(document.querySelector('.gv-wavedrom-modal')).not.toBeNull();
    _closeModalForTest();
  });

  it('releases document-level listeners when closed via ESC', () => {
    vi.useFakeTimers();
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    vi.runAllTimers();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(400);
    // After the fade-out the modal is gone and pressing ESC again is a no-op
    // (no stale keydown handler, no re-added modal, no throw).
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }).not.toThrow();
    expect(document.querySelector('.gv-wavedrom-modal')).toBeNull();
    vi.useRealTimers();
  });

  it('does not let a stale close timer tear down a newly opened modal', () => {
    vi.useFakeTimers();
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    vi.runAllTimers();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    _closeModalForTest();
    _openFullscreenForTest('<svg viewBox="0 0 100 50"><g/></svg>', '#f9fafb');
    vi.advanceTimersByTime(400);

    expect(document.querySelectorAll('.gv-wavedrom-modal')).toHaveLength(1);
    _closeModalForTest();
  });
});

// ---------------------------------------------------------------------------
// renderWaveSvg + DOMPurify sanitisation
// ---------------------------------------------------------------------------

describe('renderWaveSvg sanitisation', () => {
  it('strips script and event handlers from library-generated SVG', async () => {
    const stringifyMod = await import('onml/stringify.js');
    vi.mocked(stringifyMod.default).mockReturnValue(
      '<svg viewBox="0 0 100 50"><script>alert(1)</script><g onload="alert(2)"><text>ok</text></g></svg>',
    );
    const svg = await renderWaveSvg('{"signal": [{"name":"clk","wave":"p..."}]}', false);
    expect(svg).not.toBeNull();
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onload');
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toContain('<text>ok</text>');
  });

  it('keeps the dark-skin <style> block when sanitising', async () => {
    const stringifyMod = await import('onml/stringify.js');
    vi.mocked(stringifyMod.default).mockReturnValue(
      '<svg viewBox="0 0 100 50"><defs><style>.s6{fill:#000000}</style></defs><g/></svg>',
    );
    const svg = await renderWaveSvg('{"signal": [{"name":"clk","wave":"p..."}]}', true);
    expect(svg).not.toBeNull();
    expect(svg).toContain('<style>');
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

  it('does not steal controls from a sibling WaveDrom block', () => {
    const first = makeCodeBlock();
    const second = makeCodeBlock();
    const firstButtons = document.createElement('div');
    firstButtons.className = 'buttons';
    const secondButtons = document.createElement('div');
    secondButtons.className = 'buttons';
    first.codeBlockHost.appendChild(firstButtons);
    second.codeBlockHost.appendChild(secondButtons);

    expect(moveNativeCopyButton(second.codeBlockHost, second.toolbar)).toBe(secondButtons);
    expect(first.codeBlockHost.contains(firstButtons)).toBe(true);
    expect(second.toolbar.contains(firstButtons)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseViewBoxSize + computeAutoFitScale
// ---------------------------------------------------------------------------

describe('parseViewBoxSize', () => {
  const makeSvg = (viewBox: string | null): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (viewBox !== null) svg.setAttribute('viewBox', viewBox);
    return svg;
  };

  it('parses a 4-value viewBox into intrinsic size', () => {
    expect(parseViewBoxSize(makeSvg('0 0 800 200'))).toEqual({ w: 800, h: 200 });
  });

  it('returns null without a viewBox', () => {
    expect(parseViewBoxSize(makeSvg(null))).toBeNull();
  });

  it('returns null for degenerate viewBox values', () => {
    expect(parseViewBoxSize(makeSvg('0 0 0 200'))).toBeNull();
    expect(parseViewBoxSize(makeSvg('0 0 800 0'))).toBeNull();
    expect(parseViewBoxSize(makeSvg('0 0'))).toBeNull();
  });
});

describe('computeAutoFitScale', () => {
  it('fits a large diagram into the viewport', () => {
    // 1920 - 160 padding on each axis
    expect(computeAutoFitScale(2000, 1000, 1840, 1040)).toBeCloseTo(0.92);
  });

  it('clamps to the 10x maximum', () => {
    expect(computeAutoFitScale(100, 50, 1840, 1040)).toBe(10);
  });

  it('clamps to the 0.1x minimum', () => {
    expect(computeAutoFitScale(100000, 50000, 1840, 1040)).toBe(0.1);
  });

  it('returns 1 for unusable input', () => {
    expect(computeAutoFitScale(0, 100, 1840, 1040)).toBe(1);
    expect(computeAutoFitScale(100, 0, 1840, 1040)).toBe(1);
    expect(computeAutoFitScale(100, 100, 0, 1040)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderWaveSvg skin collections
// ---------------------------------------------------------------------------

describe('renderWaveSvg skin collections', () => {
  it('passes skin collections (not bare trees) to renderAny', async () => {
    const renderAnyMod = await import('wavedrom/render-any');
    const renderAnyMock = vi.mocked(renderAnyMod.default);
    const code = '{"signal": [{"name":"clk","wave":"p..."}]}';

    await renderWaveSvg(code, false);
    const lightSkin = renderAnyMock.mock.calls[0]?.[2] as Record<string, unknown>;
    // renderAny reads `skin.default` / the first named key before indexing the
    // tree; a bare ONML array would select the first node ('svg') and throw.
    expect(lightSkin).toEqual(expect.objectContaining({ default: expect.any(Array) }));

    await renderWaveSvg(code, true);
    const darkSkin = renderAnyMock.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(darkSkin).toEqual(expect.objectContaining({ dark: expect.any(Array) }));
  });
});

// ---------------------------------------------------------------------------
// processCodeBlocks language labels
// ---------------------------------------------------------------------------

describe('processCodeBlocks language labels', () => {
  const WAVEJSON = '{"signal": [{"name":"clk","wave":"p..."}]}';

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

  it('renders WaveJSON under an explicit wavedrom label', async () => {
    makeCodeBlock('wavedrom', WAVEJSON);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
  });

  it('renders WaveJSON under an explicit wavejson label', async () => {
    makeCodeBlock('wavejson', WAVEJSON);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
  });

  it('does not render WaveJSON inside a json-labelled block', async () => {
    makeCodeBlock('json', WAVEJSON);
    processCodeBlocks();
    // The json label returns synchronously before any render is scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.gv-wavedrom-wrapper')).toBeNull();
  });

  it('renders WaveJSON under a generic localized label', async () => {
    makeCodeBlock('代码段', WAVEJSON);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
  });

  it('renders WaveJSON without any language label', async () => {
    makeCodeBlock(null, WAVEJSON);
    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
  });

  it('skips WaveJSON inside a specific-language block', async () => {
    makeCodeBlock('typescript', WAVEJSON);
    processCodeBlocks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.gv-wavedrom-wrapper')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Runtime disable lifecycle
// ---------------------------------------------------------------------------

describe('runtime disable lifecycle', () => {
  const WAVEJSON = '{"signal": [{"name":"clk","wave":"p..."}]}';

  type StorageChangeListener = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void;

  const startEnabled = (): StorageChangeListener => {
    const storageGet = chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>;
    storageGet.mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) =>
        callback({ [StorageKeys.WAVEDROM_ENABLED]: true }),
    );
    startWaveDrom();
    const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    return addListener.mock.calls.at(-1)?.[0] as StorageChangeListener;
  };

  const addWaveDromBlock = (): HTMLElement => {
    const codeBlock = document.createElement('code-block');
    codeBlock.innerHTML = `
      <div class="code-block-decoration"><span>wavedrom</span></div>
      <pre><code data-test-id="code-content"></code></pre>
    `;
    const codeEl = codeBlock.querySelector<HTMLElement>('code')!;
    codeEl.textContent = WAVEJSON;
    document.body.appendChild(codeBlock);
    return codeEl;
  };

  const disable = (listener: StorageChangeListener): void => {
    listener(
      {
        [StorageKeys.WAVEDROM_ENABLED]: { oldValue: true, newValue: false },
      },
      'sync',
    );
  };

  const enable = (listener: StorageChangeListener): void => {
    listener(
      {
        [StorageKeys.WAVEDROM_ENABLED]: { oldValue: false, newValue: true },
      },
      'sync',
    );
  };

  it('clears a queued debounced render when disabled', async () => {
    vi.useFakeTimers();
    const onStorageChanged = startEnabled();
    addWaveDromBlock();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    disable(onStorageChanged);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);

    const renderAnyMod = await import('wavedrom/render-any');
    expect(renderAnyMod.default).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-wavedrom-wrapper')).toBeNull();
  });

  it('drops an in-flight render that resolves after disable', async () => {
    const onStorageChanged = startEnabled();
    const codeEl = addWaveDromBlock();

    processCodeBlocks();
    expect(codeEl.dataset.wavedromProcessing).toBe('true');
    disable(onStorageChanged);

    await vi.waitFor(() => {
      expect(codeEl.dataset.wavedromProcessing).toBe('false');
    });
    expect(document.querySelector('.gv-wavedrom-wrapper')).toBeNull();
  });

  it('restores rendered source and can render again after re-enable', async () => {
    const onStorageChanged = startEnabled();
    const codeEl = addWaveDromBlock();
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
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
    expect(document.querySelector('.gv-wavedrom-toggle')?.contains(nativeButtons)).toBe(true);
    expect(document.getElementById('gv-wavedrom-styles')).not.toBeNull();
    _openFullscreenForTest('<svg viewBox="0 0 50 50"><g/></svg>', '#f9fafb');
    expect(document.querySelector('.gv-wavedrom-modal')).not.toBeNull();

    disable(onStorageChanged);

    expect(document.querySelector('.gv-wavedrom-wrapper')).toBeNull();
    expect(document.querySelector('.gv-wavedrom-modal')).toBeNull();
    expect(document.getElementById('gv-wavedrom-styles')).toBeNull();
    expect(codeBlockHost.style.display).toBe('');
    expect(Array.from(decoration.childNodes)).toEqual(originalChildren);
    expect(nativeButtons.getAttribute('style')).toBe(originalStyle);
    expect(codeEl.dataset.wavedromCode).toBeUndefined();

    enable(onStorageChanged);
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-wrapper')).not.toBeNull();
    });
    expect(document.getElementById('gv-wavedrom-styles')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fullscreen SVG sizing and layout
// ---------------------------------------------------------------------------

describe('fullscreen SVG sizing and layout', () => {
  it('sizes the SVG from the viewBox before zooming (no 300x150 fallback)', () => {
    _openFullscreenForTest(
      '<svg viewBox="0 0 800 200" width="100%" height="100%"><g/></svg>',
      '#f9fafb',
    );
    const svgEl = document.querySelector('[data-testid="wavedrom-zoom-card"] svg') as SVGSVGElement;
    // jsdom window is 1024×768; viewport after the 80px margin is 864×608.
    // fitScale = min(864/800, 608/200) = 1.08 → definite pixel box.
    expect(svgEl.style.width).toBe('864px');
    expect(svgEl.style.height).toBe('216px');
    _closeModalForTest();
  });

  it('lays out overlay, toolbar and hint for both light and dark panels', () => {
    const themes = [
      ['#f9fafb', 'rgb(249, 250, 251)'],
      ['#1a1a1a', 'rgb(26, 26, 26)'],
    ] as const;
    for (const [bg, rgb] of themes) {
      _openFullscreenForTest('<svg viewBox="0 0 100 50"><g/></svg>', bg);
      const modal = document.querySelector('.gv-wavedrom-modal') as HTMLElement;
      expect(modal).not.toBeNull();
      // Toolbar holds the four zoom/close controls.
      const toolbar = modal.querySelector('.gv-wavedrom-modal-toolbar') as HTMLElement;
      expect(toolbar.querySelectorAll('button')).toHaveLength(4);
      // Card carries the panel backdrop.
      const card = modal.querySelector('[data-testid="wavedrom-zoom-card"]') as HTMLElement;
      expect(card.style.background).toBe(rgb);
      expect(modal.querySelector('.gv-wavedrom-modal-hint')).not.toBeNull();
      _closeModalForTest();
    }
  });

  it('injects centered overlay CSS shared by both themes', async () => {
    // Drive the real render path so the shared styles are injected once.
    const codeBlock = document.createElement('code-block');
    const decoration = document.createElement('div');
    decoration.className = 'code-block-decoration';
    const span = document.createElement('span');
    span.textContent = 'wavedrom';
    decoration.appendChild(span);
    const codeEl = document.createElement('code');
    codeEl.setAttribute('data-test-id', 'code-content');
    codeEl.textContent = '{"signal": [{"name":"clk","wave":"p..."}]}';
    codeBlock.append(decoration, codeEl);
    document.body.appendChild(codeBlock);

    processCodeBlocks();
    await vi.waitFor(() => {
      expect(document.querySelector('.gv-wavedrom-diagram')).not.toBeNull();
    });

    const styleEl = document.getElementById('gv-wavedrom-styles') as HTMLStyleElement;
    expect(styleEl).not.toBeNull();
    expect(styleEl.textContent).toContain('align-items: center');
    expect(styleEl.textContent).toContain('justify-content: center');
  });
});
