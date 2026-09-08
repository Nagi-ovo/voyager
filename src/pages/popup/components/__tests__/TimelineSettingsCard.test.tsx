import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranslationKey } from '@/utils/translations';

import {
  TimelineSettingsCard,
  type TimelineSettingsCardProps,
  type TimelineSettingsValues,
} from '../TimelineSettingsCard';

const translate = (key: TranslationKey): string => key;

const values: TimelineSettingsValues = {
  timelineStyle: 'ruler',
  mode: 'jump',
  hideContainer: false,
  draggableTimeline: true,
  timelinePreviewPinned: false,
  preventAutoScrollEnabled: false,
  markerLevelEnabled: true,
  showMessageTimestamps: false,
};

describe('TimelineSettingsCard', () => {
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

  const render = (overrides: Partial<TimelineSettingsCardProps> = {}) => {
    const props: TimelineSettingsCardProps = {
      values,
      onChange: vi.fn(),
      onResetPosition: vi.fn(),
      onViewStarredHistory: vi.fn(),
      isVisible: () => true,
      t: translate,
      ...overrides,
    };
    act(() => {
      root.render(<TimelineSettingsCard {...props} />);
    });
    return props;
  };

  it('renders every value into its control', () => {
    render();
    const checked = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!.checked;
    expect(checked('hide-container')).toBe(false);
    expect(checked('draggable-timeline')).toBe(true);
    expect(checked('timeline-preview-pinned')).toBe(false);
    expect(checked('prevent-auto-scroll')).toBe(false);
    expect(checked('marker-level-enabled')).toBe(true);
    expect(checked('show-message-timestamps')).toBe(false);

    const active = Array.from(container.querySelectorAll('button.text-primary-foreground')).map(
      (button) => button.textContent,
    );
    expect(active).toEqual(['timelineStyleRuler', 'jump']);
  });

  it('reports one key per change and keeps the reset and history actions separate', () => {
    const props = render();
    const click = (selector: string) =>
      act(() => {
        container.querySelector<HTMLElement>(selector)!.click();
      });

    act(() => {
      const input = container.querySelector<HTMLInputElement>('#timeline-preview-pinned')!;
      input.click();
    });
    expect(props.onChange).toHaveBeenLastCalledWith({ timelinePreviewPinned: true });

    click('button.text-muted-foreground');
    expect(props.onChange).toHaveBeenLastCalledWith({ timelineStyle: 'dots' });

    const buttons = Array.from(container.querySelectorAll('button'));
    buttons.find((b) => b.textContent === 'flow')!.click();
    expect(props.onChange).toHaveBeenLastCalledWith({ mode: 'flow' });

    buttons.find((b) => b.textContent?.includes('resetTimelinePosition'))!.click();
    expect(props.onResetPosition).toHaveBeenCalledOnce();
    buttons.find((b) => b.textContent?.includes('viewStarredHistory'))!.click();
    expect(props.onViewStarredHistory).toHaveBeenCalledOnce();
    expect(props.onChange).toHaveBeenCalledTimes(3);
  });

  it('hides rows the site or the settings search rules out, by search id', () => {
    render({ isVisible: (settingId) => settingId !== 'pinTimelinePreview' });
    const row = container
      .querySelector<HTMLElement>('#timeline-preview-pinned')!
      .closest<HTMLElement>('div.group')!;
    expect(row.hidden).toBe(true);
    expect(
      container.querySelector<HTMLElement>('#hide-container')!.closest<HTMLElement>('div.group')!
        .hidden,
    ).toBe(false);
  });

  it('marks the experimental rows with the shared badge', () => {
    render();
    const badges = Array.from(container.querySelectorAll('[title="experimentalLabel"]'));
    expect(badges).toHaveLength(2);
    expect(
      container.querySelector('label[for="marker-level-enabled"] [title="experimentalLabel"]'),
    ).not.toBeNull();
  });
});
