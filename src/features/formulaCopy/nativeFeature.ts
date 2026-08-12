import browser from 'webextension-polyfill';

import { logger } from '@/core';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { getFormulaCopyService } from './FormulaCopyService';

const nativeFormulaCopyLogger = logger.createChild('NativeFormulaCopy');

export interface FormulaCopyLifecycleService {
  prepare?(): Promise<void>;
  initialize(): void;
  destroy(): void;
  dispose?(): void;
  isServiceInitialized(): boolean;
}

export interface NativeFormulaCopyController {
  destroy(): void;
}

export interface StartNativeFormulaCopyOptions {
  service?: FormulaCopyLifecycleService;
}

/**
 * Owns the native Gemini / AI Studio formula-copy lifecycle.
 *
 * Claude and ChatGPT intentionally do not use this controller: their existing
 * default-disabled builtin plugin remains the single enable switch on those
 * platforms.
 */
export async function startNativeFormulaCopy(
  options: StartNativeFormulaCopyOptions = {},
): Promise<NativeFormulaCopyController> {
  const service = options.service ?? getFormulaCopyService();
  let destroyed = false;
  let receivedRuntimeSetting = false;
  let prepared = false;
  let desiredEnabled = true;
  let settingListenerAttached = false;

  const disposeService = (): void => {
    try {
      if (service.dispose) service.dispose();
      else if (service.isServiceInitialized()) service.destroy();
    } catch (error) {
      nativeFormulaCopyLogger.warn('Failed to dispose formula copy service', { error });
    }
  };

  const removeSettingListener = (): void => {
    if (!settingListenerAttached) return;
    settingListenerAttached = false;
    try {
      browser.storage.onChanged.removeListener(onStorageChanged);
    } catch (error) {
      nativeFormulaCopyLogger.warn('Failed to remove formula copy setting listener', { error });
    }
  };

  const reconcile = (enabled: boolean): void => {
    desiredEnabled = enabled;
    if (!prepared) return;
    if (destroyed) return;

    if (enabled) {
      if (!service.isServiceInitialized()) service.initialize();
      return;
    }

    if (service.isServiceInitialized()) service.destroy();
  };

  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (destroyed || areaName !== 'sync') return;
    const settingChange = changes[StorageKeys.FORMULA_COPY_ENABLED];
    if (!settingChange) return;

    receivedRuntimeSetting = true;
    reconcile(settingChange.newValue !== false);
  };

  try {
    // Subscribe before the initial read so a live change cannot be overwritten
    // by a stale storage snapshot that resolves later.
    browser.storage.onChanged.addListener(onStorageChanged);
    settingListenerAttached = true;

    // Load the copy format before enabling click handling. Preference sync
    // stays alive across runtime off/on transitions, so re-enabling is
    // immediately consistent with changes made while the feature was off.
    await service.prepare?.();

    let initiallyEnabled = true;
    try {
      const stored = await browser.storage.sync.get({
        [StorageKeys.FORMULA_COPY_ENABLED]: true,
      });
      initiallyEnabled = stored[StorageKeys.FORMULA_COPY_ENABLED] !== false;
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) throw error;
      nativeFormulaCopyLogger.warn(
        'Failed to read formula copy setting, continuing with the enabled default',
        { error },
      );
    }

    prepared = true;
    reconcile(receivedRuntimeSetting ? desiredEnabled : initiallyEnabled);
  } catch (error) {
    destroyed = true;
    removeSettingListener();
    disposeService();
    throw error;
  }

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      removeSettingListener();
      disposeService();
    },
  };
}
