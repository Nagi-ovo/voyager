import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineNavigation } from '../TimelineNavigation';
import type { TimelineState } from '../TimelineState';
import type { TimelineView } from '../TimelineView';
import { TimelineManager } from '../manager';
import type { SyncSettingsListener } from '../types';

vi.mock('../../../../utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));

type TimelineOwners = {
  view: TimelineView;
  state: TimelineState;
  navigation: TimelineNavigation;
  onSyncSettingsChanged: SyncSettingsListener | null;
  registerSyncSettingsListener(): void;
  mountUI(): void;
};

const managers: TimelineManager[] = [];

function fixture() {
  const manager = new TimelineManager();
  managers.push(manager);
  return { manager, owners: manager as unknown as TimelineOwners };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  managers.splice(0).forEach((manager) => manager.destroy());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TimelineManager lifecycle', () => {
  it('registers a sync settings listener once and removes it on destroy', () => {
    const { manager, owners } = fixture();
    owners.registerSyncSettingsListener();
    const listener = owners.onSyncSettingsChanged;
    expect(listener).toBeTypeOf('function');
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledWith(listener);
    owners.registerSyncSettingsListener();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);

    manager.destroy();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
    expect(owners.onSyncSettingsChanged).toBeNull();
  });

  it('does not register sync settings after destroy', () => {
    const { manager, owners } = fixture();
    manager.destroy();
    owners.registerSyncSettingsListener();
    expect(owners.onSyncSettingsChanged).toBeNull();
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();
  });

  it('routes sync settings to navigation and the cached view position', () => {
    const { owners } = fixture();
    owners.registerSyncSettingsListener();
    const listener = owners.onSyncSettingsChanged!;
    const position = { version: 2, topPercent: 12, leftPercent: 34 };
    listener(
      {
        geminiTimelinePosition: { newValue: position },
        geminiTimelineScrollMode: { newValue: 'jump' },
      },
      'sync',
    );
    expect(owners.view.savedTimelinePosition).toEqual(position);
    expect(owners.navigation.mode).toBe('jump');
    listener(
      {
        geminiTimelinePosition: { newValue: null },
        geminiTimelineScrollMode: { newValue: 'flow' },
      },
      'local',
    );
    expect(owners.view.savedTimelinePosition).toEqual(position);
    expect(owners.navigation.mode).toBe('jump');
    listener({ geminiTimelinePosition: { newValue: null } }, 'sync');
    expect(owners.view.savedTimelinePosition).toBeNull();
  });

  it('does not initialize a destroyed instance', async () => {
    const { manager } = fixture();
    manager.destroy();
    await manager.init();
    expect(document.querySelector('.gemini-timeline-bar')).toBeNull();
  });

  it('cancels the pending DOM wait when destroyed during initialization', async () => {
    const { manager, owners } = fixture();
    const init = manager.init();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    manager.destroy();
    document.body.innerHTML =
      '<main><div class="user-query-bubble-with-background">Late turn</div></main>';
    await init;
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('.gemini-timeline-bar')).toBeNull();
    expect(owners.view.ui.timelineBar).toBeNull();
    expect(owners.navigation.viewport).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes preview long-press to the shared conversation state', () => {
    const { owners } = fixture();
    const toggle = vi.spyOn(owners.state, 'toggleStar').mockResolvedValue(undefined);
    owners.state.replaceMarkers([
      {
        id: 's-compact',
        element: document.createElement('div'),
        summary: 'Compact turn',
        assistantSummary: '',
        baseN: 0,
        starred: false,
      },
    ]);
    owners.mountUI();
    owners.view.updatePreviewMarkers();
    owners.view.previewPanel!.open();
    const item = document.querySelector<HTMLElement>('.timeline-preview-item')!;
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    vi.advanceTimersByTime(550);
    expect(toggle).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith('s-compact');
  });
});
