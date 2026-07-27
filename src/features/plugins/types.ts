/**
 * Gemini Voyager — Plugin Ecosystem: core type contracts.
 *
 * Design goals (see ./README.md):
 *  - **Declarative-first.** The default plugin tier ships only data (CSS + JSON
 *    describing DOM operations). The interpreting engine lives in the extension
 *    package, so declarative plugins are Chrome MV3 "remotely-hosted code"
 *    compliant AND are almost certainly *not* GPL derivative works (data read by
 *    a program is not a derivative of it).
 *  - **Site-agnostic.** Plugins target sites via match patterns and reference DOM
 *    through a `SiteAdapter`'s semantic selector map, so a Gemini DOM change only
 *    requires updating the adapter, not every plugin.
 *  - **Extensible contribution points.** New capabilities are added as new keys on
 *    `PluginContributions` / new variants on `DomOperation` — never by letting a
 *    plugin run arbitrary top-level code.
 */

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const KNOWN_SITE_IDS = ['gemini', 'aistudio', 'chatgpt', 'claude', 'grok'] as const;
export type KnownSiteId = (typeof KNOWN_SITE_IDS)[number];

/**
 * A site identifier. Known ids get editor autocomplete; arbitrary strings are
 * still allowed so third parties can target sites Voyager ships no adapter for.
 */
export type SiteId = KnownSiteId | (string & {});

/** Coarse feature flags describing what a site exposes; lets plugins/host skip
 *  contributions a site can't support. */
export type SiteCapability = 'chat' | 'sidebar' | 'composer' | 'darkMode';

export interface SiteThemeDescriptor {
  /** Element that carries the theme class (e.g. `.theme-host` on Gemini, `body` on AI Studio). */
  readonly hostSelector: string;
  /** Selector present when the site is in light mode. */
  readonly lightSelector: string;
  /** Selector present when the site is in dark mode. */
  readonly darkSelector: string;
}

/**
 * Describes one host site. The plugin host resolves the adapter for the current
 * URL and hands it to the engine so `semantic` selector refs can be resolved.
 */
export interface SiteAdapter {
  readonly id: SiteId;
  readonly label: string;
  readonly matches: readonly string[];
  /**
   * Stable semantic key → site-specific CSS selector. Plugins reference keys
   * (not raw selectors) to stay portable across site redesigns.
   */
  readonly selectors: Readonly<Record<string, string>>;
  readonly theme: SiteThemeDescriptor;
  /**
   * Optional brand accent (hex) for Voyager's OWN UI when running on this site —
   * the Prompt Manager, formula-copy toast, popup. Acts as the built-in default;
   * a matching plugin's `theme.brand` overrides it. Omit (e.g. Gemini / AI
   * Studio) to keep Voyager's native green.
   */
  readonly brandColor?: string;
  readonly capabilities: ReadonlySet<SiteCapability>;
}

// ---------------------------------------------------------------------------
// Selector references
// ---------------------------------------------------------------------------

export interface CssSelectorRef {
  readonly kind: 'css';
  readonly selector: string;
}
export interface SemanticSelectorRef {
  readonly kind: 'semantic';
  readonly key: string;
}
export type SelectorRef = CssSelectorRef | SemanticSelectorRef;

/** Authoring sugar accepted in raw manifests: a bare string means a css selector. */
export type RawSelectorRef = string | SelectorRef;

export const cssRef = (selector: string): CssSelectorRef => ({ kind: 'css', selector });
export const semanticRef = (key: string): SemanticSelectorRef => ({ kind: 'semantic', key });

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export interface StyleContribution {
  /** Raw CSS injected as a <style> element. Classes should be `gv-` prefixed. */
  readonly css: string;
  /** Optional source path when the CSS came from a plugin-authored style file. */
  readonly source?: string;
}

/**
 * Declarative DOM operations interpreted by the bundled engine. Every variant is
 * fully reversible on teardown. New variants are the primary extension point —
 * add a case here + a handler in the engine; never execute plugin-authored code.
 */
export type DomOperation =
  | { readonly op: 'addClass'; readonly target: SelectorRef; readonly className: string }
  | {
      readonly op: 'setAttribute';
      readonly target: SelectorRef;
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly op: 'setStyle';
      readonly target: SelectorRef;
      readonly styles: Readonly<Record<string, string>>;
    }
  | { readonly op: 'hide'; readonly target: SelectorRef };

export type DomOperationKind = DomOperation['op'];

/** Schema for a user-configurable plugin setting (rendered by the store UI later). */
export interface SettingField {
  readonly type: 'boolean' | 'number' | 'string' | 'color' | 'select';
  readonly label: string;
  readonly default: boolean | number | string;
  /** Optional label for the low end of a number/range control. */
  readonly minLabel?: string;
  /** Optional label for the high end of a number/range control. */
  readonly maxLabel?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
}
export type SettingsSchema = Readonly<Record<string, SettingField>>;

/** A resolved user-configurable setting value. */
export type PluginSettingValue = string | number | boolean;
/** Resolved setting values for one plugin (keyed by the schema's keys). */
export type PluginSettings = Readonly<Record<string, PluginSettingValue>>;

export interface PluginContributions {
  readonly styles?: readonly StyleContribution[];
  readonly domOps?: readonly DomOperation[];
  readonly settings?: SettingsSchema;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * `declarative` = data only (CSS + JSON), interpreted by the engine. Store-safe
 * everywhere, remote-loadable, non-derivative.
 * `scripted` = ships JS; must run via `chrome.userScripts` (gated behind the
 * user's "Allow User Scripts" toggle) and is unavailable on Safari. Reserved for
 * an advanced tier; the v1 engine applies only its declarative contributions.
 */
export type PluginTier = 'declarative' | 'scripted';

/**
 * Plugin classification, shown in the store and used for filtering. Known values
 * get autocomplete; arbitrary strings are allowed so authors aren't boxed in.
 */
export const PLUGIN_CATEGORIES = [
  'render-fix',
  'theme',
  'layout',
  'readability',
  'productivity',
  'integration',
  'other',
] as const;
export type KnownPluginCategory = (typeof PLUGIN_CATEGORIES)[number];
export type PluginCategory = KnownPluginCategory | (string & {});

/**
 * Optional brand theming a plugin contributes for the site(s) it matches. The
 * author declares only a single accent `brand` (hex); Voyager derives the
 * hover / soft / foreground shades via CSS `color-mix`. Overrides the matching
 * `SiteAdapter.brandColor`.
 */
export interface PluginTheme {
  /** Accent colour as a hex string (e.g. `#d97757`). */
  readonly brand: string;
}

export interface LocalizedSettingField {
  readonly label?: string;
  readonly minLabel?: string;
  readonly maxLabel?: string;
}

export interface PluginLocalization {
  readonly name?: string;
  readonly description?: string;
  readonly settings?: Readonly<Record<string, LocalizedSettingField>>;
}

export interface PluginManifest {
  /** Globally unique, reverse-dotted (e.g. `vendor.my-plugin`). */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  /** Classification (e.g. `render-fix`, `theme`, `readability`). */
  readonly category: PluginCategory;
  /** SPDX expression (e.g. `MIT`, `GPL-3.0-or-later`, `Proprietary`). */
  readonly license: string;
  readonly homepage?: string;
  /** Semver range the plugin requires of the host engine (e.g. `>=1.0.0`). */
  readonly engine: string;
  readonly tier: PluginTier;
  /** URL match patterns the plugin applies to (glob subset of Chrome match patterns). */
  readonly matches: readonly string[];
  readonly contributes: PluginContributions;
  /** Optional brand accent for Voyager UI on the matched site(s). */
  readonly theme?: PluginTheme;
  /**
   * Optional localized metadata and setting labels, keyed by app language code
   * (`en`, `zh`, `zh_TW`, `ja`, …). Per-field fallback to the top-level English
   * fields when a translation is missing.
   */
  readonly i18n?: Readonly<Record<string, PluginLocalization>>;
}

/** Where an installed plugin came from. Drives trust + update behaviour. */
export type PluginSourceRef =
  | { readonly type: 'builtin' }
  | { readonly type: 'local' }
  | { readonly type: 'marketplace'; readonly marketplaceId: string; readonly url?: string };

/** Whether the user is allowed to run a plugin (paywall seam). */
export type EntitlementState = 'free' | 'entitled' | 'trial' | 'locked';

export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly source: PluginSourceRef;
  readonly enabled: boolean;
  readonly entitlement: EntitlementState;
}

// ---------------------------------------------------------------------------
// Provider seams (swap implementations to add a marketplace / paid store)
// ---------------------------------------------------------------------------

/** A place plugin manifests come from (builtin bundle now; git marketplace later). */
export interface PluginSource {
  readonly id: string;
  list(): Promise<readonly PluginManifest[]>;
}

/** Decides whether a plugin may run (always `free` now; account/Stripe later). */
export interface EntitlementProvider {
  getState(pluginId: string): Promise<EntitlementState>;
}
