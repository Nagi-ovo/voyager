#!/bin/bash
# PostToolUse hook: run oxlint on the edited .ts/.tsx file, surface failures.

input=$(cat)
file_path=$(printf '%s' "$input" \
  | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed -E 's/.*"file_path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')

case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

if ! command -v bunx >/dev/null 2>&1; then
  exit 0
fi

output=$(bunx oxlint "$file_path" 2>&1)
status=$?
if [ $status -ne 0 ]; then
  printf '%s\n' "$output" | tail -30 >&2
fi
exit 0
