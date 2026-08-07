/**
 * PluginHost — orchestrates the plugin lifecycle for the current page.
 *
 * Flow on start():
 *   1. resolve the SiteAdapter for the current URL (may be null on unknown sites)
 *   2. load manifests from all configured sources (builtin, bundled catalog,
 *      remote marketplace)
 *   3. load per-plugin enable state from storage
 *   4. reconcile: mount every plugin that (matches URL) AND (is enabled) AND
 *      (satisfies the engine version) AND (is not entitlement-locked); unmount the rest
 *   5. subscribe to state changes and re-reconcile (live enable/disable)
 *
 * All providers (registry, sources, entitlement) are injected so the host is
 * fully unit-testable and the monetization/marketplace seams can be swapped
 * without touching this class.
 */
import { logger } from '@/core/services/LoggerService';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { isScriptedTierSupported } from '../capabilities';
import { PLUGIN_ENGINE_VERSION } from '../constants';
import { LocalEntitlementProvider } from '../entitlement/LocalEntitlementProvider';
import { engineSatisfied } from '../semver';
import { matchesAnyPattern } from '../sites/matchPattern';
import { SiteRegistry } from '../sites/registry';
import { createDefaultPluginSources, listPluginManifests } from '../sources/defaultSources';
import { subscribeCatalog } from '../storage/catalogCache';
import { type PluginStateMap, loadPluginState, subscribePluginState } from '../storage/pluginState';
import type {
  EntitlementProvider,
  PluginManifest,
  PluginSettingValue,
  PluginSettings,
  PluginSource,
  SiteAdapter,
} from '../types';
import { DeclarativeEngine } from './declarativeEngine';

export interface PluginHostOptions {
  readonly url?: string;
  readonly registry?: SiteRegistry;
  readonly sources?: readonly PluginSource[];
  readonly entitlement?: EntitlementProvider;
  readonly doc?: Document;
}

export class PluginHost {
  private readonly url: string;
  private readonly registry: SiteRegistry;
  private readonly sources: readonly PluginSource[];
  private readonly entitlement: EntitlementProvider;
  private readonly doc: Document;

  private adapter: SiteAdapter | null = null;
  private engine: DeclarativeEngine | null = null;
  private manifests: readonly PluginManifest[] = [];
  private state: PluginStateMap = {};
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeCatalog: (() => void) | null = null;
  private started = false;
  /**
   * Monotonic lifecycle generation. start() and stop() each bump it; every
   * async pass captures the value at entry and aborts after any await if it
   * no longer matches, so a pass that straddles a stop→start restart can
   * never touch the new generation's engine (a bare `started` boolean would
   * read true again — the ABA case).
   */
  private generation = 0;
  /** Serializes reconcile/reload work so async passes never interleave. */
  private opChain: Promise<void> = Promise.resolve();
  /** Last settings pushed per plugin id, for change detection. */
  private readonly pushedSettings = new Map<string, string>();

  constructor(options: PluginHostOptions = {}) {
    this.url = options.url ?? location.href;
    this.registry = options.registry ?? SiteRegistry.createDefault();
    this.sources = options.sources ?? createDefaultPluginSources();
    this.entitlement = options.entitlement ?? new LocalEntitlementProvider();
    this.doc = options.doc ?? document;
  }

  get activeAdapter(): SiteAdapter | null {
    return this.adapter;
  }

  /** Live side-effect ledgers of scope-based plugins, keyed by plugin id. */
  getScopeLedgers(): Record<string, readonly string[]> {
    return this.engine?.getScopeLedgers() ?? {};
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const gen = ++this.generation;
    try {
      this.adapter = this.registry.resolveByUrl(this.url);
      this.engine = new DeclarativeEngine({ doc: this.doc, adapter: this.adapter });
      this.manifests = await this.loadManifests();
      const state = await loadPluginState();
      if (this.generation !== gen) return;
      this.state = state;
      await this.enqueue(() => this.reconcile(gen));
      if (this.generation !== gen) return;
      this.unsubscribeState = subscribePluginState((next) => {
        if (this.generation !== gen) return;
        this.state = next;
        void this.enqueue(() => this.reconcile(gen));
      });
      // A marketplace refresh updates the cached catalog: reload + re-mount so
      // new/changed plugin CSS applies live without a page reload.
      this.unsubscribeCatalog = subscribeCatalog(
        () => void this.enqueue(() => this.reloadCatalog(gen)),
      );
      logger.info('PluginHost started', {
        site: this.adapter?.id ?? 'unknown',
        manifests: this.manifests.length,
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      logger.error('PluginHost start failed', { error: String(error) });
    }
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = null;
    this.engine?.unmountAll();
    this.pushedSettings.clear();
  }

  /**
   * Append work to the host's single operation chain. Reconcile and catalog
   * reloads are async (entitlement/storage awaits); running two passes
   * concurrently lets a stale pass mount what a newer pass just unmounted.
   *
   * Returns the RAW operation promise so awaiting callers (start) observe the
   * pass's own failure; the chain itself continues through a caught tail, so
   * one failed pass never poisons ordering and fire-and-forget callers never
   * leak an unhandled rejection (the tail's catch is attached to the same
   * promise they discard).
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const op = this.opChain.then(work);
    this.opChain = op.catch((error) => {
      if (isExtensionContextInvalidatedError(error)) return;
      logger.error('PluginHost operation failed', { error: String(error) });
    });
    return op;
  }

  /** Reload manifests from the (refreshed) catalog and re-mount so new CSS applies. */
  private async reloadCatalog(gen: number): Promise<void> {
    const engine = this.engine;
    if (!engine || this.generation !== gen) return;
    const manifests = await this.loadManifests();
    if (this.generation !== gen) return;
    this.manifests = manifests;
    engine.unmountAll();
    this.pushedSettings.clear();
    await this.reconcile(gen);
  }

  private async reconcile(gen: number): Promise<void> {
    // Snapshot everything the pass reads, so one pass never mixes two state
    // revisions (the storage listener replaces `this.state` outside the op
    // chain). A revision that lands mid-pass gets its own queued pass.
    const engine = this.engine;
    const state = this.state;
    const manifests = this.manifests;
    if (!engine) return;
    for (const manifest of manifests) {
      if (this.generation !== gen) return;
      const shouldRun = await this.shouldActivate(manifest, state);
      if (this.generation !== gen) return;
      const isActive = engine.isActive(manifest.id);
      if (shouldRun && !isActive) {
        const settings = this.resolveSettings(manifest, state);
        engine.mount(manifest, settings);
        this.pushedSettings.set(manifest.id, JSON.stringify(settings));
      } else if (!shouldRun && isActive) {
        engine.unmount(manifest.id);
        this.pushedSettings.delete(manifest.id);
      } else if (shouldRun && isActive) {
        // Already active + still should run: push setting changes, but only to
        // the plugin whose settings actually changed — a state write for
        // plugin A must not re-render every other active plugin.
        const settings = this.resolveSettings(manifest, state);
        const serialized = JSON.stringify(settings);
        if (this.pushedSettings.get(manifest.id) !== serialized) {
          engine.updateSettings(manifest.id, settings);
          this.pushedSettings.set(manifest.id, serialized);
        }
      }
    }
  }

  /** Merge the plugin's declared setting defaults with the user's stored values. */
  private resolveSettings(manifest: PluginManifest, state: PluginStateMap): PluginSettings {
    const schema = manifest.contributes.settings;
    const stored = state[manifest.id]?.settings ?? {};
    if (!schema) return stored;
    const resolved: Record<string, PluginSettingValue> = {};
    for (const [key, field] of Object.entries(schema)) {
      resolved[key] = stored[key] ?? field.default;
    }
    return resolved;
  }

  private async shouldActivate(manifest: PluginManifest, state: PluginStateMap): Promise<boolean> {
    if (!matchesAnyPattern(this.url, manifest.matches)) return false;
    if (!state[manifest.id]?.enabled) return false;
    if (!engineSatisfied(manifest.engine, PLUGIN_ENGINE_VERSION)) {
      logger.warn('Plugin skipped: engine range not satisfied', {
        id: manifest.id,
        requires: manifest.engine,
        host: PLUGIN_ENGINE_VERSION,
      });
      return false;
    }
    if (manifest.tier === 'scripted' && !isScriptedTierSupported()) {
      logger.warn('Scripted plugin skipped: tier unsupported on this platform', {
        id: manifest.id,
      });
      return false;
    }
    const entitlement = await this.entitlement.getState(manifest.id);
    return entitlement !== 'locked';
  }

  private async loadManifests(): Promise<readonly PluginManifest[]> {
    return listPluginManifests(this.sources);
  }
}
