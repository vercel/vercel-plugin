#!/usr/bin/env node
/**
 * SessionStart hook: initialize the seen-skills dedup state.
 *
 * On "clear" or "compact" events (Claude Code), wipes the claim dir and session
 * file so previously-injected skills can be re-injected into the fresh context.
 *
 * On "startup" or "resume", this is a no-op for Claude Code (claim dir starts
 * empty or retains valid state).
 *
 * Cursor always returns `{ env: { VERCEL_PLUGIN_SEEN_SKILLS: "" } }` on stdout.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatOutput,
  setSessionEnv,
  type HookPlatform,
} from "./compat.mjs";
import {
  removeAllSessionDedupArtifacts,
  type RemoveArtifactsResult,
} from "./hook-env.mjs";
import { createLogger } from "./logger.mjs";

interface SessionStartSeenSkillsInput {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

/** Events where previously-injected skills are no longer in the context window. */
const CONTEXT_CLEARING_EVENTS = new Set(["clear", "compact"]);

export function parseSessionStartSeenSkillsInput(raw: string): SessionStartSeenSkillsInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SessionStartSeenSkillsInput;
  } catch {
    return null;
  }
}

export function detectSessionStartSeenSkillsPlatform(
  input: SessionStartSeenSkillsInput | null,
  env: NodeJS.ProcessEnv = process.env,
): HookPlatform {
  if (env.ANTIGRAVITY_AGENT === "1") {
    return "antigravity";
  }

  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }

  return "claude-code";
}

export function formatSessionStartSeenSkillsCursorOutput(): string {
  return JSON.stringify(formatOutput("cursor", {
    env: {
      VERCEL_PLUGIN_SEEN_SKILLS: "",
    },
  }));
}

/**
 * On context-clearing events, wipe the file-based dedup state so skills can be
 * re-injected. Removes both the main (unscoped) claim dir / session file AND
 * any agent-scoped variants (e.g. subagent claim dirs) using a prefix-glob
 * approach, mirroring session-end-cleanup.
 */
export function resetDedupStateForSession(sessionId: string): RemoveArtifactsResult {
  return removeAllSessionDedupArtifacts(sessionId);
}

function main(): void {
  const log = createLogger();
  const input = parseSessionStartSeenSkillsInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartSeenSkillsPlatform(input);

  if (platform === "cursor") {
    process.stdout.write(formatSessionStartSeenSkillsCursorOutput());
    return;
  }

  // Claude Code: reset dedup state on clear/compact so skills get re-injected.
  const hookEvent = input?.hook_event_name ?? "";
  const sessionId = input?.session_id ?? "";
  const resetTriggered = CONTEXT_CLEARING_EVENTS.has(hookEvent) && !!sessionId;

  let removedFiles = 0;
  let removedDirs = 0;

  if (resetTriggered) {
    const result = resetDedupStateForSession(sessionId);
    removedFiles = result.removedFiles;
    removedDirs = result.removedDirs;
  }

  log.debug("session-start-seen-skills:decision", {
    event: hookEvent || "unknown",
    sessionId: sessionId || "none",
    resetTriggered,
    removedFiles,
    removedDirs,
  });

  if (platform === "antigravity") {
    // Ensure the env var is initialized in the persistence file
    setSessionEnv(platform, "VERCEL_PLUGIN_SEEN_SKILLS", process.env.VERCEL_PLUGIN_SEEN_SKILLS ?? "");
  }
}

const SESSION_START_SEEN_SKILLS_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartSeenSkillsEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SESSION_START_SEEN_SKILLS_ENTRYPOINT
  : false;

if (isSessionStartSeenSkillsEntrypoint) {
  main();
}
