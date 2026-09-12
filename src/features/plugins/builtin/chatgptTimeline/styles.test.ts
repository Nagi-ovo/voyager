import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHATGPT_TIMELINE_CSS, CHATGPT_TIMELINE_ROOT_CLASS } from './styles';

function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const rgb = [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

describe('ChatGPT timeline theme isolation', () => {
  let style: HTMLStyleElement;
  let panel: HTMLElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = CHATGPT_TIMELINE_CSS;
    document.head.appendChild(style);
    document.documentElement.className = CHATGPT_TIMELINE_ROOT_CLASS;
    panel = document.createElement('div');
    panel.className = 'timeline-preview-panel';
    document.body.appendChild(panel);
  });

  afterEach(() => {
    style.remove();
    panel.remove();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-scheme');
    document.body.className = '';
  });

  it('provides explicit light colors and an opaque readable preview surface', () => {
    const theme = getComputedStyle(document.documentElement);
    expect(theme.getPropertyValue('--timeline-dot-color').trim()).toBe('#64748b');
    expect(theme.getPropertyValue('--timeline-tooltip-text').trim()).toBe('#0f172a');
    expect(getComputedStyle(panel).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(panel).color).toBe('rgb(15, 23, 42)');
  });

  it.each(['dark', 'dark-theme', 'data-theme', 'data-color-scheme', 'body.dark-theme'])(
    'keeps markers and the preview readable with the %s dark signal',
    (signal) => {
      const host = signal === 'body.dark-theme' ? document.body : document.documentElement;
      if (signal.startsWith('data-')) host.setAttribute(signal, 'dark');
      else host.classList.add(signal === 'body.dark-theme' ? 'dark-theme' : signal);

      const theme = getComputedStyle(host);
      expect(theme.getPropertyValue('--timeline-dot-color').trim()).toBe('#e2e8f0');
      expect(theme.getPropertyValue('--timeline-tooltip-text').trim()).toBe('#f1f5f9');
      expect(getComputedStyle(panel).backgroundColor).toBe('rgb(17, 24, 39)');
      expect(getComputedStyle(panel).color).toBe('rgb(241, 245, 249)');
    },
  );

  it('returns to explicit light colors when ChatGPT removes its dark signal', () => {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('dark');
    expect(getComputedStyle(panel).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--timeline-dot-color'),
    ).toBe('#64748b');
  });

  it('does not alter shared Timeline UI when the ChatGPT plugin is disabled', () => {
    document.documentElement.classList.remove(CHATGPT_TIMELINE_ROOT_CLASS);
    document.documentElement.classList.add('dark');
    expect(getComputedStyle(panel).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--timeline-dot-color'),
    ).toBe('');
  });

  it.each([
    ['light', '#ffffff'],
    ['dark', '#212121'],
    ['dark', '#000000'],
  ])('keeps %s rail boundaries and markers distinguishable on %s', (theme, page) => {
    document.documentElement.classList.add(theme);
    const css = getComputedStyle(document.documentElement);
    const color = (name: string): string => css.getPropertyValue(name).trim();
    expect(contrast(color('--timeline-dot-color'), page)).toBeGreaterThanOrEqual(3);
    expect(contrast(color('--gv-chatgpt-timeline-edge'), page)).toBeGreaterThanOrEqual(3);
    expect(
      contrast(color('--timeline-dot-color'), color('--gv-chatgpt-timeline-halo')),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(color('--timeline-tooltip-text'), color('--timeline-tooltip-bg')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('uses sRGB fallbacks without depending on advanced color or backdrop support', () => {
    // CSSOM guards declarations; jsdom does not paint pseudo-elements or GPU effects.
    const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[];
    const rule = (ending: string): CSSStyleDeclaration => {
      const found = rules.find((candidate) => candidate.selectorText?.endsWith(ending));
      expect(found).toBeDefined();
      return found!.style;
    };
    const rail = rule("[data-gv-chatgpt-timeline='true']::before");
    expect(rail.getPropertyValue('background-color')).toBe('var(--timeline-bar-bg, #cbd5e1)');
    // jsdom drops backdrop-filter from CSSOM; check the source for both engines' spellings.
    expect(CHATGPT_TIMELINE_CSS.match(/(?<!-)backdrop-filter: none/g)).toHaveLength(2);
    expect(CHATGPT_TIMELINE_CSS.match(/-webkit-backdrop-filter: none/g)).toHaveLength(2);
    expect(rail.getPropertyValue('box-shadow')).toContain('--gv-chatgpt-timeline-edge, #64748b');
    expect(rule('.timeline-dot:not(.active):not(.starred)::after').backgroundColor).toBe(
      'var(--timeline-dot-color, #64748b)',
    );
    expect(rule('.timeline-dot:not(.active):not(.starred):hover::after').backgroundColor).toBe(
      'var(--timeline-dot-active-color, #5f8f55)',
    );
    expect(rule('.timeline-dot.active::after').backgroundColor).toBe(
      'var(--timeline-dot-active-color, #5f8f55)',
    );
    expect(rule('.timeline-dot.starred::after').backgroundColor).toBe(
      'var(--timeline-star-color, #f59e0b)',
    );
    expect(rule('.timeline-dot::after').opacity).toBe('1');
    const declarations = rules.map((entry) => entry.style.cssText).join('\n');
    expect(declarations).not.toMatch(/color-mix\(|oklch\(|\bCanvas\b|blur\(/);
    // The per-site custom accent still wins; the fallback is not a replacement theme system.
    expect(declarations).toContain('var(--gv-pm-brand, #5f8f55)');
    expect(declarations).toContain('var(--gv-pm-brand, #a7c080)');
  });
});
