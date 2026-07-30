> **🌐 语言 / Language**: [中文](#贡献指南) | [English](#contributing-to-voyager) | [Español](CONTRIBUTING_ES.md) | [Français](CONTRIBUTING_FR.md) | [日本語](CONTRIBUTING_JA.md)

---

# 贡献指南

> [!CAUTION]
> **本项目暂时不接受任何新功能的 PR。** 如果你有一个很想做的功能，请按以下流程操作：
>
> 1. **先开一个 Issue 与维护者讨论**你的想法和方案
> 2. **等待维护者同意，并确定了一个好的实现方案后**，再开始编码并提交 PR
>
> 未经讨论直接提交的新功能 PR 将被直接关闭，不予审核。感谢理解。

> [!IMPORTANT]
> **项目状态：低频维护。** 回复较慢。优先处理带测试的 PR。

感谢你考虑为 Voyager 做出贡献！🚀

本文档提供贡献的指南和说明。我们欢迎错误修复、文档改进和翻译等贡献。关于新功能，请务必先通过 Issue 进行讨论。

## AI 辅助 PR 政策

**欢迎使用 AI 辅助贡献，但 PR 必须由贡献者亲自复核和验证。**

AI 是很好的辅助工具，但缺少明确目标、聚焦范围和真实验证的复制粘贴贡献会浪费维护者的时间。

- 你需要为自己提交的 PR 负责，包括目标、范围、行为变化和验证结果；不需要完全读懂 Agent 生成的每一行代码，但要能说明这个 PR 要解决什么、为什么这样改。
- 开始编码前，请先和 Agent 讨论清楚需求、影响范围、预期行为和验证方式。
- 保持 PR 聚焦：一个 PR 只修一个问题，或只做一个清晰完整的改动，不要把多个无关变化塞在一起。
- 最重要的是验证：改完后请亲自体验真实流程。涉及 UI 或行为变化时，条件允许的话建议连续使用约 15 分钟，确认没有明显问题。
- 验证后再提交 PR，并附上可视化证据，例如截图、录屏或前后对比。
- **Git 协作能力**：你应熟悉 GitHub 和 Git 的基本工作流，确保能在 AI Agent 的辅助下正确进行开源协作。如果你对此尚不熟悉，建议先学习相关知识，请保持 PR 中的 Git 历史整洁，避免出现混乱的提交记录。

## 必须流程

1. 新功能先开 Issue，并等待维护者明确同意方案；`/claim` 或被分配只代表负责人。
2. 每次仓库改动都通过一个聚焦的主题分支提交 PR，不直接推送到 `main`。
3. 提交前依次运行 `bun run format`、`bun run lint` 和 `bun run verify:pr`，并说明任何未运行项。仅改动文档（docs/README）时，可用 `bun run format:check` 加 `bun run docs:build` 代替完整的 `verify:pr`。
4. 行为变更添加回归测试，或说明自动化测试不适用的理由。
5. 在受影响浏览器中加载实际扩展并验证改动流程；缺少环境时，在 PR 中注明未测试项和补测负责人。

> 💡 使用 AI Agent（Claude Code、Codex 等）贡献时，请让它使用仓库自带的 `voyager-contribute` skill（位于 `.claude/skills/` 与 `.agents/skills/`）：它内置上述流程与历史 PR 中最耗评审轮次的仓库特有陷阱。仓库外的 agent（如 Cursor）可用 `npx skills add Nagi-ovo/voyager -s voyager-contribute` 安装。

## 目录

- [快速开始](#快速开始)
- [认领 Issue](#认领-issue)
- [开发环境设置](#开发环境设置)
- [进行更改](#进行更改)
- [提交 Pull Request](#提交-pull-request)
- [代码风格](#代码风格)
- [添加 Gem 支持](#添加-gem-支持)
- [许可证](#许可证)

---

## 快速开始

### 前置要求

- **Bun 1.3.12**（与 `packageManager` 和 CI 一致）
- **GitHub CLI（`gh`）**（[安装](https://cli.github.com/)）：安装后运行 `gh auth login` 完成认证，再运行 `gh auth status` 确认当前账号就是你准备用来贡献的账号；`voyager-contribute` skill 依赖它查询和发布 Issue/PR。没有 `gh` 时可改用 GitHub 网页操作，并在 PR 中注明。
- 用于加载扩展并验证真实流程的受影响浏览器

### 快速启动

```bash
# 克隆仓库
git clone https://github.com/Nagi-ovo/voyager.git
cd voyager

# 安装依赖
bun install

# 启动开发模式
bun run dev
```

---

## 认领 Issue

为避免重复工作并协调贡献：

### 1. 检查现有工作

在开始之前，检查 issue 的 **Assignees** 部分，确认是否已有人被分配。

### 2. 认领 Issue

对于未分配且**没有** `community-only` 标签的 issue，评论 `/claim`，机器人会自动将你分配为负责人。

### 3. 社群专属 Issue

带有 `community-only` 标签的 issue 仅供经确认的 Voyager 社群成员认领：

1. 社群成员评论 `/claim`。
2. 维护者确认社群身份后评论 `/approve @用户名`。
3. 机器人完成分配后再开始实现或提交 PR。

该标签会自动移除 `help wanted` 和 `good first issue`，避免把社群任务作为公开招募任务展示。尚未加入社群的贡献者可以先加入 [Voyager Discord](https://discord.gg/TEUFxdMbGb)，或选择没有 `community-only` 标签的 issue。

### 4. 取消认领

如果你无法继续处理某个 issue，评论 `/unclaim` 即可释放它供他人处理。

### 5. 贡献意愿复选框

创建 issue 时，你可以勾选"我愿意贡献代码"复选框，表明你有兴趣实现该功能或修复。

---

## 开发环境设置

### 安装依赖

```bash
bun install
```

### 可用命令

| 命令                  | 描述                             |
| --------------------- | -------------------------------- |
| `bun run dev`         | 启动 Chrome 开发模式（热重载）   |
| `bun run dev:firefox` | 启动 Firefox 开发模式            |
| `bun run dev:safari`  | 启动 Safari 开发模式（仅 macOS） |
| `bun run build`       | Chrome 生产构建                  |
| `bun run build:edge`  | Edge 独立构建与打包              |
| `bun run build:all`   | Chrome + Firefox + Safari 构建   |
| `bun run lint`        | 运行 ESLint 并自动修复           |
| `bun run typecheck`   | 运行 TypeScript 类型检查         |
| `bun run test`        | 运行测试套件                     |
| `bun run verify:pr`   | 标准本地 PR 自动验证             |

### 加载扩展

1. 运行 `bun run dev` 启动开发构建
2. 打开 Chrome，访问 `chrome://extensions/`
3. 启用"开发者模式"
4. 点击"加载已解压的扩展程序"，选择 `dist_chrome_dev` 文件夹

---

## 进行更改

### 开始之前

1. **从 `main` 创建分支**：

   ```bash
   git checkout -b feature/your-feature-name
   # 或
   git checkout -b fix/your-bug-fix
   ```

2. **关联 Issue** - 在实现一个新功能时，请**务必先开启一个 Issue 进行讨论**。未经讨论直接提交的新功能 PR 将被关闭。在提交 PR 时，请链接该 Issue。

### 提交前检查清单

提交前，请务必运行：

```bash
bun run format     # 格式化代码
bun run lint       # 修复代码风格问题
bun run verify:pr  # 标准本地 PR 自动验证
```

并确保：

1. 你的更改实现了预期功能。
2. 你的更改没有影响现有的原有功能。

---

## 测试策略

测试最可能回归的接口：逻辑与复杂状态使用自动化测试；选择器、挂载/清理或 SPA 导航发生变化时添加最小 DOM 回归测试；单元测试不能代替真实浏览器加载与流程验证。

---

## 提交 Pull Request

### PR 指南

1. **标题**：使用清晰的描述性标题（如 "feat: add dark mode toggle" 或 "fix: timeline scroll sync"）
2. **描述**：解释你做了什么更改以及原因
3. **用户影响**：描述用户将如何受到影响
4. **可视化证据（严格）**：对于任何 UI 修改或新功能，**必须**提供截图或屏幕录制。**没有截图 = 不予审核/回复。**
5. **Issue 引用**：链接相关 issue（如 "Closes #123"）
6. **测试与逻辑**：行为变更须包含相关回归测试；没有适用的自动化测试时，说明理由和修改逻辑。不接受没有上下文的“魔法”修复。

### 提交信息格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` - 新功能
- `fix:` - 错误修复
- `docs:` - 文档更改
- `chore:` - 维护任务
- `refactor:` - 代码重构
- `test:` - 添加或更新测试

---

## 代码风格

### 通用指南

- **优先使用提前返回**而非嵌套条件
- **使用描述性名称** - 避免缩写
- **避免魔法数字** - 使用命名常量
- **匹配现有风格** - 一致性优于偏好

### TypeScript 约定

- **PascalCase**：类、接口、类型、枚举、React 组件
- **camelCase**：函数、变量、方法
- **UPPER_SNAKE_CASE**：常量

### 导入顺序

1. React 及相关导入
2. 第三方库
3. 内部绝对导入（`@/...`）
4. 相对导入（`./...`）
5. 仅类型导入

---

## 添加 Gem 支持

如需为新 Gem（官方 Google Gems 或自定义 Gems）添加支持：

1. 打开 `src/pages/content/folder/gemConfig.ts`
2. 在 `GEM_CONFIG` 数组中添加新条目：

```typescript
{
  id: 'your-gem-id',           // URL 中的 ID：/gem/your-gem-id/...
  name: 'Your Gem Name',       // 显示名称
  icon: 'material_icon_name',  // Google Material Symbols 图标
}
```

### 查找 Gem ID

- 打开与该 Gem 的对话
- 检查 URL：`https://gemini.google.com/app/gem/[GEM_ID]/...`
- 在配置中使用 `[GEM_ID]` 部分

### 选择图标

使用有效的 [Google Material Symbols](https://fonts.google.com/icons) 图标名称：

| 图标           | 用途           |
| -------------- | -------------- |
| `auto_stories` | 学习、教育     |
| `lightbulb`    | 创意、头脑风暴 |
| `work`         | 职业、专业     |
| `code`         | 编程、技术     |
| `analytics`    | 数据、分析     |

---

## 项目范围

Voyager 通过以下功能增强 Gemini AI 聊天体验：

- 时间线导航
- 文件夹组织
- 指令宝库
- 聊天导出
- UI 自定义

> [!NOTE]
> **我们认为 Voyager 的功能已经足够充分且全面。** 引入过多个性化、小众的功能不会让软件更好用，反而会增加维护负担。除非你认为某个功能确实是急需的、大多数用户都会用到的，否则不建议提交 Feature Request。

**不在范围内**：网站爬取、网络拦截、账户自动化。

---

## 获取帮助

- 💬 [GitHub Discussions](https://github.com/Nagi-ovo/voyager/discussions) - 提问
- 🐛 [Issues](https://github.com/Nagi-ovo/voyager/issues) - 报告错误
- 📖 [文档](https://voyager.nagi.fun/) - 阅读文档

---

## 许可证

提交贡献即表示你同意你的贡献将采用 [GPLv3 许可证](../LICENSE)。

---

# Contributing to Voyager

> [!CAUTION]
> **This project is currently NOT accepting PRs for new features.** If you have a feature you'd really like to build, please follow this process:
>
> 1. **Open an Issue first** to discuss your idea and approach with the maintainer
> 2. **Wait for approval and a solid implementation plan** before writing any code or submitting a PR
>
> New feature PRs submitted without prior discussion will be closed without review. Thank you for understanding.

> [!IMPORTANT]
> **Project Status: Low Maintenance.** Expect delays in response. PRs with tests are prioritized.

Thank you for considering contributing to Voyager! 🚀

This document provides guidelines and instructions for contributing. We welcome bug fixes, documentation improvements, and translations. For new features, please discuss via an Issue first.

## AI-Assisted PR Policy

**AI-assisted contributions are welcome, but every PR must be manually reviewed and verified by the contributor.**

AI tools can be helpful, but copy-paste PRs without clear intent, focused scope, or real validation waste maintainer time.

- You are responsible for the PR you submit: its goal, scope, behavior changes, and verification results. You do not need to fully understand every line generated by an agent, but you should be able to explain what the PR solves and why this approach is reasonable.
- Before coding, discuss the requirement with your agent clearly: scope, expected behavior, affected areas, and how to verify the change.
- Keep the PR focused: one PR should fix one issue or make one coherent change. Do not bundle unrelated changes together.
- Verification matters most: after making changes, use the real workflow yourself. For UI or behavior changes, please spend about 15 minutes testing it when possible.
- Submit the PR after verification, and include visual proof such as screenshots, screen recordings, or before/after clips.
- **Workflow Proficiency**: You should be familiar with GitHub and Git workflows and able to collaborate correctly using AI tools. If you are new to this, please learn the basics first to ensure a clean Git history in your PRs.

## Required Workflow

1. Open an Issue for a new feature and wait for explicit maintainer approval of the approach; assignment or `/claim` only selects an owner.
2. Submit every repository change through one focused topic-branch PR; do not push directly to `main`.
3. Run `bun run format`, `bun run lint`, and `bun run verify:pr` in that order, and disclose anything not run. For docs-only changes (docs/README), `bun run format:check` plus `bun run docs:build` may replace the full `verify:pr`.
4. Add regression tests for behavior changes, or explain why automation is not useful.
5. Load the real extension artifact in affected browsers and exercise the changed workflow; identify missing coverage and its owner in the PR.

> 💡 If you contribute with an AI agent (Claude Code, Codex, …), tell it to use the bundled `voyager-contribute` skill (under `.claude/skills/` and `.agents/skills/`): it encodes this workflow plus the repository-specific pitfalls that cost past PRs the most review rounds. Agents outside the repo checkout (e.g. Cursor) can install it via `npx skills add Nagi-ovo/voyager -s voyager-contribute`.

## Table of Contents

- [Getting Started](#getting-started)
- [Claiming an Issue](#claiming-an-issue)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Code Style](#code-style)
- [Adding Gem Support](#adding-gem-support)
- [License](#license)

---

## Getting Started

### Prerequisites

- **Bun 1.3.12** (matching `packageManager` and CI)
- **GitHub CLI (`gh`)** ([installation](https://cli.github.com/)): install it and authenticate with `gh auth login`, then run `gh auth status` to confirm the active account is the one you intend to contribute as; the `voyager-contribute` skill relies on it for Issue/PR state and publishing. Without `gh`, use the GitHub web UI instead and note that in the PR.
- The affected browsers for loading the extension and exercising the real workflow

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Nagi-ovo/voyager.git
cd voyager

# Install dependencies
bun install

# Start development mode
bun run dev
```

---

## Claiming an Issue

To avoid duplicate work and coordinate contributions:

### 1. Check for Existing Work

Before starting, check if the issue is already assigned to someone by looking at the **Assignees** section.

### 2. Claim an Issue

For an unassigned issue **without** the `community-only` label, comment `/claim` to assign yourself automatically. A bot will confirm the assignment.

### 3. Community-only Issues

Issues labeled `community-only` are reserved for verified members of the Voyager community:

1. A community member comments `/claim`.
2. A maintainer verifies their community membership and comments `/approve @username`.
3. Start implementation or open a PR only after the bot assigns the issue.

The label automatically removes `help wanted` and `good first issue` so reserved work is not advertised as a public contribution task. Other contributors can join the [Voyager Discord](https://discord.gg/TEUFxdMbGb) or choose an issue without the `community-only` label.

### 4. Unclaim if Needed

If you can no longer work on an issue, comment `/unclaim` to release it for others.

### 5. Contribution Checkbox

When creating issues, you can check the "I am willing to contribute code" checkbox to indicate your interest in implementing the feature or fix.

---

## Development Setup

### Install Dependencies

```bash
bun install
```

### Available Commands

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `bun run dev`         | Start Chrome development mode with hot reload |
| `bun run dev:firefox` | Start Firefox development mode                |
| `bun run dev:safari`  | Start Safari development mode (macOS only)    |
| `bun run build`       | Production build for Chrome                   |
| `bun run build:edge`  | Standalone Edge build and package             |
| `bun run build:all`   | Chrome + Firefox + Safari builds              |
| `bun run lint`        | Run ESLint with auto-fix                      |
| `bun run typecheck`   | Run TypeScript type checking                  |
| `bun run test`        | Run test suite                                |
| `bun run verify:pr`   | Standard local PR automation                  |

### Loading the Extension

1. Run `bun run dev` to start the development build
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `dist_chrome_dev` folder

---

## Making Changes

### Before You Start

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Link Issues** - When implementing a new feature, you **must first open an Issue for discussion**. PRs for new features submitted without prior discussion will be closed. When submitting a PR, please link that Issue.

### Pre-Commit Checklist

Before submitting, always run:

```bash
bun run format     # Format code
bun run lint       # Fix linting issues
bun run verify:pr  # Standard local PR automation
```

Ensure that:

1. Your changes achieve the desired functionality.
2. Your changes do not negatively affect existing features.

---

## Testing Strategy

Test the interface most likely to regress: automate logic and complex state; add a minimal DOM regression test when selectors, mount/teardown, or SPA navigation changes; unit tests do not replace live extension loading and workflow checks.

---

## Submitting a Pull Request

### PR Guidelines

1. **Title**: Use a clear, descriptive title (e.g., "feat: add dark mode toggle" or "fix: timeline scroll sync")
2. **Description**: Explain what changes you made and why
3. **User Impact**: Describe how users will be affected
4. **Visual Proof (Strict)**: For ANY UI changes or new features, you **MUST** provide screenshots or screen recordings. **No screenshot = No review/reply.**
5. **Issue Reference**: Link related issues (e.g., "Closes #123")
6. **Tests & Logic**: Behavior changes need relevant regression tests; when no useful automated test exists, explain why and describe the logic. "Magic" fixes without context are not accepted.

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests

---

## Code Style

### General Guidelines

- **Prefer early returns** over nested conditionals
- **Use descriptive names** - avoid abbreviations
- **Avoid magic numbers** - use named constants
- **Match existing style** - consistency over preference

### TypeScript Conventions

- **PascalCase**: Classes, interfaces, types, enums, React components
- **camelCase**: Functions, variables, methods
- **UPPER_SNAKE_CASE**: Constants

### Import Order

1. React & React-related imports
2. Third-party libraries
3. Internal absolute imports (`@/...`)
4. Relative imports (`./...`)
5. Type-only imports

```typescript
import React, { useState } from 'react';

import { marked } from 'marked';

import { Button } from '@/components/ui/Button';
import { StorageService } from '@/core/services/StorageService';
import type { FolderData } from '@/core/types/folder';

import { parseData } from './parser';
```

---

## Adding Gem Support

To add support for a new Gem (official Google Gems or custom Gems):

1. Open `src/pages/content/folder/gemConfig.ts`
2. Add a new entry to the `GEM_CONFIG` array:

```typescript
{
  id: 'your-gem-id',           // From URL: /gem/your-gem-id/...
  name: 'Your Gem Name',       // Display name
  icon: 'material_icon_name',  // Google Material Symbols icon
}
```

### Finding the Gem ID

- Open a conversation with the Gem
- Check the URL: `https://gemini.google.com/app/gem/[GEM_ID]/...`
- Use the `[GEM_ID]` portion in your configuration

### Choosing an Icon

Use valid [Google Material Symbols](https://fonts.google.com/icons) icon names:

| Icon           | Use Case               |
| -------------- | ---------------------- |
| `auto_stories` | Learning, Education    |
| `lightbulb`    | Ideas, Brainstorming   |
| `work`         | Career, Professional   |
| `code`         | Programming, Technical |
| `analytics`    | Data, Analysis         |

---

## Project Scope

Voyager enhances the Gemini AI chat experience with:

- Timeline navigation
- Folder organization
- Prompt vault
- Chat export
- UI customization

> [!NOTE]
> **We believe Voyager's feature set is already comprehensive and well-rounded.** Adding too many niche or overly personalized features does not make the software better — it only increases the maintenance burden. Unless you believe a feature is truly essential and would benefit the majority of users, please reconsider submitting a Feature Request.

**Out of scope**: Site scraping, network interception, account automation.

---

## Getting Help

- 💬 [GitHub Discussions](https://github.com/Nagi-ovo/voyager/discussions) - Ask questions
- 🐛 [Issues](https://github.com/Nagi-ovo/voyager/issues) - Report bugs
- 📖 [Documentation](https://voyager.nagi.fun/) - Read the docs

---

## License

By contributing, you agree that your contributions will be licensed under the [GPLv3 License](../LICENSE).
