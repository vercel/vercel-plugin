/**
 * Shared hook runtime utilities.
 *
 * Centralises plugin-root resolution, env-file access, and defensive
 * file / JSON reading so every hook doesn't re-implement the same
 * try/catch boilerplate.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Plugin root
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin root directory relative to an `import.meta.url`.
 * Defaults to `import.meta.url` of *this* module (i.e. hooks/src → hooks/..).
 *
 * Hooks compiled to `hooks/*.mjs` sit one level below the plugin root, so
 * the caller can simply call `pluginRoot()` without arguments.
 */
export function pluginRoot(metaUrl?: string): string {
  const base = metaUrl ?? import.meta.url;
  return resolve(dirname(fileURLToPath(base)), "..");
}

// ---------------------------------------------------------------------------
// CLAUDE_ENV_FILE helper
// ---------------------------------------------------------------------------

/**
 * Return the value of `CLAUDE_ENV_FILE` or call `process.exit(0)`.
 * Every SessionStart hook that needs to append to the env file can
 * replace its own guard clause with a single call.
 */
export function requireEnvFile(): string {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    process.exit(0);
  }
  return envFile;
}

// ---------------------------------------------------------------------------
// Audit log helpers
// ---------------------------------------------------------------------------

function resolveAuditLogPath(hookInputCwd?: string | null): string | null {
  const cwdFromHookInput = typeof hookInputCwd === "string" && hookInputCwd.trim() !== ""
    ? hookInputCwd
    : null;
  const projectRoot = process.env.CLAUDE_PROJECT_ROOT || cwdFromHookInput || process.cwd();
  const configuredPath = process.env.VERCEL_PLUGIN_AUDIT_LOG_FILE;

  if (configuredPath === "off") {
    return null;
  }

  if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
    return resolve(projectRoot, configuredPath);
  }

  const projectSlug = projectRoot.replaceAll("/", "-");
  return join(homedir(), ".claude", "projects", projectSlug, "vercel-plugin", "skill-injections.jsonl");
}

export function appendAuditLog(record: Record<string, unknown>, hookInputCwd?: string | null): void {
  const auditLogPath = resolveAuditLogPath(hookInputCwd);
  if (auditLogPath === null) return;

  try {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    const payload = { timestamp: new Date().toISOString(), ...record };
    appendFileSync(auditLogPath, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:append-audit-log-failed", error, { auditLogPath });
  }
}

// ---------------------------------------------------------------------------
// Session-scoped dedup persistence
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function dedupSessionIdSegment(sessionId: string): string {
  if (SAFE_SESSION_ID_RE.test(sessionId)) {
    return sessionId;
  }

  return createHash("sha256").update(sessionId).digest("hex");
}

function resolveDedupTempPath(sessionId: string, basename: string): string {
  const tempRoot = resolve(tmpdir());
  const candidate = resolve(join(tempRoot, `vercel-plugin-${dedupSessionIdSegment(sessionId)}-${basename}`));
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`;

  if (!candidate.startsWith(tempPrefix)) {
    throw new Error(`dedup temp path escaped tmpdir: tempRoot=${tempRoot} candidate=${candidate}`);
  }

  return candidate;
}

export function dedupFilePath(sessionId: string, kind: string): string {
  return resolveDedupTempPath(sessionId, `${kind}.txt`);
}

export function dedupClaimDirPath(sessionId: string, kind: string): string {
  return resolveDedupTempPath(sessionId, `${kind}.d`);
}

export function readSessionFile(sessionId: string, kind: string): string {
  try {
    return readFileSync(dedupFilePath(sessionId, kind), "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:read-session-file-failed", error, { sessionId, kind });
    return "";
  }
}

export function writeSessionFile(sessionId: string, kind: string, value: string): void {
  try {
    writeFileSync(dedupFilePath(sessionId, kind), value, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:write-session-file-failed", error, { sessionId, kind });
  }
}

export function tryClaimSessionKey(sessionId: string, kind: string, key: string): boolean {
  try {
    const claimDir = dedupClaimDirPath(sessionId, kind);
    mkdirSync(claimDir, { recursive: true });
    const file = join(claimDir, encodeURIComponent(key));
    const fd = openSync(file, "wx");
    closeSync(fd);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST"
    ) {
      return false;
    }
    return false;
  }
}

export function listSessionKeys(sessionId: string, kind: string): string[] {
  try {
    return readdirSync(dedupClaimDirPath(sessionId, kind))
      .map((entry) => decodeURIComponent(entry))
      .filter((entry) => entry !== "")
      .sort();
  } catch (error) {
    logCaughtError(log, "hook-env:list-session-keys-failed", error, { sessionId, kind });
    return [];
  }
}

export function syncSessionFileFromClaims(sessionId: string, kind: string): string {
  const value = listSessionKeys(sessionId, kind).join(",");
  writeSessionFile(sessionId, kind, value);
  return value;
}

export function removeSessionClaimDir(sessionId: string, kind: string): void {
  try {
    rmSync(dedupClaimDirPath(sessionId, kind), { recursive: true, force: true });
  } catch (error) {
    logCaughtError(log, "hook-env:remove-session-claim-dir-failed", error, { sessionId, kind });
  }
}

// ---------------------------------------------------------------------------
// Defensive file / JSON readers
// ---------------------------------------------------------------------------

/**
 * Read a file as UTF-8, returning `null` on any error (missing, permission, etc.).
 */
export function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:safe-read-file-failed", error, { path });
    return null;
  }
}

/**
 * Read and JSON.parse a file, returning `null` on any error.
 */
export function safeReadJson<T>(path: string): T | null {
  const content = safeReadFile(path);
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    logCaughtError(log, "hook-env:safe-read-json-failed", error, { path });
    return null;
  }
}
