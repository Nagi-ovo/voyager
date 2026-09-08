import { vi } from 'vitest';

/**
 * Test-only ledger of everything a content module can leave behind on the
 * page: listeners on the long-lived targets (window, document, html, body),
 * DOM observers, `chrome.storage.onChanged` and `chrome.runtime.onMessage`
 * subscriptions. Timers are the caller's business through `vi.useFakeTimers`.
 *
 * `chrome.storage` is replaced by an in-memory implementation that answers
 * both callback and promise styles, so modules that read settings at start
 * actually run instead of hanging on a `vi.fn()` that never calls back.
 */

type Listener = (...args: never[]) => unknown;
type StorageArea = 'sync' | 'local';
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

interface ObserverLike {
  observe(...args: never[]): void;
  disconnect(): void;
}

export interface LifecycleLedger {
  /** Listener registrations on window/document/html/body not yet removed. */
  openListeners(): string[];
  /** Observers that called `observe` and never `disconnect`. */
  openObservers(): string[];
  openStorageListeners(): number;
  openRuntimeListeners(): number;
  /** Everything registered since the harness (or `resetActivity`) started, removed or not. */
  activity(): number;
  resetActivity(): void;
}

export interface LifecycleHarness {
  readonly ledger: LifecycleLedger;
  readonly storage: Record<StorageArea, Map<string, unknown>>;
  emitStorageChange(changes: StorageChanges, areaName: StorageArea): void;
  restore(): void;
}

function pickTarget(target: EventTarget): string | null {
  if (target === window) return 'window';
  if (target === document) return 'document';
  if (target === document.documentElement) return 'html';
  if (target === document.body) return 'body';
  return null;
}

function captureFlag(options: boolean | AddEventListenerOptions | undefined): string {
  const capture = typeof options === 'boolean' ? options : options?.capture === true;
  return capture ? 'capture' : 'bubble';
}

function readKeys(keys: unknown, store: Map<string, unknown>): Record<string, unknown> {
  if (keys === null || keys === undefined) return Object.fromEntries(store);
  if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
  if (Array.isArray(keys)) {
    return Object.fromEntries(
      keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)]),
    );
  }
  if (typeof keys === 'object') {
    return Object.fromEntries(
      Object.entries(keys as Record<string, unknown>).map(([key, fallback]) => [
        key,
        store.has(key) ? store.get(key) : fallback,
      ]),
    );
  }
  return {};
}

export function installLifecycleHarness(): LifecycleHarness {
  const listenerCounts = new Map<string, number>();
  const listenerIds = new WeakMap<object, number>();
  let nextListenerId = 1;
  let activity = 0;

  const idFor = (listener: object): number => {
    let id = listenerIds.get(listener);
    if (id === undefined) {
      id = nextListenerId++;
      listenerIds.set(listener, id);
    }
    return id;
  };

  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const name = pickTarget(this);
    if (name && listener) {
      activity += 1;
      const key = `${name}:${type}:${captureFlag(options)}:#${idFor(listener)}`;
      listenerCounts.set(key, (listenerCounts.get(key) ?? 0) + 1);
    }
    return originalAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    const name = pickTarget(this);
    if (name && listener) {
      const key = `${name}:${type}:${captureFlag(options)}:#${idFor(listener)}`;
      const count = listenerCounts.get(key) ?? 0;
      if (count <= 1) listenerCounts.delete(key);
      else listenerCounts.set(key, count - 1);
    }
    return originalRemove.call(this, type, listener, options);
  };

  // Observers: wrap the real MutationObserver; stub the layout observers jsdom lacks.
  const openObservers = new Map<object, string>();
  const OriginalMutationObserver = globalThis.MutationObserver;
  class TrackedMutationObserver extends OriginalMutationObserver {
    observe(target: Node, options?: MutationObserverInit): void {
      activity += 1;
      openObservers.set(this, 'MutationObserver');
      super.observe(target, options);
    }
    disconnect(): void {
      openObservers.delete(this);
      super.disconnect();
    }
  }
  const makeLayoutObserver = (name: string) =>
    class implements ObserverLike {
      constructor(_callback: unknown) {}
      observe(): void {
        activity += 1;
        openObservers.set(this, name);
      }
      unobserve(): void {}
      disconnect(): void {
        openObservers.delete(this);
      }
      takeRecords(): unknown[] {
        return [];
      }
    };
  const originalResize = globalThis.ResizeObserver;
  const originalIntersection = globalThis.IntersectionObserver;
  globalThis.MutationObserver = TrackedMutationObserver;
  globalThis.ResizeObserver = makeLayoutObserver(
    'ResizeObserver',
  ) as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = makeLayoutObserver(
    'IntersectionObserver',
  ) as unknown as typeof IntersectionObserver;

  // chrome.storage: in-memory areas, tracked onChanged subscriptions.
  const storage: Record<StorageArea, Map<string, unknown>> = { sync: new Map(), local: new Map() };
  const storageListeners = new Set<Listener>();
  const runtimeListeners = new Set<Listener>();
  const previous = {
    sync: { ...chrome.storage.sync },
    local: { ...chrome.storage.local },
    onChanged: { ...chrome.storage.onChanged },
    onMessage: { ...chrome.runtime.onMessage },
    sendMessage: chrome.runtime.sendMessage,
  };

  const mockArea = (area: StorageArea): void => {
    const store = storage[area];
    const target = chrome.storage[area] as unknown as Record<string, unknown>;
    const settle = <T>(value: T, callback: unknown): Promise<T> => {
      if (typeof callback === 'function') callback(value);
      return Promise.resolve(value);
    };
    target.get = vi.fn((keys: unknown, callback?: unknown) =>
      settle(readKeys(keys, store), callback),
    );
    target.set = vi.fn((items: Record<string, unknown>, callback?: unknown) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
      return settle(undefined, callback);
    });
    target.remove = vi.fn((keys: string | string[], callback?: unknown) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      return settle(undefined, callback);
    });
    target.clear = vi.fn((callback?: unknown) => {
      store.clear();
      return settle(undefined, callback);
    });
    target.getBytesInUse = vi.fn((_keys: unknown, callback?: unknown) => settle(0, callback));
  };
  mockArea('sync');
  mockArea('local');

  const onChanged = chrome.storage.onChanged as unknown as Record<string, unknown>;
  onChanged.addListener = vi.fn((listener: Listener) => {
    activity += 1;
    storageListeners.add(listener);
  });
  onChanged.removeListener = vi.fn((listener: Listener) => {
    storageListeners.delete(listener);
  });
  onChanged.hasListener = vi.fn((listener: Listener) => storageListeners.has(listener));

  const onMessage = chrome.runtime.onMessage as unknown as Record<string, unknown>;
  onMessage.addListener = vi.fn((listener: Listener) => {
    activity += 1;
    runtimeListeners.add(listener);
  });
  onMessage.removeListener = vi.fn((listener: Listener) => {
    runtimeListeners.delete(listener);
  });
  onMessage.hasListener = vi.fn((listener: Listener) => runtimeListeners.has(listener));
  (chrome.runtime as unknown as Record<string, unknown>).sendMessage = vi.fn(
    (_message: unknown, callback?: unknown) => {
      if (typeof callback === 'function') callback(undefined);
      return Promise.resolve(undefined);
    },
  );

  const ledger: LifecycleLedger = {
    openListeners: () => [...listenerCounts.keys()].sort(),
    openObservers: () => [...openObservers.values()].sort(),
    openStorageListeners: () => storageListeners.size,
    openRuntimeListeners: () => runtimeListeners.size,
    activity: () => activity,
    resetActivity: () => {
      activity = 0;
    },
  };

  return {
    ledger,
    storage,
    emitStorageChange(changes, areaName) {
      for (const listener of storageListeners) {
        (listener as (changes: StorageChanges, areaName: string) => void)(changes, areaName);
      }
    },
    restore() {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      globalThis.MutationObserver = OriginalMutationObserver;
      globalThis.ResizeObserver = originalResize;
      globalThis.IntersectionObserver = originalIntersection;
      Object.assign(chrome.storage.sync, previous.sync);
      Object.assign(chrome.storage.local, previous.local);
      Object.assign(chrome.storage.onChanged, previous.onChanged);
      Object.assign(chrome.runtime.onMessage, previous.onMessage);
      (chrome.runtime as unknown as Record<string, unknown>).sendMessage = previous.sendMessage;
    },
  };
}
