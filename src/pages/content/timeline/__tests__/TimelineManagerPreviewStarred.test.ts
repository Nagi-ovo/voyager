import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import type { StarredMessagesData } from '../starredTypes';

type PreviewUpdate = {
  id: string;
  summary: string;
  index: number;
  starred: boolean;
};

type TimelineManagerInternal = {
  conversationId: string | null;
  starred: Set<string>;
  markers: Array<{
    id: string;
    element: HTMLElement;
    summary: string;
    n: number;
    baseN: number;
    dotElement: null;
    starred: boolean;
  }>;
  previewPanel: { updateMarkers: ReturnType<typeof vi.fn> } | null;
  saveStars: () => void;
  applySharedStarredData: (data?: StarredMessagesData | null) => void;
};

function createMarker(
  id: string,
  summary: string,
  starred = false,
): TimelineManagerInternal['markers'][number] {
  return {
    id,
    element: document.createElement('div'),
    summary,
    n: 0,
    baseN: 0,
    dotElement: null,
    starred,
  };
}

function getLastPreviewUpdate(updateMarkers: ReturnType<typeof vi.fn>): PreviewUpdate[] {
  return updateMarkers.mock.calls.at(-1)?.[0] as PreviewUpdate[];
}

describe('TimelineManager preview starred sync', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('pushes add and remove starred changes into the preview panel immediately', () => {
    const manager = new TimelineManager();
    const updateMarkers = vi.fn();
    const internal = manager as unknown as TimelineManagerInternal;

    internal.conversationId = 'gemini:conv:test';
    internal.starred = new Set();
    internal.markers = [createMarker('turn-0', 'first'), createMarker('turn-1', 'second')];
    internal.previewPanel = { updateMarkers };
    internal.saveStars = vi.fn();

    internal.applySharedStarredData({
      messages: {
        'gemini:conv:test': [
          {
            turnId: 'turn-1',
            content: 'second',
            conversationId: 'gemini:conv:test',
            conversationUrl: 'https://gemini.google.com/app/test',
            conversationTitle: 'test',
            starredAt: 1710000000000,
          },
        ],
      },
    });

    let previewMarkers = getLastPreviewUpdate(updateMarkers);
    expect(previewMarkers[1]?.starred).toBe(true);
    expect(previewMarkers[1]).not.toHaveProperty('starredAt');

    internal.applySharedStarredData({
      messages: {
        'gemini:conv:test': [],
      },
    });

    previewMarkers = getLastPreviewUpdate(updateMarkers);
    expect(previewMarkers[1]?.starred).toBe(false);
    expect(previewMarkers[1]).not.toHaveProperty('starredAt');
  });

  it('keeps stars stored under a legacy conversation key when a star changes in another conversation', () => {
    // Current conversation route: stars live under a legacy key, not the
    // stable conversation id. A storage change caused by starring in ANOTHER
    // conversation must not clear this conversation's stars.
    history.replaceState({}, '', '/app/abc123');
    try {
      const manager = new TimelineManager();
      const updateMarkers = vi.fn();
      const internal = manager as unknown as TimelineManagerInternal;

      internal.conversationId = 'gemini:conv:abc123';
      internal.starred = new Set(['turn-0']);
      internal.markers = [createMarker('turn-0', 'first', true)];
      internal.previewPanel = { updateMarkers };
      internal.saveStars = vi.fn();

      internal.applySharedStarredData({
        messages: {
          'gemini:legacy-key': [
            {
              turnId: 'turn-0',
              content: 'first',
              conversationId: 'gemini:legacy-key',
              conversationUrl: 'https://gemini.google.com/app/abc123',
              conversationTitle: 'test',
              starredAt: 100,
            },
          ],
          'gemini:conv:other': [
            {
              turnId: 'turn-9',
              content: 'unrelated',
              conversationId: 'gemini:conv:other',
              conversationUrl: 'https://gemini.google.com/app/other',
              conversationTitle: 'other',
              starredAt: 999,
            },
          ],
        },
      });

      expect(internal.starred.has('turn-0')).toBe(true);
      expect(internal.starred.has('turn-9')).toBe(false);
      expect(internal.markers[0].starred).toBe(true);

      const previewMarkers = getLastPreviewUpdate(updateMarkers);
      expect(previewMarkers[0]?.starred).toBe(true);
    } finally {
      history.replaceState({}, '', '/');
    }
  });
});
