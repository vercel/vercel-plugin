import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteShellValue(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function readEnvFile(envFile: string): string {
  try {
    return readFileSync(envFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeFileAtomically(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf-8");
  try {
    renameSync(tempPath, path);
  } catch {
    rmSync(tempPath, { force: true });
    writeFileSync(path, content, "utf-8");
  }
}

export function upsertSessionEnvExports(
  envFile: string,
  vars: Record<string, string>,
): void {
  const keys = Object.keys(vars);
  if (keys.length === 0) return;

  const invalidKey = keys.find((key) => !SHELL_IDENTIFIER.test(key));
  if (invalidKey !== undefined) {
    throw new TypeError(
      `Invalid shell env var name: ${JSON.stringify(invalidKey)}`,
    );
  }

  // claude code parses this file line by line, so a value with a line break cannot be stored
  const multilineKey = keys.find((key) => /[\r\n]/.test(vars[key]));
  if (multilineKey !== undefined) {
    throw new TypeError(
      `Env var ${multilineKey} has a line break, which CLAUDE_ENV_FILE cannot hold`,
    );
  }

  const prefixes = keys.map((key) => `export ${key}=`);
  const kept = readEnvFile(envFile)
    .split(/\r?\n/)
    .filter(
      (line) =>
        line !== "" && !prefixes.some((prefix) => line.startsWith(prefix)),
    );
  const exports = keys.map(
    (key) => `export ${key}=${quoteShellValue(vars[key])}`,
  );

  writeFileAtomically(envFile, `${[...kept, ...exports].join("\n")}\n`);
}
