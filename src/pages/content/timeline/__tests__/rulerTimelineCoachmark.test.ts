import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

const mocks = vi.hoisted(() => ({
  getTranslationSync: vi.fn((key: string) => key),
  initI18n: vi.fn(async () => undefined),
  showCoachmark: vi.fn(async (_config: unknown) => 'dismissed'),
  storageGet: vi.fn(async (defaults?: Record<string, unknown>) => defaults ?? {}),
  storageSet: vi.fn(async () => undefined),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: mocks.storageGet, set: mocks.storageSet },
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: mocks.getTranslationSync,
  initI18n: mocks.initI18n,
}));

vi.mock('../../coachmark', () => ({ showCoachmark: mocks.showCoachmark }));

interface CapturedCoachmarkConfig {
  id: string;
  reveal: {
    mount: () => HTMLElement;
    unmount: (element: HTMLElement | null) => void;
  };
  toggle: {
    initial: boolean;
    onChange: (on: boolean) => Promise<void>;
  };
}

describe('ruler timeline coachmark', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'location', {
      value: { hostname: 'gemini.google.com' },
      configurable: true,
      writable: true,
    });
  });

  it('previews the ruler wave and persists the inline style toggle', async () => {
    mocks.storageGet.mockResolvedValue({ [StorageKeys.TIMELINE_STYLE]: 'dots' });
    const { maybeShowRulerTimelineCoachmark } = await import('../rulerTimelineCoachmark');
    const liveTimeline = document.createElement('div');
    liveTimeline.className = 'gemini-timeline-bar';
    document.body.appendChild(liveTimeline);

    await maybeShowRulerTimelineCoachmark({ force: true });

    const config = mocks.showCoachmark.mock.calls[0]![0] as CapturedCoachmarkConfig;
    expect(config.id).toBe('timeline-ruler-style-intro-v1');
    expect(config.toggle.initial).toBe(true);

    const preview = config.reveal.mount();
    expect(preview.classList.contains('is-ruler')).toBe(true);
    expect(preview.querySelectorAll('span')).toHaveLength(14);
    expect(preview.querySelectorAll('span.active')).toHaveLength(1);
    expect(liveTimeline.classList.contains('gv-coach-timeline-hidden')).toBe(true);

    await config.toggle.onChange(false);
    expect(preview.classList.contains('is-dots')).toBe(true);
    await config.toggle.onChange(true);
    expect(preview.classList.contains('is-ruler')).toBe(true);

    await vi.waitFor(() => expect(mocks.storageSet).toHaveBeenCalledTimes(3));
    expect(mocks.storageSet).toHaveBeenNthCalledWith(1, {
      [StorageKeys.TIMELINE_STYLE]: 'ruler',
    });
    expect(mocks.storageSet).toHaveBeenNthCalledWith(2, {
      [StorageKeys.TIMELINE_STYLE]: 'dots',
    });
    expect(mocks.storageSet).toHaveBeenNthCalledWith(3, {
      [StorageKeys.TIMELINE_STYLE]: 'ruler',
    });

    config.reveal.unmount(preview);
    expect(preview.isConnected).toBe(false);
    expect(liveTimeline.classList.contains('gv-coach-timeline-hidden')).toBe(false);
  });

  it('skips users who already use the ruler style', async () => {
    mocks.storageGet.mockResolvedValue({ [StorageKeys.TIMELINE_STYLE]: 'ruler' });
    const { maybeShowRulerTimelineCoachmark } = await import('../rulerTimelineCoachmark');

    await maybeShowRulerTimelineCoachmark();

    expect(mocks.showCoachmark).not.toHaveBeenCalled();
  });

  it('can be forced from the page console through its debug event', async () => {
    const { RULER_TIMELINE_COACHMARK_DEBUG_EVENT } = await import('../rulerTimelineCoachmark');

    document.dispatchEvent(new Event(RULER_TIMELINE_COACHMARK_DEBUG_EVENT));

    await vi.waitFor(() => expect(mocks.showCoachmark).toHaveBeenCalled());
  });
});
