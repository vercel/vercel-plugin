import { defineConfig } from "tsup";
import { readdirSync } from "node:fs";

// Build each .mts source file as a separate .mjs output (no bundling)
const discoveredEntries = readdirSync("hooks/src")
  .filter((f) => f.endsWith(".mts"))
  .map((f) => `hooks/src/${f}`);
const entries = Array.from(
  new Set([
    ...discoveredEntries,
    "hooks/src/session-end-cleanup.mts",
  ]),
).sort();

export default defineConfig({
  entry: entries,
  format: ["esm"],
  outDir: "hooks",
  outExtension: () => ({ js: ".mjs" }),
  bundle: false,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: false, // don't wipe hooks/ — it has hooks.json, src/, etc.
  target: "node20",
  // No banner — source files that need a shebang already include #!/usr/bin/env node
});
