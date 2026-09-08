/**
 * PluginHost — orchestrates the plugin lifecycle for the current page.
 *
 * Flow on start():
 *   1. resolve the SiteAdapter for the current URL (may be null on unknown sites)
 *   2. load manifests from all configured sources (builtin, bundled catalog,
 *      cached per-host remote catalog)
 *   3. load per-plugin enable state from storage
 *   4. reconcile: mount every plugin that (matches URL) AND (is enabled) AND
 *      (satisfies the engine version) AND (is not entitlement-locked); unmount the rest
 *   5. subscribe to state changes and re-reconcile (live enable/disable)
 *   6. subscribe to this host's remote catalog cache and reload on content change
 *   7. in the top frame, when an ENABLED plugin targets this page, ask the
 *      background to check the remote catalog (it applies the user's interval,
 *      switch and backoff). Pages without an enabled plugin — every Gemini /
 *      AI Studio page — never send the request.
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
import { subscribeHostCatalog } from '../remote/hostCatalogCache';
import { catalogHostFromUrl, hasEnabledPluginForUrl } from '../remote/hostCatalogPolicy';
import {
  isSameSiteAdapter,
  resolveSiteAdapterForUrl,
  resolveSiteOverride,
} from '../remote/siteOverride';
import { engineSatisfied } from '../semver';
import { matchesAnyPattern } from '../sites/matchPattern';
import { SiteRegistry } from '../sites/registry';
import { createDefaultPluginSources, listPluginManifests } from '../sources/defaultSources';
import { type PluginStateMap, loadPluginState, subscribePluginState } from '../storage/pluginState';
import type {
  EntitlementProvider,
  PluginManifest,
  PluginSettingValue,
  PluginSettings,
  PluginSource,
  PluginSourceContext,
  SiteAdapter,
} from '../types';
import { DeclarativeEngine } from './declarativeEngine';
import { PLUGIN_CATALOG_REFRESH_MESSAGE } from './messages';

export interface PluginHostOptions {
  readonly url?: string;
  readonly registry?: SiteRegistry;
  readonly sources?: readonly PluginSource[];
  readonly entitlement?: EntitlementProvider;
  readonly doc?: Document;
  /** Injectable for tests; defaults to a runtime message to the background. */
  readonly requestCatalogRefresh?: (host: string) => void;
  /** Injectable for tests; defaults to `window.top === window`. */
  readonly isTopFrame?: boolean;
}

/** Fire-and-forget: the background decides whether a network request is due. */
function sendCatalogRefreshRequest(host: string): void {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.sendMessage) return;
  try {
    runtime.sendMessage({ type: PLUGIN_CATALOG_REFRESH_MESSAGE, payload: { host } }, () => {
      // Read lastError so a missing receiver never logs "Unchecked runtime.lastError".
      void runtime.lastError;
    });
  } catch {
    // Extension context gone; nothing to refresh.
  }
}

function detectTopFrame(): boolean {
  try {
    return typeof window === 'undefined' || window.top === window;
  } catch {
    return false;
  }
}

export class PluginHost {
  private readonly url: string;
  private readonly registry: SiteRegistry;
  private readonly sources: readonly PluginSource[];
  private readonly entitlement: EntitlementProvider;
  private readonly doc: Document;
  private readonly context: PluginSourceContext;
  private readonly requestCatalogRefresh: (host: string) => void;
  private readonly isTopFrame: boolean;

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
    this.context = { url: this.url, host: catalogHostFromUrl(this.url) };
    this.requestCatalogRefresh = options.requestCatalogRefresh ?? sendCatalogRefreshRequest;
    this.isTopFrame = options.isTopFrame ?? detectTopFrame();
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
      // Subscribe to this host's catalog BEFORE the adapter read: a background
      // refresh that CHANGES the catalog while that read is in flight must
      // still reach this instance. Until the engine exists the change is only
      // remembered and the initial pass replays it; afterwards every change
      // reloads + re-mounts on the serialized chain so new/changed plugin CSS
      // applies live without a page reload.
      let engineReady = false;
      let catalogChangedBeforeEngine = false;
      const host = this.context.host;
      if (host) {
        this.unsubscribeCatalog = subscribeHostCatalog(host, () => {
          if (this.generation !== gen) return;
          if (!engineReady) {
            catalogChangedBeforeEngine = true;
            return;
          }
          void this.enqueue(() => this.reloadCatalog(gen));
        });
      }
      // A published site override (plan §3) beats the bundled adapter for
      // pages it covers; resolved before the engine exists so semantic
      // selectors use the newest site knowledge from the first mount.
      const adapter = await this.resolveAdapter();
      if (this.generation !== gen) return;
      this.adapter = adapter;
      this.engine = new DeclarativeEngine({ doc: this.doc, adapter: this.adapter });
      engineReady = true;
      // Subscribe BEFORE the initial reads: a state write that lands while
      // they are in flight must still reach this instance. The callback only
      // enqueues on the serialized chain, so nothing runs ahead of the
      // initial reconcile below.
      let stateFromListener: PluginStateMap | null = null;
      this.unsubscribeState = subscribePluginState((next) => {
        if (this.generation !== gen) return;
        stateFromListener = next;
        this.state = next;
        void this.enqueue(() => this.reconcile(gen));
      });
      // The initial read runs ON the chain, so a catalog reload the listener
      // queued meanwhile runs after it and its fresher listing wins.
      await this.enqueue(async () => {
        const manifests = await this.loadManifests();
        const state = await loadPluginState();
        if (this.generation !== gen) return;
        this.manifests = manifests;
        // A listener revision that arrived mid-read is newer than what we read.
        this.state = stateFromListener ?? state;
        await this.reconcile(gen);
        // A catalog write that landed before the engine existed may have
        // swapped the site adapter this engine was built with: replay it.
        if (catalogChangedBeforeEngine) await this.reloadCatalog(gen);
      });
      if (this.generation !== gen) return;
      logger.info('PluginHost started', {
        site: this.adapter?.id ?? 'unknown',
        manifests: this.manifests.length,
      });
      this.maybeRequestCatalogRefresh();
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

  /**
   * Reload manifests from the (refreshed) catalog and re-mount so new CSS
   * applies. A changed site adapter (remote override arrived or was
   * withdrawn) rebuilds the engine so semantic selectors resolve against it.
   */
  private async reloadCatalog(gen: number): Promise<void> {
    const engine = this.engine;
    if (!engine || this.generation !== gen) return;
    const [manifests, adapter] = await Promise.all([this.loadManifests(), this.resolveAdapter()]);
    if (this.generation !== gen) return;
    this.manifests = manifests;
    engine.unmountAll();
    this.pushedSettings.clear();
    if (!isSameSiteAdapter(adapter, this.adapter)) {
      this.adapter = adapter;
      this.engine = new DeclarativeEngine({ doc: this.doc, adapter });
    }
    await this.reconcile(gen);
  }

  private async resolveAdapter(): Promise<SiteAdapter | null> {
    const override = await resolveSiteOverride(this.sources, this.context);
    return resolveSiteAdapterForUrl(this.url, this.registry, override);
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
    return listPluginManifests(this.sources, this.context);
  }

  /**
   * D4 trigger. Only the top frame of a page that an ENABLED plugin targets
   * may ask for a check; embedded companion frames and pages without an
   * enabled plugin (all of Gemini / AI Studio) stay silent.
   */
  private maybeRequestCatalogRefresh(): void {
    const host = this.context.host;
    if (!host || !this.isTopFrame) return;
    if (!hasEnabledPluginForUrl(this.manifests, this.state, this.url)) return;
    this.requestCatalogRefresh(host);
  }
}
