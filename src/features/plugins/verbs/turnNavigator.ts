/**
 * `turnNavigator` primitive (plan §6): the conversation timeline rail. Every
 * parameter is optional; defaults come from the site adapter so a manifest
 * usually needs no more than `{ "op": "native", "handler": "turnNavigator" }`.
 */
import { logger } from '@/core/services/LoggerService';

import type { ManifestIssue } from '../manifest/validate';
import { isSafeRegexSource } from '../sites/safeRegex';
import { getPrimitiveContract } from './contracts';
import {
  TIMELINE_STYLE_COACHMARK_ID,
  type TurnNavigatorConfig,
  activateTurnNavigator,
} from './turnNavigator/TurnNavigator';
import type { Primitive } from './types';

export interface TurnNavigatorParams {
  readonly turn?: string;
  readonly conversationIdPattern?: string;
  readonly scrollContainer?: string;
  readonly yieldWhen?: string;
  readonly position?: 'left' | 'right';
}

const MAX_SELECTOR_LENGTH = 2_000;
const SELECTOR_PARAMS = ['turn', 'scrollContainer', 'yieldWhen'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SELECTOR_LENGTH
  );
}

export const turnNavigatorPrimitive: Primitive<TurnNavigatorParams> = {
  contract: getPrimitiveContract('turnNavigator')!,

  validateParams(raw: unknown) {
    if (raw !== undefined && !isRecord(raw)) {
      return { success: false, error: [{ path: 'params', message: 'must be an object' }] };
    }
    const issues: ManifestIssue[] = [];
    const params: {
      turn?: string;
      conversationIdPattern?: string;
      scrollContainer?: string;
      yieldWhen?: string;
      position?: 'left' | 'right';
    } = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if ((SELECTOR_PARAMS as readonly string[]).includes(key)) {
        if (!isSelector(value)) {
          issues.push({ path: `params.${key}`, message: 'must be a non-empty selector' });
        } else {
          params[key as (typeof SELECTOR_PARAMS)[number]] = value;
        }
        continue;
      }
      if (key === 'conversationIdPattern') {
        if (!isSelector(value)) {
          issues.push({
            path: 'params.conversationIdPattern',
            message: 'must be a non-empty string',
          });
          continue;
        }
        if (isSafeRegexSource(value)) {
          params.conversationIdPattern = value;
        } else {
          issues.push({
            path: 'params.conversationIdPattern',
            message:
              'must be a valid regular expression without lookarounds, backreferences or nested quantifiers',
          });
        }
        continue;
      }
      if (key === 'position') {
        if (value === 'left' || value === 'right') params.position = value;
        else issues.push({ path: 'params.position', message: 'must be "left" or "right"' });
        continue;
      }
      issues.push({ path: `params.${key}`, message: 'unknown parameter' });
    }
    return issues.length > 0 ? { success: false, error: issues } : { success: true, data: params };
  },

  activate(scope, params, context) {
    const adapter = context.adapter;
    const turnSelector = params.turn ?? adapter?.selectors.userTurn;
    if (!turnSelector) {
      // The status machine reports needs-semantic before this can happen;
      // stay inert rather than index nothing.
      logger.warn('turnNavigator: no turn selector for this site', { id: context.pluginId });
      context.setTargetCounter(() => 0);
      return;
    }
    context.setTargetCounter(() => {
      try {
        return context.doc.querySelectorAll(turnSelector).length;
      } catch {
        return 0;
      }
    });
    const config: TurnNavigatorConfig = {
      siteId: adapter?.id ?? 'site',
      siteLabel: adapter?.label ?? 'Conversation',
      turnSelector,
      conversationIdPattern: params.conversationIdPattern ?? adapter?.conversationIdPattern,
      scrollContainerSelector: params.scrollContainer,
      yieldWhenSelector: params.yieldWhen,
      position: params.position ?? 'right',
      pluginId: context.pluginId,
      coachmarkId: TIMELINE_STYLE_COACHMARK_ID,
    };
    return activateTurnNavigator(scope, config, context.settings);
  },
};
