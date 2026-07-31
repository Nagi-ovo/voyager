import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scriptPath = resolve(process.cwd(), 'public/fetchInterceptor.js');
const interceptorScript = readFileSync(scriptPath, 'utf-8');
const BRIDGE_ID = 'gv-watermark-bridge';
const GEMINI_DOWNLOAD_URL = 'https://lh3.googleusercontent.com/rd-gg-dl/example=s512';
const GEMINI_DOWNLOAD_URL_NO_DL = 'https://lh3.googleusercontent.com/rd-gg/example=s512';
const GEMINI_DOWNLOAD_URL_NO_RD = 'https://lh3.googleusercontent.com/gg-dl/example=d-I?alr=yes';

function installInterceptor(): void {
  (0, eval)(interceptorScript);
}

function createEnabledBridge(): HTMLElement {
  const bridge = document.createElement('div');
  bridge.id = BRIDGE_ID;
  bridge.dataset.enabled = 'true';
  document.documentElement.appendChild(bridge);
  return bridge;
}

function createMockFetchResponse(body = 'ok', init: ResponseInit = { status: 200 }): Response {
  const response = new Response(body, init);
  vi.spyOn(response, 'blob').mockResolvedValue(new window.Blob([body]));
  return response;
}

async function waitForBridgeRequest(bridge: HTMLElement): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    if (bridge.dataset.request) {
      return bridge.dataset.request;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for bridge request');
}

describe('fetchInterceptor (MAIN world script)', () => {
  let originalFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    delete (window as Window & { __gvFetchInterceptorInstalled?: boolean })
      .__gvFetchInterceptorInstalled;

    document.documentElement.innerHTML = '';
    window.history.replaceState({}, '', '/app');

    originalFetch = vi.fn().mockImplementation(() => Promise.resolve(createMockFetchResponse()));
    Object.defineProperty(window, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    });
  });

  it('short-circuits known CSP-blocked GTM telemetry requests', async () => {
    installInterceptor();

    const response = await window.fetch('https://www.googletagmanager.com/td?id=G-TEST');

    expect(response.status).toBe(204);
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it('passes through non-target requests to original fetch', async () => {
    const originalFetch = vi.fn().mockResolvedValue(createMockFetchResponse());
    Object.defineProperty(window, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    });

    installInterceptor();

    const response = await window.fetch('https://example.com/api');

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('stays installed when a Notebook load later navigates back to chat', async () => {
    const bridge = createEnabledBridge();
    window.history.replaceState({}, '', '/notebook/example');
    installInterceptor();

    await window.fetch(GEMINI_DOWNLOAD_URL);
    expect(originalFetch).toHaveBeenNthCalledWith(1, GEMINI_DOWNLOAD_URL);
    expect(bridge.dataset.status).toBeUndefined();

    window.history.pushState({}, '', '/app');
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    const responsePromise = window.fetch(GEMINI_DOWNLOAD_URL);
    const requestData = JSON.parse(await waitForBridgeRequest(bridge)) as {
      requestId: string;
      base64: string;
    };
    bridge.dataset.response = JSON.stringify({
      requestId: requestData.requestId,
      base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
    });

    await responsePromise;
    expect(originalFetch).toHaveBeenNthCalledWith(
      2,
      'https://lh3.googleusercontent.com/rd-gg-dl/example=s0',
    );
    expect(bridge.dataset.status).toContain('"type":"SUCCESS"');
  });

  it('passes Gemini download-looking requests through until the user clicks download', async () => {
    const bridge = createEnabledBridge();
    installInterceptor();

    const response = await window.fetch(GEMINI_DOWNLOAD_URL);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(GEMINI_DOWNLOAD_URL);
    expect(response.status).toBe(200);
    expect(bridge.dataset.status).toBeUndefined();
  });

  it('uses the watermark pipeline for a recent user download intent', async () => {
    const bridge = createEnabledBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    bridge.dataset.downloadIntentToken = 'intent-1';
    installInterceptor();

    const responsePromise = window.fetch(GEMINI_DOWNLOAD_URL);
    const requestData = JSON.parse(await waitForBridgeRequest(bridge)) as {
      requestId: string;
      base64: string;
    };

    expect(requestData.base64).toMatch(/^data:/);
    bridge.dataset.response = JSON.stringify({
      requestId: requestData.requestId,
      base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
    });

    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(originalFetch).toHaveBeenNthCalledWith(
      1,
      'https://lh3.googleusercontent.com/rd-gg-dl/example=s0',
    );
    expect(bridge.dataset.downloadIntentExpiresAt).toBeUndefined();
    expect(JSON.parse(bridge.dataset.status ?? '{}')).toMatchObject({
      type: 'SUCCESS',
      intentToken: 'intent-1',
    });
  });

  it('uses the watermark pipeline for rd-gg/ URLs (without -dl suffix)', async () => {
    const bridge = createEnabledBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    installInterceptor();

    const responsePromise = window.fetch(GEMINI_DOWNLOAD_URL_NO_DL);
    const requestData = JSON.parse(await waitForBridgeRequest(bridge)) as {
      requestId: string;
      base64: string;
    };

    bridge.dataset.response = JSON.stringify({
      requestId: requestData.requestId,
      base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
    });

    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(originalFetch).toHaveBeenNthCalledWith(
      1,
      'https://lh3.googleusercontent.com/rd-gg/example=s0',
    );
    expect(bridge.dataset.status).toContain('"type":"SUCCESS"');
  });

  it('passes rd-gg/ requests through when no download intent is set (preview/auto-fetch)', async () => {
    const bridge = createEnabledBridge();
    installInterceptor();

    const response = await window.fetch(GEMINI_DOWNLOAD_URL_NO_DL);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(GEMINI_DOWNLOAD_URL_NO_DL);
    expect(response.status).toBe(200);
    expect(bridge.dataset.status).toBeUndefined();
  });

  it('passes gg-dl/ through (intermediate redirect-by-content step, not the real image)', async () => {
    const bridge = createEnabledBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    installInterceptor();

    const response = await window.fetch(GEMINI_DOWNLOAD_URL_NO_RD);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(GEMINI_DOWNLOAD_URL_NO_RD);
    expect(response.status).toBe(200);
    expect(bridge.dataset.status).toBeUndefined();
    // Intent must survive so the FINAL rd-gg-dl image fetch can still trigger removal.
    expect(bridge.dataset.downloadIntentExpiresAt).toBeDefined();
  });

  it('preserves =s0-d-I (already original + download flag) without rewriting', async () => {
    const bridge = createEnabledBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    installInterceptor();

    const url = 'https://lh3.googleusercontent.com/rd-gg-dl/example=s0-d-I?alr=yes';
    const responsePromise = window.fetch(url);
    const requestData = JSON.parse(await waitForBridgeRequest(bridge)) as {
      requestId: string;
      base64: string;
    };

    bridge.dataset.response = JSON.stringify({
      requestId: requestData.requestId,
      base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
    });

    await responsePromise;

    expect(originalFetch).toHaveBeenNthCalledWith(1, url);
  });

  it('preserves =sNNN-d-I size+flag by replacing the size only (keeps -d-I)', async () => {
    const bridge = createEnabledBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 1000);
    installInterceptor();

    const url = 'https://lh3.googleusercontent.com/rd-gg-dl/example=s512-d-I?alr=yes';
    const responsePromise = window.fetch(url);
    const requestData = JSON.parse(await waitForBridgeRequest(bridge)) as {
      requestId: string;
      base64: string;
    };

    bridge.dataset.response = JSON.stringify({
      requestId: requestData.requestId,
      base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
    });

    await responsePromise;

    expect(originalFetch).toHaveBeenNthCalledWith(
      1,
      'https://lh3.googleusercontent.com/rd-gg-dl/example=s0-d-I?alr=yes',
    );
  });
});
