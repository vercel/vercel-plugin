import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function getAntigravityEnvPath(): string {
  const base = join(homedir(), ".gemini", "antigravity", "context_state");
  return join(base, "vercel-plugin-env");
}

export function loadAntigravityEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ANTIGRAVITY_AGENT !== "1") return;
  const path = getAntigravityEnvPath();
  try {
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf-8");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      const match = line.match(/^export\s+([^=]+)="(.*)"$/);
      if (match) {
        let [, key, value] = match;
        // Unescape: \" -> ", \$ -> $, \` -> `, \\ -> \
        value = value.replace(/\\(["\\$`])/g, "$1");
        env[key] = value;
      }
    }
  } catch {
    // Ignore errors
  }
}

export function saveAntigravityEnv(key: string, value: string): void {
  if (process.env.ANTIGRAVITY_AGENT !== "1") return;
  const path = getAntigravityEnvPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const escapedValue = value.replace(/(["\\$`])/g, "\\$1");
    appendFileSync(path, `export ${key}="${escapedValue}"\n`);
  } catch {
    // Ignore errors
  }
}
