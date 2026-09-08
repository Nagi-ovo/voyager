const LEGACY_BASELINE_PX = 1200; // used to migrate old px widths to %
const pxFromPercent = (percent: number) => (percent / 100) * LEGACY_BASELINE_PX;

export const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

export const normalizePercent = (
  value: number,
  fallback: number,
  min: number,
  max: number,
  legacyBaselinePx: number,
) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > max) {
    const approx = (value / legacyBaselinePx) * 100;
    return clampPercent(approx, min, max);
  }
  return clampPercent(value, min, max);
};

export const FOLDER_SPACING = { min: 0, max: 16, defaultValue: 2 };
export const FOLDER_TREE_INDENT = { min: -8, max: 32, defaultValue: -8 };
// Gems sidebar count: 0 disables the section entirely (no UI), 1-10 shows
// that many recent gems above Notebooks.
export const GEMS_SIDEBAR_COUNT = { min: 0, max: 10, defaultValue: 3 };
export const CHAT_PERCENT = {
  min: 30,
  max: 100,
  defaultValue: 70,
  legacyBaselinePx: LEGACY_BASELINE_PX,
};
export const CHAT_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
export const CHAT_LINE_HEIGHT = { min: 120, max: 220, defaultValue: 160 };
export const CHAT_PARAGRAPH_SPACING = { min: 0, max: 24, defaultValue: 12 };
export const EDIT_PERCENT = {
  min: 30,
  max: 100,
  defaultValue: 60,
  legacyBaselinePx: LEGACY_BASELINE_PX,
};
const SIDEBAR_PERCENT = {
  min: 15,
  max: 45,
  defaultValue: 26,
  legacyBaselinePx: LEGACY_BASELINE_PX,
};
export const SIDEBAR_PX = {
  min: Math.round(pxFromPercent(SIDEBAR_PERCENT.min)),
  max: Math.round(pxFromPercent(SIDEBAR_PERCENT.max)),
  defaultValue: Math.round(pxFromPercent(SIDEBAR_PERCENT.defaultValue)),
};
export const AI_STUDIO_SIDEBAR_PX = {
  min: 240,
  max: 600,
  defaultValue: 280,
};

const clampSidebarPx = (value: number) => clampNumber(value, SIDEBAR_PX.min, SIDEBAR_PX.max);
export const normalizeSidebarPx = (value: number) => {
  if (!Number.isFinite(value)) return SIDEBAR_PX.defaultValue;
  // If the stored value looks like a legacy percent, convert to px first.
  if (value <= SIDEBAR_PERCENT.max) {
    const px = pxFromPercent(value);
    return clampSidebarPx(px);
  }
  return clampSidebarPx(value);
};
