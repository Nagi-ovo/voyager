import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function dispatchObserverReady(): void {
  const event = new MessageEvent('message', {
    data: {
      source: 'gv-history-observer',
      type: 'ready',
      payload: { observerId: 'test-observer' },
    },
    origin: window.location.origin,
  });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

describe('usage observer loader history configuration', () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    document.querySelectorAll('script').forEach((script) => script.remove());
    postMessageSpy = vi
      .spyOn(window, 'postMessage')
      .mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
  });

  it('enables history capture independently of the timestamp UI setting', async () => {
    await import('../../usageObserverLoader');

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        source: 'gv-history-observer-cmd',
        type: 'configure',
        payload: { enabled: true },
      },
      window.location.origin,
    );
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it('repeats enabled configuration when the MAIN-world observer becomes ready', async () => {
    await import('../../usageObserverLoader');
    postMessageSpy.mockClear();

    dispatchObserverReady();

    expect(postMessageSpy).toHaveBeenLastCalledWith(
      {
        source: 'gv-history-observer-cmd',
        type: 'configure',
        payload: { enabled: true },
      },
      window.location.origin,
    );
  });

  it('does not DOM-inject observers in Chrome or Edge builds', async () => {
    const appendChild = vi.spyOn(document.documentElement, 'appendChild');

    await import('../../usageObserverLoader');

    expect(appendChild).not.toHaveBeenCalled();
  });

  it('retains ordered DOM injection as the Firefox compatibility fallback', async () => {
    const appendChild = vi.spyOn(document.documentElement, 'appendChild');
    const { injectObserverFallback } = await import('../../usageObserverLoader');

    injectObserverFallback('firefox');

    const injectedSources = appendChild.mock.calls
      .map(([node]) => (node as HTMLScriptElement).src)
      .filter((src) => src.includes('-observer.js'));
    expect(injectedSources).toEqual([
      'chrome-extension://test-extension-id/usage-observer.js',
      'chrome-extension://test-extension-id/conversation-history-observer.js',
    ]);
  });
});
