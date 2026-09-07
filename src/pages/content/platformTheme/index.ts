/**
 * Per-site brand accent for ALL Voyager UI (timeline, Prompt Manager, FAB,
 * formula toast, popup). The accent COLOUR is data, not hard-coded CSS, and is
 * stored PER SITE. It resolves, for the current site, to:
 *   1. the user's saved per-site override (StorageKeys.ACCENT_COLORS[siteId]),
 *   2. else a URL-matching, caller-active plugin that declares `theme.brand`,
 *   3. else the SiteAdapter's built-in `brandColor` (claude clay / chatgpt sky),
 *   4. else null → no inline override; Gemini / AI Studio fall back to the
 *      theme-aware Everforest sage default defined on :root in contentStyle.css.
 *
 * `applyBrandTheme` injects the resolved colour into the `--gv-pm-brand` custom
 * property on the document root (<html>) — plus a luminance-matched
 * `--gv-pm-brand-fg` so text/icons stay readable on light accents — and toggles
 * the `gv-platform-themed` class. Putting it on the root (not <body>) means the
 * variable is inherited by Voyager UI no matter where it mounts (body subtree,
 * html-level portal, even across a shadow boundary). `contentStyle.css` defines
 * the sage default + derives hover/soft from that single variable via
 * `color-mix`, and the whole green palette re-hues from it via relative colour
 * syntax — so one variable repaints everything.
 *
 * Platform detection reuses the plugin SiteRegistry adapters so there's a single
 * source of truth for "which site am I on".
 */
import { StorageKeys } from '@/core/types/common';
import { subscribeHostCatalog } from '@/features/plugins/remote/hostCatalogCache';
import { catalogHostFromUrl } from '@/features/plugins/remote/hostCatalogPolicy';
import {
  loadSiteOverrideForHost,
  resolveSiteAdapterForUrl,
} from '@/features/plugins/remote/siteOverride';
import { matchesAnyPattern } from '@/features/plugins/sites/matchPattern';
import { SiteRegistry } from '@/features/plugins/sites/registry';
import { listPluginManifests } from '@/features/plugins/sources/defaultSources';
import { loadPluginState, subscribePluginState } from '@/features/plugins/storage/pluginState';
import type { PluginManifest, SiteAdapter } from '@/features/plugins/types';

/** Body class flag: Voyager UI on this page uses a platform brand accent. */
export const PLATFORM_THEME_CLASS = 'gv-platform-themed';
const BRAND_VAR = '--gv-pm-brand';
const BRAND_FG_VAR = '--gv-pm-brand-fg';
const BRAND_HUE_VAR = '--gv-pm-brand-h';

/** Per-site custom accent overrides: Record<siteId, colorString>. */
export type AccentColorMap = Readonly<Record<string, string>>;

/**
 * The Gemini/AI-Studio "standard" accent (Everforest sage, light variant). Used
 * only for DISPLAY in the popup swatch / as the value the picker resets to;
 * the actual applied default is the theme-aware sage defined in contentStyle.css,
 * so we never inline-set it (we remove the inline var to let CSS win).
 */
export const DEFAULT_ACCENT = '#5f8f55';
/** Dark foreground for use on light accent backgrounds (Everforest-ish ink). */
const DARK_FG = '#1f2a24';

/** SiteAdapter id for `url`, or null when no adapter matches. */
export function resolveSiteId(url: string = location.href): string | null {
  return SiteRegistry.createDefault().resolveByUrl(url)?.id ?? null;
}

/** Parse #rgb / #rrggbb to linearized sRGB [r, g, b] in 0..1, or null. */
function hexToLinearRgb(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) return null;
  const toLin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [
    toLin(parseInt(full.slice(0, 2), 16)),
    toLin(parseInt(full.slice(2, 4), 16)),
    toLin(parseInt(full.slice(4, 6), 16)),
  ];
}

/**
 * Pick a readable foreground (#fff or dark ink) for text/icons sitting on a
 * solid `color` background, via sRGB relative luminance. Only hex is parsed
 * (every inline-set accent — adapter colours + the native colour picker — is
 * hex); anything else falls back to white.
 */
export function readableForeground(color: string): string {
  const rgb = hexToLinearRgb(color);
  if (!rgb) return '#ffffff';
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 0.42 ? DARK_FG : '#ffffff';
}

/**
 * The OKLCH hue (degrees) of `color`. Injected as --gv-pm-brand-h so the whole
 * accent palette re-hues via oklch(L C var(--gv-pm-brand-h)) — far more
 * compatible than the CSS relative-colour `oklch(from …)` syntax. Returns null
 * for unparseable or (near-)greyscale colours, where hue is meaningless and the
 * theme-aware default hue should stand.
 */
export function accentHue(color: string): number | null {
  const rgb = hexToLinearRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(a, bAxis) < 0.002) return null; // (near-)grey → keep default hue
  const hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
  return hue < 0 ? hue + 360 : hue;
}

/**
 * Resolve the brand accent (hex) for Voyager UI on `url`. `manifests` should be
 * the plugins the caller treats as active (enabled + relevant); the first one
 * matching the URL that declares `theme.brand` wins, otherwise the matching
 * `SiteAdapter.brandColor`, otherwise null (keep Voyager green).
 */
export function resolveBrandColor(
  url: string = location.href,
  manifests: readonly PluginManifest[] = [],
  customColors: AccentColorMap = {},
  adapter: SiteAdapter | null = SiteRegistry.createDefault().resolveByUrl(url),
): string | null {
  // 1. Per-site user override wins over everything for this site.
  const custom = adapter?.id ? customColors[adapter.id] : undefined;
  if (typeof custom === 'string' && custom.trim()) return custom;
  // 2. A URL-matching, caller-active plugin that declares theme.brand.
  const fromPlugin = manifests.find((m) => m.theme?.brand && matchesAnyPattern(url, m.matches));
  if (fromPlugin?.theme?.brand) return fromPlugin.theme.brand;
  // 3. The adapter's built-in brand colour (claude / chatgpt / …).
  // 4. else null → Gemini / AI Studio keep the theme-aware sage CSS default.
  return adapter?.brandColor ?? null;
}

/**
 * The accent colour to DISPLAY for `url` (never null) — the per-site override
 * if set, else the resolved brand colour, else the Everforest sage default.
 * Used by the popup colour-picker swatch and "reset to default" affordance.
 */
export function effectiveAccentForDisplay(
  url: string = location.href,
  manifests: readonly PluginManifest[] = [],
  customColors: AccentColorMap = {},
  adapter: SiteAdapter | null = SiteRegistry.createDefault().resolveByUrl(url),
): string {
  return resolveBrandColor(url, manifests, customColors, adapter) ?? DEFAULT_ACCENT;
}

/**
 * Inject (or clear) the platform brand accent on the document root (<html>).
 * Adds the `gv-platform-themed` class + `--gv-pm-brand` when a colour resolves;
 * removes both when none does, so un-themed sites fall back to Voyager green.
 * The root element always exists, so no DOMContentLoaded wait is needed.
 * Idempotent.
 */
export function applyBrandTheme(
  url: string = location.href,
  manifests: readonly PluginManifest[] = [],
  doc: Document = document,
  customColors: AccentColorMap = {},
  adapter: SiteAdapter | null = SiteRegistry.createDefault().resolveByUrl(url),
): void {
  const color = resolveBrandColor(url, manifests, customColors, adapter);
  const root = doc.documentElement;
  if (!root) return;
  if (color) {
    root.classList.add(PLATFORM_THEME_CLASS);
    root.style.setProperty(BRAND_VAR, color);
    root.style.setProperty(BRAND_FG_VAR, readableForeground(color));
    const hue = accentHue(color);
    if (hue !== null) root.style.setProperty(BRAND_HUE_VAR, `${hue}`);
    else root.style.removeProperty(BRAND_HUE_VAR);
  } else {
    root.classList.remove(PLATFORM_THEME_CLASS);
    root.style.removeProperty(BRAND_VAR);
    root.style.removeProperty(BRAND_FG_VAR);
    root.style.removeProperty(BRAND_HUE_VAR);
  }
}

/** Read the per-site accent override map from sync storage; {} on any failure. */
async function loadAccentColors(): Promise<AccentColorMap> {
  try {
    const result = await chrome.storage.sync.get(StorageKeys.ACCENT_COLORS);
    const value = result[StorageKeys.ACCENT_COLORS];
    return value && typeof value === 'object' ? (value as AccentColorMap) : {};
  } catch {
    return {};
  }
}

/**
 * Start live platform theming for the content script: apply the adapter's
 * built-in accent immediately, then re-resolve whenever the plugin catalog or
 * enable-state changes so an enabled plugin's declared `theme.brand` can take
 * over (or step back when disabled). Returns a cleanup that detaches the
 * subscriptions. Used by the content entry; `applyBrandTheme` stays the pure,
 * one-shot primitive for tests and the immediate first paint.
 */
export function startBrandTheme(url: string = location.href, doc: Document = document): () => void {
  applyBrandTheme(url, [], doc); // immediate: adapter built-in colour (pre-storage)
  let cancelled = false;
  const host = catalogHostFromUrl(url);
  const registry = SiteRegistry.createDefault();
  const recompute = async (): Promise<void> => {
    const [manifests, state, customColors, override] = await Promise.all([
      listPluginManifests(undefined, { url, host }),
      loadPluginState(),
      loadAccentColors(),
      loadSiteOverrideForHost(host),
    ]);
    if (cancelled) return;
    const active = manifests.filter((m) => m.theme?.brand && state[m.id]?.enabled);
    // A published site override can change the brand colour without a release.
    const adapter = resolveSiteAdapterForUrl(url, registry, override);
    applyBrandTheme(url, active, doc, customColors, adapter);
  };
  void recompute();
  const unState = subscribePluginState(() => void recompute());
  // A remote catalog update for this host can add or drop a plugin's theme.brand.
  const unCatalog = host ? subscribeHostCatalog(host, () => void recompute()) : () => {};
  // Repaint live when the per-site accent override changes in the popup.
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'sync' && StorageKeys.ACCENT_COLORS in changes) void recompute();
  };
  chrome.storage?.onChanged?.addListener(onStorage);
  return () => {
    cancelled = true;
    unState();
    unCatalog();
    chrome.storage?.onChanged?.removeListener(onStorage);
  };
}
