# DeepSeek Code Folding (local prototype)

Local prototype for #1015. **Real DeepSeek verification is pending.**
Neither these fixtures nor a passing build establish live-site compatibility or
maintainer approval of the new primitive contract. Do not publish this prototype
as verified until the evidence below is collected.

## Behavior

- Calls the generic `codeCollapse` primitive, introduced in engine 1.5.0.
- Optional `code` selector targets `pre` elements. Without it, queries `pre`
  inside the adapter's `assistantTurn` matches, including selector lists.
  Default targeting excludes the adapter's `thinkingBlock`; an explicit
  `code` selector can intentionally include reasoning code.
- Optional `thresholdLines` number: default 20, inclusive bounds 5 through 200.
  The plugin's numeric setting overrides the primitive default and updates in place.
- Folds only when code exceeds the threshold. Toggles and an expand-all/collapse-all
  button group are siblings, in normal document flow, with bundled Lucide icons,
  localized tooltips and accessible labels in all ten supported languages.
- Never moves or replaces host code nodes and never shortens their text. Only
  `pre` gets temporary height/overflow styles; native sibling copy controls remain
  untouched. Skips editable targets and blocks with controls inside `pre`.
  Reading is bounded to 200,000 characters and 10,000 descendant nodes per block;
  oversized blocks are left fully visible, without changing their content.
  A pixel-height fallback precedes the optional `lh` clamp on supporting browsers.
- Appended streaming text and syntax-highlight replacement with unchanged text
  preserve the user's decision. Detached, moved, non-prefix-rewritten or newly
  navigated targets release old controls and reset the decision.
- Disabling restores original inline values and priorities, including the exact
  original style attribute when the host has not independently edited it. Host
  changes to unrelated inline declarations are retained.

## Integration ownership

This directory and `verbs/codeCollapse*` contain only the prototype-owned files.
The coordinating task owns contracts, registry, params baseline, engine 1.5.0,
and marketplace registration. This plugin should remain opt-in.

## Verification still required

- Real DeepSeek conversation with long code and streaming, light and dark themes.
- Original copy buttons copy the full original code, while folded and expanded.
- Individual and all-block controls, numeric setting changes, navigation, disable,
  re-enable, and extension reload, without duplicate controls or host UI overlap.
- Narrow and wide layouts; live screenshots and nonzero target counts.
- Applicable loaded-extension browser checks from the contribution workflow.

Two-site parametric fixtures live in `verbs/codeCollapse.test.ts`. They are
synthetic regression tests, not recordings of the current DeepSeek DOM.
