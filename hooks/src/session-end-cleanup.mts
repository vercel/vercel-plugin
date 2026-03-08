#!/usr/bin/env node
/**
 * SessionEnd hook: best-effort cleanup of session-scoped temp files.
 * Always exits successfully.
 */

import { readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SessionEndHookInput = {
  session_id?: string;
};

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Silently ignore cleanup failures
  }
}

function parseSessionIdFromStdin(): string | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;

    const data = JSON.parse(raw) as SessionEndHookInput;
    return typeof data.session_id === "string" && data.session_id.length > 0
      ? data.session_id
      : null;
  } catch {
    return null;
  }
}

const sessionId = parseSessionIdFromStdin();
if (sessionId !== null) {
  const tempRoot = tmpdir();
  removeFileIfPresent(join(tempRoot, `vercel-plugin-${sessionId}-seen-skills.txt`));
  removeFileIfPresent(join(tempRoot, `vercel-plugin-${sessionId}-validated-files.txt`));

  try {
    rmSync(join(tempRoot, `vercel-plugin-${sessionId}-seen-skills.d`), {
      recursive: true,
      force: true,
    });
  } catch {
    // Silently ignore cleanup failures
  }

  try {
    rmSync(join(tempRoot, `vercel-plugin-${sessionId}-validated-files.d`), {
      recursive: true,
      force: true,
    });
  } catch {
    // Silently ignore cleanup failures
  }
}

process.exit(0);
