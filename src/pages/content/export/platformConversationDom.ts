/**
 * Platform-aware conversation root resolution.
 *
 * Uses the adapter's `getConversationRootCandidates()` to find the scroll
 * container, falling back to `document.body`.
 */
import type { ExportPlatformAdapter } from './adapter/platformAdapters';
import { filterOutDeepResearchImmersiveNodes, resolveConversationRoot } from './conversationDom';

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
  switch (adapter.site.id) {
    case 'gemini':
    case 'aistudio':
      return resolveConversationRoot({ userSelectors, doc });

    default:
      for (const selector of adapter.getConversationRootCandidates()) {
        const el = doc.querySelector(selector) as HTMLElement | null;
        if (el) return el;
      }
  }

  return doc.body as HTMLElement;
}
