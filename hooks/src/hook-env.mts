/**
 * Shared hook runtime utilities.
 *
 * Centralises plugin-root resolution, env-file access, and defensive
 * file / JSON reading so every hook doesn't re-implement the same
 * try/catch boilerplate.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  } catch {
    // Logging is best-effort and must not break hooks.
  }
}

// ---------------------------------------------------------------------------
// Session-scoped dedup persistence
// ---------------------------------------------------------------------------

export function dedupFilePath(sessionId: string, kind: string): string {
  return join(tmpdir(), `vercel-plugin-${sessionId}-${kind}.txt`);
}

export function readSessionFile(sessionId: string, kind: string): string {
  try {
    return readFileSync(dedupFilePath(sessionId, kind), "utf-8");
  } catch {
    return "";
  }
}

export function writeSessionFile(sessionId: string, kind: string, value: string): void {
  try {
    writeFileSync(dedupFilePath(sessionId, kind), value, "utf-8");
  } catch {
    // Persistence is best-effort and must not break hooks.
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
  } catch {
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
  } catch {
    return null;
  }
}

