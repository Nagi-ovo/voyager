import { afterEach, describe, expect, it } from 'vitest';

import raw from '../catalog/sites/deepseek/plugins/reading-typography/plugin.json';
import css from '../catalog/sites/deepseek/plugins/reading-typography/style.css?raw';
import { validateManifest } from '../manifest/validate';
import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { deepseekAdapter } from '../sites/adapters/deepseek';

const parsed = validateManifest({ ...raw, contributes: { ...raw.contributes, styles: [{ css }] } });
if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
const manifest = parsed.data;

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('DeepSeek answer typography', () => {
  it('leaves defaults native, excludes rich content, and restores every change', () => {
    document.body.innerHTML =
      '<textarea>input</textarea><div class="ds-message"><div class="ds-collapsible-text"><p id="user">User</p></div></div>' +
      '<div id="answer" class="ds-message" style="color: red;"><div class="ds-think-content"><p id="think">Think</p></div>' +
      '<div class="ds-assistant-message-main-content"><p id="plain">Answer</p>' +
      '<ul><li id="item">Item</li></ul><p id="math">Equation <span class="katex">x</span></p>' +
      '<p id="inline">Inline <code>x</code></p><pre><code>code</code></pre>' +
      '<table><tbody><tr><td><p id="cell">Cell</p></td></tr></tbody></table></div></div>';
    const before = document.body.innerHTML;
    const engine = new DeclarativeEngine({ doc: document, adapter: deepseekAdapter });
    const rulesFor = (id: string) =>
      Array.from(
        (document.getElementById('gv-plugin-style-' + manifest.id) as HTMLStyleElement).sheet!
          .cssRules,
      )
        .filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
        .filter((rule) => document.getElementById(id)!.matches(rule.selectorText));
    try {
      for (let i = 0; i < 2; i++) {
        engine.mount(manifest, { fontSize: 0, lineHeight: 0, paragraphSpace: 0 });
        expect(rulesFor('plain')).toHaveLength(0);
        engine.updateSettings(manifest.id, { fontSize: 18, lineHeight: 160, paragraphSpace: 16 });
        expect(rulesFor('plain')).toHaveLength(3);
        expect(rulesFor('item')).toHaveLength(2);
        for (const id of ['user', 'think', 'math', 'inline', 'cell'])
          expect(rulesFor(id), id).toHaveLength(0);
        const answer = document.getElementById('answer')!;
        expect(answer.style.getPropertyValue('--gv-type-size')).toBe('18px');
        engine.updateSettings(manifest.id, { fontSize: 0, lineHeight: 0, paragraphSpace: 0 });
        expect(rulesFor('plain')).toHaveLength(0);
        engine.unmount(manifest.id);
        // Attribute ordering can change; original content and host properties must not.
        expect(document.getElementById('answer')!.className).toBe('ds-message');
        expect(document.getElementById('answer')!.getAttribute('style')).toBe('color: red;');
        expect(document.getElementById('answer')!.hasAttribute('data-gv-fontsize')).toBe(false);
        expect(document.getElementById('gv-plugin-style-' + manifest.id)).toBeNull();
        expect(document.body.innerHTML).toBe(before);
      }
    } finally {
      engine.unmountAll();
    }
  });
});
