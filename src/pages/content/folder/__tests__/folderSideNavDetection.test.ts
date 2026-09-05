import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSidebarRuntimeHarness, mountSidebar, setLayout } from './sidebarRuntimeHarness';

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

describe('folder sidebar visibility', () => {
  let harness: ReturnType<typeof createSidebarRuntimeHarness>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness = createSidebarRuntimeHarness();
  });

  afterEach(() => {
    harness.runtime.stop();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['chat-app', 'legacy root', 'rendered width'])(
    'shows the panel when %s marks the sidebar open',
    async (marker) => {
      const { host } = mountSidebar();
      if (marker !== 'chat-app') host.className = '';
      if (marker === 'legacy root') {
        const root = document.createElement('div');
        root.id = 'app-root';
        root.className = 'side-nav-open';
        document.body.appendChild(root);
      }
      if (marker === 'rendered width') {
        const sidenav = document.createElement('bard-sidenav');
        setLayout(sidenav, 452, 800);
        document.body.appendChild(sidenav);
      }
      await harness.runtime.start('sidebar');
      expect(harness.runtime.panel?.style.display).toBe('');
    },
  );

  it('hides on sidebar close and shows on reopen without recreating the panel', async () => {
    const { host } = mountSidebar();
    await harness.runtime.start('sidebar');
    const panel = harness.runtime.panel!;
    host.className = '';
    await vi.advanceTimersByTimeAsync(20);
    expect(panel.style.display).toBe('none');
    host.className = 'side-nav-open';
    await vi.advanceTimersByTimeAsync(20);
    expect(panel.style.display).toBe('');
    expect(harness.runtime.panel).toBe(panel);
    expect(harness.createPanel).toHaveBeenCalledTimes(1);
  });

  it('opens a fallback for an attached invisible panel only after the hidden-panel grace', async () => {
    mountSidebar();
    await harness.runtime.start('sidebar');
    setLayout(harness.runtime.panel!, 0, 0);
    await vi.advanceTimersByTimeAsync(3999);
    expect(harness.floating.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.floating.open).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('repairs a stale inline hide before opening a floating fallback', async () => {
    mountSidebar();
    await harness.runtime.start('sidebar');
    const panel = harness.runtime.panel!;
    panel.style.display = 'none';
    Object.defineProperty(panel, 'offsetParent', {
      configurable: true,
      get: () => (panel.style.display === 'none' ? null : document.body),
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(panel.style.display).toBe('');
    expect(harness.floating.open).not.toHaveBeenCalled();
  });

  it.each(['visible panel', 'user-collapsed section', 'closed sidebar'])(
    'preserves a %s without opening the fallback',
    async (state) => {
      const { host } = mountSidebar();
      await harness.runtime.start('sidebar');
      const panel = harness.runtime.panel!;
      if (state !== 'visible panel') setLayout(panel, 0, 0);
      if (state === 'user-collapsed section') panel.classList.add('gv-sidebar-section-hidden');
      if (state === 'closed sidebar') host.className = '';
      await vi.advanceTimersByTimeAsync(8000);
      expect(harness.floating.open).not.toHaveBeenCalled();
    },
  );
});
