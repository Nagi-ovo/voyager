/**
 * SiteRegistry — resolves the current URL to a `SiteAdapter`.
 *
 * The default registry ships Voyager's first-party adapters. The registry is
 * mutable so future work (or tests) can register additional sites without
 * touching the runtime.
 */
import type { SiteAdapter, SiteId } from '../types';
import { aistudioAdapter } from './adapters/aistudio';
import { chatgptAdapter } from './adapters/chatgpt';
import { claudeAdapter } from './adapters/claude';
import { geminiAdapter } from './adapters/gemini';
import { grokAdapter } from './adapters/grok';
import { matchesAnyPattern } from './matchPattern';

export const DEFAULT_ADAPTERS: readonly SiteAdapter[] = [
  geminiAdapter,
  aistudioAdapter,
  chatgptAdapter,
  claudeAdapter,
  grokAdapter,
];

/**
 * Site ids Voyager treats as first-party "native" surfaces — these get the full
 * Gemini Voyager feature set (Timeline, Folders, Prompt Manager, …). Every other
 * adapter (Claude / ChatGPT / Grok) is a *plugin platform*: declarative plugins
 * + platform theming only, never core Gemini features.
 */
export const NATIVE_SITE_IDS: ReadonlySet<SiteId> = new Set<SiteId>(['gemini', 'aistudio']);

export class SiteRegistry {
  private readonly adapters: SiteAdapter[] = [];

  register(adapter: SiteAdapter): void {
    // Last registration wins for a given id (lets callers override a builtin).
    const existing = this.adapters.findIndex((a) => a.id === adapter.id);
    if (existing >= 0) this.adapters.splice(existing, 1);
    this.adapters.push(adapter);
  }

  /** First adapter whose match patterns match the URL, or null. */
  resolveByUrl(url: string): SiteAdapter | null {
    return this.adapters.find((adapter) => matchesAnyPattern(url, adapter.matches)) ?? null;
  }

  all(): readonly SiteAdapter[] {
    return this.adapters.slice();
  }

  static createDefault(): SiteRegistry {
    const registry = new SiteRegistry();
    for (const adapter of DEFAULT_ADAPTERS) registry.register(adapter);
    return registry;
  }
}

/**
 * Resolve the id of a third-party *plugin platform* for a URL (Claude / ChatGPT /
 * Grok …), or `null` when the URL is a native Voyager site (Gemini / AI Studio)
 * or has no adapter at all. The content script uses this to keep core Gemini
 * features off plugin-only platforms while still running the plugin host + theme.
 */
export function resolvePluginPlatformId(
  url: string,
  registry: SiteRegistry = SiteRegistry.createDefault(),
): SiteId | null {
  const adapter = registry.resolveByUrl(url);
  if (!adapter) return null;
  return NATIVE_SITE_IDS.has(adapter.id) ? null : adapter.id;
}
