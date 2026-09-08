import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { TranslationKey } from '@/utils/translations';

import { usePopupLayoutSettings } from '../../hooks/usePopupLayoutSettings';
import type { NativePopupSectionId } from '../../utils/nativeSiteCapabilities';
import { PopupLayoutSettings } from '../PopupLayoutSettings';

const translate = (key: TranslationKey) => key;
const writeSyncStorage = vi.fn(async (_payload: Record<string, unknown>) => {});

function Harness({
  isAIStudio = false,
  visibleSections,
  hiddenSetting,
}: {
  isAIStudio?: boolean;
  visibleSections?: NativePopupSectionId[];
  hiddenSetting?: string;
}) {
  const settings = usePopupLayoutSettings({ isAIStudio, writeSyncStorage });
  return (
    <PopupLayoutSettings
      settings={settings}
      t={translate}
      wrapSection={(id, content) =>
        !visibleSections || visibleSections.includes(id) ? (
          <section key={id} data-section={id}>
            {content}
          </section>
        ) : null
      }
      isSettingVisible={(_section, id) => id !== hiddenSetting}
    />
  );
}

describe('PopupLayoutSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(chrome.storage.sync.get).mockImplementation((...args: unknown[]) => {
      const callback = args[1];
      if (typeof callback === 'function') callback(args[0]);
      return Promise.resolve(args[0] as Record<string, unknown>);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: React.ComponentProps<typeof Harness> = {}) => {
    act(() => root.render(<Harness {...props} />));
  };
  const slider = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`)!;
  const toggle = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!;
  const drag = (input: HTMLInputElement, value: number) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('renders each layout section once with the same labels and units', () => {
    render();
    expect(
      Array.from(container.querySelectorAll('section')).map((section) => section.dataset.section),
    ).toEqual([
      'folderSpacing',
      'folderTreeIndent',
      'gemsSidebar',
      'chatWidth',
      'chatFontSize',
      'chatLineHeight',
      'editInputWidth',
      'sidebarWidth',
      'sidebarBehavior',
    ]);
    expect(slider('folderSpacing').getAttribute('aria-valuetext')).toBe('2px');
    expect(slider('chatWidth').getAttribute('aria-valuetext')).toBe('70%');
    expect(slider('sidebarWidth').getAttribute('aria-valuetext')).toBe('312px');
    expect(slider('chatParagraphSpacing').getAttribute('aria-valuetext')).toBe('12px');
    expect(toggle('chatWidth').checked).toBe(false);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it('commits a width on keyboard release rather than on every input event', () => {
    render();
    act(() => toggle('chatWidth').click());
    expect(toggle('chatWidth').checked).toBe(true);
    expect(chrome.storage.sync.set).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.CHAT_WIDTH_ENABLED]: true,
    });
    vi.mocked(chrome.storage.sync.set).mockClear();
    const input = slider('chatWidth');
    drag(input, 85);
    expect(input.getAttribute('aria-valuetext')).toBe('85%');
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    act(() =>
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })),
    );
    expect(chrome.storage.sync.set).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.CHAT_WIDTH]: 85,
    });
  });

  it('commits paragraph spacing separately from line height on pointer release', () => {
    render();
    act(() => toggle('chatLineHeight').click());
    vi.mocked(chrome.storage.sync.set).mockClear();
    const paragraph = slider('chatParagraphSpacing');
    drag(paragraph, 20);
    expect(paragraph.getAttribute('aria-valuetext')).toBe('20px');
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    act(() => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(chrome.storage.sync.set).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.CHAT_PARAGRAPH_SPACING]: 20,
    });
    expect(slider('chatLineHeight').value).toBe('160');
  });

  it('honors the parent section and setting filters while retaining sidebar choices', () => {
    render({ visibleSections: ['sidebarBehavior'], hiddenSetting: 'sidebarAutoHide' });
    expect(container.querySelectorAll('section')).toHaveLength(1);
    expect(
      container.querySelector('#sidebar-auto-hide')!.closest<HTMLElement>('[hidden]')?.hidden,
    ).toBe(true);
    const fullHide = container.querySelector<HTMLInputElement>('#sidebar-full-hide')!;
    act(() => fullHide.click());
    expect(fullHide.checked).toBe(true);
    expect(writeSyncStorage).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.GV_SIDEBAR_FULL_HIDE]: true,
    });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    render({ visibleSections: ['sidebarBehavior'] });
    expect(container.querySelector<HTMLInputElement>('#sidebar-full-hide')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#sidebar-auto-hide')!.checked).toBe(false);
  });

  it('uses the AI Studio sidebar label, bounds and default after the platform changes', () => {
    render();
    expect(slider('sidebarWidth').value).toBe('312');
    render({ isAIStudio: true });
    const sidebar = slider('AI Studio Sidebar');
    expect(sidebar.value).toBe('280');
    expect(sidebar.min).toBe('240');
    expect(sidebar.max).toBe('600');
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
