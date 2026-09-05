import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeSidebarObserver } from './NativeSidebarObserver';

function conversation(id: string): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-test-id', 'conversation');
  row.innerHTML = `<a href="/app/${id}"><span class="title-text">Original title</span></a>`;
  return row;
}

describe('NativeSidebarObserver', () => {
  let observer: NativeSidebarObserver;
  let sidebar: HTMLElement;
  let idleCallbacks: Map<number, IdleRequestCallback>;
  let nextIdleId: number;
  let hasStoredConversations: boolean;
  const enhanceConversation = vi.fn();
  const onTitlesChanged = vi.fn();

  function drainIdle(
    deadline: IdleDeadline = { didTimeout: false, timeRemaining: () => 50 },
  ): void {
    const first = idleCallbacks.entries().next().value;
    if (!first) throw new Error('Expected scheduled idle work');
    const [id, callback] = first;
    idleCallbacks.delete(id);
    callback(deadline);
  }

  async function flushObservedMutations(): Promise<void> {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    enhanceConversation.mockReset();
    onTitlesChanged.mockReset();
    idleCallbacks = new Map();
    nextIdleId = 0;
    hasStoredConversations = false;
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      const id = ++nextIdleId;
      idleCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelIdleCallback', (id: number) => idleCallbacks.delete(id));
    sidebar = document.createElement('div');
    document.body.appendChild(sidebar);
    observer = new NativeSidebarObserver({
      isDestroyed: () => false,
      enhanceConversation,
      hasStoredConversations: () => hasStoredConversations,
      onTitlesChanged,
    });
  });

  afterEach(() => {
    observer.stop();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('queues initial sweeps once and performs row work only during idle time', () => {
    const rows = [conversation('aaaaaaaa'), conversation('bbbbbbbb')];
    sidebar.append(...rows);
    observer.enqueueConversations(sidebar);
    observer.enqueueConversations(sidebar);
    expect(enhanceConversation).not.toHaveBeenCalled();
    expect(idleCallbacks.size).toBe(1);

    drainIdle();

    expect(enhanceConversation.mock.calls.map(([row]) => row)).toEqual(rows);
    expect(idleCallbacks.size).toBe(0);
  });

  it('deduplicates repeated additions across observer ticks before scheduling row work', async () => {
    observer.observe(sidebar);
    const row = conversation('aaaaaaaa');
    for (let index = 0; index < 5; index++) {
      sidebar.appendChild(row);
      await Promise.resolve();
    }
    expect(enhanceConversation).not.toHaveBeenCalled();
    await flushObservedMutations();
    expect(enhanceConversation).not.toHaveBeenCalled();
    expect(idleCallbacks.size).toBe(1);

    drainIdle();

    expect(enhanceConversation).toHaveBeenCalledExactlyOnceWith(row);
  });

  it('skips a conversation removed while its enhancement was queued', () => {
    const row = conversation('aaaaaaaa');
    sidebar.appendChild(row);
    observer.enqueueConversations(sidebar);
    row.remove();

    drainIdle();

    expect(enhanceConversation).not.toHaveBeenCalled();
  });

  it('ignores removal-only batches while continuing to enhance new rows offline', async () => {
    hasStoredConversations = true;
    const removed = conversation('aaaaaaaa');
    sidebar.appendChild(removed);
    observer.observe(sidebar);
    removed.remove();
    await flushObservedMutations();
    expect(idleCallbacks.size).toBe(0);
    expect(onTitlesChanged).not.toHaveBeenCalled();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const added = conversation('bbbbbbbb');
    sidebar.appendChild(added);
    await flushObservedMutations();
    drainIdle();

    expect(enhanceConversation).toHaveBeenCalledExactlyOnceWith(added);
  });

  it('yields when the idle budget expires and resumes the remaining rows', () => {
    const rows = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map(conversation);
    sidebar.append(...rows);
    observer.enqueueConversations(sidebar);

    drainIdle({ didTimeout: false, timeRemaining: () => 0 });
    expect(enhanceConversation.mock.calls.map(([row]) => row)).toEqual(rows.slice(0, 1));
    expect(idleCallbacks.size).toBe(1);
    drainIdle();

    expect(enhanceConversation.mock.calls.map(([row]) => row)).toEqual(rows);
    expect(idleCallbacks.size).toBe(0);
  });

  it('uses a bounded fallback budget when an idle callback fires because of its timeout', () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    enhanceConversation.mockImplementation(() => {
      elapsed += 9;
    });
    const rows = ['aaaaaaaa', 'bbbbbbbb'].map(conversation);
    sidebar.append(...rows);
    observer.enqueueConversations(sidebar);

    drainIdle({ didTimeout: true, timeRemaining: () => 0 });
    expect(enhanceConversation).toHaveBeenCalledExactlyOnceWith(rows[0]);
    drainIdle();

    expect(enhanceConversation.mock.calls.map(([row]) => row)).toEqual(rows);
  });

  it('coalesces native title mutations and cancels a scheduled title sync explicitly', async () => {
    hasStoredConversations = true;
    const row = conversation('aaaaaaaa');
    sidebar.appendChild(row);
    observer.observe(sidebar);
    row.querySelector('.title-text')!.firstChild!.textContent = 'Renamed';
    row.querySelector('a')!.setAttribute('title', 'Renamed');
    await flushObservedMutations();
    expect(onTitlesChanged).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(onTitlesChanged).toHaveBeenCalledTimes(1);
    row.querySelector('.title-text')!.textContent = 'Another name';
    await flushObservedMutations();
    observer.clearTitleSync();
    await vi.advanceTimersByTimeAsync(300);

    expect(onTitlesChanged).toHaveBeenCalledTimes(1);
  });

  it('does not schedule title synchronization when there are no stored conversations', async () => {
    const row = conversation('aaaaaaaa');
    sidebar.appendChild(row);
    observer.observe(sidebar);
    row.querySelector('.title-text')!.textContent = 'Renamed';
    await flushObservedMutations();
    await vi.advanceTimersByTimeAsync(300);

    expect(onTitlesChanged).not.toHaveBeenCalled();
  });

  it('disconnects mutation delivery while preserving row work queued before a sidebar remount', async () => {
    const queued = conversation('aaaaaaaa');
    sidebar.appendChild(queued);
    observer.observe(sidebar);
    observer.enqueueConversations(sidebar);
    observer.disconnect();
    sidebar.appendChild(conversation('bbbbbbbb'));
    await flushObservedMutations();

    drainIdle();

    expect(enhanceConversation).toHaveBeenCalledExactlyOnceWith(queued);
  });

  it.each(['before flush', 'after flush'] as const)(
    'stops pending mutation, enhancement and title work %s',
    async (when) => {
      hasStoredConversations = true;
      observer.observe(sidebar);
      sidebar.appendChild(conversation('aaaaaaaa'));
      await Promise.resolve();
      if (when === 'after flush') await flushObservedMutations();

      observer.stop();
      sidebar.appendChild(conversation('bbbbbbbb'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(idleCallbacks.size).toBe(0);
      expect(enhanceConversation).not.toHaveBeenCalled();
      expect(onTitlesChanged).not.toHaveBeenCalled();
    },
  );
});
