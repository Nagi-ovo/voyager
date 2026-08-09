import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBoundedExportImage, mapWithConcurrency } from '../boundedImageFetch';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bounded export image fetching', () => {
  it('omits credentials for cross-origin images', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['png'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const result = await fetchBoundedExportImage('https://example.com/image.png', {
      remainingBytes: 1024,
    });

    expect(result?.contentType).toBe('image/png');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/image.png',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('rejects non-image responses and blobs larger than the remaining budget', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('html', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      )
      .mockResolvedValueOnce(
        new Response(new Blob(['too large'], { type: 'image/png' }), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );

    await expect(
      fetchBoundedExportImage('https://example.com/not-image', { remainingBytes: 1024 }),
    ).resolves.toBeNull();
    await expect(
      fetchBoundedExportImage('https://example.com/large.png', { remainingBytes: 2 }),
    ).resolves.toBeNull();
  });

  it('caps concurrent work', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
