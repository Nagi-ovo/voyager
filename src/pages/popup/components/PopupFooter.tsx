import type { ReactNode } from 'react';

import { getWebStoreRatingChannel } from '@/core/utils/browser';
import type { TranslationKey } from '@/utils/translations';

export function PopupFooter({
  extVersion,
  releaseUrl,
  language,
  t,
  children,
}: {
  extVersion: string | null;
  releaseUrl: string;
  language: string;
  t: (key: TranslationKey) => string;
  children: ReactNode;
}) {
  const webStoreRatingChannel = getWebStoreRatingChannel();
  const websiteUrl =
    language === 'zh' ? 'https://voyager.nagi.fun' : `https://voyager.nagi.fun/${language}`;

  // Bundled "Fable 5 Verified" badge (public/fable-verified-badge.png). Guarded
  // so non-extension contexts (e.g. tests) don't throw on chrome.runtime.getURL.
  const fableBadgeUrl = (() => {
    try {
      return chrome?.runtime?.getURL?.('fable-verified-badge.png') ?? null;
    } catch {
      return null;
    }
  })();

  return (
    <>
      {/* Footer */}
      <div className="border-border/50 flex flex-col gap-3 border-t px-5 py-4">
        {children}

        <div className="flex w-full items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="text-foreground/80 font-semibold">{t('extensionVersion')}</span>
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:text-primary/80 font-semibold transition-colors"
              title={extVersion ? extVersion : undefined}
            >
              {extVersion ?? '...'}
            </a>
            {fableBadgeUrl && (
              <a
                href="https://github.com/yetone/alma-releases/issues/56"
                target="_blank"
                rel="noreferrer"
                className="flex items-center opacity-75 transition-opacity hover:opacity-100"
                title={t('fableVerifiedBadgeAlt')}
                aria-label={t('fableVerifiedBadgeAlt')}
              >
                <img
                  src={fableBadgeUrl}
                  alt={t('fableVerifiedBadgeAlt')}
                  className="h-[40px] w-auto"
                />
              </a>
            )}
          </div>

          <a
            href={websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary flex items-center gap-1.5 text-xs font-semibold transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            {t('officialDocs')}
          </a>
        </div>

        {webStoreRatingChannel && (
          <a
            href={
              webStoreRatingChannel === 'edge'
                ? 'https://microsoftedge.microsoft.com/addons/detail/voyager/gibmkggjijalcjinbdhcpklodjkhhlne'
                : 'https://chromewebstore.google.com/detail/gemini-voyager/iifacdnjakkhjjiengaffnegbndgingi'
            }
            target="_blank"
            rel="noreferrer"
            className="group hover:border-primary/30 flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs shadow-sm transition-[border-color,box-shadow] hover:shadow-md"
          >
            <span className="text-base leading-none" aria-hidden="true">
              ⭐
            </span>
            <span className="flex-1 leading-snug text-slate-700">
              {webStoreRatingChannel === 'edge'
                ? t('changelog_rate_edge')
                : t('changelog_rate_chrome')}
            </span>
            <span className="text-primary font-semibold whitespace-nowrap transition-transform group-hover:translate-x-0.5">
              {`${webStoreRatingChannel === 'edge' ? t('changelog_rate_edge_cta') : t('changelog_rate_chrome_cta')} →`}
            </span>
          </a>
        )}

        <a
          href="https://github.com/Nagi-ovo/voyager"
          target="_blank"
          rel="noreferrer"
          className="bg-primary hover:bg-primary/90 text-primary-foreground hover:shadow-primary/25 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold tracking-wide transition-all hover:scale-[1.02] hover:shadow-lg active:scale-[0.97]"
          title={t('starProject')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span>{t('starProject')}</span>
        </a>
      </div>
    </>
  );
}
