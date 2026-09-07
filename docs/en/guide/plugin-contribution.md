# Plugin Contribution Guide

Voyager's plugin system is designed around declarative plugins: describe plugin metadata and DOM operations in `plugin.json`, then describe visual changes in CSS. Plugins do not run remote JavaScript; Voyager's built-in plugin engine interprets the manifest and styles.

This keeps plugins easier to review and maintain. If you want to contribute a plugin, start here first.

## Recommended path

1. Confirm that the idea fits a plugin: reading width, layout fixes, theme tweaks, hiding or marking page elements, and simple site adaptations are usually good candidates.
2. Open an Issue in the Voyager repository first. Explain the problem, target website, and difference from existing plugins; wait for explicit maintainer approval before coding or opening a PR.
3. Use `plugin.json` for metadata, site matches, settings, and contributions.
4. Put styles in `style.css` in the same plugin directory, then reference it from `contributes.styles`.
5. Test locally and include test pages, screenshots, or a short recording in the PR. Maintainers will decide whether it is ready for the official catalog.

## Adding a new platform

Adding a new chat website has two separate layers:

1. The **site adapter** teaches Voyager how to recognize the website and find
   its user turns, assistant turns, composer, sidebar, and theme markers.
2. A **plugin** solves one user-facing problem on that website, such as reading
   width or a rendering fix.

For a new platform such as DeepSeek, keep the adapter work focused on the
platform contract. Put the adapter, registry entry, required selector tests,
and the minimum documentation needed to explain the support in one complete
change. Do not add a new adapter for every plugin.

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

```json
{
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

Targets can be CSS selectors or semantic selectors provided by Voyager site adapters. Semantic selectors are usually more stable, but they require the current site adapter to expose the target.

Declarative operations must be reversible and safe to run repeatedly. Do not depend on one-time page state, and do not assume the page DOM never changes.

## When not to use a regular plugin

If a feature must execute JavaScript, intercept network requests, read or write Voyager internal data, or depend on complex runtime logic, it is not a good fit for a regular declarative plugin.

Open an Issue first and describe the need. If it truly requires built-in capability, we may consider implementing it in the Voyager repository as a builtin/native plugin, like Formula Copy.

## Before opening a PR

- The plugin is disabled by default and users enable it themselves.
- You checked that there is no nearly identical plugin; if there is, improve the existing plugin first.
- You tested light and dark themes on the target website.
- `matches` does not cover unrelated sites.
- There are no remote resources.
- The plugin directory includes `plugin.json`, required CSS files, and a short README.
- The PR describes test pages, screenshots or recordings, and affected page areas.

Keep it simple, focused, and reversible. A plugin that solves one clear problem is much easier to merge and maintain.
