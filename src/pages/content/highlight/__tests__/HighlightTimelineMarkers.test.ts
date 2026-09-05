import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HighlightTimelineMarkers } from '../HighlightTimelineMarkers';
import { installConversation, makeRecord } from './fixtures';

describe('HighlightTimelineMarkers', () => {
  let markers: HighlightTimelineMarkers;
  let bar: HTMLElement;
  let track: HTMLElement;
  let scrollContainer: HTMLElement;
  const navigate = vi.fn<(id: string) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    navigate.mockReset();
    const response = installConversation();
    response.innerHTML = '<mark class="gv-highlight-mark">target</mark>';
    const mark = response.querySelector<HTMLElement>('mark')!;
    scrollContainer = document.querySelector<HTMLElement>('main')!;
    scrollContainer.style.overflowY = 'auto';
    scrollContainer.scrollTop = 250;
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000 });
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 100, 600, 500),
    );
    vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 350, 60, 20));
    bar = document.querySelector<HTMLElement>('.gemini-timeline-bar')!;
    track = document.querySelector<HTMLElement>('.timeline-track-content')!;
    Object.defineProperty(track, 'scrollHeight', { value: 800 });
    Object.defineProperty(bar, 'clientHeight', { value: 200 });
    const record = makeRecord({
      quote: { exact: 'target', prefix: '', suffix: '' },
      position: { start: 0, end: 6 },
      sourceTextHash: 'source',
    });
    markers = new HighlightTimelineMarkers(
      new Map([[record.id, record]]),
      new Map([[record.id, [mark]]]),
      navigate,
    );
    markers.start();
    markers.render();
  });

  afterEach(() => {
    markers.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uses the owning scroll position and the correct height in classic and compact modes', async () => {
    const classic = track.querySelector<HTMLButtonElement>('.gv-highlight-timeline-tick')!;
    expect(classic.style.top).toBe('200px');
    classic.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('highlight-1');

    bar.classList.add('timeline-style-compact');
    await vi.advanceTimersByTimeAsync(0);

    const compact = bar.querySelector<HTMLButtonElement>('.gv-highlight-timeline-tick')!;
    expect(compact.parentElement).toBe(bar);
    expect(compact.style.top).toBe('50px');
    expect(classic.isConnected).toBe(false);

    scrollContainer.scrollTop = 650;
    scrollContainer.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);
    expect(compact.style.top).toBe('90px');
  });

  it('cancels a scheduled position update and releases viewport listeners on destruction', async () => {
    window.dispatchEvent(new Event('resize'));
    markers.destroy();
    await vi.advanceTimersByTimeAsync(20);
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();

    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    window.dispatchEvent(new Event('resize'));
    scrollContainer.dispatchEvent(new Event('scroll'));
    bar.classList.add('timeline-style-compact');
    await vi.advanceTimersByTimeAsync(20);

    expect(requestFrame).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();
  });
});
