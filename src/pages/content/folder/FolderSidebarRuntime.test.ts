import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSidebarRuntimeHarness, mountSidebar } from './__tests__/sidebarRuntimeHarness';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
  },
}));
vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

describe('FolderSidebarRuntime lifecycle', () => {
  let harness: ReturnType<typeof createSidebarRuntimeHarness>;
  beforeEach(() => {
    vi.useFakeTimers();
    harness = createSidebarRuntimeHarness();
  });
  afterEach(() => {
    harness.runtime.stop();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets an active remount finish before starting a competing fallback', async () => {
    const { host } = mountSidebar();
    await harness.runtime.start('sidebar');
    host.remove();
    const remount = harness.runtime.remount();
    await vi.advanceTimersByTimeAsync(8000);
    expect(harness.floating.open).not.toHaveBeenCalled();
    harness.runtime.stop();
    await remount;
  });

  it('settles a pending sidebar wait on stop and leaves a later sidebar untouched', async () => {
    const initialization = harness.runtime.start('sidebar');
    harness.runtime.stop();
    await initialization;
    const { recentsSection } = mountSidebar();
    const row = document.createElement('div');
    row.dataset.testId = 'conversation';
    recentsSection.appendChild(row);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.createPanel).not.toHaveBeenCalled();
    expect(row.draggable).toBe(false);
    expect(harness.floating.open).not.toHaveBeenCalled();
  });

  it('coalesces a pending fallback open and closes its late result after stop', async () => {
    const { recentsSection } = mountSidebar();
    recentsSection.remove();
    let finishOpen!: () => void;
    harness.floating.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    await harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(harness.floating.open).toHaveBeenCalledTimes(1);
    harness.runtime.stop();
    harness.floating.close.mockClear();
    finishOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.floating.close).toHaveBeenCalledTimes(1);
  });

  it('allows explicit floating mode to adopt an in-flight fallback', async () => {
    const { recentsSection } = mountSidebar();
    recentsSection.remove();
    let finishOpen!: () => void;
    harness.floating.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    await harness.runtime.start('sidebar');
    await vi.advanceTimersByTimeAsync(8000);
    const switched = harness.runtime.start('floating');
    finishOpen();
    await switched;
    expect(harness.runtime.isFloatingMode).toBe(true);
    expect(harness.runtime.isFallbackActive).toBe(false);
    expect(harness.floating.open).toHaveBeenCalledTimes(1);
    expect(harness.floating.close).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    'honors the new floating startup request after stop (%s → %s)',
    async (firstOpenPanel, nextOpenPanel) => {
      let finishFirst!: () => void;
      const firstPending = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      let visible: 'panel' | 'fab' | null = null;
      harness.floating.open.mockImplementation(async (openPanel) => {
        if (harness.floating.open.mock.calls.length === 1) await firstPending;
        visible = openPanel ? 'panel' : 'fab';
      });
      harness.floating.close.mockImplementation(() => {
        visible = null;
      });

      const first = harness.runtime.start('floating', firstOpenPanel);
      harness.runtime.stop();
      const restarted = harness.runtime.start('floating', nextOpenPanel);
      finishFirst();
      await Promise.all([first, restarted]);

      expect(harness.floating.open.mock.calls).toEqual([[firstOpenPanel], [nextOpenPanel]]);
      expect(visible).toBe(nextOpenPanel ? 'panel' : 'fab');
      expect(harness.runtime.isFloatingMode).toBe(true);
    },
  );

  it('coalesces remounts and releases old panel bindings before constructing the replacement', async () => {
    mountSidebar();
    await harness.runtime.start('sidebar');
    const previous = harness.runtime.panel;
    harness.onPanelUnmount.mockImplementation(() => {
      expect(harness.runtime.panel).toBe(previous);
      expect(previous?.isConnected).toBe(true);
    });
    const one = harness.runtime.remount();
    const two = harness.runtime.remount();
    expect(one).toBe(two);
    await one;
    harness.onPanelUnmount.mockReset();
    expect(previous?.isConnected).toBe(false);
    expect(harness.createPanel).toHaveBeenCalledTimes(2);
    expect(harness.onPanelMount).toHaveBeenLastCalledWith(
      harness.runtime.panel,
      harness.runtime.sidebar,
    );
    expect(document.querySelectorAll('.gv-folder-container')).toHaveLength(1);
  });
});
