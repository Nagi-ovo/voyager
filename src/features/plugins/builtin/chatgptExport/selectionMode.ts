import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';

import {
  type ChatGptMessageSnapshot,
  collectMountedChatGptMessagesWithHosts,
  isChatGptGenerationActive,
} from './conversation';
import type { ChatGptExportCopy } from './i18n';

const ACTIVE_CLASS = 'gv-chatgpt-export-pick-active';
const HOST_CLASS = 'gv-chatgpt-export-pick-host';
const HOST_SELECTED_CLASS = 'gv-chatgpt-export-pick-host--selected';
const CHECKBOX_CLASS = 'gv-chatgpt-export-pick-checkbox';
const SYNC_DELAY_MS = 60;

interface MountedControl {
  readonly host: HTMLElement;
  readonly checkbox: HTMLButtonElement;
}

function createBarButton(label: string, modifier = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `gv-chatgpt-export-pick-bar__btn${modifier}`;
  button.textContent = label;
  return button;
}

/**
 * Enter an in-page, progressive selection mode. Unlike whole-conversation
 * export, this never drives the scroll container. It decorates only messages
 * ChatGPT has mounted and observes later virtualised/lazy-loaded turns as the
 * user scrolls. Detached snapshots preserve selected messages after ChatGPT
 * replaces their DOM nodes.
 */
export function showInlineMessageSelection(
  parent: PluginScope,
  copy: ChatGptExportCopy,
): Promise<ChatGptMessageSnapshot[] | null> {
  return new Promise((resolve) => {
    const scope = new PluginScope();
    const close = parent.child({ destroy: () => scope.dispose() }, 'chatgpt-export-selection');
    const discovered = new Map<string, ChatGptMessageSnapshot>();
    const selected = new Map<string, ChatGptMessageSnapshot>();
    const controls = new Map<string, MountedControl>();
    const touchedHosts = new Set<HTMLElement>();
    const fallbackIdByHost = new WeakMap<HTMLElement, string>();
    const fallbackRecords = new Map<
      string,
      { readonly host: HTMLElement; readonly snapshot: ChatGptMessageSnapshot }
    >();
    let fallbackIdSequence = 0;
    let stopSyncTimer: Dispose | null = null;
    let settled = false;

    const finish = (value: ChatGptMessageSnapshot[] | null): void => {
      if (settled) return;
      settled = true;
      if (scope.signal.aborted) {
        resolve(value);
        return;
      }
      void Promise.resolve(close()).finally(() => resolve(value));
    };
    scope.signal.addEventListener('abort', () => finish(null), { once: true });

    document.body.classList.add(ACTIVE_CLASS);
    scope.effect(
      () => () => {
        document.body.classList.remove(ACTIVE_CLASS);
        for (const { checkbox } of controls.values()) checkbox.remove();
        for (const host of touchedHosts) host.classList.remove(HOST_CLASS, HOST_SELECTED_CLASS);
      },
      'chatgpt-export-selection-nodes',
    );

    const bar = document.createElement('div');
    bar.className = 'gv-chatgpt-export-pick-bar';
    bar.dataset.gvChatgptExportOwned = 'true';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', copy.selectionTitle);
    bar.title = copy.selectionHint;

    const title = document.createElement('span');
    title.className = 'gv-chatgpt-export-pick-bar__title';
    title.textContent = copy.selectionTitle;
    const count = document.createElement('span');
    count.className = 'gv-chatgpt-export-pick-bar__count';
    const next = createBarButton(copy.next, ' gv-chatgpt-export-pick-bar__btn--primary');
    const cancel = createBarButton(copy.cancel, ' gv-chatgpt-export-pick-bar__btn--ghost');
    next.disabled = true;

    const update = (): void => {
      count.textContent = `${copy.selectedCount(selected.size)} · ${copy.loadedCount(discovered.size)}`;
      const selectedResponseIsStreaming =
        isChatGptGenerationActive() &&
        [...selected.values()].some((message) => message.role === 'assistant');
      next.disabled = selected.size === 0 || selectedResponseIsStreaming;
      for (const [id, { checkbox, host }] of controls) {
        const isSelected = selected.has(id);
        checkbox.dataset.selected = isSelected ? 'true' : 'false';
        checkbox.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        host.classList.toggle(HOST_SELECTED_CLASS, isSelected);
      }
    };

    const selectLoaded = (predicate: (message: ChatGptMessageSnapshot) => boolean): void => {
      selected.clear();
      for (const message of discovered.values()) {
        if (predicate(message)) selected.set(message.id, message);
      }
      update();
    };

    const all = createBarButton(copy.selectAll);
    const none = createBarButton(copy.selectNone);
    const onlyUser = createBarButton(copy.onlyUser);
    const onlyAssistant = createBarButton(copy.onlyAssistant);
    scope.on(all, 'click', () => selectLoaded(() => true));
    scope.on(none, 'click', () => selectLoaded(() => false));
    scope.on(onlyUser, 'click', () => selectLoaded((message) => message.role === 'user'));
    scope.on(onlyAssistant, 'click', () => selectLoaded((message) => message.role === 'assistant'));
    scope.on(next, 'click', () => {
      if (selected.size === 0) return;
      if (
        isChatGptGenerationActive() &&
        [...selected.values()].some((message) => message.role === 'assistant')
      ) {
        return;
      }
      finish([...selected.values()].sort((left, right) => left.order - right.order));
    });
    scope.on(cancel, 'click', () => finish(null));
    scope.on(window, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(null);
    });
    bar.append(title, all, none, onlyUser, onlyAssistant, count, next, cancel);
    scope.mount(bar, document.body);

    const attach = (id: string, host: HTMLElement): void => {
      const existing = controls.get(id);
      if (existing?.host === host && existing.checkbox.isConnected) return;
      if (existing) {
        existing.checkbox.remove();
        existing.host.classList.remove(HOST_CLASS, HOST_SELECTED_CLASS);
      }

      const checkbox = document.createElement('button');
      checkbox.type = 'button';
      checkbox.className = CHECKBOX_CLASS;
      checkbox.dataset.gvChatgptExportOwned = 'true';
      checkbox.dataset.gvChatgptExportMessageId = id;
      checkbox.setAttribute('aria-label', copy.selectionTitle);
      checkbox.title = copy.selectionTitle;
      host.classList.add(HOST_CLASS);
      host.appendChild(checkbox);
      controls.set(id, { host, checkbox });
      touchedHosts.add(host);
    };

    // Offset-derived collector IDs are useful for walking detached virtual
    // windows, but a history prepend changes every following offset. Selection
    // mode gives fallback hosts a local, position-independent identity. If
    // React remounts a uniquely matching fallback message during the prepend,
    // carry that identity to the replacement host as well.
    const resolveSelectionSnapshot = (
      snapshot: ChatGptMessageSnapshot,
      host: HTMLElement,
    ): ChatGptMessageSnapshot => {
      if (!snapshot.syntheticId) return snapshot;
      let id = fallbackIdByHost.get(host);
      if (!id) {
        const remounted = [...fallbackRecords].filter(
          ([, previous]) =>
            !previous.host.isConnected &&
            previous.snapshot.role === snapshot.role &&
            previous.snapshot.text === snapshot.text,
        );
        if (remounted.length === 1) {
          id = remounted[0][0];
        } else {
          fallbackIdSequence += 1;
          id = `selection-fallback-${fallbackIdSequence}`;
        }
        fallbackIdByHost.set(host, id);
      }
      const resolved = { ...snapshot, id };
      fallbackRecords.set(id, { host, snapshot: resolved });
      return resolved;
    };

    const sync = (): void => {
      stopSyncTimer = null;
      for (const [id, control] of controls) {
        if (control.host.isConnected && control.checkbox.isConnected) continue;
        controls.delete(id);
      }
      for (const mounted of collectMountedChatGptMessagesWithHosts()) {
        const { host } = mounted;
        const snapshot = resolveSelectionSnapshot(mounted.snapshot, host);
        discovered.set(snapshot.id, snapshot);
        if (selected.has(snapshot.id)) selected.set(snapshot.id, snapshot);
        attach(snapshot.id, host);
      }
      update();
    };
    const scheduleSync = (): void => {
      if (scope.isDisposed || stopSyncTimer) return;
      stopSyncTimer = scope.timer(sync, SYNC_DELAY_MS);
    };

    const swallowPointer = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(`.${CHECKBOX_CLASS}`)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    scope.on(document, 'pointerdown', swallowPointer, { capture: true });
    scope.on(document, 'mousedown', swallowPointer, { capture: true });
    scope.on(document, 'pointerup', swallowPointer, { capture: true });
    scope.on(document, 'mouseup', swallowPointer, { capture: true });
    scope.on(
      document,
      'click',
      (event) => {
        const target = event.target;
        const checkbox =
          target instanceof Element
            ? target.closest<HTMLButtonElement>(`.${CHECKBOX_CLASS}`)
            : null;
        if (!checkbox) return;
        event.preventDefault();
        event.stopPropagation();
        const id = checkbox.dataset.gvChatgptExportMessageId;
        const snapshot = id ? discovered.get(id) : undefined;
        if (!id || !snapshot) return;
        if (selected.has(id)) selected.delete(id);
        else selected.set(id, snapshot);
        update();
      },
      { capture: true },
    );
    scope.observe(document.body, { childList: true, subtree: true }, scheduleSync);
    scope.on(document, 'scroll', scheduleSync, { capture: true, passive: true });

    sync();
  });
}
