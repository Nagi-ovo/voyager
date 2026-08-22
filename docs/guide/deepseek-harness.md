# DeepSeek Harness

DeepSeek 官方的开源编码 agent，跑在你自己的机器上。

它有个网页界面，地址是 `localhost:3080`。

网页界面，就意味着 Voyager 能进去。

## 为什么能进去

Voyager 的提示词库不认域名，只认「你添加过的站点」。

本地地址也是站点。

所以 DeepSeek Harness 和 Gemini、Claude、ChatGPT 一样，都是它能落脚的地方。

## 三步接上

### 1. 把 DSH 跑起来

```bash
npm i -g @deepseek-ai/dsh
dsh web
```

浏览器打开 `http://localhost:3080`。

### 2. 在弹窗里打开开关

![点工具栏拼图图标，点 Voyager，打开「在 localhost:3080 上开启提示词管理器」](/assets/dsh-enable-steps-zh.png)

因为你人就在 `localhost:3080` 这个页面上，弹窗顶上会直接出现这一条。打开它，授权访问。

不用手打地址。

### 3. 刷新页面

浮窗按钮就出现在右下角了。

![在 DeepSeek Harness 中运行的提示词管理器](/assets/prompt-manager-deepseek-harness.png)

## 同一份提示词库

不是每个站点一个库，是一个库跟着你走。

你在 Gemini、Claude、ChatGPT 上存过的提示词，打开 DSH 就在那儿，一条不少。反过来也一样：在 DSH 里新写的提示词，回到 Gemini 照样调得出来。

标签、收藏、搜索，全都是同一套。

![同一份提示词库，落到每一个界面上](/assets/one-prompt-library.png)

## 几件小事

**端口不是固定的。** DSH 还在开发者预览版，默认端口以后可能变。真变了，按新端口再加一次就行。

**只有提示词库会加载。** 时间线、文件夹这些是为 Gemini 写的，在自定义站点上不会启动。

**你的提示词没有离开这台机器。** DSH 在本地，Voyager 的库也在本地。整条链路不出门。

::: tip
同样的办法适用于任何本地 Web UI——Open WebUI、LibreChat、你自己写的那个。填地址，刷新，就有了。
:::
