#!/bin/bash
# PreToolUse hook on `git push`: format the files changed in the outgoing
# commits, and block the push (exit 2) if oxfmt had to rewrite anything,
# so formatting lands in a commit before it reaches CI. Deliberately scoped
# to outgoing files only — uncommitted work-in-progress is never touched.

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v bunx >/dev/null 2>&1 || exit 0

# Outgoing = committed locally but not on the upstream branch. No upstream
# (new branch) or nothing outgoing -> let the push through untouched.
files=$(git diff --name-only @{u}..HEAD 2>/dev/null) || exit 0
[ -n "$files" ] || exit 0

targets=()
before=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    dist_*|node_modules/*) continue ;;
  esac
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md|*.html|*.yml|*.yaml) ;;
    *) continue ;;
  esac
  targets+=("$f")
  before+=("$(git hash-object "$f")")
done <<< "$files"

[ "${#targets[@]}" -gt 0 ] || exit 0

# oxfmt reads .oxfmtrc.jsonc, so the paths it ignores are skipped here too. A
# set that is entirely ignored leaves it with no target file, which it treats
# as an error unless --no-error-on-unmatched-pattern says otherwise.
bunx oxfmt --no-error-on-unmatched-pattern "${targets[@]}" >/dev/null 2>&1

changed=0
for i in "${!targets[@]}"; do
  if [ "${before[$i]}" != "$(git hash-object "${targets[$i]}")" ]; then
    changed=1
    echo "reformatted: ${targets[$i]}" >&2
  fi
done

if [ "$changed" -eq 1 ]; then
  echo "oxfmt reformatted outgoing files (listed above). Commit the formatting changes, then push again." >&2
  exit 2
fi
exit 0
