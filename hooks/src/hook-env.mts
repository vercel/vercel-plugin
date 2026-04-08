/**
 * Shared hook runtime utilities.
 *
 * Centralises plugin-root resolution, env-file access, and defensive
 * file / JSON reading so every hook doesn't re-implement the same
 * try/catch boilerplate.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
// Agent-scoped dedup helpers
// ---------------------------------------------------------------------------

/**
 * Extract a dedup scope identifier from a hook payload.
 * Returns the `agent_id` field when present (subagent context),
 * or `"main"` for the lead agent.
 */
export function getDedupScopeId(payload: Record<string, unknown> | null | undefined): string {
  if (
    payload &&
    typeof payload === "object" &&
    "agent_id" in payload &&
    typeof payload.agent_id === "string" &&
    payload.agent_id.length > 0
  ) {
    return payload.agent_id;
  }
  return "main";
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

function dedupScopeIdSegment(scopeId: string): string {
  if (SAFE_SESSION_ID_RE.test(scopeId)) {
    return scopeId;
  }

  return createHash("sha256").update(scopeId).digest("hex");
}

function resolveDedupTempPath(sessionId: string, basename: string, scopeId?: string): string {
  const tempRoot = resolve(tmpdir());
  const scopeSegment = scopeId ? `-${dedupScopeIdSegment(scopeId)}` : "";
  const candidate = resolve(join(tempRoot, `vercel-plugin-${dedupSessionIdSegment(sessionId)}${scopeSegment}-${basename}`));
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`;

  if (!candidate.startsWith(tempPrefix)) {
    throw new Error(`dedup temp path escaped tmpdir: tempRoot=${tempRoot} candidate=${candidate}`);
  }

  return candidate;
}

export function dedupFilePath(sessionId: string, kind: string, scopeId?: string): string {
  return resolveDedupTempPath(sessionId, `${kind}.txt`, scopeId);
}

export function dedupClaimDirPath(sessionId: string, kind: string, scopeId?: string): string {
  return resolveDedupTempPath(sessionId, `${kind}.d`, scopeId);
}

export function readSessionFile(sessionId: string, kind: string, scopeId?: string): string {
  try {
    return readFileSync(dedupFilePath(sessionId, kind, scopeId), "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:read-session-file-failed", error, { sessionId, kind, scopeId });
    return "";
  }
}

export function writeSessionFile(sessionId: string, kind: string, value: string, scopeId?: string): void {
  try {
    writeFileSync(dedupFilePath(sessionId, kind, scopeId), value, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:write-session-file-failed", error, { sessionId, kind, scopeId });
  }
}

export function tryClaimSessionKey(sessionId: string, kind: string, key: string, scopeId?: string): boolean {
  try {
    const claimDir = dedupClaimDirPath(sessionId, kind, scopeId);
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

export function listSessionKeys(sessionId: string, kind: string, scopeId?: string): string[] {
  try {
    return readdirSync(dedupClaimDirPath(sessionId, kind, scopeId))
      .map((entry) => decodeURIComponent(entry))
      .filter((entry) => entry !== "")
      .sort();
  } catch (error) {
    logCaughtError(log, "hook-env:list-session-keys-failed", error, { sessionId, kind, scopeId });
    return [];
  }
}

export function syncSessionFileFromClaims(sessionId: string, kind: string, scopeId?: string): string {
  const value = listSessionKeys(sessionId, kind, scopeId).join(",");
  writeSessionFile(sessionId, kind, value, scopeId);
  return value;
}

export function removeSessionClaimDir(sessionId: string, kind: string, scopeId?: string): void {
  try {
    rmSync(dedupClaimDirPath(sessionId, kind, scopeId), { recursive: true, force: true });
  } catch (error) {
    logCaughtError(log, "hook-env:remove-session-claim-dir-failed", error, { sessionId, kind, scopeId });
  }
}

/**
 * Remove **all** session-scoped dedup artifacts for a given session, including
 * agent-scoped claim dirs and session files.  Uses the same prefix-glob
 * strategy as `session-end-cleanup.mts` so that scoped entries
 * (`vercel-plugin-<session>-<scopeId>-seen-skills.{d,txt}`) are also cleared.
 */
export interface RemoveArtifactsResult {
  removedFiles: number;
  removedDirs: number;
}

const CLEARABLE_SESSION_KINDS = new Set([
  "seen-skills",
  "seen-context-chunks",
]);

export function removeAllSessionDedupArtifacts(sessionId: string): RemoveArtifactsResult {
  const result: RemoveArtifactsResult = { removedFiles: 0, removedDirs: 0 };
  const tempRoot = resolve(tmpdir());
  const prefix = `vercel-plugin-${dedupSessionIdSegment(sessionId)}-`;

  let entries: string[];
  try {
    entries = readdirSync(tempRoot).filter(
      (name) => {
        if (!name.startsWith(prefix)) return false;

        for (const kind of CLEARABLE_SESSION_KINDS) {
          if (name.endsWith(`-${kind}.d`) || name.endsWith(`-${kind}.txt`)) {
            return true;
          }
        }

        return false;
      },
    );
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(tempRoot, entry);
    if (entry.endsWith(".d")) {
      try {
        rmSync(fullPath, { recursive: true, force: true });
        result.removedDirs++;
      } catch (error) {
        logCaughtError(log, "hook-env:remove-all-session-dedup-artifacts-dir", error, { fullPath });
      }
    } else {
      try {
        rmSync(fullPath);
        result.removedFiles++;
      } catch (error) {
        logCaughtError(log, "hook-env:remove-all-session-dedup-artifacts-file", error, { fullPath });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Profile cache helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path for the session profile cache file.
 * Written by session-start-profiler, read by subagent-start-bootstrap.
 */
export function profileCachePath(sessionId: string): string {
  return resolveDedupTempPath(sessionId, "profile.json");
}

// ---------------------------------------------------------------------------
// Verification ID
// ---------------------------------------------------------------------------

/**
 * Generate a unique verification ID (UUIDv4) for traceability across
 * dev-server verification injection events.
 */
export function generateVerificationId(): string {
  return randomUUID();
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

// ---------------------------------------------------------------------------
// Vercel project linkage helpers
// ---------------------------------------------------------------------------

export const SESSION_VERCEL_PROJECT_LINK_KIND = "vercel-project-link";

export interface VercelProjectLink {
  projectId: string;
  orgId: string;
  source: "project.json" | "repo.json";
}

export interface SessionVercelProjectLinkState {
  lastResolvedAt: number;
  lastResolvedRoot?: string;
  projectId?: string;
  orgId?: string;
  lastSentProjectId?: string;
  lastSentOrgId?: string;
}

interface RepoProjectCandidate {
  directory: string;
  projectId: string;
  orgId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function resolveHookProjectRoot(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const workspaceRoot = input && Array.isArray(input.workspace_roots)
    ? input.workspace_roots.find((entry) => typeof entry === "string" && entry.trim() !== "")
    : null;
  const cwd = input && typeof input.cwd === "string" && input.cwd.trim() !== ""
    ? input.cwd
    : null;

  return cwd
    ?? (typeof workspaceRoot === "string" ? workspaceRoot : null)
    ?? asNonEmptyString(env.CURSOR_PROJECT_DIR)
    ?? asNonEmptyString(env.CLAUDE_PROJECT_ROOT)
    ?? asNonEmptyString(env.CLAUDE_PROJECT_DIR)
    ?? process.cwd();
}

function normalizeRepoPath(pathValue: string): string {
  const normalized = pathValue
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

  return normalized === "" ? "." : normalized;
}

function pathDepth(pathValue: string): number {
  return pathValue === "." ? 0 : pathValue.split("/").length;
}

function matchesRepoProjectDirectory(projectDirectory: string, currentPath: string): boolean {
  if (projectDirectory === ".") {
    return true;
  }

  return currentPath === projectDirectory || currentPath.startsWith(`${projectDirectory}/`);
}

function resolveProjectJsonLink(dir: string): VercelProjectLink | null {
  const raw = readJsonIfExists(join(dir, ".vercel", "project.json"));
  if (!isRecord(raw)) return null;

  const projectId = asNonEmptyString(raw.projectId);
  const orgId = asNonEmptyString(raw.orgId);
  if (!projectId || !orgId) return null;

  return {
    projectId,
    orgId,
    source: "project.json",
  };
}

function resolveRepoJsonLink(repoRoot: string, startPath: string): VercelProjectLink | null {
  const raw = readJsonIfExists(join(repoRoot, ".vercel", "repo.json"));
  if (!isRecord(raw) || !Array.isArray(raw.projects)) {
    return null;
  }

  const repoOrgId = asNonEmptyString(raw.orgId);
  const currentPath = normalizeRepoPath(relative(repoRoot, startPath));
  const candidates: RepoProjectCandidate[] = raw.projects
    .filter(isRecord)
    .map((project) => {
      const projectId = asNonEmptyString(project.id);
      const orgId = asNonEmptyString(project.orgId) ?? repoOrgId;
      const directory = normalizeRepoPath(asNonEmptyString(project.directory) ?? ".");

      if (!projectId || !orgId) {
        return null;
      }

      return {
        directory,
        projectId,
        orgId,
      };
    })
    .filter((candidate): candidate is RepoProjectCandidate => candidate !== null)
    .filter((candidate) => matchesRepoProjectDirectory(candidate.directory, currentPath))
    .sort((left, right) => pathDepth(right.directory) - pathDepth(left.directory));

  if (candidates.length === 0) {
    return null;
  }

  const deepestDepth = pathDepth(candidates[0].directory);
  const deepestCandidates = candidates.filter((candidate) => pathDepth(candidate.directory) === deepestDepth);
  if (deepestCandidates.length !== 1) {
    return null;
  }

  return {
    projectId: deepestCandidates[0].projectId,
    orgId: deepestCandidates[0].orgId,
    source: "repo.json",
  };
}

export function resolveVercelProjectLink(startPath: string): VercelProjectLink | null {
  const resolvedStartPath = resolve(startPath);
  let current = resolvedStartPath;

  while (true) {
    const projectLink = resolveProjectJsonLink(current);
    if (projectLink) {
      return projectLink;
    }

    const repoJsonPath = join(current, ".vercel", "repo.json");
    if (existsSync(repoJsonPath)) {
      const repoLink = resolveRepoJsonLink(current, resolvedStartPath);
      if (repoLink) {
        return repoLink;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function parseSessionVercelProjectLinkState(raw: string): SessionVercelProjectLinkState | null {
  if (raw.trim() === "") return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const lastResolvedAt = parsed.lastResolvedAt;
    if (typeof lastResolvedAt !== "number" || !Number.isFinite(lastResolvedAt)) {
      return null;
    }

    const state: SessionVercelProjectLinkState = { lastResolvedAt };
    const lastResolvedRoot = asNonEmptyString(parsed.lastResolvedRoot);
    const projectId = asNonEmptyString(parsed.projectId);
    const orgId = asNonEmptyString(parsed.orgId);
    const lastSentProjectId = asNonEmptyString(parsed.lastSentProjectId);
    const lastSentOrgId = asNonEmptyString(parsed.lastSentOrgId);

    if (lastResolvedRoot) {
      state.lastResolvedRoot = lastResolvedRoot;
    }
    if (projectId) {
      state.projectId = projectId;
    }
    if (orgId) {
      state.orgId = orgId;
    }
    if (lastSentProjectId) {
      state.lastSentProjectId = lastSentProjectId;
    }
    if (lastSentOrgId) {
      state.lastSentOrgId = lastSentOrgId;
    }

    return state;
  } catch {
    return null;
  }
}

export function readSessionVercelProjectLinkState(sessionId: string): SessionVercelProjectLinkState | null {
  try {
    const raw = readFileSync(dedupFilePath(sessionId, SESSION_VERCEL_PROJECT_LINK_KIND), "utf-8");
    return parseSessionVercelProjectLinkState(raw);
  } catch {
    return null;
  }
}

export function writeSessionVercelProjectLinkState(
  sessionId: string,
  state: SessionVercelProjectLinkState,
): void {
  writeSessionFile(sessionId, SESSION_VERCEL_PROJECT_LINK_KIND, JSON.stringify(state));
}

function hasUnsentSessionVercelProjectLink(state: SessionVercelProjectLinkState | null): boolean {
  if (!state) {
    return false;
  }

  return (state.projectId ?? null) !== (state.lastSentProjectId ?? null)
    || (state.orgId ?? null) !== (state.lastSentOrgId ?? null);
}

export function shouldRefreshSessionVercelProjectLink(
  state: SessionVercelProjectLinkState | null,
  currentProjectRoot: string,
  now: number,
  refreshMs: number,
): boolean {
  return !state
    || state.lastResolvedRoot !== currentProjectRoot
    || hasUnsentSessionVercelProjectLink(state)
    || now - state.lastResolvedAt >= refreshMs;
}
