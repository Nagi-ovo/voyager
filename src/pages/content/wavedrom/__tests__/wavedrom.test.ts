import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeModalForTest,
  _openFullscreenForTest,
  _resetWaveDromLoader,
  isWaveJsonCode,
  makeResponsiveSvg,
  remapDarkSkinStyle,
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
      /(\\.s[0-9]+)\{[^}]*fill:\s*#(?:000000|000|0010c0|2d6500|870500|007a80|680066|5f5f5f|2e005e)/,
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
      /(\\.s[0-9]+)\{[^}]*fill:\s*#(?:000000|000|0010c0|2d6500|870500|007a80|680066|5f5f5f|2e005e)/,
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
});
