#!/usr/bin/env node

// hooks/src/inject-claude-md.mts
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { formatOutput } from "./compat.mjs";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";
import { hasSessionStartActivationMarkers, isGreenfieldDirectory } from "./session-start-activation.mjs";
var GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;
function parseInjectClaudeMdInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectInjectClaudeMdPlatform(input, _env = process.env) {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }
  return "claude-code";
}
function buildInjectClaudeMdParts(content, env = process.env, knowledgeUpdate = null, greenfield = env.VERCEL_PLUGIN_GREENFIELD === "true") {
  const parts = [];
  if (content !== null) {
    parts.push(content);
  }
  if (knowledgeUpdate !== null) {
    parts.push(knowledgeUpdate);
  }
  if (greenfield) {
    parts.push(GREENFIELD_CONTEXT);
  }
  return parts;
}
function formatInjectClaudeMdOutput(platform, content) {
  if (platform === "cursor") {
    return JSON.stringify(formatOutput(platform, { additionalContext: content }));
  }
  return content;
}
function resolveInjectClaudeMdProjectRoot(env = process.env) {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}
function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
function main() {
  const input = parseInjectClaudeMdInput(readFileSync(0, "utf8"));
  const platform = detectInjectClaudeMdPlatform(input);
  const projectRoot = resolveInjectClaudeMdProjectRoot();
  const isGreenfield = isGreenfieldDirectory(projectRoot);
  const greenfieldOverride = process.env.VERCEL_PLUGIN_GREENFIELD === "true";
  const shouldActivate = isGreenfield || greenfieldOverride || !existsSync(projectRoot) || hasSessionStartActivationMarkers(projectRoot);
  if (!shouldActivate) {
    if (platform === "cursor") {
      process.stdout.write(JSON.stringify(formatOutput(platform, {})));
    }
    return;
  }
  const thinSessionContext = safeReadFile(join(pluginRoot(), "vercel-session.md"));
  const knowledgeUpdateRaw = safeReadFile(join(pluginRoot(), "skills", "knowledge-update", "SKILL.md"));
  const knowledgeUpdate = knowledgeUpdateRaw !== null ? stripFrontmatter(knowledgeUpdateRaw) : null;
  const parts = buildInjectClaudeMdParts(
    thinSessionContext,
    process.env,
    knowledgeUpdate,
    isGreenfield || greenfieldOverride
  );
  if (parts.length === 0) {
    return;
  }
  process.stdout.write(formatInjectClaudeMdOutput(platform, parts.join("\n\n")));
}
var INJECT_CLAUDE_MD_ENTRYPOINT = fileURLToPath(import.meta.url);
var isInjectClaudeMdEntrypoint = process.argv[1] ? resolve(process.argv[1]) === INJECT_CLAUDE_MD_ENTRYPOINT : false;
if (isInjectClaudeMdEntrypoint) {
  main();
}
export {
  buildInjectClaudeMdParts,
  detectInjectClaudeMdPlatform,
  formatInjectClaudeMdOutput,
  parseInjectClaudeMdInput
};
