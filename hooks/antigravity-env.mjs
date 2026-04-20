// hooks/src/antigravity-env.mts
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
function getAntigravityEnvPath() {
  const base = join(homedir(), ".gemini", "antigravity", "context_state");
  return join(base, "vercel-plugin-env");
}
function loadAntigravityEnv(env = process.env) {
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
        value = value.replace(/\\(["\\$`])/g, "$1");
        env[key] = value;
      }
    }
  } catch {
  }
}
function saveAntigravityEnv(key, value) {
  if (process.env.ANTIGRAVITY_AGENT !== "1") return;
  const path = getAntigravityEnvPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const escapedValue = value.replace(/(["\\$`])/g, "\\$1");
    appendFileSync(path, `export ${key}="${escapedValue}"
`);
  } catch {
  }
}
export {
  getAntigravityEnvPath,
  loadAntigravityEnv,
  saveAntigravityEnv
};
