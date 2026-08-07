import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLUGIN_BASE_STYLE_ID, PLUGIN_HIDDEN_CLASS } from '../constants';
import { type PluginManifest, type SiteAdapter, cssRef, semanticRef } from '../types';
import { DeclarativeEngine } from './declarativeEngine';
import { registerNativeHandler } from './nativeHandlers';
import { PluginScope } from './pluginScope';

function makeManifest(
  contributes: PluginManifest['contributes'],
  id = 'test.plugin',
): PluginManifest {
  return {
    id,
    name: 'Test',
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.0.0',
    tier: 'declarative',
    matches: ['*://*/*'],
    contributes,
  };
}

const adapter: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  matches: ['https://claude.ai/*'],
  selectors: { userTurn: '.user-msg' },
  theme: { hostSelector: ':root', lightSelector: ':root', darkSelector: ':root.dark' },
  capabilities: new Set(['chat']),
};

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('DeclarativeEngine', () => {
  it('injects styles on mount and removes them on unmount', () => {
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(makeManifest({ styles: [{ css: '.x{color:red}' }] }));

    const styleEl = document.getElementById('gv-plugin-style-test.plugin');
    expect(styleEl?.textContent).toContain('.x{color:red}');

    engine.unmount('test.plugin');
    expect(document.getElementById('gv-plugin-style-test.plugin')).toBeNull();
  });

  it('runs a registered native handler and pushes live settings without remounting', () => {
    const start = vi.fn();
    const updateSettings = vi.fn();
    const stop = vi.fn();
    registerNativeHandler('test.native', { start, updateSettings, stop });
    const engine = new DeclarativeEngine({ doc: document });
    const manifest = makeManifest(
      {
        settings: {
          compactView: { type: 'boolean', label: 'Compact', default: false },
        },
      },
      'test.native',
    );

    engine.mount(manifest, { compactView: false });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ compactView: false });

    // Re-mounting an already-active plugin is a no-op → start not called again.
    engine.mount(manifest, { compactView: false });
    expect(start).toHaveBeenCalledTimes(1);

    engine.updateSettings('test.native', { compactView: true });
    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ compactView: true });

    engine.unmount('test.native');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('runs a scope-based (activate) handler and disposes its scope on unmount', async () => {
    const disposer = vi.fn();
    const activate = vi.fn((scope: PluginScope) => {
      scope.effect(() => disposer, 'test-effect');
    });
    registerNativeHandler('test.scoped', { activate });
    const engine = new DeclarativeEngine({ doc: document });
    const manifest = makeManifest({}, 'test.scoped');

    engine.mount(manifest, { key: 'v' });
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(expect.any(PluginScope), { key: 'v' });

    engine.unmount('test.scoped');
    await vi.waitFor(() => expect(disposer).toHaveBeenCalledOnce());
  });

  it('an activation resolving after unmount still pays its cleanup', async () => {
    let resolveStart!: (d: () => void) => void;
    const cleanup = vi.fn();
    registerNativeHandler('test.scoped-late', {
      activate: (scope) => {
        scope.effect(() => new Promise<() => void>((r) => (resolveStart = r)), 'late-start');
      },
    });
    const engine = new DeclarativeEngine({ doc: document });

    engine.mount(makeManifest({}, 'test.scoped-late'));
    engine.unmount('test.scoped-late');
    resolveStart(cleanup);

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it('a settings change restarts a scope handler that has no updateSettings', async () => {
    const disposer = vi.fn();
    const activate = vi.fn((scope: PluginScope) => {
      scope.effect(() => disposer, 'restartable');
    });
    registerNativeHandler('test.scoped-restart', { activate });
    const engine = new DeclarativeEngine({ doc: document });
    const manifest = makeManifest(
      { settings: { flag: { type: 'boolean', label: 'Flag', default: false } } },
      'test.scoped-restart',
    );

    engine.mount(manifest, { flag: false });
    engine.updateSettings('test.scoped-restart', { flag: true });

    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(disposer).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenLastCalledWith(expect.any(PluginScope), { flag: true });
  });

  it('a scope handler WITH updateSettings gets the update, not a restart', () => {
    const updateSettings = vi.fn();
    const activate = vi.fn();
    registerNativeHandler('test.scoped-update', { activate, updateSettings });
    const engine = new DeclarativeEngine({ doc: document });

    engine.mount(makeManifest({}, 'test.scoped-update'), { a: 1 });
    engine.updateSettings('test.scoped-update', { a: 2 });

    expect(activate).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ a: 2 });
  });

  it('an unmount landing inside the restart window suppresses re-activation', async () => {
    let releaseDisposal!: () => void;
    const gate = new Promise<void>((r) => (releaseDisposal = r));
    const activate = vi.fn((scope: PluginScope) => {
      scope.effect(() => () => gate, 'slow-teardown');
    });
    registerNativeHandler('test.scoped-race', { activate });
    const engine = new DeclarativeEngine({ doc: document });

    engine.mount(makeManifest({}, 'test.scoped-race'));
    engine.updateSettings('test.scoped-race', { changed: true });
    engine.unmount('test.scoped-race');
    releaseDisposal();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(activate).toHaveBeenCalledOnce();
  });

  it('getScopeLedgers reports live effect labels per scope-based plugin', () => {
    registerNativeHandler('test.scoped-ledger', {
      activate: (scope: PluginScope) => {
        scope.effect(() => () => {}, 'my-effect');
      },
    });
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(makeManifest({}, 'test.scoped-ledger'));

    expect(engine.getScopeLedgers()).toEqual({ 'test.scoped-ledger': ['my-effect'] });

    engine.unmount('test.scoped-ledger');
    expect(engine.getScopeLedgers()).toEqual({});
  });

  it('a throwing activation rolls back what it already registered', async () => {
    const registered = vi.fn();
    registerNativeHandler('test.scoped-throw', {
      activate: (scope) => {
        scope.effect(() => registered, 'partial');
        throw new Error('activation boom');
      },
    });
    const engine = new DeclarativeEngine({ doc: document });

    engine.mount(makeManifest({}, 'test.scoped-throw'));
    await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
  });

  it('addClass is reversible', () => {
    document.body.innerHTML = '<div class="target"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        domOps: [{ op: 'addClass', target: cssRef('.target'), className: 'gv-plugin-on' }],
      }),
    );

    expect(document.querySelector('.target')?.classList.contains('gv-plugin-on')).toBe(true);
    engine.unmount('test.plugin');
    expect(document.querySelector('.target')?.classList.contains('gv-plugin-on')).toBe(false);
  });

  it('hide adds the base hidden class + stylesheet, and reverts on unmount', () => {
    document.body.innerHTML = '<div class="ad"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(makeManifest({ domOps: [{ op: 'hide', target: cssRef('.ad') }] }));

    expect(document.getElementById(PLUGIN_BASE_STYLE_ID)).not.toBeNull();
    expect(document.querySelector('.ad')?.classList.contains(PLUGIN_HIDDEN_CLASS)).toBe(true);

    engine.unmount('test.plugin');
    expect(document.querySelector('.ad')?.classList.contains(PLUGIN_HIDDEN_CLASS)).toBe(false);
  });

  it('setAttribute restores the original (removing when previously absent)', () => {
    document.body.innerHTML = '<a class="lnk" href="#a">x</a><a class="lnk2">y</a>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        domOps: [
          { op: 'setAttribute', target: cssRef('.lnk'), name: 'href', value: '#changed' },
          { op: 'setAttribute', target: cssRef('.lnk2'), name: 'target', value: '_blank' },
        ],
      }),
    );

    expect(document.querySelector('.lnk')?.getAttribute('href')).toBe('#changed');
    expect(document.querySelector('.lnk2')?.getAttribute('target')).toBe('_blank');

    engine.unmount('test.plugin');
    expect(document.querySelector('.lnk')?.getAttribute('href')).toBe('#a');
    expect(document.querySelector('.lnk2')?.hasAttribute('target')).toBe(false);
  });

  it('setStyle restores the original inline value', () => {
    document.body.innerHTML = '<div class="box" style="color: blue;"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        domOps: [
          { op: 'setStyle', target: cssRef('.box'), styles: { color: 'red', 'max-width': '60ch' } },
        ],
      }),
    );

    const box = document.querySelector<HTMLElement>('.box');
    expect(box?.style.color).toBe('red');
    expect(box?.style.getPropertyValue('max-width')).toBe('60ch');

    engine.unmount('test.plugin');
    expect(box?.style.color).toBe('blue');
    expect(box?.style.getPropertyValue('max-width')).toBe('');
  });

  it('resolves semantic selectors via the adapter and ignores unknown keys', () => {
    document.body.innerHTML = '<div class="user-msg"></div>';
    const engine = new DeclarativeEngine({ doc: document, adapter });
    engine.mount(
      makeManifest({
        domOps: [
          { op: 'addClass', target: semanticRef('userTurn'), className: 'gv-plugin-u' },
          { op: 'addClass', target: semanticRef('doesNotExist'), className: 'gv-plugin-z' },
        ],
      }),
    );

    expect(document.querySelector('.user-msg')?.classList.contains('gv-plugin-u')).toBe(true);
    // unknown key is a no-op, not a throw
    expect(document.querySelector('.gv-plugin-z')).toBeNull();
  });

  it('reapplyNow applies ops to elements added after mount (SPA re-render)', () => {
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        domOps: [{ op: 'addClass', target: cssRef('.late'), className: 'gv-plugin-late' }],
      }),
    );

    const late = document.createElement('div');
    late.className = 'late';
    document.body.appendChild(late);
    expect(late.classList.contains('gv-plugin-late')).toBe(false);

    engine.reapplyNow();
    expect(late.classList.contains('gv-plugin-late')).toBe(true);
  });

  it('substitutes {{setting}} tokens in CSS and updates them live', () => {
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        settings: { width: { type: 'number', label: 'Width', default: 70, min: 40, max: 120 } },
        styles: [{ css: '.x{max-width:{{width}}ch}' }],
      }),
      { width: 80 },
    );
    const styleEl = document.getElementById('gv-plugin-style-test.plugin');
    expect(styleEl?.textContent).toContain('max-width:80ch');

    engine.updateSettings('test.plugin', { width: 95 });
    expect(styleEl?.textContent).toContain('max-width:95ch');
  });

  it('substitutes {{setting}} tokens in domOps and updates them live', () => {
    document.body.innerHTML = '<div class="box"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        settings: { width: { type: 'number', label: 'Width', default: 70 } },
        domOps: [
          {
            op: 'setStyle',
            target: cssRef('.box'),
            styles: { '--gv-plugin-reading-width': '{{width}}px' },
          },
        ],
      }),
      { width: 80 },
    );

    const box = document.querySelector<HTMLElement>('.box');
    expect(box?.style.getPropertyValue('--gv-plugin-reading-width')).toBe('80px');

    engine.updateSettings('test.plugin', { width: 95 });
    expect(box?.style.getPropertyValue('--gv-plugin-reading-width')).toBe('95px');
  });

  it('falls back to the schema default when a setting value is absent', () => {
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        settings: { width: { type: 'number', label: 'Width', default: 70 } },
        styles: [{ css: '.y{max-width:{{width}}ch}' }],
      }),
    );
    expect(document.getElementById('gv-plugin-style-test.plugin')?.textContent).toContain(
      'max-width:70ch',
    );
  });

  // Multi-plugin composition: two plugins touching the SAME class/attribute/style
  // must not clobber each other on unmount (ref-counted / layered ledgers).
  it('ref-counts a shared class: unmounting one plugin keeps it until the last', () => {
    document.body.innerHTML = '<div class="target"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    const op = { op: 'addClass' as const, target: cssRef('.target'), className: 'gv-shared' };
    engine.mount(makeManifest({ domOps: [op] }, 'plugin.a'));
    engine.mount(makeManifest({ domOps: [op] }, 'plugin.b'));

    const target = document.querySelector('.target');
    expect(target?.classList.contains('gv-shared')).toBe(true);

    engine.unmount('plugin.a');
    // B still wants it → class stays.
    expect(target?.classList.contains('gv-shared')).toBe(true);

    engine.unmount('plugin.b');
    expect(target?.classList.contains('gv-shared')).toBe(false);
  });

  it('layers a shared attribute: unmounting the top restores the other plugin, then the original', () => {
    document.body.innerHTML = '<a class="lnk" href="#orig">x</a>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest(
        { domOps: [{ op: 'setAttribute', target: cssRef('.lnk'), name: 'href', value: '#a' }] },
        'plugin.a',
      ),
    );
    engine.mount(
      makeManifest(
        { domOps: [{ op: 'setAttribute', target: cssRef('.lnk'), name: 'href', value: '#b' }] },
        'plugin.b',
      ),
    );

    const lnk = document.querySelector('.lnk');
    // Last writer wins.
    expect(lnk?.getAttribute('href')).toBe('#b');

    engine.unmount('plugin.b');
    // Falls back to the still-active plugin A — NOT the captured original.
    expect(lnk?.getAttribute('href')).toBe('#a');

    engine.unmount('plugin.a');
    // Last release restores the true pre-plugin original.
    expect(lnk?.getAttribute('href')).toBe('#orig');
  });

  it('layers a shared inline style across plugins', () => {
    document.body.innerHTML = '<div class="box" style="color: blue;"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest(
        { domOps: [{ op: 'setStyle', target: cssRef('.box'), styles: { color: 'red' } }] },
        'plugin.a',
      ),
    );
    engine.mount(
      makeManifest(
        { domOps: [{ op: 'setStyle', target: cssRef('.box'), styles: { color: 'green' } }] },
        'plugin.b',
      ),
    );

    const box = document.querySelector<HTMLElement>('.box');
    expect(box?.style.color).toBe('green');

    engine.unmount('plugin.b');
    expect(box?.style.color).toBe('red');

    engine.unmount('plugin.a');
    expect(box?.style.color).toBe('blue');
  });

  it('installs a MutationObserver only while an active plugin has domOps', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const engine = new DeclarativeEngine({ doc: document });

    engine.mount(makeManifest({ styles: [{ css: '.x{color:red}' }] }, 'css.only'));
    expect(observe).not.toHaveBeenCalled();

    engine.mount(
      makeManifest(
        { domOps: [{ op: 'addClass', target: cssRef('.t'), className: 'y' }] },
        'with.ops',
      ),
    );
    expect(observe).toHaveBeenCalledTimes(1);

    engine.unmount('with.ops');
    expect(disconnect).toHaveBeenCalled();

    observe.mockRestore();
    disconnect.mockRestore();
  });

  it('restores a detached element before pruning and remains reversible after reattachment', () => {
    document.body.innerHTML = '<div class="target" data-orig="yes" style="color: blue;"></div>';
    const engine = new DeclarativeEngine({ doc: document });
    engine.mount(
      makeManifest({
        domOps: [
          { op: 'addClass', target: cssRef('.target'), className: 'gv-plugin-added' },
          { op: 'setAttribute', target: cssRef('.target'), name: 'data-orig', value: 'no' },
          { op: 'setStyle', target: cssRef('.target'), styles: { color: 'red' } },
        ],
      }),
    );

    const el = document.querySelector<HTMLElement>('.target')!;
    expect(el.classList.contains('gv-plugin-added')).toBe(true);
    expect(el.getAttribute('data-orig')).toBe('no');
    expect(el.style.color).toBe('red');

    el.remove();
    engine.reapplyNow();

    expect(el.classList.contains('gv-plugin-added')).toBe(false);
    expect(el.getAttribute('data-orig')).toBe('yes');
    expect(el.style.color).toBe('blue');

    document.body.appendChild(el);
    engine.reapplyNow();

    expect(el.classList.contains('gv-plugin-added')).toBe(true);
    expect(el.getAttribute('data-orig')).toBe('no');
    expect(el.style.color).toBe('red');

    engine.unmount('test.plugin');
    expect(el.classList.contains('gv-plugin-added')).toBe(false);
    expect(el.getAttribute('data-orig')).toBe('yes');
    expect(el.style.color).toBe('blue');
  });
});
