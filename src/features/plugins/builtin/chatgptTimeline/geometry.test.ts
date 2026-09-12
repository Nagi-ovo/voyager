import { describe, expect, it } from 'vitest';

import { calculateChatGptTimelineGeometry } from './geometry';

describe('ChatGPT timeline geometry', () => {
  it('maps uneven shell centers to uneven positions in the full scroll extent', () => {
    const geometry = calculateChatGptTimelineGeometry([400, 1600, 3600], 4000, 500);

    expect(geometry.contentHeight).toBe(500);
    expect(geometry.markerTops[0]).toBeCloseTo(62.8, 1);
    expect(geometry.markerTops[1]).toBeCloseTo(203.2, 1);
    expect(geometry.markerTops[2]).toBeCloseTo(437.2, 1);
    expect(geometry.markerTops[2] - geometry.markerTops[1]).toBeGreaterThan(
      geometry.markerTops[1] - geometry.markerTops[0],
    );
  });

  it('expands a dense track and preserves the minimum marker gap', () => {
    const centers = Array.from({ length: 25 }, (_, index) => 1800 + index * 10);
    const geometry = calculateChatGptTimelineGeometry(centers, 4000, 400);

    expect(geometry.contentHeight).toBe(608);
    for (let index = 1; index < geometry.markerTops.length; index += 1) {
      expect(geometry.markerTops[index] - geometry.markerTops[index - 1]).toBeGreaterThanOrEqual(
        24,
      );
    }
  });

  it('handles empty, single, and stale non-monotonic center samples', () => {
    expect(calculateChatGptTimelineGeometry([], 4000, 400)).toEqual({
      contentHeight: 400,
      markerTops: [],
    });
    expect(calculateChatGptTimelineGeometry([2000], 4000, 400).markerTops[0]).toBe(200);

    const stale = calculateChatGptTimelineGeometry([1000, 900, 2500], 4000, 400);
    expect(stale.markerTops[1] - stale.markerTops[0]).toBeGreaterThanOrEqual(24);
    expect(stale.markerTops[2]).toBeGreaterThan(stale.markerTops[1]);
  });
});
