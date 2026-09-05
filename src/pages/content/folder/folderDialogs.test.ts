import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FOLDER_COLORS } from './folderColors';
import { type FolderDialogs, createFolderDialogs } from './folderDialogs';

vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) =>
    key === 'folder_remove_conversation_confirm' ? 'Remove {title}?' : key,
}));

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

function mountList(): HTMLElement {
  document.body.innerHTML = `
    <div class="gv-folder-list">
      <div data-folder-id="parent">
        <div class="gv-folder-item-header"><span class="gv-folder-name">Original</span></div>
        <div class="gv-folder-content"><div class="existing-conversation"></div></div>
      </div>
    </div>`;
  return query('.gv-folder-list');
}

const clickAt = () => new MouseEvent('click', { clientX: 30, clientY: 45 });

describe('folder dialogs', () => {
  let dialogs: FolderDialogs;

  beforeEach(() => {
    vi.useFakeTimers();
    dialogs = createFolderDialogs();
  });

  afterEach(() => {
    dialogs.closeAll();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['root', null, '.gv-folder-list', false],
    ['expanded parent', 'parent', '.gv-folder-content', false],
    ['parent without content', 'parent', '.gv-folder-list', true],
    ['missing parent', 'missing', '.gv-folder-list', false],
  ] as const)(
    'places a create editor in the %s location',
    (_label, parentId, hostSelector, removeContent) => {
      const list = mountList();
      if (removeContent) query('.gv-folder-content').remove();
      dialogs.openCreate(list, parentId, vi.fn());
      const editor = query('.gv-folder-inline-input');
      expect(editor.parentElement).toBe(query(hostSelector));
      if (parentId === 'parent' && removeContent) {
        expect(editor.previousElementSibling?.getAttribute('data-folder-id')).toBe('parent');
      } else if (parentId !== 'missing') {
        expect(editor.parentElement?.firstElementChild).toBe(editor);
      }
      expect(document.activeElement).toBe(query('.gv-folder-name-input'));
    },
  );

  it('submits a trimmed create name only on an explicit save, once', () => {
    const onSubmit = vi.fn();
    dialogs.openCreate(mountList(), null, onSubmit);
    const input = query<HTMLInputElement>('.gv-folder-name-input');
    expect(input.maxLength).toBe(50);
    expect(input.placeholder).toBe('folder_name_prompt');
    input.value = '  New folder  ';
    input.dispatchEvent(new FocusEvent('blur'));
    expect(onSubmit).not.toHaveBeenCalled();
    const save = query<HTMLButtonElement>('.gv-folder-inline-save');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    save.click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('New folder');
    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });

  it.each(['empty', 'cancel', 'Escape'])('discards a create draft on %s', (action) => {
    const onSubmit = vi.fn();
    dialogs.openCreate(mountList(), null, onSubmit);
    const input = query<HTMLInputElement>('.gv-folder-name-input');
    input.value = action === 'empty' ? '   ' : 'Draft';
    if (action === 'cancel') query<HTMLButtonElement>('.gv-folder-inline-cancel').click();
    else
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: action === 'empty' ? 'Enter' : action }),
      );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });

  it('opens a rename with selected text, then restores the label on cancellation', () => {
    mountList();
    const onSubmit = vi.fn();
    dialogs.openRename(query('[data-folder-id="parent"]'), 'Original', onSubmit);
    const input = query<HTMLInputElement>('.gv-folder-rename-input');
    expect(input.value).toBe('Original');
    expect(input.maxLength).toBe(50);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
    expect(query('.gv-folder-name').classList.contains('gv-hidden')).toBe(true);
    input.value = 'Discarded';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(query('.gv-folder-name').textContent).toBe('Original');
    expect(query('.gv-folder-name').classList.contains('gv-hidden')).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a trimmed rename and prevents a retained old editor from submitting again', () => {
    mountList();
    const onSubmit = vi.fn();
    dialogs.openRename(query('[data-folder-id="parent"]'), 'Original', onSubmit);
    const input = query<HTMLInputElement>('.gv-folder-rename-input');
    input.value = '  Renamed  ';
    query<HTMLButtonElement>('.gv-folder-inline-save').click();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Renamed');
    expect(document.querySelector('.gv-folder-rename-inline')).toBeNull();
  });

  it('closes only inline drafts during list refresh and leaves an open move dialog usable', () => {
    const list = mountList();
    const onCreate = vi.fn();
    const onRename = vi.fn();
    dialogs.openCreate(list, null, onCreate);
    dialogs.openRename(query('[data-folder-id="parent"]'), 'Original', onRename);
    dialogs.openMove([], vi.fn());
    const create = query<HTMLInputElement>('.gv-folder-name-input');
    const rename = query<HTMLInputElement>('.gv-folder-rename-input');
    dialogs.closeInline();
    create.value = rename.value = 'Old account';
    create.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-folder-inline-input, .gv-folder-rename-inline')).toBeNull();
    expect(query('.gv-folder-name').classList.contains('gv-hidden')).toBe(false);
    expect(document.querySelector('.gv-folder-dialog-overlay')).not.toBeNull();
    query<HTMLButtonElement>('.gv-folder-dialog-cancel').click();
    expect(document.querySelector('.gv-folder-dialog-overlay')).toBeNull();
  });

  it.each(['light', 'dark'])('shows the selected preset and its %s theme colors', (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const onSelect = vi.fn();
    dialogs.openColor('folder', 'red', clickAt(), onSelect);
    const dialog = query('.gv-color-picker-dialog');
    expect([dialog.style.left, dialog.style.top, dialog.style.zIndex]).toEqual([
      '40px',
      '45px',
      '10001',
    ]);
    const selected = query<HTMLButtonElement>('.gv-color-picker-item.selected');
    expect(selected.title).toBe('folder_color_red');
    const red = FOLDER_COLORS.find((color) => color.id === 'red')!;
    const expected = document.createElement('div');
    expected.style.backgroundColor = theme === 'dark' ? red.darkColor : red.lightColor;
    expect(selected.style.backgroundColor).toBe(expected.style.backgroundColor);
    selected.click();
    selected.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('red');
    expect(document.querySelector('.gv-color-picker-dialog')).toBeNull();
  });

  it('toggles the same folder color picker and replaces it when toggle is disabled', () => {
    const onSelect = vi.fn();
    dialogs.openColor('a', undefined, clickAt(), onSelect);
    expect(query<HTMLButtonElement>('.gv-color-picker-item.selected').title).toBe(
      'folder_color_default',
    );
    dialogs.openColor('a', undefined, clickAt(), onSelect);
    expect(document.querySelector('.gv-color-picker-dialog')).toBeNull();
    dialogs.openColor('a', undefined, clickAt(), onSelect);
    const old = query<HTMLButtonElement>('.gv-color-picker-item');
    dialogs.openColor('a', '#123456', clickAt(), onSelect, false);
    old.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.gv-color-picker-dialog')).toHaveLength(1);
    const input = query<HTMLInputElement>('.gv-color-picker-custom input');
    expect(input.value).toBe('#123456');
    expect(query('.gv-color-picker-custom').classList.contains('selected')).toBe(true);
    input.value = '#abcdef';
    input.dispatchEvent(new Event('change'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('#abcdef');
    expect(document.querySelector('.gv-color-picker-dialog')).toBeNull();
  });

  it('waits for the opening click before dismissing a picker on an outside click', () => {
    dialogs.openColor('a', undefined, clickAt(), vi.fn());
    document.body.click();
    expect(document.querySelector('.gv-color-picker-dialog')).not.toBeNull();
    vi.advanceTimersByTime(0);
    query('.gv-color-picker-dialog').click();
    expect(document.querySelector('.gv-color-picker-dialog')).not.toBeNull();
    document.body.click();
    expect(document.querySelector('.gv-color-picker-dialog')).toBeNull();
  });

  it('counts instruction characters and closes after the save promise settles', async () => {
    let finishSave!: (saved: boolean) => void;
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    dialogs.openInstructions('Original', onSave);
    const input = query<HTMLTextAreaElement>('.gv-fi-textarea');
    expect(query('.gv-fi-title').textContent).toBe('folderAsProject_editInstructions');
    expect(input.placeholder).toBe('folderAsProject_setInstructions');
    expect(input.maxLength).toBe(10000);
    expect(query('.gv-fi-char-count').textContent).toBe('8 / 10000');
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
    input.value = '  New instructions  ';
    input.dispatchEvent(new InputEvent('input'));
    expect(query('.gv-fi-char-count').textContent).toBe('20 / 10000');
    query<HTMLButtonElement>('.gv-fi-btn-save').click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith('New instructions');
    expect(document.querySelector('.gv-fi-overlay')).not.toBeNull();
    finishSave(true);
    await Promise.resolve();
    expect(document.querySelector('.gv-fi-overlay')).toBeNull();
  });

  it('preserves an instructions draft after a failed save and permits retry', async () => {
    let finishSave!: (saved: boolean) => void;
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    dialogs.openInstructions('Original', onSave);
    const input = query<HTMLTextAreaElement>('.gv-fi-textarea');
    const save = query<HTMLButtonElement>('.gv-fi-btn-save');
    input.value = 'Keep this draft';
    save.click();
    save.click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith('Keep this draft');
    expect(save.disabled).toBe(true);
    finishSave(false);
    await Promise.resolve();
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('Keep this draft');
    expect(save.disabled).toBe(false);
    save.click();
    finishSave(true);
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.gv-fi-overlay')).toBeNull();
  });

  it('saves an empty instructions draft as undefined', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    dialogs.openInstructions(undefined, onSave);
    expect(query('.gv-fi-title').textContent).toBe('folderAsProject_setInstructions');
    query<HTMLTextAreaElement>('.gv-fi-textarea').value = '   ';
    query<HTMLButtonElement>('.gv-fi-btn-save').click();
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(document.querySelector('.gv-fi-overlay')).toBeNull();
  });

  it.each(['cancel', 'Escape', 'overlay'])('discards instruction changes on %s', (action) => {
    const onSave = vi.fn().mockResolvedValue(true);
    dialogs.openInstructions('Original', onSave);
    query<HTMLTextAreaElement>('.gv-fi-textarea').value = 'Discarded';
    const oldSave = query<HTMLButtonElement>('.gv-fi-btn-save');
    if (action === 'cancel') query<HTMLButtonElement>('.gv-fi-btn-cancel').click();
    else if (action === 'Escape')
      query('.gv-fi-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else query('.gv-fi-overlay').click();
    oldSave.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-fi-overlay')).toBeNull();
  });

  it('invalidates old account dialogs and their deferred work without closing the next account editor', async () => {
    const onCreate = vi.fn();
    const onConfirm = vi.fn();
    const onColor = vi.fn();
    let finishSave!: (saved: boolean) => void;
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    dialogs.openCreate(mountList(), null, onCreate);
    dialogs.openColor('a', 'red', clickAt(), onColor);
    dialogs.confirmFolderRemoval(query('[data-folder-id="parent"]'), onConfirm);
    dialogs.openInstructions('Account A', onSave);
    const create = query<HTMLInputElement>('.gv-folder-name-input');
    const yes = query<HTMLButtonElement>('.gv-folder-confirm-yes');
    const color = query<HTMLButtonElement>('.gv-color-picker-item');
    const oldInput = query<HTMLTextAreaElement>('.gv-fi-textarea');
    const oldFocus = vi.spyOn(oldInput, 'focus');
    const oldSave = query<HTMLButtonElement>('.gv-fi-btn-save');
    oldSave.click();
    const addListener = vi.spyOn(document, 'addEventListener');
    dialogs.closeAll();
    dialogs.closeAll();
    expect(
      document.querySelector(
        '.gv-fi-overlay, .gv-folder-confirm-dialog, .gv-color-picker-dialog, .gv-folder-inline-input',
      ),
    ).toBeNull();
    create.value = 'Stale folder';
    create.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    yes.click();
    color.click();
    oldSave.click();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onColor).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(oldFocus).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();

    dialogs.openInstructions('Account B', vi.fn().mockResolvedValue(true));
    finishSave(true);
    await Promise.resolve();
    expect(query<HTMLTextAreaElement>('.gv-fi-textarea').value).toBe('Account B');
  });

  it('anchors folder removal to its header and only confirms once', () => {
    mountList();
    const header = query('.gv-folder-item-header');
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 20, 100, 30));
    const onConfirm = vi.fn();
    dialogs.confirmFolderRemoval(query('[data-folder-id="parent"]'), onConfirm);
    const dialog = query('.gv-folder-confirm-dialog');
    expect([dialog.style.left, dialog.style.top, dialog.style.zIndex]).toEqual([
      '36px',
      '54px',
      '10002',
    ]);
    const yes = query<HTMLButtonElement>('.gv-folder-confirm-yes');
    expect(yes.textContent).toBe('folder_remove_conversation_action');
    expect(onConfirm).not.toHaveBeenCalled();
    yes.click();
    yes.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.gv-folder-confirm-dialog')).toBeNull();
  });

  it('renders a conversation title as text and bounds its confirmation within the viewport', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(window.innerWidth - 10, 20, 5, 30),
    );
    const onConfirm = vi.fn();
    const title = '<img src=x onerror="bad()">';
    dialogs.confirmConversationRemoval(title, anchor, onConfirm);
    const dialog = query('.gv-folder-confirm-dialog');
    expect(dialog.style.left).toBe(`${window.innerWidth - 280}px`);
    expect(dialog.style.top).toBe('54px');
    expect(query('.gv-folder-confirm-message').textContent).toBe(`Remove ${title}?`);
    expect(dialog.querySelector('img')).toBeNull();
    expect(query('.gv-folder-confirm-yes').textContent).toBe('pm_delete');
    query<HTMLButtonElement>('.gv-folder-confirm-no').click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-folder-confirm-dialog')).toBeNull();
  });

  it('keeps conversation actions single and closes the menu before running a native command', () => {
    const oldAction = vi.fn();
    const newAction = vi.fn(() =>
      expect(document.querySelector('.gv-folder-conversation-menu')).toBeNull(),
    );
    dialogs.openMenu(clickAt(), [{ label: 'old', action: oldAction }], 'conversation');
    const oldButton = query<HTMLButtonElement>('.gv-folder-menu-item');
    dialogs.openMenu(clickAt(), [{ label: 'rename', action: newAction }], 'conversation');
    oldButton.click();
    expect(oldAction).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.gv-folder-conversation-menu')).toHaveLength(1);
    query<HTMLButtonElement>('.gv-folder-menu-item').click();
    expect(newAction).toHaveBeenCalledTimes(1);
  });

  it('preserves folder menu action timing and clears its old action at runtime teardown', () => {
    const action = vi.fn(() => expect(document.querySelector('.gv-folder-menu')).not.toBeNull());
    dialogs.openMenu(clickAt(), [{ label: '<b>Folder action</b>', action }]);
    const menu = query('.gv-folder-menu');
    expect([menu.style.left, menu.style.top]).toEqual(['30px', '45px']);
    expect(menu.querySelector('b')).toBeNull();
    query<HTMLButtonElement>('.gv-folder-menu-item').click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.gv-folder-menu')).toBeNull();
    dialogs.openMenu(clickAt(), [{ label: 'Old account action', action }]);
    const old = query<HTMLButtonElement>('.gv-folder-menu-item');
    dialogs.closeAll();
    old.click();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
