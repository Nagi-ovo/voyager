# DeepSeek · Timeline

A compact conversation timeline rail on chat.deepseek.com with starred
messages and search. This plugin contains no code: it invokes Voyager's
first-party `turnNavigator` primitive through a `native` op, with every
parameter taken from the DeepSeek site adapter (`userTurn` selector and
`conversationIdPattern`). It is the same engine as the Claude timeline; starred
messages are stored under `deepseek:conv:<id>` and never mix with other sites.

- Requires Voyager plugin engine 1.4.0 or newer (`requires.handlers: ["turnNavigator"]`).
- Ships disabled; enable it from the popup on DeepSeek.
- Status: needs a live check on DeepSeek's virtual list (see issue #996).
