#!/usr/bin/env bash

exec >/dev/null 2>&1

if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  exit 0
fi

# Initialize empty seen-skills list in the session environment.
# The PreToolUse hook reads VERCEL_PLUGIN_SEEN_SKILLS as a comma-delimited
# string and appends new skill names after injection.
echo 'export VERCEL_PLUGIN_SEEN_SKILLS=""' >> "$CLAUDE_ENV_FILE" 2>/dev/null || true

exit 0
