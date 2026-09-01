import {
  createMenuItemFromNativeTemplate,
  updateMenuItemTemplateLabel,
} from '../shared/nativeMenuItemTemplate';

export type ConversationMenuExportOptions = {
  label: string;
  tooltip: string;
  onClick: () => void;
};

export type ConversationMenuType = 'top' | 'sidebar';

export type ConversationMenuContext = {
  menuType: ConversationMenuType;
  trigger: HTMLElement | null;
};

export type ResponseMenuContext = {
  trigger: HTMLElement | null;
};

const MENU_BUTTON_CLASS = 'gv-export-conversation-menu-btn';
const RESPONSE_MENU_BUTTON_CLASS = 'gv-export-response-menu-btn';
const MOVE_TO_FOLDER_BUTTON_CLASS = 'gv-move-to-folder-btn';
// gem-menu is Gemini's "lr26" replacement for mat-mdc-menu-panel.
export const MENU_PANEL_SELECTOR = '.mat-mdc-menu-panel[role="menu"], gem-menu';
const SIDEBAR_CONTAINER_SELECTOR =
  '[data-test-id="overflow-container"], [data-test-id="all-conversations"]';
const EXPANDED_MENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"][aria-expanded="true"]';
const RESPONSE_MORE_MENU_TRIGGER_TEST_ID = 'more-menu-button';
const CONVERSATION_MENU_TRIGGER_TEST_IDS = new Set([
  'actions-menu-button',
  'conversation-actions-menu-icon-button',
]);
const MENU_ITEM_SELECTOR = 'button.mat-mdc-menu-item, gem-menu-item';

function isGemMenu(menuPanel: HTMLElement): boolean {
  return menuPanel.tagName.toLowerCase() === 'gem-menu';
}

export function findMenuContent(menuPanel: HTMLElement): HTMLElement | null {
  if (isGemMenu(menuPanel)) return menuPanel;
  return menuPanel.querySelector('.mat-mdc-menu-content') as HTMLElement | null;
}

function parseControlledIds(trigger: HTMLElement): string[] {
  const raw = `${trigger.getAttribute('aria-controls') || ''} ${
    trigger.getAttribute('aria-owns') || ''
  }`;
  return raw
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolveExpandedMenuTrigger(menuPanel: HTMLElement): HTMLElement | null {
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>(EXPANDED_MENU_TRIGGER_SELECTOR),
  );
  if (triggers.length === 0) return null;

  const panelId = menuPanel.id;
  if (panelId) {
    const matched = triggers.find((trigger) => parseControlledIds(trigger).includes(panelId));
    if (matched) return matched;
  }

  return triggers[triggers.length - 1] || null;
}

function isSidebarConversationTrigger(trigger: HTMLElement): boolean {
  return !!trigger.closest(SIDEBAR_CONTAINER_SELECTOR);
}

function hasDeepResearchReportMarkers(menuContent: HTMLElement): boolean {
  return Boolean(
    menuContent.querySelector('[data-test-id="share-button-tooltip-container"]') ||
    menuContent.querySelector('[data-test-id="export-to-docs-button"]') ||
    menuContent.querySelector('[data-test-id="copy-button"]'),
  );
}

function updateButtonLabelAndTooltip(button: HTMLElement, label: string, tooltip: string): void {
  updateMenuItemTemplateLabel(button, label, tooltip);
}

function findMenuButtonByIcon(menuContent: HTMLElement, iconName: string): HTMLElement | null {
  const items = Array.from(menuContent.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
  return (
    items.find((item) => {
      const icon = item.querySelector('mat-icon');
      if (!icon) return false;
      const fontIcon = icon.getAttribute('fonticon') || icon.getAttribute('data-mat-icon-name');
      if (fontIcon === iconName) return true;
      return icon.textContent?.trim() === iconName;
    }) ?? null
  );
}

function closeMenuOverlay(menuPanel: HTMLElement): void {
  const backdrops = document.querySelectorAll<HTMLElement>('.cdk-overlay-backdrop');
  const backdrop = backdrops.length > 0 ? backdrops[backdrops.length - 1] : null;
  if (backdrop) {
    backdrop.click();
    return;
  }

  try {
    menuPanel.remove();
  } catch {}
}

function createMenuItemButton({
  label,
  tooltip,
  onClick,
  menuContent,
  menuPanel,
  injectedClassName,
  iconName,
  excludedClassNames = [],
}: ConversationMenuExportOptions & {
  menuContent: HTMLElement;
  menuPanel: HTMLElement;
  injectedClassName: string;
  iconName: string;
  excludedClassNames?: string[];
}): HTMLElement | null {
  const button = createMenuItemFromNativeTemplate({
    menuContent,
    injectedClassName,
    iconName,
    label,
    tooltip,
    excludedClassNames,
  });
  if (!button) return null;

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
    closeMenuOverlay(menuPanel);
  });

  return button;
}

export function isConversationMenuPanel(menuPanel: HTMLElement): boolean {
  if (!menuPanel.matches(MENU_PANEL_SELECTOR)) return false;
  if (menuPanel.classList.contains('gds-mode-switch-menu')) return false;
  if (menuPanel.querySelector('.bard-mode-list-button')) return false;

  const menuContent = findMenuContent(menuPanel);
  if (!menuContent) return false;
  const hasConversationActions = Boolean(
    menuContent.querySelector('[data-test-id="pin-button"]') ||
    menuContent.querySelector('[data-test-id="rename-button"]') ||
    menuContent.querySelector('[data-test-id="delete-button"]'),
  );
  if (hasConversationActions) return true;

  // Current top conversation menus can also contain Export to Docs. Strong
  // conversation-only actions win before the report-menu exclusion so those
  // menus remain identifiable when Gemini combines both action sets.
  if (hasDeepResearchReportMarkers(menuContent)) return false;

  const hasShareButton = Boolean(menuContent.querySelector('[data-test-id="share-button"]'));
  if (!hasShareButton) return false;

  const trigger = resolveExpandedMenuTrigger(menuPanel);
  const triggerTestId = trigger?.getAttribute('data-test-id') || '';
  return CONVERSATION_MENU_TRIGGER_TEST_IDS.has(triggerTestId);
}

export function getConversationMenuContext(menuPanel: HTMLElement): ConversationMenuContext | null {
  if (!isConversationMenuPanel(menuPanel)) return null;
  const trigger = resolveExpandedMenuTrigger(menuPanel);
  return {
    menuType: trigger && isSidebarConversationTrigger(trigger) ? 'sidebar' : 'top',
    trigger,
  };
}

function isResponseMenuTrigger(trigger: HTMLElement | null): boolean {
  return trigger?.getAttribute('data-test-id') === RESPONSE_MORE_MENU_TRIGGER_TEST_ID;
}

export function isResponseMenuPanel(menuPanel: HTMLElement): boolean {
  if (!menuPanel.matches(MENU_PANEL_SELECTOR)) return false;
  if (menuPanel.classList.contains('gds-mode-switch-menu')) return false;

  const menuContent = findMenuContent(menuPanel);
  if (!menuContent) return false;
  if (hasDeepResearchReportMarkers(menuContent)) return false;

  const trigger = resolveExpandedMenuTrigger(menuPanel);
  if (isResponseMenuTrigger(trigger)) return true;

  // Fallback for cases where panel/trigger linkage is not exposed during async menu rendering.
  const hasDocsAction = !!findMenuButtonByIcon(menuContent, 'docs');
  const hasGmailAction = !!findMenuButtonByIcon(menuContent, 'gmail');
  const hasLegalReportAction = !!findMenuButtonByIcon(menuContent, 'flag');
  return hasDocsAction && (hasGmailAction || hasLegalReportAction);
}

export function getResponseMenuContext(menuPanel: HTMLElement): ResponseMenuContext | null {
  if (!isResponseMenuPanel(menuPanel)) return null;
  return { trigger: resolveExpandedMenuTrigger(menuPanel) };
}

export function injectConversationMenuExportButton(
  menuPanel: HTMLElement,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  if (!isConversationMenuPanel(menuPanel)) return null;
  const menuContent = findMenuContent(menuPanel);
  if (!menuContent) return null;

  const existing = menuContent.querySelector(`.${MENU_BUTTON_CLASS}`) as HTMLElement | null;
  if (existing) {
    updateButtonLabelAndTooltip(existing, options.label, options.tooltip);
    return existing;
  }

  const button = createMenuItemButton({
    ...options,
    menuContent,
    menuPanel,
    injectedClassName: MENU_BUTTON_CLASS,
    iconName: 'download',
    excludedClassNames: ['gv-move-to-folder-btn', RESPONSE_MENU_BUTTON_CLASS],
  });
  if (!button) return null;
  const pinButton = menuContent.querySelector('[data-test-id="pin-button"]');
  if (pinButton && pinButton.parentElement === menuContent) {
    if (pinButton.nextSibling) {
      menuContent.insertBefore(button, pinButton.nextSibling);
    } else {
      menuContent.appendChild(button);
    }
  } else if (menuContent.firstChild) {
    menuContent.insertBefore(button, menuContent.firstChild);
  } else {
    menuContent.appendChild(button);
  }

  return button;
}

export function injectConversationMenuMoveToFolderButton(
  menuPanel: HTMLElement,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  if (!isConversationMenuPanel(menuPanel)) return null;
  const menuContent = findMenuContent(menuPanel);
  if (!menuContent) return null;

  const existing = menuContent.querySelector(
    `.${MOVE_TO_FOLDER_BUTTON_CLASS}`,
  ) as HTMLElement | null;
  if (existing) {
    updateButtonLabelAndTooltip(existing, options.label, options.tooltip);
    return existing;
  }

  const button = createMenuItemButton({
    ...options,
    menuContent,
    menuPanel,
    injectedClassName: MOVE_TO_FOLDER_BUTTON_CLASS,
    iconName: 'folder_open',
    excludedClassNames: [MENU_BUTTON_CLASS, RESPONSE_MENU_BUTTON_CLASS],
  });
  if (!button) return null;

  // Place after the export button when present, otherwise after the pin button,
  // keeping our two injected items grouped near the top of the native menu.
  const exportButton = menuContent.querySelector(`.${MENU_BUTTON_CLASS}`) as HTMLElement | null;
  const pinButton = menuContent.querySelector('[data-test-id="pin-button"]') as HTMLElement | null;
  const anchor =
    exportButton && exportButton.parentElement === menuContent
      ? exportButton
      : pinButton && pinButton.parentElement === menuContent
        ? pinButton
        : null;
  if (anchor) {
    if (anchor.nextSibling) {
      menuContent.insertBefore(button, anchor.nextSibling);
    } else {
      menuContent.appendChild(button);
    }
  } else if (menuContent.firstChild) {
    menuContent.insertBefore(button, menuContent.firstChild);
  } else {
    menuContent.appendChild(button);
  }

  return button;
}

export function injectResponseMenuExportButton(
  menuPanel: HTMLElement,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  if (!isResponseMenuPanel(menuPanel)) return null;
  const menuContent = findMenuContent(menuPanel);
  if (!menuContent) return null;

  const existing = menuContent.querySelector(
    `.${RESPONSE_MENU_BUTTON_CLASS}`,
  ) as HTMLElement | null;
  if (existing) {
    updateButtonLabelAndTooltip(existing, options.label, options.tooltip);
    return existing;
  }

  const button = createMenuItemButton({
    ...options,
    menuContent,
    menuPanel,
    injectedClassName: RESPONSE_MENU_BUTTON_CLASS,
    iconName: 'download',
    excludedClassNames: [MENU_BUTTON_CLASS, 'gv-move-to-folder-btn'],
  });
  if (!button) return null;

  const exportToDocsButton = findMenuButtonByIcon(menuContent, 'docs');
  if (exportToDocsButton && exportToDocsButton.parentElement === menuContent) {
    if (exportToDocsButton.nextSibling) {
      menuContent.insertBefore(button, exportToDocsButton.nextSibling);
    } else {
      menuContent.appendChild(button);
    }
  } else if (menuContent.firstChild) {
    menuContent.insertBefore(button, menuContent.firstChild);
  } else {
    menuContent.appendChild(button);
  }

  return button;
}
