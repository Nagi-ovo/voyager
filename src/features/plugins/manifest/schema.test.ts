/**
 * The published JSON Schemas (`docs/public/plugin.schema.json`,
 * `docs/public/site.schema.json`) are hand-written editor tooling; the runtime
 * validators are the authority. That split only helps authors while the two
 * agree, so this pins them together:
 *
 *   - every bundled `plugin.json` / `site.json` satisfies BOTH the schema and
 *     its validator;
 *   - every key a validator emits is described by the schema (checked in a
 *     strict mode that rejects any property the schema does not name), against
 *     the shipped DeepSeek formula-copy manifest and a hand-built manifest that
 *     exercises every documented field;
 *   - the enums and bounds a schema copies out of the source — the semantic
 *     vocabulary, the primitive name pattern, the manifest format, the DOM-op
 *     and stylesheet ceilings — still match their constants.
 *
 * The structural checker below is deliberately tiny and local: the repository
 * ships no JSON Schema validator (D17: no schema library), and adding ajv to
 * assert this would be a runtime dependency bought for one test file. It covers
 * exactly the keywords these two schemas use.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MAX_DOM_OPS, MAX_STYLE_LENGTH, PLUGIN_MANIFEST_FORMAT } from '../constants';
import { SEMANTIC_SELECTOR_KEYS } from '../sites/semanticKeys';
import { siteAdapterToData, validateSiteAdapterData } from '../sites/siteAdapterData';
import { resolveStyleFileContributions } from '../sources/styleFiles';
import { PRIMITIVE_NAME_PATTERN } from '../verbs/contracts';
import { validateManifest } from './validate';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalogSites = join(repoRoot, 'src/features/plugins/catalog/sites');

type JsonSchema = Record<string, unknown>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const pluginSchema = readJson(join(repoRoot, 'docs/public/plugin.schema.json')) as JsonSchema;
const siteSchema = readJson(join(repoRoot, 'docs/public/site.schema.json')) as JsonSchema;

// ---------------------------------------------------------------------------
// A minimal JSON Schema (draft 2020-12) checker — only the keywords used here
// ---------------------------------------------------------------------------

interface CheckOptions {
  /**
   * Report every object property the schema does not name, as if each object
   * schema carried `additionalProperties: false`. This is how "the schema
   * documents every field the validator emits" is asserted; normal validation
   * stays lenient, matching the validators, which ignore unknown keys.
   */
  readonly strictProperties?: boolean;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return jsonType(value) === type;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchema) : null;
}

/** Own enumerable properties, treating an explicitly-undefined value as absent. */
function definedEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([, item]) => item !== undefined);
}

function checkSchema(
  value: unknown,
  schema: JsonSchema | boolean,
  root: JsonSchema,
  options: CheckOptions,
  path: string,
): string[] {
  if (typeof schema === 'boolean') return schema ? [] : [`${path}: no value is allowed here`];

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (!target) return [`${path}: unresolvable $ref "${schema.$ref}"`];
    return checkSchema(value, target, root, options, path);
  }

  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${jsonType(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match /${schema.pattern}/`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(
          ...checkSchema(
            item,
            schema.items as JsonSchema | boolean,
            root,
            options,
            `${path}[${index}]`,
          ),
        );
      });
    }
  }

  if (jsonType(value) === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const additional = schema.additionalProperties;

    for (const key of (schema.required ?? []) as string[]) {
      if (object[key] === undefined) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, item] of definedEntries(object)) {
      const child = `${path}.${key}`;
      if (schema.propertyNames !== undefined) {
        errors.push(
          ...checkSchema(key, schema.propertyNames as JsonSchema, root, options, `${child} (name)`),
        );
      }
      if (properties[key] !== undefined) {
        errors.push(...checkSchema(item, properties[key], root, options, child));
        continue;
      }
      if (additional !== undefined && additional !== false && additional !== true) {
        errors.push(...checkSchema(item, additional as JsonSchema, root, options, child));
        continue;
      }
      // Only a schema that actually names properties can call a key
      // undescribed. A composition wrapper (`anyOf` / `oneOf` with no
      // `properties` of its own) describes nothing directly — its branches do,
      // and one of them matching is what counts.
      if (
        additional === false ||
        (options.strictProperties && schema.properties !== undefined && additional === undefined)
      ) {
        errors.push(`${child}: not described by the schema`);
      }
    }
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword] as (JsonSchema | boolean)[] | undefined;
    if (!Array.isArray(branches)) continue;
    const failures = branches.map((branch) =>
      checkSchema(value, branch, root, options, `${path}<${keyword}>`),
    );
    const passing = failures.filter((branch) => branch.length === 0).length;
    if (keyword === 'anyOf' && passing === 0) {
      errors.push(`${path}: matched no anyOf branch (${failures.flat().join('; ')})`);
    }
    if (keyword === 'oneOf' && passing !== 1) {
      errors.push(`${path}: matched ${passing} oneOf branches, expected exactly 1`);
    }
  }

  return errors;
}

function check(value: unknown, schema: JsonSchema, options: CheckOptions = {}): string[] {
  return checkSchema(value, schema, schema, options, '$');
}

/** JSON round trip: drops `undefined`, mirroring what a published file carries. */
function serialized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface BundledPlugin {
  readonly label: string;
  readonly dir: string;
  readonly raw: Record<string, unknown>;
}

function listBundledPlugins(): readonly BundledPlugin[] {
  const plugins: BundledPlugin[] = [];
  for (const site of listDirs(catalogSites)) {
    for (const plugin of listDirs(join(catalogSites, site, 'plugins'))) {
      const dir = join(catalogSites, site, 'plugins', plugin);
      plugins.push({
        label: relative(repoRoot, dir),
        dir,
        raw: readJson(join(dir, 'plugin.json')) as Record<string, unknown>,
      });
    }
  }
  return plugins;
}

function listDirs(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listBundledSites(): readonly { label: string; raw: Record<string, unknown> }[] {
  return listDirs(catalogSites).map((site) => ({
    label: `sites/${site}`,
    raw: readJson(join(catalogSites, site, 'site.json')) as Record<string, unknown>,
  }));
}

async function inlineStyles(plugin: BundledPlugin): Promise<unknown> {
  return resolveStyleFileContributions(plugin.raw, plugin.label, async (file) =>
    readFileSync(join(plugin.dir, file), 'utf8'),
  );
}

/**
 * Every field a manifest may carry, so the "schema describes what the validator
 * emits" check has something to bite on. `formulaCopy` is a real primitive; the
 * manifest validator does not resolve handlers, so any name would do, but using
 * a real one keeps the fixture honest.
 */
const EVERY_FIELD_MANIFEST: Record<string, unknown> = {
  $schema: 'https://voyager.nagi.fun/plugin.schema.json',
  id: 'fixture.every-field',
  name: 'Fixture · Every Field',
  version: '2.0.1',
  description: 'A manifest that uses every documented field.',
  author: 'voyager-official',
  category: 'productivity',
  license: 'MIT',
  homepage: 'https://example.invalid/fixture',
  engine: '>=1.3.0',
  tier: 'declarative',
  format: 1,
  changelog: 'Uses every field at once.',
  matches: ['https://demo.example/*'],
  theme: { brand: '#d97757' },
  requires: { handlers: ['formulaCopy'], semantic: ['composer'] },
  contributes: {
    styles: [{ css: 'body { color: red; }', source: 'style.css' }],
    settings: {
      width: {
        type: 'number',
        label: 'Reading width (px)',
        default: 768,
        min: 600,
        max: 1600,
        minLabel: 'Narrower',
        maxLabel: 'Wider',
      },
      centered: { type: 'boolean', label: 'Center content', default: false },
      title: { type: 'string', label: 'Title', default: 'Hello' },
      accent: { type: 'color', label: 'Accent', default: '#00ff00' },
      density: {
        type: 'select',
        label: 'Density',
        default: 'cozy',
        options: [
          { value: 'cozy', label: 'Cozy' },
          { value: 'compact', label: 'Compact' },
        ],
      },
    },
    domOps: [
      { op: 'addClass', target: 'body', className: 'gv-plugin-fixture' },
      {
        op: 'setAttribute',
        target: { kind: 'css', selector: 'body' },
        name: 'data-gv-fixture',
        value: 'on',
      },
      {
        op: 'setStyle',
        target: { kind: 'semantic', key: 'composer' },
        styles: { '--gv-plugin-reading-width': '768px' },
      },
      { op: 'hide', target: { kind: 'semantic', key: 'sidebar' } },
      {
        op: 'native',
        handler: 'formulaCopy',
        params: { scope: 'assistant', nested: { on: true } },
      },
    ],
  },
  i18n: {
    zh: {
      name: '固件 · 全字段',
      description: '一个用到全部字段的清单。',
      changelog: '一次用到全部字段。',
      settings: { width: { label: '阅读宽度', minLabel: '更窄', maxLabel: '更宽' } },
    },
  },
};

// ---------------------------------------------------------------------------

describe('published JSON Schemas', () => {
  it('are draft 2020-12 documents published at their documented URLs', () => {
    expect(pluginSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(pluginSchema.$id).toBe('https://voyager.nagi.fun/plugin.schema.json');
    expect(siteSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(siteSchema.$id).toBe('https://voyager.nagi.fun/site.schema.json');
  });

  it('copy the semantic vocabulary, primitive pattern and bounds from the source', () => {
    const selectors = (siteSchema.properties as Record<string, JsonSchema>).selectors;
    const propertyNames = selectors.propertyNames as { enum: string[] };
    expect([...propertyNames.enum].sort()).toEqual([...SEMANTIC_SELECTOR_KEYS].sort());

    const defs = pluginSchema.$defs as Record<string, JsonSchema>;
    const nativeOp = (defs.domOperation.oneOf as JsonSchema[]).find(
      (branch) => branch.title === 'native',
    );
    if (!nativeOp) throw new Error('plugin.schema.json lost its native DOM-op branch');
    const handler = (nativeOp.properties as Record<string, JsonSchema>).handler;
    expect(handler.pattern).toBe(PRIMITIVE_NAME_PATTERN.source);

    const properties = pluginSchema.properties as Record<string, JsonSchema>;
    expect(properties.format.const).toBe(PLUGIN_MANIFEST_FORMAT);
    const contributes = defs.contributions.properties as Record<string, JsonSchema>;
    expect(contributes.domOps.maxItems).toBe(MAX_DOM_OPS);
    const inlineCss = (defs.styleContribution.anyOf as JsonSchema[])[1];
    expect((inlineCss.properties as Record<string, JsonSchema>).css.maxLength).toBe(
      MAX_STYLE_LENGTH,
    );
  });
});

describe('plugin.schema.json', () => {
  const bundled = listBundledPlugins();

  it('finds the bundled plugins', () => {
    expect(bundled.length).toBeGreaterThan(0);
  });

  it.each(bundled.map((plugin) => [plugin.label, plugin] as const))(
    'accepts %s, and so does validateManifest',
    async (_label, plugin) => {
      expect(check(plugin.raw, pluginSchema)).toEqual([]);
      const result = validateManifest(await inlineStyles(plugin));
      expect(result.success ? [] : result.error).toEqual([]);
    },
  );

  it('describes every key validateManifest emits for the DeepSeek formula-copy plugin', async () => {
    const plugin = bundled.find((entry) => entry.label.includes('deepseek/plugins/formula-copy'));
    if (!plugin) throw new Error('the DeepSeek formula-copy plugin is missing from the catalog');

    const result = validateManifest(await inlineStyles(plugin));
    expect(result.success).toBe(true);
    if (!result.success) return;
    // It is the only bundled plugin carrying `requires`, `changelog` and a
    // `native` op, so it is the one that exercises those schema branches.
    expect(result.data.requires).toEqual({ handlers: ['formulaCopy'] });
    expect(check(serialized(result.data), pluginSchema, { strictProperties: true })).toEqual([]);
  });

  it('describes every key of a manifest that uses every field', () => {
    expect(check(EVERY_FIELD_MANIFEST, pluginSchema)).toEqual([]);

    const result = validateManifest(EVERY_FIELD_MANIFEST);
    expect(result.success ? [] : result.error).toEqual([]);
    if (!result.success) return;
    expect(check(serialized(result.data), pluginSchema, { strictProperties: true })).toEqual([]);
  });

  it('notices an undescribed key in strict mode, and ignores it otherwise', () => {
    // Guards the two checks above: without this, "the schema describes every
    // emitted key" would still pass if strict mode quietly did nothing.
    const extra = { ...EVERY_FIELD_MANIFEST, sideEffects: ['none'] };
    expect(check(extra, pluginSchema)).toEqual([]);
    expect(check(extra, pluginSchema, { strictProperties: true })).toEqual([
      '$.sideEffects: not described by the schema',
    ]);
    // The validator ignores it too — the schema is not stricter than the code.
    expect(validateManifest(extra).success).toBe(true);
  });

  it('rejects manifests the validator also rejects', () => {
    const base = EVERY_FIELD_MANIFEST;
    const without = (key: string): unknown => {
      const copy = { ...base } as Record<string, unknown>;
      delete copy[key];
      return copy;
    };

    expect(check(without('id'), pluginSchema)).toContain('$: missing required "id"');
    expect(check(without('contributes'), pluginSchema)).toContain(
      '$: missing required "contributes"',
    );
    expect(check({ ...base, tier: 'native' }, pluginSchema).join('\n')).toMatch(/\$\.tier/);
    expect(check({ ...base, format: 2 }, pluginSchema).join('\n')).toMatch(/\$\.format/);
    expect(check({ ...base, theme: { brand: 'red' } }, pluginSchema).join('\n')).toMatch(
      /\$\.theme\.brand/,
    );
    expect(check({ ...base, matches: [] }, pluginSchema).join('\n')).toMatch(/\$\.matches/);

    // Same shapes, through the validator: the schema is not stricter than it.
    for (const broken of [
      without('id'),
      without('contributes'),
      { ...base, tier: 'native' },
      { ...base, format: 2 },
      { ...base, theme: { brand: 'red' } },
      { ...base, matches: [] },
    ]) {
      expect(validateManifest(broken).success).toBe(false);
    }
  });

  it('rejects a DOM operation whose op is not a known variant', () => {
    const manifest = {
      ...EVERY_FIELD_MANIFEST,
      contributes: { domOps: [{ op: 'eval', target: 'body', code: 'alert(1)' }] },
    };
    expect(check(manifest, pluginSchema).join('\n')).toMatch(/domOps\[0\].*oneOf/s);
    expect(validateManifest(manifest).success).toBe(false);
  });
});

describe('site.schema.json', () => {
  const sites = listBundledSites();

  it('finds the bundled sites', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(sites.map((site) => [site.label, site.raw] as const))(
    'accepts %s, and so does validateSiteAdapterData',
    (_label, raw) => {
      expect(check(raw, siteSchema)).toEqual([]);
      const result = validateSiteAdapterData(raw);
      expect(result.success ? [] : result.error).toEqual([]);
      if (!result.success) return;
      // `capabilities` is a Set on the adapter; the published/serializable form
      // is what a site.json actually looks like.
      expect(check(siteAdapterToData(result.data), siteSchema, { strictProperties: true })).toEqual(
        [],
      );
    },
  );

  it('rejects site documents the validator also rejects', () => {
    const base = listBundledSites()[0].raw;

    const noId = { ...base } as Record<string, unknown>;
    delete noId.id;
    expect(check(noId, siteSchema)).toContain('$: missing required "id"');

    const badKey = { ...base, selectors: { ...(base.selectors as object), notAKey: 'div' } };
    expect(check(badKey, siteSchema).join('\n')).toMatch(/notAKey/);

    const badCapability = { ...base, capabilities: ['chat', 'teleport'] };
    expect(check(badCapability, siteSchema).join('\n')).toMatch(/capabilities\[1\]/);

    const badTheme = { ...base, theme: { hostSelector: 'html' } };
    expect(check(badTheme, siteSchema).join('\n')).toMatch(/lightSelector/);

    for (const broken of [noId, badKey, badCapability, badTheme]) {
      expect(validateSiteAdapterData(broken).success).toBe(false);
    }
  });
});
