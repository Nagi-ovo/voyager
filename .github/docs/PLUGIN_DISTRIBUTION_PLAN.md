# Voyager 插件分发架构方案（决策完成版）

日期：2026-09-07。状态：设计已批准，评审轮次已收口（新增 D16–D20，§11–§13 同步更新），等待「implement」指令。基线：`origin/main` = 18041a07，DeepSeek stack #981–#991 已合并。

## 0. 一句话

站点知识和插件是数据，走远程通道，合并到 `main` 即发布；行为原语、引擎和无法参数化的 builtin 是代码，随本体发版。Gemini 与 AI Studio 不进远程目录；新站点随本体发版。

## 1. 已定决策

| #   | 决策         | 结论                                                                                                                                                                                                                                                                             |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 目录仓库     | 主仓 `src/features/plugins/catalog/`，不用独立仓库                                                                                                                                                                                                                               |
| D2  | 分发地址     | `https://voyager.nagi.fun/catalog/hosts/<host>.json`，官网迁到 Cloudflare 代理；不签名。已接受的供应链风险：目录只含 CSS/JSON、使用前校验净化、HTTPS 传输、按扩展版本绑定缓存、下架即卸载；能改文件的人已经能改发布本身，签名不会缩小这个信任面。若发布链路脱离仓库 CI，再补签名 |
| D3  | 文件粒度     | 按 host 一个文件，路径由 `location.host` 直接算出，无索引请求；多域名站点用别名文件；新站点见 D16                                                                                                                                                                                |
| D4  | 拉取触发     | 无后台定时器。仅在「该 host 上启用过至少一个插件」的站点，打开页面或 popup 时距上次检查超过阈值才拉；popup 页脚手动「检查更新」永远可用。「上次检查」按上次尝试计，失败退避见 D19                                                                                                |
| D5  | 阈值         | 默认 6h，用户可选 1h / 6h / 24h / 仅手动；全局开关「插件在线更新」可关闭                                                                                                                                                                                                         |
| D6  | 合并优先级   | 按 id 判定：远程有且兼容取远程；远程有但不兼容而快照有兼容版本，取快照并标「更新需要新版 Voyager」；远程可达但无此 id，立即卸载（kill switch）；远程不可达用上次缓存，其次快照；扩展版本变化则全部 host 缓存作废。不用版本高者胜（revert 必须生效）                              |
| D7  | 应用时机     | CSS 与 domOps 更新即时重挂载；含 UI 状态的原语更新在整页加载后切换，SPA 内 pushState 不切换；popup 文案「刷新页面后生效」                                                                                                                                                        |
| D8  | 兼容判定     | `engine` 区间、`requires.handlers`、`requires.semantic` 任一不满足：显示但禁用并给出原因，不隐藏。缺原语时文案为通用「请更新 Voyager」，版本号不可算（见 §5 引擎版本规则）                                                                                                       |
| D9  | 原语演进     | 只增不改：新参数必须可选；破坏性变更起新名字；语义键只增不删不改义                                                                                                                                                                                                               |
| D10 | 首发原语     | `formulaCopy`、`vimInput`、`turnNavigator`；导出、临时对话交接、Claude 用量留 builtin                                                                                                                                                                                            |
| D11 | 可见性       | popup 显示插件版本；目录变化后角标；清单 `changelog` 字段展示一行说明                                                                                                                                                                                                            |
| D12 | 健康信号     | 适配器 `userTurn` 已匹配到内容、且插件自身目标为零、且 DOM 已静默一段时间后才标黄「本页无效果」；目标出现即清除。纯 CSS 插件（无 domOps、无原语）豁免                                                                                                                            |
| D13 | 隐私         | 重开远程通道的同一 PR 内更新 release-privacy 契约、站内隐私文案、商店描述草稿；启用插件时的授权文案说明会向 voyager.nagi.fun 检查更新。文案限定为「插件目录」，公告服务及其开关维持现状，不承诺「不连接任何服务器」                                                              |
| D14 | Gemini       | 不进目录，Gemini/AI Studio 用户零目录请求                                                                                                                                                                                                                                        |
| D16 | 新站点       | 远程只更新打包快照里已有的站点；新站点随本体发版。触发链「清单 matches → 用户授权 → 注入内容脚本 → PluginHost 拉取」决定远程无法引入新 host                                                                                                                                      |
| D17 | 校验实现     | 不引入 zod。原语 params 用 `validate.ts` 同款手写 guard；JSON schema 手写发布，测试用示例清单同时过 schema 与 guard 保证一致                                                                                                                                                     |
| D18 | matches 归属 | `plugin.json` 保留 `matches`，`site.json` 也有；`plugin:check` 校验插件 matches 是站点 matches 的子集；现有五处读者不改                                                                                                                                                          |
| D19 | 拉取失败     | 记录 `lastAttemptAt`；失败后退避照抄公告服务：30 分钟起、每次翻倍、24 小时封顶                                                                                                                                                                                                   |
| D20 | 远程覆盖范围 | 远程只能覆盖 bundled 目录里的 id 与新 id；`NATIVE_BUILTIN_PLUGIN_IDS` 一律以本体为准，直到 P4 把 builtin 改写为 JSON                                                                                                                                                             |

## 2. 三层模型

```
第 3 层  插件 = 绑定       catalog/sites/<site>/plugins/<id>/   远程   选原语 + 站点参数 + CSS
第 2 层  原语 = 行为       src/features/plugins/verbs/          本体   formulaCopy / vimInput / turnNavigator + 4 个 domOps
第 1 层  适配器 = 站点知识  catalog/sites/<site>/site.json       远程   matches / 语义键 / 主题 / 品牌色
```

原语缺省读适配器语义键；插件参数可覆盖；没有适配器的站点插件自带选择器。插件级 `matches` 保留（D18）。

## 3. 源码布局与产物

```
src/features/plugins/catalog/
├── sites/
│   ├── deepseek/
│   │   ├── site.json                 适配器（今天 deepseek.ts 的数据部分）
│   │   ├── CHANGELOG.md              可选
│   │   └── plugins/reading-width/{plugin.json, style.css, README.md}
│   ├── chatgpt/ …
│   └── claude/ …
└── …

docs/public/catalog/ (scripts/build-plugin-catalog.ts 输出，.gitignore 忽略；VitePress 原样拷进站点根)
└── hosts/chat.deepseek.com.json  { format:1, host, site, plugins:[…CSS 内联…], generatedAt }
```

- `BundledCatalogPluginSource` 改为 `import.meta.glob` 自动发现 `sites/*/site.json` 与 `sites/*/plugins/*/plugin.json`，删除手工映射表。
- `scripts/build-plugin-catalog.ts`（`bun run catalog:build`）生成 host 文件到 `docs/public/catalog/`；`deploy-docs.yml` 在 `docs:build` 之前调用它，产物随站点发布到 `/catalog/hosts/<host>.json`。该工作流按 `paths` 过滤，必须加上 `src/features/plugins/catalog/**`、`src/features/plugins/sites/**` 与 `scripts/build-plugin-catalog.ts`，否则目录改动只有每日 cron 才发布。
- Cloudflare 侧：部署后 purge `catalog/`，或给该路径设短 `max-age`，否则 revert 会被 CDN 缓存吃掉。
- `CODEOWNERS` 按 `catalog/sites/<site>/` 分配站点维护者。
- 适配器 TS 文件保留一个薄壳：从 `site.json` 读取并导出，`SiteRegistry.createDefault()` 用快照同步注册；远程 site 段到达后通过 `register()` 覆盖。

## 4. 客户端运行时

### 4.1 拉取

- 新 `HostCatalogSource`（替换 `MarketplacePluginSource`）：`PluginSource.list()` 接口加 host 参数；`list(host)` 读 `storage.local` 里 `gvPluginHostCatalog:<host>`；过期判断用 D5 阈值；刷新经消息交给后台单飞执行。
- 触发点：内容脚本启动（仅当 `pluginState` 中存在该 host 的已启用插件）；popup 打开于插件站点；手动按钮。
- 后台无 alarm。旧键 `gvPluginCatalogCache` 忽略不删。
- 响应处理：`format` 大版本不认识则丢弃；`validateManifest` + `validateStyleCss` 逐条校验；内容签名变化才通知订阅者；404 记为「无支持」并同样按阈值缓存。
- 失败处理：记录 `lastAttemptAt`，按 D19 退避；缓存记录写入时的扩展版本，版本变化视为过期（D6）。
- kill switch：远程可达且响应合法但缺某 id，该 id 立即卸载；快照仅在远程不可达且无缓存时参与合并（D6）。
- 覆盖范围：远程清单 id 命中 `NATIVE_BUILTIN_PLUGIN_IDS` 时忽略远程条目（D20）。

### 4.2 兼容判定与状态

`PluginHost.reconcile` 输出每个插件的状态而不是过滤：

```
invalid            结构不合法          丢弃
needs-engine       engine 区间不满足    禁用 · 需要 Voyager ≥ x.y
needs-handler      缺原语              禁用 · 请更新 Voyager（版本不可算，见 §5）
needs-semantic     缺语义键            禁用 · 需要更新的 <站点> 适配器
needs-permission   新增 matches 未授权  可见 · 现有「授予所需访问权限」流程
ready              可启用
mounted / no-effect 已挂载 / 健康信号标黄
```

popup 通过消息向当前标签页的 PluginHost 取状态渲染；标签页未注入（未授权、页面未加载完）时回退到本地推断。

### 4.3 更新应用

- 声明式贡献：`unmount` → `mount` 即时。
- 原语贡献：记录 `pendingVersion`，本页保持旧版本；整页加载时用新版本，SPA 内 pushState 不切换。popup 展示「刷新页面后生效」。

### 4.4 健康信号（D12）

- 原语 `activate` 后回报 `targets` 数量；引擎在 `MutationObserver` 静默（无 childList 变更）达到阈值后评估一次；阈值以观察器静默为准，固定超时只作上限，避免慢网误报。
- 仅当 `adapter.selectors.userTurn` 匹配数 > 0 且插件目标为 0 时标黄；空对话不标。
- 目标数变为 > 0 立即清除。
- 纯 CSS 插件（无 domOps、无原语）不评估。

## 5. 清单契约变更

```jsonc
{
  "format": 1,
  "id": "voyager.deepseek-timeline",
  "version": "1.1.0",
  "engine": ">=1.3.0",
  "requires": { "handlers": ["turnNavigator"], "semantic": ["userTurn", "scrollContainer"] },
  "changelog": "支持 DeepSeek 新版虚拟列表",
  "contributes": {
    "domOps": [{ "op": "native", "handler": "turnNavigator", "params": { "position": "right" } }],
  },
}
```

- 新 op：`{ op: 'native', handler, params }`，`handler` 必须在包内白名单，`params` 由该原语的手写 guard 校验（D17）。
- 语义键词汇表（一次定全）：`userTurn`、`assistantTurn`、`thinkingBlock`、`codeBlock`、`composer`、`sidebar`、`sidePanel`、`headerActions`、`scrollContainer`；另加 `conversationIdPattern`（路径正则）。
- 原语声明 `{ name, sinceEngine, params: guard + paramsSchema }`。`sinceEngine` 是原语首发的引擎版本；`plugin:check` 强制使用了原语的清单 `engine` ≥ 该原语 `sinceEngine`，于是 `needs-engine` 先于 `needs-handler` 命中，后者只剩配置错误。契约测试保证 `paramsSchema` 只允许新增可选字段。
- handler 不带 `@version` 后缀，破坏性变更起新名字（D9）。

## 6. 原语首发

| 原语            | 参数                                                                        | 来源                                                                                                                               |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `formulaCopy`   | 无（可选 `scope` 选择器）                                                   | `src/features/formulaCopy` 原样                                                                                                    |
| `vimInput`      | `composer`（缺省语义键）                                                    | `chatInput/vimMode.ts`，去掉写死的 Gemini 工具栏列表改为参数                                                                       |
| `turnNavigator` | `turn`、`conversationIdPattern`、`scrollContainer`、`yieldWhen`、`position` | `builtin/claudeTimeline` 参数化，其余逻辑不动；会话 id 前缀改为 `${adapter.id}:conv:<id>`，避免星标存储串站；coachmark id 各站共用 |

`yieldWhen` 名称保留：它是一个选择器参数，属于数据；C1 已改为评审规则而非按字段名拒绝。

Claude、ChatGPT 的现有 builtin 清单改写为使用原语的 JSON，随本体打包，行为不变。

## 7. Prompt Manager 路径统一

插件平台路径复用 `createCustomSiteCoverageReconciler`；popup 站点名读适配器 `label`，删除 `Popup.tsx` 中的手写映射。

## 8. 工具链与 skill

- `bun run plugin:check <dir>`：`validateManifest`、`validateStyleCss`、10 语种齐全、`requires` 引用存在、`format` 正确、`engine` ≥ 所用原语 `sinceEngine`、插件 `matches` ⊆ 站点 `matches`；进 CI。
- `docs/public/plugin.schema.json`、`site.schema.json` 手写发布，`$schema` 指向它们；测试用示例清单同时过 schema 与 guard（D17）。
- `.agents/skills/create-voyager-plugin/SKILL.md`：三条路径（插件 / 适配器 / 原语）；证据硬要求（真实页面截图或录屏、`plugin:check` 输出、目标匹配数）；原语 PR 需两个站点数据的参数化测试；原语只增不改。
- `bun run plugin:new <id> --site <host>` 脚手架：生成目录、10 语种骨架、README、追加 CODEOWNERS 提示。
- 通用参数化测试遍历所有 `sites/*/plugins/*`：mount → updateSettings → unmount 还原宿主状态。

## 9. 阶段与验收

每阶段独立可合并，任一阶段停下系统仍可用。

| 阶段 | 内容                                                                                                                                                                                                         | 验收                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| P1   | `HostCatalogSource`、后台单飞刷新、D4/D5/D19 触发与设置、popup 页脚与来源标签、版本号显示、隐私契约与文案、`build-plugin-catalog` + Pages 部署（含 `paths` 与 Cloudflare purge）、旧缓存键忽略、D20 覆盖范围 | 断网仅快照；DeepSeek 启用插件后 6h 内一次请求；Gemini 页面零请求（网络面板证据）；`bun run verify:pr` |
| P2   | 目录按站点重排、`import.meta.glob` 自动发现、适配器数据化 + 薄壳、语义键词汇表、Prompt Manager 路径统一、CODEOWNERS                                                                                          | 现有 4 个声明式插件行为不变（通用参数化测试）；适配器远程覆盖后品牌色变化可见                         |
| P3   | `native` op、`requires`、状态机、`formulaCopy` 原语、健康信号、更新时机、角标与 changelog                                                                                                                    | DeepSeek 上远程启用公式复制；缺原语的清单在旧版本显示禁用原因；空对话不标黄                           |
| P4   | `vimInput`、`turnNavigator`、Claude/ChatGPT builtin 改写为 JSON、工具链与 skill、脚手架                                                                                                                      | DeepSeek 时间线仅靠远程 JSON 生效；`plugin:check` 进 CI                                               |

## 10. 回滚

- 远程内容：revert 主仓提交，Pages 重新部署并 purge CDN，客户端下次检查即回退（D6）。
- 客户端：全局开关关闭即回到快照；任一阶段可单独 revert，不触及用户存储。

## 11. 商店政策结论（2026-09-07 调研，含原文出处）

### 11.1 结论

- Chrome：远程 JSON/CSS 明确允许（RHC 定义「不包括数据或 JSON、CSS 之类」）。红线是解释器：「构建解释器执行从远程获取的复杂命令，即使这些命令以数据形式获取」属违规（developer.chrome.com/docs/webstore/program-policies/mv3-requirements）。
- Firefox AMO：政策 §4.2 只禁「加载远程代码执行」，但审核指南的即拒表里有一条「add-on makes use of remote CSS scripts … Reject Immediately」（wiki.mozilla.org/Add-ons/Reviewers/Guide/Review_Decision，2024-09-27 修订）。上下文是与 innerHTML、dangerouslySetInnerHTML 并列的「未净化远程内容进 DOM」类，不是把 CSS 当代码，但它是活的审核清单项。判定：中等信心可过，必须按会被审核员命中来准备。
- 源码提交政策：「远程资源（如数据文件）不得用于掩盖扩展逻辑；不得基于外部资源做控制流决策」。
- 先例：uBlock Origin（AMO 推荐，远程过滤规则由内置引擎解释）、Stylus、Stylish 均在架。Dark Reader 当前源码无运行时远程拉取，不作先例。

### 11.2 由此新增的硬约束

| #   | 约束                                                                                                                                                                                 | 落点                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| C1  | 清单是无序集合，不含条件、循环、顺序依赖；`params` 只是配置，不是指令                                                                                                                | 原语 params schema 评审项与 skill 检查清单；不按字段名机械拒绝，`yieldWhen` 这类选择器参数是数据            |
| C2  | 远程内容进 DOM 只允许 `textContent` 与属性 API，引擎与原语代码禁止 `innerHTML`/`insertAdjacentHTML` 处理远程字符串                                                                   | 源码层契约测试扫描 `src/features/plugins/**`；现状已符合（`declarativeEngine.ts:139/271` 用 `textContent`） |
| C3  | CSS 净化保持：拒绝 `@import`、外部 `url()`、`-moz-binding`、`expression()`                                                                                                           | `validateStyleCss` 补后两项                                                                                 |
| C4  | 远程通道必须有用户可关的开关（D5 已含）；商店列表文案照 uBO 模板写明「插件目录只在更新时连接 voyager.nagi.fun，关闭插件在线更新后除非手动点击不会再连接」，范围限定为插件目录（D13） | P1 隐私文案                                                                                                 |
| C5  | Firefox 清单 `browser_specific_settings.gecko.data_collection_permissions: { "required": ["none"] }`                                                                                 | 已完成：`vite.config.firefox.ts` 构建期写入，本方案不改                                                     |
| C6  | 远程开关做成构建期可配：若 AMO 审核拒绝，Firefox 版本先以快照模式发布，其余浏览器不受影响                                                                                            | P1                                                                                                          |
| C7  | 保持 `none`；列表文案写明请求内容与频率（仅 IP/UA，按 D5 阈值）；AMO 若不认，以 C6 快照模式发布 Firefox                                                                              | P1 隐私文案                                                                                                 |

## 12. 实现者须知（本轮讨论中确认、文档其他章节未展开的事实）

### 12.1 现状地图（2026-09-07 `origin/main` = 18041a07）

| 事实                                                                                             | 位置                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容脚本在每个被注入页面无条件启动 PluginHost，自行探测适配器；无适配器时语义选择器 warn 后跳过  | `src/pages/content/index.tsx` ~604-616；`declarativeEngine.ts` `resolveSelector`                                                                                 |
| 插件平台与自定义站点的 Prompt Manager 走两条路径，前者无 live 开关同步                           | `index.tsx` ~228-250（reconciler）与 ~709-745（插件平台）                                                                                                        |
| 来源合并「同 id 先到先得」，顺序 builtin → bundled → marketplace；远程永远覆盖不了同名打包插件   | `sources/defaultSources.ts` `listPluginManifestsWithSources`                                                                                                     |
| 引擎按 `manifest.id` 查原生 handler，不区分清单来源                                              | `declarativeEngine.ts:117`                                                                                                                                       |
| 远程来源被一行注释关闭（2026-07-07，产品原因）                                                   | `defaultSources.ts`，提交 93c284c4                                                                                                                               |
| 旧整目录缓存键                                                                                   | `StorageKeys.PLUGIN_CATALOG_CACHE = 'gvPluginCatalogCache'`，`storage/catalogCache.ts`                                                                           |
| 公告服务已有 6h 后台 alarm 拉 raw.githubusercontent.com，带退避与用户开关                        | `src/features/announcements/background.ts`；`StorageKeys.REMOTE_ANNOUNCEMENTS_ENABLED`                                                                           |
| `deploy-docs.yml` 按 `paths` 过滤，目录改动不触发，只有每日 cron                                 | `.github/workflows/deploy-docs.yml`                                                                                                                              |
| `validate.ts` 刻意不用 schema 库；仓库无 zod                                                     | `src/features/plugins/manifest/validate.ts` 文件头                                                                                                               |
| 动态注册按所有清单的 `matches` 泛化；后台用同一来源算 `pluginSiteDomains` 排除自动加入自定义站点 | `runtime/siteRegistration.ts`；`background/index.ts` ~840-900、~1380                                                                                             |
| `manifest.matches` 的五处读者                                                                    | `PluginHost.shouldActivate`、`pluginsToOriginPatterns`、`pluginToOriginPatternsForActiveUrl`、`background.refreshPluginSiteDomains`、`Popup.siteScopedManifests` |
| 已打开标签页在授权后由后台主动注入，靠 `gv.content.ping` 判活                                    | `background/index.ts` ~1027                                                                                                                                      |
| popup 传给 PluginManager 的清单已按当前 URL 过滤                                                 | `Popup.tsx` ~1147 `siteScopedManifests`                                                                                                                          |
| 原生 handler 与插件 id 一对一绑定并双向校验                                                      | `pages/content/pluginNativeRegistration.ts` `verifyNativeHandlerBindings`                                                                                        |
| Claude 时间线会话 id 前缀 `claude:` 写死；星标存储各站共用                                       | `builtin/claudeTimeline/index.ts` `buildClaudeConversationId`；`StorageKeys.TIMELINE_STARRED_MESSAGES`                                                           |
| CSS 注入用 `textContent`                                                                         | `declarativeEngine.ts:139/271`                                                                                                                                   |
| 引擎版本与清单区间                                                                               | `constants.ts` `PLUGIN_ENGINE_VERSION = '1.2.0'`；`semver.ts` 只支持 `*`、精确、`>=`                                                                             |
| 文档站为 GitHub Pages（自带 CORS `*`），用户计划迁到 Cloudflare 代理                             | `.github/workflows/deploy-docs.yml`                                                                                                                              |
| Firefox 清单的 `data_collection_permissions` 由构建期写入                                        | `vite.config.firefox.ts`                                                                                                                                         |
| `SettingsBackupService` 有「每个 StorageKeys 必须分类」的覆盖测试                                | `src/core/services/SettingsBackupService.ts` ~159                                                                                                                |
| 适配器均为纯数据（含 deepseek），无函数                                                          | `sites/adapters/*.ts`                                                                                                                                            |
| DeepSeek 适配器与目录插件已在 main                                                               | `sites/adapters/deepseek.ts`；`catalog/plugins/deepseek-reading-width/`                                                                                          |
| `pluginScope.ts` 注释引用的 `.github/docs/CORDIS_CTX_RESEARCH.md` 不存在                         | 顺手修注释                                                                                                                                                       |

### 12.2 顺序与冲突

- P1 的 `build-plugin-catalog` 先按当前「按插件分目录」布局工作；P2 重排时同步改脚本。P1 不依赖 P2。
- `native` op 的 handler 白名单是新注册表，按原语名而非插件 id 键入；不要动 `verifyNativeHandlerBindings` 的既有语义，builtin 迁移为 JSON 后再收敛。P4 之前远程不覆盖 builtin id（D20）。

### 12.3 容易漏的仓库规则

- 新增用户设置（在线更新开关、检查间隔）走 `StorageKeys`，且要进 `SettingsBackupService` 默认值与迁移（AGENTS.md）。
- 动态键 `gvPluginHostCatalog:<host>` 以前缀登记进 `SettingsBackupService` 的分类（不备份），否则覆盖测试失败。
- 存储只增不删：旧 `gvPluginCatalogCache` 忽略，不清理。
- 所有新 popup 文案 10 语种齐全；清单 `changelog` 字段采用与 `name`/`description` 相同的 i18n 映射形状。
- 打包清单的 `format` 字段可缺省为 1；host 文件必须带。
- 触及后台、存储、插件运行时属高复杂度模块：整文件阅读、全量测试。
- 每个可复现的坑写进 `.github/docs/regressions/providers-plugins.md`，跑 `bun run regressions:check`。
- 不新增 `public/` 资源；目录产物进文档站，不进扩展包。

### 12.4 测试清单

- Gemini/AI Studio 页面与 popup：注入的 fetch stub 断言零调用。
- 已启用插件的 host：阈值内不请求、过期一次请求、多标签单飞；失败后按尝试时间退避。
- 远程优先与快照兜底：远程可用取远程；远程不兼容取快照并标更新；远程可达但缺 id 则卸载；远程不可达取上次缓存；扩展版本变化则缓存作废；404 缓存。
- 远程同 id 覆盖 builtin 清单：忽略远程条目，仍用本体。
- 状态机：每种不适用原因各一条，且 popup 渲染对应文案；标签页未注入时 popup 回退推断。
- 健康信号：空对话不标黄；慢网（观察器持续变动）不评估；目标出现后清除；纯 CSS 插件永不标黄。
- `plugin:check`：`engine` 低于所用原语 `sinceEngine` 报错；插件 `matches` 超出站点 `matches` 报错。
- 源码契约：插件运行时目录禁 `innerHTML`/`insertAdjacentHTML` 处理远程字符串；原语 paramsSchema 只允许新增可选字段；示例清单同时过 JSON schema 与 guard。
- 通用参数化测试遍历全部目录插件：mount → updateSettings → unmount 宿主状态还原。

### 12.5 外部依赖与责任

- Cloudflare 迁移由维护者完成；迁移后确认 `catalog/` 路径仍返回 `Access-Control-Allow-Origin: *`，否则 Safari/Firefox 后台 fetch 失败；部署后 purge 或短 `max-age` 也由维护者配置。
- 隐私与商店文案：实现者出草稿放在 P1 PR，维护者审后合并。
- 拉取地址是常量但可由构建期配置覆盖，便于预览环境。

## 13. 待验证（不阻塞）

- C7：AMO 是否将仅带 IP/UA 的目录请求视为数据收集。`none` 声明在 P1 提审时验证，不认则走 C6。

## 14. 实现记录

### P1（分支 `feat/plugin-host-catalog-p1`，2026-09-07）

- 运行时：`src/features/plugins/remote/`（`HostCatalogSource` 只读缓存；`hostCatalogRefresh` 后台单飞拉取；`hostCatalogPolicy` 阈值/退避/资格；`hostCatalogCache` 按 host 缓存与内容订阅；`hostCatalogSettings` 两个 sync 设置；`hostCatalogFile` 校验；`config` 构建期变量）。合并规则在 `sources/defaultSources.ts` `mergePluginRecords`。旧 `MarketplacePluginSource` 与整目录缓存模块已删除。
- 触发：`PluginHost` 仅在顶层 frame、且页面有已启用插件时向后台发 `gv.pluginCatalog.refresh`；popup 刷新按钮发 `force: true`。
- 发布：`bun run catalog:build` 写 `docs/public/catalog/hosts/<host>.json`，`deploy-docs.yml` 在 `docs:build` 前调用并已补 `paths`。
- 与设计的偏差（实现时定下，均已写进代码注释与回归笔记）：
  - 404 缓存为 `missing`，视为「无远程信息」，只有合法的同版本 host 文件才是权威（kill switch 不因部署缺失误触发）。
  - 自动检查的下一次时间 = 上次尝试 + max(阈值, 退避)；退避不会让检查比阈值更频繁。
  - 缓存条目带 `status: 'unknown'`（从未成功）以区分 404。
  - popup 设置区只在可算出 host 的插件站点显示；文案键见 `pluginsOnlineUpdates*`。
- 证据（Chrome 150，未打包 `dist_chrome`）：ChatGPT 标签页（已启用导出插件）触发恰好一次 `hosts/chatgpt.com.json` 请求（当前 404 → `missing`），两个 ChatGPT 标签页共用一次；手动检查再发一次；标签页刷新不再请求；Gemini 页面零请求、无控制台错误；popup 显示版本与来源标签、在线更新开关、间隔选择与状态行。
- 待办：目录尚未部署（合并后由 Pages 发布并配置 Cloudflare purge）；Firefox/Safari 实机未测；文档站 8 个旧结构语种的隐私页只追加了本功能一节。
