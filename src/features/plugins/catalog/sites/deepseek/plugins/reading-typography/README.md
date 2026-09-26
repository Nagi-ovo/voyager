# DeepSeek Reading Typography

Adjust ordinary answer paragraphs and list items with separate font-size and
line-height switches and three numeric settings. Both switches default to off,
leaving their native properties unchanged. When enabled, font size ranges from
12-28 px and line height from 120-220 percent. Paragraph spacing is 0-32 px,
with zero leaving its native spacing unchanged. Turning the plugin off restores
all injected attributes and styles.

To preserve math and inline-code rendering, a paragraph or list item containing
code or recognized math markup is intentionally excluded. Thinking content,
headings, code blocks, tables and the prompt composer are not targeted.

This is declarative data only, uses assistantTurn semantics and introduces no
permissions or storage format changes. Related issue: #1016.

## Acceptance status

PR #1034 is open. Automated DOM and style checks use synthetic fixtures;
before merge, verify the actual DeepSeek page in light/dark and narrow/desktop
layouts, including long virtualized conversations, list spacing and simultaneous
reading-width use. Live screenshots and browser-version details are still pending.
