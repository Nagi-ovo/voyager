import type { ManifestIssue } from '../manifest/validate';
import { activateCodeCollapse } from './codeCollapse/runtime';
import { getPrimitiveContract } from './contracts';
import type { Primitive } from './types';

export interface CodeCollapseParams {
  readonly code?: string;
  readonly thresholdLines?: number;
}

export const DEFAULT_THRESHOLD_LINES = 20;

export function isThresholdLines(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 5 && value <= 200;
}

export const codeCollapsePrimitive: Primitive<CodeCollapseParams> = {
  contract: getPrimitiveContract('codeCollapse')!,
  validateParams(raw: unknown) {
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      return { success: false, error: [{ path: 'params', message: 'must be an object' }] };
    }
    const issues: ManifestIssue[] = [];
    const params: { code?: string; thresholdLines?: number } = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (key === 'code') {
        if (typeof value === 'string' && value.trim() && value.length <= 2_000) params.code = value;
        else issues.push({ path: 'params.code', message: 'must be a non-empty selector' });
      } else if (key === 'thresholdLines') {
        if (isThresholdLines(value)) params.thresholdLines = value;
        else
          issues.push({ path: 'params.thresholdLines', message: 'must be a number from 5 to 200' });
      } else issues.push({ path: 'params.' + key, message: 'unknown parameter' });
    }
    return issues.length ? { success: false, error: issues } : { success: true, data: params };
  },
  activate: activateCodeCollapse,
};
