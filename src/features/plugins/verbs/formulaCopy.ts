/**
 * `formulaCopy` primitive (plan §6): Voyager's formula-copy feature, unchanged,
 * exposed to declarative plugins. A plugin turns it on for its site with
 *
 *   { "op": "native", "handler": "formulaCopy", "params": {} }
 *
 * The builtin `voyager.formula-copy` plugin keeps its own binding until P4
 * rewrites it as JSON; both paths call the same activation.
 */
import { activateFormulaCopy } from '@/features/formulaCopy';

import type { ManifestIssue } from '../manifest/validate';
import { getPrimitiveContract } from './contracts';
import type { Primitive } from './types';

export type FormulaCopyParams = Readonly<Record<string, never>>;

/** Markup the service recognises (Gemini data-math, KaTeX, MathJax, AI Studio). */
const FORMULA_TARGET_SELECTOR =
  '[data-math], .katex, .katex-display, ms-katex, .math-inline, .math-display, .math-block, mjx-container';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const formulaCopyPrimitive: Primitive<FormulaCopyParams> = {
  contract: getPrimitiveContract('formulaCopy')!,

  validateParams(raw: unknown) {
    const issues: ManifestIssue[] = [];
    if (raw !== undefined && !isRecord(raw)) {
      issues.push({ path: 'params', message: 'must be an object' });
    } else if (raw) {
      for (const key of Object.keys(raw)) {
        issues.push({ path: `params.${key}`, message: 'unknown parameter' });
      }
    }
    return issues.length > 0 ? { success: false, error: issues } : { success: true, data: {} };
  },

  activate(scope, _params, context) {
    context.setTargetCounter(() => context.doc.querySelectorAll(FORMULA_TARGET_SELECTOR).length);
    activateFormulaCopy(scope);
  },
};
