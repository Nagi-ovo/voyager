/**
 * Stable ChatGPT DOM and route primitives shared by Voyager's native plugins.
 *
 * Keep this module read-only: it may inspect the current DOM, but it must not
 * observe, scroll, materialize, or mutate ChatGPT. Feature lifecycles belong in
 * their own PluginScope-backed modules.
 */

export const CHATGPT_TURN_ID_ATTRIBUTE = 'data-turn-id-container';
export const CHATGPT_TURN_SHELL_SELECTOR = `[${CHATGPT_TURN_ID_ATTRIBUTE}]`;
export const CHATGPT_USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
export const CHATGPT_ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

// ChatGPT image-generation cards do not always mount a conventional assistant
// message root. This fallback is already covered by the ChatGPT export suite.
export const CHATGPT_IMAGEGEN_SELECTOR = '[class*="group/imagegen-image"]';

export const CHATGPT_SIDEBAR_SELECTOR = '#stage-slideover-sidebar, nav[aria-label]';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
// Both newly created and paginated conversations retain bookkeeping roots.
const NON_TURN_SHELL_ID = /-root(?::|$)/;
const CHATGPT_TURN_FRAME_SELECTOR = '[data-turn]';

export type ChatGptTurnRole = 'user' | 'assistant' | 'unknown';

export interface ChatGptTurnShell {
  /** Stable identity supplied by ChatGPT's retained virtual-list shell. */
  readonly id: string;
  /** DOM order after duplicate identities are reconciled. */
  readonly sequence: number;
  /** Role discoverable from content that is currently mounted inside the shell. */
  readonly role: ChatGptTurnRole;
  /** Retained top-level virtual-list element. Inner message DOM may be absent. */
  readonly container: HTMLElement;
}

export type ChatGptRouteKind = 'home' | 'conversation' | 'gpt' | 'other';

export interface ChatGptRoute {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  /** Stable SPA comparison key. Hash-only UI changes are intentionally ignored. */
  readonly routeKey: string;
  /** `/u/<id>` route scope, when present. */
  readonly workspaceId: string | null;
  readonly gptId: string | null;
  readonly conversationId: string | null;
  readonly kind: ChatGptRouteKind;
}

export interface ChatGptRouteChange {
  readonly previous: ChatGptRoute;
  readonly current: ChatGptRoute;
}

export type ChatGptScrollRegion = 'chat' | 'sidebar' | 'other';

function safeDecodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function currentChatGptBase(): string {
  if (typeof location !== 'undefined' && CHATGPT_HOSTS.has(location.hostname.toLowerCase())) {
    return location.href;
  }
  return 'https://chatgpt.com/';
}

function toChatGptUrl(input: string | URL): URL | null {
  try {
    const url = input instanceof URL ? new URL(input.href) : new URL(input, currentChatGptBase());
    if (url.protocol !== 'https:' || !CHATGPT_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseChatGptRoute(input: string | URL = location.href): ChatGptRoute | null {
  const url = toChatGptUrl(input);
  if (!url) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  let cursor = 0;
  let workspaceId: string | null = null;
  let gptId: string | null = null;
  let conversationId: string | null = null;

  if (segments[cursor] === 'u' && segments[cursor + 1]) {
    const rawWorkspaceId = segments[cursor + 1];
    workspaceId = safeDecodePathSegment(rawWorkspaceId);
    cursor += 2;
  }

  if (segments[cursor] === 'g' && segments[cursor + 1]) {
    gptId = safeDecodePathSegment(segments[cursor + 1]);
    cursor += 2;
  }

  if (segments[cursor] === 'c' && segments[cursor + 1]) {
    conversationId = safeDecodePathSegment(segments[cursor + 1]);
  }

  const kind: ChatGptRouteKind = conversationId
    ? 'conversation'
    : gptId
      ? 'gpt'
      : segments.length === cursor
        ? 'home'
        : 'other';

  return {
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    routeKey: `${url.origin}${url.pathname}${url.search}`,
    workspaceId,
    gptId,
    conversationId,
    kind,
  };
}

/** Convert a generic SPA watcher event into a ChatGPT route change. */
export function getChatGptRouteChange(
  previousHref: string,
  currentHref: string,
): ChatGptRouteChange | null {
  const previous = parseChatGptRoute(previousHref);
  const current = parseChatGptRoute(currentHref);
  if (!previous || !current || previous.routeKey === current.routeKey) return null;
  return { previous, current };
}

export function getChatGptTurnId(container: Element): string | null {
  if (!container.matches(CHATGPT_TURN_SHELL_SELECTOR)) return null;
  const id = container.getAttribute(CHATGPT_TURN_ID_ATTRIBUTE)?.trim() ?? '';
  return id && !NON_TURN_SHELL_ID.test(id) ? id : null;
}

export function getChatGptTurnRole(container: ParentNode): ChatGptTurnRole {
  if (container.querySelector(CHATGPT_USER_MESSAGE_SELECTOR)) return 'user';
  if (
    container.querySelector(CHATGPT_ASSISTANT_MESSAGE_SELECTOR) ||
    container.querySelector(CHATGPT_IMAGEGEN_SELECTOR)
  ) {
    return 'assistant';
  }
  const role = findChatGptTurnFrame(container)?.getAttribute('data-turn');
  return role === 'user' || role === 'assistant' ? role : 'unknown';
}

export function findChatGptTurnFrame(container: ParentNode): Element | null {
  return container instanceof Element && container.matches(CHATGPT_TURN_FRAME_SELECTOR)
    ? container
    : container.querySelector(CHATGPT_TURN_FRAME_SELECTOR);
}

/**
 * Collect retained virtual-list shells without causing materialization.
 *
 * The first identity establishes order. During transient duplicate-shell
 * reconciliation, a later copy replaces an empty first copy only when it has a
 * discoverable role; the original sequence remains stable.
 */
export function collectChatGptTurnShells(root: ParentNode = document): ChatGptTurnShell[] {
  const turnsById = new Map<string, ChatGptTurnShell>();

  for (const container of root.querySelectorAll<HTMLElement>(CHATGPT_TURN_SHELL_SELECTOR)) {
    const id = getChatGptTurnId(container);
    if (!id) continue;

    const role = getChatGptTurnRole(container);
    const existing = turnsById.get(id);
    if (!existing) {
      turnsById.set(id, { id, sequence: turnsById.size, role, container });
    } else if (existing.role === 'unknown' && role !== 'unknown') {
      turnsById.set(id, { ...existing, role, container });
    }
  }

  return Array.from(turnsById.values());
}

export function isChatGptSidebarElement(element: Element): boolean {
  return (
    element.matches(CHATGPT_SIDEBAR_SELECTOR) || element.closest(CHATGPT_SIDEBAR_SELECTOR) != null
  );
}

function isScrollableElement(element: HTMLElement): boolean {
  const overflowY = getComputedStyle(element).overflowY;
  return /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight;
}

/** Find the nearest mounted chat scroll root without scrolling or probing hidden shells. */
export function findChatGptChatScrollRoot(root: ParentNode = document): HTMLElement | null {
  const firstShell =
    root instanceof Element && root.matches(CHATGPT_TURN_SHELL_SELECTOR)
      ? root
      : root.querySelector<HTMLElement>(CHATGPT_TURN_SHELL_SELECTOR);

  for (let current = firstShell?.parentElement ?? null; current; current = current.parentElement) {
    if (isChatGptSidebarElement(current)) break;
    if (isScrollableElement(current)) return current;
  }

  const doc = root instanceof Document ? root : root.ownerDocument;
  return (doc?.scrollingElement as HTMLElement | null) ?? doc?.documentElement ?? null;
}

export function classifyChatGptScrollTarget(
  target: EventTarget | null,
  root: ParentNode = document,
): ChatGptScrollRegion {
  if (target === window || target === document) return 'chat';
  if (!(target instanceof Element)) return 'other';
  if (isChatGptSidebarElement(target)) return 'sidebar';

  const scrollRoot = findChatGptChatScrollRoot(root);
  if (target === scrollRoot) return 'chat';
  if (target.closest(CHATGPT_TURN_SHELL_SELECTOR)) return 'chat';
  if (target.querySelector(CHATGPT_TURN_SHELL_SELECTOR)) return 'chat';
  return 'other';
}
