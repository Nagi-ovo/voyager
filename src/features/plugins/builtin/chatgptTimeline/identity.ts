import { hashString } from '@/core/utils/hash';
import { parseChatGptRoute } from '@/features/plugins/sites/chatgptDom';

const CHATGPT_STAR_TURN_PREFIX = 'chatgpt:turn:';

/** A draft may acquire its first saved URL without replacing its native shells. */
export function isChatGptDraftPromotion(previousHref: string, currentHref: string): boolean {
  const previous = parseChatGptRoute(previousHref);
  const current = parseChatGptRoute(currentHref);
  return !!(
    previous &&
    current &&
    !previous.conversationId &&
    current.conversationId &&
    (previous.kind === 'home' || previous.kind === 'gpt') &&
    previous.origin === current.origin &&
    previous.workspaceId === current.workspaceId &&
    previous.gptId === current.gptId
  );
}

export function buildChatGptTimelineConversationId(input = location.href): string {
  const route = parseChatGptRoute(input);
  if (!route) return `chatgpt:route:${hashString(String(input || ''))}`;
  const workspace = encodeURIComponent(route.workspaceId ?? 'default');
  if (route.conversationId) {
    return `chatgpt:conv:${workspace}:${encodeURIComponent(route.conversationId)}`;
  }
  return `chatgpt:route:${workspace}:${hashString(`${route.origin}${route.pathname}`)}`;
}

export function buildChatGptTimelineStarTurnId(turnId: string): string {
  return `${CHATGPT_STAR_TURN_PREFIX}${turnId}`;
}

export function extractChatGptTimelineStarTurnId(turnId: string): string | null {
  return turnId.startsWith(CHATGPT_STAR_TURN_PREFIX)
    ? turnId.slice(CHATGPT_STAR_TURN_PREFIX.length) || null
    : null;
}
