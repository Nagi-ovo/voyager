# DeepSeek Reading Typography

Adjust ordinary answer paragraphs and list items using three numeric settings.
Each setting defaults to zero, which leaves its native property unchanged;
return all three to zero to restore native typography. Nonzero text sizes are
clamped to 12-28 px and line heights to 120-220 percent. Paragraph spacing is
0-32 px. Turning the plugin off restores all injected attributes and styles.

To preserve math and inline-code rendering, a paragraph or list item containing
code or recognized math markup is intentionally excluded. Thinking content,
headings, code blocks, tables and the prompt composer are not targeted.

This is declarative data only, uses assistantTurn semantics and introduces no
permissions or storage format changes. Related issue: #1016.

## Acceptance status

DOM and style checks use synthetic fixtures. Before PR publication, verify the
actual DeepSeek page in light/dark and narrow/desktop layouts, including long
virtualized conversations, list spacing and simultaneous reading-width use.
No current real-page screenshots or extension-load proof are claimed here.
