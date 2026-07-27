import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginManifest } from '@/features/plugins/types';

import {
  DEFAULT_ACCENT,
  PLATFORM_THEME_CLASS,
  accentHue,
  applyBrandTheme,
  effectiveAccentForDisplay,
  readableForeground,
  resolveBrandColor,
} from '../index';

afterEach(() => {
  document.documentElement.className = '';
  document.documentElement.style.removeProperty('--gv-pm-brand');
  document.documentElement.style.removeProperty('--gv-pm-brand-fg');
  document.documentElement.style.removeProperty('--gv-pm-brand-h');
});

const themedPlugin = (brand: string, matches: string[]): PluginManifest => ({
  id: 'x.themed',
  name: 'Themed',
  version: '1.0.0',
  description: 'd',
  author: 'a',
  category: 'theme',
  license: 'MIT',
  engine: '>=1.0.0',
  tier: 'declarative',
  matches,
  contributes: {},
  theme: { brand },
});

describe('resolveBrandColor', () => {
  it('uses the adapter brandColor for Claude and ChatGPT', () => {
    expect(resolveBrandColor('https://claude.ai/chat/1')).toBe('#d97757');
    expect(resolveBrandColor('https://chatgpt.com/c/1')).toBe('#0ea5e9');
    expect(resolveBrandColor('https://chat.openai.com/')).toBe('#0ea5e9');
  });

  it('returns null for Gemini / AI Studio / unknown sites', () => {
    expect(resolveBrandColor('https://gemini.google.com/app')).toBeNull();
    expect(resolveBrandColor('https://aistudio.google.com/')).toBeNull();
    expect(resolveBrandColor('https://example.com/')).toBeNull();
  });

  it('lets a matching plugin theme override the adapter default', () => {
    const plugins = [themedPlugin('#ff0000', ['https://claude.ai/*'])];
    expect(resolveBrandColor('https://claude.ai/x', plugins)).toBe('#ff0000');
  });

  it('ignores a plugin theme whose matches do not cover the url', () => {
    const plugins = [themedPlugin('#ff0000', ['https://chatgpt.com/*'])];
    // Falls back to Claude's adapter brandColor, not the ChatGPT-scoped plugin.
    expect(resolveBrandColor('https://claude.ai/x', plugins)).toBe('#d97757');
  });

  it('lets a per-site override win over the adapter default and plugin theme', () => {
    const plugins = [themedPlugin('#ff0000', ['https://claude.ai/*'])];
    expect(resolveBrandColor('https://claude.ai/x', plugins, { claude: '#123456' })).toBe(
      '#123456',
    );
    // Override is scoped per site id: a gemini override does not leak to claude.
    expect(resolveBrandColor('https://claude.ai/x', [], { gemini: '#123456' })).toBe('#d97757');
  });

  it('applies a per-site override on Gemini (which otherwise has no colour)', () => {
    expect(resolveBrandColor('https://gemini.google.com/app', [], { gemini: '#abcdef' })).toBe(
      '#abcdef',
    );
    // A blank/whitespace override is ignored.
    expect(resolveBrandColor('https://gemini.google.com/app', [], { gemini: '  ' })).toBeNull();
  });
});

describe('effectiveAccentForDisplay', () => {
  it('returns the sage default for Gemini with no override', () => {
    expect(effectiveAccentForDisplay('https://gemini.google.com/app')).toBe(DEFAULT_ACCENT);
  });

  it('returns the adapter colour for Claude and the override when set', () => {
    expect(effectiveAccentForDisplay('https://claude.ai/x')).toBe('#d97757');
    expect(effectiveAccentForDisplay('https://claude.ai/x', [], { claude: '#0f0f0f' })).toBe(
      '#0f0f0f',
    );
  });
});

describe('readableForeground', () => {
  it('uses white ink on dark accents and dark ink on light accents', () => {
    expect(readableForeground('#1f2a24')).toBe('#ffffff'); // very dark → white
    expect(readableForeground('#0ea5e9')).toBe('#ffffff'); // mid sky blue → white
    expect(readableForeground('#A7C080')).not.toBe('#ffffff'); // light sage → dark ink
    expect(readableForeground('#ffffff')).not.toBe('#ffffff'); // white bg → dark ink
  });

  it('expands 3-digit hex and falls back to white for junk', () => {
    expect(readableForeground('#fff')).not.toBe('#ffffff'); // near-white → dark ink
    expect(readableForeground('not-a-color')).toBe('#ffffff');
  });
});

describe('accentHue', () => {
  it('extracts a sensible OKLCH hue, null for grey / junk', () => {
    const sage = accentHue('#5f8f55');
    expect(sage).not.toBeNull();
    expect(sage!).toBeGreaterThan(120); // green sits ~140°
    expect(sage!).toBeLessThan(160);
    expect(accentHue('#888888')).toBeNull(); // grey → no meaningful hue
    expect(accentHue('not-a-color')).toBeNull();
  });
});

describe('applyBrandTheme', () => {
  it('sets the themed class + --gv-pm-brand on the root for a themed site', () => {
    applyBrandTheme('https://claude.ai/x', [], document);
    expect(document.documentElement.classList.contains(PLATFORM_THEME_CLASS)).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand')).toBe('#d97757');
  });

  it('adds nothing on Gemini', () => {
    applyBrandTheme('https://gemini.google.com/app', [], document);
    expect(document.documentElement.className).toBe('');
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand')).toBe('');
  });

  it('clears a previously-applied theme when navigating to an un-themed site', () => {
    applyBrandTheme('https://claude.ai/x', [], document);
    applyBrandTheme('https://gemini.google.com/app', [], document);
    expect(document.documentElement.classList.contains(PLATFORM_THEME_CLASS)).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand-fg')).toBe('');
  });

  it('sets a luminance-matched --gv-pm-brand-fg alongside the brand', () => {
    applyBrandTheme('https://claude.ai/x', [], document); // #d97757 → white ink
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand-fg')).toBe('#ffffff');
  });

  it('applies a per-site override (incl. on Gemini) with a readable foreground', () => {
    applyBrandTheme('https://gemini.google.com/app', [], document, { gemini: '#A7C080' });
    expect(document.documentElement.classList.contains(PLATFORM_THEME_CLASS)).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand')).toBe('#A7C080');
    // Light sage → dark ink, not white.
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand-fg')).not.toBe('#ffffff');
  });

  it('injects --gv-pm-brand-h so the tinted accent palette re-hues to the custom colour', () => {
    applyBrandTheme('https://gemini.google.com/app', [], document, { gemini: '#3a6df0' });
    const hue = parseFloat(document.documentElement.style.getPropertyValue('--gv-pm-brand-h'));
    expect(Number.isFinite(hue)).toBe(true);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThanOrEqual(360);
    // Clearing removes it so the theme-aware default hue stands again.
    applyBrandTheme('https://gemini.google.com/app', [], document);
    expect(document.documentElement.style.getPropertyValue('--gv-pm-brand-h')).toBe('');
  });
});

describe('platform theme CSS', () => {
  it('themes the Prompt Manager copy notice on third-party platforms', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const noticeBlock =
      css.match(/:root\.gv-platform-themed \.gv-pm-notice\.ok\s*{([\s\S]*?)}/)?.[1] ?? '';

    // Effective accent = inline override OR theme-aware default fallback.
    expect(noticeBlock).toContain('var(--gv-pm-brand, var(--gv-pm-brand-default))');
    expect(noticeBlock).toContain('var(--gv-pm-brand-fg, var(--gv-pm-brand-fg-default))');
    expect(noticeBlock).toContain('var(--gv-pm-brand-soft)');
  });

  it('paints the Gemini FAB with the brand, beating the AI Studio neutral trigger', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    // The .theme-host.*-theme trigger override must exist (specificity 0,3,0) and
    // reference the brand, or the body.*-theme neutral rules repaint it white/black.
    const fabBlock =
      css.match(/\.theme-host\.light-theme \.gv-pm-trigger[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(fabBlock).toContain('var(--gv-pm-brand, var(--gv-pm-brand-default))');
    expect(fabBlock).toContain('var(--gv-pm-brand-fg, var(--gv-pm-brand-fg-default))');
  });

  it('never re-declares the JS-overridable --gv-pm-brand on .theme-host (would shadow the inline custom colour)', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    // Each .theme-host theme block must define only the *-default vars; a bare
    // `--gv-pm-brand:` there would shadow the inline <html> override so a custom
    // colour could never reach the Voyager UI inside .theme-host.
    for (const sel of ['.theme-host.light-theme', '.theme-host.dark-theme']) {
      const block =
        css.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\s*{([\\s\\S]*?)}`))?.[1] ?? '';
      expect(block).toContain('--gv-pm-brand-default:');
      expect(/--gv-pm-brand:\s/.test(block)).toBe(false);
      expect(/--gv-pm-brand-fg:\s/.test(block)).toBe(false);
    }
  });

  it('re-hues tinted accents via var(--gv-pm-brand-h), not the low-support oklch(from …) syntax', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    // CSS relative-colour `oklch(from …)` is too new (Chrome 119+/Safari 16.4+);
    // tints must use the broadly-supported oklch(L C var(--gv-pm-brand-h)) form.
    expect(css).not.toContain('oklch(from ');
    expect(css).toContain('var(--gv-pm-brand-h, var(--gv-pm-brand-h-default))');
    // The modern timeline search panel's focus ring re-hues with the accent.
    const focusRing = css.match(/\.timeline-preview-search input:focus\s*{([\s\S]*?)}/)?.[1] ?? '';
    expect(focusRing).toContain('var(--gv-pm-brand-h');
  });

  it('uses the site accent for formula hover instead of hard-coded Gemini blue', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const formulaHover =
      css.match(
        /\.math-inline:hover,\s*\.math-display:hover,\s*\[data-math\]:hover\s*{([\s\S]*?)}/,
      )?.[1] ?? '';

    expect(formulaHover).toContain('var(--gv-pm-brand-soft)');
    expect(formulaHover).toContain('var(--gv-pm-brand, var(--gv-pm-brand-default))');
    expect(formulaHover).not.toContain('rgba(66, 133, 244');
    expect(css).toContain(':root.gv-platform-themed .math-inline .katex:hover');
  });
});
