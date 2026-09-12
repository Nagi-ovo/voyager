export const CHATGPT_TIMELINE_TRACK_PADDING_PX = 16;
export const CHATGPT_TIMELINE_MARKER_MIN_GAP_PX = 24;

export interface ChatGptTimelineGeometry {
  readonly contentHeight: number;
  readonly markerTops: number[];
}

/** Map cached shell centers onto the rail while preserving spatial gaps and order. */
export function calculateChatGptTimelineGeometry(
  centers: readonly number[],
  scrollHeight: number,
  viewportHeight: number,
  padding = CHATGPT_TIMELINE_TRACK_PADDING_PX,
  minGap = CHATGPT_TIMELINE_MARKER_MIN_GAP_PX,
): ChatGptTimelineGeometry {
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1);
  const safePadding = Math.max(0, Number.isFinite(padding) ? padding : 0);
  const safeMinGap = Math.max(0, Number.isFinite(minGap) ? minGap : 0);
  const contentHeight = Math.max(
    safeViewportHeight,
    safePadding * 2 + Math.max(0, centers.length - 1) * safeMinGap,
  );
  if (!centers.length) return { contentHeight, markerTops: [] };

  const extent = Math.max(1, Number.isFinite(scrollHeight) ? scrollHeight : 1);
  const usableHeight = Math.max(1, contentHeight - safePadding * 2);
  let previousCenter = 0;
  const markerTops = centers.map((center) => {
    const finiteCenter = Number.isFinite(center) ? center : previousCenter;
    previousCenter = Math.max(previousCenter, finiteCenter);
    return safePadding + Math.max(0, Math.min(1, previousCenter / extent)) * usableHeight;
  });

  for (let index = 1; index < markerTops.length; index += 1) {
    markerTops[index] = Math.max(markerTops[index], markerTops[index - 1] + safeMinGap);
  }

  const maxTop = safePadding + usableHeight;
  if (markerTops[markerTops.length - 1] > maxTop) {
    markerTops[markerTops.length - 1] = maxTop;
    for (let index = markerTops.length - 2; index >= 0; index -= 1) {
      markerTops[index] = Math.min(markerTops[index], markerTops[index + 1] - safeMinGap);
    }
  }

  for (let index = 0; index < markerTops.length; index += 1) {
    markerTops[index] = Math.max(safePadding, Math.min(maxTop, markerTops[index]));
  }
  return { contentHeight, markerTops };
}
