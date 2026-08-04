import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => {
    const translations: Record<string, string> = {
      gemsHide: 'Hide Gems',
      gemsShow: 'Show Gems',
      notebooksHide: 'Hide Notebooks',
      notebooksShow: 'Show Notebooks',
      sidebarCollapseNudgeTitle: 'Collapsed sections are still here',
      sidebarCollapseNudgeBody:
        'A slim bar stays in the sidebar. Click it anytime to expand this section again.',
      sidebarCollapseNudgeDismiss: 'Got it',
    };

    return translations[key] || key;
  },
}));

describe('gemsHider', () => {
  let cleanup: (() => void) | null = null;
  let localState: Record<string, boolean>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    localStorage.clear();
    Object.defineProperty(chrome.runtime, 'lastError', {
      value: null,
      configurable: true,
    });

    Object.defineProperty(window, 'location', {
      value: {
        hostname: 'gemini.google.com',
      },
      writable: true,
      configurable: true,
    });

    localState = {};
    (
      chrome.storage as unknown as {
        local: {
          get: Mock;
          set: Mock;
        };
      }
    ).local = {
      get: vi
        .fn()
        .mockImplementation(
          (
            defaults: Record<string, boolean>,
            callback: (result: Record<string, boolean>) => void,
          ) => {
            const key = Object.keys(defaults)[0];
            callback({
              [key]: Object.prototype.hasOwnProperty.call(localState, key)
                ? localState[key]
                : defaults[key],
            });
          },
        ),
      set: vi.fn().mockImplementation((update: Record<string, boolean>, callback?: () => void) => {
        Object.assign(localState, update);
        callback?.();
      }),
    };
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
  });

  function createLegacyGemsSection(): HTMLElement {
    const host = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'gems-list-container';

    const arrowIcon = document.createElement('div');
    arrowIcon.setAttribute('data-test-id', 'arrow-icon');
    container.appendChild(arrowIcon);

    host.appendChild(container);
    document.body.appendChild(host);

    return container;
  }

  function createNotebookSection(): HTMLElement {
    // Mirrors Gemini's 2026 expandable-section layout. The header is itself a
    // <button>, so the hider mounts its toggle in absolute mode on the section
    // wrapper (rather than nested inside the header button).
    const host = document.createElement('infinite-scroller');
    const container = document.createElement('expandable-section');
    container.setAttribute('data-test-id', 'notebooks-expandable-section');

    const header = document.createElement('button');
    header.className = 'expandable-section-header';
    header.setAttribute('data-test-id', 'expandable-section-toggle');

    const title = document.createElement('span');
    title.className = 'expandable-section-title gds-body-s';
    title.textContent = 'Notebooks';
    header.appendChild(title);

    container.appendChild(header);
    host.appendChild(container);
    document.body.appendChild(host);

    return container;
  }

  async function startFeature(): Promise<void> {
    const { startGemsHider } = await import('../index');
    cleanup = startGemsHider();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();
  }

  async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('does not inject a hide control on Notebooks (slot is now used by the folder-anchor swap toggle)', async () => {
    localState[StorageKeys.GEMS_HIDDEN] = true;

    const gems = createLegacyGemsSection();
    const notebooks = createNotebookSection();

    await startFeature();

    // Gems still gets its toggle (legacy layout still supported).
    expect(gems.querySelector('.gv-sidebar-section-toggle-btn')?.getAttribute('title')).toBe(
      'Hide Gems',
    );
    // Notebooks no longer gets one — the same corner is owned by the folder
    // manager's anchor swap button.
    expect(notebooks.querySelector('.gv-sidebar-section-toggle-btn')).toBeNull();
    // And no peek bar is mounted for the notebooks section.
    expect(
      document.querySelector(
        '[data-gv-sidebar-section-id="notebooks"].gv-sidebar-section-peek-bar',
      ),
    ).toBeNull();
  });

  it('leaves Voyager Folders to its built-in collapse and Activity controls', async () => {
    document.body.innerHTML = `
      <div class="gv-folder-container">
        <div class="gv-folder-header"><div class="gv-folder-header-actions"></div></div>
        <div class="gv-folder-list"></div>
      </div>
    `;

    await startFeature();

    expect(
      document.querySelector('.gv-folder-container .gv-sidebar-section-toggle-btn'),
    ).toBeNull();
    expect(document.querySelector('[data-gv-sidebar-section-id="folders"]')).toBeNull();
  });

  it('processes all sections added across one debounce window', async () => {
    await startFeature();

    const gems = createLegacyGemsSection();
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(50);

    const secondGems = createLegacyGemsSection();
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(100);
    await flushAsyncWork();

    expect(gems.querySelector('.gv-sidebar-section-toggle-btn')?.getAttribute('title')).toBe(
      'Hide Gems',
    );
    expect(secondGems.querySelector('.gv-sidebar-section-toggle-btn')?.getAttribute('title')).toBe(
      'Hide Gems',
    );
  });

  it('falls back to localStorage when storage.local.set reports lastError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (chrome.storage.local.set as Mock).mockImplementation(
      (_update: Record<string, boolean>, callback?: () => void) => {
        Object.defineProperty(chrome.runtime, 'lastError', {
          value: { message: 'storage failed' },
          configurable: true,
        });
        callback?.();
        Object.defineProperty(chrome.runtime, 'lastError', {
          value: null,
          configurable: true,
        });
      },
    );

    const gems = createLegacyGemsSection();
    await startFeature();

    gems
      .querySelector<HTMLButtonElement>('.gv-sidebar-section-toggle-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushAsyncWork();

    expect(localStorage.getItem(StorageKeys.GEMS_HIDDEN)).toBe('true');
    warn.mockRestore();
  });
});
