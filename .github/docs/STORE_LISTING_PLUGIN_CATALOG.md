# Store listing copy: plugin catalog connection

> **Draft, awaiting maintainer review.** Nothing here has been submitted to a
> store. Wording, tone and the Firefox decision in section 3 are proposals; edit
> freely before pasting into Chrome Web Store, Edge Add-ons or Firefox AMO.

Voyager can fetch an updated plugin catalog for a site from
`https://voyager.nagi.fun/catalog/hosts/<site host>.json`. Stores ask what a
listing discloses about that connection, so the copy below is kept in one place
and reused across all three of them. The framing follows uBlock Origin's
listing, which names the host it connects to and the condition under which it
stops connecting.

## 1. Listing paragraph (English)

> Voyager works locally. For its plugins it connects to one server,
> voyager.nagi.fun, and only to update the plugin catalog: the CSS and JSON that
> make Voyager's plugins work on sites like Claude, ChatGPT and DeepSeek. The check
> only happens on a site where you have enabled at least one plugin, at most as
> often as the interval you pick (every 6 hours by default), and it sends
> nothing but the request itself: no cookies, no account or extension
> identifier, no page or conversation content. Gemini and AI Studio never
> trigger it. With "Plugin online updates" turned off, Voyager does not connect
> there unless you press the manual check button. If the check fails, the
> plugin catalog bundled with the extension keeps working.

## 2. Listing paragraph (Simplified Chinese)

> Voyager 在本地运行。插件功能只会连接一台服务器 voyager.nagi.fun，而且只用于更新插件目录，也就是让
> Voyager 插件在 Claude、ChatGPT、DeepSeek 等网站上生效的 CSS 和 JSON。只有在你已经启用了至少一个插件的网站上才会检查，频率不超过你选择的间隔（默认每 6
> 小时一次），并且除请求本身外不发送任何内容：没有 Cookie，没有账户或扩展标识，没有页面或对话内容。Gemini 和 AI Studio
> 不会触发检查。关闭「插件在线更新」后，除非你按下手动检查按钮，Voyager 不会连接该服务器。检查失败时，扩展内置的插件目录照常工作。

## 3. Firefox data collection note

The AMO submission keeps `data_collection_permissions.required = ["none"]`. The
catalog check transmits no user data: it is an HTTPS GET for a static file, sent
without cookies and without any account or extension identifier, and it carries
no page or conversation content. What the server can observe is the standard
request metadata every web request exposes, namely the requesting IP address and
the browser user agent, plus the site host name in the URL path. That is the
same footprint as loading any static asset and is not collection of user data in
the sense the field asks about.

If AMO review disagrees, the fallback is to ship the Firefox build with
`VOYAGER_PLUGIN_CATALOG_REMOTE=off`. That flag compiles out the remote channel
entirely, so the build never contacts voyager.nagi.fun and the bundled plugin
snapshot is the only source. No other behavior changes, and the listing copy
above would then be dropped from the Firefox listing.

## 4. Chrome Web Store privacy practices

One-line answer for the data-usage questionnaire:

> This feature does not collect or transmit user data. Voyager requests a public
> static catalog file over HTTPS without cookies or identifiers, and sends no
> page content, conversation content, or personal information.

## 5. Related material

- Privacy policy wording, all 10 locales: `docs/privacy.md` and
  `docs/<locale>/privacy.md`, under the plugin catalog bullet or section.
- Implementation and gates: `src/features/plugins/README.md`, section "Remote
  host catalog".
- Build flags: `src/features/plugins/remote/config.ts`.
