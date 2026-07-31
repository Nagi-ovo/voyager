import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineCreate = vi.hoisted(() => vi.fn());
const fetchImageViaExtensionRuntime = vi.hoisted(() => vi.fn());

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
}));

vi.mock('@/core/utils/runtimeImageFetch', () => ({
  fetchImageViaExtensionRuntime,
}));

vi.mock('../downloadButton', () => ({
  DOWNLOAD_ICON_SELECTOR: '.gv-test-download-icon',
  findNativeDownloadButton: (target: unknown) =>
    target instanceof HTMLButtonElement ? target : null,
}));

vi.mock('../watermarkEngine', () => ({
  WatermarkEngine: {
    create: engineCreate,
  },
}));

type WatermarkRuntime = typeof import('../index');

const createDownloadHost = (): HTMLElement => {
  const host = document.createElement('download-generated-image-button');
  host.appendChild(document.createElement('button'));
  document.body.appendChild(host);
  return host;
};

const createPreviewImage = (): HTMLImageElement => {
  const host = document.createElement('generated-image');
  const image = document.createElement('img');
  image.src = 'https://lh3.googleusercontent.com/generated=s1024';
  host.appendChild(image);
  document.body.appendChild(host);
  return image;
};

const createProcessedCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'toBlob', {
    value: (callback: BlobCallback) => callback(new Blob(['processed'], { type: 'image/png' })),
    configurable: true,
  });
  return canvas;
};

const createEngine = () => ({
  removeWatermarkFromImage: vi.fn(async () => createProcessedCanvas()),
});

describe('watermarkRemover runtime toggle', () => {
  let settings: Record<string, unknown>;
  let runtime: WatermarkRuntime | null;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    settings = {
      gvWatermarkDownloadEnabled: false,
      gvWatermarkPreviewEnabled: false,
    };
    runtime = null;
    engineCreate.mockReset();
    fetchImageViaExtensionRuntime.mockReset();
    fetchImageViaExtensionRuntime.mockResolvedValue({
      base64: 'cHJldmlldy1pbWFnZQ==',
      contentType: 'image/png',
    });
    vi.stubGlobal(
      'Image',
      class AutoLoadingImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        crossOrigin = '';
        private currentSrc = '';

        get src(): string {
          return this.currentSrc;
        }

        set src(value: string) {
          this.currentSrc = value;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:processed-preview');
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,cHJvY2Vzc2Vk',
    );
    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({ ...settings }));
  });

  afterEach(() => {
    runtime?.stopWatermarkRemover();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconfigures the current page and reuses the initialized engine', async () => {
    engineCreate.mockResolvedValue(createEngine());
    runtime = await import('../index');
    const host = createDownloadHost();

    await runtime.startWatermarkRemover();
    expect(engineCreate).not.toHaveBeenCalled();

    settings.gvWatermarkPreviewEnabled = true;
    await runtime.restartWatermarkRemover();

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement | null;
    expect(bridge?.dataset.enabled).toBe('false');
    expect(host.querySelector('.nanobanana-indicator')).toBeNull();
    expect(engineCreate).toHaveBeenCalledTimes(1);

    settings.gvWatermarkPreviewEnabled = false;
    await runtime.restartWatermarkRemover();

    settings.gvWatermarkDownloadEnabled = true;
    await runtime.restartWatermarkRemover();

    expect(bridge?.dataset.enabled).toBe('true');
    expect(host.querySelector('.nanobanana-indicator')).not.toBeNull();
    expect(engineCreate).toHaveBeenCalledTimes(1);

    if (bridge) {
      bridge.dataset.downloadIntentExpiresAt = String(Date.now() + 60_000);
    }
    settings.gvWatermarkDownloadEnabled = false;
    await runtime.restartWatermarkRemover();

    expect(bridge?.dataset.enabled).toBe('false');
    expect(bridge?.dataset.downloadIntentExpiresAt).toBeUndefined();
    expect(host.querySelector('.nanobanana-indicator')).toBeNull();

    settings.gvWatermarkDownloadEnabled = true;
    await runtime.restartWatermarkRemover();

    expect(bridge?.dataset.enabled).toBe('true');
    expect(host.querySelector('.nanobanana-indicator')).not.toBeNull();
    expect(engineCreate).toHaveBeenCalledTimes(1);
  });

  it('clears delayed download feedback when the runtime stops', async () => {
    vi.useFakeTimers();
    try {
      engineCreate.mockResolvedValue(createEngine());
      runtime = await import('../index');
      const button = document.createElement('button');
      document.body.appendChild(button);

      settings.gvWatermarkDownloadEnabled = true;
      await runtime.startWatermarkRemover();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(document.querySelectorAll('.gv-status-toast')).toHaveLength(1);

      settings.gvWatermarkDownloadEnabled = false;
      await runtime.restartWatermarkRemover();

      expect(document.querySelectorAll('.gv-status-toast')).toHaveLength(0);
      const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement | null;
      expect(bridge?.dataset.downloadIntentExpiresAt).toBeUndefined();
      expect(bridge?.dataset.downloadIntentToken).toBeUndefined();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(document.querySelectorAll('.gv-status-toast')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an active download while only preview removal changes', async () => {
    engineCreate.mockResolvedValue(createEngine());
    runtime = await import('../index');
    const button = document.createElement('button');
    document.body.appendChild(button);

    settings.gvWatermarkDownloadEnabled = true;
    await runtime.startWatermarkRemover();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement;
    const intentExpiresAt = bridge.dataset.downloadIntentExpiresAt;
    const intentToken = bridge.dataset.downloadIntentToken;
    expect(intentExpiresAt).toBeDefined();
    expect(intentToken).toBeDefined();
    expect(document.querySelectorAll('.gv-status-toast')).toHaveLength(1);

    let resolveSettings: (value: Record<string, unknown>) => void = () => undefined;
    vi.mocked(chrome.storage.sync.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    settings.gvWatermarkPreviewEnabled = true;
    const restart = runtime.restartWatermarkRemover();

    // The download bridge must remain live while the preview reconfiguration
    // waits for storage; otherwise a request written in this window times out.
    bridge.dataset.request = JSON.stringify({
      requestId: 'request-during-preview-restart',
      base64: 'data:image/png;base64,b3JpZ2luYWw=',
    });
    await vi.waitFor(() =>
      expect(JSON.parse(bridge.dataset.response ?? '{}')).toMatchObject({
        requestId: 'request-during-preview-restart',
        base64: 'data:image/png;base64,cHJvY2Vzc2Vk',
      }),
    );

    resolveSettings({ ...settings });
    await restart;

    expect(bridge.dataset.enabled).toBe('true');
    expect(bridge.dataset.downloadIntentExpiresAt).toBe(intentExpiresAt);
    expect(bridge.dataset.downloadIntentToken).toBe(intentToken);
    expect(document.querySelectorAll('.gv-status-toast')).toHaveLength(1);
  });

  it('prevents a stale async start from restoring an older enabled mode', async () => {
    let resolveEngine: (engine: ReturnType<typeof createEngine>) => void = () => undefined;
    engineCreate.mockReturnValue(
      new Promise<ReturnType<typeof createEngine>>((resolveEnginePromise) => {
        resolveEngine = resolveEnginePromise;
      }),
    );
    runtime = await import('../index');
    const host = createDownloadHost();

    settings.gvWatermarkDownloadEnabled = true;
    const staleStart = runtime.startWatermarkRemover();
    await vi.waitFor(() => expect(engineCreate).toHaveBeenCalledTimes(1));

    settings.gvWatermarkDownloadEnabled = false;
    await runtime.restartWatermarkRemover();
    resolveEngine(createEngine());
    await staleStart;

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement | null;
    expect(bridge?.dataset.enabled).toBe('false');
    expect(host.querySelector('.nanobanana-indicator')).toBeNull();
  });

  it('does not write an in-flight preview result after preview removal is disabled', async () => {
    let resolveRemoval: (canvas: HTMLCanvasElement) => void = () => undefined;
    const removeWatermarkFromImage = vi.fn(
      () =>
        new Promise<HTMLCanvasElement>((resolveRemovalPromise) => {
          resolveRemoval = resolveRemovalPromise;
        }),
    );
    engineCreate.mockResolvedValue({ removeWatermarkFromImage });
    runtime = await import('../index');
    const image = createPreviewImage();
    const originalSrc = image.src;

    settings.gvWatermarkPreviewEnabled = true;
    await runtime.startWatermarkRemover();
    await vi.waitFor(() => expect(removeWatermarkFromImage).toHaveBeenCalledTimes(1));

    settings.gvWatermarkPreviewEnabled = false;
    await runtime.restartWatermarkRemover();
    resolveRemoval(createProcessedCanvas());

    await vi.waitFor(() => expect(image.dataset.watermarkProcessed).toBeUndefined());
    expect(image.src).toBe(originalSrc);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('retries stale preview work when the latest lifecycle still enables previews', async () => {
    let resolveFirstRemoval: (canvas: HTMLCanvasElement) => void = () => undefined;
    const removeWatermarkFromImage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<HTMLCanvasElement>((resolveRemovalPromise) => {
            resolveFirstRemoval = resolveRemovalPromise;
          }),
      )
      .mockResolvedValue(createProcessedCanvas());
    engineCreate.mockResolvedValue({ removeWatermarkFromImage });
    runtime = await import('../index');
    const image = createPreviewImage();

    settings.gvWatermarkPreviewEnabled = true;
    await runtime.startWatermarkRemover();
    await vi.waitFor(() => expect(removeWatermarkFromImage).toHaveBeenCalledTimes(1));

    settings.gvWatermarkDownloadEnabled = true;
    await runtime.restartWatermarkRemover();
    resolveFirstRemoval(createProcessedCanvas());

    await vi.waitFor(() => expect(removeWatermarkFromImage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(image.dataset.watermarkProcessed).toBe('true'));
    expect(image.src).toBe('blob:processed-preview');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('processes a replacement source after preview removal is re-enabled', async () => {
    const activeEngine = createEngine();
    engineCreate.mockResolvedValue(activeEngine);
    runtime = await import('../index');
    const image = createPreviewImage();

    settings.gvWatermarkPreviewEnabled = true;
    await runtime.startWatermarkRemover();
    await vi.waitFor(() => expect(image.dataset.watermarkProcessed).toBe('true'));

    const processedSrc = image.src;
    expect(image.dataset.watermarkOriginalSrc).toBe(
      'https://lh3.googleusercontent.com/generated=s1024',
    );
    expect(image.dataset.processedUrl).toBe('blob:processed-preview');

    settings.gvWatermarkPreviewEnabled = false;
    await runtime.restartWatermarkRemover();

    expect(image.src).toBe(processedSrc);
    expect(image.dataset.watermarkProcessed).toBeUndefined();
    expect(image.dataset.watermarkOriginalSrc).toBeUndefined();
    expect(image.dataset.processedUrl).toBeUndefined();

    image.src = 'https://lh3.googleusercontent.com/replacement=s1024';
    settings.gvWatermarkPreviewEnabled = true;
    await runtime.restartWatermarkRemover();

    await vi.waitFor(() => expect(activeEngine.removeWatermarkFromImage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(image.dataset.watermarkProcessed).toBe('true'));
    expect(image.dataset.watermarkOriginalSrc).toBe(
      'https://lh3.googleusercontent.com/replacement=s1024',
    );
  });

  it('wires sync watermark setting changes to the current-page restart', () => {
    const contentEntry = readFileSync(
      resolve(process.cwd(), 'src/pages/content/index.tsx'),
      'utf8',
    );

    expect(contentEntry).toContain('WATERMARK_STORAGE_KEYS.some');
    expect(contentEntry).toMatch(
      /watermarkRemoverStarted = true;\s+void startWatermarkRemover\(\);/,
    );
    expect(contentEntry).toMatch(
      /watermarkRemoverStarted &&\s+areaName === 'sync'[\s\S]*?void restartWatermarkRemover\(\);/,
    );
  });
});
