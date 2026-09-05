import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderNavigation } from '../FolderNavigation';
import type { ConversationReference } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

function createRow(conversation: ConversationReference, folderId: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'gv-folder-conversation';
  row.dataset.folderId = folderId;
  row.dataset.conversationId = conversation.conversationId;
  const link = document.createElement('a');
  link.className = 'gv-folder-conversation-link';
  link.href = conversation.url;
  row.appendChild(link);
  return row;
}

function createConversation(hexId: string): ConversationReference {
  return {
    conversationId: `c_${hexId}`,
    title: `Conversation ${hexId.slice(0, 6)}`,
    url: `https://gemini.google.com/app/${hexId}`,
    addedAt: Date.now(),
  };
}

function appendNativeConversation(
  hexId: string,
  onClick: (event: MouseEvent) => void,
): HTMLAnchorElement {
  const nativeRow = document.createElement('div');
  nativeRow.setAttribute('data-test-id', 'conversation');
  nativeRow.setAttribute('jslog', `["c_${hexId}"]`);

  const link = document.createElement('a');
  link.href = `/app/${hexId}`;
  link.addEventListener('click', onClick);

  nativeRow.appendChild(link);
  document.body.appendChild(nativeRow);

  return link;
}

describe('folder conversation navigation', () => {
  let navigation: FolderNavigation;
  let context: ReturnType<ConstructorParameters<typeof FolderNavigation>[0]['getContext']>;
  let onOpened: ReturnType<typeof vi.fn<(conversationId: string) => void>>;
  let onTitleChange: ReturnType<typeof vi.fn<(conversationId: string, title: string) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/app/original12345678');
    context = {
      container: null,
      sidebar: null,
      isDestroyed: false,
      accountIsolationEnabled: false,
    };
    onOpened = vi.fn();
    onTitleChange = vi.fn();
    navigation = new FolderNavigation({
      getContext: () => context,
      onRouteChange: vi.fn(),
      onOpened,
      onTitleChange,
      onGemDetected: vi.fn(),
    });
  });

  afterEach(() => {
    navigation.destroy();
    document.body.innerHTML = '';
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the native sidebar link when it successfully changes the conversation route', () => {
    const targetHexId = '2b6fe5971f124c03';

    const markSpy = onOpened;
    const clickSpy = vi.fn((event: MouseEvent) => {
      event.preventDefault();
      window.history.pushState({}, '', `/app/${targetHexId}`);
    });

    appendNativeConversation(targetHexId, clickSpy);

    navigation.navigate(createConversation(targetHexId), 'folder-1');
    vi.advanceTimersByTime(300);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(`/app/${targetHexId}`);
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('falls back to SPA route navigation when the native click does not change the route', () => {
    const targetHexId = '7c1b4e3a9d5f2a11';

    const markSpy = onOpened;
    const clickSpy = vi.fn((event: MouseEvent) => {
      event.preventDefault();
    });

    appendNativeConversation(targetHexId, clickSpy);

    navigation.navigate(createConversation(targetHexId), 'folder-1');
    vi.advanceTimersByTime(1199);
    expect(window.location.pathname).toBe('/app/original12345678');

    vi.advanceTimersByTime(1);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith(targetHexId);
    expect(window.location.pathname).toBe(`/app/${targetHexId}`);
  });

  it('keeps the latest destination when an older native-click fallback is pending', () => {
    const firstHexId = '1111222233334444';
    const secondHexId = '5555666677778888';

    const firstClickSpy = vi.fn((event: MouseEvent) => {
      event.preventDefault();
    });
    appendNativeConversation(firstHexId, firstClickSpy);

    navigation.navigate(createConversation(firstHexId), 'folder-1');
    navigation.navigate(createConversation(secondHexId), 'folder-1');
    vi.advanceTimersByTime(1200);

    expect(firstClickSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(`/app/${secondHexId}`);
  });

  it('ignores a recycled native row whose href belongs to another conversation', () => {
    const targetHexId = '9999aaaabbbbcccc';
    const staleHexId = 'ddddeeeeffff0000';

    const staleClickSpy = vi.fn((event: MouseEvent) => {
      event.preventDefault();
      window.history.pushState({}, '', `/app/${staleHexId}`);
    });
    const staleLink = appendNativeConversation(staleHexId, staleClickSpy);
    staleLink.parentElement?.setAttribute('jslog', `["c_${targetHexId}"]`);

    navigation.navigate(createConversation(targetHexId), 'folder-1');

    expect(staleClickSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(`/app/${targetHexId}`);
  });

  it('uses SPA route navigation when the native sidebar link is not rendered', () => {
    const targetHexId = 'bbbbccccddddeeee';

    const markSpy = onOpened;

    navigation.navigate(createConversation(targetHexId), 'folder-1');

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith(targetHexId);
    expect(window.location.pathname).toBe(`/app/${targetHexId}`);
  });

  it('highlights the clicked legacy-id row when one route is in multiple folders', () => {
    const targetHexId = 'ccccddddeeeeffff';
    const firstConversation = createConversation(targetHexId);
    const secondConversation = createConversation(targetHexId);
    firstConversation.conversationId = 'conv_firstlegacy';
    secondConversation.conversationId = 'imported_secondlegacy';

    context.container = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'gv-folder-list';
    const firstRow = createRow(firstConversation, 'folder-1');
    const secondRow = createRow(secondConversation, 'folder-2');
    list.append(firstRow, secondRow);
    context.container.appendChild(list);
    document.body.appendChild(context.container);

    navigation.navigate(secondConversation, 'folder-2');

    expect(firstRow.classList.contains('gv-folder-conversation-selected')).toBe(false);
    expect(secondRow.classList.contains('gv-folder-conversation-selected')).toBe(true);

    navigation.navigate(firstConversation, 'folder-1');

    expect(firstRow.classList.contains('gv-folder-conversation-selected')).toBe(true);
    expect(secondRow.classList.contains('gv-folder-conversation-selected')).toBe(false);
  });

  it('highlights the clicked raw-id row when the conversation is in multiple folders', () => {
    const targetHexId = '12344321abcddcba';
    const firstConversation = createConversation(targetHexId);
    const secondConversation = createConversation(targetHexId);
    firstConversation.conversationId = targetHexId;
    secondConversation.conversationId = targetHexId;

    context.container = document.createElement('div');
    const firstRow = createRow(firstConversation, 'folder-1');
    const secondRow = createRow(secondConversation, 'folder-2');
    firstRow.querySelector('a')?.remove();
    secondRow.querySelector('a')?.remove();
    context.container.append(firstRow, secondRow);
    document.body.appendChild(context.container);

    navigation.navigate(secondConversation, 'folder-2');

    expect(firstRow.classList.contains('gv-folder-conversation-selected')).toBe(false);
    expect(secondRow.classList.contains('gv-folder-conversation-selected')).toBe(true);
  });

  it('highlights an initially active legacy row from its stored conversation URL', () => {
    const targetHexId = 'abcdef12344321ff';
    const conversation = createConversation(targetHexId);
    conversation.conversationId = 'conv_legacyfallback';
    window.history.replaceState({}, '', `/app/${targetHexId}`);

    context.container = document.createElement('div');
    const row = createRow(conversation, 'folder-1');
    context.container.appendChild(row);
    document.body.appendChild(context.container);

    navigation.highlightActiveConversation();

    expect(row.classList.contains('gv-folder-conversation-selected')).toBe(true);
  });

  it('does not hard navigate when the native SPA route changes after a short delay', () => {
    const targetHexId = '88889999aaaabbbb';

    const clickSpy = vi.fn((event: MouseEvent) => {
      event.preventDefault();
      setTimeout(() => {
        window.history.pushState({}, '', `/app/${targetHexId}`);
      }, 500);
    });

    appendNativeConversation(targetHexId, clickSpy);

    navigation.navigate(createConversation(targetHexId), 'folder-1');
    vi.advanceTimersByTime(1200);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(`/app/${targetHexId}`);
  });

  it('uses the current account prefix for link hrefs when account isolation is enabled', () => {
    const targetHexId = 'abcdef1234567890';
    const conversation = createConversation(targetHexId);
    conversation.url = `https://gemini.google.com/u/1/app/${targetHexId}?hl=en`;
    window.history.replaceState({}, '', '/u/2/app/original12345678');

    context.accountIsolationEnabled = true;

    const href = navigation.getConversationHref(conversation);

    expect(href).toBe(`https://gemini.google.com/u/2/app/${targetHexId}?hl=en`);
  });

  it('uses the URL route id for legacy conversations in account-isolated links and navigation', () => {
    const targetHexId = '13572468abcdef90';
    const conversation = createConversation(targetHexId);
    conversation.conversationId = 'conv_legacyfallback';
    conversation.url = `https://gemini.google.com/u/1/app/${targetHexId}?hl=en`;
    window.history.replaceState({}, '', '/u/2/app/original12345678');

    context.accountIsolationEnabled = true;

    const href = navigation.getConversationHref(conversation);
    navigation.navigate(conversation, 'folder-1');

    expect(href).toBe(`https://gemini.google.com/u/2/app/${targetHexId}?hl=en`);
    expect(window.location.pathname).toBe(`/u/2/app/${targetHexId}`);
  });

  it('cancels a native-click fallback and metadata work when its account is released', () => {
    const target = createConversation('1234567812345678');
    appendNativeConversation('1234567812345678', (event) => event.preventDefault());
    navigation.navigate(target, 'folder-1');
    navigation.cancel();
    vi.advanceTimersByTime(2000);
    expect(window.location.pathname).toBe('/app/original12345678');
    expect(onOpened).not.toHaveBeenCalled();
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it('unsubscribes route work and cancels pending callbacks on destroy', () => {
    navigation.bind();
    window.history.pushState({}, '', '/app/1234567812345678');
    navigation.destroy();
    vi.advanceTimersByTime(2000);
    expect(onOpened).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/app/abcdefabcdef1234');
    vi.advanceTimersByTime(2000);
    expect(onOpened).not.toHaveBeenCalled();
  });
});
