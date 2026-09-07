/**
 * `vimInput` primitive (plan §6): Vim-style modal editing in the prompt
 * composer, built on `chatInput/vimMode.ts`. The composer is located through
 * the site adapter's `composer` semantic selector (or an explicit `composer`
 * param), so a site Voyager has no hard-coded selector for still works.
 */
import { findChatInput } from '@/pages/content/chatInput';
import { startInputVimMode } from '@/pages/content/chatInput/vimMode';

import type { ManifestIssue } from '../manifest/validate';
import { getPrimitiveContract } from './contracts';
import type { Primitive } from './types';

export interface VimInputParams {
  readonly composer?: string;
}

const MAX_SELECTOR_LENGTH = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const vimInputPrimitive: Primitive<VimInputParams> = {
  contract: getPrimitiveContract('vimInput')!,

  validateParams(raw: unknown) {
    const issues: ManifestIssue[] = [];
    if (raw !== undefined && !isRecord(raw)) {
      return { success: false, error: [{ path: 'params', message: 'must be an object' }] };
    }
    const params: { composer?: string } = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (key === 'composer') {
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR_LENGTH) {
          issues.push({ path: 'params.composer', message: 'must be a non-empty selector' });
        } else {
          params.composer = value;
        }
        continue;
      }
      issues.push({ path: `params.${key}`, message: 'unknown parameter' });
    }
    return issues.length > 0 ? { success: false, error: issues } : { success: true, data: params };
  },

  activate(scope, params, context) {
    const composer = params.composer ?? context.adapter?.selectors.composer;
    context.setTargetCounter(() => {
      if (composer) {
        try {
          return context.doc.querySelectorAll(composer).length;
        } catch {
          return 0;
        }
      }
      return findChatInput({ requireVisible: false }) ? 1 : 0;
    });
    // The async startup registers as a single scope effect: if the plugin is
    // disabled before it resolves, the scope pays the late cleanup itself.
    scope.effect(
      () => startInputVimMode({ forceEnabled: true, composerSelector: composer }),
      'input-vim',
    );
  },
};
