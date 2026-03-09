import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, logCaughtError } from "./logger.mjs";
const log = createLogger();
function pluginRoot(metaUrl) {
  const base = metaUrl ?? import.meta.url;
  return resolve(dirname(fileURLToPath(base)), "..");
}
function requireEnvFile() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    process.exit(0);
  }
  return envFile;
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
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function dedupSessionIdSegment(sessionId) {
  if (SAFE_SESSION_ID_RE.test(sessionId)) {
    return sessionId;
  }
  return createHash("sha256").update(sessionId).digest("hex");
}
function resolveDedupTempPath(sessionId, basename) {
  const tempRoot = resolve(tmpdir());
  const candidate = resolve(join(tempRoot, `vercel-plugin-${dedupSessionIdSegment(sessionId)}-${basename}`));
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`;
  if (!candidate.startsWith(tempPrefix)) {
    throw new Error(`dedup temp path escaped tmpdir: tempRoot=${tempRoot} candidate=${candidate}`);
  }
  return candidate;
}
function dedupFilePath(sessionId, kind) {
  return resolveDedupTempPath(sessionId, `${kind}.txt`);
}
function dedupClaimDirPath(sessionId, kind) {
  return resolveDedupTempPath(sessionId, `${kind}.d`);
}
function readSessionFile(sessionId, kind) {
  try {
    return readFileSync(dedupFilePath(sessionId, kind), "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:read-session-file-failed", error, { sessionId, kind });
    return "";
  }
}
function writeSessionFile(sessionId, kind, value) {
  try {
    writeFileSync(dedupFilePath(sessionId, kind), value, "utf-8");
  } catch (error) {
    logCaughtError(log, "hook-env:write-session-file-failed", error, { sessionId, kind });
  }
}
function tryClaimSessionKey(sessionId, kind, key) {
  try {
    const claimDir = dedupClaimDirPath(sessionId, kind);
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
function listSessionKeys(sessionId, kind) {
  try {
    return readdirSync(dedupClaimDirPath(sessionId, kind)).map((entry) => decodeURIComponent(entry)).filter((entry) => entry !== "").sort();
  } catch (error) {
    logCaughtError(log, "hook-env:list-session-keys-failed", error, { sessionId, kind });
    return [];
  }
}
function syncSessionFileFromClaims(sessionId, kind) {
  const value = listSessionKeys(sessionId, kind).join(",");
  writeSessionFile(sessionId, kind, value);
  return value;
}
function removeSessionClaimDir(sessionId, kind) {
  try {
    rmSync(dedupClaimDirPath(sessionId, kind), { recursive: true, force: true });
  } catch (error) {
    logCaughtError(log, "hook-env:remove-session-claim-dir-failed", error, { sessionId, kind });
  }
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
export {
  appendAuditLog,
  dedupClaimDirPath,
  dedupFilePath,
  listSessionKeys,
  pluginRoot,
  readSessionFile,
  removeSessionClaimDir,
  requireEnvFile,
  safeReadFile,
  safeReadJson,
  syncSessionFileFromClaims,
  tryClaimSessionKey,
  writeSessionFile
};
