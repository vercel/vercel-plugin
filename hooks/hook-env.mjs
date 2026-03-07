import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  pluginRoot,
  requireEnvFile,
  safeReadFile,
  safeReadJson
};
