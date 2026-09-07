---
name: create-voyager-plugin
description: Build a Voyager plugin, a site adapter change, or a primitive, from picking the right path to the evidence a PR must carry. Use for "写一个插件", "add a plugin for <site>", a selector fix in site.json, a new native primitive under verbs/, or any change under src/features/plugins/catalog, verbs or sites.
metadata:
  version: '1.0.0'
---

# Create a Voyager plugin

Three layers ship separately, and the layer decides everything else: what you
write, what reviews it, and whether users get it without an extension release.

```
plugin    catalog/sites/<site>/plugins/<id>/   CSS + JSON      data, travels remotely
adapter   catalog/sites/<site>/site.json       selectors       data, travels remotely
primitive src/features/plugins/verbs/          TypeScript      code, ships in the package
```

Background, not a substitute for this file: `src/features/plugins/README.md`
and `docs/en/guide/plugin-contribution.md`. The PR workflow itself belongs to
the `voyager-contribute` skill; live-browser checks belong to
`verify-in-browser`.

## 1. Pick the path

**(a) Declarative plugin.** CSS plus a JSON manifest under
`catalog/sites/<site>/plugins/<id>/`. Pick this when the behavior is a
stylesheet plus the four reversible DOM ops (`addClass`, `setAttribute`,
`setStyle`, `hide`), or a `native` op that calls a primitive that already
exists. Most contributions are this.

**(b) Site adapter change.** `catalog/sites/<site>/site.json`: `matches`, the
semantic `selectors`, `theme`, `brandColor`, `capabilities`,
`conversationIdPattern`. Pick this when the site redesigned and every plugin on
it now misses, or when a key the vocabulary already names is absent. A fix to an
existing site reaches users through the per-host catalog. A **new** site does
not: host permission and content-script registration ship inside the package, so
a new `site.json` needs an extension release (plan D16).

**(c) Primitive.** First-party TypeScript under `src/features/plugins/verbs/`,
called by name from a manifest's `native` op. Pick this only when the behavior
cannot be data: it needs event handling, its own state, or DOM that Voyager
builds. Three files divide it: the contract in `verbs/contracts.ts` (data only),
the implementation in `verbs/<name>.ts`, the binding in `verbs/registry.ts`,
plus an entry appended to `verbs/paramsBaseline.json`.

A primitive is a published API. Plan D9 holds it to: parameters are only ever
**added**, and only as **optional**; a published parameter never changes type
and never becomes required; `sinceEngine` never changes; anything breaking ships
under a **new name**, because `handler` carries no version suffix.
`verbs/contracts.test.ts` enforces this against the committed baseline. A
primitive PR also needs parametric tests over **two sites'** fixtures, so the
behavior is proven to be site-independent rather than one site's code with a
name on it.

A primitive does not stand alone: the plugin that invokes it is still path (a),
and usually lands in the same PR.

Path (c) adds first-party code and API surface, so it needs explicit maintainer
approval of the approach before the code is written. Paths (a) and (b) follow
the normal Issue-first rule in `.github/CONTRIBUTING.md`.

The path is picked when you can say which of the three files changes and, for a
new primitive or a new site, point at the approval.

## 2. Do the work

### (a) Declarative plugin

```bash
bun run plugin:new <id-segment> --site <site> --dry-run   # see the plan
bun run plugin:new <id-segment> --site <site>             # write it
```

The scaffold creates `plugin.json` (id `voyager.<site>-<segment>`, `matches`
copied from the site, `engine` pinned to this build), a `style.css` scoped under
`gv-plugin-<site>-<segment>`, a `README.md` skeleton, and appends the
`marketplace.json` entry. It refuses to overwrite an existing directory and
lists the known sites when `--site` is unknown.

Then replace every `TODO`: the English `name` and `description` first, then the
nine other locales, then the real CSS and DOM ops. Add `contributes.settings`
only for values a user should control; a `{{settingKey}}` token in CSS or in a
`setStyle` value is how a setting reaches the page. Add a one-line `changelog`
when a later version changes behavior.

```bash
bun run plugin:check src/features/plugins/catalog/sites/<site>/plugins/<id>
bun run test src/features/plugins
bun run catalog:build
bun run verify:pr
```

`plugin:check` is the gate: manifest, CSS, site containment, primitive handlers
and the engine floor, semantic keys, ten-locale metadata, README presence. Fix
what it reports rather than arguing with it.

### (b) Site adapter change

Edit `catalog/sites/<site>/site.json` and nothing else; the TypeScript adapters
for plugin platforms are one-line shells over the JSON. Only keys from
`src/features/plugins/sites/semanticKeys.ts` are accepted, and a key the site
cannot honestly provide is **left out**, not filled with a guess: a wrong
selector fails silently on every plugin that trusts it. Widening `matches`
widens every plugin under that site, so recheck each one still stays inside it.

A new site also needs its directory, a `CODEOWNERS` line, and an extension
release (D16).

```bash
bun run plugin:check src/features/plugins/catalog/sites/<site>/plugins/<id>   # each plugin
bun run test src/features/plugins
bun run catalog:build
bun run verify:pr
```

### (c) Primitive

1. `verbs/contracts.ts`: append the contract entry (`name`, `sinceEngine`,
   `semantic`, `params`, `description`). `sinceEngine` is the
   `PLUGIN_ENGINE_VERSION` the primitive first ships in, so bump
   `src/features/plugins/constants.ts` in the same PR and use the new value.
2. `verbs/<name>.ts`: the `validateParams` guard (hand-written, no schema
   library, per D17) and `activate(scope, params, context)`. Register every
   side effect on the `PluginScope` so unmount pays it all back, and report the
   element count through `context.setTargetCounter` so the health signal works.
3. `verbs/registry.ts`: bind the implementation. `verifyPrimitiveRegistry()`
   fails when the two lists disagree.
4. `verbs/paramsBaseline.json`: append the entry. Never edit an existing one.
5. Tests: the parametric two-site test, plus the contract test staying green.
6. The manifest that uses it: `requires.handlers: ["<name>"]` and an `engine`
   range whose minimum is at least `sinceEngine`.

```bash
bun run test src/features/plugins
bun run catalog:build
bun run verify:pr
```

The work is done when the gate commands above pass on the committed tree, not
on a tree that has moved since.

## 3. Evidence the PR must carry

Automated checks prove the data is well formed. They cannot prove the plugin
does anything on the real site. These are hard requirements, not a checklist to
tick:

- **A real-page screenshot or recording**, on the target site, in **light and
  dark theme**. A real conversation with real turns, not an empty page and not a
  fixture. Say which URL and roughly how long the conversation was.
- **The `plugin:check` output**, pasted, from the directory being submitted.
- **The target match count**: how many elements the plugin's selectors hit on
  that conversation. Measure it in the page rather than reasoning about it:

  ```js
  document.querySelectorAll('<the selector the manifest uses>').length;
  ```

- **For a primitive**: the two-site parametric test, named, with its result.

Zero targets is the failure that ships most often, and Voyager reports it: a
mounted plugin whose own target count is zero while the adapter's `userTurn`
matches gets flagged **"no effect"** in the popup (plan D12,
`runtime/healthMonitor.ts`). That yellow warning means the selectors miss, not
that the page is slow. A pure-CSS plugin has no countable targets and is never
flagged, so its screenshot is the only evidence there is.

Reload the extension and the tab before believing any of it; `verify-in-browser`
has the sequence. If a check could not be run, say so and name who runs it.

Evidence is complete when a reviewer can see the plugin working on the real site
in both themes without opening a browser themselves.

## 4. Rules that get PRs sent back

- Every injected class is `gv-` prefixed; plugin-scoped classes are
  `gv-plugin-<site>-<id>`. Nothing leaks to the host page unscoped.
- No remote resources in CSS: no `@import`, no `http(s)://` or protocol-relative
  `url()`. `data:` URIs are fine. `validateStyleCss` rejects the rest.
- Prefer a semantic key over a raw selector:
  `{ "kind": "semantic", "key": "userTurn" }`. Raw selectors are for what the
  vocabulary cannot name, and they are the first thing to break on a redesign.
- A plugin's `matches` stays inside its site's `matches` (D18).
  `catalog:build` fails otherwise.
- `requires.handlers` lists every primitive the plugin invokes, and `engine`'s
  minimum is at least each primitive's `sinceEngine`. That ordering is the
  point: an old build then says "update Voyager" (`needs-engine`) instead of
  `needs-handler`, which is left meaning a real configuration mistake.
- Ten locales. English lives in the top-level `name` / `description`; the other
  nine sit under `i18n.<locale>` with `name`, `description`, `changelog` when
  set, and a label for every setting.
- `marketplace.json` gets the entry, and the plugin directory gets a `README.md`
  next to the manifest. A test enforces both.
- `params` is configuration, not instructions (plan §5, C1): no conditions, no
  ordering, no code. A selector-valued parameter such as `yieldWhen` is still
  data, so do not reject one on its name.
- Themes come from the site, not from guesswork: `site.json`'s `theme` block
  records the host, light and dark selectors. Check both.
- Never hand-edit `dist_*` or `docs/public/catalog`; `catalog:build` writes the
  published catalog.

## 5. Complete when

- **Declarative plugin**: the directory holds a manifest, its CSS and a README;
  `plugin:check`, `bun run test src/features/plugins`, `catalog:build` and
  `verify:pr` pass; `marketplace.json` lists it; all ten locales are real
  translations rather than the scaffold's placeholders; and the PR carries the
  light and dark screenshots plus a non-zero target match count from a real
  conversation.
- **Site adapter change**: every semantic key in `site.json` is one the site
  genuinely provides, every plugin under the site still passes `plugin:check`
  and stays inside the new `matches`, the suite and `catalog:build` pass, and
  the PR shows the affected plugins still working on the real site. A new site
  additionally has its CODEOWNERS line and is scheduled into a release.
- **Primitive**: contract, implementation, registry binding and baseline entry
  agree; `contracts.test.ts` and the two-site parametric test pass; the engine
  version and every dependent manifest's `engine` floor were bumped together;
  the first plugin that calls it is verified on a real page; and the parameters
  added are optional, with any breaking change carrying a new name.
