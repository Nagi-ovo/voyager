/**
 * Plugin status machine (plan §4.2, D8).
 *
 * `PluginHost` reports a status for every plugin that targets the page
 * instead of silently filtering incompatible ones, so the popup can show a
 * disabled toggle WITH a reason:
 *
 *   needs-engine     the manifest's `engine` range is above this build
 *   needs-handler    a primitive it invokes is not in this build
 *   needs-semantic   the site adapter lacks a semantic key it relies on
 *   ready            compatible, not enabled (or enabled and not yet mounted)
 *   mounted          enabled and running on this page
 *   no-effect        mounted, but the health signal found no targets (D12)
 *
 * `needs-permission` (a new origin not yet granted) is decided by the popup,
 * which owns the permission flow; a content script that is running already
 * has its permission.
 */
import { PLUGIN_ENGINE_VERSION } from '../constants';
import { engineSatisfied } from '../semver';
import type { PluginManifest, SiteAdapter } from '../types';
import { getPrimitiveContract } from '../verbs/contracts';

export type PluginStatusKind =
  | 'needs-engine'
  | 'needs-handler'
  | 'needs-semantic'
  | 'ready'
  | 'mounted'
  | 'no-effect';

export interface PluginStatus {
  readonly id: string;
  readonly version: string;
  readonly kind: PluginStatusKind;
  /** For needs-engine: the range the manifest asks for. */
  readonly requiredEngine?: string;
  /** For needs-handler: primitives this build does not ship. */
  readonly missingHandlers?: readonly string[];
  /** For needs-semantic: keys the site adapter does not define. */
  readonly missingSemantic?: readonly string[];
  /**
   * A newer version arrived while this page kept the old one mounted (plan
   * D7: primitive-backed plugins switch on the next full page load).
   */
  readonly pendingVersion?: string;
}

export interface PluginIncompatibility {
  readonly id: string;
  readonly version: string;
  readonly kind: 'needs-engine' | 'needs-handler' | 'needs-semantic';
  readonly requiredEngine?: string;
  readonly missingHandlers?: readonly string[];
  readonly missingSemantic?: readonly string[];
}

/** Primitives the plugin invokes: declared `requires.handlers` plus every `native` op. */
export function requiredHandlers(manifest: PluginManifest): readonly string[] {
  const names = new Set<string>(manifest.requires?.handlers ?? []);
  for (const op of manifest.contributes.domOps ?? []) {
    if (op.op === 'native') names.add(op.handler);
  }
  return [...names];
}

/**
 * Semantic keys the plugin relies on: declared `requires.semantic`, every
 * semantic selector target, and what its primitives read from the adapter.
 */
export function requiredSemanticKeys(manifest: PluginManifest): readonly string[] {
  const keys = new Set<string>(manifest.requires?.semantic ?? []);
  for (const op of manifest.contributes.domOps ?? []) {
    if (op.op === 'native') {
      for (const key of getPrimitiveContract(op.handler)?.semantic ?? []) keys.add(key);
    } else if (op.target.kind === 'semantic') {
      keys.add(op.target.key);
    }
  }
  return [...keys];
}

export interface CompatibilityInput {
  readonly manifest: PluginManifest;
  readonly adapter: SiteAdapter | null;
  readonly hasPrimitive: (name: string) => boolean;
  readonly engineVersion?: string;
}

/** The first blocking reason, or null when the plugin can run in this build on this site. */
export function findIncompatibility(input: CompatibilityInput): PluginIncompatibility | null {
  const { manifest } = input;
  const base = { id: manifest.id, version: manifest.version };
  if (!engineSatisfied(manifest.engine, input.engineVersion ?? PLUGIN_ENGINE_VERSION)) {
    return { ...base, kind: 'needs-engine', requiredEngine: manifest.engine };
  }
  const missingHandlers = requiredHandlers(manifest).filter((name) => !input.hasPrimitive(name));
  if (missingHandlers.length > 0) {
    return { ...base, kind: 'needs-handler', missingHandlers };
  }
  const selectors = input.adapter?.selectors ?? {};
  const missingSemantic = requiredSemanticKeys(manifest).filter((key) => !selectors[key]);
  if (missingSemantic.length > 0) {
    return { ...base, kind: 'needs-semantic', missingSemantic };
  }
  return null;
}
