# DeepSeek - Code and Table Readability

An opt-in declarative plugin for code blocks and wide tables in DeepSeek
assistant answers. Code uses horizontal scrolling by default; the **Wrap code
lines** setting switches code blocks to soft wrapping without changing their
text. Existing div wrappers around tables scroll horizontally. The plugin does
not change table display roles, syntax colors, native copy buttons, thinking
content, the composer, or user messages.

Uses the DeepSeek adapter's assistantTurn semantic key. Answer contents use
.ds-assistant-message-main-content and standard pre/code/table descendants.
No extra host permissions, native handler, remote resources or new storage keys.
Disabling removes the scoped classes, setting attributes and stylesheet.

## Validation status

The DOM lifecycle and CSS behavior are tested with synthetic fixtures. They are
not a recording of the current live DeepSeek DOM. Real DeepSeek page access
failed with ERR_CONNECTION_CLOSED during preparation; Chrome was not connected.
Live narrow/desktop and light/dark screenshots, selector match counts, copy
button checks and compatibility with the reading-width plugin remain required
before merge. Tables without an existing div wrapper are left unchanged rather
than restructuring host DOM. Do not treat this README as live-browser evidence.

Related issue: #995.
