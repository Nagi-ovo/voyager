import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineCreate = vi.hoisted(() => vi.fn());

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

const createEngine = () => ({
  removeWatermarkFromImage: vi.fn(async () => document.createElement('canvas')),
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
    vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({ ...settings }));
  });

  afterEach(() => {
    runtime?.stopWatermarkRemover();
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

  it('wires sync watermark setting changes to the current-page restart', () => {
    const contentEntry = readFileSync(
      resolve(process.cwd(), 'src/pages/content/index.tsx'),
      'utf8',
    );

    expect(contentEntry).toContain('WATERMARK_STORAGE_KEYS.some');
    expect(contentEntry).toContain('void restartWatermarkRemover();');
  });
});
