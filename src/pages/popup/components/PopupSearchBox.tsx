import React from 'react';

import { Search, X } from 'lucide-react';

import type { TranslationKey } from '@/utils/translations';

export interface PopupSearchBoxProps {
  query: string;
  onChange: (query: string) => void;
  t: (key: TranslationKey) => string;
}

export function PopupSearchBox({ query, onChange, t }: PopupSearchBoxProps) {
  return (
    <div style={{ order: -3 }} className="relative">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="search"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('popupSettingsSearchPlaceholder')}
        aria-label={t('popupSettingsSearchPlaceholder')}
        className="bg-card border-border focus:ring-primary/40 w-full rounded-lg border py-2 pr-9 pl-9 text-sm shadow-sm transition-all outline-none focus:ring-2 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md transition-colors"
          aria-label={t('popupSettingsSearchClear')}
          title={t('popupSettingsSearchClear')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
