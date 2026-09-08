import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import {
  GeneralSettingsCard,
  type GeneralSettingsCardProps,
  type GeneralSettingsValues,
} from '../GeneralSettingsCard';

const translate = (key: TranslationKey): string => key;

const values: GeneralSettingsValues = {
  persistentExportToolbarEnabled: false,
  mermaidEnabled: true,
  wavedromEnabled: false,
  echartsEnabled: false,
  quoteReplyEnabled: true,
  highlightEnabled: false,
  highlightTimelineMarkersEnabled: true,
  responseCompleteNotificationEnabled: false,
  remoteAnnouncementEnabled: true,
  changelogBadgeMode: false,
  usageStatusEnabled: true,
  inputHaloHidden: false,
  defaultModelAutoApplyEnabled: false,
};

describe('GeneralSettingsCard', () => {
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

  const render = (overrides: Partial<GeneralSettingsCardProps> = {}) => {
    const props: GeneralSettingsCardProps = {
      values,
      onChange: vi.fn(),
      isSafariBrowser: false,
      remoteAnnouncementPermissionCta: { visible: false, onRequest: vi.fn() },
      isVisible: () => true,
      t: translate,
      ...overrides,
    };
    act(() => {
      root.render(<GeneralSettingsCard {...props} />);
    });
    return props;
  };

  const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;

  it('renders every value and reports one key per change', () => {
    const props = render();
    expect(input('mermaid-enabled').checked).toBe(true);
    expect(input('quote-reply-enabled').checked).toBe(true);
    expect(input('usage-status-enabled').checked).toBe(true);
    expect(input('default-model-auto-apply').checked).toBe(false);

    act(() => input('wavedrom-enabled').click());
    expect(props.onChange).toHaveBeenLastCalledWith({ wavedromEnabled: true });
    act(() => input('changelog-notify-badge').click());
    expect(props.onChange).toHaveBeenLastCalledWith({ changelogBadgeMode: true });
    expect(props.onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps the retired tab-title row disabled and gates timeline markers on highlights', () => {
    render();
    expect(input('tab-title-update').disabled).toBe(true);
    expect(input('tab-title-update').checked).toBe(false);
    expect(input('highlight-timeline-markers-enabled').disabled).toBe(true);

    render({ values: { ...values, highlightEnabled: true } });
    expect(input('highlight-timeline-markers-enabled').disabled).toBe(false);
  });

  it('switches the completion hint on Safari', () => {
    render();
    expect(container.textContent).toContain('responseCompleteNotificationHint');
    expect(container.textContent).not.toContain('responseCompleteNotificationHintSafari');

    render({ isSafariBrowser: true });
    expect(container.textContent).toContain('responseCompleteNotificationHintSafari');
  });

  it('shows the announcement permission call-to-action only when asked', () => {
    render();
    expect(container.textContent).not.toContain('remoteAnnouncementSystemPermissionCta');

    const onRequest = vi.fn();
    render({ remoteAnnouncementPermissionCta: { visible: true, onRequest } });
    const cta = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('remoteAnnouncementSystemPermissionCta'),
    )!;
    act(() => cta.click());
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it('leaves rows out of the DOM when the site or search rules them out', () => {
    render({ isVisible: (settingId) => settingId !== 'enableMermaidRendering' });
    expect(container.querySelector('#mermaid-enabled')).toBeNull();
    expect(container.querySelector('#quote-reply-enabled')).not.toBeNull();

    render({ isVisible: (settingId) => settingId !== 'enableTabTitleUpdate' });
    expect(container.querySelector('#tab-title-update')).toBeNull();
  });
});
