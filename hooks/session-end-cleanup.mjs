#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function removeFileIfPresent(path) {
  try {
    unlinkSync(path);
  } catch {
  }
}
function parseSessionIdFromStdin() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return typeof data.session_id === "string" && data.session_id.length > 0 ? data.session_id : null;
  } catch {
    return null;
  }
}
const sessionId = parseSessionIdFromStdin();
if (sessionId !== null) {
  const tempRoot = tmpdir();
  removeFileIfPresent(join(tempRoot, `vercel-plugin-${sessionId}-seen-skills.txt`));
  removeFileIfPresent(join(tempRoot, `vercel-plugin-${sessionId}-validated-files.txt`));
}
process.exit(0);
