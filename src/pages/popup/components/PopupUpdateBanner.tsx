import { Card } from '@/components/ui/card';
import type { TranslationKey } from '@/utils/translations';

import type { usePopupReleaseInfo } from '../hooks/usePopupReleaseInfo';

export function PopupUpdateBanner({
  release,
  isSafariBrowser,
  t,
}: {
  release: ReturnType<typeof usePopupReleaseInfo>;
  isSafariBrowser: boolean;
  t: (key: TranslationKey) => string;
}) {
  const {
    hasUpdate,
    normalizedLatestVersion,
    normalizedCurrentVersion,
    safariDmgUrl,
    latestReleaseUrl,
  } = release;
  return (
    hasUpdate &&
    normalizedLatestVersion &&
    normalizedCurrentVersion && (
      <Card
        style={{ order: -2 }}
        className="border-amber-200 bg-amber-50 p-3 text-amber-900 shadow-sm"
      >
        <div className="flex items-start gap-3">
          <div className="mt-1 text-amber-600">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l4 4h-3v7h-2V6H8l4-4zm6 11v6H6v-6H4v8h16v-8h-2z" />
            </svg>
          </div>
          <div className="flex-1 space-y-1">
            <p className="text-sm leading-tight font-semibold">{t('newVersionAvailable')}</p>
            <p className="text-xs leading-tight">
              {t('currentVersionLabel')}: v{normalizedCurrentVersion} · {t('latestVersionLabel')}: v
              {normalizedLatestVersion}
            </p>
          </div>
          {isSafariBrowser ? (
            safariDmgUrl ? (
              <a
                href={safariDmgUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200"
              >
                {t('updateNow')}
              </a>
            ) : (
              <span className="shrink-0 text-xs leading-tight text-amber-700">
                {t('safariUpdateNotSynced')}
              </span>
            )
          ) : (
            <a
              href={latestReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-md bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200"
            >
              {t('updateNow')}
            </a>
          )}
        </div>
      </Card>
    )
  );
}
