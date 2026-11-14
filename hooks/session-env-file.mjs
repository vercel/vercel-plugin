// hooks/src/session-env-file.mts
import { readFileSync, renameSync, rmSync, writeFileSync } from "fs";
var SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteShellValue(value) {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
function readEnvFile(envFile) {
  try {
    return readFileSync(envFile, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
function writeFileAtomically(path, content) {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf-8");
  try {
    renameSync(tempPath, path);
  } catch {
    rmSync(tempPath, { force: true });
    writeFileSync(path, content, "utf-8");
  }
}
function upsertSessionEnvExports(envFile, vars) {
  const keys = Object.keys(vars);
  if (keys.length === 0) return;
  const invalidKey = keys.find((key) => !SHELL_IDENTIFIER.test(key));
  if (invalidKey !== void 0) {
    throw new TypeError(
      `Invalid shell env var name: ${JSON.stringify(invalidKey)}`
    );
  }
  const multilineKey = keys.find((key) => /[\r\n]/.test(vars[key]));
  if (multilineKey !== void 0) {
    throw new TypeError(
      `Env var ${multilineKey} has a line break, which CLAUDE_ENV_FILE cannot hold`
    );
  }
  const prefixes = keys.map((key) => `export ${key}=`);
  const kept = readEnvFile(envFile).split(/\r?\n/).filter(
    (line) => line !== "" && !prefixes.some((prefix) => line.startsWith(prefix))
  );
  const exports = keys.map(
    (key) => `export ${key}=${quoteShellValue(vars[key])}`
  );
  writeFileAtomically(envFile, `${[...kept, ...exports].join("\n")}
`);
}
export {
  upsertSessionEnvExports
};
