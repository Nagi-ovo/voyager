# Plugin Contribution Guide

Voyager's plugin system is designed around declarative plugins: describe plugin metadata and DOM operations in `plugin.json`, then describe visual changes in CSS. Plugins do not run remote JavaScript; Voyager's built-in plugin engine interprets the manifest and styles.

This keeps plugins easier to review and maintain. If you want to contribute a plugin, start here first.

## Recommended path

1. Confirm that the idea fits a plugin: reading width, layout fixes, theme tweaks, hiding or marking page elements, and simple site adaptations are usually good candidates.
2. Open an Issue in the Voyager repository first. Explain the problem, target website, and difference from existing plugins; wait for explicit maintainer approval before coding or opening a PR.
3. Use `plugin.json` for metadata, site matches, settings, and contributions.
4. Put styles in `style.css` in the same plugin directory, then reference it from `contributes.styles`.
5. Test locally and include test pages, screenshots, or a short recording in the PR. Maintainers will decide whether it is ready for the official catalog.

## Directory layout

Official bundled plugins live under `src/features/plugins/catalog/`, one
directory per plugin platform:

```
src/features/plugins/catalog/
  marketplace.json                        index read by the docs plugin store
  sites/<site>/site.json                  the site adapter, as data
  sites/<site>/plugins/<id>/plugin.json   a declarative plugin
  sites/<site>/plugins/<id>/style.css     its styles
  sites/<site>/plugins/<id>/README.md     what it fixes and why
```

Discovery is automatic: `catalog/sites/index.ts` finds every `site.json` and
every `plugin.json` with `import.meta.glob`, so adding a site or a plugin means
adding files. There is no mapping table to edit.

`marketplace.json` is not that mapping table. It is only the index the
documentation plugin store reads, and a test keeps it in sync with discovery, so
a new plugin also needs an entry there. Its `source` is the catalog-relative
path, for example `sites/deepseek/plugins/reading-width/plugin.json`.

A plugin's `matches` must stay inside the `matches` of the site it lives under.
A plugin that reaches outside its own site fails the build.

## Semantic selector keys

`site.json` maps a fixed vocabulary of semantic keys to site-specific CSS
selectors. The vocabulary is defined in
`src/features/plugins/sites/semanticKeys.ts`; a `site.json` may only use keys
from this list, and an unknown key is rejected.

- `userTurn`: a user message container.
- `assistantTurn`: an assistant message container.
- `thinkingBlock`: the reasoning section inside an assistant turn.
- `codeBlock`: a rendered code block.
- `composer`: the prompt input the user types into.
- `sidebar`: the conversation list or navigation rail.
- `sidePanel`: a secondary panel, such as artifacts or canvas.
- `headerActions`: the top-right action cluster of the conversation view.
- `scrollContainer`: the element that scrolls the conversation.

A site only declares the keys it can actually provide. Plugins reference a key
instead of a raw selector by using `{ "kind": "semantic", "key": "userTurn" }` as
a DOM operation `target`, so a site redesign is a one-file fix in `site.json`.

`conversationIdPattern` is a separate `site.json` field rather than a selector:
it is a regular expression over the URL path whose first capture group is the
conversation id, such as `^/chat/([^/?#]+)`.

## Adding a new platform

Adding a new chat website has two separate layers:

1. The **site adapter**, `catalog/sites/<site>/site.json`, teaches Voyager how to
   recognize the website and find its user turns, assistant turns, composer,
   sidebar, and theme markers.
2. A **plugin** under `catalog/sites/<site>/plugins/<id>/` solves one
   user-facing problem on that website, such as reading width or a rendering
   fix.

A `site.json` carries `id` (equal to its directory name), `label`, `matches`,
`selectors`, `theme`, `brandColor`, `capabilities`, and an optional
`conversationIdPattern`. `validateSiteAdapterData` in
`src/features/plugins/sites/siteAdapterData.ts` validates it, and
`bun run catalog:build` validates every site and plugin before publishing.

Every plugin platform is data. Sites today are ChatGPT, Claude, and DeepSeek.
Gemini and AI Studio are native Voyager surfaces and stay TypeScript adapters
(`src/features/plugins/sites/adapters/gemini.ts` and `aistudio.ts`). The
TypeScript files for the plugin platforms, `adapters/claude.ts`, `chatgpt.ts`
and `deepseek.ts`, are now one-line shells over their `site.json`: edit the JSON,
not the TypeScript.

The published per-host catalog carries the site data too, so a selector fix in
`site.json` can reach users without an extension release. A brand new site still
needs one, because it also needs host permission and content-script registration
that ship inside the package.

For a new platform such as DeepSeek, keep the adapter work focused on the
platform contract. Put the `site.json`, the required selector tests, and the
minimum documentation needed to explain the support in one complete change. The
site registry picks the new adapter up from the file itself, so there is no
registration list to edit. Do not add a new site for every plugin.

After the adapter is accepted, follow-up plugins can be submitted as separate
focused changes. If several changes depend on one another, a stacked PR chain
is useful: each later branch is based on the previous branch, and each PR
shows only its own incremental feature. The chain should still follow the same
scope rule: one clear user goal per PR, with its required tests and cleanup.

Site support does not require a model API integration. Do not add static
content scripts or required host permissions for a new platform; use the
existing optional-permission and dynamic-registration flow for plugin-only
sites.

The optional-permission and dynamic-registration path is browser-version
dependent. Chrome and Edge support the flow used by the extension. Firefox
requires version 128 or newer for optional host permissions, and Safari
requires version 16.4 or newer for dynamic content-script registration. On
older supported browser versions, the popup may correctly refuse to enable a
plugin for a custom site because the required APIs cannot provide a persistent
grant; do not work around this by adding a broad static host permission without
maintainer approval.

## Plugin scope

Plugins should be scoped by the user problem they solve, not mechanically split by platform.

If the same feature has nearly the same experience and settings across several platforms, prefer one cross-platform plugin. For example, reading width, page navigation, or code block layout can often cover Claude, ChatGPT, and other sites through multiple `matches`.

If each platform needs very different settings, DOM logic, or user-facing copy, separate plugins are clearer. Do not force unrelated behavior into one plugin just to make it "cover everything"; one plugin should solve one clear problem.

Quick rule:

- Same user goal, same settings, only different selectors: prefer one plugin.
- Same theme, but platform behavior differs a lot: split it, while keeping names and descriptions related.
- Different goals: do not merge them.

## Avoid duplicate plugins

Before submitting, check the plugin marketplace and existing official plugins. If a good plugin already exists, improve it instead of creating a similar one.

A duplicate plugin is only worth accepting when it has a clear improvement, such as:

- It supports an important platform the original plugin does not cover.
- It fixes a compatibility issue the original plugin cannot solve.
- It has clearly better performance, accessibility, or maintainability.
- It offers a different and meaningful user experience, not just a renamed or lightly restyled copy.

This keeps the marketplace clean and helps users choose.

## Minimal example

Start from the scaffold instead of an empty directory: `bun run plugin:new <id-segment> --site <site>` creates `catalog/sites/<site>/plugins/<id-segment>/` with a `plugin.json`, a `style.css` and a `README.md`, and appends the `marketplace.json` entry for you. What it writes is a starting point, not an approval; the manifest you fill in has this shape:

```json
{
  "$schema": "https://voyager.nagi.fun/plugin.schema.json",
  "id": "your-name.example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "A short description of what this plugin improves.",
  "author": "your-name",
  "category": "readability",
  "license": "MIT",
  "engine": ">=1.0.0",
  "tier": "declarative",
  "matches": ["https://claude.ai/*"],
  "contributes": {
    "styles": [{ "file": "style.css" }],
    "domOps": [
      {
        "op": "addClass",
        "target": "body",
        "className": "gv-plugin-example"
      }
    ]
  }
}
```

The `$schema` line is optional and only for your editor: it points at the manifest JSON Schema so the file is validated and completed as you type. A `site.json` has its own at `https://voyager.nagi.fun/site.schema.json`.

`style.css` can use normal CSS, but plugin styles should be scoped under your own `gv-plugin-*` class:

```css
.gv-plugin-example .some-target {
  max-width: 880px;
}
```

## Manifest notes

- Use a reverse-domain style or author prefix for `id`, such as `your-name.reading-width`, to avoid collisions.
- Keep `matches` narrow. Match only the websites where the plugin really needs to run.
- One plugin may include multiple `matches` when those platforms share one clear feature goal.
- Recommended `category` values: `render-fix`, `theme`, `layout`, `readability`, `productivity`, `integration`, or `other`.
- Set `engine` to the plugin engine version you require. Official plugins can be used as examples.
- Add `i18n` for Chinese, English, and other common languages when possible.

## CSS and resource limits

Declarative plugins are validated as untrusted input, so keep resources self-contained:

- Do not use `@import`.
- Do not reference remote images, external fonts, or remote CSS.
- You may use normal CSS, custom properties, and Voyager setting value substitutions.
- Prefix plugin classes with `gv-plugin-` to avoid leaking styles into the host website or Voyager itself.

If your plugin needs settings, start with numeric settings when possible. For example, a reading-width plugin can write a setting value into a CSS variable and let CSS consume it.

## DOM operation boundaries

Declarative plugins currently support:

- `addClass`: add a class to target elements.
- `setAttribute`: set an attribute.
- `setStyle`: set inline styles or CSS variables.
- `hide`: hide target elements.

Targets can be CSS selectors or the semantic keys listed above, written as `{ "kind": "semantic", "key": "userTurn" }`. Semantic keys are usually more stable, but they require the current site adapter to declare that key.

Declarative operations must be reversible and safe to run repeatedly. Do not depend on one-time page state, and do not assume the page DOM never changes.

### Primitives

Some behavior cannot be described with CSS and a reversible DOM edit. A
primitive is first-party code that ships inside Voyager and that a manifest can
call by name through the `native` operation:

```json
{
  "engine": ">=1.3.0",
  "requires": { "handlers": ["formulaCopy"] },
  "contributes": {
    "domOps": [{ "op": "native", "handler": "formulaCopy", "params": {} }]
  }
}
```

The manifest picks a primitive and configures it. It never supplies logic, and
`params` is validated by that primitive before it runs.

Two rules apply to any plugin that uses one:

- `requires.handlers` must list the primitive.
- `engine` must be at least the engine version that first shipped it.
  `formulaCopy` shipped in engine 1.3.0, so a plugin using it declares
  `">=1.3.0"`. A lower range fails `bun run catalog:build`, because an older
  Voyager would then report a missing handler instead of asking the user to
  update.

Primitives only grow: a new parameter is always optional, and a breaking change
ships under a new name.

A plugin that changes behavior can also carry a one-line `changelog`, which the
popup shows next to the version. Translate it under `i18n.<locale>.changelog`
next to `name` and `description`.

## When not to use a regular plugin

If a feature must execute JavaScript, intercept network requests, read or write Voyager internal data, or depend on complex runtime logic, it is not a good fit for a regular declarative plugin.

Open an Issue first and describe the need. If it truly requires built-in capability, we may consider implementing it in the Voyager repository as a builtin/native plugin, like Formula Copy.

## Before opening a PR

Run `bun run plugin:check <plugin dir>` and paste its output in the PR. It reports every problem at once, from the manifest and CSS to site containment, primitives, semantic keys, the ten locales and the README, and CI runs the same check over every bundled plugin.

- The plugin is disabled by default and users enable it themselves.
- You checked that there is no nearly identical plugin; if there is, improve the existing plugin first.
- You tested light and dark themes on the target website.
- `matches` does not cover unrelated sites.
- There are no remote resources.
- The plugin directory includes `plugin.json`, required CSS files, and a short README.
- For an official plugin, the directory sits under `catalog/sites/<site>/plugins/<id>/`, its `matches` stay inside the site's `matches`, and `catalog/marketplace.json` lists it.
- The PR describes test pages, screenshots or recordings, and affected page areas.

Keep it simple, focused, and reversible. A plugin that solves one clear problem is much easier to merge and maintain.
