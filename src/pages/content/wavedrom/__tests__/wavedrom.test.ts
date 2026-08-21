import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeModalForTest,
  _openFullscreenForTest,
  _resetWaveDromLoader,
  computeAutoFitScale,
  isWaveJsonCode,
  makeResponsiveSvg,
  moveNativeCopyButton,
  parseViewBoxSize,
  remapDarkSkinStyle,
  renderWaveSvg,
  resolveGeminiTheme,
  resolveWaveRenderTheme,
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

vi.mock('wavedrom', () => ({
  default: {
    renderAny: vi.fn(() => ['svg', {}, '']),
    onml: { stringify: vi.fn(() => '<svg viewBox="0 0 100 50"><g/></svg>') },
  },
}));

vi.mock('wavedrom/skins/dark.js', () => ({
  default: { dark: MOCK_DARK_SKIN_TREE },
}));

vi.mock('wavedrom/skins/default.js', () => ({
  default: { default: { name: 'default-skin' } },
}));

vi.mock('json5', () => ({
  default: { parse: (s: string) => JSON.parse(s) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetWaveDromLoader();
  _closeModalForTest();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  document.body.className = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
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
});

// ---------------------------------------------------------------------------
// renderWaveSvg + DOMPurify sanitisation
// ---------------------------------------------------------------------------

describe('renderWaveSvg sanitisation', () => {
  it('strips script and event handlers from library-generated SVG', async () => {
    const waveDromMod = await import('wavedrom');
    vi.mocked(waveDromMod.default.onml.stringify).mockReturnValue(
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
    const waveDromMod = await import('wavedrom');
    vi.mocked(waveDromMod.default.onml.stringify).mockReturnValue(
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
  const makeWrapper = (): { wrapper: HTMLElement; parent: HTMLElement; toolbar: HTMLElement } => {
    const wrapper = document.createElement('div');
    const parent = document.createElement('div');
    parent.appendChild(wrapper);
    const toolbar = document.createElement('div');
    return { wrapper, parent, toolbar };
  };

  it('moves a .copy-button into the toolbar and resets its positioning', () => {
    const { wrapper, parent, toolbar } = makeWrapper();
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-button';
    copyBtn.style.position = 'absolute';
    copyBtn.style.top = '8px';
    parent.appendChild(copyBtn);

    const moved = moveNativeCopyButton(wrapper, toolbar);
    expect(moved).toBe(copyBtn);
    expect(toolbar.contains(copyBtn)).toBe(true);
    expect(copyBtn.style.position).toBe('static');
    expect(copyBtn.style.top).toBe('auto');
    expect(copyBtn.style.right).toBe('auto');
    // jsdom normalises the px unit on zero margins.
    expect(copyBtn.style.marginTop).toBe('0px');
  });

  it('prefers the .buttons container when present', () => {
    const { wrapper, parent, toolbar } = makeWrapper();
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    parent.appendChild(buttons);
    parent.appendChild(
      Object.assign(document.createElement('button'), { className: 'copy-button' }),
    );

    expect(moveNativeCopyButton(wrapper, toolbar)).toBe(buttons);
    expect(toolbar.contains(buttons)).toBe(true);
  });

  it('returns null when no native copy button exists', () => {
    const { wrapper, toolbar } = makeWrapper();
    expect(moveNativeCopyButton(wrapper, toolbar)).toBeNull();
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
