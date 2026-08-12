/**
 * Export adapter composition root.
 *
 * Host-specific DOM logic lives in one module per platform. Adding another
 * exporter should require a new module plus one factory registration here,
 * never host checks in the shared export services.
 */
import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { SiteAdapter } from '@/features/plugins/types';

import { buildChatGptAdapter } from './platform/chatgpt';
import type { ExportPlatformAdapter } from './platform/contract';
import { buildGeminiAdapter } from './platform/gemini';

export type { ExportPlatformAdapter } from './platform/contract';
export { chatgptExtractFormula, chatgptExtractInlineFormula } from './platform/chatgpt';

type ExportAdapterFactory = (site: SiteAdapter) => ExportPlatformAdapter;

const EXPORT_ADAPTER_FACTORIES: ReadonlyMap<string, ExportAdapterFactory> = new Map([
  ['gemini', buildGeminiAdapter],
  ['chatgpt', buildChatGptAdapter],
]);

const siteRegistry = SiteRegistry.createDefault();
const GEMINI_FALLBACK_URL = 'https://gemini.google.com/';

/** Resolve the export implementation for the current site. */
export function resolveExportAdapter(): ExportPlatformAdapter {
  const site = siteRegistry.resolveByUrl(window.location.href);
  const factory = site ? EXPORT_ADAPTER_FACTORIES.get(site.id) : undefined;
  if (site && factory) return factory(site);

  // Preserve Voyager's historical behavior on the native Gemini entry point.
  // Future platforms must register an explicit factory instead of inheriting
  // Gemini's DOM rules by accident.
  const geminiSite = siteRegistry.resolveByUrl(GEMINI_FALLBACK_URL);
  if (!geminiSite) throw new Error('Gemini site adapter is unavailable');
  return buildGeminiAdapter(geminiSite);
}
