import { logger } from '@/core/services/LoggerService';
import { getCurrentLanguage } from '@/utils/i18n';
import { isAppLanguage } from '@/utils/language';

import type { ManifestIssue } from '../manifest/validate';
import { PluginScope } from '../runtime/pluginScope';
import { getPrimitiveContract } from './contracts';
import { mountTableCopyControls } from './tableCopy/controls';
import { TABLE_COPY_LABELS } from './tableCopy/i18n';
import type { Primitive } from './types';

export interface TableCopyParams {
  readonly table?: string;
}

const MAX_SELECTOR_LENGTH = 2_000;
const DISCOVERY_DELAY_MS = 50;

export const tableCopyPrimitive: Primitive<TableCopyParams> = {
  contract: getPrimitiveContract('tableCopy')!,

  validateParams(raw: unknown) {
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      return { success: false, error: [{ path: 'params', message: 'must be an object' }] };
    }
    const issues: ManifestIssue[] = [];
    const params: { table?: string } = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (key !== 'table') {
        issues.push({ path: 'params.' + key, message: 'unknown parameter' });
      } else if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR_LENGTH) {
        issues.push({ path: 'params.table', message: 'must be a non-empty selector' });
      } else {
        params.table = value;
      }
    }
    return issues.length ? { success: false, error: issues } : { success: true, data: params };
  },

  async activate(scope, params, context) {
    const { doc } = context;
    const assistant = context.adapter?.selectors.assistantTurn;
    const thinking = context.adapter?.selectors.thinkingBlock;
    const selector = params.table ?? 'table';
    const entries = new Map<HTMLTableElement, { scope: PluginScope; host: HTMLElement }>();
    context.setTargetCounter(() =>
      scope.signal.aborted
        ? 0
        : Array.from(entries.keys()).filter((table) => table.isConnected).length,
    );
    if (!assistant || scope.signal.aborted) return;
    // Selector syntax needs a DOM; protect direct callers bypassing validation too.
    try {
      doc.querySelector(assistant);
      doc.querySelector(selector);
      if (thinking) doc.querySelector(thinking);
    } catch {
      return;
    }
    const requestedLanguage = await getCurrentLanguage().catch(() => 'en' as const);
    const language = isAppLanguage(requestedLanguage) ? requestedLanguage : 'en';
    if (scope.signal.aborted) return;
    const labels = TABLE_COPY_LABELS[language];
    const ownHosts = new WeakSet<Node>();
    const liveHosts = new Set<Node>();
    let scheduled = false;

    const eligible = (table: HTMLTableElement) =>
      table.isConnected &&
      table.ownerDocument === doc &&
      table.matches(selector) &&
      Boolean(table.closest(assistant)) &&
      !table.parentElement?.closest('table') &&
      !(thinking && table.closest(thinking));

    scope.effect(
      () => async () => {
        const children = Array.from(entries.values());
        entries.clear();
        liveHosts.clear();
        await Promise.all(children.map((entry) => entry.scope.dispose()));
      },
      'table-copy-controls',
    );

    function reconcile() {
      try {
        reconcileTables();
      } catch {
        // Host DOM can disappear or reject insertion during a framework remount.
        // Keep the observer alive for a later retry; never log conversation data.
        logger.warn('tableCopy: could not reconcile table controls', { id: context.pluginId });
      }
    }

    function reconcileTables() {
      if (scope.signal.aborted) return;
      for (const [table, entry] of entries) {
        if (
          !eligible(table) ||
          entry.host.nextElementSibling !== table ||
          !entry.host.isConnected
        ) {
          entries.delete(table);
          liveHosts.delete(entry.host);
          void entry.scope.dispose();
        }
      }
      for (const element of doc.querySelectorAll(selector)) {
        if (element.tagName !== 'TABLE') continue;
        const table = element as HTMLTableElement;
        if (!eligible(table) || entries.has(table)) continue;
        const child = new PluginScope();
        try {
          const host = mountTableCopyControls(
            child,
            table,
            labels,
            () => !scope.signal.aborted && eligible(table),
            language === 'ar',
          );
          ownHosts.add(host);
          liveHosts.add(host);
          entries.set(table, { scope: child, host });
        } catch {
          void child.dispose();
          logger.warn('tableCopy: could not mount table controls', { id: context.pluginId });
        }
      }
    }

    reconcile();
    scope.observe(
      doc.documentElement,
      { childList: true, subtree: true, attributes: true },
      (records) => {
        if (scope.signal.aborted || scheduled) return;
        const relevant = records.some((record) => {
          if (ownHosts.has(record.target)) return false;
          if (record.type !== 'childList') return true;
          const changed = [...record.addedNodes, ...record.removedNodes];
          return (
            changed.some((node) => !ownHosts.has(node)) ||
            Array.from(record.removedNodes).some((node) => liveHosts.has(node))
          );
        });
        if (!relevant) return;
        scheduled = true;
        scope.timer(() => {
          scheduled = false;
          reconcile();
        }, DISCOVERY_DELAY_MS);
      },
    );
  },
};
