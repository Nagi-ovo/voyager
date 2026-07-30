import { storageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';

import { type ExportSpeakerLabelOverrides, normalizeSpeakerLabelOverrides } from '../types/export';

export { normalizeSpeakerLabelOverrides, resolveExportSpeakerLabels } from '../types/export';

export async function getSavedSpeakerLabelOverrides(): Promise<ExportSpeakerLabelOverrides> {
  try {
    const result = await storageService.get<unknown>(StorageKeys.EXPORT_SPEAKER_LABELS);
    if (!result.success) return {};
    return normalizeSpeakerLabelOverrides(result.data);
  } catch {
    return {};
  }
}

export async function saveSpeakerLabelOverrides(value: unknown): Promise<boolean> {
  const overrides = normalizeSpeakerLabelOverrides(value);

  try {
    if (Object.keys(overrides).length === 0) {
      const result = await storageService.remove(StorageKeys.EXPORT_SPEAKER_LABELS);
      return result.success;
    }

    const result = await storageService.set(StorageKeys.EXPORT_SPEAKER_LABELS, overrides);
    return result.success;
  } catch {
    return false;
  }
}
