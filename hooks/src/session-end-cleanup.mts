#!/usr/bin/env node
/**
 * SessionEnd hook: best-effort cleanup of session-scoped temp files.
 * Deletes main and all agent-scoped claim dirs plus session-scoped temp files.
 * Always exits successfully.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const sessionId = parseSessionIdFromStdin();
  if (sessionId === null) {
    process.exit(0);
  }
  const tempRoot = tmpdir();
  const prefix = `vercel-plugin-${tempSessionIdSegment(sessionId)}-`;

  // Glob all session-scoped temp entries (main + agent-scoped claim dirs, files)
  let entries: string[] = [];
  try {
    entries = readdirSync(tempRoot).filter((name) => name.startsWith(prefix));
  } catch {
    // Silently ignore readdir failures
  }

  for (const entry of entries) {
    const fullPath = join(tempRoot, entry);
    if (entry.endsWith(".d")) {
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
