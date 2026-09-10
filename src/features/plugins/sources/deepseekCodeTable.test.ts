import { afterEach, describe, expect, it } from 'vitest';

import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { deepseekAdapter } from '../sites/adapters/deepseek';
import { BundledCatalogPluginSource } from './BundledCatalogPluginSource';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('DeepSeek code and table readability', () => {
  it('scopes styles to answers and restores host state across settings and remounts', async () => {
    const manifest = (await new BundledCatalogPluginSource().list()).find(
      (entry) => entry.id === 'voyager.deepseek-code-table',
    );
    if (!manifest) throw new Error('Missing code/table plugin');
    document.body.innerHTML =
      '<textarea>composer</textarea>' +
      '<div class="ds-message"><div class="ds-collapsible-text"><pre>user code</pre></div></div>' +
      '<div id="answer" class="ds-message" data-gv-code-wrap="host">' +
      '<div class="ds-think-content"><pre>thinking code</pre></div>' +
      '<div class="ds-assistant-message-main-content"><button>Copy</button>' +
      '<pre><code>const value = 123;</code></pre><div><table><tbody><tr><th>Name</th>' +
      '<td>Value</td></tr></tbody></table></div></div></div>';
    const answer = document.getElementById('answer')!;
    const contents = answer.innerHTML;
    const table = answer.querySelector('table')!;
    const button = answer.querySelector('button')!;
    const engine = new DeclarativeEngine({ doc: document, adapter: deepseekAdapter });
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        engine.mount(manifest, { wrapCode: false });
        expect(answer.classList.contains('gv-plugin-deepseek-code-table')).toBe(true);
        expect(answer.getAttribute('data-gv-code-wrap')).toBe('false');
        expect(document.querySelectorAll('.gv-plugin-deepseek-code-table')).toHaveLength(1);
        const pre = answer.querySelector('.ds-assistant-message-main-content pre')!;
        expect(getComputedStyle(pre).whiteSpace).toBe('pre');
        expect(getComputedStyle(pre).overflowX).toBe('auto');
        expect(getComputedStyle(table.parentElement!).overflowX).toBe('auto');
        expect(getComputedStyle(table).display).toBe('table');
        expect(getComputedStyle(answer.querySelector('.ds-think-content pre')!).overflowX).not.toBe(
          'auto',
        );
        engine.updateSettings(manifest.id, { wrapCode: true });
        expect(getComputedStyle(pre).whiteSpace).toBe('pre-wrap');
        expect(getComputedStyle(pre.querySelector('code')!).overflowWrap).toBe('anywhere');
        expect(answer.innerHTML).toBe(contents);
        expect(answer.querySelector('button')).toBe(button);
        expect(answer.querySelector('table')).toBe(table);
        engine.unmount(manifest.id);
        expect(answer.className).toBe('ds-message');
        expect(answer.getAttribute('data-gv-code-wrap')).toBe('host');
        expect(getComputedStyle(pre).overflowX).not.toBe('auto');
        expect(document.getElementById('gv-plugin-style-' + manifest.id)).toBeNull();
      }
    } finally {
      engine.unmountAll();
    }
  });

  it('applies to newly mounted answer nodes and releases them when disabled', async () => {
    const manifest = (await new BundledCatalogPluginSource().list()).find(
      (entry) => entry.id === 'voyager.deepseek-code-table',
    )!;
    const engine = new DeclarativeEngine({ doc: document, adapter: deepseekAdapter });
    try {
      engine.mount(manifest, { wrapCode: true });
      const answer = document.createElement('div');
      answer.className = 'ds-message';
      answer.innerHTML =
        '<div class="ds-assistant-message-main-content"><pre><code>x</code></pre></div>';
      document.body.append(answer);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(answer.classList.contains('gv-plugin-deepseek-code-table')).toBe(true);
      expect(answer.getAttribute('data-gv-code-wrap')).toBe('true');
      engine.unmount(manifest.id);
      expect(answer.className).toBe('ds-message');
      expect(answer.hasAttribute('data-gv-code-wrap')).toBe(false);
    } finally {
      engine.unmountAll();
    }
  });
});
