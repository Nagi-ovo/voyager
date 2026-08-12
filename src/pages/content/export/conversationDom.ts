type ResolveConversationRootOptions = {
  userSelectors: string[];
  doc?: Document;
};

export const CONVERSATION_ROOT_CANDIDATES = [
  '#chat-history',
  'infinite-scroller.chat-history',
  'chat-window-content',
  'main',
];

export function filterOutDeepResearchImmersiveNodes<T extends HTMLElement>(elements: T[]): T[] {
  return elements.filter((element) => !element.closest('deep-research-immersive-panel'));
}

function hasVisibleUserTurns(root: HTMLElement, userSelectors: string[]): boolean {
  if (userSelectors.length === 0) return false;
  const nodes = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  return nodes.length > 0;
}

export function resolveConversationRoot({
  userSelectors,
  doc = document,
}: ResolveConversationRootOptions): HTMLElement {
  const body = doc.body as HTMLElement;
  let firstCandidate: HTMLElement | null = null;

  for (const selector of CONVERSATION_ROOT_CANDIDATES) {
    const candidate = doc.querySelector(selector) as HTMLElement | null;
    if (!candidate) continue;
    if (!firstCandidate) firstCandidate = candidate;
    if (hasVisibleUserTurns(candidate, userSelectors)) return candidate;
  }

  return firstCandidate || body;
}
