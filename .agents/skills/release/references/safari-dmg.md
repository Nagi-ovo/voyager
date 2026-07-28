# Safari Release CI and Recovery Reference

Use this reference when the `build-safari-release` GitHub Actions job fails or when the user explicitly requests a local Safari release artifact. Normal releases use CI; do not duplicate this flow locally after pushing a tag.

## Contents

- Sources of truth
- Compatibility invariants
- Required secrets
- Automated pipeline
- Safe local checks
- Full local recovery build
- Failure triage

## Sources of truth

Read these before changing the release procedure:

- `.github/workflows/release.yml` — orchestration, secrets, provisioning-profile installation, artifact handoff
- `scripts/build-safari-release.sh` — archive, export, signing, notarization, DMG, Sparkle, privacy checks
- `scripts/generate-sparkle-appcast.sh` — Sparkle key validation and signed feed generation
- `scripts/verify-release-privacy.mjs` — artifact privacy gate
- `Voyager/Voyager.xcodeproj/project.pbxproj` — scheme inputs, bundle IDs, entitlements, version

Do not copy the shell pipeline into the Skill. Invoke the tracked script so CI and local recovery cannot drift.

## Compatibility invariants

- Project: `Voyager/Voyager.xcodeproj`
- Scheme: `Voyager`
- Exported app: `Voyager.app`
- Embedded extension: `Voyager Extension.appex`
- App bundle ID: `com.yourCompany.Gemini-Voyager`
- Extension bundle ID: `com.yourCompany.Gemini-Voyager.Extension`
- iCloud container: `iCloud.com.yourCompany.Gemini-Voyager`
- Team: `PJM828YBFJ`
- Output DMG: `voyager-v{VERSION}.dmg`
- Sparkle feed: `appcast.xml`

The old-looking bundle IDs are intentional compatibility IDs. Never rename them: existing Safari installs, permissions, native messaging, CloudKit data, and Sparkle updates depend on them.

The app and file names are now `Voyager`, not `Gemini Voyager`. The DMG includes `READ ME — Safari Upgrade.html` to guide users who still have the old app filename in `/Applications`.

## Required secrets

The CI job checks these before building:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_APP_PROVISIONING_PROFILE_BASE64`
- `APPLE_EXTENSION_PROVISIONING_PROFILE_BASE64`
- `SPARKLE_PRIVATE_KEY`

Only check secret names with `gh secret list`; never print, download, or commit their values.

The extension provisioning profile must permit CloudKit and the existing iCloud container. The workflow validates both before installing the profile.

## Automated pipeline

On a release tag, `build-safari-release`:

1. Checks out the exact tag.
2. Installs Bun dependencies and builds `dist_safari`.
3. Imports the Developer ID certificate.
4. Decodes both provisioning profiles and records their profile names.
5. Calls:

   ```bash
   scripts/build-safari-release.sh "v{VERSION}" "$RUNNER_TEMP/safari-release"
   ```

6. Uploads the DMG and `appcast.xml` as a workflow artifact.

The script then:

1. Archives the `Voyager` scheme for `generic/platform=macOS` with manual Developer ID signing.
2. Exports `Voyager.app` using the app and extension provisioning profiles.
3. Verifies code signing and requires both `arm64` and `x86_64`.
4. Notarizes a zip containing the app, then staples and validates the app.
5. Builds a branded DMG with `Voyager.app`, an `/Applications` drop target, the
   migration README, and `scripts/assets/safari-dmg-background.png`. The fixed
   Finder layout is produced by pinned `dmgbuild`, which writes `.DS_Store`
   directly instead of relying on Finder automation. CI installs it into the
   explicit Python version prepared by `actions/setup-python`.
6. Notarizes, staples, and validates the DMG.
7. Generates signed `appcast.xml` from the final DMG.
8. Runs the privacy scanner over the app, DMG, and appcast.

`build-and-release` will not start unless this job succeeds.

## Safe local checks

These checks do not publish anything:

```bash
bun run build:safari
bash -n scripts/build-safari-release.sh
bash -n scripts/generate-sparkle-appcast.sh
node scripts/verify-safari-resources.mjs
```

Compile the native project without producing a release artifact:

```bash
xcodebuild \
  -project Voyager/Voyager.xcodeproj \
  -scheme Voyager \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath .build/safari-native-test-derived \
  -clonedSourcePackagesDirPath .build/sparkle-source-packages \
  build
```

This proves compilation, not Developer ID export, notarization, Sparkle signing, installation, or live Safari behavior.

## Full local recovery build

Only use this when CI cannot be recovered or the user explicitly requests a local artifact. It requires:

- a Developer ID Application identity,
- installed app and extension provisioning profiles,
- a notarytool keychain profile or Apple ID app-specific password,
- the Sparkle private key in Keychain or `SPARKLE_PRIVATE_KEY`.

Prefer a keychain profile so credentials never enter shell history:

```bash
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
OUT="/tmp/voyager-safari-${VERSION}"

VOYAGER_APP_PROFILE_NAME="{APP_PROFILE_NAME}" \
VOYAGER_EXTENSION_PROFILE_NAME="{EXTENSION_PROFILE_NAME}" \
NOTARY_KEYCHAIN_PROFILE="voyager-notary" \
scripts/build-safari-release.sh "$TAG" "$OUT"
```

The script generates:

```text
/tmp/voyager-safari-{VERSION}/voyager-v{VERSION}.dmg
/tmp/voyager-safari-{VERSION}/appcast.xml
```

Before uploading, inspect the exact artifact set and confirm the GitHub Release tag exists. Upload only after explicit user confirmation:

```bash
node scripts/verify-release-privacy.mjs \
  "$OUT/voyager-v${VERSION}.dmg" "$OUT/appcast.xml"
gh release upload "$TAG" \
  "$OUT/voyager-v${VERSION}.dmg" "$OUT/appcast.xml" --clobber
```

## Failure triage

| Failure                        | Check first                                                  | Correct response                                                                         |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Missing Safari secret          | `Check required Safari release secrets` log                  | Add/rotate the named repository secret, then rerun the failed workflow.                  |
| Certificate import fails       | P12 secret and password; certificate expiry                  | Replace the P12/password secrets. Do not alter bundle IDs.                               |
| Provisioning profile fails     | Profile UUID, app ID, CloudKit entitlement, iCloud container | Regenerate the matching Developer ID profiles and replace the base64 secrets.            |
| Archive cannot find scheme/app | Project path and `Voyager` scheme                            | Fix stale instructions or project wiring; do not fall back to `Gemini Voyager`.          |
| Export signing fails           | Profile names, Developer ID identity, team ID                | Fix signing inputs; do not switch to ad-hoc signing.                                     |
| Binary is not universal        | `lipo -archs Voyager.app/Contents/MacOS/Voyager`             | Fix archive architecture settings before releasing.                                      |
| Notarization rejected          | `notarytool` result JSON/log                                 | Fix the reported signing/bundle problem and rebuild; never upload an unnotarized DMG.    |
| Sparkle key mismatch           | `SPARKLE_PRIVATE_KEY` vs `SUPublicEDKey`                     | Restore the matching existing private key. Never rotate the public key casually.         |
| Privacy check fails            | Exact path or secret pattern in the log                      | Remove the leak at its source and rebuild every affected artifact.                       |
| DMG/appcast missing downstream | Safari artifact upload/download steps                        | Rerun the failed job; do not create a GitHub Release without the expected Safari assets. |

After recovery, verify the workflow log shows successful notarization/stapling, `appcast.xml` has `sparkle:edSignature`, and the GitHub Release contains both Safari assets.
