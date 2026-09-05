import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeConversationMenus } from '../NativeConversationMenus';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

/** Native menus restore trigger focus; pointer dismissal should not leave the row highlighted. */
describe('menu close focus release', () => {
  let menus: NativeConversationMenus;
  let trigger: HTMLButtonElement;
  let menu: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    menus = new NativeConversationMenus({
      getContext: () => ({
        sidebar: null,
        storageKey: 'gvFolderData',
        accountIsolationEnabled: false,
        isDestroyed: false,
      }),
      onMoveToFolder: vi.fn(),
      onConfirmedDelete: vi.fn(),
    });
    menus.startTracking();
    menus.observePanels();
    trigger = document.createElement('button');
    trigger.setAttribute('data-test-id', 'actions-menu-button');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'native-menu');
    document.body.appendChild(trigger);
    menu = document.createElement('gem-menu');
    menu.id = 'native-menu';
    menu.innerHTML =
      '<gem-menu-item data-test-id="rename-button"><mat-icon fonticon="edit">edit</mat-icon><span class="label">Rename</span></gem-menu-item>';
    document.body.appendChild(menu);
    trigger.click();
    await vi.advanceTimersByTimeAsync(40);
    expect(menu.querySelector('.gv-move-to-folder-btn')).not.toBeNull();
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  afterEach(() => {
    menus.stop();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function closeMenu(): Promise<void> {
    menu.remove();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('blurs the trigger after a pointer-driven close', async () => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await closeMenu();
    expect(document.activeElement).not.toBe(trigger);
  });

  it('keeps focus on the trigger after a keyboard-driven close (a11y)', async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await closeMenu();
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['cdk-overlay-backdrop', 'gv-folder-dialog-overlay'])(
    'preserves trigger focus when a %s remains open',
    async (className) => {
      const overlay = document.createElement('div');
      overlay.className = className;
      document.body.appendChild(overlay);
      await closeMenu();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it('leaves focus alone when the active element is not a conversation trigger', async () => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    await closeMenu();
    expect(document.activeElement).toBe(other);
  });
});
