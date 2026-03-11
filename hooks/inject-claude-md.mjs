#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";
const GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;
async function loadSessionHookCompat() {
  try {
    return await import("./compat.mjs");
  } catch {
    return {};
  }
}
const sessionHookCompat = await loadSessionHookCompat();
function parseInjectClaudeMdInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectInjectClaudeMdPlatform(input, env = process.env) {
  const compatDetectHookPlatform = sessionHookCompat.detectHookPlatform;
  if (typeof compatDetectHookPlatform === "function") {
    try {
      return compatDetectHookPlatform(input, env);
    } catch {
    }
  }
  if (env.CURSOR_PROJECT_DIR) {
    return "cursor";
  }
  if (typeof input?.conversation_id === "string" && input.conversation_id.trim() !== "") {
    return "cursor";
  }
  if (typeof input?.cursor_version === "string" && input.cursor_version.trim() !== "") {
    return "cursor";
  }
  return "claude";
}
function buildInjectClaudeMdParts(content, env = process.env) {
  const parts = [];
  if (content !== null) {
    parts.push(content);
  }
  if (env.VERCEL_PLUGIN_GREENFIELD === "true") {
    parts.push(GREENFIELD_CONTEXT);
  }
  return parts;
}
function formatInjectClaudeMdOutput(platform, content) {
  if (platform === "cursor") {
    return JSON.stringify({ additional_context: content });
  }
  return content;
}
function main() {
  const input = parseInjectClaudeMdInput(readFileSync(0, "utf8"));
  const platform = detectInjectClaudeMdPlatform(input);
  const parts = buildInjectClaudeMdParts(safeReadFile(join(pluginRoot(), "vercel.md")));
  if (parts.length === 0) {
    return;
  }
  process.stdout.write(formatInjectClaudeMdOutput(platform, parts.join("\n\n")));
}
const INJECT_CLAUDE_MD_ENTRYPOINT = fileURLToPath(import.meta.url);
const isInjectClaudeMdEntrypoint = process.argv[1] ? resolve(process.argv[1]) === INJECT_CLAUDE_MD_ENTRYPOINT : false;
if (isInjectClaudeMdEntrypoint) {
  main();
}
export {
  buildInjectClaudeMdParts,
  detectInjectClaudeMdPlatform,
  formatInjectClaudeMdOutput,
  parseInjectClaudeMdInput
};
