import React from 'react';

import type { TranslationKey } from '@/utils/translations';

import { Card, CardContent } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';

export type VisualEffect = 'off' | 'snow' | 'sakura' | 'rain';

export interface VisualEffectPickerProps {
  value: VisualEffect;
  onChange: (value: VisualEffect) => void;
  t: (key: TranslationKey) => string;
}

const STROKE = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
} as const;

const OPTIONS: readonly { value: VisualEffect; label: TranslationKey; icon: React.ReactNode }[] = [
  {
    value: 'off',
    label: 'visualEffectOff',
    icon: (
      <svg {...STROKE} strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    ),
  },
  {
    value: 'snow',
    label: 'visualEffectSnow',
    icon: (
      <svg {...STROKE} strokeLinejoin="round">
        <line x1="12" y1="2" x2="12" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        <line x1="19.07" y1="4.93" x2="4.93" y2="19.07" />
        <line x1="12" y1="2" x2="14.5" y2="4.5" />
        <line x1="12" y1="2" x2="9.5" y2="4.5" />
        <line x1="12" y1="22" x2="14.5" y2="19.5" />
        <line x1="12" y1="22" x2="9.5" y2="19.5" />
        <line x1="2" y1="12" x2="4.5" y2="9.5" />
        <line x1="2" y1="12" x2="4.5" y2="14.5" />
        <line x1="22" y1="12" x2="19.5" y2="9.5" />
        <line x1="22" y1="12" x2="19.5" y2="14.5" />
      </svg>
    ),
  },
  {
    value: 'sakura',
    label: 'visualEffectSakura',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <g transform="translate(12,12)">
          {[0, 72, 144, 216, 288].map((deg) => (
            <ellipse
              key={deg}
              cx="0"
              cy="-6"
              rx="2.8"
              ry="5.5"
              transform={`rotate(${deg})`}
              opacity="0.85"
            />
          ))}
          <circle cx="0" cy="0" r="2" opacity="0.6" />
        </g>
      </svg>
    ),
  },
  {
    value: 'rain',
    label: 'visualEffectRain',
    icon: (
      <svg {...STROKE}>
        <line x1="8" y1="3" x2="6.5" y2="10" />
        <line x1="14" y1="2" x2="12.5" y2="9" />
        <line x1="20" y1="4" x2="18.5" y2="11" />
        <line x1="5" y1="12" x2="3.5" y2="19" />
        <line x1="11" y1="11" x2="9.5" y2="18" />
        <line x1="17" y1="13" x2="15.5" y2="20" />
      </svg>
    ),
  },
];

/** Segmented picker for the platform-neutral fullscreen effect (snow, sakura, rain). */
export function VisualEffectPicker({ value, onChange, t }: VisualEffectPickerProps) {
  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardContent className="p-0">
        <div className="flex-1">
          <Label className="text-sm font-medium">{t('visualEffect')}</Label>
          <p className="text-muted-foreground mt-1 text-xs">{t('visualEffectHint')}</p>
        </div>
        <div className="bg-secondary/60 mt-3 flex items-center gap-0.5 rounded-full p-1">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-bold transition-all duration-200 ${
                value === option.value
                  ? 'bg-background text-foreground shadow-md'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.icon}
              <span>{t(option.label)}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
