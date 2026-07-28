---
name: voyager-contribute
description: Prepare and publish Voyager contributions through the Issue, topic branch, verification, commit, and pull request workflow. Use when claiming or implementing Voyager work, preparing browser evidence, committing or pushing local changes, opening or updating a Voyager PR, or checking whether a contribution is ready for review.
---

# Voyager Contribution

Route issue investigation to the `issue-review` skill, Safari loading or native verification to `update-safari-extension`, and releases to `release`. Return here to finish the contribution.

## 1. Preflight

1. Inspect `git status --short --branch`, the current branch, and the diff. Preserve unrelated work.
2. Read the linked Issue and its comments when one exists. A new feature needs explicit maintainer approval of the approach, either in the Issue or as a direct instruction in the current task; assignment or `/claim` only selects an owner.
3. Read related entries in `.github/docs/REGRESSION_NOTES.md` before a non-trivial feature or fix.
4. Work on one focused topic branch targeting `main`. Keep secrets and generated `dist_*` artifacts out of commits.
5. Read [repo-traps.md](references/repo-traps.md) — the repository-specific pitfalls that have cost past contributors the most review rounds.
6. Use `gh` as the source of truth for Issue/PR state. Before any GitHub write, confirm `gh auth status` shows the account you intend to contribute as.

Preflight is complete when the Issue or rationale, approval state, intended scope, current branch, and clean ownership of every changed file are known.

## 2. Verify

1. Add or update regression tests for behavior changes. If no useful automated test exists, record the reason.
2. Run formatting and linting before the non-mutating PR suite, then inspect any resulting edits:

   ```bash
   bun run format
   bun run lint
   bun run verify:pr
   git diff --check
   git status --short
   ```

   `verify:pr` covers local automation and production browser builds; it does not prove that an extension loaded or that live behavior works.

3. For runtime, UI, manifest, permission, packaging, native, or plugin changes, read [browser-testing.md](references/browser-testing.md) and collect the required live evidence.
4. Record every omitted command or browser check with its reason. For required coverage that another person must complete, name the browser and owner and leave the item pending.

Verification is complete when every applicable automated check and browser check has a truthful result, the working tree matches the snapshot being tested, and remaining work is explicitly assigned.

## 3. Commit and publish

1. Review the final diff and stage only intended paths.
2. Create a Conventional Commit with a lowercase scope and a header no longer than 100 characters. Add `Fixes #<issue>` or `Closes #<issue>` when appropriate. Retain the active agent's project-standard co-author footer; Codex-authored commits use:

   ```text
   Co-authored-by: Codex <codex@users.noreply.github.com>
   ```

3. Inspect the commit with `git show --stat --format=fuller HEAD` and `git status --short`. Require no staged or unstaged changes in the contribution's paths; preserve and disclose unrelated pre-existing work. `HEAD` is the tested commit only while the verified paths match it, and any later change invalidates affected evidence.
4. When publishing is authorized, push only the topic branch and open or update a draft PR targeting `main`. Contributors never push directly to `main`; use force-push only with explicit user approval — this repository squash-merges, so a merged branch will later look unmerged (see repo-traps.md) and must be deleted, not re-pushed.
5. In the PR, state the linked Issue or direct authorization/rationale, scope, tested commit, commands run, live browser evidence, screenshots for UI changes, and all pending checks. Re-run affected checks after review changes.
6. Verify the PR author, base branch, commit set, changed files, and CI state with `gh` before handoff.

Publishing is complete when the focused diff is on a topic branch, the draft PR accurately reports its evidence and gaps, and the user receives the PR URL plus pending review or CI work.

After an Issue fix lands, leave a short comment in the reporter's language: the fix has landed, it will be available in the next version, and the Issue may be reopened if the problem remains.
