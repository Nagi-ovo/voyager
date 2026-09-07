import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateFormulaCopy } from '@/features/formulaCopy';

import { PluginScope } from '../runtime/pluginScope';
import { formulaCopyPrimitive } from './formulaCopy';
import type { PrimitiveContext } from './types';

vi.mock('@/features/formulaCopy', () => ({
  activateFormulaCopy: vi.fn((scope: PluginScope) => {
    scope.effect(() => () => {}, 'formula-copy');
  }),
}));

function context(doc: Document): PrimitiveContext & { counters: Array<() => number> } {
  const counters: Array<() => number> = [];
  return {
    doc,
    adapter: null,
    pluginId: 'test.formula',
    settings: {},
    counters,
    setTargetCounter: (count) => counters.push(count),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.mocked(activateFormulaCopy).mockClear();
});

describe('formulaCopy primitive', () => {
  it('accepts only an empty params object', () => {
    expect(formulaCopyPrimitive.validateParams(undefined)).toEqual({ success: true, data: {} });
    expect(formulaCopyPrimitive.validateParams({})).toEqual({ success: true, data: {} });
    expect(formulaCopyPrimitive.validateParams({ scope: '.x' }).success).toBe(false);
    expect(formulaCopyPrimitive.validateParams('nope').success).toBe(false);
  });

  it('activates the shared formula-copy feature under the plugin scope and counts formula targets', () => {
    document.body.innerHTML =
      '<div class="katex">a</div><span data-math="x"></span><p>no formula</p>';
    const scope = new PluginScope();
    const ctx = context(document);

    formulaCopyPrimitive.activate(scope, {}, ctx);

    expect(activateFormulaCopy).toHaveBeenCalledWith(scope);
    expect(ctx.counters).toHaveLength(1);
    expect(ctx.counters[0]()).toBe(2);
    expect(scope.getEffects()).toContain('formula-copy');
  });
});
