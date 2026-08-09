import { describe, expect, it } from 'vitest';

import { chatgptExtractFormula, chatgptExtractInlineFormula } from '../platformAdapters';

describe('ChatGPT export adapter HTML safety', () => {
  it('escapes block formula source in attribute context', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-math-source', 'x" onpointerover="alert(1)');
    wrapper.innerHTML = '<span class="katex-display">rendered</span>';
    const formula = wrapper.firstElementChild!;
    const html: string[] = [];

    chatgptExtractFormula(
      formula,
      { hasImages: false, hasFormulas: false, hasTables: false, hasCode: false },
      html,
      [],
    );

    expect(html.join('')).toContain('data-math="x&quot; onpointerover=&quot;alert(1)"');
    expect(html.join('')).not.toContain('data-math="x" onpointerover=');
  });

  it('escapes inline formula source in attribute context', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-math-source', 'x" onload="alert(1)');
    wrapper.innerHTML = '<span class="katex">rendered</span>';
    const formula = wrapper.firstElementChild!;
    const html: string[] = [];

    chatgptExtractInlineFormula(formula, html, []);

    expect(html.join('')).toContain('data-math="x&quot; onload=&quot;alert(1)"');
    expect(html.join('')).not.toContain('data-math="x" onload=');
  });

  it('keeps display KaTeX as block math during inline paragraph traversal', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-math-source', '\\frac{1}{2}');
    wrapper.innerHTML = '<span class="katex-display"><span class="katex">rendered</span></span>';
    const html: string[] = [];
    const text: string[] = [];

    chatgptExtractInlineFormula(wrapper.firstElementChild!, html, text);

    expect(html.join('')).toContain('class="math-block"');
    expect(text.join('')).toBe('\n$$\n\\frac{1}{2}\n$$\n');
  });
});
