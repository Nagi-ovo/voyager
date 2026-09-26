import type { PluginScope } from '../../runtime/pluginScope';
import type { TableCopyLabels } from './i18n';
import { TableCopyError, type TableCopyFormat, serializeTable } from './serializer';

export const TABLE_COPY_CLASS = 'gv-table-copy';

const CONTROL_CSS = `
  :host { display: block; max-width: 100%; color: inherit; font: inherit; }
  .gv-table-copy-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    padding-block: 6px; max-width: 100%; font: 12px/1.5 system-ui, sans-serif; }
  .gv-table-copy-button { box-sizing: border-box; min-height: 32px; max-width: 100%;
    padding: 4px 8px; border: 1px solid currentColor; border-radius: 4px;
    color: inherit; background: transparent; font: inherit; cursor: pointer;
    overflow-wrap: anywhere; text-align: start; letter-spacing: 0; }
  .gv-table-copy-button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .gv-table-copy-button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .gv-table-copy-button:disabled { opacity: .6; cursor: wait; }
  .gv-table-copy-status { flex: 1 0 100%; min-height: 1.5em; overflow-wrap: anywhere; }
`;

/** Shadow styles inherit the site's text color in both themes without leaking into its table. */
export function mountTableCopyControls(
  scope: PluginScope,
  table: HTMLTableElement,
  labels: TableCopyLabels,
  isCurrent: () => boolean,
  rtl: boolean,
): HTMLElement {
  const doc = table.ownerDocument;
  const host = doc.createElement('div');
  host.className = TABLE_COPY_CLASS;
  host.dir = rtl ? 'rtl' : 'ltr';
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = CONTROL_CSS;
  const actions = doc.createElement('div');
  actions.className = 'gv-table-copy-actions';
  const status = doc.createElement('span');
  status.className = 'gv-table-copy-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const buttons: HTMLButtonElement[] = [];
  let busy = false;
  const alive = () =>
    !scope.signal.aborted && host.isConnected && host.nextElementSibling === table && isCurrent();

  async function copy(format: TableCopyFormat) {
    if (busy || !alive()) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    actions.setAttribute('aria-busy', 'true');
    status.textContent = labels.busy;
    try {
      const value = serializeTable(table, format);
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      // No await before writeText: preserve the click's transient user activation.
      await clipboard.writeText(value);
      if (alive()) status.textContent = labels.copied;
    } catch (error) {
      if (alive()) {
        status.textContent = error instanceof TableCopyError ? labels[error.code] : labels.failed;
      }
    } finally {
      busy = false;
      if (alive()) {
        actions.setAttribute('aria-busy', 'false');
        for (const button of buttons) button.disabled = false;
      }
    }
  }

  for (const format of ['markdown', 'tsv'] as const) {
    const button = doc.createElement('button');
    button.className = 'gv-table-copy-button';
    button.type = 'button';
    button.textContent = labels[format];
    button.setAttribute('aria-label', labels[format]);
    button.dataset.format = format;
    scope.on(button, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copy(format);
    });
    actions.appendChild(button);
    buttons.push(button);
  }
  actions.appendChild(status);
  root.append(style, actions);
  scope.mount(host, table.parentElement!, table);
  return host;
}
