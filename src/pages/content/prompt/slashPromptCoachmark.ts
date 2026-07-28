import browser from 'webextension-polyfill';

import { promptStorageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';
import { getTranslationSync, initI18n } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { findChatInput } from '../chatInput';
import {
  type CoachmarkProgress,
  type CoachmarkResult,
  type CoachmarkSequenceStep,
  showCoachmark,
} from '../coachmark';
import { hasSlashEligiblePrompts, isGeminiSlashPromptSurface } from './slashPrompt';

export const SLASH_PROMPT_COACHMARK_ID = 'slash-prompt-insertion-intro';
export const SLASH_PROMPT_COACHMARK_DEBUG_EVENT = 'gv:debug:slashPromptCoachmark';

const t = (key: TranslationKey, fallback: string): string => {
  try {
    const value = getTranslationSync(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
};

interface SlashPromptCoachmarkState {
  enabled: boolean;
  prompts: PromptItem[];
}

async function loadSlashPromptCoachmarkState(): Promise<SlashPromptCoachmarkState> {
  const [setting, storedPrompts] = await Promise.all([
    browser.storage.sync
      .get({ [StorageKeys.SLASH_PROMPT_ENABLED]: true })
      .catch(() => ({ [StorageKeys.SLASH_PROMPT_ENABLED]: true })),
    promptStorageService.get<PromptItem[]>(StorageKeys.PROMPT_ITEMS),
  ]);

  return {
    enabled: setting[StorageKeys.SLASH_PROMPT_ENABLED] !== false,
    prompts: storedPrompts.success && Array.isArray(storedPrompts.data) ? storedPrompts.data : [],
  };
}

async function setSlashPromptEnabled(enabled: boolean): Promise<void> {
  try {
    await browser.storage.sync.set({ [StorageKeys.SLASH_PROMPT_ENABLED]: enabled });
  } catch {
    /* non-critical */
  }
}

export async function isSlashPromptCoachmarkEligible(): Promise<boolean> {
  if (!isGeminiSlashPromptSurface()) return false;
  const state = await loadSlashPromptCoachmarkState();
  return state.enabled && hasSlashEligiblePrompts(state.prompts);
}

export async function maybeShowSlashPromptCoachmark(
  options: { force?: boolean; progress?: CoachmarkProgress } = {},
): Promise<CoachmarkResult> {
  if (!isGeminiSlashPromptSurface()) return 'skipped';

  const state = await loadSlashPromptCoachmarkState();
  if (!options.force && (!state.enabled || !hasSlashEligiblePrompts(state.prompts))) {
    return 'skipped';
  }

  try {
    await initI18n();
  } catch {
    /* fall back to literals */
  }

  return showCoachmark({
    id: SLASH_PROMPT_COACHMARK_ID,
    once: !options.force,
    scrim: true,
    title: t('slashPromptCoachmarkTitle', 'New: slash prompt insertion'),
    body: t(
      'slashPromptCoachmarkBody',
      'Type / in the Gemini composer to quickly insert a saved Prompt.',
    ),
    placement: 'top',
    anchor: () => findChatInput(),
    toggle: {
      label: t('slashPromptCoachmarkToggle', 'Enable slash prompt insertion'),
      initial: state.enabled,
      onChange: setSlashPromptEnabled,
    },
    dismissLabel: t('coachmarkDismiss', 'Done'),
    nextLabel: t('coachmarkNext', 'Next'),
    closeLabel: t('coachmarkClose', 'Close'),
    progress: options.progress,
    focusOnOpen: false,
  });
}

export const slashPromptCoachmarkStep: CoachmarkSequenceStep = {
  id: SLASH_PROMPT_COACHMARK_ID,
  isEligible: isSlashPromptCoachmarkEligible,
  show: (progress) => maybeShowSlashPromptCoachmark({ progress }),
};

const showDebugSlashPromptCoachmark = () => void maybeShowSlashPromptCoachmark({ force: true });

// Debug from the page console:
// document.dispatchEvent(new Event('gv:debug:slashPromptCoachmark'))
try {
  (window as unknown as Record<string, unknown>).__gvSlashPromptCoachmark =
    showDebugSlashPromptCoachmark;
  document.addEventListener(SLASH_PROMPT_COACHMARK_DEBUG_EVENT, showDebugSlashPromptCoachmark);
} catch {
  /* ignore */
}
