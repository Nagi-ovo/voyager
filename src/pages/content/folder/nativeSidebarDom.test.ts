import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConversationUrlFromId,
  buildNativeConversationTitleMap,
  collectAllSidebarConversations,
  extractConversationData,
  findNativeConversationElement,
  lookupNativeConversationTitle,
} from './nativeSidebarDom';

function makeConversation(opts: { hexId?: string; title?: string | null }): HTMLElement {
  const item = document.createElement('gem-nav-list-item');
  item.setAttribute('data-test-id', 'conversation');
  if (opts.hexId) {
    const link = document.createElement('a');
    link.setAttribute('href', '/app/' + opts.hexId);
    if (opts.title) {
      const titleEl = document.createElement('span');
      titleEl.className = 'title-text gds-body-s';
      titleEl.textContent = opts.title;
      link.appendChild(titleEl);
    }
    item.appendChild(link);
  }
  return item;
}

describe('native sidebar conversation data', () => {
  let originalUrl: string;

  beforeEach(() => {
    originalUrl = window.location.href;
    window.history.replaceState({}, '', '/app');
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState({}, '', originalUrl);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('AI Organize collection', () => {
    const collect = () =>
      collectAllSidebarConversations(() => ({
        sidebar: null,
        accountIsolationEnabled: false,
        isDestroyed: false,
      }));

    it('collects id/title/url from populated rows', async () => {
      document.body.append(
        makeConversation({ hexId: 'abcdef1234567890', title: 'First chat' }),
        makeConversation({ hexId: '0123456789abcdef', title: 'Second chat' }),
      );

      const result = await collect();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'abcdef1234567890',
        title: 'First chat',
        url: 'https://gemini.google.com/app/abcdef1234567890',
      });
      expect(result[1].title).toBe('Second chat');
    });

    it('drops virtualized stubs that have no link yet', async () => {
      document.body.append(makeConversation({}), makeConversation({}), makeConversation({}));

      const pending = collect();
      await vi.runAllTimersAsync();

      expect(await pending).toEqual([]);
    });

    it('returns only populated rows when stubs and real rows are mixed', async () => {
      document.body.append(
        makeConversation({}),
        makeConversation({ hexId: 'aaaabbbbccccdddd', title: 'Real one' }),
        makeConversation({}),
      );

      const result = await collect();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('aaaabbbbccccdddd');
    });

    it('dedupes rows that resolve to the same conversation id', async () => {
      document.body.append(
        makeConversation({ hexId: 'deadbeefdeadbeef', title: 'Dup' }),
        makeConversation({ hexId: 'deadbeefdeadbeef', title: 'Dup' }),
      );

      expect(await collect()).toHaveLength(1);
    });

    it('falls back to Untitled when a populated row has no readable title', async () => {
      document.body.append(makeConversation({ hexId: 'feedfacefeedface', title: null }));

      const result = await collect();

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Untitled');
    });

    it('reads the replacement sidebar when rows populate after a remount', async () => {
      const originalSidebar = document.createElement('aside');
      originalSidebar.appendChild(makeConversation({}));
      document.body.appendChild(originalSidebar);
      let sidebar = originalSidebar;
      const pending = collectAllSidebarConversations(() => ({
        sidebar,
        accountIsolationEnabled: false,
        isDestroyed: false,
      }));

      sidebar = document.createElement('aside');
      sidebar.appendChild(makeConversation({ hexId: 'aaaabbbbccccdddd', title: 'Remounted chat' }));
      document.body.appendChild(sidebar);
      await vi.advanceTimersByTimeAsync(150);

      expect(await pending).toEqual([
        {
          id: 'aaaabbbbccccdddd',
          title: 'Remounted chat',
          url: 'https://gemini.google.com/app/aaaabbbbccccdddd',
        },
      ]);
    });
  });

  it('indexes prefixed, bare and href-only IDs while retaining the first native title', () => {
    const first = makeConversation({ hexId: 'abc123def4567890', title: 'Title A' });
    first.setAttribute('jslog', '["c_abc123def4567890"]');
    const second = makeConversation({ hexId: '1111222233334444', title: 'Title B' });
    second.setAttribute('jslog', '["c_1111222233334444"]');
    document.body.append(
      first,
      second,
      makeConversation({ hexId: 'feedfacecafebeef', title: 'Href-only title' }),
      makeConversation({ hexId: 'abc123def4567890', title: 'Duplicate title' }),
    );

    const titles = buildNativeConversationTitleMap();

    for (const [id, expected] of [
      ['c_abc123def4567890', 'Title A'],
      ['abc123def4567890', 'Title A'],
      ['c_1111222233334444', 'Title B'],
      ['1111222233334444', 'Title B'],
      ['feedfacecafebeef', 'Href-only title'],
      ['c_deadbeef00000000', null],
    ] as const) {
      expect(lookupNativeConversationTitle(titles, id)).toBe(expected);
    }
  });

  it('finds native conversations from the document when no sidebar reference is cached', () => {
    const conversation = makeConversation({ hexId: 'def456', title: 'Conversation' });
    conversation.setAttribute('jslog', '["c_def456"]');
    document.body.appendChild(conversation);

    expect(findNativeConversationElement(null, 'c_def456')).toBe(conversation);
  });

  it.each([
    ['/u/1/app/existing123', false, '/u/1/app/abc123def4567890'],
    ['/u/2/gem/gem-42/existing123', false, '/u/2/gem/gem-42/abc123def4567890'],
    ['/app/existing123', false, '/app/abc123def4567890'],
    ['/u/3/app/existing123', true, '/app/abc123def4567890'],
  ])('builds fallback URLs from route %s with isolation %s', (route, isolated, expected) => {
    window.history.replaceState({}, '', route);

    expect(buildConversationUrlFromId('abc123def4567890', isolated)).toBe(
      'https://gemini.google.com' + expected,
    );
  });

  it('omits the route account from isolated drag URLs while preserving query parameters', () => {
    window.history.replaceState({}, '', '/u/1/app?foo=bar');
    const row = document.createElement('div');
    row.setAttribute('jslog', '["c_2b6fe5971f124c03"]');

    expect(extractConversationData(row, true).url).toBe(
      window.location.origin + '/app/2b6fe5971f124c03?foo=bar',
    );
  });
});
