import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as i18n from '@/utils/i18n';

import pluginManifest from '../catalog/sites/deepseek/plugins/code-collapse/plugin.json';
import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { PluginScope } from '../runtime/pluginScope';
import type { PluginManifest, SiteAdapter } from '../types';
import { codeCollapsePrimitive, type CodeCollapseParams } from './codeCollapse';
import { codeCollapseLabels } from './codeCollapse/labels';
import { activateCodeCollapse } from './codeCollapse/runtime';
import type { PrimitiveContext } from './types';

const fixtures = [
  {
    id: 'deepseek',
    selector: '.ds-message:has(.ds-assistant-message-main-content)',
    html: '<div class="ds-message"><div class="ds-assistant-message-main-content"><div class="code-shell"><button class="native-copy">Copy</button><pre><code></code></pre></div></div></div>',
  },
  {
    id: 'chatgpt',
    selector: '[data-message-author-role="assistant"], .imagegen',
    html: '<article data-message-author-role="assistant"><section class="code-shell"><header><button class="native-copy">Copy code</button></header><pre><code></code></pre></section></article>',
  },
];
const text = (lines: number, prefix = 'line') =>
  Array.from({ length: lines }, (_, i) => prefix + i).join('\n');
const toggle = () => document.querySelector<HTMLButtonElement>('.gv-code-collapse-toggle');
const toolbarButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-code-collapse-toolbar button')).find(
    (el) => el.getAttribute('aria-label') === label,
  )!;
let scopes: PluginScope[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(i18n, 'getCurrentLanguage').mockResolvedValue('en');
  vi.stubGlobal('CSS', { supports: () => true });
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
});
afterEach(async () => {
  for (const scope of scopes) await scope.dispose();
  scopes = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});
async function flush() {
  await vi.advanceTimersByTimeAsync(100);
}

function setup(
  fixture: (typeof fixtures)[number],
  lines = 25,
  params: CodeCollapseParams = {},
  settings = {},
) {
  document.body.innerHTML = fixture.html + '<div class="user"><pre>user code</pre></div>';
  const pre = document.querySelector<HTMLElement>('pre')!;
  const code = pre.querySelector('code')!;
  code.textContent = text(lines);
  const scope = new PluginScope();
  scopes.push(scope);
  const adapter: SiteAdapter = {
    id: fixture.id,
    label: fixture.id,
    matches: ['https://example.com/*'],
    selectors: { assistantTurn: fixture.selector, userTurn: '.user', thinkingBlock: '.reasoning' },
    capabilities: new Set(['chat']),
    theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  };
  const count = vi.fn();
  const context: PrimitiveContext = {
    doc: document,
    adapter,
    pluginId: 'test.code-collapse',
    settings,
    setTargetCounter: count,
  };
  return {
    pre,
    code,
    scope,
    adapter,
    context,
    count,
    start: () => activateCodeCollapse(scope, params, context),
  };
}

describe('codeCollapse validation and locales', () => {
  it('accepts only optional code and bounded numeric thresholdLines', () => {
    expect(codeCollapsePrimitive.validateParams(undefined)).toEqual({ success: true, data: {} });
    expect(
      codeCollapsePrimitive.validateParams({ code: '.answer pre', thresholdLines: 5 }).success,
    ).toBe(true);
    expect(codeCollapsePrimitive.validateParams({ thresholdLines: 200 }).success).toBe(true);
    for (const raw of [
      null,
      [],
      '',
      { code: '' },
      { code: 1 },
      { code: 'x'.repeat(2001) },
      { thresholdLines: 4 },
      { thresholdLines: 201 },
      { thresholdLines: NaN },
      { thresholdLines: Infinity },
      { thresholdLines: '20' },
      { enabled: true },
    ]) {
      expect(codeCollapsePrimitive.validateParams(raw).success).toBe(false);
    }
  });
  it('covers the same ten locales as the manifest with language and region fallbacks', () => {
    const locales = ['en', ...Object.keys(pluginManifest.i18n)];
    expect(locales).toHaveLength(10);
    for (const locale of locales) {
      const labels = codeCollapseLabels(locale);
      expect(Object.values(labels).every((label) => label.length > 0)).toBe(true);
      if (locale !== 'en') expect(labels.expand).not.toBe(codeCollapseLabels('en').expand);
    }
    expect(codeCollapseLabels('zh-Hant-HK')).toEqual(codeCollapseLabels('zh_TW'));
    expect(codeCollapseLabels('pt-BR')).toEqual(codeCollapseLabels('pt'));
    expect(codeCollapseLabels('xx')).toEqual(codeCollapseLabels('en'));
    expect(pluginManifest.contributes.settings.thresholdLines).toMatchObject({
      default: 20,
      min: 5,
      max: 200,
    });
  });
});

describe.each(fixtures)('codeCollapse on $id', (fixture) => {
  it('defaults to answer code, excluding thinking blocks unless explicitly selected', async () => {
    const { pre, adapter, start, scope } = setup(fixture);
    const thinking = document.createElement('div');
    thinking.className = 'reasoning';
    const thoughtCode = pre.cloneNode(true) as HTMLElement;
    thinking.append(thoughtCode);
    pre.parentElement!.append(thinking);
    start();
    expect(document.querySelectorAll('.gv-code-collapse-toggle')).toHaveLength(1);
    expect(thoughtCode.hasAttribute('style')).toBe(false);
    await scope.dispose();
    const next = new PluginScope();
    scopes.push(next);
    activateCodeCollapse(
      next,
      { code: '.reasoning pre' },
      {
        doc: document,
        adapter,
        pluginId: 'test.explicit',
        settings: {},
        setTargetCounter: () => {},
      },
    );
    expect(thoughtCode.style.maxHeight).toBe('20lh');
    expect(pre.hasAttribute('style')).toBe(false);
  });

  it('uses bounded traversal instead of pre.textContent and releases oversized blocks', async () => {
    const { pre, code, start } = setup(fixture);
    Object.defineProperty(pre, 'textContent', {
      configurable: true,
      get() {
        throw new Error('unbounded text read');
      },
    });
    start();
    expect(toggle()).not.toBeNull();
    code.append('x'.repeat(200_001));
    await flush();
    expect(toggle()).toBeNull();
    expect(pre.hasAttribute('style')).toBe(false);
    expect(code.textContent!.length).toBeGreaterThan(200_000);
  });

  it('uses a pixel clamp when lh is unsupported and restores it exactly', async () => {
    vi.stubGlobal('CSS', { supports: () => false });
    const { pre, start, scope } = setup(fixture);
    pre.style.lineHeight = '24px';
    const original = pre.getAttribute('style');
    start();
    expect(pre.style.maxHeight).toBe('480px');
    await scope.dispose();
    expect(pre.getAttribute('style')).toBe(original);
  });

  it('resets a user decision when the same target is assigned a new message id', async () => {
    const { pre, start } = setup(fixture);
    pre.parentElement!.setAttribute('data-message-id', 'first');
    start();
    toggle()!.click();
    const old = toggle();
    pre.parentElement!.setAttribute('data-message-id', 'second');
    await flush();
    expect(old?.isConnected).toBe(false);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('settles its own DOM mutations without an observer/timer loop', async () => {
    const { start, scope } = setup(fixture);
    start();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    toggle()!.click();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    const html = document.body.innerHTML;
    const effects = scope.getEffects();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.body.innerHTML).toBe(html);
    expect(scope.getEffects()).toEqual(effects);
  });

  it('ignores unrelated streaming but still reconciles on route and code changes', async () => {
    const { code, pre, start } = setup(fixture);
    const prose = document.createElement('p');
    pre.parentElement!.parentElement!.append(prose);
    const reads = vi.spyOn(document, 'createTreeWalker');
    start();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    const codeReads = () => reads.mock.calls.filter(([root]) => root === pre).length;
    const initialReads = codeReads();
    prose.append('response text');
    prose.firstChild!.textContent += ' keeps streaming';
    prose.classList.add('streaming');
    await flush();
    expect(codeReads()).toBe(initialReads);
    code.append('\nstreamed code');
    await flush();
    expect(codeReads()).toBeGreaterThan(initialReads);

    toggle()!.click();
    const oldToggle = toggle();
    const originalUrl = location.href;
    try {
      history.pushState(null, '', '#new-conversation');
      prose.append('another unrelated update');
      await flush();
      expect(oldToggle?.isConnected).toBe(false);
      expect(pre.style.maxHeight).toBe('20lh');
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      history.replaceState(null, '', originalUrl);
    }
  });

  it('keeps native copy, original nodes, full text, and exact DOM/styles on disposal', async () => {
    const { pre, code, start, scope, count } = setup(fixture);
    pre.setAttribute(
      'style',
      'color: red; max-height: 900px !important; min-height: 8px; overflow: auto;',
    );
    const before = document.body.innerHTML;
    const parent = pre.parentNode;
    const copied: string[] = [];
    const copy = document.querySelector<HTMLButtonElement>('.native-copy')!;
    copy.addEventListener('click', () => copied.push(code.textContent!));
    start();
    expect(pre.parentNode).toBe(parent);
    expect(pre.querySelector('code')).toBe(code);
    expect(pre.style.maxHeight).toBe('20lh');
    expect(code.textContent).toBe(text(25));
    expect(copy.closest('pre')).toBeNull();
    copy.click();
    expect(copied).toEqual([text(25)]);
    expect(count.mock.calls[0][0]()).toBe(1);
    expect(document.querySelector('.user pre')?.getAttribute('style')).toBeNull();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    await flush();
    await scope.dispose();
    expect(document.body.innerHTML).toBe(before);
    expect(document.head.querySelector('[data-gv-plugin-scope]')).toBeNull();
    expect(scope.getEffects()).toEqual([]);
    code.append('\nlate');
    await flush();
    expect(toggle()).toBeNull();
  });

  it('waits to exceed threshold, then preserves expansion during streaming and rehighlighting', async () => {
    const { code, pre, start } = setup(fixture, 20);
    start();
    expect(toggle()).toBeNull();
    code.append('\nline20');
    await flush();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    toggle()!.click();
    expect(pre.hasAttribute('style')).toBe(false);
    code.append('\nline21');
    await flush();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    const highlighted = document.createElement('span');
    highlighted.textContent = code.textContent;
    code.replaceChildren(highlighted);
    await flush();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(pre.hasAttribute('style')).toBe(false);
  });

  it('supports all-block controls and in-place threshold settings without losing decisions', async () => {
    const { pre, code, start } = setup(fixture, 25, { thresholdLines: 30 });
    const handle = start();
    expect(toggle()).toBeNull();
    handle.updateSettings!({ thresholdLines: 5 });
    expect(pre.style.maxHeight).toBe('5lh');
    const second = pre.cloneNode(true) as HTMLElement;
    second.removeAttribute('style');
    pre.parentElement!.append(second);
    await flush();
    expect(document.querySelectorAll('.gv-code-collapse-toggle')).toHaveLength(2);
    toolbarButton('Expand all code').click();
    expect(
      document.querySelectorAll('.gv-code-collapse-toggle[aria-expanded="true"]'),
    ).toHaveLength(2);
    handle.updateSettings!({ thresholdLines: 10 });
    code.append('\nnext');
    await flush();
    expect(pre.hasAttribute('style')).toBe(false);
    toolbarButton('Collapse all code').click();
    expect(pre.style.maxHeight).toBe('10lh');
    handle.updateSettings!({ thresholdLines: 200 });
    expect(toggle()).toBeNull();
    expect(pre.hasAttribute('style')).toBe(false);
    handle.updateSettings!({ thresholdLines: 5 });
    expect(pre.style.maxHeight).toBe('5lh');
  });

  it('cleans detached controls and gives reused targets a fresh decision', async () => {
    const { pre, code, start } = setup(fixture);
    start();
    toggle()!.click();
    const old = toggle()!;
    code.textContent = text(26, 'replacement');
    await flush();
    expect(old.isConnected).toBe(false);
    expect(toggle()).not.toBe(old);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    const parent = pre.parentElement!;
    pre.remove();
    await flush();
    expect(toggle()).toBeNull();
    expect(document.querySelector('.gv-code-collapse-toolbar')).toBeNull();
    expect(pre.hasAttribute('style')).toBe(false);
    parent.append(pre);
    await flush();
    expect(document.querySelectorAll('.gv-code-collapse-toggle')).toHaveLength(1);
  });

  it('leaves internal native controls and editable code untouched', () => {
    const { pre, start } = setup(fixture);
    pre.append(document.createElement('button'));
    const before = pre.outerHTML;
    start();
    expect(pre.outerHTML).toBe(before);
    expect(toggle()).toBeNull();
  });

  it('respects inherited editable modes and reacts when they change', async () => {
    const { pre, start } = setup(fixture);
    const parent = pre.parentElement!;
    parent.setAttribute('contenteditable', '');
    start();
    expect(toggle()).toBeNull();
    parent.setAttribute('contenteditable', 'false');
    await flush();
    expect(toggle()).not.toBeNull();
    parent.setAttribute('contenteditable', 'plaintext-only');
    await flush();
    expect(toggle()).toBeNull();
    expect(pre.hasAttribute('style')).toBe(false);
    parent.removeAttribute('contenteditable');
    await flush();
    expect(toggle()).not.toBeNull();
  });

  it('uses the saved language, updates controls, and ignores stale language reads', async () => {
    vi.mocked(i18n.getCurrentLanguage).mockResolvedValueOnce('zh');
    const { start, scope } = setup(fixture);
    start();
    await flush();
    expect(toggle()?.getAttribute('aria-label')).toBe('展开代码');
    expect(toolbarButton('展开全部代码')).not.toBeNull();
    let resolveOld!: (value: 'en') => void;
    vi.mocked(i18n.getCurrentLanguage)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce('ja');
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];
    listener?.({ language: { newValue: 'en' } }, 'sync');
    listener?.({ language: { newValue: 'ja' } }, 'sync');
    await flush();
    expect(toggle()?.getAttribute('aria-label')).toBe('コードを展開');
    resolveOld('en');
    await flush();
    expect(toggle()?.getAttribute('aria-label')).toBe('コードを展開');
    toggle()!.click();
    expect(toggle()?.getAttribute('aria-label')).toBe('コードを折りたたむ');
    await scope.dispose();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
  });

  it('does not mount controls from a language read that resolves after disposal', async () => {
    let resolveLanguage!: (value: 'zh') => void;
    vi.mocked(i18n.getCurrentLanguage).mockImplementationOnce(
      () => new Promise((resolve) => (resolveLanguage = resolve)),
    );
    const { start, scope } = setup(fixture);
    start();
    await scope.dispose();
    resolveLanguage('zh');
    await flush();
    expect(toggle()).toBeNull();
    expect(document.head.querySelector('[data-gv-plugin-scope]')).toBeNull();
  });

  it('honors selector overrides and stays inert for invalid selectors', async () => {
    const { start, scope } = setup(fixture, 25, { code: '[' });
    start();
    expect(toggle()).toBeNull();
    await scope.dispose();
    const next = setup(fixture, 25, { code: '.code-shell pre', thresholdLines: 5 });
    next.start();
    expect(next.pre.style.maxHeight).toBe('5lh');
  });

  it('preserves unrelated inline host updates while restoring original clamp properties', async () => {
    const { pre, start, scope } = setup(fixture);
    pre.style.setProperty('max-height', '333px', 'important');
    pre.style.setProperty('overflow-y', 'scroll');
    // jsdom's CSS parser currently drops priority on max-height; compare the
    // actual pre-mount CSSOM value here. The exact raw attribute test above
    // independently guards rollback of authored !important declarations.
    const priorPriority = pre.style.getPropertyPriority('max-height');
    start();
    pre.style.color = 'blue';
    await scope.dispose();
    expect(pre.style.maxHeight).toBe('333px');
    expect(pre.style.getPropertyPriority('max-height')).toBe(priorPriority);
    expect(pre.style.overflowY).toBe('scroll');
    expect(pre.style.color).toBe('blue');
  });

  it('reapplies the clamp after host style writes and returns the host latest values', async () => {
    const { pre, start, scope } = setup(fixture);
    pre.style.setProperty('max-height', '333px', 'important');
    start();
    await flush();
    pre.style.setProperty('max-height', '777px', 'important');
    const hostPriority = pre.style.getPropertyPriority('max-height');
    pre.style.color = 'blue';
    await flush();
    expect(pre.style.maxHeight).toBe('20lh');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(vi.getTimerCount()).toBe(0);
    await scope.dispose();
    expect(pre.style.maxHeight).toBe('777px');
    expect(pre.style.getPropertyPriority('max-height')).toBe(hostPriority);
    expect(pre.style.color).toBe('blue');
  });

  it('keeps a last-moment host style replacement when disabled', async () => {
    const { pre, start, scope } = setup(fixture);
    start();
    pre.setAttribute('style', 'max-height: 800px; color: green;');
    await scope.dispose();
    expect(pre.getAttribute('style')).toContain('max-height: 800px');
    expect(pre.style.color).toBe('green');
  });

  it('does not duplicate-mount through the engine and handles settings and teardown', async () => {
    const { adapter } = setup(fixture);
    const engine = new DeclarativeEngine({ doc: document, adapter });
    const manifest = pluginManifest as PluginManifest;
    const before = document.body.innerHTML;
    engine.mount(manifest);
    engine.mount(manifest);
    await flush();
    expect(document.querySelectorAll('.gv-code-collapse-toggle')).toHaveLength(1);
    engine.updateSettings(manifest.id, { thresholdLines: 5 });
    expect(document.querySelector<HTMLElement>('pre')!.style.maxHeight).toBe('5lh');
    engine.unmount(manifest.id);
    await flush();
    expect(document.body.innerHTML).toBe(before);
  });
});
