#!/usr/bin/env bash
set -euo pipefail

HOOK_ID="${1:-}"
REL_SCRIPT_PATH="${2:-}"
PROFILES_CSV="${3:-standard,strict}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

# Preserve stdin for passthrough or script execution
INPUT="$(cat)"

if [[ -z "$HOOK_ID" || -z "$REL_SCRIPT_PATH" ]]; then
  printf '%s' "$INPUT"
  exit 0
fi

# Ask Node helper if this hook is enabled
ENABLED="$(node "${PLUGIN_ROOT}/scripts/hooks/check-hook-enabled.js" "$HOOK_ID" "$PROFILES_CSV" 2>/dev/null || echo yes)"
if [[ "$ENABLED" != "yes" ]]; then
  printf '%s' "$INPUT"
  exit 0
fi

SCRIPT_PATH="${PLUGIN_ROOT}/${REL_SCRIPT_PATH}"
if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "[Hook] Script not found for ${HOOK_ID}: ${SCRIPT_PATH}" >&2
  printf '%s' "$INPUT"
  exit 0
fi

EXEC_SCRIPT_PATH="$SCRIPT_PATH"
TEMP_SCRIPT_PATH=""

# Normalize CRLF shell scripts at runtime to avoid WSL/Git Bash execution failures.
if grep -q $'\r' "$SCRIPT_PATH" 2>/dev/null; then
  SCRIPT_BASE_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  TEMP_SCRIPT_PATH="${SCRIPT_BASE_DIR}/.$(basename "$SCRIPT_PATH").ecc-tmp-${RANDOM}-${RANDOM}.sh"
  tr -d '\r' < "$SCRIPT_PATH" > "$TEMP_SCRIPT_PATH"
  chmod +x "$TEMP_SCRIPT_PATH" 2>/dev/null || true
  EXEC_SCRIPT_PATH="$TEMP_SCRIPT_PATH"
fi

# Extract phase prefix from hook ID (e.g., "pre:observe" -> "pre", "post:observe" -> "post")
# This is needed by scripts like observe.sh that behave differently for PreToolUse vs PostToolUse
HOOK_PHASE="${HOOK_ID%%:*}"
IS_OBSERVE_HOOK="false"
if [[ "$HOOK_ID" == "pre:observe" || "$HOOK_ID" == "post:observe" ]]; then
  IS_OBSERVE_HOOK="true"
fi

SCRIPT_OUTPUT=""
STDERR_CAPTURE_FILE="$(mktemp "${TMPDIR:-/tmp}/ecc-hook-stderr.XXXXXX.log")"
if SCRIPT_OUTPUT="$(printf '%s' "$INPUT" | bash "$EXEC_SCRIPT_PATH" "$HOOK_PHASE" 2>"$STDERR_CAPTURE_FILE")"; then
  if [[ -s "$STDERR_CAPTURE_FILE" ]]; then
    cat "$STDERR_CAPTURE_FILE" >&2
  fi
  printf '%s' "$SCRIPT_OUTPUT"
else
  if [[ -s "$STDERR_CAPTURE_FILE" ]]; then
    cat "$STDERR_CAPTURE_FILE" >&2
  fi
  if [[ "$IS_OBSERVE_HOOK" == "true" ]]; then
    echo "[Hook][observe] Script failed for ${HOOK_ID}; continuing with passthrough" >&2
  else
    echo "[Hook] Script failed for ${HOOK_ID}; continuing with passthrough" >&2
  fi
  printf '%s' "$INPUT"
fi

rm -f "$STDERR_CAPTURE_FILE" 2>/dev/null || true

if [[ -n "$TEMP_SCRIPT_PATH" ]]; then
  rm -f "$TEMP_SCRIPT_PATH" 2>/dev/null || true
fi

exit 0
