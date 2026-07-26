import browser from 'webextension-polyfill';

import { logger } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';

import {
  type SlashPromptController,
  createSlashPromptLifecycle,
  isGeminiSlashPromptSurface,
  startStoredPromptSlashCommand,
} from './slashPrompt';

const slashPromptFeatureLogger = logger.createChild('SlashPromptFeature');

export interface SlashPromptFeatureOptions {
  pageUrl?: string;
  start?: () => Promise<SlashPromptController>;
}

/**
 * Owns slash completion independently from the Prompt Manager UI.
 *
 * Unsupported surfaces return an inert controller without touching storage.
 */
export async function startSlashPromptFeature(
  options: SlashPromptFeatureOptions = {},
): Promise<SlashPromptController> {
  if (!isGeminiSlashPromptSurface(options.pageUrl)) {
    return { destroy: () => {} };
  }

  const lifecycle = createSlashPromptLifecycle(options.start ?? startStoredPromptSlashCommand);
  let destroyed = false;
  let receivedRuntimeSetting = false;
  let latestReconciliation = Promise.resolve();

  const reconcile = (enabled: boolean): Promise<void> => {
    const reconciliation = lifecycle.setEnabled(enabled).catch((error: unknown) => {
      slashPromptFeatureLogger.warn('Failed to update slash prompt completion state', {
        enabled,
        error,
      });
    });
    latestReconciliation = reconciliation;
    return reconciliation;
  };

  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (destroyed || areaName !== 'sync') return;
    const settingChange = changes[StorageKeys.SLASH_PROMPT_ENABLED];
    if (!settingChange) return;

    receivedRuntimeSetting = true;
    void reconcile(settingChange.newValue !== false);
  };

  browser.storage.onChanged.addListener(onStorageChanged);

  let initiallyEnabled = true;
  try {
    const stored = await browser.storage.sync.get({
      [StorageKeys.SLASH_PROMPT_ENABLED]: true,
    });
    initiallyEnabled = stored[StorageKeys.SLASH_PROMPT_ENABLED] !== false;
  } catch (error) {
    slashPromptFeatureLogger.warn(
      'Failed to read slash prompt setting, continuing with the enabled default',
      { error },
    );
  }

  if (!receivedRuntimeSetting) {
    await reconcile(initiallyEnabled);
  } else {
    // A live change that arrived during the initial read is authoritative.
    await latestReconciliation;
  }

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
      lifecycle.destroy();
    },
  };
}
