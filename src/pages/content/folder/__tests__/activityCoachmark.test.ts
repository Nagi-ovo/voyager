import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

const mocks = vi.hoisted(() => ({
  getTranslationSync: vi.fn((key: string) => key),
  initI18n: vi.fn(async () => undefined),
  showCoachmark: vi.fn(async (_config: unknown) => 'dismissed'),
  syncGet: vi.fn(async (defaults?: Record<string, unknown>) => defaults ?? {}),
  localGet: vi.fn(async (defaults?: Record<string, unknown>) => defaults ?? {}),
  localSet: vi.fn(async () => undefined),
  releaseSidebar: vi.fn(),
  keepSidebarExpanded: vi.fn(),
}));

mocks.keepSidebarExpanded.mockImplementation(() => mocks.releaseSidebar);

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: mocks.syncGet },
      local: { get: mocks.localGet, set: mocks.localSet },
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: mocks.getTranslationSync,
  initI18n: mocks.initI18n,
}));

vi.mock('../../coachmark', () => ({ showCoachmark: mocks.showCoachmark }));
vi.mock('../../sidebarAutoHide', () => ({ keepSidebarExpanded: mocks.keepSidebarExpanded }));

interface CapturedCoachmarkConfig {
  id: string;
  anchor: () => HTMLElement | null;
  toggle: {
    initial: boolean;
    onChange: (on: boolean) => Promise<void>;
  };
}

describe('folder Activity coachmark', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'location', {
      value: { hostname: 'gemini.google.com' },
      configurable: true,
      writable: true,
    });
    mocks.syncGet.mockResolvedValue({
      geminiFolderEnabled: true,
      [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
    });
    mocks.localGet.mockResolvedValue({ [StorageKeys.FOLDERS_VIEW_MODE]: 'folders' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('anchors to the Activity bell and enables the live attention view', async () => {
    const button = document.createElement('button');
    button.className = 'gv-folder-activity-toggle';
    button.getBoundingClientRect = () => new DOMRect(24, 80, 32, 32);
    document.body.appendChild(button);
    const { maybeShowFolderActivityCoachmark } = await import('../activityCoachmark');

    const pending = maybeShowFolderActivityCoachmark({ force: true });
    await vi.advanceTimersByTimeAsync(320);
    await pending;

    const config = mocks.showCoachmark.mock.calls[0]![0] as CapturedCoachmarkConfig;
    expect(config.id).toBe('folder-activity-view-intro-v1');
    expect(config.anchor()).toBe(button);
    expect(config.toggle.initial).toBe(false);

    await config.toggle.onChange(true);
    expect(mocks.localSet).toHaveBeenCalledWith({
      [StorageKeys.FOLDERS_VIEW_MODE]: 'activity',
      [StorageKeys.FOLDERS_COLLAPSED]: false,
    });
    expect(mocks.keepSidebarExpanded).toHaveBeenCalledOnce();
    expect(mocks.releaseSidebar).toHaveBeenCalledOnce();
  });

  it('skips the automatic tour when folders use floating mode', async () => {
    mocks.syncGet.mockResolvedValue({
      geminiFolderEnabled: true,
      [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: true,
    });
    const { maybeShowFolderActivityCoachmark } = await import('../activityCoachmark');

    await maybeShowFolderActivityCoachmark();

    expect(mocks.showCoachmark).not.toHaveBeenCalled();
  });

  it('can be forced from the page console through its debug event', async () => {
    const button = document.createElement('button');
    button.className = 'gv-folder-activity-toggle';
    button.getBoundingClientRect = () => new DOMRect(24, 80, 32, 32);
    document.body.appendChild(button);
    const { FOLDER_ACTIVITY_COACHMARK_DEBUG_EVENT } = await import('../activityCoachmark');

    document.dispatchEvent(new Event(FOLDER_ACTIVITY_COACHMARK_DEBUG_EVENT));
    await vi.advanceTimersByTimeAsync(320);

    expect(mocks.showCoachmark).toHaveBeenCalled();
  });
});
