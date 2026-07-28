# GitHub Release Body Template

## Contents

- Why this exists as a separate artifact from the in-product changelog
- Full template (copy-ready skeleton)
- Generation procedure (collect → filter → write rows → contributors → paste → apply)
- Worked example — v1.3.9

---

This is the body that lands on `https://github.com/Nagi-ovo/voyager/releases/tag/v{VERSION}`. It's **derivative of the in-product changelog** (`src/pages/content/changelog/notes/{VERSION}.md`) but reformatted for a developer audience:

- Two languages (English + 简体中文), rendered as **separate sections** — not mixed per cell.
- Table format with PR/commit attribution in a third column.
- Skips `zh_TW`, `ja`, `fr`, etc. (those live in the in-product changelog).

## Why this exists as a separate artifact from the in-product changelog

| Audience                         | File                                             | Format                                     |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| End users (in-product)           | `src/pages/content/changelog/notes/{VERSION}.md` | 10 locales, bullet lists                   |
| Developers (GitHub release page) | posted via `gh release edit --notes-file`        | en + zh, tables with PR/commit attribution |

The workflow (`.github/workflows/release.yml`) generates a default body on tag push using `gh api releases/generate-notes`. The default has contributor attribution but is **not** the curated table. After the workflow finishes, overwrite the body with this template.

## Layout principle — EN on top, ZH stacked below

Two prior iterations didn't work:

1. **Mixed-cell EN+ZH** (e.g. `**Feature name** 功能名 | Description here. 一句中文描述。`) — every reader parses 2× the text they need.
2. **Chinese section wrapped in `<details>` (the 1.4.0–1.4.5 era)** — saved vertical space but ZH readers had to click to expand. Most users dismissed without seeing the Chinese notes at all. Discoverability beats compactness for this audience.

Current layout:

- **English tables at the top** (the GitHub release page audience skews global; EN gets first-screen real estate).
- **Chinese section rendered directly below**, separated by a thin `---` divider and an `## 中文版` heading. Both languages are visible without interaction.
- **Drop the "Implemented in" / "实现" column when every row is `direct commit by @Nagi-ovo`** — that column is pure noise when 100% owner-attributed. Inline the `closes #NNN` reference into the description for the rare row that needs it. Add a single trailer line `_All changes by @Nagi-ovo unless noted._` (and `_除特别注明外，均由 @Nagi-ovo 提交。_` in the ZH section) below each language's tables.
- **Keep the column when external contributors landed PRs in this release** — attribution matters more than column-drop savings. Each PR row reads `PR #NNN by @author`; owner rows read `—` or are dropped to a footer note.

Shared metadata (Full Changelog URL, New Contributors) lives once, at the very bottom after the Chinese tables.

## Full template

Two flavors — pick based on whether external contributors landed PRs in this release.

### Flavor 1 — Owner-only release (drop attribution column)

```markdown
## ✨ What's New

| Feature            | Description                                           |
| ------------------ | ----------------------------------------------------- |
| **{Feature Name}** | {One-line description.} _(closes #NNN if applicable)_ |

{repeat rows…}

## 🐛 Bug Fixes

| Fix            | Description             |
| -------------- | ----------------------- |
| **{Fix Name}** | {One-line description.} |

{repeat rows…}

_All changes by @Nagi-ovo unless noted._

---

## 中文版

## ✨ 新功能

| 功能         | 说明                              |
| ------------ | --------------------------------- |
| **{功能名}** | {一句话说明。}（关联 #NNN，可选） |

{repeat rows…}

## 🐛 修复

| 修复         | 说明           |
| ------------ | -------------- |
| **{修复名}** | {一句话说明。} |

{repeat rows…}

_除特别注明外，均由 @Nagi-ovo 提交。_

---

## New Contributors ← omit if none

- @{user} made their first contribution in PR #{NNN}

**Full Changelog**: https://github.com/Nagi-ovo/voyager/compare/v{PREV_VERSION}...v{VERSION}
```

### Flavor 2 — Mixed contributors (keep attribution column)

When external PRs landed, the column carries information worth a column. Owner rows leave a `—` rather than repeating the handle on every row.

```markdown
## ✨ What's New

| Feature             | Description             | By                     |
| ------------------- | ----------------------- | ---------------------- |
| **{Feature Name}**  | {One-line description.} | PR #{NNN} by @{author} |
| **{Owner Feature}** | {One-line description.} | —                      |

{repeat rows…}

(rest of the structure is identical to Flavor 1, with the matching `By` / `提交者` column in the ZH table; drop the trailer line since attribution is per-row)
```

### Layout notes

- The `## 📥 Installation` section and the Safari block are appended by the workflow — do not duplicate them. They sit below the Chinese tables.
- The Installation block should show Chrome Web Store + Microsoft Edge Add-ons + Firefox buttons (Edge button links to `https://microsoftedge.microsoft.com/addons/detail/voyager/gibmkggjijalcjinbdhcpklodjkhhlne`), plus the "Edge users: Voyager is still maintained on Edge Add-ons" note.

## Generation procedure

Perform these steps after the tag push completes (see SKILL.md Step 6).

### 1. Collect data

```bash
PREV_TAG=$(git describe --tags --abbrev=0 v{VERSION}^)
git log ${PREV_TAG}..v{VERSION} --oneline        # authoritative list of commits for the tables
gh api repos/Nagi-ovo/voyager/releases/generate-notes \
  -f tag_name=v{VERSION} \
  -f previous_tag_name=${PREV_TAG} \
  --jq '.body'                                    # use ONLY for the New Contributors section
```

**Important:** `generate-notes` has a `"What's Changed"` section that looks like a PR list — **don't use it as your source of truth for the tables**. It filters to external-contributor PRs only; owner (`@Nagi-ovo`) PRs get silently dropped. For v1.4.0, that meant PR #616, #614, #613 (all owner PRs) didn't appear even though they're user-facing features. Always drive the tables from `git log`, where every `feat`/`fix` commit shows up with its `(#NNN)` suffix when applicable. Use `gh pr view <NNN>` to confirm authors.

### 2. Filter commits for the tables

Include:

- `feat(…): …` → **What's New** row
- `fix(…): …` → **Bug Fixes** row

Exclude:

- `chore`, `style`, `refactor`, `ci`, `build` — internal noise
- `docs` — unless the doc change is user-visible (e.g., a new settings guide linked from the product)
- Sponsor/README updates
- Commits that roll back or amend other commits within the same release window

When in doubt, ask: "Would a user care?"

### 3. Write each row

Each row appears **twice** in the final body — once in the English table, once in the Chinese table. Same PR/commit attribution in both. Keep EN and ZH rows in the same order so readers can cross-reference by position.

**Feature/Fix column** — bold title, one language per table:

```
EN:  | **Pinned timeline preview** |
ZH:  | **固定时间线预览** |
```

**Description column** — one sentence per language. Keep under ~15 words.

```
EN:  | Keep the timeline preview panel pinned from the popup. |
ZH:  | 可在弹窗中将时间线预览面板固定显示。 |
```

**Attribution** — depends on which Flavor you're using (see `Full template` above):

- **Flavor 1 (owner-only release)**: no `By` column. Inline `(closes #NNN)` / `（关联 #NNN）` into the description for rows that reference an issue. Add the trailer line `_All changes by @Nagi-ovo unless noted._` (and ZH equivalent) below each language's tables.
- **Flavor 2 (mixed contributors)**: keep the `By` / `提交者` column. External PR rows read `PR #NNN by @author`; owner rows read `—` (em-dash) so the column is uniform width without repeating the handle.

Map commit → PR by scanning commit messages for `(#NNN)` suffixes, or by running `gh pr list --state merged --search "<commit-short-sha>"`.

### 4. New Contributors

Take this section from `gh api generate-notes` output — it correctly identifies first-time contributors across repo history. Don't handwrite it; you'll miss someone. This section stays English-only (GitHub auto-generates it that way and readers of both languages recognize the pattern).

### 5. Paste together

Combine sections into `release_body.md` in this order (top to bottom):

1. `## ✨ What's New` (EN) table
2. `## 🐛 Bug Fixes` (EN) table
3. `_All changes by @Nagi-ovo unless noted._` trailer (Flavor 1) — or skip if Flavor 2
4. `---` divider
5. `## 中文版` heading
6. `## ✨ 新功能` (ZH) table
7. `## 🐛 修复` (ZH) table
8. `_除特别注明外，均由 @Nagi-ovo 提交。_` trailer (Flavor 1) — or skip if Flavor 2
9. `---` divider
10. `## New Contributors` (omit entire section if the release has no new contributors — don't leave an empty heading)
11. `**Full Changelog**: …` link
12. ⚠️ Stop here. The workflow already appended the Installation block and Safari block.

### 6. Apply

```bash
gh release edit v{VERSION} --notes-file release_body.md
```

This overwrites the body. The asset list and Installation block are preserved if they live as a separate field — check `gh release view v{VERSION} --json body` immediately after and confirm the Installation section is still present and includes the Microsoft Edge Add-ons button alongside Chrome Web Store and Firefox. If it disappeared (because `--notes-file` replaced the entire body, including workflow-appended tail), append the Installation block manually before re-running.

**Safer alternative:** first read the current body, strip the curated sections if present (from a previous attempt), prepend the new curated sections, and write back. This preserves whatever the workflow put there:

```bash
CURRENT=$(gh release view v{VERSION} --json body --jq '.body')
# Find the line "## 📥 Installation" and keep from there onward
TAIL=$(echo "$CURRENT" | awk '/^## 📥 Installation/{flag=1} flag')
printf "%s\n\n%s" "$(cat release_body.md)" "$TAIL" > final_body.md
gh release edit v{VERSION} --notes-file final_body.md
```

## Worked example — v1.3.9 (Flavor 2: external contributors present)

Given commits in the v1.3.8..v1.3.9 range:

```
feat: pinned timeline preview (closes #570)
feat(timeline): configurable jump shortcuts (closes #568)
fix(timeline): persist node hierarchy per account
fix(folder): nested folder moves (#547)
fix(firefox): permission request handling (#567)
chore: sponsor update          ← skip
style: prettier                 ← skip
```

Two of the five commits are external PRs (#547 chang-xinhai, #567 LinJHS), so this is a Flavor 2 release — keep the `By` column and use it for attribution. Produces:

```markdown
## ✨ What's New

| Feature                                  | Description                                                                  | By  |
| ---------------------------------------- | ---------------------------------------------------------------------------- | --- |
| **Pinned timeline preview**              | Keep the timeline preview panel pinned from the popup. (closes #570)         | —   |
| **Configurable timeline jump shortcuts** | Customize the shortcut keys used to jump through the timeline. (closes #568) | —   |

## 🐛 Bug Fixes

| Fix                             | Description                                                             | By                       |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| **Experimental node hierarchy** | Timeline node hierarchy state now persists separately for each account. | —                        |
| **Nested folder moves**         | Moving folders with child folders now works correctly.                  | PR #547 by @chang-xinhai |
| **Firefox permission flow**     | Fixed permission request handling for Firefox.                          | PR #567 by @LinJHS       |

---

## 中文版

## ✨ 新功能

| 功能                       | 说明                                              | 提交者 |
| -------------------------- | ------------------------------------------------- | ------ |
| **固定时间线预览**         | 可在弹窗中将时间线预览面板固定显示。（关联 #570） | —      |
| **时间线跳转快捷键可配置** | 可自定义在时间线中跳转使用的快捷键。（关联 #568） | —      |

## 🐛 修复

| 修复                 | 说明                                               | 提交者                   |
| -------------------- | -------------------------------------------------- | ------------------------ |
| **实验性节点层级**   | 时间线节点层级状态现在会按不同账号分别持久化保存。 | —                        |
| **嵌套文件夹移动**   | 现在可以正确移动带有子文件夹的文件夹。             | PR #547 by @chang-xinhai |
| **Firefox 权限流程** | 修复了 Firefox 中的权限请求处理问题。              | PR #567 by @LinJHS       |

---

## New Contributors

- @chang-xinhai made their first contribution in PR #547
- @LinJHS made their first contribution in PR #567

**Full Changelog**: https://github.com/Nagi-ovo/voyager/compare/v1.3.8...v1.3.9
```

## Worked example — v1.4.2 (Flavor 1: owner-only)

All commits attributable to @Nagi-ovo, so drop the `By` column entirely; `closes #NNN` moves into the description for the one row that needs it. The trailer line carries the universal attribution.

```markdown
## ✨ What's New

| Feature                                     | Description                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Floating folder mode** _(off by default)_ | Pop the folder panel out as a draggable floating window instead of injecting it into the sidebar. Toggle from popup → Folder options.                |
| **AI Studio new nav support**               | Folder panel now mounts on AI Studio's refreshed left nav (`/prompts` and `/library`), restoring the feature after Google's UI change. (closes #622) |
| … (rest of rows) …                          |

## 🐛 Bug Fixes

| Fix                                            | Description                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| **Vim mode line editing**                      | Stabilized cursor behavior at end-of-line during operations.                     |
| **Sidebar auto-hide / full-hide independence** | The two settings are now independent — toggling one no longer affects the other. |

_All changes by @Nagi-ovo unless noted._

---

## 中文版

## ✨ 新功能

| 功能                              | 说明                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| **悬浮文件夹模式** _（默认关闭）_ | 把文件夹面板拆成可拖动的悬浮窗，不再注入到侧边栏。弹窗 → 文件夹选项中开启。 |
| … (rest of rows) …                |

## 🐛 修复

| 修复                             | 说明                             |
| -------------------------------- | -------------------------------- |
| **Vim 模式行尾编辑**             | 行尾操作时光标行为更稳定。       |
| **侧边栏自动隐藏与完全隐藏独立** | 两项设置互相独立，不再相互干扰。 |

_除特别注明外，均由 @Nagi-ovo 提交。_

---

**Full Changelog**: https://github.com/Nagi-ovo/voyager/compare/v1.4.0...v1.4.2
```
