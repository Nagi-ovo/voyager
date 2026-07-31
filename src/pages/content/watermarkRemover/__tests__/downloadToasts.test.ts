import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startWatermarkRemover, stopWatermarkRemover } from '../index';

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
    create: vi.fn(async () => ({
      removeWatermarkFromImage: vi.fn(async () => document.createElement('canvas')),
    })),
  },
}));

const flushMutationObservers = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('watermarkRemover download toasts', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopWatermarkRemover();
    vi.useRealTimers();
  });

  it('does not show large file warning until DOWNLOADING_LARGE arrives', async () => {
    await startWatermarkRemover();

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const toastsBefore = document.querySelectorAll('.gv-status-toast');
    expect(toastsBefore.length).toBeGreaterThan(0);
    expect([...toastsBefore].some((toast) => toast.textContent === '大文件警告')).toBe(false);

    const bridge = document.getElementById('gv-watermark-bridge');
    expect(bridge).not.toBeNull();
    if (!bridge) return;
    const intentTtlMs =
      Number((bridge as HTMLElement).dataset.downloadIntentExpiresAt) - Date.now();
    expect(intentTtlMs).toBeGreaterThanOrEqual(59000);
    expect(intentTtlMs).toBeLessThanOrEqual(60000);

    (bridge as HTMLElement).dataset.status = JSON.stringify({
      type: 'DOWNLOADING_LARGE',
      intentToken: (bridge as HTMLElement).dataset.downloadIntentToken,
    });
    await flushMutationObservers();

    const toastsAfter = document.querySelectorAll('.gv-status-toast');
    expect([...toastsAfter].some((toast) => toast.textContent === '大文件警告')).toBe(true);

    vi.advanceTimersByTime(8000);
    const toastsFinal = document.querySelectorAll('.gv-status-toast');
    expect([...toastsFinal].some((toast) => toast.textContent === '大文件警告')).toBe(false);
  });

  it('ignores a late status from an older download sequence', async () => {
    await startWatermarkRemover();

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const bridge = document.getElementById('gv-watermark-bridge') as HTMLElement;
    bridge.dataset.status = JSON.stringify({
      type: 'SUCCESS',
      intentToken: 'stale-download-token',
    });
    await flushMutationObservers();

    const toasts = [...document.querySelectorAll('.gv-status-toast')];
    expect(toasts.some((toast) => toast.textContent === '正在下载原始图片')).toBe(true);
    expect(toasts.some((toast) => toast.textContent === '正在下载')).toBe(false);
  });
});
