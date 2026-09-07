/**
 * Manifest validation + normalization.
 *
 * Plugins from a remote marketplace are UNTRUSTED input. This validator turns an
 * arbitrary `unknown` into a typed `PluginManifest` (or a list of issues),
 * normalizing authoring sugar along the way (a bare selector string becomes a
 * `{kind:'css'}` ref). Custom type guards are used instead of a schema library
 * to avoid adding a runtime dependency (the codebase has no zod).
 */
import type { Result } from '@/core/types/common';

import { MAX_DOM_OPS, MAX_STYLE_LENGTH, PLUGIN_MANIFEST_FORMAT } from '../constants';
import type {
  DomOperation,
  LocalizedSettingField,
  PluginContributions,
  PluginLocalization,
  PluginManifest,
  PluginRequirements,
  PluginTheme,
  PluginTier,
  SelectorRef,
  SettingField,
  SettingsSchema,
  StyleContribution,
} from '../types';
import { PRIMITIVE_NAME_PATTERN } from '../verbs/contracts';

const SETTING_TYPES = ['boolean', 'number', 'string', 'color', 'select'] as const;

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

const TIERS = ['declarative', 'scripted'] as const;
const OP_KINDS = ['addClass', 'setAttribute', 'setStyle', 'hide', 'native'] as const;
/** Bounds on `native` op params (UNTRUSTED configuration, never instructions). */
const MAX_PARAMS_DEPTH = 4;
const MAX_PARAMS_KEYS = 50;
const MAX_PARAM_STRING_LENGTH = 2_000;
const MAX_REQUIRES_ENTRIES = 50;
const MAX_CHANGELOG_LENGTH = 500;
const REQUIRED_STRINGS = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'category',
  'license',
  'engine',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Accept ONLY hex colours for a plugin-declared brand. The value is injected
 * into a CSS custom property and string-concatenated into a `color-mix(...)`
 * expression at runtime, so anything other than a strict hex literal (3/4/6/8
 * digits) could break out of the value context — reject it.
 */
function isHexColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  );
}

/** Per-field cap for localized strings (UNTRUSTED input). */
const MAX_I18N_FIELD_LENGTH = 500;

function readOptionalString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  issues?: ManifestIssue[],
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (nonEmptyString(value) && value.length <= MAX_I18N_FIELD_LENGTH) return value;
  issues?.push({
    path,
    message: `must be a non-empty string up to ${MAX_I18N_FIELD_LENGTH} chars`,
  });
  return undefined;
}

function normalizeLocalizedSetting(raw: unknown): LocalizedSettingField | undefined {
  if (!isRecord(raw)) return undefined;
  const label = readOptionalString(raw, 'label', 'label');
  const minLabel = readOptionalString(raw, 'minLabel', 'minLabel');
  const maxLabel = readOptionalString(raw, 'maxLabel', 'maxLabel');
  const entry: LocalizedSettingField = {
    ...(label ? { label } : {}),
    ...(minLabel ? { minLabel } : {}),
    ...(maxLabel ? { maxLabel } : {}),
  };
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function normalizeLocalizedSettings(
  raw: unknown,
): Readonly<Record<string, LocalizedSettingField>> | undefined {
  if (!isRecord(raw)) return undefined;
  const settings: Record<string, LocalizedSettingField> = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizeLocalizedSetting(value);
    if (entry) settings[key] = entry;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Sanitize an optional `i18n` map (UNTRUSTED). Keeps only localized metadata and
 * setting labels whose fields are non-oversized strings; drops everything else.
 * Returns undefined when nothing survives, so the field is absent on the manifest.
 */
function normalizeI18n(raw: unknown): Readonly<Record<string, PluginLocalization>> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, PluginLocalization> = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const entry: {
      name?: string;
      description?: string;
      changelog?: string;
      settings?: Readonly<Record<string, LocalizedSettingField>>;
    } = {};
    // A blank localized changelog would hide the top-level one in the popup.
    if (nonEmptyString(value.changelog) && value.changelog.length <= MAX_CHANGELOG_LENGTH) {
      entry.changelog = value.changelog;
    }
    if (isString(value.name) && value.name.length <= MAX_I18N_FIELD_LENGTH) {
      entry.name = value.name;
    }
    if (isString(value.description) && value.description.length <= MAX_I18N_FIELD_LENGTH) {
      entry.description = value.description;
    }
    const settings = normalizeLocalizedSettings(value.settings);
    if (settings) entry.settings = settings;
    if (
      entry.name !== undefined ||
      entry.description !== undefined ||
      entry.changelog !== undefined ||
      entry.settings !== undefined
    )
      out[locale] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Reject CSS that can fetch remote resources — `@import` and external `url()`
 * (http(s):// or protocol-relative //). A declarative plugin is meant to be
 * self-contained data; remote fetches enable tracking/exfiltration and defeat
 * the "no remotely-hosted code/resources" posture. `data:` URIs stay allowed.
 */
function cssHasExternalUrl(css: string): boolean {
  return /url\(\s*['"]?\s*(?:https?:)?\/\//i.test(css);
}

function cssHasRemoteResource(css: string): boolean {
  return /@import\b/i.test(css) || cssHasExternalUrl(css);
}

export function validateStyleCss(css: string, path: string): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (css.length > MAX_STYLE_LENGTH) {
    issues.push({ path, message: `exceeds ${MAX_STYLE_LENGTH} chars` });
  }
  if (cssHasRemoteResource(css)) {
    issues.push({
      path,
      message: 'must not use @import or external url() (remote-resource fetch)',
    });
  }
  return issues;
}

/** Event-handler attributes (`onclick`, `onload`, …) inject executable code. */
function isEventHandlerAttribute(name: string): boolean {
  return /^on/i.test(name);
}

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

function hasExecutableAttributeUrl(name: string, value: string): boolean {
  return (
    URL_ATTRIBUTES.has(name.trim().toLowerCase()) &&
    /^(?:javascript|data|vbscript):/i.test(value.trim())
  );
}

function normalizeSelector(
  raw: unknown,
  path: string,
  issues: ManifestIssue[],
): SelectorRef | null {
  if (isString(raw)) {
    if (raw.trim() === '') {
      issues.push({ path, message: 'selector string is empty' });
      return null;
    }
    return { kind: 'css', selector: raw };
  }
  if (isRecord(raw) && (raw.kind === 'css' || raw.kind === 'semantic')) {
    if (raw.kind === 'css') {
      if (!nonEmptyString(raw.selector)) {
        issues.push({ path: `${path}.selector`, message: 'required non-empty string' });
        return null;
      }
      return { kind: 'css', selector: raw.selector };
    }
    if (!nonEmptyString(raw.key)) {
      issues.push({ path: `${path}.key`, message: 'required non-empty string' });
      return null;
    }
    return { kind: 'semantic', key: raw.key };
  }
  issues.push({ path, message: 'expected a selector string or {kind:"css"|"semantic"}' });
  return null;
}

/**
 * `native` op params are plain JSON configuration: primitives, arrays and
 * objects of those, bounded in depth, count and string length. Anything else
 * (functions cannot arrive through JSON, but prototype keys and oversized
 * blobs can) is rejected.
 */
function isPlainParamValue(value: unknown, depth: number): boolean {
  if (depth > MAX_PARAMS_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (typeof value === 'string') return value.length <= MAX_PARAM_STRING_LENGTH;
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_PARAMS_KEYS && value.every((item) => isPlainParamValue(item, depth + 1))
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_PARAMS_KEYS &&
      entries.every(
        ([key, item]) =>
          key !== '__proto__' &&
          key !== 'constructor' &&
          key !== 'prototype' &&
          isPlainParamValue(item, depth + 1),
      )
    );
  }
  return false;
}

function normalizeNativeOp(
  raw: Record<string, unknown>,
  path: string,
  issues: ManifestIssue[],
): DomOperation | null {
  if (!isString(raw.handler) || !PRIMITIVE_NAME_PATTERN.test(raw.handler)) {
    issues.push({ path: `${path}.handler`, message: 'must be a primitive name (camelCase)' });
    return null;
  }
  const params = raw.params === undefined ? {} : raw.params;
  if (!isRecord(params) || !isPlainParamValue(params, 0)) {
    issues.push({ path: `${path}.params`, message: 'must be a plain JSON object of bounded size' });
    return null;
  }
  return { op: 'native', handler: raw.handler, params };
}

function normalizeOp(raw: unknown, path: string, issues: ManifestIssue[]): DomOperation | null {
  if (!isRecord(raw) || !isString(raw.op) || !(OP_KINDS as readonly string[]).includes(raw.op)) {
    issues.push({ path: `${path}.op`, message: `must be one of ${OP_KINDS.join(', ')}` });
    return null;
  }
  if (raw.op === 'native') return normalizeNativeOp(raw, path, issues);
  const target = normalizeSelector(raw.target, `${path}.target`, issues);
  if (!target) return null;

  switch (raw.op) {
    case 'addClass':
      if (!nonEmptyString(raw.className)) {
        issues.push({ path: `${path}.className`, message: 'required non-empty string' });
        return null;
      }
      return { op: 'addClass', target, className: raw.className };
    case 'hide':
      return { op: 'hide', target };
    case 'setAttribute':
      if (!nonEmptyString(raw.name) || !isString(raw.value)) {
        issues.push({
          path,
          message: 'setAttribute requires a non-empty `name` and string `value`',
        });
        return null;
      }
      if (isEventHandlerAttribute(raw.name)) {
        issues.push({
          path: `${path}.name`,
          message: 'event-handler attributes (on*) are not allowed',
        });
        return null;
      }
      if (hasExecutableAttributeUrl(raw.name, raw.value)) {
        issues.push({
          path: `${path}.value`,
          message: 'executable or data URLs are not allowed for URL attributes',
        });
        return null;
      }
      return { op: 'setAttribute', target, name: raw.name, value: raw.value };
    case 'setStyle': {
      if (!isRecord(raw.styles)) {
        issues.push({ path: `${path}.styles`, message: 'required object of CSS prop -> value' });
        return null;
      }
      const styles: Record<string, string> = {};
      for (const [prop, value] of Object.entries(raw.styles)) {
        if (!isString(value)) {
          issues.push({ path: `${path}.styles.${prop}`, message: 'value must be a string' });
          return null;
        }
        if (cssHasExternalUrl(value)) {
          issues.push({
            path: `${path}.styles.${prop}`,
            message: 'must not use an external url() (remote-resource fetch)',
          });
          return null;
        }
        styles[prop] = value;
      }
      return { op: 'setStyle', target, styles };
    }
    default:
      return null;
  }
}

function normalizeContributions(raw: unknown, issues: ManifestIssue[]): PluginContributions {
  if (!isRecord(raw)) {
    issues.push({ path: 'contributes', message: 'required object' });
    return {};
  }
  const result: {
    styles?: StyleContribution[];
    domOps?: DomOperation[];
    settings?: SettingsSchema;
  } = {};

  if (raw.styles !== undefined) {
    if (!Array.isArray(raw.styles)) {
      issues.push({ path: 'contributes.styles', message: 'must be an array' });
    } else {
      const styles: StyleContribution[] = [];
      raw.styles.forEach((entry, index) => {
        if (!isRecord(entry) || !isString(entry.css)) {
          issues.push({ path: `contributes.styles[${index}].css`, message: 'required string' });
          return;
        }
        const cssIssues = validateStyleCss(entry.css, `contributes.styles[${index}].css`);
        if (cssIssues.length > 0) {
          issues.push(...cssIssues);
          return;
        }
        styles.push({
          css: entry.css,
          ...(isString(entry.source) ? { source: entry.source } : {}),
        });
      });
      result.styles = styles;
    }
  }

  if (raw.domOps !== undefined) {
    if (!Array.isArray(raw.domOps)) {
      issues.push({ path: 'contributes.domOps', message: 'must be an array' });
    } else {
      if (raw.domOps.length > MAX_DOM_OPS) {
        issues.push({ path: 'contributes.domOps', message: `exceeds max of ${MAX_DOM_OPS}` });
      }
      const ops: DomOperation[] = [];
      raw.domOps.slice(0, MAX_DOM_OPS).forEach((rawOp, index) => {
        const op = normalizeOp(rawOp, `contributes.domOps[${index}]`, issues);
        if (op) ops.push(op);
      });
      result.domOps = ops;
    }
  }

  if (raw.settings !== undefined) {
    if (!isRecord(raw.settings)) {
      issues.push({ path: 'contributes.settings', message: 'must be an object' });
    } else {
      const settings: Record<string, SettingField> = {};
      for (const [key, rawField] of Object.entries(raw.settings)) {
        const path = `contributes.settings.${key}`;
        if (
          !isRecord(rawField) ||
          !isString(rawField.type) ||
          !(SETTING_TYPES as readonly string[]).includes(rawField.type)
        ) {
          issues.push({
            path: `${path}.type`,
            message: `must be one of ${SETTING_TYPES.join(', ')}`,
          });
          continue;
        }
        if (!nonEmptyString(rawField.label)) {
          issues.push({ path: `${path}.label`, message: 'required non-empty string' });
          continue;
        }
        const fallback = rawField.default;
        if (
          typeof fallback !== 'boolean' &&
          typeof fallback !== 'number' &&
          typeof fallback !== 'string'
        ) {
          issues.push({ path: `${path}.default`, message: 'required boolean | number | string' });
          continue;
        }
        const minLabel = readOptionalString(rawField, 'minLabel', `${path}.minLabel`, issues);
        const maxLabel = readOptionalString(rawField, 'maxLabel', `${path}.maxLabel`, issues);
        settings[key] = {
          type: rawField.type as SettingField['type'],
          label: rawField.label,
          default: fallback,
          ...(minLabel ? { minLabel } : {}),
          ...(maxLabel ? { maxLabel } : {}),
          ...(typeof rawField.min === 'number' ? { min: rawField.min } : {}),
          ...(typeof rawField.max === 'number' ? { max: rawField.max } : {}),
          ...(Array.isArray(rawField.options)
            ? {
                options: rawField.options.filter(
                  (option): option is { value: string; label: string } =>
                    isRecord(option) && isString(option.value) && isString(option.label),
                ),
              }
            : {}),
        };
      }
      result.settings = settings;
    }
  }

  return result;
}

function normalizeStringList(
  raw: unknown,
  path: string,
  issues: ManifestIssue[],
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_REQUIRES_ENTRIES ||
    !raw.every((entry) => nonEmptyString(entry) && entry.length <= 100)
  ) {
    issues.push({ path, message: 'must be an array of short non-empty strings' });
    return undefined;
  }
  return Array.from(new Set(raw as string[]));
}

function normalizeRequires(raw: unknown, issues: ManifestIssue[]): PluginRequirements | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push({ path: 'requires', message: 'must be an object' });
    return undefined;
  }
  const handlers = normalizeStringList(raw.handlers, 'requires.handlers', issues);
  const semantic = normalizeStringList(raw.semantic, 'requires.semantic', issues);
  if (handlers?.some((name) => !PRIMITIVE_NAME_PATTERN.test(name))) {
    issues.push({ path: 'requires.handlers', message: 'entries must be primitive names' });
  }
  if (!handlers && !semantic) return undefined;
  return { ...(handlers ? { handlers } : {}), ...(semantic ? { semantic } : {}) };
}

export function validateManifest(input: unknown): Result<PluginManifest, ManifestIssue[]> {
  if (!isRecord(input)) {
    return { success: false, error: [{ path: '', message: 'manifest must be an object' }] };
  }
  const issues: ManifestIssue[] = [];

  if (input.format !== undefined && input.format !== PLUGIN_MANIFEST_FORMAT) {
    issues.push({
      path: 'format',
      message: `unsupported manifest format (expected ${PLUGIN_MANIFEST_FORMAT})`,
    });
  }
  const requires = normalizeRequires(input.requires, issues);
  let changelog: string | undefined;
  if (input.changelog !== undefined) {
    if (nonEmptyString(input.changelog) && input.changelog.length <= MAX_CHANGELOG_LENGTH) {
      changelog = input.changelog;
    } else {
      issues.push({
        path: 'changelog',
        message: `must be a non-empty string up to ${MAX_CHANGELOG_LENGTH} chars`,
      });
    }
  }

  for (const key of REQUIRED_STRINGS) {
    if (!nonEmptyString(input[key]))
      issues.push({ path: key, message: 'required non-empty string' });
  }
  if (!isString(input.tier) || !(TIERS as readonly string[]).includes(input.tier)) {
    issues.push({ path: 'tier', message: `must be one of ${TIERS.join(', ')}` });
  }
  if (
    !Array.isArray(input.matches) ||
    input.matches.length === 0 ||
    !input.matches.every(nonEmptyString)
  ) {
    issues.push({ path: 'matches', message: 'must be a non-empty array of non-empty strings' });
  }

  const contributes = normalizeContributions(input.contributes, issues);

  let theme: PluginTheme | undefined;
  if (input.theme !== undefined) {
    if (!isRecord(input.theme) || !isHexColor(input.theme.brand)) {
      issues.push({ path: 'theme.brand', message: 'must be a hex colour string (e.g. #d97757)' });
    } else {
      theme = { brand: input.theme.brand };
    }
  }

  const i18n = normalizeI18n(input.i18n);

  if (issues.length > 0) return { success: false, error: issues };

  const manifest: PluginManifest = {
    id: input.id as string,
    name: input.name as string,
    version: input.version as string,
    description: input.description as string,
    author: input.author as string,
    category: input.category as string,
    license: input.license as string,
    homepage: isString(input.homepage) ? input.homepage : undefined,
    engine: input.engine as string,
    tier: input.tier as PluginTier,
    matches: (input.matches as string[]).slice(),
    contributes,
    ...(theme ? { theme } : {}),
    ...(typeof input.format === 'number' ? { format: input.format } : {}),
    ...(requires ? { requires } : {}),
    ...(changelog ? { changelog } : {}),
    ...(i18n ? { i18n } : {}),
  };
  return { success: true, data: manifest };
}
