const USER_TURN_ID_RE = /^u-(\d+)(?:(?:-|~c).+)?$/;
const SERVER_RESPONSE_ID_RE = /^r_([0-9a-f]{8,})$/i;
const SERVER_CONTAINER_ID_RE = /^[0-9a-f]{8,}$/i;
const SERVER_TURN_ID_RE = /^s-([0-9a-f]{8,})$/i;

export function makeStableTurnId(index: number): string {
  return `u-${Math.max(0, index)}`;
}

export function makeServerTurnId(responseId: string): string | null {
  const trimmed = responseId.trim();
  const responseMatch = SERVER_RESPONSE_ID_RE.exec(trimmed);
  if (responseMatch) return `s-${responseMatch[1].toLowerCase()}`;
  if (SERVER_CONTAINER_ID_RE.test(trimmed)) return `s-${trimmed.toLowerCase()}`;
  return null;
}

/** The server-derived id for a turn element, or null when Gemini exposes none. */
export function readServerTurnId(el: Element | null | undefined): string | null {
  if (!el || typeof el.closest !== 'function') return null;
  const container = el.closest('.conversation-container');
  return makeServerTurnId((container as HTMLElement | null)?.id ?? '');
}

export function isServerTurnId(turnId: string): boolean {
  return SERVER_TURN_ID_RE.test(turnId.trim());
}

/** Server-derived id when Gemini exposes one, positional id otherwise. */
export function makeTurnId(el: Element | null | undefined, index: number): string {
  return readServerTurnId(el) ?? makeStableTurnId(index);
}

/** Index encoded by a legacy positional id, including its historical suffixes. */
export function getLegacyTurnIndex(turnId: string): number | null {
  const match = USER_TURN_ID_RE.exec(turnId.trim());
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

export function normalizeTurnId(turnId: string): string {
  const trimmed = turnId.trim();
  const match = USER_TURN_ID_RE.exec(trimmed);
  if (!match) return trimmed;
  return `u-${match[1]}`;
}
