/**
 * One-time guided intro for the compact timeline style.
 *
 * The guide reveals a static replica of the compact rail, temporarily hides the
 * live rail, and lets the user compare both styles without overlapping UI.
 */
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

export const TIMELINE_STYLE_COACHMARK_ID = 'timeline-compact-style-intro-v2';
const PREVIEW_TICK_COUNT = 14;
export const TIMELINE_STYLE_COACHMARK_DEBUG_EVENT = 'gv:debug:timelineStyleCoachmark';

const TIMELINE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6.5h12M6 10.2h12M6 13.8h12M6 17.5h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const t = (key: TranslationKey, fallback: string): string => {
  try {
    const value = getTranslationSync(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
};

async function loadCompactTimelineEnabled(): Promise<boolean> {
  try {
    const got = (await browser.storage.sync.get({
      [StorageKeys.TIMELINE_STYLE]: 'dots',
    })) as Record<string, unknown>;
    return got[StorageKeys.TIMELINE_STYLE] === 'compact';
  } catch {
    return false;
  }
}

async function setCompactTimelineEnabled(on: boolean): Promise<void> {
  try {
    await browser.storage.sync.set({
      [StorageKeys.TIMELINE_STYLE]: on ? 'compact' : 'dots',
    });
  } catch {
    /* non-critical */
  }
}

interface TimelineStyleCoachmarkOptions {
  id: string;
  enabled: boolean;
  force?: boolean;
  progress?: CoachmarkProgress;
  /** Abort to close the guide when the owning feature tears down. */
  signal?: AbortSignal;
  onStyleChange: (compact: boolean) => void | Promise<void>;
}

/** A non-interactive timeline replica that can morph between both styles. */
function buildTimelineStylePreview(compact: boolean): HTMLElement {
  const preview = document.createElement('div');
  preview.className = `gv-timeline-style-preview ${compact ? 'is-compact' : 'is-dots'}`;
  preview.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < PREVIEW_TICK_COUNT; index += 1) {
    const tick = document.createElement('span');
    if (index === Math.floor(PREVIEW_TICK_COUNT / 2)) tick.className = 'active';
    preview.appendChild(tick);
  }

  document.body.appendChild(preview);
  return preview;
}

function setPreviewStyle(preview: HTMLElement | null, compact: boolean): void {
  if (!preview) return;
  preview.classList.toggle('is-compact', compact);
  preview.classList.toggle('is-dots', !compact);
}

/** Shared compact-timeline intro used by native and plugin timelines. */
export async function showTimelineStyleCoachmark({
  id,
  enabled,
  force = false,
  progress,
  signal,
  onStyleChange,
}: TimelineStyleCoachmarkOptions): Promise<CoachmarkResult> {
  if (enabled && !force) return 'skipped';

  try {
    await initI18n();
  } catch {
    /* fall back to literals */
  }

  let preview: HTMLElement | null = null;
  let hiddenTimelineElements: HTMLElement[] = [];

  return showCoachmark({
    id,
    once: !force,
    scrim: true,
    icon: TIMELINE_ICON,
    title: t('timelineCoachmarkTitle', 'New: compact timeline'),
    body: t(
      'timelineCoachmarkBody',
      'Keep the right edge quiet. Hover the compact index to open every message in one panel.',
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
        preview = buildTimelineStylePreview(true);
        void Promise.resolve(onStyleChange(true)).catch(() => {});
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
      label: t('timelineCoachmarkToggle', 'Use compact timeline'),
      initial: true,
      onChange: (on) => {
        setPreviewStyle(preview, on);
        return onStyleChange(on);
      },
    },
    dismissLabel: t('coachmarkDismiss', 'Done'),
    nextLabel: t('coachmarkNext', 'Next'),
    closeLabel: t('coachmarkClose', 'Close'),
    progress,
    signal,
  });
}

/**
 * Show Gemini's compact-timeline intro once. `force` re-shows it for debugging
 * and bypasses the already-enabled short-circuit.
 */
export async function maybeShowTimelineStyleCoachmark(
  opts: { force?: boolean; progress?: CoachmarkProgress } = {},
): Promise<CoachmarkResult> {
  if (location.hostname !== 'gemini.google.com') return 'skipped';
  const enabled = await loadCompactTimelineEnabled();
  return showTimelineStyleCoachmark({
    id: TIMELINE_STYLE_COACHMARK_ID,
    enabled,
    force: opts.force,
    progress: opts.progress,
    onStyleChange: setCompactTimelineEnabled,
  });
}

export const timelineStyleCoachmarkStep: CoachmarkSequenceStep = {
  id: TIMELINE_STYLE_COACHMARK_ID,
  isEligible: async () =>
    location.hostname === 'gemini.google.com' && !(await loadCompactTimelineEnabled()),
  show: (progress) => maybeShowTimelineStyleCoachmark({ progress }),
};

const showDebugTimelineStyleCoachmark = () => void maybeShowTimelineStyleCoachmark({ force: true });

// Debug from the normal page console:
// document.dispatchEvent(new Event('gv:debug:timelineStyleCoachmark'))
try {
  (window as unknown as Record<string, unknown>).__gvTimelineStyleCoachmark =
    showDebugTimelineStyleCoachmark;
  document.addEventListener(TIMELINE_STYLE_COACHMARK_DEBUG_EVENT, showDebugTimelineStyleCoachmark);
} catch {
  /* ignore */
}
