import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import rawManifest from '../catalog/sites/deepseek/plugins/vim-input/plugin.json';
import { validateManifest } from '../manifest/validate';
import { DeclarativeEngine } from '../runtime/declarativeEngine';
import { PluginScope } from '../runtime/pluginScope';
import { deepseekAdapter } from '../sites/adapters/deepseek';

const parsed = validateManifest(rawManifest);
if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
const manifest = parsed.data;
const HUD_SELECTOR = '.gv-input-vim-hud';
const CURSOR_SELECTOR = '.gv-input-vim-cursor';

function createTextarea(id: string, className = ''): HTMLTextAreaElement {
  const input = document.createElement('textarea');
  input.id = id;
  input.className = className;
  input.value = 'alpha beta';
  // jsdom has no layout; keep selection, focus, events, and editing real.
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 40));
  return input;
}

function press(
  input: HTMLTextAreaElement,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  input.dispatchEvent(event);
  return event;
}

// Observe disposal without replacing PluginScope, the engine, registry, or Vim implementation.
function observeDisposal() {
  return vi.spyOn(PluginScope.prototype, 'dispose');
}

describe('DeepSeek Vim input integration', () => {
  let engine: DeclarativeEngine;
  let composer: HTMLTextAreaElement;
  let unrelated: HTMLTextAreaElement;
  let disposal: ReturnType<typeof observeDisposal>;

  beforeEach(() => {
    disposal = observeDisposal();
    unrelated = createTextarea('unrelated');
    composer = createTextarea('composer', 'ds-scroll-area');
    const wrapper = document.createElement('div');
    wrapper.append(composer);
    document.body.append(unrelated, wrapper);
    engine = new DeclarativeEngine({ doc: document, adapter: deepseekAdapter });
  });

  async function unmount(): Promise<void> {
    engine.unmount(manifest.id);
    // unmount is void; await its real scope disposal barrier before re-enabling.
    await Promise.all(disposal.mock.results.map((result) => result.value));
  }

  afterEach(async () => {
    engine.unmountAll();
    await Promise.all(disposal.mock.results.map((result) => result.value));
    // Let pending focusout reconciliation finish before the next fixture mounts.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function mountAndFocus(): void {
    engine.mount(manifest);
    composer.focus();
    composer.setSelectionRange(0, 0);
    expect(composer.dataset.gvVimMode).toBe('insert');
  }

  it('declares the existing handler, semantic composer, engine floor, and ten locales', () => {
    expect(manifest.id).toBe('voyager.deepseek-vim-input');
    expect(manifest.engine).toBe('>=1.4.0');
    expect(manifest.matches).toEqual(deepseekAdapter.matches);
    expect(manifest.requires).toEqual({ handlers: ['vimInput'], semantic: ['composer'] });
    expect(manifest.contributes.domOps).toEqual([
      { op: 'native', handler: 'vimInput', params: {} },
    ]);
    expect(manifest.contributes.styles ?? []).toEqual([]);
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
    for (const metadata of [manifest, ...Object.values(manifest.i18n ?? {})]) {
      expect(metadata.name?.trim()).toBeTruthy();
      expect(metadata.description?.trim()).toBeTruthy();
    }
  });

  it('uses the semantic composer rather than the first unrelated textarea', () => {
    mountAndFocus();
    expect(document.querySelectorAll(HUD_SELECTOR)).toHaveLength(1);
    expect(press(composer, 'Escape').defaultPrevented).toBe(true);
    expect(composer.dataset.gvVimMode).toBe('normal');

    unrelated.focus();
    unrelated.setSelectionRange(2, 2);
    for (const key of ['Escape', 'x', 'h', 'i']) {
      expect(press(unrelated, key).defaultPrevented).toBe(false);
    }
    expect(unrelated.value).toBe('alpha beta');
    expect(unrelated.selectionStart).toBe(2);
    expect(unrelated.dataset.gvVimMode).toBeUndefined();
    expect(composer.value).toBe('alpha beta');

    composer.focus();
    composer.setSelectionRange(0, 0);
    press(composer, 'Escape');
    press(composer, 'x');
    expect(composer.value).toBe('lpha beta');
    expect(unrelated.value).toBe('alpha beta');
  });

  it('passes insert typing through and performs normal-mode motions, deletion, and undo', () => {
    mountAndFocus();
    expect(press(composer, 'x').defaultPrevented).toBe(false);
    // Synthetic keydown has no browser default insertion in jsdom.
    composer.setRangeText('x', 0, 0, 'end');
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }));
    expect(composer.value).toBe('xalpha beta');
    expect(composer.selectionStart).toBe(1);

    expect(press(composer, 'Escape').defaultPrevented).toBe(true);
    expect(composer.dataset.gvVimMode).toBe('normal');
    expect(press(composer, 'h').defaultPrevented).toBe(true);
    expect(composer.selectionStart).toBe(0);
    press(composer, 'l');
    expect(composer.selectionStart).toBe(1);
    press(composer, 'w');
    expect(composer.selectionStart).toBe(7);

    const onInput = vi.fn();
    composer.addEventListener('input', onInput);
    expect(press(composer, 'x').defaultPrevented).toBe(true);
    expect(composer.value).toBe('xalpha eta');
    expect(onInput).toHaveBeenCalledOnce();
    press(composer, 'u');
    expect(composer.value).toBe('xalpha beta');

    expect(press(composer, 'i').defaultPrevented).toBe(true);
    expect(composer.dataset.gvVimMode).toBe('insert');
    expect(press(composer, 'x').defaultPrevented).toBe(false);
  });

  it('bypasses composing keys without changing mode, text, or selection', () => {
    mountAndFocus();
    expect(press(composer, 'Escape', { isComposing: true }).defaultPrevented).toBe(false);
    expect(composer.dataset.gvVimMode).toBe('insert');

    press(composer, 'Escape');
    for (const key of ['x', 'h', 'i', 'Escape']) {
      expect(press(composer, key, { isComposing: true }).defaultPrevented).toBe(false);
      expect(composer.dataset.gvVimMode).toBe('normal');
      expect(composer.value).toBe('alpha beta');
      expect(composer.selectionStart).toBe(0);
      expect(composer.selectionEnd).toBe(0);
    }
    press(composer, 'x');
    expect(composer.value).toBe('lpha beta');
  });

  it('edits a replacement composer without remounting and clears the detached input state', () => {
    mountAndFocus();
    press(composer, 'Escape');
    press(composer, 'x');
    const detached = composer;
    composer = createTextarea('replacement', 'ds-scroll-area');
    detached.replaceWith(composer);
    composer.focus();
    composer.setSelectionRange(0, 0);

    expect(composer.dataset.gvVimMode).toBe('insert');
    expect(detached.dataset.gvVimMode).toBeUndefined();
    expect(detached.className).toBe('ds-scroll-area');
    press(composer, 'Escape');
    press(composer, 'u');
    expect(composer.value).toBe('alpha beta');
    press(composer, 'x');
    expect(composer.value).toBe('lpha beta');
    expect(detached.value).toBe('lpha beta');
    expect(document.querySelectorAll(HUD_SELECTOR)).toHaveLength(1);
    expect(unrelated.dataset.gvVimMode).toBeUndefined();
  });

  it('disposes UI and key handling and re-enables without duplicate edits or stale undo', async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      composer.value = 'alpha beta';
      mountAndFocus();
      press(composer, 'Escape');
      press(composer, 'u');
      expect(composer.value).toBe('alpha beta');
      press(composer, 'x');
      expect(composer.value).toBe('lpha beta');
      expect(document.querySelectorAll(HUD_SELECTOR)).toHaveLength(1);

      await unmount();
      expect(engine.activeCount).toBe(0);
      expect(disposal).toHaveBeenCalledTimes(cycle + 1);
      expect(composer.dataset.gvVimMode).toBeUndefined();
      expect(composer.className).toBe('ds-scroll-area');
      expect(document.querySelector(HUD_SELECTOR)).toBeNull();
      expect(document.querySelector(CURSOR_SELECTOR)).toBeNull();
      expect(document.querySelector('.gv-input-vim-hud-mount')).toBeNull();
      const selection = composer.selectionStart;
      for (const key of ['Escape', 'x', 'h', 'i']) {
        expect(press(composer, key).defaultPrevented).toBe(false);
      }
      expect(composer.selectionStart).toBe(selection);
      expect(composer.value).toBe('lpha beta');
    }
  });

  it('pays late startup cleanup when disabled before the activation promise settles', async () => {
    mountAndFocus();
    await unmount();
    expect(document.querySelector(HUD_SELECTOR)).toBeNull();
    expect(composer.dataset.gvVimMode).toBeUndefined();
    expect(press(composer, 'Escape').defaultPrevented).toBe(false);

    mountAndFocus();
    press(composer, 'Escape');
    press(composer, 'x');
    expect(composer.value).toBe('lpha beta');
    expect(document.querySelectorAll(HUD_SELECTOR)).toHaveLength(1);
  });
});
