import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readFormulaCopyCss(): string {
  const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
  const start = css.indexOf('/* ==================== Formula Copy Feature ==================== */');
  const end = css.indexOf('Folder Import/Export Styles', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe('formula copy interaction styles', () => {
  it('only shows formula click affordances while the service is active', () => {
    const css = readFormulaCopyCss();

    expect(css).toContain(
      ':root.gv-formula-copy-enabled .math-inline:not(.gv-formula-copy-ignored)',
    );
    expect(css).toContain(
      ':root.gv-formula-copy-enabled [data-math]:not(.gv-formula-copy-ignored)',
    );
    expect(css).toContain(':root.gv-formula-copy-enabled ms-katex:not(.gv-formula-copy-ignored)');
    expect(css).toContain(
      ':root.gv-platform-themed.gv-formula-copy-enabled .katex:not(.gv-formula-copy-ignored)',
    );
    expect(css).toContain("html.gv-formula-copy-enabled[data-color-scheme='light']");

    expect(css).not.toMatch(/^\.math-inline/m);
    expect(css).not.toMatch(/^\.math-display/m);
    expect(css).not.toMatch(/^\[data-math\]/m);
    expect(css).not.toMatch(/^ms-katex/m);
    expect(css).not.toMatch(
      /html\[data-color-scheme='light'\]\s+(?:\.math-inline|\.math-display|\[data-math\]|ms-katex)/,
    );
    expect(css).not.toContain(':root.gv-platform-themed .katex');
  });
});
