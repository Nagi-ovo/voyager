// @vitest-environment-options {"url":"https://chatgpt.com/c/one"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { CHATGPT_TURN_ID_ATTRIBUTE } from '@/features/plugins/sites/chatgptDom';

import {
  activateChatGptTimeline,
  buildChatGptTimelineConversationId,
  buildChatGptTimelineStarTurnId,
  extractChatGptTimelineStarTurnId,
  startChatGptTimeline,
  stopChatGptTimeline,
  updateChatGptTimelineSettings,
} from '.';
import { CHATGPT_TIMELINE_ROOT_CLASS } from './styles';

const { addStarredMessage, getStarredMessagesForConversation, removeStarredMessage } = vi.hoisted(
  () => ({
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));

vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    addStarredMessage,
    getStarredMessagesForConversation,
    removeStarredMessage,
  },
}));

interface PositionedShell {
  shell: HTMLElement;
  position: { top: number };
}

function createScrollRoot(): HTMLElement & { scrollTo: ReturnType<typeof vi.fn> } {
  const root = document.createElement('main') as HTMLElement & {
    scrollTo: ReturnType<typeof vi.fn>;
  };
  root.style.overflowY = 'auto';
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 4000 });
  root.getBoundingClientRect = vi.fn(
    () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 800, width: 800 }) as DOMRect,
  );
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    root.scrollTop = options.top ?? root.scrollTop;
  });
  Object.defineProperty(root, 'scrollTo', { configurable: true, value: scrollTo });
  document.body.appendChild(root);
  return root;
}

function createShell(
  root: HTMLElement,
  id: string,
  role: 'user' | 'assistant' | 'unknown',
  text: string,
  top: number,
): PositionedShell {
  const shell = document.createElement('article');
  shell.setAttribute(CHATGPT_TURN_ID_ATTRIBUTE, id);
  if (role !== 'unknown') {
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = role;
    message.textContent = text;
    shell.appendChild(message);
  }
  const position = { top };
  shell.getBoundingClientRect = vi.fn(() => {
    const viewportTop = position.top - root.scrollTop;
    return {
      top: viewportTop,
      bottom: viewportTop + 40,
      height: 40,
      left: 0,
      right: 700,
      width: 700,
    } as DOMRect;
  });
  root.appendChild(shell);
  return { shell, position };
}

function dots(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-dot'));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleRefresh(): Promise<void> {
  await flush();
  vi.advanceTimersByTime(120);
  await flush();
}

describe('ChatGPT timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    history.replaceState({}, '', '/c/one');
    getStarredMessagesForConversation.mockResolvedValue([]);
    getStarredMessagesForConversation.mockClear();
    addStarredMessage.mockClear();
    removeStarredMessage.mockClear();
    vi.mocked(chrome.storage.onChanged.addListener).mockClear();
    vi.mocked(chrome.storage.onChanged.removeListener).mockClear();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  });

  afterEach(async () => {
    await stopChatGptTimeline();
    vi.useRealTimers();
  });

  it('prefixes persisted conversation and star identities by provider and workspace', () => {
    expect(buildChatGptTimelineConversationId('https://chatgpt.com/c/abc')).toBe(
      'chatgpt:conv:default:abc',
    );
    expect(buildChatGptTimelineConversationId('https://chatgpt.com/u/team/c/abc')).toBe(
      'chatgpt:conv:team:abc',
    );
    expect(buildChatGptTimelineStarTurnId('turn-1')).toBe('chatgpt:turn:turn-1');
    expect(extractChatGptTimelineStarTurnId('chatgpt:turn:turn-1')).toBe('turn-1');
    expect(extractChatGptTimelineStarTurnId('turn-1')).toBeNull();
  });

  it('renders user turns in stable order, updates active state, and discovers new turns', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    createShell(root, 'assistant-1', 'assistant', 'first answer', 400);
    createShell(root, 'user-2', 'user', 'second prompt', 1100);

    startChatGptTimeline();
    await flush();

    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['user-1', 'user-2']);
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'first prompt',
      'second prompt',
    ]);

    root.scrollTop = 750;
    root.dispatchEvent(new Event('scroll'));
    expect(dots()[1].classList.contains('active')).toBe(true);

    createShell(root, 'assistant-2', 'assistant', 'second answer', 1400);
    createShell(root, 'user-3', 'user', 'third prompt', 1700);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('renders multiple markers at shell-relative positions instead of ordinal slots', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    createShell(root, 'user-2', 'user', 'second prompt', 900);
    createShell(root, 'user-3', 'user', 'third prompt', 2500);

    startChatGptTimeline();
    await flush();

    const tops = dots().map((dot) => Number.parseFloat(dot.style.top));
    expect(dots()).toHaveLength(3);
    expect(new Set(tops).size).toBe(3);
    expect(tops[1] - tops[0]).toBeLessThan(tops[2] - tops[1]);
    expect(tops.every((top) => top > 16 && top < 600)).toBe(true);
  });

  it('updates marker geometry when a retained shell height is reconciled', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    const target = createShell(root, 'user-2', 'user', 'second prompt', 900);
    startChatGptTimeline();
    await flush();
    const before = Number.parseFloat(dots()[1].style.top);

    target.position.top = 1700;
    root.dispatchEvent(new Event('scroll'));

    expect(Number.parseFloat(dots()[1].style.top)).toBeGreaterThan(before);
  });

  it('discovers mounted role content incrementally and preserves it after virtualization', async () => {
    const root = createScrollRoot();
    const retained = createShell(root, 'retained-turn', 'unknown', '', 100);
    createShell(root, 'known-turn', 'user', 'known prompt', 900);
    startChatGptTimeline();
    await flush();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['known-turn']);

    const message = document.createElement('div');
    message.dataset.messageAuthorRole = 'user';
    message.textContent = 'newly mounted prompt';
    retained.shell.appendChild(message);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['retained-turn', 'known-turn']);

    message.remove();
    await settleRefresh();
    retained.shell.remove();
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['retained-turn', 'known-turn']);
    expect(dots()[0].getAttribute('aria-label')).toBe('newly mounted prompt');
    expect(root.scrollTo).not.toHaveBeenCalled();
  });

  it('switches between Standard and Compact without rebuilding the registry', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    createShell(root, 'user-2', 'user', 'second prompt', 900);
    startChatGptTimeline({ compactView: false });
    await flush();

    const originalIds = dots().map((dot) => dot.dataset.targetTurnId);
    updateChatGptTimelineSettings({ compactView: true });

    const bar = document.querySelector<HTMLElement>('[data-gv-chatgpt-timeline="true"]')!;
    expect(bar.classList.contains('timeline-style-compact')).toBe(true);
    expect(bar.querySelector('.timeline-track')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.timeline-preview-panel-compact')).toBeTruthy();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(originalIds);
  });

  it('preserves compact spacing and navigates ticks without opening preview', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    createShell(root, 'user-2', 'user', 'second prompt', 900);
    createShell(root, 'user-3', 'user', 'third prompt', 1700);
    startChatGptTimeline({ compactView: true });
    await flush();

    expect(dots().map((dot) => dot.style.getPropertyValue('--timeline-compact-offset'))).toEqual([
      '-8px',
      '0px',
      '8px',
    ]);
    expect(document.querySelector('[data-gv-turn-navigator="chatgpt"]')).toBeTruthy();
    dots()[2].click();
    expect(root.scrollTo).toHaveBeenCalled();
    expect(document.querySelector('.timeline-preview-panel')?.classList.contains('visible')).toBe(
      false,
    );
  });

  it('previews cached prompt text on marker hover and keyboard focus', async () => {
    const root = createScrollRoot();
    const prompt = createShell(root, 'user-1', 'user', 'cached hover prompt', 100);
    startChatGptTimeline();
    await flush();
    prompt.shell.replaceChildren();
    await settleRefresh();

    const tooltip = document.querySelector<HTMLElement>('#gv-chatgpt-timeline-tooltip')!;
    dots()[0].dispatchEvent(new PointerEvent('pointerenter'));
    vi.advanceTimersByTime(160);
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');
    expect(tooltip.textContent).toBe('cached hover prompt');
    expect(document.querySelector('.timeline-preview-panel')?.classList.contains('visible')).toBe(
      false,
    );

    dots()[0].dispatchEvent(new PointerEvent('pointerleave'));
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    dots()[0].focus();
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');
    updateChatGptTimelineSettings({ compactView: true });
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
  });

  it('expands and synchronizes a dense Standard rail without scrolling the chat itself', async () => {
    const root = createScrollRoot();
    for (let index = 0; index < 30; index += 1) {
      createShell(root, `user-${index}`, 'user', `prompt ${index}`, 100 + index * 120);
    }
    startChatGptTimeline();
    await flush();

    const track = document.querySelector<HTMLElement>('.timeline-track')!;
    const content = document.querySelector<HTMLElement>('.timeline-track-content')!;
    expect(Number.parseFloat(content.style.height)).toBe(728);
    expect(root.scrollTo).not.toHaveBeenCalled();

    root.scrollTop = 1700;
    root.dispatchEvent(new Event('scroll'));
    expect(track.scrollTop).toBeCloseTo(64, 0);
    expect(root.scrollTop).toBe(1700);
  });

  it('re-anchors a marker after ChatGPT reconciles virtualized shell height', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    const target = createShell(root, 'user-2', 'user', 'far prompt', 1500);
    startChatGptTimeline();
    await flush();

    dots()[1].click();
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 1250, behavior: 'smooth' });
    expect(dots()[1].classList.contains('active')).toBe(true);

    target.position.top = 1750;
    vi.advanceTimersByTime(200);
    await flush();
    expect(root.scrollTo).toHaveBeenLastCalledWith({ top: 1500, behavior: 'auto' });

    vi.advanceTimersByTime(400);
    await flush();
    expect(root.scrollTo).toHaveBeenCalledTimes(2);
  });

  it('homes to an unmounted stable id when its shell remounts', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);
    const target = createShell(root, 'user-2', 'user', 'virtual prompt', 1500);
    startChatGptTimeline();
    await flush();

    target.shell.remove();
    await settleRefresh();
    dots()[1].click();
    expect(root.scrollTo).toHaveBeenLastCalledWith({ top: 1250, behavior: 'auto' });

    createShell(root, 'user-2', 'user', 'virtual prompt', 1800);
    vi.advanceTimersByTime(200);
    await flush();
    expect(root.scrollTo).toHaveBeenLastCalledWith({ top: 1550, behavior: 'auto' });
    expect(dots()).toHaveLength(2);
  });

  it.each(['wheel', 'touchmove', 'pointerdown'])(
    'cancels automated re-anchoring and releases active tracking on %s',
    async (eventType) => {
      const root = createScrollRoot();
      createShell(root, 'user-1', 'user', 'first prompt', 100);
      const target = createShell(root, 'user-2', 'user', 'second prompt', 1500);
      startChatGptTimeline();
      await flush();

      dots()[1].click();
      expect(root.scrollTo).toHaveBeenCalledTimes(1);
      target.position.top = 2000;
      root.dispatchEvent(new Event(eventType, { bubbles: true }));
      root.scrollTop = 0;
      root.dispatchEvent(new Event('scroll'));
      expect(dots()[0].getAttribute('aria-current')).toBe('true');
      vi.advanceTimersByTime(1000);
      await flush();
      expect(root.scrollTo).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['/', '/g/custom', '/u/team/g/custom'])(
    'keeps retained draft turns when %s acquires a saved URL',
    async (draft) => {
      history.replaceState({}, '', draft);
      const root = createScrollRoot();
      createShell(root, 'draft-user', 'user', 'draft prompt', 100);
      startChatGptTimeline();
      await flush();
      history.replaceState({}, '', `${draft.replace(/\/$/, '')}/c/saved`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleRefresh();
      await settleRefresh();
      expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['draft-user']);
      expect(root.scrollTo).not.toHaveBeenCalled();
      // A sidebar destination replacing a provisional draft set must not inherit it.
      root.replaceChildren();
      createShell(root, 'saved-user', 'user', 'saved prompt', 900);
      await settleRefresh();
      await settleRefresh();
      expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['saved-user']);
    },
  );

  it('cancels a detached marker long press when settings rerender the rail', async () => {
    const root = createScrollRoot();
    createShell(root, 'pressed-user', 'user', 'pressed prompt', 100);
    startChatGptTimeline();
    await flush();
    dots()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    updateChatGptTimelineSettings({ compactView: true });
    document.dispatchEvent(new PointerEvent('pointerup'));
    vi.advanceTimersByTime(600);
    await flush();
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('resets the grow-only registry on conversation and workspace SPA switches', async () => {
    const root = createScrollRoot();
    createShell(root, 'old-turn', 'user', 'old prompt', 100);
    startChatGptTimeline();
    await flush();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['old-turn']);

    history.pushState({}, '', '/u/team/c/two');
    vi.advanceTimersByTime(520);
    await flush();
    expect(dots()).toHaveLength(0);

    root.replaceChildren();
    createShell(root, 'new-turn', 'user', 'new prompt', 100);
    await settleRefresh();
    await settleRefresh();

    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['new-turn']);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:team:two');
  });

  it('rejects mixed old and new shells during a ChatGPT route transition', async () => {
    const root = createScrollRoot();
    const oldTurn = createShell(root, 'old-turn', 'user', 'old prompt', 100);
    createShell(root, 'old-answer', 'assistant', 'old answer', 400);
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    await flush();
    expect(dots()).toHaveLength(0);

    oldTurn.shell.remove();
    root.querySelector('[data-turn-id-container="old-answer"]')?.remove();
    const remountedOldTurn = createShell(root, 'old-turn', 'user', 'old prompt', 100);
    createShell(root, 'new-turn', 'user', 'new prompt', 100);
    await settleRefresh();
    expect(dots()).toHaveLength(0);

    remountedOldTurn.shell.remove();
    await settleRefresh();
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['new-turn']);
  });

  it('quarantines a registry-known source id when its DOM shell was already unmounted', async () => {
    const root = createScrollRoot();
    const oldTurn = createShell(root, 'old-turn', 'user', 'old prompt', 100);
    startChatGptTimeline();
    await flush();
    oldTurn.shell.remove();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    await flush();

    const remountedOldTurn = createShell(root, 'old-turn', 'user', 'old prompt', 100);
    createShell(root, 'new-turn', 'user', 'new prompt', 400);
    await settleRefresh();
    expect(dots()).toHaveLength(0);

    remountedOldTurn.shell.remove();
    await settleRefresh();
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['new-turn']);
  });

  it('replaces a late stale shell set when the source route had no mounted turns', async () => {
    const root = createScrollRoot();
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    await flush();

    createShell(root, 'late-old-turn', 'user', 'late old prompt', 100);
    await settleRefresh();
    expect(dots()).toHaveLength(0);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['late-old-turn']);

    root.replaceChildren();
    createShell(root, 'new-turn', 'user', 'new prompt', 100);
    await settleRefresh();
    expect(dots()).toHaveLength(0);
    await settleRefresh();

    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['new-turn']);
  });

  it('restarts empty-source confirmation when the candidate shell signature changes', async () => {
    const root = createScrollRoot();
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    await flush();

    createShell(root, 'candidate-one', 'user', 'first candidate', 100);
    await settleRefresh();
    expect(dots()).toHaveLength(0);

    root.replaceChildren();
    createShell(root, 'candidate-two', 'user', 'second candidate', 100);
    await settleRefresh();
    expect(dots()).toHaveLength(0);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['candidate-two']);
  });

  it('handles rapid A to B to A navigation without permanently quarantining A', async () => {
    const root = createScrollRoot();
    createShell(root, 'turn-a', 'user', 'prompt A', 100);
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    root.replaceChildren();
    createShell(root, 'turn-b', 'user', 'prompt B', 100);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['turn-b']);

    history.pushState({}, '', '/c/one');
    vi.advanceTimersByTime(520);
    root.replaceChildren();
    createShell(root, 'turn-a', 'user', 'prompt A remounted', 100);
    await settleRefresh();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['turn-a']);
  });

  it('keeps destination markers grow-only across disjoint virtualized windows', async () => {
    const root = createScrollRoot();
    createShell(root, 'old-turn', 'user', 'old prompt', 100);
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    vi.advanceTimersByTime(520);
    root.replaceChildren();
    createShell(root, 'new-turn-1', 'user', 'first destination prompt', 100);
    await settleRefresh();
    await settleRefresh();

    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    root.scrollTop = 900;
    root.replaceChildren();
    createShell(root, 'new-turn-2', 'user', 'virtualized destination prompt', 1100);
    await settleRefresh();

    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['new-turn-1', 'new-turn-2']);
  });

  it('does not let an older async refresh render across a newer route generation', async () => {
    const root = createScrollRoot();
    createShell(root, 'turn-a', 'user', 'prompt A', 100);
    startChatGptTimeline();
    await flush();

    let resolveRouteB!: (messages: []) => void;
    const routeBStars = new Promise<[]>((resolve) => {
      resolveRouteB = resolve;
    });
    getStarredMessagesForConversation.mockImplementation((conversationId: string) =>
      conversationId === 'chatgpt:conv:default:two' ? routeBStars : Promise.resolve([]),
    );

    history.pushState({}, '', '/c/two');
    root.replaceChildren();
    createShell(root, 'turn-b', 'user', 'prompt B', 100);
    vi.advanceTimersByTime(520);
    await flush();

    history.pushState({}, '', '/c/three');
    root.replaceChildren();
    createShell(root, 'turn-c', 'user', 'prompt C', 100);
    vi.advanceTimersByTime(520);
    await flush();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['turn-c']);

    resolveRouteB([]);
    await flush();
    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(['turn-c']);
  });

  it('keeps an empty destination idle instead of scheduling confirmation refreshes', async () => {
    const root = createScrollRoot();
    createShell(root, 'old-turn', 'user', 'old prompt', 100);
    startChatGptTimeline();
    await flush();

    history.pushState({}, '', '/c/two');
    root.replaceChildren();
    vi.advanceTimersByTime(520);
    await flush();
    const starReads = getStarredMessagesForConversation.mock.calls.length;

    vi.advanceTimersByTime(5000);
    await flush();
    expect(dots()).toHaveLength(0);
    expect(getStarredMessagesForConversation).toHaveBeenCalledTimes(starReads);
  });

  it('reuses persisted stars plus preview search and navigation', async () => {
    getStarredMessagesForConversation.mockResolvedValue([
      {
        turnId: 'chatgpt:turn:user-1',
        content: 'remember prompt',
        conversationId: 'chatgpt:conv:default:one',
        conversationUrl: 'https://chatgpt.com/c/one',
        conversationTitle: 'test',
        starredAt: 123,
      },
    ]);
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'remember prompt', 100);
    createShell(root, 'user-2', 'user', 'find this needle', 900);
    startChatGptTimeline();
    await flush();

    expect(dots()[0].classList.contains('starred')).toBe(true);
    document.querySelector<HTMLButtonElement>('.timeline-preview-toggle')!.click();
    expect(document.querySelector('.timeline-preview-item.starred')).toBeTruthy();

    const search = document.querySelector<HTMLInputElement>('.timeline-preview-search input')!;
    search.value = 'needle';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const items = document.querySelectorAll<HTMLElement>('.timeline-preview-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('find this needle');

    items[0].click();
    expect(root.scrollTo).toHaveBeenCalled();

    dots()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(550);
    await flush();
    expect(removeStarredMessage).toHaveBeenCalledWith(
      'chatgpt:conv:default:one',
      'chatgpt:turn:user-1',
    );
  });

  it('uses the native handler scope for settings and repeated teardown', async () => {
    const root = createScrollRoot();
    createShell(root, 'native-user', 'user', 'native handler prompt', 100);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const scope = new PluginScope();
      try {
        activateChatGptTimeline(scope);
        await flush();
        expect(dots()).toHaveLength(1);
        expect(document.querySelectorAll('.timeline-preview-panel')).toHaveLength(1);
        updateChatGptTimelineSettings({ compactView: true });
        expect(document.querySelector('.timeline-style-compact')).toBeTruthy();
      } finally {
        await scope.dispose();
      }
      expect(dots()).toHaveLength(0);
      expect(document.querySelector('.timeline-preview-panel')).toBeNull();
      updateChatGptTimelineSettings({ compactView: false });
      await settleRefresh();
      expect(document.querySelector('[data-gv-chatgpt-timeline]')).toBeNull();
    }
  });

  it('cleans observers, listeners, timers, and UI across repeated enable/disable cycles', async () => {
    const root = createScrollRoot();
    createShell(root, 'user-1', 'user', 'first prompt', 100);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      startChatGptTimeline();
      await flush();
      expect(document.querySelectorAll('[data-gv-chatgpt-timeline="true"]')).toHaveLength(1);
      expect(document.documentElement.classList.contains(CHATGPT_TIMELINE_ROOT_CLASS)).toBe(true);
      expect(document.querySelectorAll('#gv-chatgpt-timeline-tooltip')).toHaveLength(1);
      dots()[0].dispatchEvent(new PointerEvent('pointerenter'));
      await stopChatGptTimeline();
      expect(document.querySelector('[data-gv-chatgpt-timeline="true"]')).toBeNull();
      expect(document.querySelector('.timeline-preview-panel')).toBeNull();
      expect(document.querySelector('.timeline-preview-toggle')).toBeNull();
      expect(document.querySelector('#gv-chatgpt-timeline-tooltip')).toBeNull();
      expect(document.documentElement.classList.contains(CHATGPT_TIMELINE_ROOT_CLASS)).toBe(false);
      expect(
        Array.from(document.querySelectorAll('style')).some((style) =>
          style.textContent?.includes(CHATGPT_TIMELINE_ROOT_CLASS),
        ),
      ).toBe(false);
    }

    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(
      vi.mocked(chrome.storage.onChanged.addListener).mock.calls.length,
    );
    createShell(root, 'user-2', 'user', 'after disable', 900);
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('[data-gv-chatgpt-timeline="true"]')).toBeNull();
  });
});
