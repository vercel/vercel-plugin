#!/usr/bin/env node
/**
 * SessionEnd hook: best-effort cleanup of session-scoped temp files.
 * Deletes main and all agent-scoped claim dirs, session files, and profile cache.
 * Always exits successfully.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeStaleExposures } from "./routing-policy-ledger.mjs";

type SessionEndHookInput = {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  [key: string]: unknown;
};

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function tempSessionIdSegment(sessionId: string): string {
  if (SAFE_SESSION_ID_RE.test(sessionId)) {
    return sessionId;
  }

  return createHash("sha256").update(sessionId).digest("hex");
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Silently ignore cleanup failures
  }
}

function removeDirIfPresent(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Silently ignore cleanup failures
  }
}

export function parseSessionEndHookInput(raw: string): SessionEndHookInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SessionEndHookInput;
  } catch {
    return null;
  }
}

export function normalizeSessionEndSessionId(input: SessionEndHookInput | null): string | null {
  if (!input) return null;

  const sessionId = input.session_id ?? input.conversation_id ?? "";

  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function parseSessionIdFromStdin(): string | null {
  return normalizeSessionEndSessionId(parseSessionEndHookInput(readFileSync(0, "utf8")));
}

function main(): void {
  // Convert "asked" telemetry preference to "disabled" (opt-out by default)
  try {
    const prefPath = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
    const pref = readFileSync(prefPath, "utf-8").trim();
    if (pref === "asked") {
      writeFileSync(prefPath, "disabled");
    }
  } catch {
    // File doesn't exist or can't be read — nothing to do
  }

  const sessionId = parseSessionIdFromStdin();
  if (sessionId === null) {
    process.exit(0);
  }
  const tempRoot = tmpdir();
  const prefix = `vercel-plugin-${tempSessionIdSegment(sessionId)}-`;

  // Finalize any pending routing policy exposures before deleting temp files
  try {
    finalizeStaleExposures(sessionId, new Date().toISOString());
  } catch {
    // Best-effort: don't block cleanup on policy finalization failure
  }

  // Glob all session-scoped temp entries (main + agent-scoped claim dirs, files, profile cache)
  let entries: string[] = [];
  try {
    entries = readdirSync(tempRoot).filter((name) => name.startsWith(prefix));
  } catch {
    // Silently ignore readdir failures
  }

  for (const entry of entries) {
    const fullPath = join(tempRoot, entry);
    if (entry.endsWith(".d") || entry.endsWith("-pending-launches")) {
      removeDirIfPresent(fullPath);
    } else {
      removeFileIfPresent(fullPath);
    }
  }

  process.exit(0);
}

const SESSION_END_CLEANUP_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionEndCleanupEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SESSION_END_CLEANUP_ENTRYPOINT
  : false;

if (isSessionEndCleanupEntrypoint) {
  main();
}
