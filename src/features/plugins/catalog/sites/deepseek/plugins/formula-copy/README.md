# DeepSeek · Formula Copy

Click an inline or block formula on chat.deepseek.com to copy its LaTeX. This
plugin contains no code of its own: it invokes Voyager's first-party
`formulaCopy` primitive through a `native` op (plan §5), so the behaviour is the
same as the built-in formula copy on Claude and ChatGPT.

- Requires Voyager plugin engine 1.3.0 or newer (`requires.handlers: ["formulaCopy"]`).
- Ships disabled; enable it from the popup on DeepSeek.
- Status: needs a live check on DeepSeek's current KaTeX markup (see issue #994).
