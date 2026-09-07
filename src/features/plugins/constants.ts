/**
 * Plugin ecosystem — shared constants.
 *
 * Single source of truth for the magic strings/numbers used across the engine,
 * host, sources and tests. Anything injected into the page follows the `gv-`
 * prefix rule from `.claude/rules/content-scripts.md`; plugin-scoped artifacts
 * add a `plugin-` segment so they never clash with first-party Voyager classes.
 */

/**
 * Semantic version of the plugin runtime contract. Plugins declare an `engine`
 * semver range (e.g. `>=1.0.0`); the host refuses to activate plugins whose
 * range this version does not satisfy. Bump the MAJOR when a change to the
 * manifest/contribution shape is backwards-incompatible.
 */
export const PLUGIN_ENGINE_VERSION = '1.4.0';

/** Manifest format major this engine understands (plan §5). */
export const PLUGIN_MANIFEST_FORMAT = 1;

/** Plugin-scoped CSS class prefix. Authors should namespace classes under this. */
export const PLUGIN_CLASS_PREFIX = 'gv-plugin-';

/** Class toggled by the declarative `hide` op; backed by the engine base stylesheet. */
export const PLUGIN_HIDDEN_CLASS = 'gv-plugin-hidden';

/** id of the single base stylesheet the engine injects once (hosts the `hide` rule). */
export const PLUGIN_BASE_STYLE_ID = 'gv-plugin-base-style';

/** Prefix for a per-plugin injected <style> element id. */
export const PLUGIN_STYLE_ID_PREFIX = 'gv-plugin-style-';

/** Marker attribute placed on per-plugin injected elements (debugging + teardown). */
export const PLUGIN_MARKER_ATTR = 'data-gv-plugin';

/** Safety ceiling: a single plugin may not declare more DOM ops than this. */
export const MAX_DOM_OPS = 500;

/** Safety ceiling on a single injected stylesheet length (chars), to bound abuse. */
export const MAX_STYLE_LENGTH = 200_000;
