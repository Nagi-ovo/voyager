import type { ComponentProps } from 'react';

import { DarkModeToggle } from '@/components/DarkModeToggle';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import type { TranslationKey } from '@/utils/translations';

import { ThemeColorButton } from './ThemeColorButton';

export function PopupHeader({
  themePicker,
  t,
}: {
  themePicker: ComponentProps<typeof ThemeColorButton>;
  t: (key: TranslationKey) => string;
}) {
  return (
    <div className="border-border/50 flex items-center justify-between border-b px-5 py-5">
      <h1 className="text-primary text-2xl font-extrabold tracking-tight">{t('extName')}</h1>
      <div className="flex items-center gap-1">
        <DarkModeToggle />
        <ThemeColorButton {...themePicker} />
        <LanguageSwitcher />
      </div>
    </div>
  );
}
