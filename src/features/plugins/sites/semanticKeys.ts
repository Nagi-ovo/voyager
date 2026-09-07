/**
 * The semantic selector vocabulary (plan §5, D9).
 *
 * A site adapter maps these keys to site-specific CSS selectors; plugins and
 * primitives reference the KEY, never the selector, so a site redesign is a
 * one-file adapter fix. The list only ever grows: a key is never removed or
 * given a new meaning, and a site.json that uses a key outside this list is
 * rejected so authors cannot invent one silently.
 *
 *   userTurn         a user message container
 *   assistantTurn    an assistant message container
 *   thinkingBlock    the reasoning / "thinking" section inside an assistant turn
 *   codeBlock        a rendered code block
 *   composer         the prompt input the user types into
 *   sidebar          the conversation list / navigation rail
 *   sidePanel        a secondary panel (artifacts, canvas, previews)
 *   headerActions    the top-right action cluster of the conversation view
 *   scrollContainer  the element that scrolls the conversation
 *
 * `conversationIdPattern` is NOT a selector: it is a path regular expression
 * carried on the adapter itself (see `SiteAdapter`).
 */
export const SEMANTIC_SELECTOR_KEYS = [
  'userTurn',
  'assistantTurn',
  'thinkingBlock',
  'codeBlock',
  'composer',
  'sidebar',
  'sidePanel',
  'headerActions',
  'scrollContainer',
] as const;

export type SemanticSelectorKey = (typeof SEMANTIC_SELECTOR_KEYS)[number];

export function isSemanticSelectorKey(key: string): key is SemanticSelectorKey {
  return (SEMANTIC_SELECTOR_KEYS as readonly string[]).includes(key);
}
