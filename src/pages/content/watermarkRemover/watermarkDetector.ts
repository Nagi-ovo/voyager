/**
 * Conservative watermark-presence detection and removal validation.
 *
 * The detector ports the useful signal checks from GeminiWatermarkTool's C++
 * implementation and the upstream userscript to TypeScript: luminance NCC,
 * Sobel-gradient NCC, and a counterfactual damage check before pixels are
 * committed to the output image.
 * License: MIT - Copyright (c) 2025 Jad; Copyright (c) 2024 AllenK (Kwyshell)
 * Full retained notice: see /THIRD_PARTY_NOTICES.md
 */
import type { WatermarkPosition } from './blendModes';

const EPSILON = 1e-9;
const DIRECT_MATCH_MIN_SPATIAL_SCORE = 0.3;
const DIRECT_MATCH_MIN_GRADIENT_SCORE = 0.12;
const STRONG_GRADIENT_MIN_SPATIAL_SCORE = 0.295;
const STRONG_GRADIENT_MIN_GRADIENT_SCORE = 0.45;
const MAX_RESIDUAL_SPATIAL_SCORE = 0.25;
const MAX_RESIDUAL_GRADIENT_SCORE = 0.18;
const MIN_SUPPRESSION_GAIN = 0.25;
const MIN_RELIABILITY_TRANSITION_GAIN = 0.2;
const MIN_RELIABILITY_TRANSITION_RATIO = 0.4;
const MIN_DIFFICULT_SUPPRESSION = 0.08;
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_INCREASE = 0.05;
const CLIP_ORIGINAL_THRESHOLD = 5;
const CLIP_CANDIDATE_THRESHOLD = 0;
const MAX_NEWLY_CLIPPED_RATIO = 0.03;
const ALPHA_THRESHOLD = 0.002;
const MAX_ALPHA = 0.99;
const LOGO_VALUE = 255;
const SEVERE_UNDERSHOOT_THRESHOLD = -5;
const MAX_SEVERE_UNDERSHOOT_RATIO = 0.1;

export interface WatermarkSignal {
  spatialScore: number;
  gradientScore: number;
}

export interface WatermarkRemovalAssessment {
  safe: boolean;
  originalSignal: WatermarkSignal;
  candidateSignal: WatermarkSignal;
  suppressionGain: number;
  nearBlackIncrease: number;
  newlyClippedRatio: number;
  severeUndershootRatio: number;
}

export interface DifficultWatermarkRemovalAssessment {
  eligible: boolean;
  originalStrength: number;
  finalResidualStrength: number;
  suppression: number;
  severeUndershootRatio: number;
}

function calculateLuminance(data: Uint8ClampedArray, index: number): number {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function isRegionInBounds(imageData: ImageData, position: WatermarkPosition): boolean {
  return (
    position.width > 0 &&
    position.height > 0 &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x + position.width <= imageData.width &&
    position.y + position.height <= imageData.height
  );
}

function extractLuminanceRegion(
  imageData: ImageData,
  position: WatermarkPosition,
): Float32Array | null {
  if (!isRegionInBounds(imageData, position)) return null;

  const values = new Float32Array(position.width * position.height);
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const imageIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
      values[row * position.width + col] = calculateLuminance(imageData.data, imageIndex) / 255;
    }
  }
  return values;
}

function normalizedCrossCorrelation(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < a.length; i++) {
    sumA += a[i];
    sumB += b[i];
  }

  const meanA = sumA / a.length;
  const meanB = sumB / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < a.length; i++) {
    const centeredA = a[i] - meanA;
    const centeredB = b[i] - meanB;
    covariance += centeredA * centeredB;
    varianceA += centeredA * centeredA;
    varianceB += centeredB * centeredB;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator <= EPSILON ? 0 : covariance / denominator;
}

function sobelMagnitude(values: Float32Array, width: number, height: number): Float32Array {
  const gradient = new Float32Array(values.length);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const gradientX =
        -values[index - width - 1] -
        2 * values[index - 1] -
        values[index + width - 1] +
        values[index - width + 1] +
        2 * values[index + 1] +
        values[index + width + 1];
      const gradientY =
        -values[index - width - 1] -
        2 * values[index - width] -
        values[index - width + 1] +
        values[index + width - 1] +
        2 * values[index + width] +
        values[index + width + 1];
      gradient[index] = Math.hypot(gradientX, gradientY);
    }
  }

  return gradient;
}

export function measureWatermarkSignal(
  imageData: ImageData,
  alphaMap: Float32Array,
  position: WatermarkPosition,
): WatermarkSignal {
  const luminance = extractLuminanceRegion(imageData, position);
  if (!luminance || alphaMap.length !== position.width * position.height) {
    return { spatialScore: 0, gradientScore: 0 };
  }

  return {
    spatialScore: normalizedCrossCorrelation(luminance, alphaMap),
    gradientScore: normalizedCrossCorrelation(
      sobelMagnitude(luminance, position.width, position.height),
      sobelMagnitude(alphaMap, position.width, position.height),
    ),
  };
}

export function hasReliableWatermarkSignal(signal: WatermarkSignal): boolean {
  return (
    (signal.spatialScore >= DIRECT_MATCH_MIN_SPATIAL_SCORE &&
      signal.gradientScore >= DIRECT_MATCH_MIN_GRADIENT_SCORE) ||
    (signal.spatialScore >= STRONG_GRADIENT_MIN_SPATIAL_SCORE &&
      signal.gradientScore >= STRONG_GRADIENT_MIN_GRADIENT_SCORE)
  );
}

export function getWatermarkSignalStrength(signal: WatermarkSignal): number {
  return Math.max(0, signal.spatialScore) * 0.5 + Math.max(0, signal.gradientScore) * 0.3;
}

export function assessDifficultWatermarkRemovalCandidate(
  originalSignal: WatermarkSignal,
  finalSignal: WatermarkSignal,
  severeUndershootRatio: number,
): DifficultWatermarkRemovalAssessment {
  const originalStrength = getWatermarkSignalStrength(originalSignal);
  const finalResidualStrength =
    Math.abs(finalSignal.spatialScore) * 0.5 + Math.max(0, finalSignal.gradientScore) * 0.3;
  const suppression = originalStrength - finalResidualStrength;
  const spatialReduced = Math.abs(finalSignal.spatialScore) < originalSignal.spatialScore;
  const gradientReduced = finalSignal.gradientScore < originalSignal.gradientScore;
  const eligible =
    spatialReduced &&
    gradientReduced &&
    suppression > MIN_DIFFICULT_SUPPRESSION &&
    severeUndershootRatio < MAX_SEVERE_UNDERSHOOT_RATIO;

  return {
    eligible,
    originalStrength,
    finalResidualStrength,
    suppression,
    severeUndershootRatio,
  };
}

export function hasResidualWatermarkEdges(signal: WatermarkSignal): boolean {
  return !hasReliableWatermarkSignal(signal) && signal.gradientScore > MAX_RESIDUAL_GRADIENT_SCORE;
}

export function hasAcceptableWatermarkRemovalEvidence(
  candidateSignal: WatermarkSignal,
  suppressionGain: number,
): boolean {
  const residualStillReliable = hasReliableWatermarkSignal(candidateSignal);
  const residualCleared = hasStrongWatermarkRemovalEvidence(candidateSignal, suppressionGain);
  const inferredOriginalSpatialMagnitude =
    Math.abs(candidateSignal.spatialScore) + Math.max(0, suppressionGain);
  const suppressionRatio =
    inferredOriginalSpatialMagnitude > EPSILON
      ? Math.max(0, suppressionGain) / inferredOriginalSpatialMagnitude
      : 0;
  const residualSuppressedBelowReliability =
    !residualStillReliable &&
    suppressionGain >= MIN_RELIABILITY_TRANSITION_GAIN &&
    suppressionRatio >= MIN_RELIABILITY_TRANSITION_RATIO;

  return residualStillReliable || residualCleared || residualSuppressedBelowReliability;
}

function hasStrongWatermarkRemovalEvidence(
  candidateSignal: WatermarkSignal,
  suppressionGain: number,
): boolean {
  return (
    suppressionGain >= MIN_SUPPRESSION_GAIN &&
    Math.abs(candidateSignal.spatialScore) <= MAX_RESIDUAL_SPATIAL_SCORE &&
    candidateSignal.gradientScore <= MAX_RESIDUAL_GRADIENT_SCORE
  );
}

export function measureSevereUndershootRatio(
  imageData: ImageData,
  alphaMap: Float32Array,
  position: WatermarkPosition,
): number {
  if (
    !isRegionInBounds(imageData, position) ||
    alphaMap.length !== position.width * position.height
  ) {
    return 0;
  }

  let severeUndershoot = 0;
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const alphaIndex = row * position.width + col;
      let alpha = alphaMap[alphaIndex];
      if (alpha < ALPHA_THRESHOLD) continue;

      alpha = Math.min(alpha, MAX_ALPHA);
      const oneMinusAlpha = 1 - alpha;
      const imageIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
      let severePixel = false;
      for (let channel = 0; channel < 3; channel++) {
        const watermarked = imageData.data[imageIndex + channel];
        const rawOriginal = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
        if (rawOriginal < SEVERE_UNDERSHOOT_THRESHOLD) {
          severePixel = true;
          break;
        }
      }
      if (severePixel) severeUndershoot++;
    }
  }

  return severeUndershoot / Math.max(1, position.width * position.height);
}

export function assessWatermarkRemovalCandidate(
  originalImageData: ImageData,
  candidateImageData: ImageData,
  alphaMap: Float32Array,
  position: WatermarkPosition,
  originalSignal = measureWatermarkSignal(originalImageData, alphaMap, position),
  severeUndershootRatio = measureSevereUndershootRatio(originalImageData, alphaMap, position),
): WatermarkRemovalAssessment {
  const candidateSignal = measureWatermarkSignal(candidateImageData, alphaMap, position);
  const totalPixels = position.width * position.height;
  let originalNearBlack = 0;
  let candidateNearBlack = 0;
  let newlyClipped = 0;

  if (
    isRegionInBounds(originalImageData, position) &&
    isRegionInBounds(candidateImageData, position)
  ) {
    for (let row = 0; row < position.height; row++) {
      for (let col = 0; col < position.width; col++) {
        const index = ((position.y + row) * originalImageData.width + position.x + col) * 4;
        const originalBlack =
          originalImageData.data[index] <= NEAR_BLACK_THRESHOLD &&
          originalImageData.data[index + 1] <= NEAR_BLACK_THRESHOLD &&
          originalImageData.data[index + 2] <= NEAR_BLACK_THRESHOLD;
        const candidateBlack =
          candidateImageData.data[index] <= NEAR_BLACK_THRESHOLD &&
          candidateImageData.data[index + 1] <= NEAR_BLACK_THRESHOLD &&
          candidateImageData.data[index + 2] <= NEAR_BLACK_THRESHOLD;

        if (originalBlack) originalNearBlack++;
        if (candidateBlack) candidateNearBlack++;

        const newlyClippedPixel =
          (candidateImageData.data[index] <= CLIP_CANDIDATE_THRESHOLD &&
            originalImageData.data[index] > CLIP_ORIGINAL_THRESHOLD) ||
          (candidateImageData.data[index + 1] <= CLIP_CANDIDATE_THRESHOLD &&
            originalImageData.data[index + 1] > CLIP_ORIGINAL_THRESHOLD) ||
          (candidateImageData.data[index + 2] <= CLIP_CANDIDATE_THRESHOLD &&
            originalImageData.data[index + 2] > CLIP_ORIGINAL_THRESHOLD);
        if (newlyClippedPixel) {
          newlyClipped++;
        }
      }
    }
  }

  const suppressionGain = originalSignal.spatialScore - Math.abs(candidateSignal.spatialScore);
  const ratioDenominator = Math.max(1, totalPixels);
  const nearBlackIncrease = Math.max(0, candidateNearBlack - originalNearBlack) / ratioDenominator;
  const newlyClippedRatio = newlyClipped / ratioDenominator;
  const evidenceSafe = hasAcceptableWatermarkRemovalEvidence(candidateSignal, suppressionGain);
  const exceedsLegacyDamageLimits =
    nearBlackIncrease > MAX_NEAR_BLACK_INCREASE || newlyClippedRatio > MAX_NEWLY_CLIPPED_RATIO;
  const damageSafe =
    !exceedsLegacyDamageLimits || severeUndershootRatio < MAX_SEVERE_UNDERSHOOT_RATIO;

  return {
    safe: hasReliableWatermarkSignal(originalSignal) && evidenceSafe && damageSafe,
    originalSignal,
    candidateSignal,
    suppressionGain,
    nearBlackIncrease,
    newlyClippedRatio,
    severeUndershootRatio,
  };
}
