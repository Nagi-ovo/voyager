/**
 * PluginScope — the side-effect ledger for builtin (native-function) plugins.
 *
 * Every side effect a plugin creates (listener, observer, DOM node, timer,
 * injected style, network task) is registered through this scope and paid back
 * automatically, in reverse registration order, when the scope is disposed.
 * Plugins never hand-write teardown pairs; the host owns the ledger.
 *
 * Design cribbed from cordis (`fiber.effect`) with three deliberate cuts:
 * no Context proxy, no service dependency graph, no event bus. See
 * .github/docs/CORDIS_CTX_RESEARCH.md for the full rationale.
 *
 * Ledger semantics (each entry is claim-once):
 *  - An effect occupies its ledger slot at REGISTRATION time, even when its
 *    disposer arrives later from a Promise — so `dispose()` is a real barrier
 *    that awaits in-flight startup work, and teardown order always follows
 *    registration order, not settlement order.
 *  - Every entry is disposed exactly once, whether through the effect's own
 *    remover, `dispose()`, or a mid-flight cancellation — concurrent callers
 *    await the same settlement instead of re-running the disposer.
 *  - `signal` aborts when disposal begins; bind all cancellable work to it.
 *  - One failing disposer is logged and never blocks the rest.
 *  - Contract: a disposer must not await `scope.dispose()` (self-deadlock),
 *    and effects cannot be registered once disposal has begun.
 */
import { logger } from '@/core/services/LoggerService';

export type Dispose = () => void | Promise<void>;

type EffectResult = Dispose | Promise<Dispose> | Iterable<Dispose>;

/** chrome.* event objects (e.g. chrome.storage.onChanged) are not EventTargets. */
export interface ChromeEventLike<F extends (...args: never[]) => void> {
  addListener(listener: F): void;
  removeListener(listener: F): void;
}

const enum EntryState {
  /** Waiting for its Promise-borne disposer to arrive. */
  PENDING,
  /** Disposer present, not yet claimed. */
  LIVE,
  /** Some caller owns disposal; `settled` tracks completion. */
  CLAIMED,
  /** Disposer finished (or entry cancelled with nothing to run). */
  DONE,
}

class LedgerEntry {
  state = EntryState.LIVE;
  dispose: Dispose | null = null;
  /** Settlement of this entry's disposal once claimed. */
  settled: Promise<void> | null = null;
  /** Set when the entry is released (remover/dispose) while still PENDING. */
  cancelled = false;
  /** For PENDING entries: resolves when the startup promise has settled. */
  arrival: Promise<void> | null = null;

  constructor(public readonly label: string) {}
}

export class PluginScope {
  private readonly ledger: LedgerEntry[] = [];
  private readonly abort = new AbortController();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  /** Fire-and-forget cleanup work (mid-way rollbacks) the barrier must await. */
  private readonly looseEnds = new Set<Promise<void>>();

  /** Aborts when disposal begins. Bind fetches and cancellable loops to it. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Register a side effect. `run` performs the effect and returns its
   * disposer — directly, via a Promise, or as an iterable of several.
   * Throwing mid-way rolls back whatever was already collected. The returned
   * remover disposes just this effect, exactly once, however often called.
   */
  effect(run: () => EffectResult, label = 'anonymous'): Dispose {
    this.assertLive(label);
    const entries: LedgerEntry[] = [];
    try {
      const result = run();
      if (typeof result === 'function') {
        entries.push(this.addLiveEntry(label, result));
      } else if (result && typeof (result as Promise<Dispose>).then === 'function') {
        entries.push(this.addPendingEntry(label, result as Promise<Dispose>));
      } else if (result && Symbol.iterator in (result as Iterable<Dispose>)) {
        for (const dispose of result as Iterable<Dispose>) {
          if (typeof dispose !== 'function') throw new TypeError('Invalid effect disposer');
          entries.push(this.addLiveEntry(label, dispose));
        }
      } else if (result !== undefined && result !== null) {
        throw new TypeError('Invalid effect result');
      }
    } catch (error) {
      // Roll back whatever landed before the throw; the barrier awaits it.
      for (const entry of entries.splice(0).reverse()) {
        this.trackLooseEnd(this.release(entry));
      }
      throw error;
    }
    // `run` may have disposed the scope synchronously; nothing may outlive it.
    if (this.disposed) {
      for (const entry of entries.slice().reverse()) this.trackLooseEnd(this.release(entry));
    }
    return async () => {
      for (const entry of entries.slice().reverse()) {
        await this.release(entry);
      }
    };
  }

  /** Adopt an existing component's destroy() chain (e.g. a preview panel). */
  child(target: { destroy: () => void | Promise<void> }, label = 'child'): Dispose {
    return this.effect(() => () => target.destroy(), label);
  }

  /** addEventListener with automatic removal. Accepts DOM/window targets. */
  on<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): Dispose;
  on(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): Dispose;
  on(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): Dispose {
    return this.effect(() => {
      target.addEventListener(type, listener as EventListener, options);
      return () => target.removeEventListener(type, listener as EventListener, options);
    }, `on(${type})`);
  }

  /** chrome.*.onX.addListener with automatic removal. */
  onChromeEvent<F extends (...args: never[]) => void>(
    event: ChromeEventLike<F>,
    listener: F,
  ): Dispose {
    return this.effect(() => {
      event.addListener(listener);
      return () => event.removeListener(listener);
    }, 'onChromeEvent');
  }

  /** MutationObserver with automatic disconnect. */
  observe(target: Node, options: MutationObserverInit, callback: MutationCallback): Dispose {
    return this.effect(() => {
      const observer = new MutationObserver(callback);
      observer.observe(target, options);
      return () => observer.disconnect();
    }, 'observe');
  }

  /** Insert a DOM node with automatic removal. */
  mount(el: Element, parent: Element, anchor: Element | null = null): Dispose {
    return this.effect(() => {
      parent.insertBefore(el, anchor);
      return () => el.remove();
    }, `mount(<${el.tagName.toLowerCase()}>)`);
  }

  /** Inject a <style> element (gv- prefixed CSS) with automatic removal. */
  style(css: string, doc: Document = document): Dispose {
    return this.effect(() => {
      const el = doc.createElement('style');
      el.setAttribute('data-gv-plugin-scope', '');
      el.textContent = css;
      doc.head.appendChild(el);
      return () => el.remove();
    }, 'style');
  }

  /**
   * setTimeout / setInterval with automatic clearing. A one-shot timer
   * releases its ledger slot when it fires, so debounce-style repeated
   * scheduling never grows the ledger.
   */
  timer(fn: () => void, ms: number, options?: { repeat?: boolean }): Dispose {
    if (options?.repeat) {
      return this.effect(() => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      }, `timer(${ms}ms)`);
    }
    let release: Dispose | null = null;
    release = this.effect(() => {
      const id = setTimeout(() => {
        fn();
        void release?.();
      }, ms);
      return () => clearTimeout(id);
    }, `timer(${ms}ms)`);
    return release;
  }

  /**
   * requestAnimationFrame (one-shot or loop) with automatic cancel. A
   * one-shot frame releases its ledger slot after it runs.
   */
  frame(fn: FrameRequestCallback, options?: { repeat?: boolean }): Dispose {
    let release: Dispose | null = null;
    release = this.effect(() => {
      let id = 0;
      let stopped = false;
      const tick: FrameRequestCallback = (time) => {
        if (stopped) return;
        fn(time);
        if (options?.repeat && !stopped) id = requestAnimationFrame(tick);
        else if (!options?.repeat) void release?.();
      };
      id = requestAnimationFrame(tick);
      return () => {
        stopped = true;
        cancelAnimationFrame(id);
      };
    }, 'frame');
    return release;
  }

  /** Labels of currently live/pending effects, newest last. Leak inspection. */
  getEffects(): readonly string[] {
    return this.ledger
      .filter((entry) => entry.state === EntryState.PENDING || entry.state === EntryState.LIVE)
      .map((entry) => entry.label);
  }

  /**
   * Abort the signal, then settle every entry in reverse registration order.
   * A pending entry is awaited until its startup promise settles, so the
   * returned promise is a true barrier: when it resolves, nothing registered
   * through this scope is still alive or still starting. Idempotent.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    // Publish the settlement before running any foreign code (abort listeners
    // may re-enter dispose(); they must receive this same promise).
    let settle!: () => void;
    this.disposal = new Promise<void>((r) => (settle = r));
    void (async () => {
      try {
        this.abort.abort();
        for (const entry of this.ledger.slice().reverse()) {
          await this.release(entry);
        }
        await Promise.allSettled(this.looseEnds);
      } finally {
        settle();
      }
    })();
    return this.disposal;
  }

  private assertLive(label: string): void {
    if (this.disposed) {
      throw new Error(`PluginScope is disposed; cannot register effect "${label}"`);
    }
  }

  private addLiveEntry(label: string, dispose: Dispose): LedgerEntry {
    const entry = new LedgerEntry(label);
    entry.dispose = dispose;
    this.ledger.push(entry);
    return entry;
  }

  private addPendingEntry(label: string, promise: Promise<Dispose>): LedgerEntry {
    const entry = new LedgerEntry(label);
    entry.state = EntryState.PENDING;
    this.ledger.push(entry);
    entry.arrival = promise.then(
      (dispose) => {
        if (typeof dispose !== 'function') {
          if (entry.state === EntryState.PENDING) this.finish(entry);
          return;
        }
        if (entry.cancelled || this.disposed) {
          // Released (or scope died) before startup finished: pay immediately.
          entry.state = EntryState.CLAIMED;
          entry.settled = this.runDisposer(entry.label, dispose);
          return entry.settled.then(() => this.finish(entry));
        }
        entry.dispose = dispose;
        entry.state = EntryState.LIVE;
      },
      (error) => {
        if (entry.state === EntryState.PENDING) this.finish(entry);
        logger.error('PluginScope effect failed', { label, error: String(error) });
      },
    );
    return entry;
  }

  /**
   * Settle one entry, exactly once. Concurrent callers share the settlement.
   * A PENDING entry is cancelled and awaited until its arrival chain has run
   * (and paid) the late disposer.
   */
  private release(entry: LedgerEntry): Promise<void> {
    switch (entry.state) {
      case EntryState.DONE:
        return entry.settled ?? Promise.resolve();
      case EntryState.CLAIMED:
        return entry.settled ?? Promise.resolve();
      case EntryState.PENDING:
        entry.cancelled = true;
        return entry.arrival ?? Promise.resolve();
      case EntryState.LIVE: {
        const dispose = entry.dispose!;
        entry.state = EntryState.CLAIMED;
        entry.settled = this.runDisposer(entry.label, dispose).then(() => this.finish(entry));
        return entry.settled;
      }
    }
  }

  /** Mark an entry settled and physically drop it so the ledger stays bounded. */
  private finish(entry: LedgerEntry): void {
    entry.state = EntryState.DONE;
    const index = this.ledger.indexOf(entry);
    if (index >= 0) this.ledger.splice(index, 1);
  }

  private trackLooseEnd(work: Promise<void>): void {
    this.looseEnds.add(work);
    void work.finally(() => this.looseEnds.delete(work));
  }

  private async runDisposer(label: string, dispose: Dispose): Promise<void> {
    try {
      await dispose();
    } catch (error) {
      logger.error('PluginScope disposer failed', { label, error: String(error) });
    }
  }
}
