import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { TRANSLATIONS, type TranslationKey } from '@/utils/translations';

import { PopupSection } from '../../components/PopupSection';
import { NATIVE_POPUP_SECTION_IDS } from '../../utils/nativeSiteCapabilities';
import { usePopupSections, type PopupSectionsOptions } from '../usePopupSections';

vi.mock('webextension-polyfill', () => ({
  default: { storage: { local: { get: vi.fn(), set: vi.fn() } } },
}));

type Sections = ReturnType<typeof usePopupSections>;
const translate = (key: TranslationKey) => TRANSLATIONS.en[key];

function Harness({
  capture,
  ...options
}: PopupSectionsOptions & { capture: (sections: Sections) => void }) {
  const sections = usePopupSections(options);
  useEffect(() => capture(sections), [capture, sections]);
  return NATIVE_POPUP_SECTION_IDS.map((id) => (
    <PopupSection
      key={id}
      {...sections.getSectionProps(id, { allowPluginSite: id === 'visualEffect' })}
    >
      <span data-section={id}>{id}</span>
    </PopupSection>
  ));
}

describe('usePopupSections', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let sections: Sections;
  const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => undefined);
  const capture = (value: Sections) => {
    sections = value;
  };

  async function render(options: Partial<PopupSectionsOptions> = {}) {
    await act(async () => {
      root?.render(
        <Harness
          nativePopupPlatform="gemini"
          isPluginSite={false}
          visualEffectsAvailable
          t={translate}
          writeSyncStorage={writeSyncStorage}
          {...options}
          capture={capture}
        />,
      );
    });
  }

  function section(id: string) {
    return container.querySelector(`[data-section="${id}"]`)?.parentElement;
  }

  async function search(query: string) {
    await act(async () => sections.updateSettingsSearchQuery(query));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
  });

  it('hydrates known slots without writing and keeps one stable bulk-read callback', async () => {
    await render();
    const hydrate = sections.hydrateFromStorage;
    await act(async () =>
      hydrate({
        [StorageKeys.GV_POPUP_SECTION_ORDER]: ['folder', 'retired', 17, 'cloudSync'],
      }),
    );

    expect(section('folder')?.style.order).toBe('0');
    expect(section('cloudSync')?.style.order).toBe('2');
    expect(section('contextSync')?.style.order).toBe('4');
    expect(section('plugins')).toBeUndefined();
    expect(writeSyncStorage).not.toHaveBeenCalled();

    await render({ nativePopupPlatform: 'aistudio' });
    expect(sections.hydrateFromStorage).toBe(hydrate);
    expect(section('contextSync')).toBeUndefined();
    expect(sections.getSectionProps('contextSync').order).toBe(4);
    expect(browser.storage.local.get).toHaveBeenCalledTimes(1);
  });

  it('moves between visible sections while preserving hidden platform and plugin slots', async () => {
    await render({ nativePopupPlatform: 'aistudio' });
    const initial = ['cloudSync', 'timeline', 'plugins', 'folder'];
    await act(async () =>
      sections.hydrateFromStorage({ [StorageKeys.GV_POPUP_SECTION_ORDER]: initial }),
    );
    const moveDown = section('cloudSync')?.querySelector<HTMLButtonElement>(
      `button[aria-label="${translate('moveSectionDown')}"]`,
    );
    expect(moveDown).toBeTruthy();
    await act(async () => moveDown?.click());

    expect(writeSyncStorage).toHaveBeenLastCalledWith({
      [StorageKeys.GV_POPUP_SECTION_ORDER]: [
        'folder',
        'timeline',
        'plugins',
        'cloudSync',
        ...NATIVE_POPUP_SECTION_IDS.filter((id) => !initial.includes(id)),
      ],
    });
    expect(section('cloudSync')?.style.order).toBe('6');
    expect(section('folder')?.style.order).toBe('0');
    expect(
      section('folder')?.querySelector<HTMLButtonElement>(
        `button[aria-label="${translate('moveSectionUp')}"]`,
      )?.disabled,
    ).toBe(true);
  });

  it('filters rows, expands matching section titles and restores reordering after clearing', async () => {
    await render();
    await search(translate('pinTimelinePreview'));
    expect(sections.hasSettingsSearch).toBe(true);
    expect(sections.hasVisibleSearchResults).toBe(true);
    expect(section('timeline')).toBeTruthy();
    expect(sections.shouldShowSetting('timeline', 'pinTimelinePreview')).toBe(true);
    expect(sections.shouldShowSetting('timeline', 'hideOuterContainer')).toBe(false);
    expect(container.querySelector('button')).toBeNull();

    await search(translate('timelineOptions'));
    expect(sections.shouldShowSetting('timeline', 'hideOuterContainer')).toBe(true);
    expect(sections.shouldShowSetting('timeline', 'showMessageTimestamps')).toBe(true);

    await search('zzzzzzunknownsettingzzzzzz');
    expect(sections.hasVisibleSearchResults).toBe(false);
    expect(container.querySelector('[data-section]')).toBeNull();

    await search('');
    expect(sections.hasSettingsSearch).toBe(false);
    expect(container.querySelector('button')).toBeTruthy();
    expect(browser.storage.local.set).toHaveBeenLastCalledWith({
      [StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]: '',
    });
    expect(writeSyncStorage).not.toHaveBeenCalled();
  });

  it('keeps unsupported AI Studio settings hidden even when a section title matches', async () => {
    await render({ nativePopupPlatform: 'aistudio' });
    await search(translate('folderOptions'));
    expect(section('folder')).toBeTruthy();
    expect(sections.shouldShowSetting('folder', 'enableFolderFeature')).toBe(true);
    expect(sections.shouldShowSetting('folder', 'enableForkFeature')).toBe(false);
    expect(section('timeline')).toBeUndefined();

    await search(translate('enableMermaidRendering'));
    expect(sections.shouldShowSetting('general', 'enableMermaidRendering')).toBe(false);
    expect(sections.hasVisibleSearchResults).toBe(false);
  });

  it('requires plugin-site allowance and visual availability without losing layout slots', async () => {
    await render({ isPluginSite: true });
    expect(section('cloudSync')).toBeUndefined();
    expect(sections.getSectionProps('cloudSync').order).toBe(0);
    expect(sections.getSectionProps('visualEffect').visible).toBe(false);
    expect(section('visualEffect')).toBeTruthy();
    expect(container.querySelectorAll('[data-section]')).toHaveLength(1);
    expect(container.querySelector('button')).toBeNull();

    await render({ isPluginSite: true, visualEffectsAvailable: false });
    expect(section('visualEffect')).toBeUndefined();
    expect(sections.getSectionProps('visualEffect', { allowPluginSite: true }).order).toBe(
      NATIVE_POPUP_SECTION_IDS.indexOf('visualEffect') * 2,
    );
  });

  it('restores an asynchronous local query and ignores a read completed after unmount', async () => {
    let resolveQuery!: (value: Record<string, unknown>) => void;
    vi.mocked(browser.storage.local.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    await render();
    expect(sections.settingsSearchQuery).toBe('');
    await act(async () =>
      resolveQuery({ [StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]: 'timeline' }),
    );
    expect(sections.settingsSearchQuery).toBe('timeline');

    await act(async () => root?.unmount());
    root = createRoot(container);
    let resolveLateQuery!: (value: Record<string, unknown>) => void;
    vi.mocked(browser.storage.local.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLateQuery = resolve;
      }),
    );
    await render();
    const lastMountedOutput = sections;
    await act(async () => root?.unmount());
    root = null;
    await act(async () =>
      resolveLateQuery({ [StorageKeys.GV_POPUP_SETTINGS_SEARCH_QUERY]: 'late query' }),
    );
    expect(sections).toBe(lastMountedOutput);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });
});
