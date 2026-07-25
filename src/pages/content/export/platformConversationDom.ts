/**
 * Platform-aware conversation root resolution.
 *
 * Uses the adapter's `getConversationRootCandidates()` to find the scroll
 * container, falling back to `document.body`.
 */
import { filterOutDeepResearchImmersiveNodes, resolveConversationRoot } from './conversationDom';
import type { ExportPlatformAdapter } from './platformAdapters';

/**
 * Resolve the conversation root element for the current platform.
 * For Gemini (which uses the existing resolveConversationRoot heuristic),
 * delegates to the legacy function. For other platforms, walks the adapter's
 * root candidates with a body fallback.
 */
export function resolveConversationRootForPlatform(
  adapter: ExportPlatformAdapter,
  userSelectors: string[],
  doc: Document = document,
): HTMLElement {
  // Gemini: use existing heuristic (checks for visible user turns in each candidate)
  if (adapter.site.id === 'gemini' || adapter.site.id === 'aistudio') {
    return resolveConversationRoot({ userSelectors, doc });
  }

  // Claude / ChatGPT / others: walk candidates, first match wins
  for (const selector of adapter.getConversationRootCandidates()) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (el) return el;
  }

  return doc.body as HTMLElement;
}
