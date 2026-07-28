---
name: release
description: Cut or recover a Voyager release, including issue triage, verification, versioning, the 10-locale in-product changelog, commit and tag creation, GitHub Actions monitoring, Chrome Web Store, Firefox AMO, Edge Add-ons, and the signed/notarized Safari DMG with Sparkle updates. Use for “发版”, “release”, “bump”, “ship vX.Y.Z”, store retries, or Safari release failures.
metadata:
  version: '1.4.1'
---

# Voyager Release Workflow

Treat the repository scripts and `.github/workflows/release.yml` as the source of truth. The normal release path is CI-first: pushing the release tag builds every browser artifact, signs and notarizes Safari, creates the GitHub Release, and submits the stores.

Copy this checklist into the response and update it while working:

```text
Release Progress:
- [ ] Step 1: Scope, issue triage, branch/worktree, secret-name preflight
- [ ] Step 2: lint, typecheck, tests, production builds
- [ ] Step 3: version bump and 10-locale changelog
- [ ] Step 4: release commit and local tag
- [ ] Step 5: confirmed tag push
- [ ] Step 6: monitor the complete CI release pipeline
- [ ] Step 7: curated GitHub release body
- [ ] Step 8: assets, Sparkle, and store verification
```

## Step 1 — Establish the release scope

### Branch and worktree

- Release from `main` unless the user explicitly chooses another branch.
- Inspect `git status`. Preserve unrelated changes and never use `git add -A`.
- Release files left from an interrupted attempt are acceptable only after verifying their target version and contents.

### Commit range

Derive the scope from the last released tag, not from unpushed commits:

```bash
PREV_TAG=$(git describe --tags --abbrev=0)
git log "${PREV_TAG}..HEAD" --format='%h %s' --no-merges
git rev-list --count "${PREV_TAG}..HEAD"
```

Use this same range for both the in-product changelog and GitHub release body.

### Open issues

Read the current open issues and briefly classify recent bugs, `important` issues, and maintainer promises as blocking or non-blocking:

```bash
gh issue list --state open --limit 100 \
  --json number,title,labels,createdAt,updatedAt,author
```

Show the user the possible blockers before changing the version.

### Secret-name preflight

Checking secret names does not expose their values:

```bash
gh secret list -R Nagi-ovo/voyager --json name --jq '.[].name'
```

Confirm the workflow has names for:

- Safari: `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_APP_PROVISIONING_PROFILE_BASE64`, `APPLE_EXTENSION_PROVISIONING_PROFILE_BASE64`, `SPARKLE_PRIVATE_KEY`
- Firefox: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`
- Chrome: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`
- Edge: `EDGE_CLIENT_ID`, `EDGE_PRODUCT_ID`, `EDGE_API_KEY`

Missing Safari release secrets are blocking: the GitHub Release job now waits for the Safari artifact job.

## Step 2 — Verify before bumping

Run lint first because it can modify files. Inspect its diff. Then run the independent checks concurrently:

```bash
bun run lint

bun run typecheck
bun run test
bun run build:all
```

Use `bun run test`, not raw `bun test`. `build:all` writes production outputs to `dist_chrome`, `dist_firefox`, and `dist_safari`; `dist_chrome_dev` is only for routine local Chrome development.

Stop if any required check fails unless the user explicitly accepts the risk.

## Step 3 — Version and changelog

### Version bump

Read the four current version sources first. If they already match the intended release version after an interrupted attempt, do not bump again; continue with verification and the changelog.

For the next patch version:

```bash
bun run bump
```

For an explicit version:

```bash
bun run bump {VERSION}
```

`scripts/bump-version.js` now updates all four tracked version sources together:

- `package.json`
- `manifest.json`
- `manifest.dev.json`
- `Voyager/Voyager.xcodeproj/project.pbxproj`

Do not manually edit the Xcode project version during a normal release. Verify all values after the bump:

```bash
grep -E '"version"' package.json manifest.json manifest.dev.json
grep -E 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' \
  Voyager/Voyager.xcodeproj/project.pbxproj | sort -u
```

### In-product changelog

Create `src/pages/content/changelog/notes/{VERSION}.md`. Read `references/changelog.md` before authoring it.

Before writing, cover every commit in `PREV_TAG..HEAD` with subagents, one commit or a small group per agent. Each agent must report:

- the actual user-facing effect,
- whether the implementation matches the commit message,
- whether it belongs in the changelog.

This is a coverage gate, not optional parallelism. Write `zh` first, derive `en`, then translate the other eight locales while preserving the required on-disk locale order.

## Step 4 — Commit and tag locally

Stage only the release files:

```bash
git add \
  package.json manifest.json manifest.dev.json \
  Voyager/Voyager.xcodeproj/project.pbxproj \
  src/pages/content/changelog/notes/{VERSION}.md
git diff --cached --name-only
git diff --cached --check
git commit -m "chore(release): v{VERSION}"
git tag "v{VERSION}"
```

If this release intentionally includes announcements or other release-only files, add them explicitly and re-check the staged list. Never absorb unrelated worktree changes.

## Step 5 — Confirm and push

The tag push is an external, user-visible action. Confirm immediately before it:

> About to push `v{VERSION}`. This triggers the public GitHub Release, Safari signing/notarization and Sparkle feed, Firefox AMO submission, Chrome Web Store publication, and Edge Add-ons submission. OK to push?

After confirmation:

```bash
git push origin main
git push origin "v{VERSION}"
```

Do not use the workflow's auto-increment `workflow_dispatch` path for a normal curated release: it can bump and tag, but it cannot author the required in-product changelog. Reserve it for an already-prepared version or an explicit recovery decision.

## Step 6 — Monitor CI

The tag workflow runs these gates:

1. `build-safari-release` builds `dist_safari`, imports the Developer ID certificate and provisioning profiles, then calls `scripts/build-safari-release.sh`.
2. That script archives the `Voyager` scheme, exports `Voyager.app`, verifies a universal binary, notarizes and staples the app and DMG, includes the Safari-upgrade README, generates signed `appcast.xml`, and scans artifacts for private data.
3. `build-and-release` waits for Safari, builds the other browser artifacts, signs/submits Firefox, creates the GitHub Release, then submits Chrome and Edge.

Monitor with:

```bash
gh run list --workflow release.yml --limit 3
gh run view {RUN_ID} --log-failed
```

Do not run a second local Safari release in parallel with CI. Read `references/safari-dmg.md` only when diagnosing the Safari job or deliberately producing a local recovery artifact.

Important failure semantics:

- Safari build/sign/notarization failure prevents the GitHub Release job from starting.
- A later Chrome or Edge store failure does not undo an already-created GitHub Release or AMO submission.
- Firefox signing can remain quiet for several minutes; wait for an actual error before treating it as stuck.

## Step 7 — Curate the GitHub release body

Read `references/release-body.md`. Replace the generated top section with concise English and Chinese feature/fix tables while preserving the workflow-generated `## 📥 Installation` tail.

```bash
CURRENT=$(gh release view "v{VERSION}" --json body --jq '.body')
TAIL=$(printf '%s\n' "$CURRENT" | awk '/^## 📥 Installation/{flag=1} flag')
printf '%s\n\n%s\n' "$(cat release_body.md)" "$TAIL" > final_body.md
gh release edit "v{VERSION}" --notes-file final_body.md
```

Verify the rendered body and ensure its Safari capability text still matches the current product.

## Step 8 — Final verification and recovery

Confirm the release contains:

- `voyager-chrome-v{VERSION}.zip`
- `voyager-firefox-v{VERSION}.xpi`
- `voyager-v{VERSION}.dmg`
- `appcast.xml`

```bash
gh release view "v{VERSION}" --json assets --jq '.assets[].name'
```

Also confirm:

- the Safari job reported notarization and privacy verification success,
- `appcast.xml` contains `sparkle:edSignature`,
- Chrome and Edge workflow steps reached upload/submission success,
- AMO signing/submission completed.

If only a store submission failed, do not cut another version:

- Chrome: run `release.yml` with `version={VERSION}`, `publish_only=true`.
- Edge: run `release.yml` with `version={VERSION}`, `publish_edge_only=true`.

For an urgent Firefox-only code hotfix, keep the shared three-part product
version unchanged and run `release.yml` from `main` with a four-part version
(for example `version=1.6.0.1`) and `publish_firefox_only=true`. This path builds
only `dist_firefox`, injects the override into its manifest, runs the privacy
scan, signs/submits to AMO, retains the signed XPI as a workflow artifact, and
replaces the Firefox XPI on the matching three-part GitHub Release. The release
asset keeps its existing three-part filename so direct-download links remain
stable, while the signed manifest contains the four-part hotfix version. It
creates no shared release tag and does not touch Chrome, Edge, or Safari. The
next normal three-part release sorts above it (`1.6.1 > 1.6.0.1`).

## Do not

- Do not push a release tag from an unintended feature branch.
- Do not use `git add -A` in a dirty worktree.
- Do not publish without the 10-locale changelog file.
- Do not bypass hooks with `--no-verify`.
- Do not change the shipped Safari bundle IDs.
- Do not manually upload a second Safari DMG while the automated release is running.
- Do not claim Safari or a store is released until the corresponding CI evidence exists.
