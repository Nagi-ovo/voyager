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

const createPixels = (value: number): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  return pixels;
};

describe('watermarkRemover corrupted download detection', () => {
  let runtime: WatermarkRuntime | null;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    runtime = null;

    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
      gvWatermarkDownloadEnabled: true,
      gvWatermarkPreviewEnabled: false,
    }));
    fetchImageViaExtensionRuntime.mockReset();
    fetchImageViaExtensionRuntime.mockResolvedValue({
      base64: 'cHJldmlldw==',
      contentType: 'image/png',
    });

    vi.stubGlobal(
      'Image',
      class AutoLoadingImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        crossOrigin = '';
        naturalWidth = 2048;
        naturalHeight = 2048;
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

    const previewPixels = createPixels(0);
    const corruptedDownloadPixels = createPixels(255);
    let drawnSource = '';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      return {
        drawImage: (image: { src?: string }) => {
          drawnSource = image.src ?? '';
        },
        getImageData: () => {
          if (drawnSource.startsWith('https://lh3.googleusercontent.com/')) {
            throw new DOMException('The canvas has been tainted', 'SecurityError');
          }
          return {
            data: drawnSource.includes('ZG93bmxvYWQ=') ? corruptedDownloadPixels : previewPixels,
          } as ImageData;
        },
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,cHJvY2Vzc2Vk',
    );

    engineCreate.mockReset();
    engineCreate.mockResolvedValue({
      removeWatermarkFromImage: vi.fn(async () => document.createElement('canvas')),
    });
  });

  afterEach(() => {
    runtime?.stopWatermarkRemover();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to extension fetch when Gemini preview taints the canvas', async () => {
    runtime = await import('../index');

    const host = document.createElement('generated-image');
    const preview = document.createElement('img');
    preview.src = 'https://lh3.googleusercontent.com/generated=s1024';
    const button = document.createElement('button');
    host.append(preview, button);
    document.body.appendChild(host);

    await runtime.startWatermarkRemover();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement;
    const intentToken = bridge.dataset.downloadIntentToken;
    bridge.dataset.request = JSON.stringify({
      requestId: 'corrupted-google-download',
      base64: 'data:image/png;base64,ZG93bmxvYWQ=',
      intentToken,
    });

    await vi.waitFor(() => {
      expect(JSON.parse(bridge.dataset.response ?? '{}')).toMatchObject({
        requestId: 'corrupted-google-download',
        corrupted: true,
      });
    });
    expect(fetchImageViaExtensionRuntime).toHaveBeenCalledWith(preview.src);
  });
});
