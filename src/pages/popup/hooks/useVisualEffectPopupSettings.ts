import { useCallback, useState } from 'react';

import type { VisualEffect } from '../components/VisualEffectPicker';

export const VISUAL_EFFECT_STORAGE_DEFAULTS = { gvVisualEffect: 'off', gvSnowEffect: false };

export function useVisualEffectPopupSettings(
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>,
) {
  const [value, setValue] = useState<VisualEffect>('off');
  const hydrateFromStorage = useCallback((raw: Record<string, unknown>) => {
    const stored = raw.gvVisualEffect;
    if (stored === 'snow' || stored === 'sakura' || stored === 'rain') setValue(stored);
    else setValue(raw.gvSnowEffect === true ? 'snow' : 'off');
  }, []);

  const onChange = useCallback(
    (next: VisualEffect) => {
      setValue(next);
      void writeSyncStorage({ gvVisualEffect: next, gvSnowEffect: false });
    },
    [writeSyncStorage],
  );

  return { value, onChange, hydrateFromStorage };
}
