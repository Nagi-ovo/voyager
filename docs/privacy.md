# 隐私政策

最后更新：2026 年 9 月 7 日

## 概述

Voyager 是一个以本地处理为主的浏览器扩展，用于整理和增强受支持的 AI 对话工作区。它只会为用户主动使用的功能处理必要的数据。Voyager 不运营用于接收对话、提示词、浏览活动、图片或账户标识的后端，也不使用广告或分析追踪器。

## 处理的数据

根据您使用的功能，Voyager 可能会处理：

- **网站内容和个人通信**：对话文本、提示词、草稿、图片、链接及其他受支持页面内容，用于文件夹、导航、导出、提示词管理、研究和界面功能。
- **账户标识**：受支持的 Google 服务可能提供当前登录邮箱。Voyager 会将其转换为本地账户标识，用于隔离不同账户的数据；原始邮箱不会发送给我们。
- **网页历史和用户活动**：受支持网站的 URL、对话路由，以及实现导航、快捷键、用量显示、回复完成通知等功能所需的有限页面、交互和网络事件。这些数据不会用于画像或广告。
- **身份验证信息**：仅在用户主动启用 Google Drive 同步时使用、权限范围为 `drive.file` 的 OAuth2 令牌。
- **扩展数据和设置**：文件夹、提示词模板、草稿、星标消息、用量快照、插件状态和界面偏好。

这些数据保存在 `chrome.storage.local`，或在受支持的情况下保存在 `chrome.storage.sync`。除非用户主动使用下述传输功能，否则数据只保留在用户设备或浏览器同步账户中。

## 用户主动发起的数据传输

- **Google Drive 同步（可选）**：选定的备份数据会在用户设备与用户自己的 Google Drive 之间直接传输。Chrome、Edge 和 Firefox 使用浏览器身份 API；Safari 直装版使用原生 Google Sign-In，并将凭据保存在 macOS 钥匙串中。两种路径都只申请权限受限的 `drive.file` 范围，OAuth 令牌不会发送到 Voyager 服务器。
- **Safari iCloud 同步（可选）**：选定的备份数据由 Safari 原生扩展直接传输到用户 iCloud 账户的私有 CloudKit 数据库。Voyager 不会取得用户的 Apple ID 或 iCloud 身份验证令牌，开发者也无法访问该私有数据库中的记录。
- **导出和图片**：用户发起导出时，Voyager 可能从页面原有来源获取图片，并可能临时申请捕获生成式界面内容所需的访问权限。导出文件直接提供给用户，不会上传到 Voyager 服务器。
- **公开项目资源**：Voyager 可能请求公开的版本、公告或文档资源；这些请求不会携带对话或提示词内容。
- **插件目录更新**：在用户已启用至少一个插件的网站上，Voyager 可能通过 HTTPS 请求该网站对应的插件目录文件 `https://voyager.nagi.fun/catalog/hosts/<网站主机名>.json`，例如 `https://voyager.nagi.fun/catalog/hosts/chat.deepseek.com.json`。检查只在打开这类页面、或在这类页面上打开扩展弹窗时进行，并且距上次检查已超过用户选择的间隔（默认 6 小时，可选 1 小时、6 小时、24 小时或仅手动）。Gemini 和 AI Studio 页面没有插件，因此不会触发任何请求。该请求是一次普通的 GET：不携带 Cookie，不携带账户或扩展标识，也不携带页面或对话内容；与任何网络请求一样，服务器会看到发起请求的 IP 地址和浏览器 User-Agent，以及 URL 路径中的网站主机名。在有插件的网站上，弹窗提供“插件在线更新”开关和检查间隔选项，两项设置保存在浏览器同步存储中，并包含在设置备份内。关闭该开关后，除非用户点击“立即检查插件更新”，Voyager 不会连接 voyager.nagi.fun。如果请求失败或该网站没有目录文件，扩展将继续使用随扩展打包的插件快照。获取到的目录只包含 CSS 和 JSON，使用前会经过校验和净化；不会下载或执行任何 JavaScript。此检查与公告检查相互独立，公告检查有自己的开关。

Voyager 不会出售用户数据，也不会将其用于广告、信用评估或与扩展面向用户的功能无关的目的。

## 权限说明

- **Storage（存储）**：在本地保存扩展数据和偏好，并在受支持时使用浏览器同步。
- **Identity（身份认证）**：在用户明确操作后，为可选的 Google Drive 同步进行认证。Safari iCloud 同步使用 Mac 的系统 iCloud 账户，不使用此浏览器权限。
- **Scripting（脚本注入）**：只在受支持网站注入扩展自身打包的脚本，不执行远程 JavaScript 或 WebAssembly。
- **Active tab 和 Declarative content**：识别用户当前打开的受支持网站，并显示对应的网站设置。
- **Notifications 和 Alarms**：提供可选的回复完成通知，并定期检查公开的兼容性公告。
- **Host permissions（主机权限）**：在 Gemini、AI Studio、Claude 和 ChatGPT 上提供 Voyager 功能，并支持用户主动发起的 Google Drive 和图片操作。
- **Optional host permissions（可选主机权限）**：只申请用户明确启用的自定义网站或插件来源。用户选择捕获生成式界面内容的导出方式时，也可能临时申请 `<all_urls>`；如果用户拒绝，导出会跳过该捕获并继续进行。

## 保留期限和用户控制

本地和浏览器同步数据会保留到用户删除数据、清除扩展存储或卸载扩展为止。云端备份会保留在用户所选的 Google Drive 或 iCloud 账户中，直到用户从该账户中删除。用户可以在 Voyager 和浏览器设置中关闭可选功能，并撤销可选网站权限或 Google 授权。

## Google API Limited Use

Voyager 对从 Google API 获取的信息的使用和传输，遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。

## 政策变更

我们可能会随着 Voyager 的变化更新本隐私政策。最新版本及更新日期会发布在本页面。

## 联系我们

如有隐私问题，请通过 [Voyager GitHub 仓库](https://github.com/Nagi-ovo/voyager) 联系我们。
