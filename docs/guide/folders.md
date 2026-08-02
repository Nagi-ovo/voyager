# 文件夹，本该如此

整理 AI 聊天记录，以前怎么那么难？
我们修好了。给你的思绪，装个文件系统。

<div style="display: flex; gap: 20px; margin-top: 20px; flex-wrap: wrap; margin-bottom: 40px;">
  <div style="flex: 1; min-width: 300px; text-align: center;">
    <p><b>Gemini™</b></p>
    <img src="/assets/gemini-folders.png" alt="Gemini 文件夹" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);"/>
  </div>
  <div style="flex: 1; min-width: 300px; text-align: center;">
    <p><b>AI Studio</b></p>
    <img src="/assets/aistudio-folders.png" alt="AI Studio 文件夹" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);"/>
  </div>
</div>

## 整理的直觉

手感对了，一切都对了。

- **拖拽**：抓起来，扔进去。真实物理反馈。
- **套娃**：大项目套小项目。无限层级，随你定义。
- **间距**：自由调节侧边栏密度，从紧凑到宽松。
  > _注：Mac Safari 上的调整可能不是实时的，刷新页面即可生效。_
- **同步**：电脑上理好，笔记本上就能用。

## 绝招

- **多选**：长按对话项进入多选模式，批量操作，一次搞定。
- **改名**：双击文件夹，直接改。
- **识图**：代码、写作、闲聊... 我们自动识别 Gem 类型，配上图标。你只管用，剩下的交给我们。

## 平台特性差异

### 通用功能

- **基础管理**：拖拽排序、重命名、多选操作。
- **智能识别**：自动识别对话类型并匹配图标。
- **多级目录**：支持文件夹嵌套，结构更深邃。
- **AI Studio 适配**：上述高级功能即将支持 AI Studio。
- **Google Drive 同步**：支持将文件夹结构同步到 Google Drive。

### Gemini 专属增强

#### Activity 注意力视图

文件夹标题右侧的铃铛会把目录切换成一个只读的 Activity 视图。它不会移动、复制或重新分类任何对话，只是换一种查看方式：

- **优先**：显示最近 3 小时内有真实对话活动的会话，不使用查看或打开时间。
- **今天、昨天、具体星期**：按最近一次真实对话时间排列，并只保留今天与此前四个自然日。
- Star 是独立的手动标记，不会决定对话是否进入优先分组。
- 更早或时间未知的对话不进入 Activity，仍可在原来的文件夹树中找到。
- 每条记录都会保留所属文件夹路径；同一对话被放进多个文件夹时，Activity 里只显示一次。

再次点击铃铛即可回到原来的文件夹树。左侧箭头仍然只负责折叠整个区域。

[查看 Activity 注意力视图的完整说明](/guide/activity-view)

#### 隐藏已归档对话

对话归入文件夹后，它就算"处理完了"——但默认情况下它还会继续占据主侧边栏的位置。在扩展弹窗 → **文件夹选项** 里开启 **隐藏已归档对话**，主列表就只保留进行中的对话，真正的 inbox zero。

- 你第一次把对话拖入文件夹时，Voyager 会在文件夹区域弹出一张小卡片，一键即可开启。不想用的话点"暂不开启"，不会再打扰你。
- 已归档对话 **永远不会被删除**——随时可在文件夹中查看。
- 任何时候都能在弹窗里关闭此功能。

#### 自定义颜色

点击文件夹图标自定义颜色。内置 7 种默认配色，亦支持通过调色盘选取你的专属色彩。

<img src="/assets/folder-color.png" alt="文件夹配色" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-top: 10px; max-width: 600px;"/>

#### 账号隔离

侧栏人像按钮只用于临时显示当前 Google 账号的对话，默认关闭。弹窗「文件夹选项」里的 Hard Isolation 会进一步按账号拆分文件夹与云同步数据。Hard Isolation 开启后数据已经天然隔离，因此侧栏人像按钮会自动隐藏。

<img src="/assets/current-user-only.png" alt="账号隔离模式" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-top: 10px; max-width: 600px;"/>

#### AI 自动整理

对话太多，懒得手动分？让 Gemini 替你想。

一键复制当前对话结构，粘贴给 Gemini，它会帮你生成一份整理好的文件夹方案——直接导入，即刻生效。

**第一步：复制对话结构**

在扩展弹窗的文件夹区域底部，点击 **AI Organize** 按钮。它会自动收集你所有未归类的对话和现有文件夹结构，生成一段提示词并复制到剪贴板。

<img src="/assets/ai-auto-folder.png" alt="AI Organize 按钮" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px;"/>

**第二步：让 Gemini 整理**

将剪贴板内容粘贴到 Gemini 对话中，它会分析你的对话标题并输出一段 JSON 格式的文件夹方案。

**第三步：导入分类结果**

点击文件夹面板菜单中的 **Import folders**，选择 **Or paste JSON directly**，将 Gemini 返回的 JSON 粘贴进去，点击 **Import**。

<div style="display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; margin-bottom: 24px;">
  <div style="text-align: center;">
    <img src="/assets/ai-auto-folder-2.png" alt="导入菜单" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 240px;"/>
  </div>
  <div style="text-align: center;">
    <img src="/assets/ai-auto-folder-3.png" alt="粘贴 JSON 导入" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px;"/>
  </div>
</div>

- **增量合并**：默认使用"Merge"策略，只添加新文件夹和新分配，不会破坏你已有的分类。
- **多语言**：提示词会自动使用你设置的语言，文件夹名也会用对应语言生成。

#### 文件夹即项目

想让新对话自带一套轻量“项目预设”？把任意文件夹变成项目即可。
这个设计参考了 Claude Projects，但 Voyager 采用的是更轻量的实现：基于文件夹的首轮指令 + 自动归档，而不是共享上下文工作区。

1. 在扩展弹窗中开启 `启用文件夹作为项目`。
2. 右键某个文件夹，选择 `设置指令` 或 `编辑指令`。
3. 打开一个新的 Gemini 对话，在输入框旁的文件夹选择器里选中它。
4. 发送第一条消息。

接下来会发生什么：

- 首次发送后，这个对话会自动归入该文件夹。
- 如果文件夹配置了指令，Voyager 只会在第一次发送时临时附加这些指令。
- 如果文件夹没有指令，它仍然可以作为一个快速归档入口。
- 同一文件夹下的对话 **不会** 共享记忆，也不会自动互相读取内容。
- 草稿自动保存只保留你输入的正文，不会把隐藏指令重新塞回输入框。

### AI Studio 专属增强

- **侧边栏调节**：鼠标拖拽边缘，自由调整侧边栏宽度。
- **库拖拽支持**：支持直接从 Library 列表中拖拽项目到文件夹。
