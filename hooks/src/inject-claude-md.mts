#!/usr/bin/env node
/**
 * SessionStart hook: inject vercel.md as additional context.
 * Outputs the contents of vercel.md to stdout so Claude Code adds it
 * to the conversation context at session start.
 */

import { join } from "node:path";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";

const content = safeReadFile(join(pluginRoot(), "vercel.md"));
if (content !== null) {
  process.stdout.write(content);
}
