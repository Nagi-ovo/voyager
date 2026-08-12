// Persistent top-right export toolbar.
// Mounted as a fallback when Gemini's logo (the usual injection point for the
// inline export dropdown) is absent — e.g. after the lr26 UI refresh removed
// [data-test-id="logo"]. Calls back into showExportDialog when clicked.

export type PersistentExportToolbarOptions = {
  label: string;
  tooltip: string;
  onClick: () => void;
};

const TOOLBAR_CLASS = 'gv-persistent-export-toolbar';
const BUTTON_CLASS = 'gv-persistent-export-btn';
const ICON_CLASS = 'gv-persistent-export-icon';
const LABEL_CLASS = 'gv-persistent-export-label';
const DEFAULT_RIGHT_OFFSET_PX = 84;
const TOP_RIGHT_GAP_PX = 12;
const TOP_RIGHT_MAX_Y_PX = 96;
const TOP_RIGHT_MIN_LEFT_RATIO = 0.45;
const TOP_RIGHT_AVOIDANCE_SELECTORS = [
  'top-bar-actions',
  '.top-bar-actions',
  '[data-test-id="top-bar-actions"]',
  'side-nav-sparkle-button',
  'side-nav-menu-button',
  '[data-test-id*="upgrade" i]',
  '[aria-label*="upgrade" i]',
  '[aria-label*="pro" i]',
  '[aria-label*="advanced" i]',
].join(',');

type OwnedToolbarRoot = HTMLDivElement & { _gvOwner?: symbol };
type ToolbarButton = HTMLButtonElement & { _gvOnClick?: () => void };

let activeAvoidanceRoot: HTMLDivElement | null = null;
let activeAvoidanceCleanup: (() => void) | null = null;

function isVisibleTopRightElement(
  element: Element,
  toolbarRoot: HTMLElement,
): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element === toolbarRoot || toolbarRoot.contains(element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.bottom <= 0 || rect.top >= TOP_RIGHT_MAX_Y_PX) return false;
  // Some Gemini top-bar hosts span the full viewport. Treating those as
  // right-side controls makes the computed offset enormous and pushes the
  // toolbar into the left rail, so only avoid elements whose own left edge is
  // already in the right-side control cluster.
  return rect.left >= window.innerWidth * TOP_RIGHT_MIN_LEFT_RATIO;
}

function calculateRightOffset(toolbarRoot: HTMLElement): number {
  const candidates = Array.from(document.querySelectorAll(TOP_RIGHT_AVOIDANCE_SELECTORS)).filter(
    (element): element is HTMLElement => isVisibleTopRightElement(element, toolbarRoot),
  );
  if (candidates.length === 0) return DEFAULT_RIGHT_OFFSET_PX;

  const leftMost = candidates.reduce(
    (minLeft, element) => Math.min(minLeft, element.getBoundingClientRect().left),
    window.innerWidth,
  );
  return Math.max(
    DEFAULT_RIGHT_OFFSET_PX,
    Math.ceil(window.innerWidth - leftMost + TOP_RIGHT_GAP_PX),
  );
}

function installToolbarAvoidance(root: HTMLDivElement): void {
  if (activeAvoidanceRoot === root) return;
  activeAvoidanceCleanup?.();
  activeAvoidanceRoot = root;

  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    if (!root.isConnected) {
      activeAvoidanceCleanup?.();
      return;
    }
    root.style.setProperty('--gv-persistent-export-right', `${calculateRightOffset(root)}px`);
  };
  const scheduleUpdate = () => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(update);
  };

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-hidden', 'class', 'hidden', 'style'],
  });
  window.addEventListener('resize', scheduleUpdate);
  scheduleUpdate();

  activeAvoidanceCleanup = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    observer.disconnect();
    window.removeEventListener('resize', scheduleUpdate);
    if (activeAvoidanceRoot === root) {
      activeAvoidanceRoot = null;
      activeAvoidanceCleanup = null;
    }
  };
}

function removeToolbarRoot(root: HTMLDivElement): void {
  if (activeAvoidanceRoot === root) activeAvoidanceCleanup?.();
  try {
    root.remove();
  } catch {}
}

function buildToolbarDom(options: PersistentExportToolbarOptions): {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  labelEl: HTMLSpanElement;
} {
  const root = document.createElement('div');
  root.className = TOOLBAR_CLASS;
  root.setAttribute('data-gv-component', 'persistent-export-toolbar');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.title = options.tooltip;
  button.setAttribute('aria-label', options.tooltip);

  const icon = document.createElement('span');
  icon.className = ICON_CLASS;
  icon.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = LABEL_CLASS;
  labelEl.textContent = options.label;

  button.appendChild(icon);
  button.appendChild(labelEl);
  root.appendChild(button);

  return { root, button, labelEl };
}

export type PersistentExportToolbarHandle = {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  setText(label: string, tooltip: string): void;
  remove(): void;
};

export function mountPersistentExportToolbar(
  options: PersistentExportToolbarOptions,
): PersistentExportToolbarHandle {
  const owner = Symbol('persistent-export-toolbar-owner');
  const existing = document.querySelector(`.${TOOLBAR_CLASS}`) as OwnedToolbarRoot | null;
  if (existing) {
    const button = existing.querySelector(`.${BUTTON_CLASS}`) as ToolbarButton;
    const labelEl = existing.querySelector(`.${LABEL_CLASS}`) as HTMLSpanElement;
    button.title = options.tooltip;
    button.setAttribute('aria-label', options.tooltip);
    if (labelEl) labelEl.textContent = options.label;
    existing._gvOwner = owner;
    button._gvOnClick = options.onClick;
    installToolbarAvoidance(existing);
    return {
      root: existing,
      button,
      setText(label, tooltip) {
        button.title = tooltip;
        button.setAttribute('aria-label', tooltip);
        if (labelEl) labelEl.textContent = label;
      },
      remove() {
        if (existing._gvOwner === owner) removeToolbarRoot(existing);
      },
    };
  }

  const { root: plainRoot, button: plainButton, labelEl } = buildToolbarDom(options);
  const root = plainRoot as OwnedToolbarRoot;
  const button = plainButton as ToolbarButton;
  root._gvOwner = owner;
  button._gvOnClick = options.onClick;

  const swallow = (e: Event) => {
    try {
      e.stopPropagation();
    } catch {}
  };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
    button.addEventListener(type, swallow, true);
  });
  button.addEventListener('click', (ev) => {
    swallow(ev);
    try {
      button._gvOnClick?.();
    } catch (err) {
      try {
        console.error('[Gemini Voyager] Persistent export toolbar click failed:', err);
      } catch {}
    }
  });

  document.body.appendChild(root);
  installToolbarAvoidance(root);

  return {
    root,
    button,
    setText(label, tooltip) {
      button.title = tooltip;
      button.setAttribute('aria-label', tooltip);
      labelEl.textContent = label;
    },
    remove() {
      if (root._gvOwner === owner) removeToolbarRoot(root);
    },
  };
}

export function isPersistentExportToolbarMounted(): boolean {
  return !!document.querySelector(`.${TOOLBAR_CLASS}`);
}
