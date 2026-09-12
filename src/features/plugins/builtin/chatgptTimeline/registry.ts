import {
  CHATGPT_ASSISTANT_MESSAGE_SELECTOR,
  CHATGPT_USER_MESSAGE_SELECTOR,
  type ChatGptTurnRole,
  type ChatGptTurnShell,
} from '@/features/plugins/sites/chatgptDom';

export interface ChatGptTimelineTurn {
  readonly id: string;
  role: ChatGptTurnRole;
  summary: string;
  element: HTMLElement;
  center: number;
}

function normalizeSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readMountedSummary(shell: ChatGptTurnShell): string {
  const selector =
    shell.role === 'user'
      ? CHATGPT_USER_MESSAGE_SELECTOR
      : shell.role === 'assistant'
        ? CHATGPT_ASSISTANT_MESSAGE_SELECTOR
        : null;
  return selector
    ? normalizeSummary(shell.container.querySelector(selector)?.textContent ?? '')
    : '';
}

/**
 * Grow-only conversation registry keyed by ChatGPT's retained turn-shell id.
 * Missing shells are treated as virtualized, never deleted. Partial windows
 * are stitched next to exact-id anchors; a disjoint window falls back to its
 * measured position among the registry's cached centers.
 */
export class ChatGptTimelineRegistry {
  private readonly turnsById = new Map<string, ChatGptTimelineTurn>();
  private orderedIds: string[] = [];

  get size(): number {
    return this.orderedIds.length;
  }

  reset(): void {
    this.turnsById.clear();
    this.orderedIds = [];
  }

  get(id: string): ChatGptTimelineTurn | undefined {
    return this.turnsById.get(id);
  }

  all(): ChatGptTimelineTurn[] {
    return this.orderedIds.flatMap((id) => {
      const turn = this.turnsById.get(id);
      return turn ? [turn] : [];
    });
  }

  userTurns(): ChatGptTimelineTurn[] {
    return this.all().filter((turn) => turn.role === 'user');
  }

  merge(
    shells: readonly ChatGptTurnShell[],
    measureCenter: (element: HTMLElement) => number,
  ): void {
    if (!shells.length) return;

    const currentIds: string[] = [];
    const freshIds = new Set<string>();
    for (const shell of shells) {
      currentIds.push(shell.id);
      const existing = this.turnsById.get(shell.id);
      const summary = readMountedSummary(shell);
      if (existing) {
        existing.element = shell.container;
        existing.center = measureCenter(shell.container);
        if (shell.role !== 'unknown') existing.role = shell.role;
        if (summary) existing.summary = summary;
        continue;
      }

      this.turnsById.set(shell.id, {
        id: shell.id,
        role: shell.role,
        summary,
        element: shell.container,
        center: measureCenter(shell.container),
      });
      freshIds.add(shell.id);
    }

    if (this.orderedIds.length === 0) {
      this.orderedIds = currentIds;
      return;
    }
    if (freshIds.size === 0) return;

    const firstAnchor = currentIds.findIndex((id) => !freshIds.has(id));
    if (firstAnchor === -1) {
      const firstCenter = this.turnsById.get(currentIds[0])?.center ?? Number.POSITIVE_INFINITY;
      const insertAt = this.orderedIds.findIndex(
        (id) => (this.turnsById.get(id)?.center ?? Number.NEGATIVE_INFINITY) > firstCenter,
      );
      this.orderedIds.splice(insertAt === -1 ? this.orderedIds.length : insertAt, 0, ...currentIds);
      return;
    }

    const beforeFirstAnchor: string[] = [];
    const afterAnchor = new Map<string, string[]>();
    let lastAnchor: string | null = null;
    for (const id of currentIds) {
      if (!freshIds.has(id)) {
        lastAnchor = id;
      } else if (lastAnchor === null) {
        beforeFirstAnchor.push(id);
      } else {
        const bucket = afterAnchor.get(lastAnchor);
        if (bucket) bucket.push(id);
        else afterAnchor.set(lastAnchor, [id]);
      }
    }

    const firstAnchorId = currentIds[firstAnchor];
    const next: string[] = [];
    for (const id of this.orderedIds) {
      if (id === firstAnchorId) next.push(...beforeFirstAnchor);
      next.push(id);
      const extras = afterAnchor.get(id);
      if (extras) next.push(...extras);
    }
    this.orderedIds = next;
  }
}
