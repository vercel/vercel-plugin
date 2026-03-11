#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
async function loadSessionHookCompat() {
  try {
    return await import("./compat.mjs");
  } catch {
    return {};
  }
}
const sessionHookCompat = await loadSessionHookCompat();
function parseSessionStartSeenSkillsInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectSessionStartSeenSkillsPlatform(input, env = process.env) {
  const compatDetectHookPlatform = sessionHookCompat.detectHookPlatform;
  if (typeof compatDetectHookPlatform === "function") {
    try {
      return compatDetectHookPlatform(input, env);
    } catch {
    }
  }
  return env.CLAUDE_ENV_FILE ? "claude" : "cursor";
}
function formatSessionStartSeenSkillsCursorOutput() {
  return JSON.stringify({
    env: {
      VERCEL_PLUGIN_SEEN_SKILLS: ""
    }
  });
}
function main() {
  const input = parseSessionStartSeenSkillsInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartSeenSkillsPlatform(input);
  if (platform === "cursor") {
    process.stdout.write(formatSessionStartSeenSkillsCursorOutput());
    return;
  }
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    process.exit(0);
  }
  try {
    appendFileSync(envFile, 'export VERCEL_PLUGIN_SEEN_SKILLS=""\n');
  } catch {
  }
}
const SESSION_START_SEEN_SKILLS_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartSeenSkillsEntrypoint = process.argv[1] ? resolve(process.argv[1]) === SESSION_START_SEEN_SKILLS_ENTRYPOINT : false;
if (isSessionStartSeenSkillsEntrypoint) {
  main();
}
export {
  detectSessionStartSeenSkillsPlatform,
  formatSessionStartSeenSkillsCursorOutput,
  parseSessionStartSeenSkillsInput
};
