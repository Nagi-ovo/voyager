import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startWatermarkRemover, stopWatermarkRemover } from '../index';
import { WatermarkEngine } from '../watermarkEngine';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
}));

vi.mock('../downloadButton', () => ({
  DOWNLOAD_ICON_SELECTOR: '.gv-test-download-icon',
  findNativeDownloadButton: (target: unknown) =>
    target instanceof HTMLButtonElement ? target : null,
}));

vi.mock('../watermarkEngine', () => ({
  WatermarkEngine: {
    create: vi.fn(),
  },
}));

const flushMutationObservers = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('watermarkRemover engine-init race', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    stopWatermarkRemover();
    vi.restoreAllMocks();
  });

  it('shows download indicators while WatermarkEngine.create is still pending', async () => {
    vi.useFakeTimers();
    try {
      let resolveEngine: (engine: unknown) => void = () => undefined;
      const enginePromise = new Promise<unknown>((resolve) => {
        resolveEngine = resolve;
      });
      (WatermarkEngine.create as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        enginePromise,
      );

      const existingHost = document.createElement('download-generated-image-button');
      existingHost.appendChild(document.createElement('button'));
      document.body.appendChild(existingHost);

      void startWatermarkRemover();
      await flushMutationObservers();

      expect(existingHost.querySelector('.nanobanana-indicator')).not.toBeNull();

      const lateHost = document.createElement('download-generated-image-button');
      lateHost.appendChild(document.createElement('button'));
      document.body.appendChild(lateHost);
      await flushMutationObservers();
      await vi.advanceTimersByTimeAsync(100);

      expect(lateHost.querySelector('.nanobanana-indicator')).not.toBeNull();

      resolveEngine({
        removeWatermarkFromImage: vi.fn(async () => document.createElement('canvas')),
      });
      await flushMutationObservers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('installs the bridge observer before WatermarkEngine.create resolves', async () => {
    // Simulates the scenario right after a /u/0/ → /u/1/ account switch:
    // content script re-injects, engine asset load takes time, user clicks
    // download during that window. Before the fix, the request landed on a
    // bridge with no observer and the MAIN-world interceptor sat for ~30s
    // waiting for a response that never came.
    let resolveEngine: (engine: unknown) => void = () => undefined;
    const enginePromise = new Promise<unknown>((resolve) => {
      resolveEngine = resolve;
    });
    (WatermarkEngine.create as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      enginePromise,
    );

    // Fire and forget — start the remover but do NOT await its completion;
    // engine creation is deferred via the mock above.
    void startWatermarkRemover();

    // Let synchronous setup finish (storage.get + setupFetchInterceptorBridge
    // both run BEFORE the engine await).
    await flushMutationObservers();

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement | null;
    expect(bridge).not.toBeNull();
    if (!bridge) return;

    // The observer signals "I'm alive" by removing data-request after reading it.
    // If observer isn't installed yet, the attribute would still be there.
    bridge.dataset.request = JSON.stringify({
      requestId: 'race-test',
      base64: 'data:image/png;base64,iVBORw0KGgo=',
    });
    await flushMutationObservers();

    expect(bridge.dataset.request).toBeUndefined();

    // Release the engine so any awaiting tasks can settle and Vitest doesn't
    // leak the unresolved promise into the next test.
    resolveEngine({
      removeWatermarkFromImage: vi.fn(async () => document.createElement('canvas')),
    });
    await flushMutationObservers();
  });
});
