#!/usr/bin/env node
/**
 * SessionStart hook: initialize the seen-skills dedup env var.
 * Appends `export VERCEL_PLUGIN_SEEN_SKILLS=""` to CLAUDE_ENV_FILE
 * so the PreToolUse hook can track which skills have already been injected.
 */

import { appendFileSync } from "node:fs";
import { requireEnvFile } from "./hook-env.mjs";

const envFile = requireEnvFile();

try {
  appendFileSync(envFile, 'export VERCEL_PLUGIN_SEEN_SKILLS=""\n');
} catch {
  // Silently ignore — non-critical
}
