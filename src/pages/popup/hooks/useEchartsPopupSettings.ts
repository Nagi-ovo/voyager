import { useCallback, useRef, useState } from 'react';

import { StorageKeys } from '@/core/types/common';

export interface EchartsPopupSettings {
  enabled: boolean;
  hydrateFromStorage: (storedEnabled: unknown) => void;
  setEnabledFromUser: (enabled: boolean) => void;
}

type SyncStorageWriter = (payload: Record<string, unknown>) => Promise<void>;

export function useEchartsPopupSettings(writeSyncStorage: SyncStorageWriter): EchartsPopupSettings {
  const [enabled, setEnabled] = useState(true);
  const touchedRef = useRef(false);

  const hydrateFromStorage = useCallback((storedEnabled: unknown): void => {
    if (!touchedRef.current) setEnabled(storedEnabled !== false);
  }, []);

  const setEnabledFromUser = useCallback(
    (nextEnabled: boolean): void => {
      touchedRef.current = true;
      setEnabled(nextEnabled);
      void writeSyncStorage({ [StorageKeys.ECHARTS_ENABLED]: nextEnabled });
    },
    [writeSyncStorage],
  );

  return { enabled, hydrateFromStorage, setEnabledFromUser };
}
