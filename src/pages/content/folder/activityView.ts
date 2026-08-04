import type { ConversationReference, Folder, FolderData } from './types';

export type FolderViewMode = 'folders' | 'activity';
export type ActivityRecentDayOffset = 2 | 3 | 4;
export type ActivityGroupId = 'priority' | 'today' | 'yesterday' | `day-${ActivityRecentDayOffset}`;

/** Conversations stay in Priority for three hours after their latest real turn. */
export const ACTIVITY_PRIORITY_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface ActivityFolderContext {
  name: string;
  path: string;
}

export interface ConversationActivityItem {
  conversation: ConversationReference;
  sourceFolderId: string;
  folderContexts: ActivityFolderContext[];
  starred: boolean;
  lastTurnAt?: number;
}

export interface ConversationActivityGroup {
  id: ActivityGroupId;
  dayStart?: number;
  items: ConversationActivityItem[];
}

interface ActivityAccumulator {
  conversation: ConversationReference;
  sourceFolderId: string;
  folderContexts: ActivityFolderContext[];
  starred: boolean;
  lastTurnAt?: number;
}

function normalizeConversationId(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^c_/, '');
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getFolderPath(folderId: string, foldersById: Map<string, Folder>): string | null {
  const segments: string[] = [];
  const visited = new Set<string>();
  let folder = foldersById.get(folderId);

  while (folder) {
    if (visited.has(folder.id)) return null;
    visited.add(folder.id);
    segments.unshift(folder.name);
    folder = folder.parentId ? foldersById.get(folder.parentId) : undefined;
  }

  return segments.length > 0 ? segments.join(' / ') : null;
}

function compareActivityItems(
  left: ConversationActivityItem,
  right: ConversationActivityItem,
): number {
  const timeDifference = (right.lastTurnAt ?? -Infinity) - (left.lastTurnAt ?? -Infinity);
  if (timeDifference !== 0) return timeDifference;
  return left.conversation.title.localeCompare(right.conversation.title, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getLocalDayStartDaysAgo(todayStart: number, daysAgo: number): number {
  const date = new Date(todayStart);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

export function formatActivityFolderSummary(
  folderContexts: readonly ActivityFolderContext[],
  maxVisible: number = 2,
): string {
  const visibleLimit = Math.max(1, Math.floor(maxVisible));
  const visibleNames = folderContexts.slice(0, visibleLimit).map((context) => context.name);
  const hiddenCount = Math.max(0, folderContexts.length - visibleNames.length);
  const summary = visibleNames.join(' · ');

  return hiddenCount > 0 ? `${summary} +${hiddenCount}` : summary;
}

/**
 * Build a read-only, attention-first projection over folder data.
 *
 * A conversation can exist in more than one folder. Activity renders it once,
 * keeps every folder name and full path for context, and treats starring as
 * conversation-wide for this projection. Priority is a short-lived activity
 * window based only on real turn time; starring remains visible but does not
 * affect grouping. Each chat is assigned to exactly one group, so a Priority
 * item returns to its calendar-day group when the window expires. Items are
 * limited to today and the previous four local calendar days; older or unknown
 * activity stays in the folder tree instead of turning this view into an archive.
 */
export function buildConversationActivityGroups(
  data: FolderData,
  options: {
    now?: number;
    rootLabel: string;
    matches?: (conversation: ConversationReference, folderPaths: string[]) => boolean;
  },
): ConversationActivityGroup[] {
  const now = options.now ?? Date.now();
  const foldersById = new Map(data.folders.map((folder) => [folder.id, folder]));
  const pathByFolderId = new Map<string, string>();
  foldersById.forEach((_folder, folderId) => {
    const path = getFolderPath(folderId, foldersById);
    if (path) pathByFolderId.set(folderId, path);
  });

  const byConversationId = new Map<string, ActivityAccumulator>();

  Object.entries(data.folderContents).forEach(([folderId, conversations]) => {
    const folderName = foldersById.get(folderId)?.name ?? options.rootLabel;
    const folderPath = pathByFolderId.get(folderId) ?? options.rootLabel;
    const folderContext: ActivityFolderContext = { name: folderName, path: folderPath };

    conversations.forEach((conversation) => {
      const key = normalizeConversationId(conversation.conversationId);
      if (!key) return;

      const timestamp = isFiniteTimestamp(conversation.lastTurnAt)
        ? conversation.lastTurnAt
        : undefined;
      const existing = byConversationId.get(key);

      if (!existing) {
        byConversationId.set(key, {
          conversation,
          sourceFolderId: folderId,
          folderContexts: [folderContext],
          starred: conversation.starred === true,
          lastTurnAt: timestamp,
        });
        return;
      }

      if (!existing.folderContexts.some((context) => context.path === folderPath)) {
        existing.folderContexts.push(folderContext);
      }
      existing.starred ||= conversation.starred === true;

      if ((timestamp ?? -Infinity) > (existing.lastTurnAt ?? -Infinity)) {
        existing.conversation = conversation;
        existing.sourceFolderId = folderId;
        existing.lastTurnAt = timestamp;
      }
    });
  });

  const todayStart = startOfLocalDay(now);
  const yesterdayStart = getLocalDayStartDaysAgo(todayStart, 1);
  const recentDayOffsets: ActivityRecentDayOffset[] = [2, 3, 4];
  const recentDayStarts = new Map<ActivityRecentDayOffset, number>(
    recentDayOffsets.map((offset) => [offset, getLocalDayStartDaysAgo(todayStart, offset)]),
  );
  const itemsByGroup = new Map<ActivityGroupId, ConversationActivityItem[]>([
    ['priority', []],
    ['today', []],
    ['yesterday', []],
    ['day-2', []],
    ['day-3', []],
    ['day-4', []],
  ]);

  byConversationId.forEach((accumulator) => {
    accumulator.folderContexts.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }),
    );

    const folderPaths = accumulator.folderContexts.map((context) => context.path);
    if (options.matches && !options.matches(accumulator.conversation, folderPaths)) {
      return;
    }

    const item: ConversationActivityItem = {
      conversation: accumulator.conversation,
      sourceFolderId: accumulator.sourceFolderId,
      folderContexts: accumulator.folderContexts,
      starred: accumulator.starred,
      lastTurnAt: accumulator.lastTurnAt,
    };

    let groupId: ActivityGroupId | null = null;
    if (isFiniteTimestamp(item.lastTurnAt) && item.lastTurnAt > now - ACTIVITY_PRIORITY_WINDOW_MS) {
      groupId = 'priority';
    } else if (isFiniteTimestamp(item.lastTurnAt) && item.lastTurnAt >= todayStart) {
      groupId = 'today';
    } else if (isFiniteTimestamp(item.lastTurnAt) && item.lastTurnAt >= yesterdayStart) {
      groupId = 'yesterday';
    } else if (isFiniteTimestamp(item.lastTurnAt)) {
      const recentOffset = recentDayOffsets.find(
        (offset) => item.lastTurnAt! >= (recentDayStarts.get(offset) ?? Infinity),
      );
      if (recentOffset) groupId = `day-${recentOffset}`;
    }

    if (!groupId) return;
    itemsByGroup.get(groupId)?.push(item);
  });

  return (['priority', 'today', 'yesterday', 'day-2', 'day-3', 'day-4'] as const).flatMap(
    (id): ConversationActivityGroup[] => {
      const items = itemsByGroup.get(id) ?? [];
      if (items.length === 0) return [];
      items.sort(compareActivityItems);
      const dayOffset = id.startsWith('day-')
        ? (Number(id.slice(4)) as ActivityRecentDayOffset)
        : null;
      return [
        {
          id,
          items,
          ...(dayOffset ? { dayStart: recentDayStarts.get(dayOffset) } : {}),
        },
      ];
    },
  );
}
