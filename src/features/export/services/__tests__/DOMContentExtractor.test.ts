/**
 * DOMContentExtractor unit tests
 */
import { Marked, marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { describe, expect, it, vi } from 'vitest';

import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import { DOMContentExtractor } from '../DOMContentExtractor';

// Base the test adapter on the real Gemini adapter, overriding only the
// image-extraction methods with a generic, platform-agnostic implementation
// so these tests exercise DOMContentExtractor's own logic (not Gemini's
// production selectors for search/generated images).
DOMContentExtractor.setExportAdapter({
  ...resolveExportAdapter(),
  extractUserImage: (element) =>
    element.querySelectorAll<HTMLImageElement>('user-query-file-preview img, .preview-image'),
  extractAssistantImage: (
    child,
    htmlParts,
    textParts,
    flags,
    tagName,
    _debug,
    processedImageSrcs,
  ) => {
    if (
      child.querySelector(
        '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
      )
    ) {
      return DOMContentExtractor.processYouTubeCovers(child, htmlParts, textParts, flags);
    }
    if (tagName !== 'img') return undefined;

    const image = child as HTMLImageElement;
    const src = image.src || image.getAttribute('src') || '';
    if (src && src !== 'about:blank' && !processedImageSrcs?.has(src)) {
      processedImageSrcs?.add(src);
      const alt = image.getAttribute('alt')?.trim() || 'Image';
      flags.hasImages = true;
      htmlParts.push(
        `<img src="${DOMContentExtractor.escapeHtmlAttribute(src)}" alt="${DOMContentExtractor.escapeHtmlAttribute(alt)}" />`,
      );
      textParts.push(`\n![${alt.replace(/\]/g, '\\]')}](${src})\n`);
    }
    return true;
  },
  extractFormula: () => undefined,
  extractCodeBlock: () => undefined,
  extractUserText: (textLines, textParts, element) => {
    textLines.forEach((line) => {
      const text = DOMContentExtractor.normalizeText(line.textContent ?? '');
      if (text) textParts.push(text);
    });
    if (textParts.length === 0) {
      const contentOnly = element.cloneNode(true) as HTMLElement;
      Array.from(contentOnly.querySelectorAll<HTMLElement>('[role="group"][aria-label]')).forEach(
        (candidate) => candidate.remove(),
      );
      const fallback = DOMContentExtractor.normalizeText(contentOnly.textContent ?? '');
      if (fallback) textParts.push(fallback);
    }
  },
  getUserAttachmentCandidates: (element) => {
    const geminiUploadedFiles = Array.from(
      element.querySelectorAll<HTMLElement>(
        'user-query-file-preview [data-test-id="uploaded-file"]',
      ),
    );
    if (geminiUploadedFiles.length > 0) return geminiUploadedFiles;

    const geminiFilePreviews = Array.from(
      element.querySelectorAll<HTMLElement>('user-query-file-preview .new-file-preview-file'),
    );
    if (geminiFilePreviews.length > 0) return geminiFilePreviews;

    return Array.from(element.querySelectorAll<HTMLElement>('[role="group"][aria-label]')).filter(
      (candidate) => {
        const name = candidate.getAttribute('aria-label')?.trim();
        const buttonName = candidate
          .querySelector<HTMLElement>('[data-default-action] button[aria-label]')
          ?.getAttribute('aria-label')
          ?.trim();
        return !!name && name === buttonName;
      },
    );
  },
});

describe('DOMContentExtractor', () => {
  it('escapes literal pipes in Markdown table cells', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content><div class="markdown">
        <table><thead><tr><th>Choice</th><th>Meaning</th></tr></thead>
        <tbody><tr><td>A | B</td><td>Either</td></tr></tbody></table>
      </div></message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('| A \\| B | Either |');
    expect(extracted.html).toContain('A | B');
  });

  it('preserves ordered-list starting numbers in Markdown', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content><div class="markdown">
        <ol start="22"><li>First retained number</li><li>Next retained number</li></ol>
      </div></message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('22. First retained number');
    expect(extracted.text).toContain('23. Next retained number');
  });

  it('preserves blockquote structure in HTML and Markdown output', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content><div class="markdown">
        <blockquote><p>Quoted line one.</p><p>Quoted line two.</p></blockquote>
      </div></message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('<blockquote>');
    expect(extracted.html).toContain('Quoted line one.');
    expect(extracted.text).toContain('> Quoted line one.');
    expect(extracted.text).toContain('> Quoted line two.');
  });
  it('exports non-image user uploads as filename placeholders', () => {
    const user = document.createElement('div');
    user.innerHTML = `
      <user-query-file-carousel>
        <user-query-file-preview>
          <div data-test-id="uploaded-file">
            <button class="new-file-preview-file" aria-label="Agent notes &amp; review.pdf">
              <span>PDF</span>
              <span>Agent notes &amp; review</span>
            </button>
          </div>
        </user-query-file-preview>
      </user-query-file-carousel>
      <p class="query-text-line">Please review this file</p>
    `;

    const extracted = DOMContentExtractor.extractUserContent(user);

    expect(extracted.attachments).toEqual([{ name: 'Agent notes & review.pdf', type: 'pdf' }]);
    expect(extracted.text).toContain('📎 Agent notes & review.pdf');
    expect(extracted.text).toContain('Please review this file');
    expect(extracted.html).toContain('class="gv-export-attachment"');
    expect(extracted.html).toContain('Agent notes &amp; review.pdf');
    expect(extracted.hasImages).toBe(false);
  });

  it('exports ChatGPT file tiles as filename placeholders without duplicating tile text', () => {
    const user = document.createElement('div');
    user.innerHTML = `
      <div class="flex gap-2 flex-wrap">
        <div role="group" aria-label="spring理解.md">
          <div data-default-action="true">
            <button type="button" aria-label="spring理解.md"></button>
          </div>
          <div class="pointer-events-none">
            <div class="truncate font-semibold">spring理解.md</div>
            <div class="truncate text-token-text-secondary">文件</div>
          </div>
        </div>
      </div>
      <div>请解释这个文件。</div>
    `;

    const extracted = DOMContentExtractor.extractUserContent(user);

    expect(extracted.attachments).toEqual([{ name: 'spring理解.md', type: 'md' }]);
    expect(extracted.text).toContain('📎 spring理解.md');
    expect(extracted.text).toContain('请解释这个文件。');
    expect(extracted.text).not.toContain('spring理解.md\n文件');
    expect(extracted.html).toContain('class="gv-export-attachment"');
  });

  it('does not duplicate image uploads as file placeholders', () => {
    const user = document.createElement('div');
    user.innerHTML = `
      <user-query-file-preview>
        <div data-test-id="uploaded-file">
          <button class="new-file-preview-file" aria-label="photo.png">Image</button>
          <img src="https://example.com/photo.png" alt="Photo" />
        </div>
      </user-query-file-preview>
    `;

    const extracted = DOMContentExtractor.extractUserContent(user);

    expect(extracted.hasImages).toBe(true);
    expect(extracted.attachments).toEqual([]);
    expect(extracted.text).toContain('![Photo](https://example.com/photo.png)');
    expect(extracted.text).not.toContain('📎 photo.png');
  });

  it('escapes user image attributes in exported HTML', () => {
    const user = document.createElement('div');
    user.innerHTML = `<img class="preview-image" src="https://example.com/photo.png" alt="&quot; onload=&quot;alert(1)" />`;

    const extracted = DOMContentExtractor.extractUserContent(user);

    expect(extracted.html).toContain('alt="&quot; onload=&quot;alert(1)"');
    expect(extracted.html).not.toContain('alt="" onload=');
  });

  it('preserves direct text around nested inline elements', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown"><div>Amount: <strong>42</strong> total</div></div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('Amount: **42** total');
    expect(extracted.html).toContain('Amount:');
    expect(extracted.html).toContain('total');
  });

  it.each([
    ['<span>First <strong>bold</strong> </span><span>Second.</span>', 'First **bold** Second.'],
    ['<span>First <strong>bold</strong></span><span> Second.</span>', 'First **bold** Second.'],
  ])('preserves whitespace between adjacent inline containers', (content, expected) => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div>${content}</div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toBe(expected);
  });

  it('does not invent whitespace between adjacent inline containers', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div><span>Hello</span><span>, world.</span></div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toBe('Hello, world.');
  });

  it('preserves a whitespace-only inline container between text containers', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div><span>First</span><span> </span><span>Second</span></div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toBe('First Second');
    expect(extracted.html).toContain('<span> </span>');
  });

  it('exports ordinary prose rendered inside an open shadow root', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `<message-content><div class="markdown"><shadow-answer></shadow-answer></div></message-content>`;
    const host = assistant.querySelector('shadow-answer');
    const shadow = host?.attachShadow({ mode: 'open' });
    if (shadow) shadow.innerHTML = '<p>Shadow response text</p>';

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('Shadow response text');
    expect(extracted.html).toContain('<p>Shadow response text</p>');
  });

  it('deduplicates repeated assistant image sources', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content><div class="markdown">
        <img src="https://example.com/repeated.png" alt="One" />
        <img src="https://example.com/repeated.png" alt="Two" />
      </div></message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text.split('repeated.png')).toHaveLength(2);
    expect(extracted.html.split('repeated.png')).toHaveLength(2);
  });

  it('exports rendered Mermaid SVG in HTML while preserving Mermaid source in text', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="dark">
            <code-block style="display: none;">
              <div class="code-block-decoration">Code snippet</div>
              <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
            </code-block>
            <div class="gv-mermaid-toggle">
              <button class="active">Diagram</button>
              <button>Code</button>
            </div>
            <div class="gv-mermaid-diagram">
              <svg data-render-theme="dark" viewBox="0 0 120 80" aria-label="Flowchart">
                <g><text>A</text><text>B</text></g>
              </svg>
            </div>
            <template class="gv-mermaid-light-export">
              <svg data-export-theme="light" viewBox="0 0 120 80" aria-label="Flowchart">
                <g><text>A</text><text>B</text></g>
              </svg>
            </template>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.html).toContain('data-export-theme="light"');
    expect(extracted.html).not.toContain('data-render-theme="dark"');
    expect(extracted.html).not.toContain('<pre><code');
    expect(extracted.html).not.toContain('gv-mermaid-toggle');
    expect(extracted.html).toContain('data-gv-mermaid-theme="light"');
    expect(extracted.text).toContain('```mermaid\nflowchart TD\nA --> B\n```');
    expect(extracted.text).not.toContain('```code snippet');
  });

  it('falls back to source for an invalid Mermaid theme marker', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="neon">
            <code-block><div class="code-block-decoration">mermaid</div><pre><code role="text">flowchart TD\nA --&gt; B</code></pre></code-block>
            <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Diagram</text></svg></div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('<pre><code class="language-mermaid">');
    expect(extracted.html).not.toContain('class="gv-export-mermaid"');
    expect(extracted.html).not.toContain('data-gv-mermaid-theme');
  });

  it('falls back to source when a dark diagram has no light export SVG', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="dark">
            <code-block><pre><code role="text">flowchart TD\nA --&gt; B</code></pre></code-block>
            <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"></svg></div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('<pre><code class="language-mermaid">');
    expect(extracted.html).not.toContain('class="gv-export-mermaid"');
  });

  it('falls back to Mermaid source when a rendered SVG is unavailable', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-mermaid-wrapper">
            <code-block>
              <div class="code-block-decoration">mermaid</div>
              <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
            </code-block>
            <div class="gv-mermaid-diagram"></div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('<pre><code class="language-mermaid">');
    expect(extracted.html).not.toContain('class="gv-export-mermaid"');
    expect(extracted.text).toContain('```mermaid\nflowchart TD\nA --> B\n```');
  });

  it('reaches a rendered Mermaid wrapper nested in a response element', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <response-element>
            <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
              <code-block style="display: none;">
                <div class="code-block-decoration">mermaid</div>
                <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
              </code-block>
              <div class="gv-mermaid-toggle"><button>Diagram</button></div>
              <div class="gv-mermaid-diagram">
                <svg viewBox="0 0 120 80"><text>Rendered diagram</text></svg>
              </div>
            </div>
          </response-element>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.html).toContain('<svg viewBox="0 0 120 80">');
    expect(extracted.html).not.toContain('<pre><code');
    expect(extracted.text).toContain('```mermaid\nflowchart TD\nA --> B\n```');
  });

  it('exports rendered WaveDrom SVG in HTML while preserving WaveJSON source in text', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-wavedrom-wrapper">
            <code-block style="display: none;">
              <div class="code-block-decoration">wavedrom</div>
              <pre><code role="text">{"signal": [{"name":"clk","wave":"p..."}]}</code></pre>
            </code-block>
            <div class="gv-wavedrom-toggle">
              <button class="active">Diagram</button>
              <button>Code</button>
            </div>
            <div class="gv-wavedrom-diagram">
              <svg viewBox="0 0 800 200" aria-label="Timing diagram">
                <g><text>clk</text></g>
              </svg>
            </div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('class="gv-export-wavedrom"');
    expect(extracted.html).toContain('<svg viewBox="0 0 800 200"');
    expect(extracted.html).not.toContain('<pre><code');
    expect(extracted.html).not.toContain('gv-wavedrom-toggle');
    expect(extracted.text).toContain(
      '```wavedrom\n{"signal": [{"name":"clk","wave":"p..."}]}\n```',
    );
    expect(extracted.text).not.toContain('```code snippet');
  });

  it('falls back to WaveJSON source when a rendered WaveDrom SVG is unavailable', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-wavedrom-wrapper">
            <code-block>
              <div class="code-block-decoration">wavedrom</div>
              <pre><code role="text">{"signal": [{"name":"clk","wave":"p..."}]}</code></pre>
            </code-block>
            <div class="gv-wavedrom-toggle"><button>Diagram</button></div>
            <div class="gv-wavedrom-diagram"></div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('<pre><code class="language-wavedrom">');
    expect(extracted.html).not.toContain('class="gv-export-wavedrom"');
    expect(extracted.text).toContain(
      '```wavedrom\n{"signal": [{"name":"clk","wave":"p..."}]}\n```',
    );
  });

  it('preserves WaveDrom skin styles and fenced source inside list items', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              Timing diagram
              <div class="gv-wavedrom-wrapper">
                <code-block style="display: none;">
                  <div class="code-block-decoration">wavedrom</div>
                  <pre><code role="text">{"signal": [{"name":"clk","wave":"p..."}]}</code></pre>
                </code-block>
                <div class="gv-wavedrom-toggle"><button>Diagram</button></div>
                <div class="gv-wavedrom-diagram">
                  <svg viewBox="0 0 800 200">
                    <style>.s1{fill:#fff;stroke:#000}</style>
                    <g class="s1"><text>clk</text></g>
                  </svg>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('class="gv-export-wavedrom"');
    expect(extracted.html).toContain('<style>.s1{fill:#fff;stroke:#000}</style>');
    expect(extracted.html).not.toContain('gv-wavedrom-toggle');
    expect(extracted.text).toContain(
      '- Timing diagram\n  ```wavedrom\n  {"signal": [{"name":"clk","wave":"p..."}]}\n  ```',
    );
  });

  it('reaches a rendered Mermaid wrapper through an intervening container', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <response-element>
            <section>
              <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                <code-block style="display: none;">
                  <div class="code-block-decoration">mermaid</div>
                  <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
                </code-block>
                <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Rendered diagram</text></svg></div>
              </div>
            </section>
          </response-element>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.html).toContain('<svg viewBox="0 0 120 80">');
    expect(extracted.html).not.toContain('<pre><code');
    expect(extracted.text).toContain('```mermaid\nflowchart TD\nA --> B\n```');
  });

  it('preserves rendered Mermaid diagrams and fenced source inside list items', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <span>Diagram</span>
              <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                <code-block style="display: none;">
                  <div class="code-block-decoration">mermaid</div>
                  <pre><code role="text">flowchart TD\nA --&gt; B</code></pre>
                </code-block>
                <div class="gv-mermaid-toggle"><button>Diagram</button></div>
                <div class="gv-mermaid-diagram">
                  <svg viewBox="0 0 120 80"><text>Rendered diagram</text></svg>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('<ul>');
    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.html).toContain('<svg viewBox="0 0 120 80">');
    expect(extracted.html).not.toContain('gv-mermaid-wrapper');
    expect(extracted.html).not.toContain('<pre><code');
    expect(extracted.text).toContain('- Diagram\n  ```mermaid\n  flowchart TD\n  A --> B\n  ```');
  });

  it('exports a rendered ECharts canvas as an image while preserving option source in text', () => {
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,TESTDATA');
    try {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <div class="gv-echarts-wrapper">
              <code-block style="display: none;">
                <div class="code-block-decoration">echarts</div>
                <pre><code role="text">{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}</code></pre>
              </code-block>
              <div class="gv-echarts-toggle">
                <button class="active">Diagram</button>
                <button>Code</button>
              </div>
              <div class="gv-echarts-diagram">
                <canvas width="800" height="400"></canvas>
              </div>
            </div>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasCode).toBe(true);
      expect(extracted.html).toContain('class="gv-export-echarts"');
      expect(extracted.html).toContain('<img src="data:image/png;base64,TESTDATA"');
      expect(extracted.html).not.toContain('<pre><code');
      expect(extracted.html).not.toContain('gv-echarts-toggle');
      expect(extracted.text).toContain(
        '```echarts\n{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}\n```',
      );
    } finally {
      toDataURLSpy.mockRestore();
    }
  });

  it('falls back to option source when a rendered ECharts canvas is unavailable', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="gv-echarts-wrapper">
            <code-block>
              <div class="code-block-decoration">echarts</div>
              <pre><code role="text">{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}</code></pre>
            </code-block>
            <div class="gv-echarts-toggle"><button>Diagram</button></div>
            <div class="gv-echarts-diagram"></div>
          </div>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('<pre><code class="language-echarts">');
    expect(extracted.html).not.toContain('class="gv-export-echarts"');
    expect(extracted.text).toContain(
      '```echarts\n{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}\n```',
    );
  });

  it('falls back to option source when the ECharts canvas is tainted', () => {
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockImplementation(() => {
        throw new Error('Tainted canvas');
      });
    try {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <div class="gv-echarts-wrapper">
              <code-block style="display: none;">
                <div class="code-block-decoration">echarts</div>
                <pre><code role="text">{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}</code></pre>
              </code-block>
              <div class="gv-echarts-diagram"><canvas width="800" height="400"></canvas></div>
            </div>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.html).toContain('<pre><code class="language-echarts">');
      expect(extracted.html).not.toContain('class="gv-export-echarts"');
      expect(extracted.text).toContain(
        '```echarts\n{"series": [{"type": "pie", "data": [{"value": 1, "name": "a"}]}]}\n```',
      );
    } finally {
      toDataURLSpy.mockRestore();
    }
  });

  it('preserves regular fenced code when list extraction handles block content', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <span>Example</span>
              <code-block>
                <div class="code-block-decoration">typescript</div>
                <pre><code role="text">const answer = 42;</code></pre>
              </code-block>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('<ul>');
    expect(extracted.html).toContain('<pre><code class="language-typescript">');
    expect(extracted.html).not.toContain('<code-block>');
    expect(extracted.text).toContain('- Example\n  ```typescript\n  const answer = 42;\n  ```');
  });

  it('preserves prose, ordinary code, and subsequent prose order inside list items', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <span>Before ordinary code.</span>
              <code-block>
                <div class="code-block-decoration">typescript</div>
                <pre><code role="text">const answer = 42;</code></pre>
              </code-block>
              <span>After ordinary code.</span>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.text).toContain(
      '- Before ordinary code.\n  ```typescript\n  const answer = 42;\n  ```\n  After ordinary code.',
    );
  });

  it('preserves Mermaid blocks and nested lists at their original list-item positions', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <span>Before Mermaid.</span>
              <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                <code-block><div class="code-block-decoration">mermaid</div><pre><code role="text">flowchart TD\nA --&gt; B</code></pre></code-block>
                <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Diagram</text></svg></div>
              </div>
              <ul><li>Nested item</li></ul>
              <span>After Mermaid.</span>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.text).toContain(
      '- Before Mermaid.\n  ```mermaid\n  flowchart TD\n  A --> B\n  ```\n  - Nested item\n  After Mermaid.',
    );
  });

  it('keeps interleaved ordinary and Mermaid blocks in list DOM order', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ol>
            <li>
              <span>First prose.</span>
              <code-block><div class="code-block-decoration">json</div><pre><code role="text">{}</code></pre></code-block>
              <span>Second prose.</span>
              <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                <code-block><div class="code-block-decoration">mermaid</div><pre><code role="text">graph LR\nA --&gt; B</code></pre></code-block>
                <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Diagram</text></svg></div>
              </div>
              <span>Third prose with <span class="math-inline" data-math="x^2">x²</span>.</span>
            </li>
          </ol>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.hasFormulas).toBe(true);
    expect(extracted.text).toContain(
      '1. First prose.\n   ```json\n   {}\n   ```\n   Second prose.\n   ```mermaid\n   graph LR\n   A --> B\n   ```\n   Third prose with $x^2$.',
    );
  });

  it('extracts Mermaid blocks wrapped by response elements inside list items', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <span>Before wrapped Mermaid.</span>
              <response-element>
                <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                  <code-block><div class="code-block-decoration">mermaid</div><pre><code role="text">flowchart LR\nA --&gt; B</code></pre></code-block>
                  <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Diagram</text></svg></div>
                </div>
              </response-element>
              <span>After wrapped Mermaid.</span>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.text).toContain(
      '- Before wrapped Mermaid.\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n  After wrapped Mermaid.',
    );
  });

  it('preserves block order through section and div containers inside list items', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <section>
                <p>Before ordinary code.</p>
                <div>
                  <code-block><div class="code-block-decoration">typescript</div><pre><code role="text">const answer = 42;</code></pre></code-block>
                </div>
                <p>Before Mermaid.</p>
                <div>
                  <div>
                    <div class="gv-mermaid-wrapper" data-gv-mermaid-theme="light">
                      <code-block><div class="code-block-decoration">Code snippet</div><pre><code role="text">flowchart TD\nA --&gt; B</code></pre></code-block>
                      <div class="gv-mermaid-diagram"><svg viewBox="0 0 120 80"><text>Diagram</text></svg></div>
                    </div>
                  </div>
                </div>
                <ol><li>Nested item</li></ol>
                <p>After nested list.</p>
              </section>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasCode).toBe(true);
    expect(extracted.html).toContain('class="gv-export-mermaid"');
    expect(extracted.text).toContain(
      '- Before ordinary code.\n  ```typescript\n  const answer = 42;\n  ```\n  Before Mermaid.\n  ```mermaid\n  flowchart TD\n  A --> B\n  ```\n  1. Nested item\n  After nested list.',
    );
    expect(extracted.text).not.toContain('```code snippet');
  });

  it('should strip Gemini inline source chips (link icons) from assistant export', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <p>Hello</p>
          <sources-carousel-inline>
            <source-inline-chips>
              <source-inline-chip>
                <div class="source-inline-chip-container">
                  <button aria-label="View source details. Opens side panel.">
                    <mat-icon fonticon="link">link</mat-icon>
                  </button>
                </div>
              </source-inline-chip>
            </source-inline-chips>
          </sources-carousel-inline>
          <p>World</p>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('Hello');
    expect(extracted.text).toContain('World');
    expect(extracted.text).not.toMatch(/\blink\b/i);

    expect(extracted.html).toContain('<p>Hello</p>');
    expect(extracted.html).toContain('<p>World</p>');
    expect(extracted.html).not.toContain('sources-carousel-inline');
    expect(extracted.html).not.toContain('source-inline-chip');
    expect(extracted.html).not.toContain('mat-icon');
  });

  it('should strip source chips nested in lists from exported HTML', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              Item 1
              <sources-carousel-inline>
                <mat-icon fonticon="link">link</mat-icon>
              </sources-carousel-inline>
            </li>
            <li>Item 2</li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).toContain('Item 1');
    expect(extracted.text).toContain('Item 2');
    expect(extracted.text).not.toMatch(/\blink\b/i);

    expect(extracted.html).toContain('<ul>');
    expect(extracted.html).toMatch(/<li[^>]*>\s*Item 1/i);
    expect(extracted.html).toMatch(/<li[^>]*>\s*Item 2/i);
    expect(extracted.html).not.toContain('sources-carousel-inline');
    expect(extracted.html).not.toContain('mat-icon');
  });

  describe('Gemini Notebook table exports', () => {
    it('ends the table block before a following paragraph', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <p>前置段落</p>
            <table-block>
              <table>
                <tbody>
                  <tr><th>案例</th></tr>
                  <tr><td>最后一行表格内容</td></tr>
                </tbody>
              </table>
            </table-block>
            <p>通过这三个例题的对比可以看出……</p>
          </div>
        </message-content>
      `;

      const sourceRowCount = assistant.querySelectorAll('table tr').length;
      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text).toContain('| 最后一行表格内容 |\n\n通过这三个例题的对比可以看出……');

      const rendered = document.createElement('div');
      rendered.innerHTML = marked.parse(extracted.text) as string;
      const renderedTable = rendered.querySelector('table');

      expect(renderedTable?.querySelector('tbody')?.textContent).not.toContain(
        '通过这三个例题的对比可以看出……',
      );
      expect(renderedTable?.nextElementSibling?.tagName).toBe('P');
      expect(renderedTable?.querySelectorAll('tr')).toHaveLength(sourceRowCount);
    });

    it('preserves inline LaTeX and removes source chips from tables with a thead', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Statistic</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      Text before <span class="math-inline" data-math="X \\sim B(15, 0.9)">
                        <span class="katex"><span class="katex-html"><span class="vlist">X∼B(15, 0.9)</span></span></span>
                      </span> text after
                      <sources-carousel-inline>
                        <source-inline-chips>
                          <source-inline-chip>
                            <div class="source-inline-chip-container"><span>PDF</span></div>
                          </source-inline-chip>
                        </source-inline-chips>
                      </sources-carousel-inline>
                    </td>
                    <td><span data-math="p = 0.9"><span class="katex">p=0.9</span></span></td>
                    <td><em>Emphasis</em> and <code>inline code</code></td>
                  </tr>
                  <tr>
                    <td>Multiple formulas</td>
                    <td>
                      <span class="math-inline" data-math="\\mu = 90">μ=90</span>
                      and
                      <span class="math-inline" data-math="\\sigma = 3">σ=3</span>
                    </td>
                    <td>
                      Kept text
                      <span>
                        <sources-carousel-inline>
                          <source-inline-chip><span>PDF+1</span></source-inline-chip>
                        </sources-carousel-inline>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasTables).toBe(true);
      expect(extracted.hasFormulas).toBe(true);
      expect(extracted.text).toBe(
        [
          '| Case | Statistic | Notes |',
          '| --- | --- | --- |',
          '| Text before $X \\sim B(15, 0.9)$ text after | $p = 0.9$ | *Emphasis* and `inline code` |',
          '| Multiple formulas | $\\mu = 90$ and $\\sigma = 3$ | Kept text |',
        ].join('\n'),
      );
      expect(extracted.text).not.toContain('PDF');
      expect(extracted.text).not.toContain('PDF+1');
      expect(extracted.html).toContain('data-math="X \\sim B(15, 0.9)"');
      expect(extracted.html).toContain('class="katex"');
      expect(extracted.html).toContain('class="vlist"');
      expect(extracted.html).not.toContain('sources-carousel-inline');
      expect(extracted.html).not.toContain('source-inline-chip');
    });

    it('uses the same inline serialization when a tbody first row is the header', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr>
                    <th>
                      Parameter <span class="math-inline" data-math="\\theta">θ</span>
                      <source-inline-chip><span>PDF</span></source-inline-chip>
                    </th>
                    <th>Value</th>
                  </tr>
                  <tr>
                    <td>
                      Mean <span><span data-math="\\mu">μ</span></span>
                      <span><source-inline-chip><span>PDF+1</span></source-inline-chip></span>
                    </td>
                    <td>
                      <span class="math-inline" data-math="\\bar{x} = 356.5">x̄=356.5</span>
                      and <span class="math-inline" data-math="s = 5">s=5</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasTables).toBe(true);
      expect(extracted.hasFormulas).toBe(true);
      expect(extracted.text).toBe(
        [
          '| Parameter $\\theta$ | Value |',
          '| --- | --- |',
          '| Mean $\\mu$ | $\\bar{x} = 356.5$ and $s = 5$ |',
        ].join('\n'),
      );
      expect(extracted.text).not.toContain('PDF');
      expect(extracted.text).not.toContain('PDF+1');
      expect(extracted.html).toContain('data-math="\\bar{x} = 356.5"');
      expect(extracted.html).not.toContain('source-inline-chip');
    });

    it('preserves whitespace between adjacent formatted nodes', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Assessment</th></tr>
                  <tr><td><strong>high</strong> <em>risk</em></td></tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text).toBe(['| Assessment |', '| --- |', '| **high** *risk* |'].join('\n'));
    });

    it.each([
      ['First<strong> Second</strong>', 'First **Second**'],
      ['<strong>First </strong>Second', '**First** Second'],
      ['First<em> Second</em>', 'First *Second*'],
      ['<code>First </code>Second', '`First` Second'],
    ])(
      'moves nested formatting boundary whitespace outside Markdown markers',
      (content, expected) => {
        const assistant = document.createElement('div');
        assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Content</th></tr>
                  <tr><td>${content}</td></tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

        const extracted = DOMContentExtractor.extractAssistantContent(assistant);

        expect(extracted.text).toBe(['| Content |', '| --- |', `| ${expected} |`].join('\n'));
      },
    );

    it('serializes nested display tags in inline code as plain text', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <div>Run <code><strong>npm</strong><em> install</em></code>.</div>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text).toBe('Run `npm install`.');
      expect(extracted.html).toContain('Run <code>npm install</code>.');
    });

    it('serializes nested display tags in table inline code as plain text', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Code</th></tr>
                  <tr>
                    <td>
                      <code><strong>npm</strong><em> install|test</em><source-inline-chip>PDF</source-inline-chip></code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);
      const rendered = document.createElement('div');
      rendered.innerHTML = marked.parse(extracted.text) as string;

      expect(rendered.querySelectorAll('tbody tr:first-child td')).toHaveLength(1);
      expect(rendered.querySelector('tbody tr:first-child code')?.textContent).toBe(
        'npm install|test',
      );
      expect(extracted.text).not.toContain('PDF');
    });

    it.each([
      ['a`b', '``a`b``'],
      ['`edge`', '`` `edge` ``'],
      ['a``b', '```a``b```'],
    ])('round-trips backticks in inline code spans', (content, expectedMarkdown) => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Code</th></tr>
                  <tr><td><code>${content}</code></td></tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);
      expect(extracted.text).toContain(`| ${expectedMarkdown} |`);

      const rendered = document.createElement('div');
      rendered.innerHTML = marked.parse(extracted.text) as string;

      expect(rendered.querySelector('tbody tr:first-child code')?.textContent).toBe(content);
    });

    it.each([
      [String.raw`\|`, '<code>&#x5c;&#x7c;</code>'],
      [String.raw`\\|`, '<code>&#x5c;&#x5c;&#x7c;</code>'],
      ['*em*|x', '`*em*\\|x`'],
      [
        '[link](https://example.com)|**bold**~~gone~~',
        '`[link](https://example.com)\\|**bold**~~gone~~`',
      ],
    ])(
      'round-trips Markdown syntax and backslashes in table inline code spans',
      (content, expectedMarkdown) => {
        const assistant = document.createElement('div');
        assistant.innerHTML = `
          <message-content>
            <div class="markdown">
              <table-block>
                <table>
                  <tbody>
                    <tr><th>Code</th></tr>
                    <tr><td><code>${content}</code></td></tr>
                  </tbody>
                </table>
              </table-block>
            </div>
          </message-content>
        `;

        const extracted = DOMContentExtractor.extractAssistantContent(assistant);
        expect(extracted.text).toContain(`| ${expectedMarkdown} |`);

        const rendered = document.createElement('div');
        rendered.innerHTML = marked.parse(extracted.text) as string;

        expect(rendered.querySelectorAll('tbody tr:first-child td')).toHaveLength(1);
        expect(rendered.querySelector('tbody tr:first-child code')?.textContent).toBe(content);
      },
    );

    it.each(['a  |  b', 'a\t|\tb', 'a\n|\nb'])(
      'round-trips collapsible whitespace in table inline code',
      (content) => {
        const assistant = document.createElement('div');
        assistant.innerHTML = `
          <message-content>
            <div class="markdown">
              <table-block>
                <table>
                  <tbody>
                    <tr><th>Code</th></tr>
                    <tr><td><code>${content}</code></td></tr>
                  </tbody>
                </table>
              </table-block>
            </div>
          </message-content>
        `;

        const extracted = DOMContentExtractor.extractAssistantContent(assistant);
        const rendered = document.createElement('div');
        rendered.innerHTML = marked.parse(extracted.text) as string;

        expect(extracted.text).toContain('<code>');
        expect(rendered.querySelectorAll('tbody tr:first-child td')).toHaveLength(1);
        expect(rendered.querySelector('tbody tr:first-child code')?.textContent).toBe(content);
      },
    );

    it('escapes table delimiters in formulas, text, and inline code', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Formula</th><th>Text</th><th>Code</th></tr>
                  <tr>
                    <td><span class="math-inline" data-math="P(A|B)">P(A|B)</span></td>
                    <td>left | right</td>
                    <td><code>a|b</code></td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text).toContain('| $P(A\\|B)$ | left \\| right | `a\\|b` |');

      const rendered = document.createElement('div');
      rendered.innerHTML = marked.parse(extracted.text) as string;
      const cells = rendered.querySelectorAll('tbody tr:first-child td');
      expect(cells).toHaveLength(3);
      expect(Array.from(cells, (cell) => cell.textContent)).toEqual([
        '$P(A|B)$',
        'left | right',
        'a|b',
      ]);

      const katexParser = new Marked(
        markedKatex({
          throwOnError: false,
          output: 'html',
          trust: true,
          strict: false,
        }),
      );
      const katexRendered = document.createElement('div');
      katexRendered.innerHTML = katexParser.parse(extracted.text) as string;

      const formulaCell = katexRendered.querySelector('tbody tr:first-child td:first-child');
      expect(formulaCell?.querySelector('.katex')).not.toBeNull();
      expect(formulaCell?.querySelector('.katex-error')).toBeNull();
      expect(formulaCell?.querySelector('.katex-html')?.textContent).toContain('P(A');
    });

    it('preserves LaTeX vertical-bar commands through Markdown table rendering', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Norm</th></tr>
                  <tr>
                    <td><span class="math-inline" data-math="\\|x\\|">‖x‖</span></td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);
      const parser = new Marked(
        markedKatex({
          throwOnError: false,
          output: 'html',
          trust: true,
          strict: false,
        }),
      );
      const rendered = document.createElement('div');
      rendered.innerHTML = parser.parse(extracted.text) as string;

      expect(rendered.querySelector('.katex-html')?.textContent).toBe('∥x∥');
      expect(rendered.querySelector('.katex-html .newline')).toBeNull();
    });

    it('preserves consecutive LaTeX vertical-bar commands in Markdown tables', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Bars</th></tr>
                  <tr>
                    <td><span class="math-inline" data-math="\\|\\|">‖‖</span></td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);
      const parser = new Marked(
        markedKatex({
          throwOnError: false,
          output: 'html',
          trust: true,
          strict: false,
        }),
      );
      const rendered = document.createElement('div');
      rendered.innerHTML = parser.parse(extracted.text) as string;

      expect(extracted.text).toContain('$\\Vert{}\\Vert{}$');
      expect(rendered.querySelector('.katex-html')?.textContent).toBe('∥∥');
    });

    it('recursively serializes formulas and filters sources inside formatting tags', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <table-block>
              <table>
                <tbody>
                  <tr><th>Strong</th><th>Emphasis</th><th>Code</th></tr>
                  <tr>
                    <td>
                      <strong>
                        <span class="math-inline" data-math="\\theta">θ</span>
                        <source-inline-chip><span>PDF</span></source-inline-chip>
                      </strong>
                    </td>
                    <td>
                      <em>
                        value <span data-math="\\alpha">α</span>
                        <source-inline-chip><span>PDF+1</span></source-inline-chip>
                      </em>
                    </td>
                    <td><code>x<source-inline-chip><span>PDF</span></source-inline-chip></code></td>
                  </tr>
                </tbody>
              </table>
            </table-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasFormulas).toBe(true);
      expect(extracted.text).toContain('| **$\\theta$** | *value $\\alpha$* | `x` |');
      expect(extracted.text).not.toContain('PDF');
      expect(extracted.text).not.toContain('PDF+1');
    });
  });

  it('preserves Gemini KaTeX radical image nodes nested in lists', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <ul>
            <li>
              <b>积的开方：</b>
              <span class="math-inline" data-math="\\sqrt{ab} = \\sqrt{a}">
                <span class="katex">
                  <span class="katex-html" aria-hidden="true">
                    <span class="base">
                      <span class="mord sqrt">
                        <span class="vlist-t">
                          <span class="vlist">
                            <span class="hide-tail">
                              <img class="katex-svg" style="display:block;position:absolute;width:100%;height:inherit;" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" />
                            </span>
                          </span>
                        </span>
                      </span>
                    </span>
                  </span>
                </span>
              </span>
            </li>
          </ul>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasFormulas).toBe(true);
    expect(extracted.text).toContain('$\\sqrt{ab} = \\sqrt{a}$');
    expect(extracted.html).toContain('class="katex-svg"');
    expect(extracted.html).toContain('data:image/svg+xml');
    expect(extracted.html).toContain('hide-tail');
  });

  it('should extract assistant images as markdown and html', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <p>Hello</p>
          <img src="https://example.com/a.png" alt="A" />
          <p>World</p>
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.hasImages).toBe(true);
    expect(extracted.text).toContain('Hello');
    expect(extracted.text).toContain('World');
    expect(extracted.text).toContain('![A](https://example.com/a.png)');
    expect(extracted.html).toContain('<img');
    expect(extracted.html).toContain('https://example.com/a.png');
  });

  it('should skip about:blank images while preserving valid images', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <img src="about:blank" alt="placeholder" />
          <img src="https://example.com/real.png" alt="Real" />
        </div>
      </message-content>
    `;

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.text).not.toContain('about:blank');
    expect(extracted.html).not.toContain('about:blank');
    expect(extracted.text).toContain('![Real](https://example.com/real.png)');
    expect(extracted.html).toContain('https://example.com/real.png');
  });

  it('escapes generated image src/alt when rendered into html attributes', () => {
    const assistant = document.createElement('div');
    assistant.innerHTML = `
      <message-content>
        <div class="markdown">
          <div class="attachment-container generated-images">
            <generated-image><img /></generated-image>
          </div>
        </div>
      </message-content>
    `;

    const generated = assistant.querySelector('img') as HTMLImageElement;
    generated.setAttribute('src', 'https://example.com/a"b.png');
    generated.setAttribute('alt', 'A "quoted" image');

    const extracted = DOMContentExtractor.extractAssistantContent(assistant);

    expect(extracted.html).toContain('src="https://example.com/a%22b.png"');
    expect(extracted.html).toContain('alt="A &quot;quoted&quot; image"');
  });

  describe('YouTube video covers', () => {
    // Mirrors Gemini's live DOM: .attachment-container.youtube > … > youtube-block
    // > single-video > … > img.thumbnail, plus the <iframe> player.
    const youtubeCard = `
      <message-content>
        <div class="markdown">
          <p>Here is a relevant clip.</p>
          <div class="attachment-container youtube">
            <response-element>
              <youtube-block>
                <attribution-container>
                  <single-video class="youtube-item">
                    <default-player>
                      <div class="single-video-container">
                        <div class="single-video-thumbnail">
                          <img class="thumbnail" src="https://i.ytimg.com/vi/ttkd0t5qTD4/hqdefault.jpg" alt="Sample Video" />
                        </div>
                        <iframe class="single-video-player" src="https://www.youtube.com/embed/ttkd0t5qTD4"></iframe>
                      </div>
                    </default-player>
                  </single-video>
                </attribution-container>
              </youtube-block>
            </response-element>
          </div>
        </div>
      </message-content>
    `;

    it('emits the cover thumbnail as a clickable image in markdown', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = youtubeCard;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasImages).toBe(true);
      expect(extracted.text).toContain('Here is a relevant clip.');
      expect(extracted.text).toContain(
        '[![Sample Video](https://i.ytimg.com/vi/ttkd0t5qTD4/hqdefault.jpg)](https://www.youtube.com/watch?v=ttkd0t5qTD4)',
      );
    });

    it('emits the cover as a linked <img> in the html output', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = youtubeCard;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.html).toMatch(
        /<a href="https:\/\/www\.youtube\.com\/watch\?v=ttkd0t5qTD4"><img src="https:\/\/i\.ytimg\.com\/vi\/ttkd0t5qTD4\/hqdefault\.jpg" alt="Sample Video" \/><\/a>/,
      );
    });

    it('does not duplicate the cover (processNodes + fallback pass dedupe)', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = youtubeCard;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text.split('hqdefault.jpg').length - 1).toBe(1);
    });

    it('derives the video id from an embed iframe when the thumbnail src lacks one', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <youtube-block>
              <single-video>
                <div class="single-video-thumbnail">
                  <img class="thumbnail" src="https://lh3.googleusercontent.com/opaque-thumb" alt="No-Id Thumb" />
                </div>
                <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
              </single-video>
            </youtube-block>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      // Falls back to a stable hqdefault cover built from the embed id.
      expect(extracted.text).toContain(
        '[![No-Id Thumb](https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg)](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      );
    });
  });

  describe('Canvas export support', () => {
    it('extracts injected canvas-export-section content correctly', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <p>Here is my canvas doc:</p>
            <div class="gv-canvas-export-section">
              <h3>📄 Canvas Document: Doc Title</h3>
              <div class="gv-canvas-content"># Heading 1\nThis is canvas content.</div>
            </div>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.text).toContain('Here is my canvas doc:');
      expect(extracted.text).toContain('### 📄 Canvas Document: Doc Title');
      expect(extracted.text).toContain('# Heading 1\nThis is canvas content.');

      expect(extracted.html).toContain('gv-canvas-export-section');
      expect(extracted.html).toContain('<h3>📄 Canvas Document: Doc Title</h3>');
      expect(extracted.html).toContain(
        '<pre style="white-space: pre-wrap;"># Heading 1\nThis is canvas content.</pre>',
      );
    });
  });

  describe('Generated UI screenshot export', () => {
    it('exports injected generated UI screenshots as images', () => {
      const assistant = document.createElement('div');
      assistant.innerHTML = `
        <message-content>
          <div class="markdown">
            <p>Here is the app:</p>
            <div class="gv-generated-ui-screenshot-section">
              <img src="data:image/png;base64,abc123" alt="Gemini interactive UI screenshot">
            </div>
          </div>
        </message-content>
      `;

      const extracted = DOMContentExtractor.extractAssistantContent(assistant);

      expect(extracted.hasImages).toBe(true);
      expect(extracted.text).toContain(
        '![Gemini interactive UI screenshot](data:image/png;base64,abc123)',
      );
      expect(extracted.html).toContain(
        '<img src="data:image/png;base64,abc123" alt="Gemini interactive UI screenshot" />',
      );
    });
  });
});
