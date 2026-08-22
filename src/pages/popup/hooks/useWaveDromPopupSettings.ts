import { useCallback, useRef, useState } from 'react';

import { StorageKeys } from '@/core/types/common';

export interface WaveDromPopupSettings {
  enabled: boolean;
  hydrateFromStorage: (storedEnabled: unknown) => void;
  setEnabledFromUser: (enabled: boolean) => void;
}

type SyncStorageWriter = (payload: Record<string, unknown>) => Promise<void>;

export function useWaveDromPopupSettings(
  writeSyncStorage: SyncStorageWriter,
): WaveDromPopupSettings {
  const [enabled, setEnabled] = useState(true);
  const touchedRef = useRef(false);

  const hydrateFromStorage = useCallback((storedEnabled: unknown): void => {
    if (!touchedRef.current) setEnabled(storedEnabled !== false);
  }, []);

  const setEnabledFromUser = useCallback(
    (nextEnabled: boolean): void => {
      touchedRef.current = true;
      setEnabled(nextEnabled);
      void writeSyncStorage({ [StorageKeys.WAVEDROM_ENABLED]: nextEnabled });
    },
    [writeSyncStorage],
  );

  return { enabled, hydrateFromStorage, setEnabledFromUser };
}
