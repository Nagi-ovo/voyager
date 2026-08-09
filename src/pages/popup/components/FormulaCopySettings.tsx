import React from 'react';

import type { FormulaCopyFormat } from '@/features/formulaCopy/FormulaCopyService';
import type { TranslationKey } from '@/utils/translations';

import { Card, CardContent, CardTitle } from '../../../components/ui/card';
import { Label } from '../../../components/ui/label';
import { Switch } from '../../../components/ui/switch';

export interface FormulaCopySettingsProps {
  enabled: boolean;
  format: FormulaCopyFormat;
  onEnabledChange: (enabled: boolean) => void;
  onFormatChange: (format: FormulaCopyFormat) => void;
  showEnabled?: boolean;
  showFormat?: boolean;
  t: (key: TranslationKey) => string;
}

const FORMAT_OPTIONS: readonly { value: FormulaCopyFormat; label: TranslationKey }[] = [
  { value: 'latex', label: 'formulaCopyFormatLatex' },
  { value: 'unicodemath', label: 'formulaCopyFormatUnicodeMath' },
  { value: 'no-dollar', label: 'formulaCopyFormatNoDollar' },
  { value: 'notion', label: 'formulaCopyFormatNotion' },
];

export function FormulaCopySettings({
  enabled,
  format,
  onEnabledChange,
  onFormatChange,
  showEnabled = true,
  showFormat = true,
  t,
}: FormulaCopySettingsProps) {
  const formatsDisabled = !enabled;

  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('formulaCopyFormat')}</CardTitle>
      <CardContent className="space-y-4 p-0">
        {showEnabled && (
          <div className="group flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Label
                htmlFor="formula-copy-enabled"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('enableFormulaCopy')}
              </Label>
              <p id="formula-copy-enabled-hint" className="text-muted-foreground mt-1 text-xs">
                {t('enableFormulaCopyHint')}
              </p>
            </div>
            <Switch
              id="formula-copy-enabled"
              aria-describedby="formula-copy-enabled-hint"
              checked={enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
          </div>
        )}

        {showFormat && (
          <div className="border-border/60 border-t pt-3">
            <p className="text-muted-foreground mb-3 text-xs">{t('formulaCopyFormatHint')}</p>
            <div className="space-y-2">
              {FORMAT_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-center space-x-3">
                  <input
                    type="radio"
                    name="formulaCopyFormat"
                    value={option.value}
                    checked={format === option.value}
                    onChange={() => onFormatChange(option.value)}
                    disabled={formatsDisabled}
                    aria-label={t(option.label)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">{t(option.label)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
