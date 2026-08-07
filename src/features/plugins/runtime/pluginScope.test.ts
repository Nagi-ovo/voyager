import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from './pluginScope';

describe('PluginScope', () => {
  let scope: PluginScope;

  afterEach(async () => {
    await scope?.dispose();
  });

  describe('effect', () => {
    it('runs disposers in reverse registration order on dispose', async () => {
      scope = new PluginScope();
      const order: string[] = [];
      scope.effect(() => () => void order.push('first'));
      scope.effect(() => () => void order.push('second'));
      await scope.dispose();
      expect(order).toEqual(['second', 'first']);
    });

    it('one throwing disposer does not block the rest', async () => {
      scope = new PluginScope();
      const survivor = vi.fn();
      scope.effect(() => survivor);
      scope.effect(() => () => {
        throw new Error('boom');
      });
      await scope.dispose();
      expect(survivor).toHaveBeenCalledOnce();
    });

    it('supports async disposers and awaits them on dispose', async () => {
      scope = new PluginScope();
      let settled = false;
      scope.effect(() => async () => {
        await Promise.resolve();
        settled = true;
      });
      await scope.dispose();
      expect(settled).toBe(true);
    });

    it('collects every disposer yielded by an iterable', async () => {
      scope = new PluginScope();
      const a = vi.fn();
      const b = vi.fn();
      scope.effect(function* () {
        yield a;
        yield b;
      });
      await scope.dispose();
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it('rolls back already-collected disposers when the effect throws mid-way', () => {
      scope = new PluginScope();
      const collected = vi.fn();
      expect(() =>
        scope.effect(function* () {
          yield collected;
          throw new Error('mid-way');
        }),
      ).toThrow('mid-way');
      expect(collected).toHaveBeenCalledOnce();
      expect(scope.getEffects()).toHaveLength(0);
    });

    it('a Promise disposer resolving after disposal began is still paid before it settles', async () => {
      scope = new PluginScope();
      const late = vi.fn();
      let resolve!: (d: () => void) => void;
      scope.effect(() => new Promise<() => void>((r) => (resolve = r)));
      const disposal = scope.dispose();
      resolve(late);
      await disposal;
      expect(late).toHaveBeenCalledOnce();
    });

    it('returned remover disposes just that effect and unlists it', async () => {
      scope = new PluginScope();
      const target = vi.fn();
      const keep = vi.fn();
      const remove = scope.effect(() => target, 'target');
      scope.effect(() => keep, 'keep');
      await remove();
      expect(target).toHaveBeenCalledOnce();
      expect(scope.getEffects()).toEqual(['keep']);
      await scope.dispose();
      expect(target).toHaveBeenCalledOnce();
      expect(keep).toHaveBeenCalledOnce();
    });

    it('registering on a disposed scope throws', async () => {
      scope = new PluginScope();
      await scope.dispose();
      expect(() => scope.effect(() => () => {}, 'late')).toThrow(/disposed/);
    });

    it('dispose is idempotent and runs each disposer once', async () => {
      scope = new PluginScope();
      const once = vi.fn();
      scope.effect(() => once);
      await Promise.all([scope.dispose(), scope.dispose()]);
      await scope.dispose();
      expect(once).toHaveBeenCalledOnce();
    });
  });

  describe('signal', () => {
    it('aborts when disposal begins', async () => {
      scope = new PluginScope();
      expect(scope.signal.aborted).toBe(false);
      await scope.dispose();
      expect(scope.signal.aborted).toBe(true);
    });
  });

  describe('helpers', () => {
    it('on() removes the DOM listener on dispose', async () => {
      scope = new PluginScope();
      const fn = vi.fn();
      const el = document.createElement('button');
      scope.on(el, 'click', fn);
      el.dispatchEvent(new Event('click'));
      await scope.dispose();
      el.dispatchEvent(new Event('click'));
      expect(fn).toHaveBeenCalledOnce();
    });

    it('onChromeEvent() removes the chrome-style listener on dispose', async () => {
      scope = new PluginScope();
      const listeners = new Set<() => void>();
      const event = {
        addListener: (fn: () => void) => void listeners.add(fn),
        removeListener: (fn: () => void) => void listeners.delete(fn),
      };
      scope.onChromeEvent(event, vi.fn());
      expect(listeners.size).toBe(1);
      await scope.dispose();
      expect(listeners.size).toBe(0);
    });

    it('mount() inserts before the anchor and removes on dispose', async () => {
      scope = new PluginScope();
      const parent = document.body.appendChild(document.createElement('div'));
      try {
        const anchor = parent.appendChild(document.createElement('i'));
        const el = document.createElement('span');
        scope.mount(el, parent, anchor);
        expect(parent.firstElementChild).toBe(el);
        await scope.dispose();
        expect(el.isConnected).toBe(false);
        expect(anchor.isConnected).toBe(true);
      } finally {
        parent.remove();
      }
    });

    it('style() injects into head and removes on dispose', async () => {
      scope = new PluginScope();
      scope.style('.gv-scope-test { color: red; }');
      const el = document.head.querySelector('style[data-gv-plugin-scope]');
      expect(el?.textContent).toContain('gv-scope-test');
      await scope.dispose();
      expect(document.head.querySelector('style[data-gv-plugin-scope]')).toBeNull();
    });

    it('timer() clears a pending timeout on dispose', async () => {
      vi.useFakeTimers();
      try {
        scope = new PluginScope();
        const fn = vi.fn();
        scope.timer(fn, 1000);
        await scope.dispose();
        vi.advanceTimersByTime(2000);
        expect(fn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('timer({repeat}) clears the interval on dispose', async () => {
      vi.useFakeTimers();
      try {
        scope = new PluginScope();
        const fn = vi.fn();
        scope.timer(fn, 100, { repeat: true });
        vi.advanceTimersByTime(250);
        expect(fn).toHaveBeenCalledTimes(2);
        await scope.dispose();
        vi.advanceTimersByTime(500);
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('observe() disconnects the MutationObserver on dispose', async () => {
      scope = new PluginScope();
      const fn = vi.fn();
      const target = document.createElement('div');
      document.body.appendChild(target);
      try {
        scope.observe(target, { childList: true }, fn);
        target.appendChild(document.createElement('span'));
        await new Promise((r) => setTimeout(r, 0));
        const callsWhileLive = fn.mock.calls.length;
        expect(callsWhileLive).toBeGreaterThan(0);
        await scope.dispose();
        target.appendChild(document.createElement('span'));
        await new Promise((r) => setTimeout(r, 0));
        expect(fn.mock.calls.length).toBe(callsWhileLive);
      } finally {
        target.remove();
      }
    });

    it('child() invokes the adopted destroy() on dispose', async () => {
      scope = new PluginScope();
      const destroy = vi.fn();
      scope.child({ destroy });
      await scope.dispose();
      expect(destroy).toHaveBeenCalledOnce();
    });

    it('frame({repeat}) stops the rAF loop on dispose', async () => {
      scope = new PluginScope();
      const fn = vi.fn();
      scope.frame(fn, { repeat: true });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const calls = fn.mock.calls.length;
      await scope.dispose();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      expect(fn.mock.calls.length).toBe(calls);
    });
  });

  describe('claim-once and barrier semantics', () => {
    it('a remover called after dispose() does not run the disposer twice', async () => {
      scope = new PluginScope();
      const once = vi.fn();
      const remove = scope.effect(() => once);
      await scope.dispose();
      await remove();
      expect(once).toHaveBeenCalledOnce();
    });

    it('concurrent remover and dispose() share one settlement', async () => {
      scope = new PluginScope();
      const once = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      const remove = scope.effect(() => once);
      await Promise.all([remove(), scope.dispose()]);
      expect(once).toHaveBeenCalledOnce();
    });

    it('a remover called before the Promise disposer resolves pays once, not re-adds', async () => {
      scope = new PluginScope();
      const late = vi.fn();
      let resolve!: (d: () => void) => void;
      const remove = scope.effect(() => new Promise<() => void>((r) => (resolve = r)), 'late');
      const removal = remove();
      resolve(late);
      await removal;
      expect(late).toHaveBeenCalledOnce();
      expect(scope.getEffects()).toEqual([]);
      await scope.dispose();
      expect(late).toHaveBeenCalledOnce();
    });

    it('dispose() is a barrier: it awaits a pending Promise effect and pays in order', async () => {
      scope = new PluginScope();
      const order: string[] = [];
      let resolveFirst!: (d: () => void) => void;
      scope.effect(() => new Promise<() => void>((r) => (resolveFirst = r)), 'first');
      scope.effect(() => () => void order.push('second'), 'second');

      const disposal = scope.dispose();
      let settled = false;
      void disposal.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 0));
      // The pending first effect keeps the barrier open.
      expect(settled).toBe(false);

      resolveFirst(() => void order.push('first'));
      await disposal;
      expect(order).toEqual(['second', 'first']);
    });

    it('dispose() awaits the rollback of a mid-way-failed iterable effect', async () => {
      scope = new PluginScope();
      let rolledBack = false;
      expect(() =>
        scope.effect(function* () {
          yield async () => {
            await new Promise((r) => setTimeout(r, 5));
            rolledBack = true;
          };
          throw new Error('mid-way');
        }),
      ).toThrow('mid-way');
      await scope.dispose();
      expect(rolledBack).toBe(true);
    });

    it('an effect whose run() disposes the scope synchronously still gets paid', async () => {
      scope = new PluginScope();
      const paid = vi.fn();
      scope.effect(() => {
        void scope.dispose();
        return paid;
      });
      await scope.dispose();
      expect(paid).toHaveBeenCalledOnce();
    });

    it('an abort listener re-entering dispose() receives the same settlement', async () => {
      scope = new PluginScope();
      let inner: Promise<void> | null = null;
      scope.signal.addEventListener('abort', () => {
        inner = scope.dispose();
      });
      const outer = scope.dispose();
      expect(inner).not.toBeNull();
      await Promise.all([outer, inner]);
    });
  });

  describe('ledger hygiene', () => {
    it('a fired one-shot timer releases its ledger slot', async () => {
      vi.useFakeTimers();
      try {
        scope = new PluginScope();
        scope.timer(() => {}, 100);
        expect(scope.getEffects()).toHaveLength(1);
        vi.advanceTimersByTime(150);
        await Promise.resolve();
        expect(scope.getEffects()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a fired one-shot frame releases its ledger slot', async () => {
      scope = new PluginScope();
      scope.frame(() => {});
      expect(scope.getEffects()).toHaveLength(1);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      expect(scope.getEffects()).toHaveLength(0);
    });
  });

  describe('getEffects', () => {
    it('lists live effect labels for leak inspection', async () => {
      scope = new PluginScope();
      scope.effect(() => () => {}, 'custom');
      scope.timer(() => {}, 50);
      expect(scope.getEffects()).toEqual(['custom', 'timer(50ms)']);
      await scope.dispose();
      expect(scope.getEffects()).toEqual([]);
    });
  });
});
