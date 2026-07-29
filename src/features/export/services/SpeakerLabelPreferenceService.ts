import { storageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';

import {
  type ExportSpeakerLabelOverrides,
  type ExportSpeakerLabels,
  normalizeSpeakerLabelOverrides,
} from '../types/export';

export { normalizeSpeakerLabelOverrides, resolveExportSpeakerLabels } from '../types/export';

export async function getSavedSpeakerLabelOverrides(
  defaults: ExportSpeakerLabels,
): Promise<ExportSpeakerLabelOverrides> {
  try {
    const result = await storageService.get<unknown>(StorageKeys.EXPORT_SPEAKER_LABELS);
    if (!result.success) return {};
    return normalizeSpeakerLabelOverrides(result.data, defaults);
  } catch {
    return {};
  }
}

export async function saveSpeakerLabelOverrides(
  value: unknown,
  defaults: ExportSpeakerLabels,
): Promise<boolean> {
  const overrides = normalizeSpeakerLabelOverrides(value, defaults);

  try {
    if (!overrides.user && !overrides.assistant) {
      const result = await storageService.remove(StorageKeys.EXPORT_SPEAKER_LABELS);
      return result.success;
    }

    const result = await storageService.set(StorageKeys.EXPORT_SPEAKER_LABELS, overrides);
    return result.success;
  } catch {
    return false;
  }
}
