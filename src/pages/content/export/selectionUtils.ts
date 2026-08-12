export function filterItemsBySelectedIds<T>(
  items: readonly T[],
  getId: (item: T) => string | null | undefined,
  selectedIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => {
    const id = getId(item);
    return typeof id === 'string' && id.length > 0 && selectedIds.has(id);
  });
}

export function selectBelowIds(allIds: readonly string[], startId: string): Set<string> {
  const startIndex = allIds.indexOf(startId);
  if (startIndex < 0) return new Set();

  const out = new Set<string>();
  for (let i = startIndex; i < allIds.length; i++) {
    out.add(allIds[i]);
  }
  return out;
}

export type SelectableMessageRole = 'user' | 'assistant';

export interface SelectedMessageForTurnGrouping<TElement = HTMLElement> {
  messageId: string;
  role: SelectableMessageRole;
  text: string;
  starred: boolean;
  exportElement?: TElement;
}

export interface GroupedSelectedTurn<TElement = HTMLElement> {
  turnId: string;
  starred: boolean;
  user?: SelectedMessageForTurnGrouping<TElement>;
  assistant?: SelectedMessageForTurnGrouping<TElement>;
}

function parseMessageId(messageId: string): {
  turnId: string;
  roleHint: SelectableMessageRole | null;
} {
  const match = /^(.*):(u|a)$/.exec(messageId);
  if (!match) {
    return { turnId: messageId, roleHint: null };
  }
  return {
    turnId: match[1],
    roleHint: match[2] === 'u' ? 'user' : 'assistant',
  };
}

export function groupSelectedMessagesByTurn<TElement = HTMLElement>(
  selectedMessages: readonly SelectedMessageForTurnGrouping<TElement>[],
): GroupedSelectedTurn<TElement>[] {
  const grouped = new Map<string, GroupedSelectedTurn<TElement>>();
  const order: string[] = [];

  for (const message of selectedMessages) {
    const { turnId, roleHint } = parseMessageId(message.messageId);
    const role: SelectableMessageRole = roleHint ?? message.role;

    let turn = grouped.get(turnId);
    if (!turn) {
      turn = { turnId, starred: false };
      grouped.set(turnId, turn);
      order.push(turnId);
    }

    if (role === 'user') {
      if (!turn.user) turn.user = message;
    } else if (!turn.assistant) {
      turn.assistant = message;
    }

    turn.starred = turn.starred || message.starred;
  }

  return order.map((turnId) => grouped.get(turnId) as GroupedSelectedTurn<TElement>);
}

export function findSelectionStartIdAtLine(
  items: readonly { id: string; top: number; bottom: number }[],
  lineY: number,
): string | null {
  for (const item of items) {
    if (item.top <= lineY && item.bottom > lineY) {
      return item.id;
    }
  }

  for (const item of items) {
    if (item.top > lineY) {
      return item.id;
    }
  }

  return null;
}

export function resolveInitialSelectedMessageIds(
  allMessageIds: readonly string[],
  preferredMessageId: string | null | undefined,
): Set<string> {
  if (!preferredMessageId) return new Set<string>();
  if (!allMessageIds.includes(preferredMessageId)) return new Set<string>();
  return new Set<string>([preferredMessageId]);
}

export function reconcileExistingSelectionHost(
  boundHost: HTMLElement | null | undefined,
  currentHost: HTMLElement,
  selected: boolean,
): boolean {
  if (boundHost !== currentHost) return false;
  const selector = currentHost.querySelector<HTMLElement>(':scope > .gv-export-msg-selector');
  if (!selector?.isConnected) return false;

  currentHost.classList.add('gv-export-msg-host');
  currentHost.classList.toggle('gv-export-msg-selected', selected);
  return true;
}

export function shouldRefreshSelectionUi(mutations: readonly MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.type === 'childList') return true;
    if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') return false;
    if (!(mutation.target instanceof HTMLElement)) return false;

    return mutation.target.querySelector(':scope > .gv-export-msg-selector') !== null;
  });
}
