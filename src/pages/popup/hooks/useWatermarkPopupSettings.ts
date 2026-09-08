import { useCallback, useState } from 'react';

import { StorageKeys } from '@/core/types/common';
import { resolveWatermarkSettings } from '@/core/utils/watermarkSettings';

export const WATERMARK_SETTINGS_STORAGE_DEFAULTS = {
  [StorageKeys.WATERMARK_REMOVER_ENABLED]: null,
  [StorageKeys.WATERMARK_DOWNLOAD_ENABLED]: null,
  [StorageKeys.WATERMARK_PREVIEW_ENABLED]: null,
};

export function useWatermarkPopupSettings(
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>,
) {
  const [values, setValues] = useState({ download: true, preview: true });
  const hydrateFromStorage = useCallback((raw: Record<string, unknown>) => {
    setValues(resolveWatermarkSettings(raw));
  }, []);

  const onChange = useCallback(
    (kind: 'download' | 'preview', enabled: boolean) => {
      setValues((current) => ({ ...current, [kind]: enabled }));
      void writeSyncStorage({
        [kind === 'download'
          ? StorageKeys.WATERMARK_DOWNLOAD_ENABLED
          : StorageKeys.WATERMARK_PREVIEW_ENABLED]: enabled,
        // A touched split flag must no longer be overridden by the legacy toggle.
        [StorageKeys.WATERMARK_REMOVER_ENABLED]: null,
      });
    },
    [writeSyncStorage],
  );

  return { values, onChange, hydrateFromStorage };
}
