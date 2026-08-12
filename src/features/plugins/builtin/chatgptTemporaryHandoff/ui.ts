import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';

import type { TemporaryHandoffCopy } from './i18n';

interface OwnedScope {
  readonly scope: PluginScope;
  readonly close: Dispose;
}

export interface ProgressHandle {
  readonly close: Dispose;
}

let dialogSequence = 0;

function ownScope(parent: PluginScope, label: string): OwnedScope {
  const scope = new PluginScope();
  const close = parent.child({ destroy: () => scope.dispose() }, label);
  return { scope, close };
}

function createButton(label: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `gv-chatgpt-handoff-dialog-button${primary ? ' gv-chatgpt-handoff-dialog-button--primary' : ''}`;
  button.textContent = label;
  return button;
}

function createDialog(
  titleText: string,
  bodyText: string,
): {
  overlay: HTMLElement;
  dialog: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
} {
  const overlay = document.createElement('div');
  overlay.className = 'gv-chatgpt-handoff-overlay';
  overlay.dataset.gvChatgptHandoffOwned = 'true';

  const dialog = document.createElement('section');
  dialog.className = 'gv-chatgpt-handoff-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const title = document.createElement('h2');
  title.className = 'gv-chatgpt-handoff-dialog-title';
  dialogSequence += 1;
  title.id = `gv-chatgpt-handoff-dialog-title-${dialogSequence}`;
  dialog.setAttribute('aria-labelledby', title.id);
  title.textContent = titleText;

  const body = document.createElement('div');
  body.className = 'gv-chatgpt-handoff-dialog-body';
  body.textContent = bodyText;

  const footer = document.createElement('footer');
  footer.className = 'gv-chatgpt-handoff-dialog-footer';
  dialog.append(title, body, footer);
  overlay.appendChild(dialog);
  return { overlay, dialog, body, footer };
}

function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function mountDialog(
  scope: PluginScope,
  overlay: HTMLElement,
  dialog: HTMLElement,
  dismiss: () => void,
): void {
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scope.effect(
    () => () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    },
    'restore-handoff-dialog-focus',
  );
  scope.on(overlay, 'pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  scope.on(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });
  scope.mount(overlay, document.body);
  (focusables(dialog)[0] || dialog).focus();
}

export function showHandoffConfirmation(
  parent: PluginScope,
  copy: TemporaryHandoffCopy,
): Promise<boolean> {
  return new Promise((resolve) => {
    const owned = ownScope(parent, 'chatgpt-handoff-confirmation');
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      void Promise.resolve(owned.close()).then(() => resolve(value));
    };
    owned.scope.signal.addEventListener('abort', () => finish(false), { once: true });

    const { overlay, dialog, footer } = createDialog(copy.confirmTitle, copy.confirmBody);
    const cancel = createButton(copy.cancel);
    const confirm = createButton(copy.confirm, true);
    owned.scope.on(cancel, 'click', () => finish(false));
    owned.scope.on(confirm, 'click', () => finish(true));
    footer.append(cancel, confirm);
    mountDialog(owned.scope, overlay, dialog, () => finish(false));
  });
}

export function showHandoffProgress(
  parent: PluginScope,
  copy: TemporaryHandoffCopy,
  onCancel: () => void,
): ProgressHandle {
  const owned = ownScope(parent, 'chatgpt-handoff-progress');
  const { overlay, dialog, body, footer } = createDialog(copy.collecting, '');
  const spinner = document.createElement('span');
  spinner.className = 'gv-chatgpt-handoff-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = copy.collecting;
  body.replaceChildren(spinner, status);

  const cancel = createButton(copy.cancel);
  footer.appendChild(cancel);
  const dismiss = (): void => {
    onCancel();
    void owned.close();
  };
  owned.scope.on(cancel, 'click', dismiss);
  mountDialog(owned.scope, overlay, dialog, dismiss);
  return { close: owned.close };
}

export function showHandoffToast(
  parent: PluginScope,
  message: string,
  kind: 'info' | 'error' = 'info',
): void {
  if (parent.isDisposed) return;
  const owned = ownScope(parent, 'chatgpt-handoff-toast');
  const toast = document.createElement('div');
  toast.className = `gv-chatgpt-handoff-toast${kind === 'error' ? ' gv-chatgpt-handoff-toast--error' : ''}`;
  toast.dataset.gvChatgptHandoffOwned = 'true';
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  owned.scope.mount(toast, document.body);
  owned.scope.timer(() => void owned.close(), 4_500);
}
