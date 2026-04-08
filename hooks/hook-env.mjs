// hooks/src/hook-env.mts
import { createHash, randomUUID } from "crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { createLogger, logCaughtError } from "./logger.mjs";
var log = createLogger();
function pluginRoot(metaUrl) {
  const base = metaUrl ?? import.meta.url;
  return resolve(dirname(fileURLToPath(base)), "..");
}
function resolveAuditLogPath(hookInputCwd) {
  const cwdFromHookInput = typeof hookInputCwd === "string" && hookInputCwd.trim() !== "" ? hookInputCwd : null;
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
function appendAuditLog(record, hookInputCwd) {
  const auditLogPath = resolveAuditLogPath(hookInputCwd);
  if (auditLogPath === null) return;
  try {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    const payload = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...record };
    appendFileSync(auditLogPath, `${JSON.stringify(payload)}
`, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:append-audit-log-failed", error, { auditLogPath });
  }
}
function getDedupScopeId(payload) {
  if (payload && typeof payload === "object" && "agent_id" in payload && typeof payload.agent_id === "string" && payload.agent_id.length > 0) {
    return payload.agent_id;
  }
  return "main";
}
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function dedupSessionIdSegment(sessionId) {
  if (SAFE_SESSION_ID_RE.test(sessionId)) {
    return sessionId;
  }
  return createHash("sha256").update(sessionId).digest("hex");
}
function dedupScopeIdSegment(scopeId) {
  if (SAFE_SESSION_ID_RE.test(scopeId)) {
    return scopeId;
  }
  return createHash("sha256").update(scopeId).digest("hex");
}
function resolveDedupTempPath(sessionId, basename, scopeId) {
  const tempRoot = resolve(tmpdir());
  const scopeSegment = scopeId ? `-${dedupScopeIdSegment(scopeId)}` : "";
  const candidate = resolve(join(tempRoot, `vercel-plugin-${dedupSessionIdSegment(sessionId)}${scopeSegment}-${basename}`));
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`;
  if (!candidate.startsWith(tempPrefix)) {
    throw new Error(`dedup temp path escaped tmpdir: tempRoot=${tempRoot} candidate=${candidate}`);
  }
  return candidate;
}
function dedupFilePath(sessionId, kind, scopeId) {
  return resolveDedupTempPath(sessionId, `${kind}.txt`, scopeId);
}
function dedupClaimDirPath(sessionId, kind, scopeId) {
  return resolveDedupTempPath(sessionId, `${kind}.d`, scopeId);
}
function readSessionFile(sessionId, kind, scopeId) {
  try {
    return readFileSync(dedupFilePath(sessionId, kind, scopeId), "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:read-session-file-failed", error, { sessionId, kind, scopeId });
    return "";
  }
}
function writeSessionFile(sessionId, kind, value, scopeId) {
  try {
    writeFileSync(dedupFilePath(sessionId, kind, scopeId), value, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:write-session-file-failed", error, { sessionId, kind, scopeId });
  }
}
function tryClaimSessionKey(sessionId, kind, key, scopeId) {
  try {
    const claimDir = dedupClaimDirPath(sessionId, kind, scopeId);
    mkdirSync(claimDir, { recursive: true });
    const file = join(claimDir, encodeURIComponent(key));
    const fd = openSync(file, "wx");
    closeSync(fd);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return false;
    }
    return false;
  }
}
function listSessionKeys(sessionId, kind, scopeId) {
  try {
    return readdirSync(dedupClaimDirPath(sessionId, kind, scopeId)).map((entry) => decodeURIComponent(entry)).filter((entry) => entry !== "").sort();
  } catch (error) {
    logCaughtError(log, "hook-env:list-session-keys-failed", error, { sessionId, kind, scopeId });
    return [];
  }
}
function syncSessionFileFromClaims(sessionId, kind, scopeId) {
  const value = listSessionKeys(sessionId, kind, scopeId).join(",");
  writeSessionFile(sessionId, kind, value, scopeId);
  return value;
}
function removeSessionClaimDir(sessionId, kind, scopeId) {
  try {
    rmSync(dedupClaimDirPath(sessionId, kind, scopeId), { recursive: true, force: true });
  } catch (error) {
    logCaughtError(log, "hook-env:remove-session-claim-dir-failed", error, { sessionId, kind, scopeId });
  }
}
var CLEARABLE_SESSION_KINDS = /* @__PURE__ */ new Set([
  "seen-skills",
  "seen-context-chunks"
]);
function removeAllSessionDedupArtifacts(sessionId) {
  const result = { removedFiles: 0, removedDirs: 0 };
  const tempRoot = resolve(tmpdir());
  const prefix = `vercel-plugin-${dedupSessionIdSegment(sessionId)}-`;
  let entries;
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
      }
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
function profileCachePath(sessionId) {
  return resolveDedupTempPath(sessionId, "profile.json");
}
function generateVerificationId() {
  return randomUUID();
}
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:safe-read-file-failed", error, { path });
    return null;
  }
}
function safeReadJson(path) {
  const content = safeReadFile(path);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    logCaughtError(log, "hook-env:safe-read-json-failed", error, { path });
    return null;
  }
}
var SESSION_VERCEL_PROJECT_LINK_KIND = "vercel-project-link";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function resolveHookProjectRoot(input, env = process.env) {
  const workspaceRoot = input && Array.isArray(input.workspace_roots) ? input.workspace_roots.find((entry) => typeof entry === "string" && entry.trim() !== "") : null;
  const cwd = input && typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : null;
  return cwd ?? (typeof workspaceRoot === "string" ? workspaceRoot : null) ?? asNonEmptyString(env.CURSOR_PROJECT_DIR) ?? asNonEmptyString(env.CLAUDE_PROJECT_ROOT) ?? asNonEmptyString(env.CLAUDE_PROJECT_DIR) ?? process.cwd();
}
function normalizeRepoPath(pathValue) {
  const normalized = pathValue.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}
function pathDepth(pathValue) {
  return pathValue === "." ? 0 : pathValue.split("/").length;
}
function matchesRepoProjectDirectory(projectDirectory, currentPath) {
  if (projectDirectory === ".") {
    return true;
  }
  return currentPath === projectDirectory || currentPath.startsWith(`${projectDirectory}/`);
}
function resolveProjectJsonLink(dir) {
  const raw = readJsonIfExists(join(dir, ".vercel", "project.json"));
  if (!isRecord(raw)) return null;
  const projectId = asNonEmptyString(raw.projectId);
  const orgId = asNonEmptyString(raw.orgId);
  if (!projectId || !orgId) return null;
  return {
    projectId,
    orgId,
    source: "project.json"
  };
}
function resolveRepoJsonLink(repoRoot, startPath) {
  const raw = readJsonIfExists(join(repoRoot, ".vercel", "repo.json"));
  if (!isRecord(raw) || !Array.isArray(raw.projects)) {
    return null;
  }
  const repoOrgId = asNonEmptyString(raw.orgId);
  const currentPath = normalizeRepoPath(relative(repoRoot, startPath));
  const candidates = raw.projects.filter(isRecord).map((project) => {
    const projectId = asNonEmptyString(project.id);
    const orgId = asNonEmptyString(project.orgId) ?? repoOrgId;
    const directory = normalizeRepoPath(asNonEmptyString(project.directory) ?? ".");
    if (!projectId || !orgId) {
      return null;
    }
    return {
      directory,
      projectId,
      orgId
    };
  }).filter((candidate) => candidate !== null).filter((candidate) => matchesRepoProjectDirectory(candidate.directory, currentPath)).sort((left, right) => pathDepth(right.directory) - pathDepth(left.directory));
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
    source: "repo.json"
  };
}
function resolveVercelProjectLink(startPath) {
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
function parseSessionVercelProjectLinkState(raw) {
  if (raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const lastResolvedAt = parsed.lastResolvedAt;
    if (typeof lastResolvedAt !== "number" || !Number.isFinite(lastResolvedAt)) {
      return null;
    }
    const state = { lastResolvedAt };
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
function readSessionVercelProjectLinkState(sessionId) {
  try {
    const raw = readFileSync(dedupFilePath(sessionId, SESSION_VERCEL_PROJECT_LINK_KIND), "utf-8");
    return parseSessionVercelProjectLinkState(raw);
  } catch {
    return null;
  }
}
function writeSessionVercelProjectLinkState(sessionId, state) {
  writeSessionFile(sessionId, SESSION_VERCEL_PROJECT_LINK_KIND, JSON.stringify(state));
}
function hasUnsentSessionVercelProjectLink(state) {
  if (!state) {
    return false;
  }
  return (state.projectId ?? null) !== (state.lastSentProjectId ?? null) || (state.orgId ?? null) !== (state.lastSentOrgId ?? null);
}
function shouldRefreshSessionVercelProjectLink(state, currentProjectRoot, now, refreshMs) {
  return !state || state.lastResolvedRoot !== currentProjectRoot || hasUnsentSessionVercelProjectLink(state) || now - state.lastResolvedAt >= refreshMs;
}
export {
  SESSION_VERCEL_PROJECT_LINK_KIND,
  appendAuditLog,
  dedupClaimDirPath,
  dedupFilePath,
  generateVerificationId,
  getDedupScopeId,
  listSessionKeys,
  parseSessionVercelProjectLinkState,
  pluginRoot,
  profileCachePath,
  readSessionFile,
  readSessionVercelProjectLinkState,
  removeAllSessionDedupArtifacts,
  removeSessionClaimDir,
  resolveHookProjectRoot,
  resolveVercelProjectLink,
  safeReadFile,
  safeReadJson,
  shouldRefreshSessionVercelProjectLink,
  syncSessionFileFromClaims,
  tryClaimSessionKey,
  writeSessionFile,
  writeSessionVercelProjectLinkState
};
