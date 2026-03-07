import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  } catch {
  }
}
function dedupFilePath(sessionId, kind) {
  return join(tmpdir(), `vercel-plugin-${sessionId}-${kind}.txt`);
}
function readSessionFile(sessionId, kind) {
  try {
    return readFileSync(dedupFilePath(sessionId, kind), "utf-8");
  } catch {
    return "";
  }
}
function writeSessionFile(sessionId, kind, value) {
  try {
    writeFileSync(dedupFilePath(sessionId, kind), value, "utf-8");
  } catch {
  }
}
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
function safeReadJson(path) {
  const content = safeReadFile(path);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
export {
  appendAuditLog,
  dedupFilePath,
  pluginRoot,
  readSessionFile,
  requireEnvFile,
  safeReadFile,
  safeReadJson,
  writeSessionFile
};
