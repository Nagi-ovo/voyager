import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashString } from '@/core/utils/hash';

import {
  buildClaudeConversationId,
  buildClaudeTurnId,
  extractClaudeTurnHash,
  startClaudeTimeline,
  stopClaudeTimeline,
  updateClaudeTimelineSettings,
} from '.';

const {
  addStarredMessage,
  getStarredMessagesForConversation,
  removeStarredMessage,
  setPluginSetting,
  showTimelineStyleCoachmark,
} = vi.hoisted(() => ({
  addStarredMessage: vi.fn().mockResolvedValue(undefined),
  getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
  removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  setPluginSetting: vi.fn().mockResolvedValue(undefined),
  showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock('@/features/plugins/storage/pluginState', () => ({ setPluginSetting }));

vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark,
}));

interface CapturedTimelineCoachmarkOptions {
  id: string;
  enabled: boolean;
  onStyleChange: (compact: boolean) => Promise<void>;
}

function createTurn(text: string): HTMLElement {
  const turn = document.createElement('div');
  turn.setAttribute('data-testid', 'user-message');
  turn.textContent = text;
  return turn;
}

function addTurn(text: string): HTMLElement {
  const turn = createTurn(text);
  document.body.appendChild(turn);
  return turn;
}

function queryDots(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-dot'));
}

function dotLabels(): string[] {
  return queryDots().map((dot) => dot.getAttribute('aria-label') || '');
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

describe('Claude timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    history.replaceState({}, '', '/chat/claude-123');
    getStarredMessagesForConversation.mockResolvedValue([]);
    addStarredMessage.mockClear();
    removeStarredMessage.mockClear();
    setPluginSetting.mockClear();
    showTimelineStyleCoachmark.mockClear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.scrollTo = vi.fn();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  afterEach(async () => {
    await stopClaudeTimeline();
    vi.useRealTimers();
  });

  it('builds Claude-scoped conversation and turn ids', () => {
    expect(buildClaudeConversationId('https://claude.ai/chat/abc')).toBe('claude:conv:abc');
    expect(buildClaudeConversationId('https://claude.ai/new')).toMatch(/^claude:/);
    expect(buildClaudeTurnId('hello')).toBe(`c-${hashString('hello')}`);
    expect(extractClaudeTurnHash(`c-2-${hashString('hello')}`)).toBe(hashString('hello'));
    expect(extractClaudeTurnHash(`c-${hashString('hello')}`)).toBe(hashString('hello'));
    expect(extractClaudeTurnHash(`c-${hashString('hello')}~2`)).toBe(hashString('hello'));
  });

  it('renders one dot per Claude user message, scrolls on click, and highlights active dot', async () => {
    addTurn('first prompt');
    addTurn('second prompt');

    startClaudeTimeline();
    await flush();

    const dots = queryDots();
    expect(dots).toHaveLength(2);

    dots[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
    expect(dots[0].classList.contains('active')).toBe(true);
    expect(dots[0].getAttribute('aria-current')).toBe('true');
  });

  it('shows the compact-view guide when the plugin starts for the first time', async () => {
    addTurn('first prompt');

    startClaudeTimeline({ compactView: false });
    await flush();

    expect(showTimelineStyleCoachmark).toHaveBeenCalledOnce();
    const options = showTimelineStyleCoachmark.mock
      .calls[0]![0] as CapturedTimelineCoachmarkOptions;
    expect(options.id).toBe('claude-timeline-compact-style-intro-v1');
    expect(options.enabled).toBe(false);

    await options.onStyleChange(true);

    expect(setPluginSetting).toHaveBeenCalledWith('voyager.claude-timeline', 'compactView', true);
    expect(
      document.querySelector('.gemini-timeline-bar')?.classList.contains('timeline-style-compact'),
    ).toBe(true);
  });

  it('suppresses the compact-view guide while an artifact iframe is open', async () => {
    addTurn('first prompt');
    const artifact = document.createElement('iframe');
    artifact.src = 'https://abc123.frame.claudeusercontent.com/artifact';
    document.body.appendChild(artifact);
    try {
      startClaudeTimeline({ compactView: false });
      await flush();

      expect(showTimelineStyleCoachmark).not.toHaveBeenCalled();
      // The timeline itself still runs — only the guide is suppressed.
      expect(document.querySelector('.gemini-timeline-bar')).toBeTruthy();
    } finally {
      artifact.remove();
    }
  });

  it('switches live between node and compact hover-panel views', async () => {
    addTurn('first prompt');
    addTurn('second prompt');
    addTurn('third prompt');

    startClaudeTimeline({ compactView: true });
    await flush();

    const bar = document.querySelector<HTMLElement>('.gemini-timeline-bar')!;
    expect(bar.classList.contains('timeline-style-compact')).toBe(true);
    expect(bar.querySelector('.timeline-track')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      queryDots().map((dot) => dot.style.getPropertyValue('--timeline-compact-offset')),
    ).toEqual(['-10px', '0px', '10px']);
    expect(document.querySelector('.timeline-preview-panel-compact')).toBeTruthy();

    bar.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.timeline-preview-panel')?.classList.contains('visible')).toBe(
      true,
    );

    updateClaudeTimelineSettings({ compactView: false });

    expect(bar.classList.contains('timeline-style-compact')).toBe(false);
    expect(bar.querySelector('.timeline-track')?.hasAttribute('aria-hidden')).toBe(false);
    expect(queryDots().every((dot) => dot.style.getPropertyValue('--n') !== '')).toBe(true);
    expect(document.querySelector('.timeline-preview-panel-compact')).toBeNull();
    expect(document.querySelector('.timeline-preview-panel')?.classList.contains('visible')).toBe(
      false,
    );
  });

  it('spreads compact ticks over the whole track instead of a fixed cluster', async () => {
    for (let index = 0; index < 60; index += 1) addTurn(`prompt ${index}`);
    startClaudeTimeline({ compactView: true });
    await flush();

    const track = document.querySelector<HTMLElement>('.timeline-track')!;
    Object.defineProperty(track, 'clientHeight', { configurable: true, value: 1000 });
    window.dispatchEvent(new Event('resize'));

    const offsets = queryDots().map((dot) =>
      dot.style.getPropertyValue('--timeline-compact-offset'),
    );
    expect(offsets[0]).toBe('-295px');
    expect(offsets[30]).toBe('5px');
    expect(offsets[59]).toBe('295px');
  });

  it('jumps from a compact tick without toggling the preview panel or a tooltip', async () => {
    addTurn('first prompt');
    const second = addTurn('second prompt');
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    startClaudeTimeline({ compactView: true });
    await flush();

    const bar = document.querySelector<HTMLElement>('.gemini-timeline-bar')!;
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    const dot = queryDots()[1];
    dot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(
      document.getElementById('gv-turn-navigator-tooltip')?.classList.contains('visible'),
    ).toBe(false);

    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'instant' });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.timeline-preview-panel')?.classList.contains('visible')).toBe(
      false,
    );
  });

  it('updates active dot from the current viewport', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    const firstRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    const secondRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    first.getBoundingClientRect = firstRect;
    second.getBoundingClientRect = secondRect;
    startClaudeTimeline();
    await flush();

    const dots = queryDots();
    expect(dots[0].classList.contains('active')).toBe(true);
    firstRect.mockClear();
    secondRect.mockClear();

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 });
    window.dispatchEvent(new Event('scroll'));

    expect(dots[1].classList.contains('active')).toBe(true);
    expect(firstRect).not.toHaveBeenCalled();
    expect(secondRect).not.toHaveBeenCalled();
  });

  it('activates the last dot when scrolled to the bottom', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    const third = addTurn('last prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(
      () => ({ top: 1580, bottom: 1620, height: 40 }) as DOMRect,
    );
    third.getBoundingClientRect = vi.fn(() => ({ top: 1950, bottom: 1990, height: 40 }) as DOMRect);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });

    startClaudeTimeline();
    await flush();

    const dots = queryDots();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1400 });
    window.dispatchEvent(new Event('scroll'));

    expect(dots[2].classList.contains('active')).toBe(true);
    expect(dots[1].classList.contains('active')).toBe(false);
  });

  it('keeps clicked dot active while the jump settles', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);

    startClaudeTimeline();
    await flush();

    const dots = queryDots();
    dots[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 });
    window.dispatchEvent(new Event('scroll'));

    expect(dots[0].classList.contains('active')).toBe(true);
    expect(dots[1].classList.contains('active')).toBe(false);
  });

  it('scrolls clicked markers to the active anchor', async () => {
    addTurn('first prompt');
    const second = addTurn('second prompt');
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);

    startClaudeTimeline();
    await flush();

    queryDots()[1].click();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'instant' });
  });

  it('long-presses a dot to star it', async () => {
    addTurn('remember this');
    startClaudeTimeline();
    await flush();

    const dot = queryDots()[0];
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(550);
    await flush();

    expect(addStarredMessage).toHaveBeenCalledTimes(1);
    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: buildClaudeTurnId('remember this') }),
    );
    expect(dot.classList.contains('starred')).toBe(true);
    expect(dot.getAttribute('aria-pressed')).toBe('true');
  });

  it('long-presses a compact preview item to star without navigating', async () => {
    addTurn('remember compact item');
    startClaudeTimeline({ compactView: true });
    await flush();

    document
      .querySelector<HTMLElement>('.gemini-timeline-bar')!
      .dispatchEvent(new MouseEvent('mouseenter'));
    const item = document.querySelector<HTMLElement>('.timeline-preview-item')!;
    item.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
        pointerType: 'mouse',
      }),
    );
    vi.advanceTimersByTime(550);
    await flush();
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'mouse' }),
    );
    item.click();

    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: buildClaudeTurnId('remember compact item') }),
    );
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(document.querySelector('.timeline-preview-item')?.classList.contains('starred')).toBe(
      true,
    );
  });

  it('recognizes and unstars messages stored with the legacy index-based id', async () => {
    const legacyId = `c-0-${hashString('first prompt')}`;
    getStarredMessagesForConversation.mockResolvedValue([
      {
        turnId: legacyId,
        content: 'first prompt',
        conversationId: 'claude:conv:claude-123',
        conversationUrl: 'https://claude.ai/chat/claude-123',
        conversationTitle: 'test',
        starredAt: 111,
      },
    ]);
    addTurn('first prompt');
    startClaudeTimeline();
    await flush();

    const dot = queryDots()[0];
    expect(dot.classList.contains('starred')).toBe(true);

    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(550);
    await flush();

    expect(removeStarredMessage).toHaveBeenCalledWith('claude:conv:claude-123', legacyId);
    expect(dot.classList.contains('starred')).toBe(false);
  });

  it('removes a legacy star from the compact preview without navigating', async () => {
    const legacyId = `c-0-${hashString('compact legacy prompt')}`;
    getStarredMessagesForConversation.mockResolvedValue([
      {
        turnId: legacyId,
        content: 'compact legacy prompt',
        conversationId: 'claude:conv:claude-123',
        conversationUrl: 'https://claude.ai/chat/claude-123',
        conversationTitle: 'test',
        starredAt: 111,
      },
    ]);
    addTurn('compact legacy prompt');
    startClaudeTimeline({ compactView: true });
    await flush();

    document
      .querySelector<HTMLElement>('.gemini-timeline-bar')!
      .dispatchEvent(new MouseEvent('mouseenter'));
    const item = document.querySelector<HTMLElement>('.timeline-preview-item')!;
    expect(item.classList.contains('starred')).toBe(true);
    item.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
        pointerType: 'mouse',
      }),
    );
    vi.advanceTimersByTime(550);
    await flush();
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'mouse' }),
    );
    item.click();

    expect(removeStarredMessage).toHaveBeenCalledWith('claude:conv:claude-123', legacyId);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(document.querySelector('.timeline-preview-item')?.classList.contains('starred')).toBe(
      false,
    );
  });

  it('shows message content when hovering a dot', async () => {
    addTurn('hover preview text');
    startClaudeTimeline();
    await flush();

    const dot = queryDots()[0];
    dot.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(150);

    const tooltip = document.querySelector<HTMLElement>('#gv-turn-navigator-tooltip')!;
    expect(tooltip.textContent).toBe('hover preview text');
    expect(tooltip.querySelector('.gv-turn-navigator-tooltip-text')?.textContent).toBe(
      'hover preview text',
    );
    expect(tooltip.classList.contains('visible')).toBe(true);

    dot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  it('keeps dots and ids stable when Claude virtualizes turns out during scroll', async () => {
    const first = addTurn('first prompt');
    addTurn('second prompt');
    startClaudeTimeline();
    await flush();
    expect(queryDots()).toHaveLength(2);
    const secondDotId = queryDots()[1].dataset.targetTurnId;

    // Scroll: Claude unmounts the first turn and mounts a newly visible one.
    first.remove();
    addTurn('third prompt');
    await settleRefresh();

    expect(dotLabels()).toEqual(['first prompt', 'second prompt', 'third prompt']);
    expect(queryDots()[1].dataset.targetTurnId).toBe(secondDotId);

    // Scrolling back re-mounts the first turn: nothing is duplicated.
    document.body.insertBefore(first, document.body.firstChild);
    await settleRefresh();
    expect(dotLabels()).toEqual(['first prompt', 'second prompt', 'third prompt']);
  });

  it('stitches older turns ahead of known ones when scrolling up', async () => {
    const third = addTurn('third prompt');
    const fourth = addTurn('fourth prompt');
    startClaudeTimeline();
    await flush();
    expect(queryDots()).toHaveLength(2);

    // Scrolling up: Claude mounts [first, second, third] and unmounts fourth.
    fourth.remove();
    document.body.insertBefore(createTurn('second prompt'), third);
    document.body.insertBefore(createTurn('first prompt'), third.previousSibling);
    await settleRefresh();

    expect(dotLabels()).toEqual(['first prompt', 'second prompt', 'third prompt', 'fourth prompt']);
  });

  it('never shrinks when the mounted window turns sparse mid-transition', async () => {
    const turns = ['one', 'two', 'three', 'four', 'five'].map((text) => addTurn(text));
    startClaudeTimeline();
    await flush();
    expect(queryDots()).toHaveLength(5);

    // Jump from bottom to top: Claude briefly mounts a non-contiguous set
    // (top + bottom windows coexist) — the accumulated timeline must not drop
    // the unmounted turns in between.
    turns[1].remove();
    turns[2].remove();
    turns[3].remove();
    await settleRefresh();
    expect(dotLabels()).toEqual(['one', 'two', 'three', 'four', 'five']);

    // Turns re-mount as their region scrolls back in: still no duplicates.
    document.body.insertBefore(turns[2], turns[4]);
    await settleRefresh();
    expect(dotLabels()).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('keeps the opening turns ahead of the bottom window when Claude leaves the latest turn mounted', async () => {
    const rect = (top: number) => vi.fn(() => ({ top, bottom: top + 40, height: 40 }) as DOMRect);
    // Loaded at the bottom: only the last turns are mounted.
    const lateOne = addTurn('late one');
    const lateTwo = addTurn('late two');
    const last = addTurn('last prompt');
    lateOne.getBoundingClientRect = rect(38000);
    lateTwo.getBoundingClientRect = rect(38500);
    last.getBoundingClientRect = rect(39000);
    startClaudeTimeline();
    await flush();
    expect(dotLabels()).toEqual(['late one', 'late two', 'last prompt']);

    // Scrolled to the top: Claude mounts the opening turns, unmounts the late
    // ones, but keeps the latest turn mounted (and re-measured further down).
    lateOne.remove();
    lateTwo.remove();
    const first = createTurn('first prompt');
    const second = createTurn('second prompt');
    first.getBoundingClientRect = rect(100);
    second.getBoundingClientRect = rect(1200);
    document.body.insertBefore(second, last);
    document.body.insertBefore(first, second);
    last.getBoundingClientRect = rect(41600);
    await settleRefresh();

    expect(dotLabels()).toEqual([
      'first prompt',
      'second prompt',
      'late one',
      'late two',
      'last prompt',
    ]);
  });

  it('places a new turn by the drift of its nearer anchor when the two anchors drifted differently', async () => {
    const rect = (top: number) => vi.fn(() => ({ top, bottom: top + 40, height: 40 }) as DOMRect);
    const a = addTurn('turn a');
    const b = addTurn('turn b');
    const c = addTurn('turn c');
    const d = addTurn('turn d');
    a.getBoundingClientRect = rect(1000);
    b.getBoundingClientRect = rect(2000);
    c.getBoundingClientRect = rect(3000);
    d.getBoundingClientRect = rect(4000);
    startClaudeTimeline();
    await flush();

    // b and c unmount; a stays where it was, d is re-measured 2000px lower, and
    // a new turn x mounts between them at 2600. Under a's drift (0) x sits
    // after b; only under d's drift would it land before b.
    b.remove();
    c.remove();
    const x = createTurn('turn x');
    x.getBoundingClientRect = rect(2600);
    document.body.insertBefore(x, d);
    d.getBoundingClientRect = rect(6000);
    await settleRefresh();

    expect(dotLabels()).toEqual(['turn a', 'turn b', 'turn x', 'turn c', 'turn d']);
  });

  it('files a bottom window behind the known opening turns when the first turn stays mounted', async () => {
    const rect = (top: number) => vi.fn(() => ({ top, bottom: top + 40, height: 40 }) as DOMRect);
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    const third = addTurn('third prompt');
    first.getBoundingClientRect = rect(100);
    second.getBoundingClientRect = rect(1200);
    third.getBoundingClientRect = rect(2300);
    startClaudeTimeline();
    await flush();

    second.remove();
    third.remove();
    const late = addTurn('late prompt');
    const last = addTurn('last prompt');
    late.getBoundingClientRect = rect(38000);
    last.getBoundingClientRect = rect(39000);
    await settleRefresh();

    expect(dotLabels()).toEqual([
      'first prompt',
      'second prompt',
      'third prompt',
      'late prompt',
      'last prompt',
    ]);
  });

  it('assigns distinct ids to turns with identical text', async () => {
    addTurn('same text');
    addTurn('same text');
    startClaudeTimeline();
    await flush();

    const ids = queryDots().map((dot) => dot.dataset.targetTurnId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(buildClaudeTurnId('same text'));
    expect(ids[1]).toBe(`${buildClaudeTurnId('same text')}~2`);
  });

  it('keeps homing toward a virtualized-out turn until it mounts, then aims precisely', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    startClaudeTimeline();
    await flush();

    second.remove();
    await settleRefresh();
    expect(queryDots()).toHaveLength(2);

    // First hop jumps instantly to the remembered offset (center 720 → top 450).
    queryDots()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'instant' });

    // Still unmounted after a hop interval: bisect further instead of giving up.
    vi.advanceTimersByTime(200);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1030, behavior: 'instant' });

    // Turn mounts: the next hop aims precisely and stops.
    document.body.appendChild(second);
    await flush();
    vi.advanceTimersByTime(200);
    await flush();
    expect(window.scrollTo).toHaveBeenCalledTimes(3);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: 'instant' });

    vi.advanceTimersByTime(600);
    expect(window.scrollTo).toHaveBeenCalledTimes(3);
  });

  it('homes into a virtualization gap between mounted turns', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    const third = addTurn('third prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    third.getBoundingClientRect = vi.fn(() => ({ top: 1300, bottom: 1340, height: 40 }) as DOMRect);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    startClaudeTimeline();
    await flush();

    second.remove();
    await settleRefresh();
    expect(queryDots()).toHaveLength(3);

    // Target sits between two mounted turns: probe its remembered offset...
    queryDots()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'instant' });

    // ...then bisect between the mounted neighbours instead of giving up.
    vi.advanceTimersByTime(200);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'instant' });

    document.body.insertBefore(second, third);
    await flush();
    vi.advanceTimersByTime(200);
    await flush();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: 'instant' });
  });

  it('jumps instantly for long-distance navigation to a mounted turn, then fine-aims', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(
      () => ({ top: 5000, bottom: 5040, height: 40 }) as DOMRect,
    );
    startClaudeTimeline();
    await flush();

    // Distance > 3 viewports: jump, then fine-aim once the region re-measures.
    queryDots()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 4750, behavior: 'instant' });

    // Next hop fine-aims and ends the navigation.
    vi.advanceTimersByTime(200);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 4750, behavior: 'instant' });

    vi.advanceTimersByTime(600);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
  });

  it('stops homing when the user scrolls manually', async () => {
    const first = addTurn('first prompt');
    const second = addTurn('second prompt');
    first.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 40, height: 40 }) as DOMRect);
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    startClaudeTimeline();
    await flush();

    second.remove();
    await settleRefresh();

    queryDots()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('wheel'));
    vi.advanceTimersByTime(1000);
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('consumes a gv-turn hash once instead of re-navigating on every refresh', async () => {
    addTurn('first prompt');
    const second = addTurn('second prompt');
    second.getBoundingClientRect = vi.fn(() => ({ top: 700, bottom: 740, height: 40 }) as DOMRect);
    const legacyHashId = `c-1-${hashString('second prompt')}`;
    history.replaceState({}, '', `/chat/claude-123#gv-turn-${legacyHashId}`);

    startClaudeTimeline();
    await flush();

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'instant' });

    addTurn('third prompt');
    await settleRefresh();
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('keeps existing dots on unrelated DOM changes', async () => {
    addTurn('first prompt');
    startClaudeTimeline();
    await flush();
    const dot = queryDots()[0];
    const queryAll = vi.spyOn(document, 'querySelectorAll');

    document.body.appendChild(document.createElement('main'));
    await settleRefresh();

    expect(queryAll).not.toHaveBeenCalled();
    expect(queryDots()[0]).toBe(dot);
    queryAll.mockRestore();
  });

  it('rolls back data-gv-turn-id stamps on stop', async () => {
    addTurn('first prompt');
    startClaudeTimeline();
    await flush();
    expect(document.querySelectorAll('[data-gv-turn-id]').length).toBeGreaterThan(0);

    await stopClaudeTimeline();
    expect(document.querySelectorAll('[data-gv-turn-id]').length).toBe(0);
  });

  it('removes UI on stop', async () => {
    addTurn('first prompt');
    startClaudeTimeline();
    await flush();
    expect(document.querySelector('.gemini-timeline-bar')).toBeTruthy();

    await stopClaudeTimeline();
    expect(document.querySelector('.gemini-timeline-bar')).toBeNull();
    expect(document.querySelector('.timeline-preview-toggle')).toBeNull();
    expect(document.querySelector('#gv-turn-navigator-tooltip')).toBeNull();
  });
});
