import { describe, expect, it } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';

import {
  type ExportPlatformAdapter,
  chatgptExtractFormula,
  chatgptExtractInlineFormula,
  chatgptExtractUserText,
  resolveExportAdapter,
} from '../platformAdapters';

describe('Gemini export adapter contract', () => {
  const extractWithProductionAdapter = (html: string) => {
    DOMContentExtractor.setExportAdapter(resolveExportAdapter());
    const assistant = document.createElement('div');
    assistant.className = 'markdown';
    assistant.innerHTML = html;
    return DOMContentExtractor.extractAssistantContent(assistant);
  };

  it('preserves standalone assistant images', () => {
    const extracted = extractWithProductionAdapter(
      '<img src="https://example.com/generated-ui.png" alt="UI capture">',
    );

    expect(extracted).toMatchObject({ hasImages: true });
    expect(extracted.text).toContain('![UI capture](https://example.com/generated-ui.png)');
    expect(extracted.html).toContain(
      '<img src="https://example.com/generated-ui.png" alt="UI capture" />',
    );
  });

  it('preserves prose around a nested code block in DOM order', () => {
    const extracted = extractWithProductionAdapter(`
      <div>
        <p>before</p>
        <code-block><pre><code>const x = 1;</code></pre></code-block>
        <p>after</p>
      </div>
    `);

    expect(extracted.text).toContain('before');
    expect(extracted.text).toContain('```\nconst x = 1;\n```');
    expect(extracted.text).toContain('after');
    expect(extracted.text.indexOf('before')).toBeLessThan(extracted.text.indexOf('```'));
    expect(extracted.text.indexOf('```')).toBeLessThan(extracted.text.indexOf('after'));
    expect(extracted.html).toContain('<p>before</p>');
    expect(extracted.html).toContain('<p>after</p>');
  });
});

describe('ChatGPT export adapter HTML safety', () => {
  it('preserves line breaks in multiline user prompts', () => {
    const message = document.createElement('div');
    message.innerHTML = '<div>First line<br>Second line</div><p>Third paragraph</p>';
    const text: string[] = [];

    chatgptExtractUserText(message.querySelectorAll('.query-text-line'), text, message);

    expect(text).toEqual(['First line\nSecond line\nThird paragraph']);
  });

  it('renders multiline user prompts with explicit HTML line breaks', () => {
    DOMContentExtractor.setExportAdapter({
      extractUserImage: (element: HTMLElement) => element.querySelectorAll('img'),
      extractUserText: chatgptExtractUserText,
      getUserAttachmentCandidates: () => [],
      extractAssistantImage: () => undefined,
      extractFormula: () => undefined,
      extractCodeBlock: () => undefined,
      extractInlineFormula: () => undefined,
    } as unknown as ExportPlatformAdapter);
    const message = document.createElement('div');
    message.innerHTML = '<div>First line<br>Second line</div><p>Third paragraph</p>';

    const extracted = DOMContentExtractor.extractUserContent(message);

    expect(extracted.text).toBe('First line\nSecond line\nThird paragraph');
    expect(extracted.html).toBe('<p>First line<br />Second line<br />Third paragraph</p>');
  });

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
