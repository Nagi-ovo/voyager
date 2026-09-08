import { useCallback, useEffect, useMemo, useState } from 'react';

import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import type { PopupSectionProps } from '../components/PopupSection';
import {
  NATIVE_POPUP_SECTION_IDS,
  type NativePopupPlatform,
  type NativePopupSectionId,
  POPUP_SECTION_SEARCH_SETTING_ID,
  isNativePopupSectionAvailable,
  isNativePopupSettingAvailable,
} from '../utils/nativeSiteCapabilities';
import {
  POPUP_SETTINGS_SEARCH_ITEMS,
  type PopupSettingsSearchTargetId,
} from '../utils/popupSettingsSearchIndex';
import {
  getSettingsSearchMatches,
  normalizePersistedSettingsSearchQuery,
} from '../utils/settingsSearch';

export type PopupSectionId = NativePopupSectionId;

export const SECTION_LAYOUT_STORAGE_DEFAULTS = { [StorageKeys.GV_POPUP_SECTION_ORDER]: null };

const DEFAULT_SECTION_ORDER: readonly PopupSectionId[] = NATIVE_POPUP_SECTION_IDS;
const VALUE_BADGE_SECTION_IDS = new Set<PopupSectionId>([
  'folderSpacing',
  'folderTreeIndent',
  'gemsSidebar',
  'chatWidth',
  'chatFontSize',
  'chatLineHeight',
  'editInputWidth',
  'sidebarWidth',
]);

export interface PopupSectionsOptions {
  nativePopupPlatform: NativePopupPlatform;
  isPluginSite: boolean;
  visualEffectsAvailable: boolean;
  t: (key: TranslationKey) => string;
  writeSyncStorage: (payload: Record<string, unknown>) => Promise<void>;
}

export interface PopupSectionOptions {
  allowPluginSite?: boolean;
}

/** Persisted section order, settings search and the active platform's visibility rules. */
export function usePopupSections({
  nativePopupPlatform,
  isPluginSite,
  visualEffectsAvailable,
  t,
  writeSyncStorage,
}: PopupSectionsOptions) {
  const [sectionOrder, setSectionOrder] = useState<PopupSectionId[]>([...DEFAULT_SECTION_ORDER]);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void browser.storage.local
      .get({ [StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]: '' })
      .then((result) => {
        if (!cancelled) {
          setSettingsSearchQuery(
            normalizePersistedSettingsSearchQuery(
              result[StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY],
            ),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettingsSearchQuery = useCallback((query: string) => {
    setSettingsSearchQuery(query);
    void browser.storage.local
      .set({ [StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]: query })
      .catch(() => undefined);
  }, []);

  // The popup supplies this from its existing single bulk settings read.
  const hydrateFromStorage = useCallback((stored: Record<string, unknown>) => {
    const storedOrder = stored[StorageKeys.GV_POPUP_SECTION_ORDER];
    if (!Array.isArray(storedOrder)) return;
    const validIds = new Set<string>(NATIVE_POPUP_SECTION_IDS);
    const filtered = storedOrder.filter(
      (id: unknown): id is PopupSectionId => typeof id === 'string' && validIds.has(id),
    );
    const seen = new Set(filtered);
    const missing = NATIVE_POPUP_SECTION_IDS.filter((id) => !seen.has(id));
    setSectionOrder([...filtered, ...missing]);
  }, []);

  const isSectionVisible = useCallback(
    (id: PopupSectionId): boolean => {
      // Plugins are pinned separately; visual effects also require an activated site.
      if (id === 'plugins' || (id === 'visualEffect' && !visualEffectsAvailable)) return false;
      return isNativePopupSectionAvailable(nativePopupPlatform, id);
    },
    [nativePopupPlatform, visualEffectsAvailable],
  );
  const visibleSections = useMemo(
    () => sectionOrder.filter(isSectionVisible),
    [sectionOrder, isSectionVisible],
  );
  const hasSettingsSearch = settingsSearchQuery.trim().length > 0;
  const settingsSearchMatches = useMemo(
    () =>
      getSettingsSearchMatches(
        POPUP_SETTINGS_SEARCH_ITEMS.filter((item) =>
          isNativePopupSettingAvailable(nativePopupPlatform, item.sectionId, item.settingId),
        ),
        settingsSearchQuery,
      ),
    [nativePopupPlatform, settingsSearchQuery],
  );
  const settingsSearchSections = useMemo(() => {
    if (!hasSettingsSearch) return new Set<PopupSectionId>(visibleSections);
    const sections = new Set<PopupSectionId>();
    for (const item of POPUP_SETTINGS_SEARCH_ITEMS) {
      if (settingsSearchMatches.has(item.id)) sections.add(item.sectionId);
    }
    return sections;
  }, [hasSettingsSearch, settingsSearchMatches, visibleSections]);
  const displayedSections = hasSettingsSearch
    ? visibleSections.filter((id) => settingsSearchSections.has(id))
    : visibleSections;

  const shouldShowSetting = useCallback(
    (sectionId: PopupSectionId, settingId: string): boolean => {
      if (!isNativePopupSettingAvailable(nativePopupPlatform, sectionId, settingId)) return false;
      const sectionTarget: PopupSettingsSearchTargetId = `${sectionId}:${POPUP_SECTION_SEARCH_SETTING_ID}`;
      const settingTarget: PopupSettingsSearchTargetId = `${sectionId}:${settingId}`;
      return (
        !hasSettingsSearch ||
        settingsSearchMatches.has(sectionTarget) ||
        settingsSearchMatches.has(settingTarget)
      );
    },
    [nativePopupPlatform, hasSettingsSearch, settingsSearchMatches],
  );

  const moveSectionInOrder = useCallback(
    (sectionId: PopupSectionId, direction: 'up' | 'down') => {
      setSectionOrder((prev) => {
        const idx = prev.indexOf(sectionId);
        if (idx === -1) return prev;
        const step = direction === 'up' ? -1 : 1;
        let swapIdx = idx + step;
        while (swapIdx >= 0 && swapIdx < prev.length && !isSectionVisible(prev[swapIdx])) {
          swapIdx += step;
        }
        if (swapIdx < 0 || swapIdx >= prev.length) return prev;
        const next = [...prev];
        [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
        void writeSyncStorage({ [StorageKeys.GV_POPUP_SECTION_ORDER]: next });
        return next;
      });
    },
    [isSectionVisible, writeSyncStorage],
  );

  const getSectionProps = (
    id: PopupSectionId,
    options: PopupSectionOptions = {},
  ): Omit<PopupSectionProps, 'children'> => ({
    visible:
      (!isPluginSite || options.allowPluginSite === true) &&
      isSectionVisible(id) &&
      (!hasSettingsSearch || settingsSearchSections.has(id)),
    // Keep the stored slot even while hidden; the quota card is placed after cloud sync.
    order: sectionOrder.indexOf(id) * 2,
    reorder:
      !isPluginSite && !hasSettingsSearch
        ? {
            isFirst: displayedSections[0] === id,
            isLast: displayedSections[displayedSections.length - 1] === id,
            hasValueBadge: VALUE_BADGE_SECTION_IDS.has(id),
            onMoveUp: () => moveSectionInOrder(id, 'up'),
            onMoveDown: () => moveSectionInOrder(id, 'down'),
            moveUpLabel: t('moveSectionUp'),
            moveDownLabel: t('moveSectionDown'),
          }
        : undefined,
  });

  return {
    settingsSearchQuery,
    updateSettingsSearchQuery,
    hasSettingsSearch,
    hasVisibleSearchResults: displayedSections.length > 0,
    shouldShowSetting,
    hydrateFromStorage,
    getSectionProps,
  };
}
