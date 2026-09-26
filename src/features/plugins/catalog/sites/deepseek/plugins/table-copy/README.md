# DeepSeek Table Copy

PR #1035 implements #1014. The automated checks passed; maintainer approval
of the primitive contract and documented live-browser evidence are still pending.
Synthetic tests are not live-browser evidence.

## Behavior

Each rendered table inside the adapter's assistant turn gets explicit **Copy
Markdown** and **Copy TSV** buttons. The controls use isolated Shadow DOM styles,
inherit the site's text color, wrap on narrow screens, and expose localized
accessible names and live copy/error feedback in all ten Voyager languages.
No remote assets, code, requests, transcript storage, or automatic clipboard
writes are used. Only a copy-button click reads the current table and calls the
Clipboard API; failures are reported without an automatic fallback or retry.
Tables inside the adapter's thinkingBlock are excluded, even when that block
belongs to an assistant turn.

The first header row becomes the Markdown header. A table without a header gets
an empty Markdown header, retaining its first data row. Blank cells remain blank.
Markdown escapes pipes, backticks, backslashes, tildes and HTML, and uses inline
breaks for cell newlines. Cell text is copied without HTML markup, script/style/
template contents, hidden or aria-hidden content, or elements hidden by computed
CSS (display:none or visibility:hidden/collapse). Offscreen but rendered content
is still copied. This is a text export, not a lossless HTML or formatting export.

TSV normalizes embedded tabs/newlines to spaces, doubles and quotes embedded
quotation marks, and prefixes an apostrophe before formula-leading cells
(=, +, -, @, including full-width variants and leading whitespace). Invisible
controls are removed before that check. This intentionally treats negative
numbers as text too. Spreadsheet import behavior varies; real paste checks
remain pending, and subsequent user transformations can remove these safeguards.

Nested tables, merged cells (including rowspan=0), multiple header rows, and
uneven row widths are refused with feedback rather than flattened. Limits are
500 rows, 100 columns, 10,000 cells, 1,000,000 input text characters, 100,000
visited cell nodes and 128 nesting levels. Oversized tables fail without a
partial clipboard write. Only currently rendered DOM is available; virtualized
or otherwise unloaded rows cannot be exported by this primitive.

Dynamic table insertion/replacement and assistant marker changes are observed.
The observer ignores its own controls, releases detached table state, and stops
on disposal; pending clipboard results cannot update a removed or disposed UI.
An already submitted system clipboard write cannot be cancelled on disposal.

## Integration

Requires engine **>=1.5.0**, handler **tableCopy**, and adapter **assistantTurn**.
The only optional parameter is **table** (selector, default **table**). Custom
selectors still only target actual tables within assistant turns. The primitive
exports **tableCopyPrimitive** and **TableCopyParams** from verbs/tableCopy.ts.

The same PR registers the shared contract, primitive, engine version, parameter
baseline and marketplace entry.
There is no plugin CSS file: the first-party primitive owns its isolated styles.

## Verification

- Run **bun run test src/features/plugins/verbs/tableCopy** for serializer and
  actual-primitive tests using DeepSeek and ChatGPT semantic fixtures.
- Run **bun run plugin:check
  src/features/plugins/catalog/sites/deepseek/plugins/table-copy** and the full
  repository checks after any behavior change.
- **Live pending:** real conversation with tables, selector hit counts, light and
  dark screenshots, narrow layout, streaming/replacement behavior, clipboard
  denial and actual spreadsheet paste. The contributor reports the feature is
  visible, but screenshots and detailed clipboard results are not yet recorded.

Disable the plugin to remove controls/listeners/observers. Source tables and
conversation contents are never rewritten by activation or teardown.
