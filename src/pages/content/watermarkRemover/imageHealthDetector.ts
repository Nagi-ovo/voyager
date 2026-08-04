export const IMAGE_HEALTH_SAMPLE_SIZE = 32;

export type ImageHealthFingerprint = {
  sampleWidth: number;
  sampleHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  rgb: number[];
};

export type ImageHealthResult = {
  corrupted: boolean;
  reason: 'healthy' | 'aspect-ratio-mismatch' | 'preview-mismatch';
  mismatchScore: number;
  trailingBandUniformity: number;
  trailingBandBoundaryJump: number;
};

const SEVERE_MISMATCH_THRESHOLD = 42;
const BANDED_MISMATCH_THRESHOLD = 18;
const TRAILING_BAND_UNIFORMITY_THRESHOLD = 8;
const TRAILING_BAND_BOUNDARY_JUMP_THRESHOLD = 24;
const ASPECT_RATIO_TOLERANCE = 0.02;

export function createImageHealthFingerprint(
  rgba: Uint8ClampedArray,
  sampleWidth: number,
  sampleHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ImageHealthFingerprint {
  const expectedLength = sampleWidth * sampleHeight * 4;
  if (rgba.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} RGBA values, received ${rgba.length}`);
  }

  const rgb = new Array<number>(sampleWidth * sampleHeight * 3);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < rgba.length; sourceIndex += 4) {
    rgb[targetIndex] = rgba[sourceIndex];
    rgb[targetIndex + 1] = rgba[sourceIndex + 1];
    rgb[targetIndex + 2] = rgba[sourceIndex + 2];
    targetIndex += 3;
  }

  return { sampleWidth, sampleHeight, sourceWidth, sourceHeight, rgb };
}

function calculateMismatch(
  preview: ImageHealthFingerprint,
  download: ImageHealthFingerprint,
): number {
  if (
    preview.sampleWidth !== download.sampleWidth ||
    preview.sampleHeight !== download.sampleHeight ||
    preview.rgb.length !== download.rgb.length
  ) {
    return Number.POSITIVE_INFINITY;
  }

  let absoluteDifference = 0;
  for (let index = 0; index < preview.rgb.length; index += 1) {
    absoluteDifference += Math.abs(preview.rgb[index] - download.rgb[index]);
  }
  return absoluteDifference / preview.rgb.length;
}

function calculateSpatialUniformity(
  fingerprint: ImageHealthFingerprint,
  startRow: number,
  endRow: number,
): number {
  const { rgb, sampleWidth } = fingerprint;
  const pixelCount = (endRow - startRow) * sampleWidth;
  let totalChannelDeviation = 0;

  for (let channel = 0; channel < 3; channel += 1) {
    let sum = 0;
    let sumOfSquares = 0;
    for (let y = startRow; y < endRow; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const value = rgb[(y * sampleWidth + x) * 3 + channel];
        sum += value;
        sumOfSquares += value * value;
      }
    }
    const mean = sum / pixelCount;
    totalChannelDeviation += Math.sqrt(Math.max(0, sumOfSquares / pixelCount - mean * mean));
  }

  return totalChannelDeviation / 3;
}

function calculateRowBoundaryJump(
  fingerprint: ImageHealthFingerprint,
  upperRow: number,
  lowerRow: number,
): number {
  const { rgb, sampleWidth } = fingerprint;
  let difference = 0;

  for (let channel = 0; channel < 3; channel += 1) {
    let upperMean = 0;
    let lowerMean = 0;
    for (let x = 0; x < sampleWidth; x += 1) {
      upperMean += rgb[(upperRow * sampleWidth + x) * 3 + channel];
      lowerMean += rgb[(lowerRow * sampleWidth + x) * 3 + channel];
    }
    difference += Math.abs(upperMean / sampleWidth - lowerMean / sampleWidth);
  }

  return difference / 3;
}

export function detectCorruptedGeminiDownload(
  preview: ImageHealthFingerprint,
  download: ImageHealthFingerprint,
): ImageHealthResult {
  const previewAspectRatio = preview.sourceWidth / preview.sourceHeight;
  const downloadAspectRatio = download.sourceWidth / download.sourceHeight;
  const aspectRatioDifference = Math.abs(previewAspectRatio - downloadAspectRatio);
  const mismatchScore = calculateMismatch(preview, download);
  const trailingBandStart = Math.floor(download.sampleHeight * 0.75);
  const trailingBandUniformity = calculateSpatialUniformity(
    download,
    trailingBandStart,
    download.sampleHeight,
  );
  const trailingBandBoundaryJump = calculateRowBoundaryJump(
    download,
    trailingBandStart - 1,
    trailingBandStart,
  );

  if (aspectRatioDifference > ASPECT_RATIO_TOLERANCE) {
    return {
      corrupted: true,
      reason: 'aspect-ratio-mismatch',
      mismatchScore,
      trailingBandUniformity,
      trailingBandBoundaryJump,
    };
  }

  const hasAbruptBlankTrailingBand =
    trailingBandUniformity < TRAILING_BAND_UNIFORMITY_THRESHOLD &&
    trailingBandBoundaryJump > TRAILING_BAND_BOUNDARY_JUMP_THRESHOLD;
  const hasPreviewMismatch =
    mismatchScore >= SEVERE_MISMATCH_THRESHOLD ||
    (mismatchScore >= BANDED_MISMATCH_THRESHOLD && hasAbruptBlankTrailingBand);

  return {
    corrupted: hasPreviewMismatch,
    reason: hasPreviewMismatch ? 'preview-mismatch' : 'healthy',
    mismatchScore,
    trailingBandUniformity,
    trailingBandBoundaryJump,
  };
}
