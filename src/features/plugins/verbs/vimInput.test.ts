import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '../runtime/pluginScope';
import type { SiteAdapter } from '../types';
import type { PrimitiveContext } from './types';
import { vimInputPrimitive } from './vimInput';

const mocks = vi.hoisted(() => ({
  startInputVimMode: vi.fn(),
  findChatInput: vi.fn(),
}));

vi.mock('@/pages/content/chatInput/vimMode', () => ({
  startInputVimMode: mocks.startInputVimMode,
}));
vi.mock('@/pages/content/chatInput', () => ({
  findChatInput: mocks.findChatInput,
}));

const deepseek: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: { composer: 'textarea.ds-scroll-area' },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  capabilities: new Set(['composer']),
};

function context(adapter: SiteAdapter | null) {
  const counters: Array<() => number> = [];
  const ctx: PrimitiveContext = {
    doc: document,
    adapter,
    pluginId: 'test.vim',
    settings: {},
    setTargetCounter: (count) => counters.push(count),
  };
  return { ctx, counters };
}

afterEach(() => {
  document.body.innerHTML = '';
  mocks.startInputVimMode.mockReset();
  mocks.findChatInput.mockReset();
});

describe('vimInput primitive', () => {
  it('accepts an optional composer selector and rejects anything else', () => {
    expect(vimInputPrimitive.validateParams(undefined)).toEqual({ success: true, data: {} });
    expect(vimInputPrimitive.validateParams({ composer: 'textarea' })).toEqual({
      success: true,
      data: { composer: 'textarea' },
    });
    expect(vimInputPrimitive.validateParams({ composer: '' }).success).toBe(false);
    expect(vimInputPrimitive.validateParams({ mode: 'insert' }).success).toBe(false);
    expect(vimInputPrimitive.validateParams('x').success).toBe(false);
  });

  it("starts Vim on the adapter's composer and counts it as the target", async () => {
    document.body.innerHTML = '<textarea class="ds-scroll-area"></textarea>';
    const cleanup = vi.fn();
    mocks.startInputVimMode.mockResolvedValue(cleanup);
    const scope = new PluginScope();
    const { ctx, counters } = context(deepseek);

    vimInputPrimitive.activate(scope, {}, ctx);

    expect(mocks.startInputVimMode).toHaveBeenCalledWith({
      forceEnabled: true,
      composerSelector: 'textarea.ds-scroll-area',
    });
    expect(counters[0]()).toBe(1);
    await scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('prefers an explicit composer param and falls back to the generic lookup without one', () => {
    mocks.startInputVimMode.mockResolvedValue(() => {});
    const explicit = context(deepseek);
    vimInputPrimitive.activate(new PluginScope(), { composer: '#custom' }, explicit.ctx);
    expect(mocks.startInputVimMode).toHaveBeenLastCalledWith({
      forceEnabled: true,
      composerSelector: '#custom',
    });

    mocks.findChatInput.mockReturnValue(document.createElement('textarea'));
    const generic = context(null);
    vimInputPrimitive.activate(new PluginScope(), {}, generic.ctx);
    expect(mocks.startInputVimMode).toHaveBeenLastCalledWith({
      forceEnabled: true,
      composerSelector: undefined,
    });
    expect(generic.counters[0]()).toBe(1);
  });
});
