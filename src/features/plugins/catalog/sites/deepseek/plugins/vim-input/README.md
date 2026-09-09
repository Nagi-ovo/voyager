# DeepSeek Vim Input

Vim-style editing in the DeepSeek prompt composer, using Voyager's existing
`vimInput` primitive through a declarative `native` operation. Requires plugin
engine 1.4.0 or newer, the `vimInput` handler, and the site's `composer` semantic
selector. No plugin-specific CSS or new primitive is needed.

The current DeepSeek adapter resolves `composer` to `textarea.ds-scroll-area`;
the manifest uses that semantic selector without a hard-coded override.
Editing starts in insert mode. Press `Escape` for normal mode, use motions such
as `h`, `l`, `w`, and `b`, or commands such as `x` and `u`, then press `i` to
return to insert mode. These commands are supplied by Voyager's shared Vim
implementation, not a separate DeepSeek editor.

## Verification

`src/features/plugins/sources/deepseekVimInput.test.ts` exercises this manifest
through the real declarative engine, primitive registry, `PluginScope`, and
current Vim implementation. Its DOM fixtures cover the composer alongside an
unrelated textarea, keyboard editing, composing-key bypass, composer replacement,
and disposal followed by re-enabling. These are jsdom integration tests, not
evidence of live DeepSeek behavior or visual appearance.

The composer selector was reported as previously observed on the live site in
the implementation handoff for issue #997. Live extension verification in a real
conversation, including light/dark appearance, actual IME input, and enable/disable
behavior, remains pending. The current handoff reports browser access failing
with `ERR_CONNECTION_CLOSED` and no exposed Chrome session. Marketplace index
integration is handled separately.
