import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const observerScript = readFileSync(resolve(process.cwd(), 'public/usage-observer.js'), 'utf-8');
const NativeXMLHttpRequest = window.XMLHttpRequest;

type UsageWindow = Window &
  typeof globalThis & {
    __gvUsageObserverInstalled?: boolean;
    WIZ_global_data?: Record<string, string>;
  };

function installObserver(): void {
  // oxlint-disable-next-line no-eval -- evaluating the observer under test is what this suite exercises
  (0, eval)(observerScript);
}

function dispatchReplay(sourcePath: string): void {
  const event = new MessageEvent('message', {
    data: {
      source: 'gv-usage-observer-cmd',
      type: 'replay',
      payload: {
        id: 1,
        rpcid: 'jSf9Qc',
        args: '[]',
        sourcePath,
      },
    },
  });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

function dispatchPing(): void {
  const event = new MessageEvent('message', {
    data: { source: 'gv-usage-observer-cmd', type: 'ping' },
  });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

class MockXMLHttpRequest {
  public readonly addEventListener = vi.fn(
    (_type: string, _listener: EventListenerOrEventListenerObject) => {},
  );
  public readonly open = vi.fn();
  public readonly send = vi.fn();
}

describe('usage-observer replay', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();

    const usageWindow = window as UsageWindow;
    delete usageWindow.__gvUsageObserverInstalled;
    usageWindow.WIZ_global_data = {
      SNlM0e: 'at-token',
      cfb2h: 'bl-token',
      FdrFJe: 'fsid-token',
    };

    fetchMock = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue('[]'),
    });
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

  it('announces readiness and answers bridge pings', () => {
    installObserver();

    expect(postMessageSpy).toHaveBeenCalledWith(
      { source: 'gv-usage-observer', type: 'ready', payload: {} },
      window.location.origin,
    );

    postMessageSpy.mockClear();
    dispatchPing();

    expect(postMessageSpy).toHaveBeenCalledWith(
      { source: 'gv-usage-observer', type: 'ready', payload: {} },
      window.location.origin,
    );
  });

  it('replays multi-account usage requests against the account-scoped usage route', async () => {
    installObserver();

    dispatchReplay('/u/2/app');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe('/u/2/_/BardChatUi/data/batchexecute');
    expect(requestUrl.searchParams.get('source-path')).toBe('/u/2/usage');
  });

  it('replays default-account usage requests against /usage', async () => {
    installObserver();

    dispatchReplay('/app/some-conversation');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe('/_/BardChatUi/data/batchexecute');
    expect(requestUrl.searchParams.get('source-path')).toBe('/usage');
  });

  it('does not treat copy batchexecute traffic as generation when text mentions generation APIs', async () => {
    fetchMock.mockResolvedValue({
      clone: vi.fn(() => new Response('copy-ok')),
    });
    installObserver();

    await window.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=copyRpc', {
      method: 'POST',
      body: 'f.req=' + encodeURIComponent('BardFrontendService assistant.lamda'),
    });
    await Promise.resolve();

    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'gv-usage-observer', type: 'generation-complete' }),
      expect.any(String),
    );
  });

  it('does not treat copy XHR batchexecute traffic as generation', () => {
    Object.defineProperty(window, 'XMLHttpRequest', {
      value: MockXMLHttpRequest,
      writable: true,
      configurable: true,
    });
    installObserver();

    const xhr = new window.XMLHttpRequest() as unknown as MockXMLHttpRequest;
    xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=copyRpc');
    xhr.send('f.req=' + encodeURIComponent('BardFrontendService assistant.lamda'));

    expect(xhr.addEventListener).not.toHaveBeenCalledWith(
      'loadend',
      expect.any(Function),
      expect.anything(),
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'gv-usage-observer', type: 'generation-complete' }),
      expect.any(String),
    );
  });
});
