import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateFormulaCopy } from '@/features/formulaCopy';

import type { PluginManifest, SiteAdapter } from '../types';
import { DeclarativeEngine } from './declarativeEngine';
import type { PluginScope } from './pluginScope';

vi.mock('@/features/formulaCopy', () => ({
  activateFormulaCopy: vi.fn((scope: PluginScope) => {
    scope.effect(() => () => {}, 'formula-copy');
  }),
}));

const adapter: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: { userTurn: '.user-turn' },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  capabilities: new Set(['chat']),
};

function manifest(id: string, domOps: PluginManifest['contributes']['domOps']): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'd',
    author: 'a',
    category: 'other',
    license: 'MIT',
    engine: '>=1.3.0',
    tier: 'declarative',
    matches: ['https://chat.deepseek.com/*'],
    contributes: { domOps },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.mocked(activateFormulaCopy).mockClear();
});

describe('DeclarativeEngine native ops', () => {
  it('activates the named primitive on mount and disposes it on unmount', async () => {
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const plugin = manifest('x.formula', [{ op: 'native', handler: 'formulaCopy', params: {} }]);

    engine.mount(plugin);
    expect(activateFormulaCopy).toHaveBeenCalledTimes(1);
    const scope = vi.mocked(activateFormulaCopy).mock.calls[0][0];
    expect(scope.isDisposed).toBe(false);

    engine.unmount(plugin.id);
    await scope.dispose();
    expect(scope.isDisposed).toBe(true);
  });

  it('skips an unknown primitive and invalid params without failing the mount', () => {
    const engine = new DeclarativeEngine({ doc: document, adapter });
    engine.mount(
      manifest('x.unknown', [
        { op: 'native', handler: 'noSuchPrimitive', params: {} },
        { op: 'native', handler: 'formulaCopy', params: { bogus: true } },
        { op: 'addClass', target: { kind: 'css', selector: 'body' }, className: 'gv-plugin-ok' },
      ]),
    );
    expect(engine.isActive('x.unknown')).toBe(true);
    expect(activateFormulaCopy).not.toHaveBeenCalled();
    expect(document.body.classList.contains('gv-plugin-ok')).toBe(true);
    engine.unmount('x.unknown');
  });

  it('restarts primitives when settings change', async () => {
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const plugin = manifest('x.formula', [{ op: 'native', handler: 'formulaCopy', params: {} }]);
    engine.mount(plugin, { a: 1 });
    const first = vi.mocked(activateFormulaCopy).mock.calls[0][0];

    engine.updateSettings(plugin.id, { a: 2 });
    await vi.waitFor(() => expect(activateFormulaCopy).toHaveBeenCalledTimes(2));
    expect(first.isDisposed).toBe(true);
    engine.unmount(plugin.id);
  });

  it('a second settings update during a pending restart activates once, with the latest settings', async () => {
    const { getPrimitive } = await import('../verbs/registry');
    const activate = vi.spyOn(getPrimitive('formulaCopy')!, 'activate');
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const plugin = manifest('x.formula', [{ op: 'native', handler: 'formulaCopy', params: {} }]);
    engine.mount(plugin, { a: 1 });
    expect(activate).toHaveBeenCalledTimes(1);

    engine.updateSettings(plugin.id, { a: 2 });
    engine.updateSettings(plugin.id, { a: 3 });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls[1][2].settings).toEqual({ a: 3 });
    engine.unmount(plugin.id);
    activate.mockRestore();
  });
});

describe('DeclarativeEngine health signal (plan D12)', () => {
  it('flags a mounted plugin that finds no targets on a page with user turns, and clears when they appear', () => {
    document.body.innerHTML = '<div class="user-turn">hi</div>';
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const plugin = manifest('x.ops', [
      { op: 'addClass', target: { kind: 'css', selector: '.never-there' }, className: 'gv-x' },
    ]);
    engine.mount(plugin);
    expect(engine.getHealth(plugin.id)).toBeUndefined();

    engine.evaluateHealthNow();
    expect(engine.getHealth(plugin.id)).toBe(true);

    document.body.insertAdjacentHTML('beforeend', '<div class="never-there"></div>');
    engine.evaluateHealthNow();
    expect(engine.getHealth(plugin.id)).toBe(false);
    engine.unmount(plugin.id);
    expect(engine.getHealth(plugin.id)).toBeUndefined();
  });

  it('never flags an empty conversation or a pure-CSS plugin', () => {
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const ops = manifest('x.ops', [
      { op: 'addClass', target: { kind: 'css', selector: '.never-there' }, className: 'gv-x' },
    ]);
    const cssOnly: PluginManifest = {
      ...manifest('x.css', undefined),
      contributes: { styles: [{ css: 'body{--x:1}' }] },
    };
    engine.mount(ops);
    engine.mount(cssOnly);
    engine.evaluateHealthNow();
    expect(engine.getHealth(ops.id)).toBe(false);
    expect(engine.getHealth(cssOnly.id)).toBeUndefined();
    engine.unmountAll();
  });

  it('counts primitive-reported targets', () => {
    document.body.innerHTML = '<div class="user-turn">hi</div><div class="katex">f</div>';
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const plugin = manifest('x.formula', [{ op: 'native', handler: 'formulaCopy', params: {} }]);
    engine.mount(plugin);
    engine.evaluateHealthNow();
    expect(engine.getHealth(plugin.id)).toBe(false);
    engine.unmount(plugin.id);
  });
});
