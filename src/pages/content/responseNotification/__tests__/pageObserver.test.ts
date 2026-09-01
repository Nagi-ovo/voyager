import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scriptPath = resolve(process.cwd(), 'public/response-complete-observer.js');
const observerScript = readFileSync(scriptPath, 'utf-8');
const SOURCE = 'gemini-voyager-response-complete-observer';
const NativeXMLHttpRequest = window.XMLHttpRequest;

function installObserver(): void {
  // oxlint-disable-next-line no-eval -- evaluating the observer under test is what this suite exercises
  (0, eval)(observerScript);
}

function createResponseWithCloneSpy(): Response & { cloneSpy: ReturnType<typeof vi.fn> } {
  const cloneResponse = new Response('clone-ok');
  const response = new Response('ok') as Response & { cloneSpy: ReturnType<typeof vi.fn> };
  response.cloneSpy = vi.fn(() => cloneResponse);
  Object.defineProperty(response, 'clone', {
    value: response.cloneSpy,
    configurable: true,
  });
  return response;
}

class MockXMLHttpRequest {
  public readonly addEventListener = vi.fn(
    (_type: string, _listener: EventListenerOrEventListenerObject) => {},
  );
  public readonly open = vi.fn();
  public readonly send = vi.fn();
}

describe('response-complete-observer page script', () => {
  let originalFetch: ReturnType<typeof vi.fn>;
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { __gvResponseCompleteObserverInstalled?: boolean })
      .__gvResponseCompleteObserverInstalled;

    originalFetch = vi.fn();
    Object.defineProperty(window, 'fetch', {
      value: originalFetch,
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

  it('ignores non-generation batchexecute requests such as native Copy Response', async () => {
    const response = createResponseWithCloneSpy();
    originalFetch.mockResolvedValue(response);
    installObserver();

    await window.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=copyRpc', {
      method: 'POST',
      body: 'f.req=%5B%5B%5B%22copyRpc%22%2C%22%5B%5D%22%2Cnull%2C%22generic%22%5D%5D%5D',
    });

    expect(response.cloneSpy).not.toHaveBeenCalled();
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: SOURCE, type: 'request-start' }),
      expect.any(String),
    );
  });

  it('ignores native Copy Response even when copied text mentions generation APIs', async () => {
    const response = createResponseWithCloneSpy();
    originalFetch.mockResolvedValue(response);
    installObserver();

    const copyArgs = JSON.stringify([
      [
        [
          'copyRpc',
          JSON.stringify([
            'This answer mentions generateContent, BardFrontendService, and assistant.lamda.',
          ]),
          null,
          'generic',
        ],
      ],
    ]);

    await window.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=copyRpc', {
      method: 'POST',
      body: `f.req=${encodeURIComponent(copyArgs)}`,
    });

    expect(response.cloneSpy).not.toHaveBeenCalled();
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: SOURCE, type: 'request-start' }),
      expect.any(String),
    );
  });

  it('ignores Copy Response XHR batchexecute requests with generation-looking body text', () => {
    Object.defineProperty(window, 'XMLHttpRequest', {
      value: MockXMLHttpRequest,
      writable: true,
      configurable: true,
    });
    installObserver();

    const xhr = new window.XMLHttpRequest() as unknown as MockXMLHttpRequest;
    xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=copyRpc');
    xhr.send('f.req=' + encodeURIComponent('generateContent BardFrontendService assistant.lamda'));

    expect(xhr.addEventListener).not.toHaveBeenCalledWith(
      'loadend',
      expect.any(Function),
      expect.anything(),
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: SOURCE, type: 'request-start' }),
      expect.any(String),
    );
  });

  it('tracks explicit Gemini generation requests', async () => {
    const response = createResponseWithCloneSpy();
    originalFetch.mockResolvedValue(response);
    installObserver();

    await window.fetch('https://gemini.google.com/_/BardChatUi/data/StreamGenerate', {
      method: 'POST',
    });
    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ source: SOURCE, type: 'request-complete' }),
        expect.any(String),
      );
    });

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: SOURCE, type: 'request-start' }),
      expect.any(String),
    );
    expect(response.cloneSpy).toHaveBeenCalledTimes(1);
  });
});
