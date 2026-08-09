import { describe, expect, it } from 'vitest';

import {
  POPUP_SECTION_SEARCH_SETTING_ID,
  isNativePopupSectionAvailable,
  isNativePopupSettingAvailable,
} from './nativeSiteCapabilities';

describe('native popup site capabilities', () => {
  it('keeps the complete settings surface on Gemini', () => {
    expect(isNativePopupSectionAvailable('gemini', 'timeline')).toBe(true);
    expect(isNativePopupSettingAvailable('gemini', 'timeline', 'timelineStyle')).toBe(true);
  });

  it('hides unsupported Gemini-only sections on AI Studio', () => {
    for (const sectionId of [
      'contextSync',
      'timeline',
      'gemsSidebar',
      'chatWidth',
      'chatFontSize',
      'chatLineHeight',
      'editInputWidth',
      'sidebarBehavior',
      'keyboardShortcuts',
      'nanobanana',
    ] as const) {
      expect(isNativePopupSectionAvailable('aistudio', sectionId)).toBe(false);
    }
  });

  it('keeps supported AI Studio sections and all of their settings', () => {
    for (const sectionId of [
      'cloudSync',
      'folderSpacing',
      'sidebarWidth',
      'visualEffect',
      'formulaCopy',
      'promptManager',
    ] as const) {
      expect(isNativePopupSectionAvailable('aistudio', sectionId)).toBe(true);
      expect(isNativePopupSettingAvailable('aistudio', sectionId, 'any-setting')).toBe(true);
    }
  });

  it('keeps both formula-copy controls available on Gemini and AI Studio', () => {
    for (const platform of ['gemini', 'aistudio'] as const) {
      expect(isNativePopupSettingAvailable(platform, 'formulaCopy', 'formulaCopyEnabled')).toBe(
        true,
      );
      expect(isNativePopupSettingAvailable(platform, 'formulaCopy', 'formulaCopyFormat')).toBe(
        true,
      );
    }
  });

  it('filters mixed sections down to their supported AI Studio settings', () => {
    expect(isNativePopupSettingAvailable('aistudio', 'folder', 'enableFolderFeature')).toBe(true);
    expect(isNativePopupSettingAvailable('aistudio', 'folder', 'hideArchivedConversations')).toBe(
      true,
    );
    expect(isNativePopupSettingAvailable('aistudio', 'folder', 'enableAccountIsolation')).toBe(
      true,
    );
    expect(isNativePopupSettingAvailable('aistudio', 'folder', 'enableForkFeature')).toBe(false);
    expect(isNativePopupSettingAvailable('aistudio', 'inputCollapse', 'enterSend')).toBe(true);
    expect(isNativePopupSettingAvailable('aistudio', 'inputCollapse', 'inputVimMode')).toBe(false);
    expect(
      isNativePopupSettingAvailable('aistudio', 'general', 'remoteAnnouncementNotification'),
    ).toBe(true);
    expect(isNativePopupSettingAvailable('aistudio', 'general', 'enableMermaidRendering')).toBe(
      false,
    );
  });

  it('keeps searchable section headings only for available AI Studio sections', () => {
    expect(
      isNativePopupSettingAvailable('aistudio', 'folder', POPUP_SECTION_SEARCH_SETTING_ID),
    ).toBe(true);
    expect(
      isNativePopupSettingAvailable('aistudio', 'timeline', POPUP_SECTION_SEARCH_SETTING_ID),
    ).toBe(false);
  });
});
