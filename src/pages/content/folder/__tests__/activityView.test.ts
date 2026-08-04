import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_PRIORITY_WINDOW_MS,
  buildConversationActivityGroups,
  formatActivityFolderSummary,
} from '../activityView';
import type { FolderData } from '../types';

const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();

function makeData(): FolderData {
  return {
    folders: [
      {
        id: 'work',
        name: 'Work',
        parentId: null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'research',
        name: 'Research',
        parentId: 'work',
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: {
      work: [
        {
          conversationId: 'c_priority',
          title: 'Priority chat',
          url: 'https://gemini.google.com/app/priority',
          addedAt: 1,
          lastTurnAt: NOW - 4 * 60 * 60 * 1000,
          starred: true,
        },
        {
          conversationId: 'c_today',
          title: 'Today chat',
          url: 'https://gemini.google.com/app/today',
          addedAt: 1,
          lastTurnAt: NOW - 120_000,
        },
      ],
      research: [
        {
          conversationId: 'today',
          title: 'Today chat copy',
          url: 'https://gemini.google.com/app/today',
          addedAt: 1,
          lastTurnAt: NOW - 30_000,
        },
        {
          conversationId: 'c_yesterday',
          title: 'Yesterday chat',
          url: 'https://gemini.google.com/app/yesterday',
          addedAt: 1,
          lastTurnAt: new Date(2026, 6, 31, 9, 0, 0).getTime(),
        },
        {
          conversationId: 'c_unknown',
          title: 'Unknown chat',
          url: 'https://gemini.google.com/app/unknown',
          addedAt: 1,
        },
        {
          conversationId: 'c_thursday',
          title: 'Thursday chat',
          url: 'https://gemini.google.com/app/thursday',
          addedAt: 1,
          lastTurnAt: new Date(2026, 6, 30, 9, 0, 0).getTime(),
        },
        {
          conversationId: 'c_wednesday',
          title: 'Wednesday chat',
          url: 'https://gemini.google.com/app/wednesday',
          addedAt: 1,
          lastTurnAt: new Date(2026, 6, 29, 9, 0, 0).getTime(),
        },
        {
          conversationId: 'c_tuesday',
          title: 'Tuesday chat',
          url: 'https://gemini.google.com/app/tuesday',
          addedAt: 1,
          lastTurnAt: new Date(2026, 6, 28, 9, 0, 0).getTime(),
        },
        {
          conversationId: 'c_older',
          title: 'Older chat',
          url: 'https://gemini.google.com/app/older',
          addedAt: 1,
          lastTurnAt: new Date(2026, 6, 27, 9, 0, 0).getTime(),
        },
      ],
    },
  };
}

describe('buildConversationActivityGroups', () => {
  it('groups by real turn time, keeps priority exclusive, and deduplicates cross-folder chats', () => {
    const groups = buildConversationActivityGroups(makeData(), {
      now: NOW,
      rootLabel: 'Top level',
    });

    expect(groups.map((group) => group.id)).toEqual([
      'priority',
      'today',
      'yesterday',
      'day-2',
      'day-3',
      'day-4',
    ]);
    expect(groups[0].items.map((item) => item.conversation.conversationId)).toEqual(['today']);
    expect(groups[0].items[0].starred).toBe(false);
    expect(groups[1].items).toHaveLength(1);
    expect(groups[1].items[0]).toMatchObject({
      starred: true,
      lastTurnAt: NOW - 4 * 60 * 60 * 1000,
    });
    expect(groups[0].items[0]).toMatchObject({
      lastTurnAt: NOW - 30_000,
      folderContexts: [
        { name: 'Work', path: 'Work' },
        { name: 'Research', path: 'Work / Research' },
      ],
    });
    expect(groups.flatMap((group) => group.items)).toHaveLength(6);
    expect(
      groups.flatMap((group) => group.items).map((item) => item.conversation.title),
    ).not.toEqual(expect.arrayContaining(['Unknown chat', 'Older chat']));
  });

  it('returns an expired Priority item to Today without duplicating it', () => {
    const lastTurnAt = NOW - ACTIVITY_PRIORITY_WINDOW_MS + 1_000;
    const data: FolderData = {
      folders: [
        {
          id: 'work',
          name: 'Work',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: {
        work: [
          {
            conversationId: 'c_active',
            title: 'Active chat',
            url: 'https://gemini.google.com/app/active',
            addedAt: 1,
            lastTurnAt,
            starred: true,
          },
        ],
      },
    };

    const activeGroups = buildConversationActivityGroups(data, {
      now: NOW,
      rootLabel: 'Top level',
    });
    expect(activeGroups.map((group) => group.id)).toEqual(['priority']);

    const expiredGroups = buildConversationActivityGroups(data, {
      now: NOW + 1_001,
      rootLabel: 'Top level',
    });
    expect(expiredGroups.map((group) => group.id)).toEqual(['today']);
    expect(expiredGroups.flatMap((group) => group.items)).toHaveLength(1);
    expect(expiredGroups[0].items[0].starred).toBe(true);
  });

  it('filters against both conversation titles and folder paths', () => {
    const groups = buildConversationActivityGroups(makeData(), {
      now: NOW,
      rootLabel: 'Top level',
      matches: (conversation, paths) =>
        conversation.title.includes('Yesterday') || paths.some((path) => path.includes('Research')),
    });

    expect(groups.flatMap((group) => group.items).map((item) => item.conversation.title)).toEqual([
      'Today chat copy',
      'Yesterday chat',
      'Thursday chat',
      'Wednesday chat',
      'Tuesday chat',
    ]);
  });

  it('limits visible folder names while retaining the remaining count', () => {
    expect(
      formatActivityFolderSummary([
        { name: 'Work', path: 'Work' },
        { name: 'Research', path: 'Work / Research' },
        { name: 'Archive', path: 'Archive' },
      ]),
    ).toBe('Work · Research +1');
  });
});
