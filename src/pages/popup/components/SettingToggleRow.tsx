import React from 'react';

import type { TranslationKey } from '@/utils/translations';

import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';
import { ExperimentalBadge } from './ExperimentalBadge';

export interface SettingToggleRowProps {
  /** Input id; the label points at it. */
  id: string;
  /** Settings-search id handed to `isVisible`. */
  settingId: string;
  label: TranslationKey;
  hint?: TranslationKey;
  /** Wider text/switch gap and overflow clamp, as the floating-mode row has always had. */
  gapped?: boolean;
  experimental?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  isVisible: (settingId: string) => boolean;
  t: (key: TranslationKey) => string;
}

/** One labelled switch row of a popup settings card, hidden by site capability or search. */
export function SettingToggleRow({
  id,
  settingId,
  label,
  hint,
  gapped,
  experimental,
  checked,
  onChange,
  isVisible,
  t,
}: SettingToggleRowProps) {
  const labelNode = (
    <Label
      htmlFor={id}
      className={`group-hover:text-primary cursor-pointer text-sm font-medium transition-colors${
        experimental ? ' flex items-center gap-1' : ''
      }`}
    >
      {t(label)}
      {experimental && <ExperimentalBadge title={t('experimentalLabel')} />}
    </Label>
  );
  return (
    <div
      hidden={!isVisible(settingId)}
      className={`group flex items-center justify-between${gapped ? ' gap-3' : ''}`}
    >
      {hint ? (
        <div className={gapped ? 'min-w-0 flex-1' : 'flex-1'}>
          {labelNode}
          <p className="text-muted-foreground mt-1 text-xs">{t(hint)}</p>
        </div>
      ) : (
        labelNode
      )}
      <Switch id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </div>
  );
}
