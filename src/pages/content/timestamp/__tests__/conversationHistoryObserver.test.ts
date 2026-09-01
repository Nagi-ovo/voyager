import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observerScript = readFileSync(
  resolve(process.cwd(), 'public/conversation-history-observer.js'),
  'utf-8',
);
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf-8')) as {
  web_accessible_resources?: Array<{ resources?: string[] }>;
};
const NativeXMLHttpRequest = window.XMLHttpRequest;
const HISTORY_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb';

type HistoryObserverWindow = Window &
  typeof globalThis & {
    __gvHistoryObserverInstalled?: boolean;
  };

function installObserver(limits?: {
  count?: number;
  captureBytes?: number;
  bufferBytes?: number;
}): void {
  let source = observerScript;
  if (limits?.count !== undefined) {
    source = source.replace('var MAX_BUFFER_COUNT = 4;', `var MAX_BUFFER_COUNT = ${limits.count};`);
  }
  if (limits?.captureBytes !== undefined) {
    source = source.replace(
      'var MAX_CAPTURE_BYTES = 16 * 1024 * 1024;',
      `var MAX_CAPTURE_BYTES = ${limits.captureBytes};`,
    );
  }
  if (limits?.bufferBytes !== undefined) {
    source = source.replace(
      'var MAX_BUFFER_BYTES = 24 * 1024 * 1024;',
      `var MAX_BUFFER_BYTES = ${limits.bufferBytes};`,
    );
  }
  // oxlint-disable-next-line no-eval -- evaluating the observer under test is what this suite exercises
  (0, eval)(source);
}

function dispatchCommand(type: 'configure' | 'flush' | 'ack', payload?: unknown): void {
  const event = new MessageEvent('message', {
    data: { source: 'gv-history-observer-cmd', type, payload },
    origin: window.location.origin,
  });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

function responseWithBody(body: string, text = vi.fn().mockResolvedValue(body)) {
  return {
    clone: vi.fn(() => ({ text })),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('conversation history observer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as HistoryObserverWindow).__gvHistoryObserverInstalled;
    fetchMock = vi.fn();
    Object.defineProperty(window, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'XMLHttpRequest', {
      value: NativeXMLHttpRequest,
      writable: true,
      configurable: true,
    });
    postMessageSpy = vi
      .spyOn(window, 'postMessage')
      .mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
    delete (window as HistoryObserverWindow).__gvHistoryObserverInstalled;
    Object.defineProperty(window, 'XMLHttpRequest', {
      value: NativeXMLHttpRequest,
      writable: true,
      configurable: true,
    });
  });

  it('announces readiness after installing its command bridge', () => {
    installObserver();

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        source: 'gv-history-observer',
        type: 'ready',
        payload: { observerId: expect.any(String) },
      },
      window.location.origin,
    );
  });

  it('ships the observer as a web-accessible page-world resource', () => {
    const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources ?? []);
    expect(resources).toContain('conversation-history-observer.js');
  });

  it('returns the original fetch promise and captures once when enabled', async () => {
    const response = responseWithBody('history-body');
    const originalPromise = Promise.resolve(response);
    fetchMock.mockReturnValue(originalPromise);
    installObserver();
    dispatchCommand('configure', { enabled: true });

    const returned = window.fetch(HISTORY_URL);
    expect(returned).toBe(originalPromise);
    await flushPromises();

    expect(response.clone).toHaveBeenCalledTimes(1);
    const captures = postMessageSpy.mock.calls.filter(
      ([message]) => message?.source === 'gv-history-observer' && message?.type === 'capture',
    );
    expect(captures).toHaveLength(1);
    expect(captures[0][0].payload).toMatchObject({
      id: expect.stringContaining(':'),
      url: HISTORY_URL,
      body: 'history-body',
    });
  });

  it('does not clone a response when disabled before it resolves', async () => {
    let resolveResponse: ((response: ReturnType<typeof responseWithBody>) => void) | null = null;
    const responsePromise = new Promise<ReturnType<typeof responseWithBody>>((resolvePromise) => {
      resolveResponse = resolvePromise;
    });
    const response = responseWithBody('history-body');
    fetchMock.mockReturnValue(responsePromise);
    installObserver();

    window.fetch(HISTORY_URL);
    dispatchCommand('configure', { enabled: false });
    resolveResponse!(response);
    await flushPromises();

    expect(response.clone).not.toHaveBeenCalled();
    expect(
      postMessageSpy.mock.calls.filter(([, target]) => target === window.location.origin),
    ).not.toContainEqual([
      expect.objectContaining({ source: 'gv-history-observer', type: 'capture' }),
      window.location.origin,
    ]);
  });

  it('allows at most one response read while the setting is unresolved', async () => {
    const first = responseWithBody('first');
    const second = responseWithBody('second');
    fetchMock
      .mockReturnValueOnce(Promise.resolve(first))
      .mockReturnValueOnce(Promise.resolve(second));
    installObserver();

    window.fetch(HISTORY_URL);
    window.fetch(HISTORY_URL);
    await flushPromises();

    expect(first.clone).toHaveBeenCalledTimes(1);
    expect(second.clone).not.toHaveBeenCalled();
  });

  it('drops an in-flight body when disabled before text resolves', async () => {
    let resolveText: ((body: string) => void) | null = null;
    const textPromise = new Promise<string>((resolvePromise) => {
      resolveText = resolvePromise;
    });
    const text = vi.fn(() => textPromise);
    const response = responseWithBody('ignored', text);
    fetchMock.mockReturnValue(Promise.resolve(response));
    installObserver();
    dispatchCommand('configure', { enabled: true });

    window.fetch(HISTORY_URL);
    await Promise.resolve();
    expect(text).toHaveBeenCalledTimes(1);
    dispatchCommand('configure', { enabled: false });
    resolveText!('late-history-body');
    await flushPromises();

    expect(
      postMessageSpy.mock.calls.some(
        ([message]) => message?.source === 'gv-history-observer' && message?.type === 'capture',
      ),
    ).toBe(false);
  });

  it('replays only unacknowledged captures', async () => {
    const response = responseWithBody('history-body');
    fetchMock.mockReturnValue(Promise.resolve(response));
    installObserver();
    dispatchCommand('configure', { enabled: true });
    window.fetch(HISTORY_URL);
    await flushPromises();

    const firstCapture = postMessageSpy.mock.calls.find(
      ([message]) => message?.source === 'gv-history-observer' && message?.type === 'capture',
    )?.[0];
    expect(firstCapture).toBeDefined();

    postMessageSpy.mockClear();
    dispatchCommand('flush');
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0].payload.id).toBe(firstCapture.payload.id);

    dispatchCommand('ack', { id: firstCapture.payload.id });
    postMessageSpy.mockClear();
    dispatchCommand('flush');
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('enforces the capture count independently of the byte limit', async () => {
    installObserver({ count: 2, captureBytes: 1_000, bufferBytes: 1_000 });
    dispatchCommand('configure', { enabled: true });

    for (const body of ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)]) {
      fetchMock.mockReturnValueOnce(Promise.resolve(responseWithBody(body)));
      window.fetch(HISTORY_URL);
      await flushPromises();
    }

    postMessageSpy.mockClear();
    dispatchCommand('flush');
    const replayedBodies = postMessageSpy.mock.calls.map(([message]) => message.payload.body);
    expect(replayedBodies).toEqual(['b'.repeat(20), 'c'.repeat(20)]);
  });

  it('enforces total and per-capture byte limits independently', async () => {
    installObserver({ count: 10, captureBytes: 80, bufferBytes: 100 });
    dispatchCommand('configure', { enabled: true });

    for (const body of ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)]) {
      fetchMock.mockReturnValueOnce(Promise.resolve(responseWithBody(body)));
      window.fetch(HISTORY_URL);
      await flushPromises();
    }

    postMessageSpy.mockClear();
    dispatchCommand('flush');
    expect(postMessageSpy.mock.calls.map(([message]) => message.payload.body)).toEqual([
      'b'.repeat(20),
      'c'.repeat(20),
    ]);

    postMessageSpy.mockClear();
    fetchMock.mockReturnValueOnce(Promise.resolve(responseWithBody('x'.repeat(41))));
    window.fetch(HISTORY_URL);
    await flushPromises();
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('clears buffered bodies when disabled and captures again after re-enable', async () => {
    installObserver();
    dispatchCommand('configure', { enabled: true });
    fetchMock.mockReturnValueOnce(Promise.resolve(responseWithBody('before-disable')));
    window.fetch(HISTORY_URL);
    await flushPromises();

    dispatchCommand('configure', { enabled: false });
    postMessageSpy.mockClear();
    dispatchCommand('flush');
    expect(postMessageSpy).not.toHaveBeenCalled();

    dispatchCommand('configure', { enabled: true });
    fetchMock.mockReturnValueOnce(Promise.resolve(responseWithBody('after-enable')));
    window.fetch(HISTORY_URL);
    await flushPromises();
    expect(
      postMessageSpy.mock.calls.some(
        ([message]) => message?.type === 'capture' && message?.payload?.body === 'after-enable',
      ),
    ).toBe(true);
  });

  it('captures matching XHR responses and accepts URL objects', () => {
    class MockXMLHttpRequest {
      responseType = '';
      responseText = 'xhr-history-body';
      private loadListener: (() => void) | null = null;
      open = vi.fn();
      send = vi.fn(() => this.loadListener?.());
      addEventListener = vi.fn((type: string, listener: () => void) => {
        if (type === 'load') this.loadListener = listener;
      });
    }
    Object.defineProperty(window, 'XMLHttpRequest', {
      value: MockXMLHttpRequest,
      writable: true,
      configurable: true,
    });
    installObserver();
    dispatchCommand('configure', { enabled: true });

    const xhr = new window.XMLHttpRequest();
    xhr.open('POST', new URL(HISTORY_URL));
    xhr.send();

    expect(
      postMessageSpy.mock.calls.some(
        ([message]) => message?.type === 'capture' && message?.payload?.body === 'xhr-history-body',
      ),
    ).toBe(true);
  });
});
