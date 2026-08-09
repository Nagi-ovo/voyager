import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';

import type { ChatGptExportFormat } from './exporter';
import type { ChatGptExportCopy } from './i18n';

interface OwnedScope {
  readonly scope: PluginScope;
  readonly close: Dispose;
}

export interface ExportFormatChoice {
  readonly format: ChatGptExportFormat;
  readonly fontSize?: number;
}

export interface ProgressHandle {
  readonly setCount: (count: number) => void;
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
  button.className = `gv-chatgpt-export-btn${primary ? ' gv-chatgpt-export-btn--primary' : ''}`;
  button.textContent = label;
  return button;
}

function createDialog(
  titleText: string,
  hintText: string,
): {
  overlay: HTMLElement;
  dialog: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
} {
  const overlay = document.createElement('div');
  overlay.className = 'gv-chatgpt-export-overlay';
  overlay.dataset.gvChatgptExportOwned = 'true';

  const dialog = document.createElement('section');
  dialog.className = 'gv-chatgpt-export-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'gv-chatgpt-export-dialog-header';
  const title = document.createElement('h2');
  title.className = 'gv-chatgpt-export-dialog-title';
  dialogSequence += 1;
  title.id = `gv-chatgpt-export-dialog-title-${dialogSequence}`;
  dialog.setAttribute('aria-labelledby', title.id);
  title.textContent = titleText;
  const hint = document.createElement('p');
  hint.className = 'gv-chatgpt-export-dialog-hint';
  hint.textContent = hintText;
  header.append(title, hint);

  const body = document.createElement('div');
  body.className = 'gv-chatgpt-export-dialog-body';
  const footer = document.createElement('footer');
  footer.className = 'gv-chatgpt-export-dialog-footer';
  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  return { overlay, dialog, header, body, footer };
}

function getDialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.closest('[hidden], [aria-hidden="true"]'));
}

function mountDialog(
  scope: PluginScope,
  overlay: HTMLElement,
  dialog: HTMLElement,
  onDismiss: () => void,
): void {
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scope.effect(
    () => () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    },
    'restore-dialog-focus',
  );
  scope.on(overlay, 'pointerdown', (event) => {
    if (event.target === overlay) onDismiss();
  });
  scope.on(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = getDialogFocusables(dialog);
    if (focusables.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    const first = focusables[0];
    const last = focusables.at(-1)!;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });
  scope.mount(overlay, document.body);
  (getDialogFocusables(dialog)[0] || dialog).focus();
}

export function showCollectionProgress(
  parent: PluginScope,
  copy: ChatGptExportCopy,
  onCancel: () => void,
): ProgressHandle {
  const owned = ownScope(parent, 'chatgpt-export-progress');
  const { overlay, dialog, body, footer } = createDialog(copy.collectTitle, '');
  const progress = document.createElement('div');
  progress.className = 'gv-chatgpt-export-progress';
  const spinner = document.createElement('div');
  spinner.className = 'gv-chatgpt-export-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const message = document.createElement('div');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.textContent = copy.collectProgress(0);
  progress.append(spinner, message);
  body.appendChild(progress);

  const cancel = createButton(copy.cancel);
  footer.appendChild(cancel);
  const dismiss = (): void => {
    onCancel();
    void owned.close();
  };
  owned.scope.on(cancel, 'click', dismiss);
  mountDialog(owned.scope, overlay, dialog, dismiss);
  return {
    setCount: (count) => {
      message.textContent = copy.collectProgress(count);
    },
    close: owned.close,
  };
}

export function showFormatDialog(
  parent: PluginScope,
  copy: ChatGptExportCopy,
): Promise<ExportFormatChoice | null> {
  return new Promise((resolve) => {
    const owned = ownScope(parent, 'chatgpt-export-format');
    let settled = false;
    const finish = (value: ExportFormatChoice | null): void => {
      if (settled) return;
      settled = true;
      void Promise.resolve(owned.close()).then(() => resolve(value));
    };
    owned.scope.signal.addEventListener('abort', () => finish(null), { once: true });

    const { overlay, dialog, header, body, footer } = createDialog(
      copy.formatTitle,
      copy.formatHint,
    );
    const attribution = document.createElement('a');
    attribution.className = 'gv-chatgpt-export-attribution';
    attribution.href = 'https://github.com/TanChuping/chatgpt-voyager';
    attribution.target = '_blank';
    attribution.rel = 'noopener noreferrer';
    attribution.referrerPolicy = 'no-referrer';
    attribution.textContent = 'Powered by ChatGPT Voyager';
    header.appendChild(attribution);
    const formats: readonly ChatGptExportFormat[] = ['markdown', 'json', 'pdf'];
    let selected: ChatGptExportFormat = 'markdown';
    const list = document.createElement('div');
    list.className = 'gv-chatgpt-export-format-list';
    const options = document.createElement('div');
    options.className = 'gv-chatgpt-export-options';

    const fontControl = createRangeControl(owned.scope, copy.fontSize, 8, 28, 11, '');
    options.append(fontControl.root);
    const updateOptions = (): void => {
      fontControl.root.hidden = selected !== 'pdf';
    };

    formats.forEach((format) => {
      const choice = copy.formats[format];
      const label = document.createElement('label');
      label.className = 'gv-chatgpt-export-format-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gv-chatgpt-export-format';
      radio.value = format;
      radio.checked = format === selected;
      const content = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'gv-chatgpt-export-format-label';
      name.textContent = choice.label;
      const description = document.createElement('span');
      description.className = 'gv-chatgpt-export-format-description';
      description.textContent = choice.description;
      content.append(name, description);
      owned.scope.on(radio, 'change', () => {
        if (!radio.checked) return;
        selected = format;
        updateOptions();
      });
      label.append(radio, content);
      list.appendChild(label);
    });

    const cancel = createButton(copy.cancel);
    const submit = createButton(copy.export, true);
    owned.scope.on(cancel, 'click', () => finish(null));
    owned.scope.on(submit, 'click', () =>
      finish({
        format: selected,
        fontSize: selected === 'pdf' ? Number(fontControl.input.value) : undefined,
      }),
    );
    body.append(list, options);
    footer.append(cancel, submit);
    updateOptions();
    mountDialog(owned.scope, overlay, dialog, () => finish(null));
  });
}

function createRangeControl(
  scope: PluginScope,
  labelText: string,
  min: number,
  max: number,
  value: number,
  unit: string,
  step = 1,
): { root: HTMLElement; input: HTMLInputElement; update: () => void } {
  const root = document.createElement('label');
  root.className = 'gv-chatgpt-export-control';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const output = document.createElement('output');
  const update = (): void => {
    output.value = `${input.value}${unit}`;
  };
  scope.on(input, 'input', update);
  root.append(label, input, output);
  update();
  return { root, input, update };
}

export function showConfirmationDialog(
  parent: PluginScope,
  copy: ChatGptExportCopy,
): Promise<boolean> {
  return new Promise((resolve) => {
    const owned = ownScope(parent, 'chatgpt-export-confirm');
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      void Promise.resolve(owned.close()).then(() => resolve(value));
    };
    owned.scope.signal.addEventListener('abort', () => finish(false), { once: true });
    const { overlay, dialog, footer } = createDialog(copy.tempTitle, copy.tempBody);
    const cancel = createButton(copy.cancel);
    const confirm = createButton(copy.tempConfirm, true);
    owned.scope.on(cancel, 'click', () => finish(false));
    owned.scope.on(confirm, 'click', () => finish(true));
    footer.append(cancel, confirm);
    mountDialog(owned.scope, overlay, dialog, () => finish(false));
  });
}

export function showExportToast(
  parent: PluginScope,
  message: string,
  kind: 'info' | 'error' = 'info',
): void {
  const owned = ownScope(parent, 'chatgpt-export-toast');
  const toast = document.createElement('div');
  toast.className = `gv-chatgpt-export-toast${kind === 'error' ? ' gv-chatgpt-export-toast--error' : ''}`;
  toast.dataset.gvChatgptExportOwned = 'true';
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  owned.scope.mount(toast, document.body);
  owned.scope.timer(() => void owned.close(), 4_500);
}
