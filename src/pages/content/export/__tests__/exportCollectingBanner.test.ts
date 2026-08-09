import { describe, expect, it, vi } from 'vitest';

import { withExportCollectingBanner } from '../exportCollectingBanner';

describe('withExportCollectingBanner', () => {
  it('shows the banner and hides it after the task succeeds', async () => {
    const showBanner = vi.fn(() => vi.fn());
    const task = vi.fn(async () => 'result');

    const result = await withExportCollectingBanner(showBanner, task);

    expect(result).toBe('result');
    expect(showBanner).toHaveBeenCalledTimes(1);
    const hideBanner = showBanner.mock.results[0].value;
    expect(hideBanner).toHaveBeenCalledTimes(1);
  });

  it('hides the banner and rethrows when the task fails', async () => {
    const hideBanner = vi.fn();
    const showBanner = vi.fn(() => hideBanner);
    const error = new Error('collection failed');
    const task = vi.fn(async () => {
      throw error;
    });

    await expect(withExportCollectingBanner(showBanner, task)).rejects.toBe(error);

    expect(showBanner).toHaveBeenCalledTimes(1);
    expect(hideBanner).toHaveBeenCalledTimes(1);
  });

  it('hides the banner even when the task returns an empty result', async () => {
    const hideBanner = vi.fn();
    const showBanner = vi.fn(() => hideBanner);
    const task = vi.fn(async () => []);

    const result = await withExportCollectingBanner(showBanner, task);

    expect(result).toEqual([]);
    expect(showBanner).toHaveBeenCalledTimes(1);
    expect(hideBanner).toHaveBeenCalledTimes(1);
  });
});
