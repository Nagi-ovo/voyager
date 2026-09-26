import { afterEach, describe, expect, it } from 'vitest';

import raw from '../catalog/sites/deepseek/plugins/reading-typography/plugin.json';
import { validateManifest } from '../manifest/validate';
import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { deepseekAdapter } from '../sites/adapters/deepseek';

const parsed = validateManifest(raw);
if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
const manifest = parsed.data;
const defaults = {
  fontSizeEnabled: false,
  fontSize: 16,
  lineHeightEnabled: false,
  lineHeight: 160,
  paragraphSpace: 0,
};

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('DeepSeek answer typography', () => {
  it('offers separate opt-in switches and only effective numeric ranges in every locale', () => {
    const settings = manifest.contributes.settings!;
    expect(settings.fontSizeEnabled).toMatchObject({ type: 'boolean', default: false });
    expect(settings.fontSize).toMatchObject({ type: 'number', default: 16, min: 12, max: 28 });
    expect(settings.lineHeightEnabled).toMatchObject({ type: 'boolean', default: false });
    expect(settings.lineHeight).toMatchObject({ type: 'number', default: 160, min: 120, max: 220 });
    expect(settings.paragraphSpace).toMatchObject({ type: 'number', default: 0, min: 0, max: 32 });
    expect(settings.fontSize.label).toContain('px');
    expect(settings.lineHeight.label).toContain('%');
    expect(Object.keys(manifest.i18n ?? {}).sort()).toEqual([
      'ar',
      'es',
      'fr',
      'ja',
      'ko',
      'pt',
      'ru',
      'zh',
      'zh_TW',
    ]);
    for (const locale of Object.values(manifest.i18n ?? {})) {
      for (const key of Object.keys(defaults)) {
        expect(locale.settings?.[key]?.label).toBeTruthy();
      }
    }
  });

  it('leaves defaults native, scopes each switch independently, and restores every change', () => {
    document.body.innerHTML =
      '<textarea>input</textarea><div class="ds-message"><div class="ds-collapsible-text"><p id="user">User</p></div></div>' +
      '<div id="answer" class="ds-message" style="color: red;" data-gv-fontsize-enabled="host"><div class="ds-think-content"><p id="think">Think</p></div>' +
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
    const declaration = (id: string, property: string) => {
      const rule = rulesFor(id).find((candidate) => candidate.style.getPropertyValue(property));
      expect(rule, property).toBeDefined();
      if (property !== 'margin-block-end')
        expect(rule!.style.getPropertyPriority(property)).toBe('important');
      return rule!.style.getPropertyValue(property);
    };
    try {
      for (let i = 0; i < 2; i++) {
        engine.mount(manifest, defaults);
        expect(rulesFor('plain')).toHaveLength(0);
        expect(rulesFor('item')).toHaveLength(0);
        expect(document.getElementById('answer')!.getAttribute('data-gv-fontsize-enabled')).toBe(
          'false',
        );

        engine.updateSettings(manifest.id, { ...defaults, fontSizeEnabled: true, fontSize: 12 });
        expect(rulesFor('plain')).toHaveLength(1);
        expect(rulesFor('item')).toHaveLength(1);
        expect(declaration('plain', 'font-size')).toBe('calc(12px)');
        expect(getComputedStyle(document.getElementById('plain')!).fontSize).toBe('calc(12px)');
        engine.updateSettings(manifest.id, { ...defaults, fontSizeEnabled: true, fontSize: 28 });
        expect(declaration('plain', 'font-size')).toBe('calc(28px)');
        expect(getComputedStyle(document.getElementById('plain')!).fontSize).toBe('calc(28px)');

        engine.updateSettings(manifest.id, {
          ...defaults,
          lineHeightEnabled: true,
          lineHeight: 120,
        });
        expect(rulesFor('plain')).toHaveLength(1);
        expect(rulesFor('item')).toHaveLength(1);
        expect(declaration('plain', 'line-height')).toBe('120%');
        expect(getComputedStyle(document.getElementById('plain')!).lineHeight).toBe('120%');
        engine.updateSettings(manifest.id, {
          ...defaults,
          lineHeightEnabled: true,
          lineHeight: 220,
        });
        expect(declaration('plain', 'line-height')).toBe('220%');
        expect(getComputedStyle(document.getElementById('plain')!).lineHeight).toBe('220%');

        engine.updateSettings(manifest.id, { ...defaults, paragraphSpace: 16 });
        expect(rulesFor('plain')).toHaveLength(1);
        expect(rulesFor('item')).toHaveLength(0);
        expect(declaration('plain', 'margin-block-end')).toBe('16px');

        engine.updateSettings(manifest.id, {
          ...defaults,
          fontSizeEnabled: true,
          fontSize: 18,
          lineHeightEnabled: true,
          lineHeight: 160,
          paragraphSpace: 16,
        });
        expect(rulesFor('plain')).toHaveLength(3);
        expect(rulesFor('item')).toHaveLength(2);
        for (const id of ['user', 'think', 'math', 'inline', 'cell'])
          expect(rulesFor(id), id).toHaveLength(0);
        expect(document.getElementById('answer')!.getAttribute('style')).toBe('color: red;');
        engine.updateSettings(manifest.id, defaults);
        expect(rulesFor('plain')).toHaveLength(0);
        engine.unmount(manifest.id);
        // Attribute ordering can change; original content and host properties must not.
        expect(document.getElementById('answer')!.className).toBe('ds-message');
        expect(document.getElementById('answer')!.getAttribute('style')).toBe('color: red;');
        expect(document.getElementById('answer')!.getAttribute('data-gv-fontsize-enabled')).toBe(
          'host',
        );
        expect(document.getElementById('answer')!.hasAttribute('data-gv-lineheight-enabled')).toBe(
          false,
        );
        expect(document.getElementById('answer')!.hasAttribute('data-gv-paragraphspace')).toBe(
          false,
        );
        expect(document.getElementById('gv-plugin-style-' + manifest.id)).toBeNull();
        expect(document.body.innerHTML).toBe(before);
      }
    } finally {
      engine.unmountAll();
    }
  });
});
