import { describe, expect, it } from 'vitest';

import {
  createImageHealthFingerprint,
  detectCorruptedGeminiDownload,
} from '../imageHealthDetector';

const SIZE = 32;

function createSample(
  pixel: (x: number, y: number) => readonly [number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = (y * SIZE + x) * 4;
      const [red, green, blue] = pixel(x, y);
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
  return data;
}

describe('Gemini download health detector', () => {
  it('accepts the same image with small resize/compression differences', () => {
    const preview = createImageHealthFingerprint(
      createSample((x, y) => [x * 7, y * 7, ((x + y) * 4) % 256]),
      SIZE,
      SIZE,
      1024,
      1024,
    );
    const download = createImageHealthFingerprint(
      createSample((x, y) => [x * 7 + 3, y * 7 + 2, (((x + y) * 4) % 256) + 2]),
      SIZE,
      SIZE,
      2048,
      2048,
    );

    expect(detectCorruptedGeminiDownload(preview, download).corrupted).toBe(false);
  });

  it('flags a severe preview mismatch with an abrupt blank trailing panel', () => {
    const preview = createImageHealthFingerprint(
      createSample((x, y) => [40 + x * 5, 30 + y * 5, 25 + ((x + y) % 20) * 6]),
      SIZE,
      SIZE,
      1024,
      1024,
    );
    const download = createImageHealthFingerprint(
      createSample((x, y) =>
        y >= 24 ? [156, 148, 139] : [20 + x * 2, 18 + y * 2, 15 + ((x + y) % 8) * 3],
      ),
      SIZE,
      SIZE,
      2048,
      2048,
    );

    const result = detectCorruptedGeminiDownload(preview, download);

    expect(result.corrupted).toBe(true);
    expect(result.reason).toBe('preview-mismatch');
    expect(result.trailingBandUniformity).toBeLessThan(8);
  });

  it('does not flag a legitimate flat lower area when it matches the preview', () => {
    const sample = createSample((x, y) =>
      y >= 24 ? [156, 148, 139] : [50 + x * 4, 40 + y * 3, 30 + ((x + y) % 12) * 5],
    );
    const preview = createImageHealthFingerprint(sample, SIZE, SIZE, 1024, 1024);
    const download = createImageHealthFingerprint(sample, SIZE, SIZE, 2048, 2048);

    expect(detectCorruptedGeminiDownload(preview, download).corrupted).toBe(false);
  });
});
