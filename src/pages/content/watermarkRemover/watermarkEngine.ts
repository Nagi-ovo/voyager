/**
 * Watermark Engine Main Module
 *
 * This module is ported from gemini-watermark-remover by journey-ad (Jad),
 * itself based on GeminiWatermarkTool by AllenK (Kwyshell).
 * Original: https://github.com/journey-ad/gemini-watermark-remover/blob/main/src/core/watermarkEngine.js
 * License: MIT - Copyright (c) 2025 Jad; Copyright (c) 2024 AllenK (Kwyshell)
 * Full retained notice: see /THIRD_PARTY_NOTICES.md
 *
 * Coordinates watermark detection, alpha map calculation, and removal operations.
 */
import { calculateAlphaMap } from './alphaMap';
import BG_36_20260520_IMPORT from './assets/bg_36_20260520.png';
// Import watermark background capture images - Vite will bundle these
import BG_48_IMPORT from './assets/bg_48.png';
import BG_96_IMPORT from './assets/bg_96.png';
import BG_96_20260520_IMPORT from './assets/bg_96_20260520.png';
import { type WatermarkPosition, removeWatermark } from './blendModes';
import {
  assessDifficultWatermarkRemovalCandidate,
  assessWatermarkRemovalCandidate,
  getWatermarkSignalStrength,
  hasReliableWatermarkSignal,
  hasResidualWatermarkEdges,
  hasSafeSupportedReliabilityTransition,
  measureSevereUndershootRatio,
  measureWatermarkSignal,
} from './watermarkDetector';

// For content scripts, we need to use chrome.runtime.getURL to resolve asset paths
// The imported paths are relative to the bundle, which works in extension context
const getBgPath = (importedPath: string): string => {
  // If it's already a data URL, use it directly
  if (importedPath.startsWith('data:')) {
    return importedPath;
  }
  // For file paths, use chrome.runtime.getURL in extension context
  try {
    // Extract just the filename from the path
    const filename = importedPath.split('/').pop() || importedPath;
    return chrome.runtime.getURL(`assets/${filename}`);
  } catch {
    // Fallback to the original path
    return importedPath;
  }
};

export interface WatermarkConfig {
  logoSize: number;
  marginRight: number;
  marginBottom: number;
  alphaVariant?: WatermarkAlphaVariant;
}

export interface WatermarkInfo {
  size: number;
  position: WatermarkPosition;
  config: WatermarkConfig;
}

export type WatermarkAlphaVariant = '20260520' | '20260520-small';

type WatermarkLogoSize = 36 | 48 | 96;
type WatermarkAlphaMapKey = WatermarkLogoSize | `${WatermarkLogoSize}-${WatermarkAlphaVariant}`;
export interface WatermarkAnchorOption {
  config: WatermarkConfig;
  alphaMap: Float32Array;
}

const LEGACY_LARGE_IMAGE_MIN_EDGE = 1024;
const WATERMARK_MAX_REMOVAL_PASSES = 3;

const LEGACY_96_WATERMARK_CONFIG: WatermarkConfig = {
  logoSize: 96,
  marginRight: 64,
  marginBottom: 64,
};

const LEGACY_48_WATERMARK_CONFIG: WatermarkConfig = {
  logoSize: 48,
  marginRight: 32,
  marginBottom: 32,
};

const V2_LARGE_WATERMARK_CONFIG: WatermarkConfig = {
  logoSize: 96,
  marginRight: 192,
  marginBottom: 192,
  alphaVariant: '20260520',
};

const V2_DOWNSCALED_LARGE_WATERMARK_CONFIG: WatermarkConfig = {
  logoSize: 48,
  marginRight: 96,
  marginBottom: 96,
  alphaVariant: '20260520',
};

const areSameWatermarkConfig = (a: WatermarkConfig, b: WatermarkConfig): boolean =>
  a.logoSize === b.logoSize &&
  a.marginRight === b.marginRight &&
  a.marginBottom === b.marginBottom &&
  a.alphaVariant === b.alphaVariant;

function createV2SmallWatermarkConfig(imageWidth: number, imageHeight: number): WatermarkConfig {
  const longSide = Math.max(imageWidth, imageHeight);
  const shortSide = Math.min(imageWidth, imageHeight);
  const sourceLongDimension = shortSide >= 566 ? 2752 : shortSide >= 550 ? 2816 : 2848;
  const margin = Math.round((192 * longSide) / sourceLongDimension);

  return {
    logoSize: 36,
    marginRight: margin,
    marginBottom: margin,
    alphaVariant: '20260520-small',
  };
}

/**
 * Detect watermark configuration based on image size
 * @param imageWidth - Image width
 * @param imageHeight - Image height
 * @returns Watermark configuration {logoSize, marginRight, marginBottom}
 */
export function detectWatermarkConfig(imageWidth: number, imageHeight: number): WatermarkConfig {
  if (imageWidth > LEGACY_LARGE_IMAGE_MIN_EDGE && imageHeight > LEGACY_LARGE_IMAGE_MIN_EDGE) {
    return { ...LEGACY_96_WATERMARK_CONFIG };
  }

  return { ...LEGACY_48_WATERMARK_CONFIG };
}

export function getWatermarkConfigOptions(
  imageWidth: number,
  imageHeight: number,
): WatermarkConfig[] {
  const legacyConfig = detectWatermarkConfig(imageWidth, imageHeight);
  const isLarge =
    imageWidth > LEGACY_LARGE_IMAGE_MIN_EDGE && imageHeight > LEGACY_LARGE_IMAGE_MIN_EDGE;
  const currentConfigs = isLarge
    ? [V2_LARGE_WATERMARK_CONFIG]
    : [createV2SmallWatermarkConfig(imageWidth, imageHeight), V2_DOWNSCALED_LARGE_WATERMARK_CONFIG];

  return [legacyConfig, ...currentConfigs].filter(
    (config, index, configs) =>
      calculateWatermarkPosition(imageWidth, imageHeight, config).x >= 0 &&
      calculateWatermarkPosition(imageWidth, imageHeight, config).y >= 0 &&
      configs.findIndex((candidate) => areSameWatermarkConfig(candidate, config)) === index,
  );
}

/**
 * Calculate watermark position in image based on image size and watermark configuration
 * @param imageWidth - Image width
 * @param imageHeight - Image height
 * @param config - Watermark configuration {logoSize, marginRight, marginBottom}
 * @returns Watermark position {x, y, width, height}
 */
export function calculateWatermarkPosition(
  imageWidth: number,
  imageHeight: number,
  config: WatermarkConfig,
): WatermarkPosition {
  const { logoSize, marginRight, marginBottom } = config;

  return {
    x: imageWidth - marginRight - logoSize,
    y: imageHeight - marginBottom - logoSize,
    width: logoSize,
    height: logoSize,
  };
}

export function chooseWatermarkAnchorOption(
  imageData: ImageData,
  options: WatermarkAnchorOption[],
): WatermarkAnchorOption {
  if (options.length <= 1) {
    return options[0];
  }

  let strongestReliable:
    | { option: WatermarkAnchorOption; signal: ReturnType<typeof measureWatermarkSignal> }
    | undefined;

  for (const option of options) {
    const snapOffsets =
      option.config.alphaVariant === '20260520-small' ? [-3, -2, -1, 0, 1, 2, 3] : [0];
    for (const offsetX of snapOffsets) {
      for (const offsetY of snapOffsets) {
        const snappedOption =
          offsetX === 0 && offsetY === 0
            ? option
            : {
                ...option,
                config: {
                  ...option.config,
                  marginRight: option.config.marginRight - offsetX,
                  marginBottom: option.config.marginBottom - offsetY,
                },
              };
        const position = calculateWatermarkPosition(
          imageData.width,
          imageData.height,
          snappedOption.config,
        );
        const signal = measureWatermarkSignal(imageData, snappedOption.alphaMap, position);
        if (!hasReliableWatermarkSignal(signal)) continue;
        if (
          !strongestReliable ||
          getWatermarkSignalStrength(signal) > getWatermarkSignalStrength(strongestReliable.signal)
        ) {
          strongestReliable = { option: snappedOption, signal };
        }
      }
    }
  }

  return strongestReliable?.option ?? options[0];
}

function snapshotWatermarkRegion(
  imageData: ImageData,
  position: WatermarkPosition,
): Uint8ClampedArray {
  const snapshot = new Uint8ClampedArray(position.width * position.height * 4);
  for (let row = 0; row < position.height; row++) {
    const sourceStart = ((position.y + row) * imageData.width + position.x) * 4;
    const targetStart = row * position.width * 4;
    snapshot.set(
      imageData.data.subarray(sourceStart, sourceStart + position.width * 4),
      targetStart,
    );
  }
  return snapshot;
}

function restoreWatermarkRegion(
  imageData: ImageData,
  position: WatermarkPosition,
  snapshot: Uint8ClampedArray,
): void {
  for (let row = 0; row < position.height; row++) {
    const sourceStart = row * position.width * 4;
    const targetStart = ((position.y + row) * imageData.width + position.x) * 4;
    imageData.data.set(
      snapshot.subarray(sourceStart, sourceStart + position.width * 4),
      targetStart,
    );
  }
}

function isWatermarkPositionInBounds(imageData: ImageData, position: WatermarkPosition): boolean {
  return (
    position.width > 0 &&
    position.height > 0 &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x + position.width <= imageData.width &&
    position.y + position.height <= imageData.height
  );
}

function getDifficultWatermarkAnchorOptions(
  options: WatermarkAnchorOption[],
): WatermarkAnchorOption[] {
  return options.flatMap((option) => {
    const snapOffsets =
      option.config.alphaVariant === '20260520-small' ? [-3, -2, -1, 0, 1, 2, 3] : [0];

    return snapOffsets.flatMap((offsetX) =>
      snapOffsets.map((offsetY) =>
        offsetX === 0 && offsetY === 0
          ? option
          : {
              ...option,
              config: {
                ...option.config,
                marginRight: option.config.marginRight - offsetX,
                marginBottom: option.config.marginBottom - offsetY,
              },
            },
      ),
    );
  });
}

export function chooseDifficultWatermarkAnchorOption(
  imageData: ImageData,
  options: WatermarkAnchorOption[],
): WatermarkAnchorOption | undefined {
  let best:
    | {
        option: WatermarkAnchorOption;
        suppression: number;
      }
    | undefined;

  for (const option of getDifficultWatermarkAnchorOptions(options)) {
    const position = calculateWatermarkPosition(imageData.width, imageData.height, option.config);
    if (!isWatermarkPositionInBounds(imageData, position)) continue;

    const originalSignal = measureWatermarkSignal(imageData, option.alphaMap, position);
    const severeUndershootRatio = measureSevereUndershootRatio(
      imageData,
      option.alphaMap,
      position,
    );
    const snapshot = snapshotWatermarkRegion(imageData, position);
    let finalSignal: ReturnType<typeof measureWatermarkSignal>;

    try {
      removeWatermark(imageData, option.alphaMap, position);
      finalSignal = measureWatermarkSignal(imageData, option.alphaMap, position);
    } finally {
      restoreWatermarkRegion(imageData, position, snapshot);
    }

    const assessment = assessDifficultWatermarkRemovalCandidate(
      originalSignal,
      finalSignal,
      severeUndershootRatio,
    );
    if (!assessment.eligible) continue;
    if (!best || assessment.suppression > best.suppression) {
      best = {
        option,
        suppression: assessment.suppression,
      };
    }
  }

  return best?.option;
}

export function removeWatermarkFromAnchorOptions(
  imageData: ImageData,
  anchorOptions: WatermarkAnchorOption[],
): void {
  const trustedOption = chooseWatermarkAnchorOption(imageData, anchorOptions);
  const trustedPosition = calculateWatermarkPosition(
    imageData.width,
    imageData.height,
    trustedOption.config,
  );
  const trustedSignal = measureWatermarkSignal(imageData, trustedOption.alphaMap, trustedPosition);

  if (hasReliableWatermarkSignal(trustedSignal)) {
    // Gemini can stack multiple transparent marks after iterative edits, so
    // trusted candidates retain the iterative safety rollback. Only the exact
    // full-size V2 preset may use its narrower first-pass transition evidence.
    const allowSupportedReliabilityTransition =
      trustedOption.config.logoSize === 96 && trustedOption.config.alphaVariant === '20260520';
    removeWatermarkWithResidualCheck(
      imageData,
      trustedOption.alphaMap,
      trustedPosition,
      allowSupportedReliabilityTransition,
    );
    return;
  }

  // Only fall back after every known anchor misses the trusted thresholds.
  // Each difficult candidate is trialed against, and restored to, the same
  // original pixels before the strongest safe suppression is applied once.
  const difficultOption = chooseDifficultWatermarkAnchorOption(imageData, anchorOptions);
  if (!difficultOption) return;

  const difficultPosition = calculateWatermarkPosition(
    imageData.width,
    imageData.height,
    difficultOption.config,
  );
  removeWatermark(imageData, difficultOption.alphaMap, difficultPosition);
}

function createGaussianKernel(radius: number, sigma: number): Float32Array {
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const value = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = value;
    sum += value;
  }
  for (let index = 0; index < kernel.length; index++) kernel[index] /= sum;
  return kernel;
}

function blurScalarField(
  values: Float32Array,
  width: number,
  height: number,
  radius: number,
  sigma: number,
): Float32Array {
  const kernel = createGaussianKernel(radius, sigma);
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset));
        sum += values[y * width + sampleX] * kernel[offset + radius];
      }
      horizontal[y * width + x] = sum;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset));
        sum += horizontal[sampleY * width + x] * kernel[offset + radius];
      }
      result[y * width + x] = sum;
    }
  }

  return result;
}

function createResidualCleanupWeights(
  alphaMap: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const gradient = new Float32Array(alphaMap.length);
  let maxGradient = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const gradientX =
        -alphaMap[index - width - 1] -
        2 * alphaMap[index - 1] -
        alphaMap[index + width - 1] +
        alphaMap[index - width + 1] +
        2 * alphaMap[index + 1] +
        alphaMap[index + width + 1];
      const gradientY =
        -alphaMap[index - width - 1] -
        2 * alphaMap[index - width] -
        alphaMap[index - width + 1] +
        alphaMap[index + width - 1] +
        2 * alphaMap[index + width] +
        alphaMap[index + width + 1];
      const magnitude = Math.hypot(gradientX, gradientY);
      gradient[index] = magnitude;
      maxGradient = Math.max(maxGradient, magnitude);
    }
  }
  if (maxGradient === 0) return gradient;

  const expanded = new Float32Array(alphaMap.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxWeight = 0;
      for (let offsetY = -2; offsetY <= 2; offsetY++) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
        for (let offsetX = -2; offsetX <= 2; offsetX++) {
          const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
          maxWeight = Math.max(
            maxWeight,
            Math.sqrt(gradient[sampleY * width + sampleX] / maxGradient),
          );
        }
      }
      expanded[y * width + x] = maxWeight;
    }
  }

  const smoothed = blurScalarField(expanded, width, height, 4, 2);
  for (let index = 0; index < smoothed.length; index++) {
    smoothed[index] = Math.min(1, smoothed[index] * 0.85);
  }
  return smoothed;
}

function softenWatermarkResidual(
  imageData: ImageData,
  alphaMap: Float32Array,
  position: WatermarkPosition,
): void {
  if (alphaMap.length !== position.width * position.height) return;

  const weights = createResidualCleanupWeights(alphaMap, position.width, position.height);
  const blurRadius = 10;
  const kernel = createGaussianKernel(blurRadius, 8);
  const original = new Uint8ClampedArray(imageData.data);

  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const weight = weights[row * position.width + col];
      if (weight <= 0.01) continue;

      const imageX = position.x + col;
      const imageY = position.y + row;
      const targetIndex = (imageY * imageData.width + imageX) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let blurred = 0;
        for (let offsetY = -blurRadius; offsetY <= blurRadius; offsetY++) {
          const sampleY = Math.max(0, Math.min(imageData.height - 1, imageY + offsetY));
          const weightY = kernel[offsetY + blurRadius];
          for (let offsetX = -blurRadius; offsetX <= blurRadius; offsetX++) {
            const sampleX = Math.max(0, Math.min(imageData.width - 1, imageX + offsetX));
            const sampleIndex = (sampleY * imageData.width + sampleX) * 4 + channel;
            blurred += original[sampleIndex] * weightY * kernel[offsetX + blurRadius];
          }
        }
        imageData.data[targetIndex + channel] = Math.round(
          original[targetIndex + channel] * (1 - weight) + blurred * weight,
        );
      }
    }
  }
}

export function removeWatermarkWithResidualCheck(
  imageData: ImageData,
  alphaMap: Float32Array,
  position: WatermarkPosition,
  allowSupportedReliabilityTransition = false,
): number {
  let passes = 0;
  let currentSignal = measureWatermarkSignal(imageData, alphaMap, position);
  if (!hasReliableWatermarkSignal(currentSignal)) return passes;

  const originalImageData = {
    data: new Uint8ClampedArray(imageData.data),
    width: imageData.width,
    height: imageData.height,
  } as ImageData;

  while (passes < WATERMARK_MAX_REMOVAL_PASSES) {
    const previousRegion = snapshotWatermarkRegion(imageData, position);
    const severeUndershootRatio = measureSevereUndershootRatio(imageData, alphaMap, position);
    removeWatermark(imageData, alphaMap, position);
    const assessment = assessWatermarkRemovalCandidate(
      originalImageData,
      imageData,
      alphaMap,
      position,
      currentSignal,
      severeUndershootRatio,
    );
    const supportedReliabilityTransition =
      allowSupportedReliabilityTransition &&
      passes === 0 &&
      hasSafeSupportedReliabilityTransition(assessment);
    if (!assessment.safe && !supportedReliabilityTransition) {
      restoreWatermarkRegion(imageData, position, previousRegion);
      break;
    }

    passes++;
    currentSignal = assessment.candidateSignal;
    if (!hasReliableWatermarkSignal(currentSignal)) break;
  }

  if (passes > 0 && hasResidualWatermarkEdges(currentSignal)) {
    softenWatermarkResidual(imageData, alphaMap, position);
  }

  return passes;
}

interface BgCaptures {
  bg36_20260520: HTMLImageElement;
  bg48: HTMLImageElement;
  bg96: HTMLImageElement;
  bg96_20260520: HTMLImageElement;
}

/**
 * Watermark engine class
 * Coordinates watermark detection, alpha map calculation, and removal operations
 */
export class WatermarkEngine {
  private bgCaptures: BgCaptures;
  private alphaMaps: Partial<Record<WatermarkAlphaMapKey, Float32Array>>;

  constructor(bgCaptures: BgCaptures) {
    this.bgCaptures = bgCaptures;
    this.alphaMaps = {};
  }

  static async create(): Promise<WatermarkEngine> {
    const bg48 = new Image();
    const bg96 = new Image();
    const bg36_20260520 = new Image();
    const bg96_20260520 = new Image();

    const bg48Path = getBgPath(BG_48_IMPORT);
    const bg96Path = getBgPath(BG_96_IMPORT);
    const bg36_20260520Path = getBgPath(BG_36_20260520_IMPORT);
    const bg96_20260520Path = getBgPath(BG_96_20260520_IMPORT);

    console.log('[Gemini Voyager] Loading watermark assets:', {
      bg48Path,
      bg96Path,
      bg36_20260520Path,
      bg96_20260520Path,
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        bg48.onload = () => resolve();
        bg48.onerror = (e) =>
          reject(
            new Error(
              `Failed to load bg_48.png from ${bg48Path}: ${e instanceof Event ? 'Image load error' : e}`,
            ),
          );
        // Set crossOrigin before src to prevent canvas tainting in Firefox
        bg48.crossOrigin = 'anonymous';
        bg48.src = bg48Path;
      }),
      new Promise<void>((resolve, reject) => {
        bg96.onload = () => resolve();
        bg96.onerror = (e) =>
          reject(
            new Error(
              `Failed to load bg_96.png from ${bg96Path}: ${e instanceof Event ? 'Image load error' : e}`,
            ),
          );
        // Set crossOrigin before src to prevent canvas tainting in Firefox
        bg96.crossOrigin = 'anonymous';
        bg96.src = bg96Path;
      }),
      new Promise<void>((resolve, reject) => {
        bg36_20260520.onload = () => resolve();
        bg36_20260520.onerror = (e) =>
          reject(
            new Error(
              `Failed to load bg_36_20260520.png from ${bg36_20260520Path}: ${e instanceof Event ? 'Image load error' : e}`,
            ),
          );
        bg36_20260520.crossOrigin = 'anonymous';
        bg36_20260520.src = bg36_20260520Path;
      }),
      new Promise<void>((resolve, reject) => {
        bg96_20260520.onload = () => resolve();
        bg96_20260520.onerror = (e) =>
          reject(
            new Error(
              `Failed to load bg_96_20260520.png from ${bg96_20260520Path}: ${e instanceof Event ? 'Image load error' : e}`,
            ),
          );
        bg96_20260520.crossOrigin = 'anonymous';
        bg96_20260520.src = bg96_20260520Path;
      }),
    ]);

    return new WatermarkEngine({ bg36_20260520, bg48, bg96, bg96_20260520 });
  }

  /**
   * Get alpha map from background captured image based on watermark size/variant
   * @param size - Watermark size key
   * @returns Alpha map
   */
  async getAlphaMap(size: WatermarkAlphaMapKey): Promise<Float32Array> {
    // If cached, return directly
    if (this.alphaMaps[size]) {
      return this.alphaMaps[size];
    }

    // Select corresponding background capture based on watermark size
    const isVariant = typeof size === 'string';
    const logoSize = (isVariant ? Number(size.split('-')[0]) : size) as WatermarkLogoSize;
    const bgImage =
      size === '36-20260520-small'
        ? this.bgCaptures.bg36_20260520
        : isVariant
          ? this.bgCaptures.bg96_20260520
          : logoSize === 48
            ? this.bgCaptures.bg48
            : this.bgCaptures.bg96;

    // Create temporary canvas to extract ImageData
    const canvas = document.createElement('canvas');
    canvas.width = logoSize;
    canvas.height = logoSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas 2d context');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bgImage, 0, 0, logoSize, logoSize);

    const imageData = ctx.getImageData(0, 0, logoSize, logoSize);

    // Calculate alpha map
    const alphaMap = calculateAlphaMap(imageData);

    // Cache result
    this.alphaMaps[size] = alphaMap;

    return alphaMap;
  }

  private getAlphaMapKey(config: WatermarkConfig): WatermarkAlphaMapKey {
    const logoSize = config.logoSize === 36 ? 36 : config.logoSize === 48 ? 48 : 96;
    if (config.alphaVariant === '20260520-small') return '36-20260520-small';
    if (config.alphaVariant === '20260520') return `${logoSize}-20260520`;
    return logoSize;
  }

  /**
   * Remove watermark from image based on watermark size
   * @param image - Input image
   * @returns Processed canvas
   */
  async removeWatermarkFromImage(
    image: HTMLImageElement | HTMLCanvasElement,
  ): Promise<HTMLCanvasElement> {
    // Create canvas to process image
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas 2d context');
    }

    // Draw original image onto canvas
    ctx.drawImage(image, 0, 0);

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const anchorOptions = await Promise.all(
      getWatermarkConfigOptions(canvas.width, canvas.height).map(async (config) => ({
        config,
        alphaMap: await this.getAlphaMap(this.getAlphaMapKey(config)),
      })),
    );
    removeWatermarkFromAnchorOptions(imageData, anchorOptions);

    // Write processed image data back to canvas
    ctx.putImageData(imageData, 0, 0);

    return canvas;
  }

  /**
   * Get watermark information (for display)
   * @param imageWidth - Image width
   * @param imageHeight - Image height
   * @returns Watermark information {size, position, config}
   */
  getWatermarkInfo(imageWidth: number, imageHeight: number): WatermarkInfo {
    const config = detectWatermarkConfig(imageWidth, imageHeight);
    const position = calculateWatermarkPosition(imageWidth, imageHeight, config);

    return {
      size: config.logoSize,
      position: position,
      config: config,
    };
  }
}
