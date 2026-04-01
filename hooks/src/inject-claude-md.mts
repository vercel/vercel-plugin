#!/usr/bin/env node
/**
 * SessionStart hook: inject a thin Vercel session context.
 * Claude Code receives plain-text stdout.
 * Cursor receives `{ additional_context: "..." }` JSON on stdout.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatOutput, type HookPlatform } from "./compat.mjs";
import { pluginRoot, safeReadFile } from "./hook-env.mjs";

interface InjectClaudeMdInput {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  [key: string]: unknown;
}

const GREENFIELD_CONTEXT = `<!-- vercel-plugin:greenfield-execution -->
## Greenfield execution mode

This directory is empty.
Do not stop in planning mode or spin up a read-only planning subagent.
Choose sensible defaults immediately.
Start executing with real tool calls.
Use non-interactive scaffolding commands (--yes) where available.
Only ask follow-up questions when blocked by missing credentials or irreversible decisions.`;

export function parseInjectClaudeMdInput(raw: string): InjectClaudeMdInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as InjectClaudeMdInput;
  } catch {
    return null;
  }
}

export function detectInjectClaudeMdPlatform(
  input: InjectClaudeMdInput | null,
  _env: NodeJS.ProcessEnv = process.env,
): HookPlatform {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }

  return "claude-code";
}

export function buildInjectClaudeMdParts(
  content: string | null,
  env: NodeJS.ProcessEnv = process.env,
  knowledgeUpdate: string | null = null,
): string[] {
  const parts: string[] = [];

  if (content !== null) {
    parts.push(content);
  }

  if (knowledgeUpdate !== null) {
    parts.push(knowledgeUpdate);
  }

  if (env.VERCEL_PLUGIN_GREENFIELD === "true") {
    parts.push(GREENFIELD_CONTEXT);
  }

  return parts;
}

export function formatInjectClaudeMdOutput(platform: HookPlatform, content: string): string {
  if (platform === "cursor") {
    return JSON.stringify(formatOutput(platform, { additionalContext: content }));
  }

  return content;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function main(): void {
  const input = parseInjectClaudeMdInput(readFileSync(0, "utf8"));
  const platform = detectInjectClaudeMdPlatform(input);
  const thinSessionContext = safeReadFile(join(pluginRoot(), "vercel-session.md"));
  const knowledgeUpdateRaw = safeReadFile(join(pluginRoot(), "skills", "knowledge-update", "SKILL.md"));
  const knowledgeUpdate = knowledgeUpdateRaw !== null ? stripFrontmatter(knowledgeUpdateRaw) : null;
  const parts = buildInjectClaudeMdParts(thinSessionContext, process.env, knowledgeUpdate);

  if (parts.length === 0) {
    return;
  }

  process.stdout.write(formatInjectClaudeMdOutput(platform, parts.join("\n\n")));
}

const INJECT_CLAUDE_MD_ENTRYPOINT = fileURLToPath(import.meta.url);
const isInjectClaudeMdEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === INJECT_CLAUDE_MD_ENTRYPOINT
  : false;

if (isInjectClaudeMdEntrypoint) {
  main();
}
