import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import {
  FolderSettingsCard,
  type FolderSettingsCardProps,
  type FolderSettingsValues,
} from '../FolderSettingsCard';

const translate = (key: TranslationKey): string => key;

const values: FolderSettingsValues = {
  folderEnabled: true,
  floatingModeEnabled: false,
  floatingOpenOnStart: true,
  hideArchivedConversations: false,
  folderSearchEnabled: true,
  forkEnabled: false,
  folderProjectEnabled: false,
};

describe('FolderSettingsCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (overrides: Partial<FolderSettingsCardProps> = {}) => {
    const props: FolderSettingsCardProps = {
      values,
      onChange: vi.fn(),
      accountIsolation: { enabled: true, platformLabel: 'Gemini', onChange: vi.fn() },
      aiStructureCopy: { status: 'idle', onCopy: vi.fn() },
      isVisible: () => true,
      t: translate,
      ...overrides,
    };
    act(() => {
      root.render(<FolderSettingsCard {...props} />);
    });
    return props;
  };

  it('renders every toggle and routes account isolation to its own handler', () => {
    const props = render();
    const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(input('folder-enabled').checked).toBe(true);
    expect(input('folder-search-enabled').checked).toBe(true);
    expect(input('fork-enabled').checked).toBe(false);
    expect(input('account-isolation-enabled').checked).toBe(true);
    expect(container.textContent).toContain('Gemini');

    act(() => input('fork-enabled').click());
    expect(props.onChange).toHaveBeenLastCalledWith({ forkEnabled: true });

    act(() => input('account-isolation-enabled').click());
    expect(props.accountIsolation.onChange).toHaveBeenCalledWith(false);
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the open-on-start row only while floating mode is on', () => {
    render();
    expect(container.querySelector('#floating-open-on-start')).toBeNull();

    render({ values: { ...values, floatingModeEnabled: true } });
    const input = container.querySelector<HTMLInputElement>('#floating-open-on-start')!;
    expect(input.checked).toBe(true);

    render({
      values: { ...values, floatingModeEnabled: true },
      isVisible: (settingId) => settingId !== 'openFloatingFolderOnStartup',
    });
    expect(container.querySelector('#floating-open-on-start')).toBeNull();
  });

  it('reflects the AI structure copy status in the button', () => {
    const props = render();
    const button = () =>
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('aiOrg'),
      )!;
    expect(button().textContent).toContain('aiOrgCopyButton');
    expect(button().disabled).toBe(false);

    act(() => button().click());
    expect(props.aiStructureCopy.onCopy).toHaveBeenCalledOnce();

    render({ aiStructureCopy: { status: 'loading', onCopy: vi.fn() } });
    expect(button().disabled).toBe(true);

    render({ aiStructureCopy: { status: 'copied', onCopy: vi.fn() } });
    expect(button().textContent).toContain('check');
    expect(button().textContent).toContain('aiOrgCopied');

    render({ aiStructureCopy: { status: 'empty', onCopy: vi.fn() } });
    expect(button().textContent).toContain('aiOrgNoConversations');
  });

  it('hides rows by search id', () => {
    render({ isVisible: (settingId) => settingId !== 'hideArchivedConversations' });
    expect(
      container.querySelector<HTMLElement>('#hide-archived')!.closest<HTMLElement>('div.group')!
        .hidden,
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement>('#folder-enabled')!.closest<HTMLElement>('div.group')!
        .hidden,
    ).toBe(false);
  });
});
