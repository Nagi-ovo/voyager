import { CleanupPositions } from '@/core/types/cleanupPositions';
import { StorageKeys } from '@/core/types/common';

import { startAccountContextBridge } from './accountContext';
import { startInputVimMode } from './chatInput/vimMode';
import { startCodeBlockCollapse } from './codeBlockCollapse';
import { startDraftSave } from './draftSave/index';
import { startEdgeFinalVersionNotice } from './edgeFinalVersionNotice';
import type { NativeFeature } from './featureLifecycle';
import { isForkFeatureEnabledValue } from './fork/featureFlag';
import { startFork } from './fork/index';
import { startGemsHider } from './gemsHider/index';
import { startGemsSidebar } from './gemsSidebar/index';
import { startBrandTheme } from './platformTheme';
import { startPromptHistory } from './promptHistory/index';
import { startRemoteAnnouncements } from './remoteAnnouncements/index';
import { startResponseCompleteNotification } from './responseNotification/index';
import { startSendBehavior } from './sendBehavior/index';
import { startStorageQuotaWarningToast } from './storageQuotaWarning';
import { startUsageStatus } from './usageStatus/index';

/**
 * Native content modules that follow the lifecycle contract in
 * `featureLifecycle.ts`. `index.tsx` starts them from here (so a module cannot
 * be started without being registered) and the parametric lifecycle test
 * walks `NATIVE_FEATURE_LIST`.
 *
 * Start order, host gating and idle yields stay in `index.tsx`; this table
 * only says what a feature is, not when it runs. Keep entries to data — a
 * start that needs logic belongs in the module.
 */
export const NATIVE_FEATURES = {
  accountContextBridge: {
    id: 'account-context-bridge',
    position: CleanupPositions.CleanupAccountContextBridge,
    start: startAccountContextBridge,
  },
  brandTheme: {
    id: 'brand-theme',
    position: CleanupPositions.CleanupBrandTheme,
    start: () => startBrandTheme(),
    inertReason: 'Only Claude / ChatGPT adapters declare a brand colour; Gemini is left untouched.',
  },
  edgeFinalVersionNotice: {
    id: 'edge-final-version-notice',
    position: CleanupPositions.CleanupEdgeFinalVersionNotice,
    start: () => startEdgeFinalVersionNotice(),
    inertReason: 'Only the Edge release channel schedules the notice.',
  },
  remoteAnnouncements: {
    id: 'remote-announcements',
    position: CleanupPositions.CleanupRemoteAnnouncements,
    start: startRemoteAnnouncements,
  },
  storageQuotaWarning: {
    id: 'storage-quota-warning',
    position: CleanupPositions.CleanupStorageQuotaWarning,
    start: startStorageQuotaWarningToast,
  },
  inputVimMode: {
    id: 'input-vim-mode',
    position: CleanupPositions.CleanupInputVimMode,
    start: () => startInputVimMode(),
  },
  sendBehaviorGemini: {
    id: 'send-behavior:gemini',
    position: CleanupPositions.CleanupSendBehavior,
    start: () => startSendBehavior('gemini'),
  },
  sendBehaviorAiStudio: {
    id: 'send-behavior:aistudio',
    position: CleanupPositions.CleanupSendBehavior,
    start: () => startSendBehavior('aistudio'),
  },
  responseCompleteNotification: {
    id: 'response-complete-notification',
    position: CleanupPositions.CleanupResponseCompleteNotification,
    start: startResponseCompleteNotification,
  },
  draftSave: {
    id: 'draft-save',
    position: CleanupPositions.CleanupDraftSave,
    start: startDraftSave,
  },
  gemsSidebar: {
    id: 'gems-sidebar',
    position: CleanupPositions.CleanupGemsSidebar,
    start: startGemsSidebar,
  },
  usageStatus: {
    id: 'usage-status',
    position: CleanupPositions.CleanupUsageStatus,
    start: startUsageStatus,
  },
  promptHistory: {
    id: 'prompt-history',
    position: CleanupPositions.CleanupPromptHistory,
    start: startPromptHistory,
  },
  codeBlockCollapse: {
    id: 'code-block-collapse',
    position: CleanupPositions.CleanupCodeBlockCollapse,
    start: startCodeBlockCollapse,
  },
  gemsHider: {
    id: 'gems-hider',
    position: CleanupPositions.CleanupGemsHider,
    start: startGemsHider,
  },
  fork: {
    id: 'fork',
    position: CleanupPositions.CleanupFork,
    start: startFork,
    toggle: { key: StorageKeys.FORK_ENABLED, isEnabled: isForkFeatureEnabledValue },
  },
} as const satisfies Record<string, NativeFeature>;

export const NATIVE_FEATURE_LIST: readonly NativeFeature[] = Object.values(NATIVE_FEATURES);
