import type { Folder } from '@/core/types/folder';
import { sortFolders } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import { FOLDER_COLORS, getFolderColor, isDarkMode } from './folderColors';

type FolderMenuAction = { label: string; action: () => void };

export type FolderDialogs = {
  openCreate: (
    folderList: HTMLElement | null,
    parentId: string | null,
    onSubmit: (name: string) => void,
  ) => void;
  openRename: (
    folderElement: Element | null,
    currentName: string,
    onSubmit: (name: string) => void,
  ) => void;
  openColor: (
    folderId: string,
    currentColor: string | undefined,
    event: MouseEvent,
    onSelect: (color: string) => void,
    allowToggle?: boolean,
  ) => void;
  openMove: (folders: readonly Folder[], onSelect: (folderId: string) => void) => void;
  openInstructions: (
    instructions: string | undefined,
    onSave: (instructions: string | undefined) => Promise<void>,
  ) => void;
  confirmFolderRemoval: (folderElement: Element | null, onConfirm: () => void) => void;
  confirmConversationRemoval: (title: string, anchor: HTMLElement, onConfirm: () => void) => void;
  openMenu: (
    event: MouseEvent,
    items: readonly FolderMenuAction[],
    kind?: 'folder' | 'conversation',
  ) => void;
  closeInline: () => void;
  closeAll: () => void;
};

type DialogView = {
  element: HTMLElement;
  inline: boolean;
  signal: AbortSignal;
  close: () => void;
  defer: (action: () => void, delay: number) => void;
};

function normalizeFolderPath(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, '/');
}

/** Owns temporary folder views, including listeners and deferred focus, for one runtime. */
export function createFolderDialogs(): FolderDialogs {
  const views = new Set<DialogView>();
  let activeCreate: { view: DialogView; input: HTMLInputElement } | null = null;
  let activeColor: { view: DialogView; folderId: string } | null = null;
  let conversationMenu: DialogView | null = null;

  const own = (element: HTMLElement, inline = false, restore?: () => void): DialogView => {
    const controller = new AbortController();
    const timers = new Set<number>();
    const view: DialogView = {
      element,
      inline,
      signal: controller.signal,
      close: () => {
        if (controller.signal.aborted) return;
        controller.abort();
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
        element.remove();
        restore?.();
        views.delete(view);
        if (activeCreate?.view === view) activeCreate = null;
        if (activeColor?.view === view) activeColor = null;
        if (conversationMenu === view) conversationMenu = null;
      },
      defer: (action, delay) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (!controller.signal.aborted) action();
        }, delay);
        timers.add(timer);
      },
    };
    views.add(view);
    return view;
  };

  const dismissOnOutsideClick = (view: DialogView) => {
    view.defer(() => {
      document.addEventListener(
        'click',
        (event) => {
          if (!view.element.contains(event.target as Node)) view.close();
        },
        { signal: view.signal },
      );
    }, 0);
  };

  const createInlineButtons = (container: HTMLElement) => {
    const save = document.createElement('button');
    save.className = 'gv-folder-inline-btn gv-folder-inline-save';
    save.innerHTML =
      '<mat-icon class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" role="img" aria-hidden="true">check</mat-icon>';
    const cancel = document.createElement('button');
    cancel.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancel.innerHTML =
      '<mat-icon class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" role="img" aria-hidden="true">close</mat-icon>';
    container.append(save, cancel);
    return { save, cancel };
  };

  const confirmRemoval = (message: string, label: string, onConfirm: () => void) => {
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-confirm-dialog';
    const view = own(dialog);
    const text = document.createElement('div');
    text.className = 'gv-folder-confirm-message';
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'gv-folder-confirm-actions';
    const yes = document.createElement('button');
    yes.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
    yes.textContent = label;
    yes.addEventListener(
      'click',
      () => {
        view.close();
        onConfirm();
      },
      { signal: view.signal },
    );
    const no = document.createElement('button');
    no.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
    no.textContent = t('pm_cancel');
    no.addEventListener('click', view.close, { signal: view.signal });
    actions.append(yes, no);
    dialog.append(text, actions);
    document.body.appendChild(dialog);
    dismissOnOutsideClick(view);
    return dialog;
  };

  return {
    openCreate: (folderList, parentId, onSubmit) => {
      if (activeCreate && !activeCreate.view.element.isConnected) activeCreate.view.close();
      if (activeCreate) {
        activeCreate.input.focus();
        return;
      }
      if (!folderList) return;

      const container = document.createElement('div');
      container.className = 'gv-folder-inline-input';
      const view = own(container, true);
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'gv-folder-name-input';
      input.placeholder = t('folder_name_prompt');
      input.maxLength = 50;
      container.appendChild(input);
      const { save, cancel } = createInlineButtons(container);
      save.title = t('pm_save');
      cancel.title = t('pm_cancel');
      const submit = () => {
        const name = input.value.trim();
        view.close();
        if (name) onSubmit(name);
      };
      save.addEventListener('click', submit, { signal: view.signal });
      cancel.addEventListener('click', view.close, { signal: view.signal });
      input.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Enter') submit();
          else if (event.key === 'Escape') view.close();
        },
        { signal: view.signal },
      );

      const parent = parentId ? folderList.querySelector(`[data-folder-id="${parentId}"]`) : null;
      if (parent) {
        const content = parent.querySelector('.gv-folder-content');
        if (content) content.prepend(container);
        else parent.insertAdjacentElement('afterend', container);
      } else if (parentId) {
        folderList.appendChild(container);
      } else {
        folderList.prepend(container);
      }
      activeCreate = { view, input };
      input.focus();
    },

    openRename: (folderElement, currentName, onSubmit) => {
      const name = folderElement?.querySelector('.gv-folder-name');
      if (!name) return;
      const container = document.createElement('span');
      container.className = 'gv-folder-rename-inline';
      const view = own(container, true, () => {
        name.textContent = currentName;
        name.classList.remove('gv-hidden');
      });
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'gv-folder-rename-input';
      input.value = currentName;
      input.maxLength = 50;
      container.appendChild(input);
      const { save, cancel } = createInlineButtons(container);
      const submit = () => {
        const nextName = input.value.trim();
        view.close();
        if (nextName) onSubmit(nextName);
      };
      save.addEventListener('click', submit, { signal: view.signal });
      cancel.addEventListener('click', view.close, { signal: view.signal });
      input.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Enter') submit();
          else if (event.key === 'Escape') view.close();
        },
        { signal: view.signal },
      );
      name.classList.add('gv-hidden');
      name.insertAdjacentElement('afterend', container);
      input.focus();
      input.select();
    },

    openColor: (folderId, currentColor, event, onSelect, allowToggle = true) => {
      if (activeColor) {
        const sameFolder = activeColor.folderId === folderId;
        activeColor.view.close();
        if (sameFolder && allowToggle) return;
      }
      const dialog = document.createElement('div');
      dialog.className = 'gv-color-picker-dialog';
      dialog.style.position = 'fixed';
      dialog.style.left = `${event.clientX + 10}px`;
      dialog.style.top = `${event.clientY}px`;
      dialog.style.zIndex = '10001';
      const view = own(dialog);
      activeColor = { view, folderId };
      const select = (color: string) => {
        view.close();
        onSelect(color);
      };
      const dark = isDarkMode();
      for (const color of FOLDER_COLORS) {
        const button = document.createElement('button');
        button.className = 'gv-color-picker-item';
        button.title = t(color.nameKey);
        button.style.backgroundColor = getFolderColor(color.id, dark);
        if (currentColor === color.id || (!currentColor && color.id === 'default')) {
          button.classList.add('selected');
        }
        button.addEventListener('click', () => select(color.id), { signal: view.signal });
        dialog.appendChild(button);
      }

      const custom = document.createElement('button');
      custom.className = 'gv-color-picker-item gv-color-picker-custom';
      custom.title = t('folder_color_custom');
      const input = document.createElement('input');
      input.type = 'color';
      input.style.cssText =
        'position: absolute; opacity: 0; width: 100%; height: 100%; top: 0; left: 0; cursor: pointer;';
      if (currentColor?.startsWith('#')) {
        input.value = currentColor;
        custom.classList.add('selected');
        custom.style.background = currentColor;
      } else {
        custom.style.background =
          'conic-gradient(from 180deg at 50% 50%, #D9231E 0deg, #F06800 66.47deg, #E6A300 125.68deg, #2D9CDB 195.91deg, #9B51E0 262.24deg, #D9231E 360deg)';
      }
      input.addEventListener('change', () => select(input.value), { signal: view.signal });
      custom.addEventListener(
        'click',
        (click) => {
          click.stopPropagation();
          if (click.target === custom) input.click();
        },
        { signal: view.signal },
      );
      custom.appendChild(input);
      dialog.appendChild(custom);
      document.body.appendChild(dialog);
      dismissOnOutsideClick(view);
    },

    openMove: (folders, onSelect) => {
      const overlay = document.createElement('div');
      overlay.className = 'gv-folder-dialog-overlay';
      const view = own(overlay);
      const dialog = document.createElement('div');
      dialog.className = 'gv-folder-dialog';
      const title = document.createElement('div');
      title.className = 'gv-folder-dialog-title';
      title.textContent = t('conversation_move_to_folder_title');
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'gv-folder-dialog-search';
      search.placeholder = t('timelinePreviewSearch');
      search.setAttribute('aria-label', t('timelinePreviewSearch'));
      const list = document.createElement('div');
      list.className = 'gv-folder-dialog-list';
      const empty = document.createElement('div');
      empty.className = 'gv-folder-dialog-empty';
      empty.textContent = t('timelinePreviewNoResults');
      const options: { folder: Folder; level: number; path: string }[] = [];
      const collect = (
        parentId: string | null,
        level = 0,
        parentPath = '',
        ancestors = new Set<string>(),
      ) => {
        for (const folder of sortFolders(folders.filter((item) => item.parentId === parentId))) {
          if (ancestors.has(folder.id)) continue;
          const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
          options.push({ folder, level, path });
          collect(folder.id, level + 1, path, new Set([...ancestors, folder.id]));
        }
      };
      collect(null);
      const render = () => {
        list.replaceChildren();
        const query = normalizeFolderPath(search.value);
        const visible = options.filter((option) =>
          normalizeFolderPath(option.path).includes(query),
        );
        for (const { folder, level, path } of visible) {
          const item = document.createElement('button');
          item.className = 'gv-folder-dialog-item';
          // The flat picker always indents children, independent of sidebar spacing.
          item.style.paddingLeft = `${level * 16 + 12}px`;
          item.dataset.folderId = folder.id;
          item.dataset.folderPath = path;
          item.setAttribute('aria-label', path);
          const icon = document.createElement('mat-icon');
          icon.className =
            'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
          icon.setAttribute('role', 'img');
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = 'folder';
          const name = document.createElement('span');
          name.className = 'gv-folder-dialog-item-text';
          name.textContent = folder.name;
          const pathLabel = document.createElement('span');
          pathLabel.className = 'gv-folder-dialog-item-path';
          pathLabel.textContent = `/${normalizeFolderPath(path)}`;
          item.append(icon, name, pathLabel);
          item.addEventListener(
            'click',
            () => {
              view.close();
              onSelect(folder.id);
            },
            { signal: view.signal },
          );
          list.appendChild(item);
        }
        if (visible.length === 0) list.appendChild(empty);
      };
      render();
      search.addEventListener('input', render, { signal: view.signal });
      const cancel = document.createElement('button');
      cancel.className = 'gv-folder-dialog-cancel';
      cancel.textContent = t('pm_cancel');
      cancel.addEventListener('click', view.close, { signal: view.signal });
      dialog.append(title, search, list, cancel);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      overlay.addEventListener(
        'click',
        (click) => {
          if (click.target === overlay) view.close();
        },
        { signal: view.signal },
      );
    },

    openInstructions: (instructions, onSave) => {
      const maxChars = 10000;
      const overlay = document.createElement('div');
      overlay.className = 'gv-fi-overlay';
      const view = own(overlay);
      const dialog = document.createElement('div');
      dialog.className = 'gv-fi-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'gv-fi-dialog-title');
      const title = document.createElement('h2');
      title.className = 'gv-fi-title';
      title.id = 'gv-fi-dialog-title';
      title.textContent = t(
        instructions ? 'folderAsProject_editInstructions' : 'folderAsProject_setInstructions',
      );
      const input = document.createElement('textarea');
      input.className = 'gv-fi-textarea';
      input.maxLength = maxChars;
      input.rows = 7;
      input.placeholder = t('folderAsProject_setInstructions');
      input.value = instructions ?? '';
      const count = document.createElement('div');
      count.className = 'gv-fi-char-count';
      const updateCount = () => {
        count.textContent = `${input.value.length} / ${maxChars}`;
      };
      updateCount();
      input.addEventListener('input', updateCount, { signal: view.signal });
      const actions = document.createElement('div');
      actions.className = 'gv-fi-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'gv-fi-btn gv-fi-btn-cancel';
      cancel.textContent = t('pm_cancel');
      cancel.addEventListener('click', view.close, { signal: view.signal });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'gv-fi-btn gv-fi-btn-save';
      save.textContent = t('pm_save');
      save.addEventListener(
        'click',
        async () => {
          await onSave(input.value.trim() || undefined);
          view.close();
        },
        { signal: view.signal },
      );
      actions.append(cancel, save);
      dialog.append(title, input, count, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      overlay.addEventListener(
        'click',
        (click) => {
          if (click.target === overlay) view.close();
        },
        { signal: view.signal },
      );
      overlay.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape') view.close();
        },
        { signal: view.signal },
      );
      view.defer(() => input.focus(), 50);
    },

    confirmFolderRemoval: (folderElement, onConfirm) => {
      const dialog = confirmRemoval(
        t('folder_delete_confirm'),
        t('folder_remove_conversation_action'),
        onConfirm,
      );
      const header = folderElement?.querySelector('.gv-folder-item-header');
      if (header) {
        const rect = header.getBoundingClientRect();
        dialog.style.position = 'fixed';
        dialog.style.top = `${rect.bottom + 4}px`;
        dialog.style.left = `${rect.left + 24}px`;
        dialog.style.zIndex = '10002';
      } else if (folderElement) {
        const rect = folderElement.getBoundingClientRect();
        dialog.style.position = 'fixed';
        dialog.style.top = `${rect.top + 32}px`;
        dialog.style.left = `${rect.left}px`;
        dialog.style.zIndex = '10002';
      }
    },

    confirmConversationRemoval: (title, anchor, onConfirm) => {
      const dialog = confirmRemoval(
        t('folder_remove_conversation_confirm').replace('{title}', title),
        t('pm_delete'),
        onConfirm,
      );
      const rect = anchor.getBoundingClientRect();
      dialog.style.position = 'fixed';
      dialog.style.top = `${rect.bottom + 4}px`;
      dialog.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;
    },

    openMenu: (event, items, kind = 'folder') => {
      event.stopPropagation();
      if (kind === 'conversation') conversationMenu?.close();
      const menu = document.createElement('div');
      menu.className =
        kind === 'conversation' ? 'gv-folder-menu gv-folder-conversation-menu' : 'gv-folder-menu';
      menu.style.position = 'fixed';
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      const view = own(menu);
      if (kind === 'conversation') conversationMenu = view;
      for (const item of items) {
        const button = document.createElement('button');
        button.className = 'gv-folder-menu-item';
        button.textContent = item.label;
        button.addEventListener(
          'click',
          () => {
            if (kind === 'conversation') view.close();
            item.action();
            view.close();
          },
          { signal: view.signal },
        );
        menu.appendChild(button);
      }
      document.body.appendChild(menu);
      dismissOnOutsideClick(view);
    },

    closeInline: () => {
      for (const view of views) if (view.inline) view.close();
    },
    closeAll: () => {
      for (const view of views) view.close();
    },
  };
}
