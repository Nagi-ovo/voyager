/** One-time guided intro for the compact ruler timeline. */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { getTranslationSync, initI18n } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import {
  type CoachmarkProgress,
  type CoachmarkResult,
  type CoachmarkSequenceStep,
  showCoachmark,
} from '../coachmark';

export const RULER_TIMELINE_COACHMARK_ID = 'timeline-ruler-style-intro-v1';
export const RULER_TIMELINE_COACHMARK_DEBUG_EVENT = 'gv:debug:rulerTimelineCoachmark';
const PREVIEW_TICK_COUNT = 14;

const RULER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h5M5 8.5h9M5 12h13M5 15.5h9M5 19h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const t = (key: TranslationKey, fallback: string): string => {
  try {
    const value = getTranslationSync(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
};

async function loadRulerTimelineEnabled(): Promise<boolean> {
  try {
    const got = (await browser.storage.sync.get({
      [StorageKeys.TIMELINE_STYLE]: 'dots',
    })) as Record<string, unknown>;
    return got[StorageKeys.TIMELINE_STYLE] === 'ruler';
  } catch {
    return false;
  }
}

async function setRulerTimelineEnabled(on: boolean): Promise<void> {
  try {
    await browser.storage.sync.set({
      [StorageKeys.TIMELINE_STYLE]: on ? 'ruler' : 'dots',
    });
  } catch {
    /* non-critical */
  }
}

function buildRulerPreview(ruler: boolean): HTMLElement {
  const preview = document.createElement('div');
  preview.className = `gv-timeline-style-preview ${ruler ? 'is-ruler' : 'is-dots'}`;
  preview.setAttribute('aria-hidden', 'true');

  const crestIndex = Math.floor(PREVIEW_TICK_COUNT / 2);
  for (let index = 0; index < PREVIEW_TICK_COUNT; index += 1) {
    const tick = document.createElement('span');
    const distance = Math.abs(index - crestIndex);
    const crest = Math.exp(-(distance * distance) / (2 * 1.25 * 1.25));
    tick.style.setProperty('--gv-coach-ruler-scale', (0.28 + 0.72 * crest).toFixed(3));
    if (index === crestIndex) tick.className = 'active';
    preview.appendChild(tick);
  }

  document.body.appendChild(preview);
  return preview;
}

function setPreviewStyle(preview: HTMLElement | null, ruler: boolean): void {
  if (!preview) return;
  preview.classList.toggle('is-ruler', ruler);
  preview.classList.toggle('is-dots', !ruler);
}

export async function maybeShowRulerTimelineCoachmark(
  opts: { force?: boolean; progress?: CoachmarkProgress } = {},
): Promise<CoachmarkResult> {
  if (location.hostname !== 'gemini.google.com') return 'skipped';
  const enabled = await loadRulerTimelineEnabled();
  if (enabled && !opts.force) return 'skipped';

  try {
    await initI18n();
  } catch {
    /* fall back to literals */
  }

  let preview: HTMLElement | null = null;
  let hiddenTimelineElements: HTMLElement[] = [];

  return showCoachmark({
    id: RULER_TIMELINE_COACHMARK_ID,
    once: !opts.force,
    scrim: true,
    icon: RULER_ICON,
    title: t('timelineRulerCoachmarkTitle', 'New: ruler timeline'),
    body: t(
      'timelineRulerCoachmarkBody',
      'A compact signal follows your reading position. Hover any tick to instantly preview the question and response.',
    ),
    placement: 'top',
    reveal: {
      mount: () => {
        hiddenTimelineElements = Array.from(
          document.querySelectorAll<HTMLElement>('.gemini-timeline-bar, .timeline-left-slider'),
        );
        hiddenTimelineElements.forEach((element) =>
          element.classList.add('gv-coach-timeline-hidden'),
        );
        preview = buildRulerPreview(true);
        void setRulerTimelineEnabled(true);
        return preview;
      },
      unmount: (element) => {
        hiddenTimelineElements.forEach((timelineElement) =>
          timelineElement.classList.remove('gv-coach-timeline-hidden'),
        );
        hiddenTimelineElements = [];
        if (preview === element) preview = null;
        element?.remove();
      },
    },
    anchor: () => null,
    toggle: {
      label: t('timelineRulerCoachmarkToggle', 'Use ruler timeline'),
      initial: true,
      onChange: (on) => {
        setPreviewStyle(preview, on);
        return setRulerTimelineEnabled(on);
      },
    },
    dismissLabel: t('coachmarkDismiss', 'Done'),
    nextLabel: t('coachmarkNext', 'Next'),
    closeLabel: t('coachmarkClose', 'Close'),
    progress: opts.progress,
  });
}

export const rulerTimelineCoachmarkStep: CoachmarkSequenceStep = {
  id: RULER_TIMELINE_COACHMARK_ID,
  isEligible: async () =>
    location.hostname === 'gemini.google.com' && !(await loadRulerTimelineEnabled()),
  show: (progress) => maybeShowRulerTimelineCoachmark({ progress }),
};

const showDebugRulerTimelineCoachmark = () => void maybeShowRulerTimelineCoachmark({ force: true });

// Debug: document.dispatchEvent(new Event('gv:debug:rulerTimelineCoachmark'))
try {
  (window as unknown as Record<string, unknown>).__gvRulerTimelineCoachmark =
    showDebugRulerTimelineCoachmark;
  document.addEventListener(RULER_TIMELINE_COACHMARK_DEBUG_EVENT, showDebugRulerTimelineCoachmark);
} catch {
  /* ignore */
}
