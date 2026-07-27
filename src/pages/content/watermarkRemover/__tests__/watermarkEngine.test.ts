import { describe, expect, it } from 'vitest';

import { removeWatermark } from '../blendModes';
import {
  assessDifficultWatermarkRemovalCandidate,
  getWatermarkSignalStrength,
  hasAcceptableWatermarkRemovalEvidence,
  hasReliableWatermarkSignal,
  measureSevereUndershootRatio,
  measureWatermarkSignal,
} from '../watermarkDetector';
import {
  type WatermarkAnchorOption,
  type WatermarkConfig,
  calculateWatermarkPosition,
  chooseDifficultWatermarkAnchorOption,
  chooseWatermarkAnchorOption,
  detectWatermarkConfig,
  getWatermarkConfigOptions,
  removeWatermarkFromAnchorOptions,
  removeWatermarkWithResidualCheck,
} from '../watermarkEngine';

const TEST_ALPHA_MAP = Float32Array.from([
  0.02, 0.15, 0.15, 0.02, 0.15, 0.8, 0.8, 0.15, 0.15, 0.8, 0.8, 0.15, 0.02, 0.15, 0.15, 0.02,
]);

const WEAK_DIFFICULT_ALPHA_MAP = Float32Array.from(TEST_ALPHA_MAP, (alpha) => alpha * 0.15);
const STRONG_DIFFICULT_ALPHA_MAP = Float32Array.from(TEST_ALPHA_MAP, (alpha) => alpha * 0.5);
const WEAK_DIFFICULT_BASE_PATTERN = [
  93, 131, 74, 82, 64, 50, 129, 101, 27, 77, 218, 34, 221, 116, 76, 131,
];
const STRONG_DIFFICULT_BASE_PATTERN = [
  24, 102, 48, 226, 59, 235, 28, 58, 65, 64, 103, 204, 33, 179, 216, 173,
];

function createSolidImageData(value = 80): ImageData {
  const width = 24;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < data.length; index += 4) {
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }

  return { data, width, height } as ImageData;
}

function createImageDataWithWatermark(
  config: WatermarkConfig,
  layers = 1,
  baseValue = 80,
): ImageData {
  const imageData = createSolidImageData(baseValue);
  const { data, width, height } = imageData;

  const position = calculateWatermarkPosition(width, height, config);
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const alpha = TEST_ALPHA_MAP[row * position.width + col];
      let value = baseValue;
      for (let layer = 0; layer < layers; layer++) {
        value = Math.round(255 * alpha + value * (1 - alpha));
      }
      const index = ((position.y + row) * width + position.x + col) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }

  return imageData;
}

function createImageDataWithWeakAlphaPattern(config: WatermarkConfig): ImageData {
  const imageData = createImageDataWithWatermark(config, 0);
  const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const alpha = TEST_ALPHA_MAP[row * position.width + col];
      const value = Math.round(80 + alpha * 60);
      const index = ((position.y + row) * imageData.width + position.x + col) * 4;
      imageData.data[index] = value;
      imageData.data[index + 1] = value;
      imageData.data[index + 2] = value;
    }
  }

  return imageData;
}

function createTestAnchorOption(config: WatermarkConfig): WatermarkAnchorOption {
  return {
    config,
    alphaMap: TEST_ALPHA_MAP,
  };
}

function writeGrayscalePattern(
  imageData: ImageData,
  config: WatermarkConfig,
  values: number[],
): void {
  const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const value = values[row * position.width + col];
      const index = ((position.y + row) * imageData.width + position.x + col) * 4;
      imageData.data[index] = value;
      imageData.data[index + 1] = value;
      imageData.data[index + 2] = value;
    }
  }
}

function writeSyntheticWatermark(
  imageData: ImageData,
  config: WatermarkConfig,
  alphaMap: Float32Array,
  basePattern: number[],
): void {
  const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const alphaIndex = row * position.width + col;
      const alpha = alphaMap[alphaIndex];
      const value = Math.round(255 * alpha + basePattern[alphaIndex] * (1 - alpha));
      const imageIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
      imageData.data[imageIndex] = value;
      imageData.data[imageIndex + 1] = value;
      imageData.data[imageIndex + 2] = value;
    }
  }
}

function fillRegionAboveWatermark(
  imageData: ImageData,
  config: WatermarkConfig,
  value: number,
): void {
  const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const index = ((position.y - position.height + row) * imageData.width + position.x + col) * 4;
      imageData.data[index] = value;
      imageData.data[index + 1] = value;
      imageData.data[index + 2] = value;
    }
  }
}

function expectWatermarkAreaNearBase(imageData: ImageData, config: WatermarkConfig): void {
  const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

  for (let row = 0; row < position.height; row++) {
    for (let col = 0; col < position.width; col++) {
      const alpha = TEST_ALPHA_MAP[row * position.width + col];
      if (alpha < 0.08) continue;

      const index = ((position.y + row) * imageData.width + position.x + col) * 4;
      expect(Math.abs(imageData.data[index] - 80)).toBeLessThanOrEqual(1);
      expect(Math.abs(imageData.data[index + 1] - 80)).toBeLessThanOrEqual(1);
      expect(Math.abs(imageData.data[index + 2] - 80)).toBeLessThanOrEqual(1);
    }
  }
}

describe('watermarkEngine config detection', () => {
  it('accepts a difficult match only when both signals improve and removal stays safe', () => {
    const assessment = assessDifficultWatermarkRemovalCandidate(
      { spatialScore: 0.25, gradientScore: 0.2 },
      { spatialScore: -0.1, gradientScore: 0.1 },
      0.099,
    );

    expect(assessment.originalStrength).toBeCloseTo(0.185);
    expect(assessment.finalResidualStrength).toBeCloseTo(0.08);
    expect(assessment.suppression).toBeCloseTo(0.105);
    expect(assessment.eligible).toBe(true);
  });

  it.each([
    {
      name: 'suppression equals the strict minimum',
      originalSignal: { spatialScore: 0.2, gradientScore: 0.1 },
      finalSignal: { spatialScore: 0.1, gradientScore: 0 },
      severeUndershootRatio: 0,
    },
    {
      name: 'severe undershoot equals the strict maximum',
      originalSignal: { spatialScore: 0.25, gradientScore: 0.2 },
      finalSignal: { spatialScore: -0.1, gradientScore: 0.1 },
      severeUndershootRatio: 0.1,
    },
    {
      name: 'spatial correlation does not decrease',
      originalSignal: { spatialScore: 0.2, gradientScore: 0.5 },
      finalSignal: { spatialScore: -0.2, gradientScore: 0 },
      severeUndershootRatio: 0,
    },
    {
      name: 'gradient correlation does not decrease',
      originalSignal: { spatialScore: 0.25, gradientScore: 0.1 },
      finalSignal: { spatialScore: 0.05, gradientScore: 0.1 },
      severeUndershootRatio: 0,
    },
  ])(
    'rejects a difficult match when $name',
    ({ originalSignal, finalSignal, severeUndershootRatio }) => {
      expect(
        assessDifficultWatermarkRemovalCandidate(originalSignal, finalSignal, severeUndershootRatio)
          .eligible,
      ).toBe(false);
    },
  );

  it('selects the strongest difficult candidate without retaining trial pixels', () => {
    const weakConfig = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const strongConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createSolidImageData();
    writeSyntheticWatermark(
      imageData,
      weakConfig,
      WEAK_DIFFICULT_ALPHA_MAP,
      WEAK_DIFFICULT_BASE_PATTERN,
    );
    writeSyntheticWatermark(
      imageData,
      strongConfig,
      STRONG_DIFFICULT_ALPHA_MAP,
      STRONG_DIFFICULT_BASE_PATTERN,
    );
    const originalPixels = new Uint8ClampedArray(imageData.data);
    const weakOption = { config: weakConfig, alphaMap: WEAK_DIFFICULT_ALPHA_MAP };
    const strongOption = { config: strongConfig, alphaMap: STRONG_DIFFICULT_ALPHA_MAP };

    for (const option of [weakOption, strongOption]) {
      const position = calculateWatermarkPosition(imageData.width, imageData.height, option.config);
      expect(
        hasReliableWatermarkSignal(measureWatermarkSignal(imageData, option.alphaMap, position)),
      ).toBe(false);
    }

    expect(chooseDifficultWatermarkAnchorOption(imageData, [weakOption])).toBe(weakOption);
    expect(chooseDifficultWatermarkAnchorOption(imageData, [strongOption])).toBe(strongOption);
    expect(chooseDifficultWatermarkAnchorOption(imageData, [weakOption, strongOption])).toBe(
      strongOption,
    );
    expect(imageData.data).toEqual(originalPixels);
  });

  it('finds a difficult small watermark at a snapped offset', () => {
    const baseConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520-small' as const,
    };
    const shiftedConfig = {
      ...baseConfig,
      marginRight: 7,
      marginBottom: 10,
    };
    const imageData = createSolidImageData();
    writeSyntheticWatermark(
      imageData,
      shiftedConfig,
      STRONG_DIFFICULT_ALPHA_MAP,
      STRONG_DIFFICULT_BASE_PATTERN,
    );
    const originalPixels = new Uint8ClampedArray(imageData.data);

    expect(
      chooseDifficultWatermarkAnchorOption(imageData, [
        { config: baseConfig, alphaMap: STRONG_DIFFICULT_ALPHA_MAP },
      ])?.config,
    ).toEqual(shiftedConfig);
    expect(imageData.data).toEqual(originalPixels);
  });

  it('leaves trial pixels unchanged when no difficult candidate qualifies', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createSolidImageData();
    const originalPixels = new Uint8ClampedArray(imageData.data);

    expect(
      chooseDifficultWatermarkAnchorOption(imageData, [
        { config, alphaMap: STRONG_DIFFICULT_ALPHA_MAP },
      ]),
    ).toBeUndefined();
    expect(imageData.data).toEqual(originalPixels);
  });

  it('applies an accepted difficult candidate exactly once', () => {
    const config = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createSolidImageData();
    writeSyntheticWatermark(
      imageData,
      config,
      STRONG_DIFFICULT_ALPHA_MAP,
      STRONG_DIFFICULT_BASE_PATTERN,
    );
    const expected = {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height,
    } as ImageData;
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
    removeWatermark(expected, STRONG_DIFFICULT_ALPHA_MAP, position);

    removeWatermarkFromAnchorOptions(imageData, [{ config, alphaMap: STRONG_DIFFICULT_ALPHA_MAP }]);

    expect(imageData.data).toEqual(expected.data);
  });

  it('does not enter the difficult path after a trusted candidate is rolled back', () => {
    const trustedConfig = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const difficultConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createImageDataWithWeakAlphaPattern(trustedConfig);
    writeSyntheticWatermark(
      imageData,
      difficultConfig,
      STRONG_DIFFICULT_ALPHA_MAP,
      STRONG_DIFFICULT_BASE_PATTERN,
    );
    const originalPixels = new Uint8ClampedArray(imageData.data);
    const trustedPosition = calculateWatermarkPosition(
      imageData.width,
      imageData.height,
      trustedConfig,
    );
    const difficultPosition = calculateWatermarkPosition(
      imageData.width,
      imageData.height,
      difficultConfig,
    );
    expect(
      hasReliableWatermarkSignal(
        measureWatermarkSignal(imageData, TEST_ALPHA_MAP, trustedPosition),
      ),
    ).toBe(true);
    expect(
      hasReliableWatermarkSignal(
        measureWatermarkSignal(imageData, STRONG_DIFFICULT_ALPHA_MAP, difficultPosition),
      ),
    ).toBe(false);

    removeWatermarkFromAnchorOptions(imageData, [
      { config: trustedConfig, alphaMap: TEST_ALPHA_MAP },
      { config: difficultConfig, alphaMap: STRONG_DIFFICULT_ALPHA_MAP },
    ]);

    expect(imageData.data).toEqual(originalPixels);
  });

  it('accepts a safely suppressed residual measured from a real moved-anchor output', () => {
    const candidateSignal = {
      spatialScore: 0.2143191174,
      gradientScore: 0.1471584466,
    };

    expect(hasReliableWatermarkSignal(candidateSignal)).toBe(false);
    expect(hasAcceptableWatermarkRemovalEvidence(candidateSignal, 0.3951623107)).toBe(true);
  });

  it('accepts a full-size residual once removal makes the watermark signal unreliable', () => {
    const candidateSignal = {
      spatialScore: 0.2565236249,
      gradientScore: 0.3808002233,
    };

    expect(hasReliableWatermarkSignal(candidateSignal)).toBe(false);
    expect(hasAcceptableWatermarkRemovalEvidence(candidateSignal, 0.2442947403)).toBe(true);
  });

  it('accepts a pale-background removal when spatial evidence clears but gradients remain', () => {
    const candidateSignal = {
      spatialScore: -0.103115824,
      gradientScore: 0.6026689081,
    };

    expect(hasReliableWatermarkSignal(candidateSignal)).toBe(false);
    expect(hasAcceptableWatermarkRemovalEvidence(candidateSignal, 0.2945188229)).toBe(true);
  });

  it('rejects an unreliable residual when removal did not suppress its spatial signal', () => {
    expect(
      hasAcceptableWatermarkRemovalEvidence(
        {
          spatialScore: 0.2143191174,
          gradientScore: 0.1471584466,
        },
        0,
      ),
    ).toBe(false);
  });

  it('keeps the reliability-transition fallback narrow enough to reject weak suppression', () => {
    expect(
      hasAcceptableWatermarkRemovalEvidence(
        {
          spatialScore: 0.2565236249,
          gradientScore: 0.3808002233,
        },
        0.19,
      ),
    ).toBe(false);
  });

  it('keeps historical detection as the default for full-size 2816x1536 outputs', () => {
    expect(detectWatermarkConfig(2816, 1536)).toEqual({
      logoSize: 96,
      marginRight: 64,
      marginBottom: 64,
    });
  });

  it('offers old and May 2026 anchors for full-size 2816x1536 outputs', () => {
    const options = getWatermarkConfigOptions(2816, 1536);

    expect(options).toEqual([
      {
        logoSize: 96,
        marginRight: 64,
        marginBottom: 64,
      },
      {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520',
      },
    ]);
    expect(calculateWatermarkPosition(2816, 1536, options[1])).toEqual({
      x: 2528,
      y: 1248,
      width: 96,
      height: 96,
    });
  });

  it('offers old and May 2026 anchors for half-size 16:9 preview images', () => {
    const options = getWatermarkConfigOptions(1408, 768);

    expect(options).toEqual([
      {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32,
      },
      {
        logoSize: 36,
        marginRight: 98,
        marginBottom: 98,
        alphaVariant: '20260520-small',
      },
      {
        logoSize: 48,
        marginRight: 96,
        marginBottom: 96,
        alphaVariant: '20260520',
      },
    ]);
    expect(calculateWatermarkPosition(1408, 768, options[1])).toEqual({
      x: 1274,
      y: 634,
      width: 36,
      height: 36,
    });
    expect(calculateWatermarkPosition(1408, 768, options[2])).toEqual({
      x: 1264,
      y: 624,
      width: 48,
      height: 48,
    });
  });

  it('offers the moved anchor for square outputs', () => {
    expect(getWatermarkConfigOptions(1024, 1024)).toEqual([
      {
        logoSize: 48,
        marginRight: 32,
        marginBottom: 32,
      },
      {
        logoSize: 36,
        marginRight: 71,
        marginBottom: 71,
        alphaVariant: '20260520-small',
      },
      {
        logoSize: 48,
        marginRight: 96,
        marginBottom: 96,
        alphaVariant: '20260520',
      },
    ]);
  });

  it('keeps the historical anchor first for other old-rule dimensions', () => {
    expect(getWatermarkConfigOptions(1376, 768)[0]).toEqual({
      logoSize: 48,
      marginRight: 32,
      marginBottom: 32,
    });
    expect(getWatermarkConfigOptions(2708, 1536)[0]).toEqual({
      logoSize: 96,
      marginRight: 64,
      marginBottom: 64,
    });
  });

  it('selects the historical anchor when the actual pixels still contain the old watermark', () => {
    const oldConfig = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const newConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createImageDataWithWatermark(oldConfig);

    expect(
      chooseWatermarkAnchorOption(imageData, [
        createTestAnchorOption(oldConfig),
        createTestAnchorOption(newConfig),
      ]).config,
    ).toBe(oldConfig);
  });

  it('selects the May 2026 anchor when the actual pixels contain the moved watermark', () => {
    const oldConfig = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const newConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createImageDataWithWatermark(newConfig);

    expect(
      chooseWatermarkAnchorOption(imageData, [
        createTestAnchorOption(oldConfig),
        createTestAnchorOption(newConfig),
      ]).config,
    ).toBe(newConfig);
  });

  it('prefers a reliable anchor over a stronger but unreliable candidate', () => {
    const oldConfig = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const newConfig = {
      logoSize: 4,
      marginRight: 9,
      marginBottom: 9,
      alphaVariant: '20260520' as const,
    };
    const imageData = createImageDataWithWatermark(oldConfig, 0);
    writeGrayscalePattern(
      imageData,
      oldConfig,
      [29, 49, 126, 66, 21, 97, 81, 47, 186, 39, 189, 109, 40, 25, 53, 120],
    );
    writeGrayscalePattern(
      imageData,
      newConfig,
      [109, 154, 46, 13, 72, 122, 166, 144, 93, 183, 94, 168, 172, 80, 145, 104],
    );

    const oldPosition = calculateWatermarkPosition(imageData.width, imageData.height, oldConfig);
    const newPosition = calculateWatermarkPosition(imageData.width, imageData.height, newConfig);
    const oldSignal = measureWatermarkSignal(imageData, TEST_ALPHA_MAP, oldPosition);
    const newSignal = measureWatermarkSignal(imageData, TEST_ALPHA_MAP, newPosition);
    expect(hasReliableWatermarkSignal(oldSignal)).toBe(false);
    expect(hasReliableWatermarkSignal(newSignal)).toBe(true);
    expect(getWatermarkSignalStrength(oldSignal)).toBeGreaterThan(
      getWatermarkSignalStrength(newSignal),
    );

    expect(
      chooseWatermarkAnchorOption(imageData, [
        createTestAnchorOption(oldConfig),
        createTestAnchorOption(newConfig),
      ]).config,
    ).toBe(newConfig);
  });

  it('removes a single transparent watermark layer in one pass', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createImageDataWithWatermark(config);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

    const passes = removeWatermarkWithResidualCheck(imageData, TEST_ALPHA_MAP, position);

    expect(passes).toBe(1);
    expectWatermarkAreaNearBase(imageData, config);
  });

  it('does not mistake unrelated brighter content above the watermark for removal damage', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const alphaMap = Float32Array.from([0, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0]);
    const imageData = createImageDataWithWatermark(config, 0);
    fillRegionAboveWatermark(imageData, config, 240);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);
    for (let row = 0; row < position.height; row++) {
      for (let col = 0; col < position.width; col++) {
        const alpha = alphaMap[row * position.width + col];
        const value = alpha === 0 ? 81 : 168;
        const index = ((position.y + row) * imageData.width + position.x + col) * 4;
        imageData.data[index] = value;
        imageData.data[index + 1] = value;
        imageData.data[index + 2] = value;
      }
    }

    const passes = removeWatermarkWithResidualCheck(imageData, alphaMap, position);

    expect(passes).toBe(1);
    for (let row = 0; row < position.height; row++) {
      for (let col = 0; col < position.width; col++) {
        const index = ((position.y + row) * imageData.width + position.x + col) * 4;
        expect(imageData.data[index]).toBe(81);
        expect(imageData.data[index + 1]).toBe(81);
        expect(imageData.data[index + 2]).toBe(81);
      }
    }
  });

  it('repeats removal while a stacked watermark layer remains', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createImageDataWithWatermark(config, 2);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

    const passes = removeWatermarkWithResidualCheck(imageData, TEST_ALPHA_MAP, position);

    expect(passes).toBe(2);
    expectWatermarkAreaNearBase(imageData, config);
  });

  it('leaves a clean image pixel-identical when no watermark signal is present', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createImageDataWithWatermark(config, 0);
    const originalPixels = new Uint8ClampedArray(imageData.data);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

    const passes = removeWatermarkWithResidualCheck(imageData, TEST_ALPHA_MAP, position);

    expect(passes).toBe(0);
    expect(imageData.data).toEqual(originalPixels);
  });

  it('accepts clipped pixels that reconstruct a dark background without severe undershoot', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createImageDataWithWatermark(config, 1, 0);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

    expect(measureSevereUndershootRatio(imageData, TEST_ALPHA_MAP, position)).toBeLessThan(0.1);

    const passes = removeWatermarkWithResidualCheck(imageData, TEST_ALPHA_MAP, position);

    expect(passes).toBe(1);
    for (let row = 0; row < position.height; row++) {
      for (let col = 0; col < position.width; col++) {
        const index = ((position.y + row) * imageData.width + position.x + col) * 4;
        expect(imageData.data[index]).toBe(0);
        expect(imageData.data[index + 1]).toBe(0);
        expect(imageData.data[index + 2]).toBe(0);
      }
    }
  });

  it('rejects a watermark-like pattern when trial removal would clip pixels', () => {
    const config = { logoSize: 4, marginRight: 1, marginBottom: 1 };
    const imageData = createImageDataWithWeakAlphaPattern(config);
    const originalPixels = new Uint8ClampedArray(imageData.data);
    const position = calculateWatermarkPosition(imageData.width, imageData.height, config);

    expect(
      hasReliableWatermarkSignal(measureWatermarkSignal(imageData, TEST_ALPHA_MAP, position)),
    ).toBe(true);
    expect(
      measureSevereUndershootRatio(imageData, TEST_ALPHA_MAP, position),
    ).toBeGreaterThanOrEqual(0.1);

    const passes = removeWatermarkWithResidualCheck(imageData, TEST_ALPHA_MAP, position);

    expect(passes).toBe(0);
    expect(imageData.data).toEqual(originalPixels);
  });
});
