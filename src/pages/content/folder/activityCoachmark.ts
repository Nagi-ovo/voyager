/** One-time guided intro for the attention-first Activity folder view. */
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
import { keepSidebarExpanded } from '../sidebarAutoHide';

export const FOLDER_ACTIVITY_COACHMARK_ID = 'folder-activity-view-intro-v1';
export const FOLDER_ACTIVITY_COACHMARK_DEBUG_EVENT = 'gv:debug:folderActivityCoachmark';
const SIDEBAR_EXPAND_WAIT_MS = 320;

const ACTIVITY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const t = (key: TranslationKey, fallback: string): string => {
  try {
    const value = getTranslationSync(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
};

interface ActivityCoachmarkState {
  available: boolean;
  enabled: boolean;
}

async function loadActivityCoachmarkState(): Promise<ActivityCoachmarkState> {
  try {
    const [syncState, localState] = await Promise.all([
      browser.storage.sync.get({
        [StorageKeys.FOLDER_ENABLED]: true,
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
      }),
      browser.storage.local.get({ [StorageKeys.FOLDERS_VIEW_MODE]: 'folders' }),
    ]);
    return {
      available:
        syncState[StorageKeys.FOLDER_ENABLED] !== false &&
        syncState[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] !== true,
      enabled: localState[StorageKeys.FOLDERS_VIEW_MODE] === 'activity',
    };
  } catch {
    return { available: false, enabled: false };
  }
}

async function setActivityViewEnabled(on: boolean): Promise<void> {
  try {
    await browser.storage.local.set({
      [StorageKeys.FOLDERS_VIEW_MODE]: on ? 'activity' : 'folders',
      ...(on ? { [StorageKeys.FOLDERS_COLLAPSED]: false } : {}),
    });
  } catch {
    /* non-critical */
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function getVisibleActivityButton(): HTMLButtonElement | null {
  const button = document.querySelector<HTMLButtonElement>('.gv-folder-activity-toggle');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? button : null;
}

export async function maybeShowFolderActivityCoachmark(
  opts: { force?: boolean; progress?: CoachmarkProgress } = {},
): Promise<CoachmarkResult> {
  if (location.hostname !== 'gemini.google.com') return 'skipped';
  const state = await loadActivityCoachmarkState();
  if ((!state.available || state.enabled) && !opts.force) return 'skipped';

  try {
    await initI18n();
  } catch {
    /* fall back to literals */
  }

  const releaseSidebar = keepSidebarExpanded();
  try {
    await wait(SIDEBAR_EXPAND_WAIT_MS);
    return await showCoachmark({
      id: FOLDER_ACTIVITY_COACHMARK_ID,
      once: !opts.force,
      scrim: true,
      icon: ACTIVITY_ICON,
      title: t('folderActivityCoachmarkTitle', 'New: Activity view'),
      body: t(
        'folderActivityCoachmarkBody',
        'Focus on conversations in motion: Priority, today, and recent days—without moving anything out of its folders.',
      ),
      placement: 'bottom',
      anchor: getVisibleActivityButton,
      toggle: {
        label: t('folderActivityCoachmarkToggle', 'Use Activity view'),
        initial: state.enabled,
        onChange: setActivityViewEnabled,
      },
      dismissLabel: t('coachmarkDismiss', 'Done'),
      nextLabel: t('coachmarkNext', 'Next'),
      closeLabel: t('coachmarkClose', 'Close'),
      progress: opts.progress,
    });
  } finally {
    releaseSidebar();
  }
}

export const folderActivityCoachmarkStep: CoachmarkSequenceStep = {
  id: FOLDER_ACTIVITY_COACHMARK_ID,
  isEligible: async () => {
    if (location.hostname !== 'gemini.google.com') return false;
    const state = await loadActivityCoachmarkState();
    return state.available && !state.enabled;
  },
  show: (progress) => maybeShowFolderActivityCoachmark({ progress }),
};

const showDebugFolderActivityCoachmark = () =>
  void maybeShowFolderActivityCoachmark({ force: true });

// Debug: document.dispatchEvent(new Event('gv:debug:folderActivityCoachmark'))
try {
  (window as unknown as Record<string, unknown>).__gvFolderActivityCoachmark =
    showDebugFolderActivityCoachmark;
  document.addEventListener(
    FOLDER_ACTIVITY_COACHMARK_DEBUG_EVENT,
    showDebugFolderActivityCoachmark,
  );
} catch {
  /* ignore */
}
