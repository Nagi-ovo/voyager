import { CLOUD_SYNC_PATH, CLOUD_UPLOAD_PATH } from '@/core/icons/cloudSyncPaths';
import { isSafari } from '@/core/utils/browser';
import {
  type ConversationSortMode,
  getFolderDepth,
  sortConversationsByPriority,
  sortFolders,
} from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { FOLDER_COLORS, getFolderColor, isDarkMode } from './folderColors';
import type { ConversationReference, Folder, FolderData } from './types';

export const FLOATING_PANEL_CLASS = 'gv-floating-folder-panel';

export type FloatingPanelPos = { x: number; y: number };
export type FloatingPanelSize = { w: number; h: number };

export type MountArgs = {
  data: FolderData;
  dataReady?: boolean;
  conversationSortMode?: ConversationSortMode;
  storedPos?: FloatingPanelPos | null;
  storedSize?: FloatingPanelSize | null;
  onPosChange?: (pos: FloatingPanelPos) => void;
  onSizeChange?: (size: FloatingPanelSize) => void;
  onClose?: () => void;
  onNavigate?: (conv: ConversationReference) => void;
  onCreateFolder?: (name: string, parentId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onRemoveConversation?: (folderId: string, conversationId: string) => void;
  onToggleStar?: (folderId: string, conversationId: string) => void;
  onToggleFolderPinned?: (folderId: string) => void;
  onMoveConversation?: (conversationId: string, fromFolderId: string, toFolderId: string) => void;
  onSetFolderColor?: (folderId: string, color: string) => void;
  onCloudUpload?: () => void;
  onCloudSync?: () => void;
  getCloudUploadTooltip?: () => Promise<string>;
  getCloudSyncTooltip?: () => Promise<string>;
};

export type FloatingPanelMountArgs = MountArgs;

export type FloatingPanelHandle = {
  element: HTMLElement;
  setDataReady: (ready: boolean) => void;
  update: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  /** Replaces account data and discards transient edits without changing panel geometry. */
  reset: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  destroy: () => void;
};

const MIN_MARGIN = 8;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 420;
const MIN_PANEL_WIDTH = 280;
const MIN_PANEL_HEIGHT = 320;
const MAX_PANEL_WIDTH = 640;
const VIEWPORT_SIZE_MARGIN = 32;
const SIZE_CHANGE_DEBOUNCE_MS = 300;
const MAX_FOLDER_NAME_LENGTH = 50;
// Cap nesting at 2 total layers: root (depth 0) plus one subfolder level
// (depth 1). Deeper pre-existing data keeps rendering; only *new* creation
// beyond this is blocked. Mirrors MAX_FOLDER_DEPTH in manager.ts.
const MAX_FOLDER_DEPTH = 1;

type InlineEditorState =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'rename'; folderId: string };

type ContextMenuState =
  | { folderId: string; x: number; y: number; confirmingDelete: false }
  | { folderId: string; x: number; y: number; confirmingDelete: true };

type ConversationDragData = {
  type: 'conversation';
  conversationId: string;
  sourceFolderId: string;
};

type RenderActions = Pick<
  MountArgs,
  | 'onNavigate'
  | 'onCreateFolder'
  | 'onRenameFolder'
  | 'onDeleteFolder'
  | 'onRemoveConversation'
  | 'onToggleStar'
  | 'onToggleFolderPinned'
  | 'onMoveConversation'
  | 'onSetFolderColor'
>;

type RenderContext = {
  data: FolderData;
  conversationSortMode: ConversationSortMode;
  actions: RenderActions;
  expandedFolders: Map<string, boolean>;
  inlineEditor: InlineEditorState | null;
  contextMenu: ContextMenuState | null;
  setInlineEditor: (state: InlineEditorState | null) => void;
  setContextMenu: (state: ContextMenuState | null) => void;
  registerInlineFormCleanup: (cleanup: (() => void) | null) => void;
  render: () => void;
};

function t(key: string): string {
  return getTranslationSyncUnsafe(key);
}

function clampPos(pos: FloatingPanelPos, width: number, height: number): FloatingPanelPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(MIN_MARGIN, Math.min(pos.x, Math.max(MIN_MARGIN, vw - width - MIN_MARGIN))),
    y: Math.max(MIN_MARGIN, Math.min(pos.y, Math.max(MIN_MARGIN, vh - height - MIN_MARGIN))),
  };
}

function clampSize(size: FloatingPanelSize): FloatingPanelSize {
  const maxWidth = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(MAX_PANEL_WIDTH, window.innerWidth - VIEWPORT_SIZE_MARGIN),
  );
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - VIEWPORT_SIZE_MARGIN);

  return {
    w: Math.max(MIN_PANEL_WIDTH, Math.min(size.w, maxWidth)),
    h: Math.max(MIN_PANEL_HEIGHT, Math.min(size.h, maxHeight)),
  };
}

function getPanelSize(panel: HTMLElement): FloatingPanelSize {
  const rect = panel.getBoundingClientRect();
  return clampSize({
    w: Math.round(rect.width || panel.offsetWidth || DEFAULT_WIDTH),
    h: Math.round(rect.height || panel.offsetHeight || DEFAULT_HEIGHT),
  });
}

function isSameSize(a: FloatingPanelSize, b: FloatingPanelSize): boolean {
  return a.w === b.w && a.h === b.h;
}

function defaultPos(size: FloatingPanelSize): FloatingPanelPos {
  return {
    x: Math.max(MIN_MARGIN, window.innerWidth - size.w - 24),
    y: Math.max(MIN_MARGIN, window.innerHeight - size.h - 24),
  };
}

function getFolderChildren(data: FolderData, parentId: string | null): Folder[] {
  return sortFolders(data.folders.filter((folder) => folder.parentId === parentId));
}

function canCreateChildAtDepth(depth: number): boolean {
  return depth < MAX_FOLDER_DEPTH;
}

function readConversationDragData(e: DragEvent): ConversationDragData | null {
  const raw = e.dataTransfer?.getData('application/json');
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.type === 'conversation' &&
      typeof candidate.conversationId === 'string' &&
      typeof candidate.sourceFolderId === 'string'
    ) {
      return {
        type: 'conversation',
        conversationId: candidate.conversationId,
        sourceFolderId: candidate.sourceFolderId,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function createIconButton(
  modifier: string,
  labelKey: string,
  text: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${FLOATING_PANEL_CLASS}__icon-button ${FLOATING_PANEL_CLASS}__icon-button--${modifier}`;
  button.setAttribute('aria-label', t(labelKey));
  button.title = t(labelKey);
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function createSvgIconButton(
  modifier: string,
  labelKey: string,
  pathData: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const button = createIconButton(modifier, labelKey, '', onClick);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('height', '20px');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('width', '20px');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

function updateTooltipOnHover(
  button: HTMLButtonElement,
  getTooltip: (() => Promise<string>) | undefined,
): void {
  if (!getTooltip) return;

  button.addEventListener('mouseenter', () => {
    void getTooltip()
      .then((tooltip) => {
        button.title = tooltip;
      })
      .catch(() => {});
  });
}

function createEmptyFolderIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add(`${FLOATING_PANEL_CLASS}__empty-icon`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M4.75 6.5c0-.69.56-1.25 1.25-1.25h4.16c.36 0 .69.15.93.41l1.12 1.23c.14.15.34.24.55.24H18c.69 0 1.25.56 1.25 1.25v1.12H4.75v-3Zm0 4.25h14.5v6.75c0 .69-.56 1.25-1.25 1.25H6c-.69 0-1.25-.56-1.25-1.25v-6.75Z',
  );
  svg.appendChild(path);
  return svg;
}

function createHintRow(key: string, iconText: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `${FLOATING_PANEL_CLASS}__move-hint`;

  const icon = document.createElement('span');
  icon.className = `${FLOATING_PANEL_CLASS}__move-hint-icon`;
  icon.textContent = iconText;
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = `${FLOATING_PANEL_CLASS}__move-hint-text`;
  text.textContent = t(key);

  row.appendChild(icon);
  row.appendChild(text);
  return row;
}

function createHintStack(): HTMLElement {
  const stack = document.createElement('div');
  stack.className = `${FLOATING_PANEL_CLASS}__hint-stack`;
  stack.appendChild(createHintRow('floatingPanelMoveHint', 'i'));
  stack.appendChild(createHintRow('floatingPanelGestureHint', '?'));
  return stack;
}

function createInlineForm(
  initialValue: string,
  placeholderKey: string,
  onSubmit: (value: string) => void,
  onCancel: () => void,
  registerCleanup: (cleanup: (() => void) | null) => void,
): HTMLElement {
  const form = document.createElement('div');
  form.className = `${FLOATING_PANEL_CLASS}__inline-form`;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    document.removeEventListener('mousedown', onOutsideMouseDown, true);
    registerCleanup(null);
  };

  const submit = () => {
    cleanup();
    onSubmit(input.value.trim());
  };

  const cancel = () => {
    cleanup();
    onCancel();
  };

  const isInsideContextMenu = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    const element = target instanceof Element ? target : target.parentElement;
    return !!element?.closest(`.${FLOATING_PANEL_CLASS}__context-menu`);
  };

  function onOutsideMouseDown(e: MouseEvent): void {
    if (form.contains(e.target as Node)) return;
    if (isInsideContextMenu(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    cancel();
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = `${FLOATING_PANEL_CLASS}__inline-input`;
  input.placeholder = t(placeholderKey);
  input.value = initialValue;
  input.maxLength = MAX_FOLDER_NAME_LENGTH;

  const saveBtn = createIconButton('save', 'floatingPanelSave', '✓', (e) => {
    e.stopPropagation();
    submit();
  });

  const cancelBtn = createIconButton('cancel', 'floatingPanelCancel', '×', (e) => {
    e.stopPropagation();
    cancel();
  });

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  form.appendChild(input);
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  document.addEventListener('mousedown', onOutsideMouseDown, true);
  registerCleanup(cleanup);

  const focusInput = () => {
    input.focus();
    input.select();
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(focusInput);
  } else {
    focusInput();
  }

  return form;
}

function renderFolderTree(container: HTMLElement, context: RenderContext): void {
  container.textContent = '';

  if (context.inlineEditor?.mode === 'create' && context.inlineEditor.parentId === null) {
    container.appendChild(
      createCreateFolderForm(context, null, `${FLOATING_PANEL_CLASS}__inline-form--root`),
    );
  }

  if (context.data.folders.length === 0 && context.inlineEditor?.mode !== 'create') {
    const empty = document.createElement('div');
    empty.className = `${FLOATING_PANEL_CLASS}__empty`;
    const label = document.createElement('div');
    label.className = `${FLOATING_PANEL_CLASS}__empty-label`;
    label.textContent = t('floatingPanelEmpty');
    empty.appendChild(createEmptyFolderIcon());
    empty.appendChild(label);
    container.appendChild(empty);
    return;
  }

  for (const folder of getFolderChildren(context.data, null)) {
    container.appendChild(renderFolderNode(folder, context, 0));
  }

  renderContextMenu(container, context);
}

function createCreateFolderForm(
  context: RenderContext,
  parentId: string | null,
  extraClass?: string,
): HTMLElement {
  const parentDepth = parentId ? getFolderDepth(context.data, parentId) : -1;
  const form = createInlineForm(
    '',
    'floatingPanelFolderNamePlaceholder',
    (name) => {
      context.setInlineEditor(null);
      if (name && canCreateChildAtDepth(parentDepth)) {
        context.actions.onCreateFolder?.(name, parentId);
      }
      context.render();
    },
    () => {
      context.setInlineEditor(null);
      context.render();
    },
    context.registerInlineFormCleanup,
  );

  if (extraClass) form.classList.add(extraClass);
  return form;
}

function createRenameFolderForm(context: RenderContext, folder: Folder): HTMLElement {
  return createInlineForm(
    folder.name,
    'floatingPanelFolderNamePlaceholder',
    (newName) => {
      context.setInlineEditor(null);
      if (newName && newName !== folder.name) {
        context.actions.onRenameFolder?.(folder.id, newName);
      }
      context.render();
    },
    () => {
      context.setInlineEditor(null);
      context.render();
    },
    context.registerInlineFormCleanup,
  );
}

function renderFolderNode(folder: Folder, context: RenderContext, depth: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${FLOATING_PANEL_CLASS}__folder`;
  wrap.dataset.depth = String(depth);
  // Depth exposed as a custom property so the body's ::before tree-guide line
  // can position itself under this folder's caret, one level at a time.
  wrap.style.setProperty('--gv-folder-depth', String(depth));

  const header = document.createElement('div');
  header.className = `${FLOATING_PANEL_CLASS}__folder-header`;
  header.style.paddingInlineStart = `${8 + depth * 12}px`;
  header.dataset.folderId = folder.id;

  const isExpanded = context.expandedFolders.get(folder.id) ?? folder.isExpanded;
  context.expandedFolders.set(folder.id, isExpanded);

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = `${FLOATING_PANEL_CLASS}__caret`;
  caret.setAttribute(
    'aria-label',
    t(isExpanded ? 'floatingPanelCollapseFolder' : 'floatingPanelExpandFolder'),
  );
  caret.textContent = isExpanded ? '▾' : '▸';

  const colorDot = document.createElement('span');
  colorDot.className = `${FLOATING_PANEL_CLASS}__folder-color`;
  colorDot.style.backgroundColor = getFolderColor(folder.color, isDarkMode());

  const nameWrap = document.createElement('span');
  nameWrap.className = `${FLOATING_PANEL_CLASS}__folder-name-wrap`;

  if (context.inlineEditor?.mode === 'rename' && context.inlineEditor.folderId === folder.id) {
    nameWrap.appendChild(createRenameFolderForm(context, folder));
  } else {
    const name = document.createElement('span');
    name.className = `${FLOATING_PANEL_CLASS}__folder-name`;
    name.textContent = folder.name;
    name.title = folder.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      context.setInlineEditor({ mode: 'rename', folderId: folder.id });
      context.setContextMenu(null);
      context.render();
    });
    nameWrap.appendChild(name);
  }

  const childConversations = context.data.folderContents[folder.id] ?? [];
  const childFolders = getFolderChildren(context.data, folder.id);
  const count = childConversations.length + childFolders.length;

  const countBadge = document.createElement('span');
  countBadge.className = `${FLOATING_PANEL_CLASS}__count`;
  countBadge.textContent = String(count);

  const pinned = document.createElement('span');
  pinned.className = `${FLOATING_PANEL_CLASS}__pin`;
  pinned.textContent = folder.pinned ? '●' : '';
  pinned.setAttribute('aria-hidden', 'true');

  // Always occupy the trailing "+ add subfolder" slot so rows at different
  // depths line up — at MAX_FOLDER_DEPTH we can't create a subfolder, but
  // reserving the same footprint keeps the count badge at a consistent
  // position between root and sub rows. An invisible placeholder does it.
  const addChildSlot: HTMLElement = canCreateChildAtDepth(depth)
    ? createIconButton('add-child', 'floatingPanelCreateSubfolder', '+', (e) => {
        e.stopPropagation();
        context.expandedFolders.set(folder.id, true);
        context.setInlineEditor({ mode: 'create', parentId: folder.id });
        context.setContextMenu(null);
        context.render();
      })
    : (() => {
        const placeholder = document.createElement('span');
        placeholder.className = `${FLOATING_PANEL_CLASS}__icon-button ${FLOATING_PANEL_CLASS}__icon-button--placeholder`;
        placeholder.setAttribute('aria-hidden', 'true');
        return placeholder;
      })();

  header.appendChild(caret);
  header.appendChild(colorDot);
  header.appendChild(nameWrap);
  header.appendChild(pinned);
  header.appendChild(countBadge);
  header.appendChild(addChildSlot);
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = `${FLOATING_PANEL_CLASS}__folder-body`;
  if (!isExpanded) body.style.display = 'none';

  if (context.inlineEditor?.mode === 'create' && context.inlineEditor.parentId === folder.id) {
    const form = createCreateFolderForm(context, folder.id);
    form.style.paddingInlineStart = `${32 + depth * 12}px`;
    body.appendChild(form);
  }

  for (const child of childFolders) {
    body.appendChild(renderFolderNode(child, context, depth + 1));
  }

  for (const conv of sortConversationsByPriority(
    childConversations,
    context.conversationSortMode,
  )) {
    body.appendChild(renderConversationRow(conv, folder.id, depth, context));
  }

  wrap.appendChild(body);

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    context.expandedFolders.set(folder.id, !isExpanded);
    context.render();
  });

  header.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest(`.${FLOATING_PANEL_CLASS}__inline-form`)) return;
    if ((e.target as HTMLElement).closest(`.${FLOATING_PANEL_CLASS}__icon-button`)) return;
    if ((e.target as HTMLElement).closest(`.${FLOATING_PANEL_CLASS}__caret`)) return;
    e.stopPropagation();
    context.expandedFolders.set(folder.id, !isExpanded);
    context.render();
  });

  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    context.setInlineEditor(null);
    context.setContextMenu({
      folderId: folder.id,
      x: e.clientX,
      y: e.clientY,
      confirmingDelete: false,
    });
    context.render();
  });

  // HTML5 quirk: `dataTransfer.getData(...)` returns "" during dragover for
  // security, so we can't read the payload here — we can only inspect the
  // MIME-type list via `dataTransfer.types`. If our payload type is present
  // we accept the drop *visually*, and the drop handler re-reads and validates
  // the full payload (including rejecting same-folder drops).
  header.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes('application/json')) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    header.classList.add(`${FLOATING_PANEL_CLASS}__drop-target`);
  });

  header.addEventListener('dragleave', () => {
    header.classList.remove(`${FLOATING_PANEL_CLASS}__drop-target`);
  });

  header.addEventListener('drop', (e) => {
    header.classList.remove(`${FLOATING_PANEL_CLASS}__drop-target`);
    const payload = readConversationDragData(e);
    if (!payload || payload.sourceFolderId === folder.id) return;

    e.preventDefault();
    e.stopPropagation();
    context.actions.onMoveConversation?.(payload.conversationId, payload.sourceFolderId, folder.id);
  });

  return wrap;
}

function renderConversationRow(
  conv: ConversationReference,
  folderId: string,
  depth: number,
  context: RenderContext,
): HTMLElement {
  const row = document.createElement('div');
  row.className = `${FLOATING_PANEL_CLASS}__conv`;
  row.style.paddingInlineStart = `${24 + depth * 12}px`;
  row.dataset.folderId = folderId;
  row.dataset.conversationId = conv.conversationId;
  row.draggable = true;

  const title = document.createElement('button');
  title.type = 'button';
  title.className = `${FLOATING_PANEL_CLASS}__conv-title`;
  title.textContent = conv.title || t('floatingPanelUntitled');
  title.title = conv.title || '';
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    context.actions.onNavigate?.(conv);
  });

  const starBtn = createIconButton(
    'star',
    conv.starred ? 'floatingPanelUnstarConversation' : 'floatingPanelStarConversation',
    conv.starred ? '★' : '☆',
    (e) => {
      e.stopPropagation();
      context.actions.onToggleStar?.(folderId, conv.conversationId);
    },
  );
  if (conv.starred) starBtn.classList.add(`${FLOATING_PANEL_CLASS}__icon-button--active`);

  const removeBtn = createIconButton('remove', 'floatingPanelRemoveConversation', '×', (e) => {
    e.stopPropagation();
    context.actions.onRemoveConversation?.(folderId, conv.conversationId);
  });

  row.appendChild(title);
  row.appendChild(starBtn);
  row.appendChild(removeBtn);

  row.addEventListener('dragstart', (e) => {
    const payload: ConversationDragData = {
      type: 'conversation',
      conversationId: conv.conversationId,
      sourceFolderId: folderId,
    };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', conv.title || t('floatingPanelUntitled'));
    }
    row.classList.add(`${FLOATING_PANEL_CLASS}__conv--dragging`);
  });

  row.addEventListener('dragend', () => {
    row.classList.remove(`${FLOATING_PANEL_CLASS}__conv--dragging`);
  });

  return row;
}

function createMenuButton(labelKey: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${FLOATING_PANEL_CLASS}__menu-item`;
  button.textContent = t(labelKey);
  button.addEventListener('click', onClick);
  return button;
}

function renderContextMenu(container: HTMLElement, context: RenderContext): void {
  if (!context.contextMenu) return;

  const folder = context.data.folders.find(
    (candidate) => candidate.id === context.contextMenu?.folderId,
  );
  if (!folder) return;

  const menu = document.createElement('div');
  menu.className = `${FLOATING_PANEL_CLASS}__context-menu`;
  menu.style.left = `${context.contextMenu.x}px`;
  menu.style.top = `${context.contextMenu.y}px`;
  menu.setAttribute('role', 'menu');

  if (context.contextMenu.confirmingDelete) {
    menu.classList.add(`${FLOATING_PANEL_CLASS}__context-menu--confirming`);

    const confirm = document.createElement('div');
    confirm.className = `${FLOATING_PANEL_CLASS}__confirm-inline`;

    const actions = document.createElement('div');
    actions.className = `${FLOATING_PANEL_CLASS}__confirm-actions`;

    const deleteBtn = createMenuButton('floatingPanelDeleteFolder', (e) => {
      e.stopPropagation();
      context.setContextMenu(null);
      context.actions.onDeleteFolder?.(folder.id);
      context.render();
    });
    deleteBtn.classList.add(`${FLOATING_PANEL_CLASS}__menu-item--danger`);
    deleteBtn.classList.add(`${FLOATING_PANEL_CLASS}__confirm-button`);

    const cancelBtn = createMenuButton('floatingPanelCancel', (e) => {
      e.stopPropagation();
      context.setContextMenu(null);
      context.render();
    });
    cancelBtn.classList.add(`${FLOATING_PANEL_CLASS}__confirm-button`);

    actions.appendChild(deleteBtn);
    actions.appendChild(cancelBtn);
    confirm.appendChild(actions);
    menu.appendChild(confirm);
    container.appendChild(menu);
    return;
  }

  const menuFolderDepth = getFolderDepth(context.data, folder.id);

  menu.appendChild(
    createMenuButton(folder.pinned ? 'floatingPanelUnpinFolder' : 'floatingPanelPinFolder', (e) => {
      e.stopPropagation();
      context.setContextMenu(null);
      context.actions.onToggleFolderPinned?.(folder.id);
      context.render();
    }),
  );

  if (canCreateChildAtDepth(menuFolderDepth)) {
    menu.appendChild(
      createMenuButton('floatingPanelCreateSubfolder', (e) => {
        e.stopPropagation();
        context.expandedFolders.set(folder.id, true);
        context.setContextMenu(null);
        context.setInlineEditor({ mode: 'create', parentId: folder.id });
        context.render();
      }),
    );
  }

  menu.appendChild(
    createMenuButton('floatingPanelRenameFolder', (e) => {
      e.stopPropagation();
      context.setContextMenu(null);
      context.setInlineEditor({ mode: 'rename', folderId: folder.id });
      context.render();
    }),
  );

  const colorSection = document.createElement('div');
  colorSection.className = `${FLOATING_PANEL_CLASS}__color-section`;

  const colorTitle = document.createElement('div');
  colorTitle.className = `${FLOATING_PANEL_CLASS}__color-title`;
  colorTitle.textContent = t('floatingPanelColor');

  const swatches = document.createElement('div');
  swatches.className = `${FLOATING_PANEL_CLASS}__color-swatches`;

  for (const color of FOLDER_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `${FLOATING_PANEL_CLASS}__color-swatch`;
    if ((folder.color ?? 'default') === color.id) {
      swatch.classList.add(`${FLOATING_PANEL_CLASS}__color-swatch--active`);
    }
    swatch.style.backgroundColor = getFolderColor(color.id, isDarkMode());
    swatch.setAttribute('aria-label', t(color.nameKey));
    swatch.title = t(color.nameKey);
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      context.setContextMenu(null);
      context.actions.onSetFolderColor?.(folder.id, color.id);
      context.render();
    });
    swatches.appendChild(swatch);
  }

  colorSection.appendChild(colorTitle);
  colorSection.appendChild(swatches);
  menu.appendChild(colorSection);

  const divider = document.createElement('div');
  divider.className = `${FLOATING_PANEL_CLASS}__menu-divider`;
  menu.appendChild(divider);

  const deleteBtn = createMenuButton('floatingPanelDeleteFolder', (e) => {
    e.stopPropagation();
    context.setContextMenu({
      folderId: folder.id,
      x: context.contextMenu?.x ?? 0,
      y: context.contextMenu?.y ?? 0,
      confirmingDelete: true,
    });
    context.render();
  });
  deleteBtn.classList.add(`${FLOATING_PANEL_CLASS}__menu-item--danger`);
  menu.appendChild(deleteBtn);

  container.appendChild(menu);
}

export function mountFloatingPanel({
  data,
  dataReady = true,
  conversationSortMode = 'manual',
  storedPos,
  storedSize,
  onPosChange,
  onSizeChange,
  onClose,
  onNavigate,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRemoveConversation,
  onToggleStar,
  onToggleFolderPinned,
  onMoveConversation,
  onSetFolderColor,
  onCloudUpload,
  onCloudSync,
  getCloudUploadTooltip,
  getCloudSyncTooltip,
}: MountArgs): FloatingPanelHandle {
  const existing = document.querySelector(`.${FLOATING_PANEL_CLASS}`);
  if (existing) existing.remove();

  let currentData = data;
  let currentConversationSortMode = conversationSortMode;

  const panel = document.createElement('div');
  panel.className = FLOATING_PANEL_CLASS;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('floatingPanelTitle'));

  const header = document.createElement('div');
  header.className = `${FLOATING_PANEL_CLASS}__header`;

  const title = document.createElement('div');
  title.className = `${FLOATING_PANEL_CLASS}__title`;
  title.textContent = t('floatingPanelTitle');

  const headerActions = document.createElement('div');
  headerActions.className = `${FLOATING_PANEL_CLASS}__header-actions`;

  if (!isSafari()) {
    const cloudUploadBtn = createSvgIconButton(
      'cloud-upload',
      'floatingPanelCloudUpload',
      CLOUD_UPLOAD_PATH,
      (e) => {
        e.stopPropagation();
        onCloudUpload?.();
      },
    );
    updateTooltipOnHover(cloudUploadBtn, getCloudUploadTooltip);

    const cloudSyncBtn = createSvgIconButton(
      'cloud-sync',
      'floatingPanelCloudSync',
      CLOUD_SYNC_PATH,
      (e) => {
        e.stopPropagation();
        onCloudSync?.();
      },
    );
    updateTooltipOnHover(cloudSyncBtn, getCloudSyncTooltip);

    headerActions.appendChild(cloudUploadBtn);
    headerActions.appendChild(cloudSyncBtn);
  }

  const createBtn = createIconButton('create', 'floatingPanelCreateFolder', '+', (e) => {
    e.stopPropagation();
    setInlineEditor({ mode: 'create', parentId: null });
    setContextMenu(null);
    render();
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = `${FLOATING_PANEL_CLASS}__close`;
  closeBtn.setAttribute('aria-label', t('floatingPanelClose'));
  closeBtn.textContent = '×';

  header.appendChild(title);
  headerActions.appendChild(createBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);

  const body = document.createElement('div');
  body.className = `${FLOATING_PANEL_CLASS}__body`;

  const setDataReady = (ready: boolean): void => {
    body.inert = !ready;
    body.setAttribute('aria-busy', String(!ready));
    headerActions
      .querySelectorAll<HTMLButtonElement>(`.${FLOATING_PANEL_CLASS}__icon-button`)
      .forEach((button) => {
        button.disabled = !ready;
      });
  };
  setDataReady(dataReady);

  panel.appendChild(header);
  panel.appendChild(createHintStack());
  panel.appendChild(body);

  const initialSize = clampSize(storedSize ?? { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const initialPos = clampPos(storedPos ?? defaultPos(initialSize), initialSize.w, initialSize.h);
  panel.style.left = `${initialPos.x}px`;
  panel.style.top = `${initialPos.y}px`;
  panel.style.width = `${initialSize.w}px`;
  panel.style.height = `${initialSize.h}px`;

  // Drag support — header is the grabbable handle. Panel dimensions are read
  // once at drag start and reused on every move: interleaving offsetWidth/
  // offsetHeight reads with style writes inside pointermove forces a layout
  // pass per event (the panel doesn't resize mid-drag anyway).
  let dragState: { offsetX: number; offsetY: number; width: number; height: number } | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // primary button only — no right/middle drags
    const target = e.target as HTMLElement;
    if (target.closest(`.${FLOATING_PANEL_CLASS}__close`)) return;
    if (target.closest(`.${FLOATING_PANEL_CLASS}__icon-button`)) return;
    const rect = panel.getBoundingClientRect();
    dragState = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width || panel.offsetWidth,
      height: rect.height || panel.offsetHeight,
    };
    header.setPointerCapture(e.pointerId);
    header.classList.add(`${FLOATING_PANEL_CLASS}__header--dragging`);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragState) return;
    const next = clampPos(
      { x: e.clientX - dragState.offsetX, y: e.clientY - dragState.offsetY },
      dragState.width,
      dragState.height,
    );
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragState) return;
    dragState = null;
    try {
      header.releasePointerCapture(e.pointerId);
    } catch {}
    header.classList.remove(`${FLOATING_PANEL_CLASS}__header--dragging`);
    onPosChange?.({ x: panel.offsetLeft, y: panel.offsetTop });
  };

  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);
  header.addEventListener('pointercancel', onPointerUp);

  let lastCommittedSize = initialSize;
  let sizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const commitObservedSize = (size: FloatingPanelSize) => {
    if (isSameSize(size, lastCommittedSize)) return;
    lastCommittedSize = size;
    onSizeChange?.(size);
  };

  const scheduleSizeCommit = (size: FloatingPanelSize) => {
    if (isSameSize(size, lastCommittedSize)) return;
    if (sizeDebounceTimer) clearTimeout(sizeDebounceTimer);
    sizeDebounceTimer = setTimeout(() => {
      sizeDebounceTimer = null;
      commitObservedSize(getPanelSize(panel));
    }, SIZE_CHANGE_DEBOUNCE_MS);
  };

  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const nextSize = getPanelSize(panel);
          const nextPos = clampPos(
            { x: panel.offsetLeft, y: panel.offsetTop },
            nextSize.w,
            nextSize.h,
          );
          panel.style.left = `${nextPos.x}px`;
          panel.style.top = `${nextPos.y}px`;
          scheduleSizeCommit(nextSize);
        })
      : null;
  resizeObserver?.observe(panel);

  let inlineEditor: InlineEditorState | null = null;
  let contextMenu: ContextMenuState | null = null;
  let inlineFormCleanup: (() => void) | null = null;
  const expandedFolders = new Map<string, boolean>();
  for (const folder of data.folders) {
    expandedFolders.set(folder.id, folder.isExpanded);
  }

  const setInlineEditor = (state: InlineEditorState | null) => {
    inlineEditor = state;
  };

  const setContextMenu = (state: ContextMenuState | null) => {
    contextMenu = state;
  };

  const registerInlineFormCleanup = (cleanup: (() => void) | null) => {
    inlineFormCleanup = cleanup;
  };

  const render = () => {
    inlineFormCleanup?.();
    inlineFormCleanup = null;

    for (const folder of currentData.folders) {
      if (!expandedFolders.has(folder.id)) {
        expandedFolders.set(folder.id, folder.isExpanded);
      }
    }

    renderFolderTree(body, {
      data: currentData,
      conversationSortMode: currentConversationSortMode,
      actions: {
        onNavigate,
        onCreateFolder,
        onRenameFolder,
        onDeleteFolder,
        onRemoveConversation,
        onToggleStar,
        onToggleFolderPinned,
        onMoveConversation,
        onSetFolderColor,
      },
      expandedFolders,
      inlineEditor,
      contextMenu,
      setInlineEditor,
      setContextMenu,
      registerInlineFormCleanup,
      render,
    });
  };
  render();

  const onResize = () => {
    const clamped = clampPos(
      { x: panel.offsetLeft, y: panel.offsetTop },
      panel.offsetWidth,
      panel.offsetHeight,
    );
    panel.style.left = `${clamped.x}px`;
    panel.style.top = `${clamped.y}px`;
  };
  window.addEventListener('resize', onResize);

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    destroy();
    onClose?.();
  });

  const onDocumentClick = (e: MouseEvent) => {
    if (contextMenu && !panel.contains(e.target as Node)) {
      setContextMenu(null);
      render();
    }
  };
  document.addEventListener('click', onDocumentClick);

  const destroy = () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('click', onDocumentClick);
    resizeObserver?.disconnect();
    if (sizeDebounceTimer) {
      clearTimeout(sizeDebounceTimer);
      sizeDebounceTimer = null;
    }
    inlineFormCleanup?.();
    inlineFormCleanup = null;
    panel.remove();
  };

  document.body.appendChild(panel);

  // Is the user currently typing into an inline create/rename input?
  const isInlineFormInputFocused = () => {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      panel.contains(active) &&
      active.classList.contains(`${FLOATING_PANEL_CLASS}__inline-input`)
    );
  };

  return {
    element: panel,
    setDataReady,
    reset: (next, nextConversationSortMode) => {
      currentData = next;
      if (nextConversationSortMode) currentConversationSortMode = nextConversationSortMode;
      inlineEditor = null;
      contextMenu = null;
      expandedFolders.clear();
      render();
    },
    update: (next, nextConversationSortMode) => {
      currentData = next;
      if (nextConversationSortMode) currentConversationSortMode = nextConversationSortMode;
      const nextIds = new Set(next.folders.map((folder) => folder.id));
      for (const folderId of expandedFolders.keys()) {
        if (!nextIds.has(folderId)) expandedFolders.delete(folderId);
      }
      if (inlineEditor?.mode === 'rename') {
        const editingFolderId = inlineEditor.folderId;
        if (!next.folders.some((folder) => folder.id === editingFolderId)) {
          inlineEditor = null;
        }
      }
      if (contextMenu && !next.folders.some((folder) => folder.id === contextMenu?.folderId)) {
        contextMenu = null;
      }
      // A background update (storage sync, another tab) must not rebuild the
      // tree while the user is typing in an inline form — the rebuild would
      // recreate the form empty, losing their input. `currentData` is already
      // updated above, and every form close path (submit / cancel / outside
      // mousedown) calls render(), which then picks up the deferred data.
      // If the edited folder was deleted remotely, inlineEditor is nulled
      // above and we fall through to render immediately.
      if (inlineEditor && isInlineFormInputFocused()) return;
      render();
    },
    destroy,
  };
}
