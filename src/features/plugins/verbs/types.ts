/**
 * Primitive runtime contract. See `contracts.ts` for the data half.
 *
 * A primitive is invoked once per `native` op of a mounted plugin with a
 * PluginScope that pays back every side effect on unmount, the validated
 * params from the manifest, and a context carrying the site adapter and the
 * plugin's resolved settings. It never receives plugin-authored code: params
 * are configuration (plan C1), not instructions.
 */
import type { Result } from '@/core/types/common';

import type { ManifestIssue } from '../manifest/validate';
import type { PluginScope } from '../runtime/pluginScope';
import type { PluginSettings, SiteAdapter } from '../types';
import type { PrimitiveContract } from './contracts';

export interface PrimitiveContext {
  readonly doc: Document;
  readonly adapter: SiteAdapter | null;
  readonly pluginId: string;
  readonly settings: PluginSettings;
  /**
   * Health signal (plan D12): tell the engine how to count the page elements
   * this activation acts on. The engine calls it once the DOM has been quiet
   * for a while and flags the plugin as having no effect when the count stays
   * zero on a page that already shows conversation turns.
   */
  setTargetCounter(count: () => number): void;
}

/**
 * What an activation hands back. A primitive that can absorb a settings
 * change in place (the timeline keeps its grow-only markers) returns
 * `updateSettings`; otherwise the engine restarts the primitive under the
 * new settings.
 */
export interface PrimitiveHandle {
  updateSettings?(settings: PluginSettings): void;
}

export type PrimitiveActivation = void | PrimitiveHandle | Promise<void | PrimitiveHandle>;

export interface Primitive<P = Readonly<Record<string, unknown>>> {
  readonly contract: PrimitiveContract;
  validateParams(raw: unknown): Result<P, ManifestIssue[]>;
  activate(scope: PluginScope, params: P, context: PrimitiveContext): PrimitiveActivation;
}
