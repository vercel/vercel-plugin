import { defineConfig } from "tsup";
import { readFileSync, readdirSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };

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

// Local hook-to-hook imports stay as external (sibling .mjs files at runtime).
// Everything from node_modules gets bundled inline — plugins can't install deps.
//
// IMPORTANT: noExternal: [/.*/] overrides the `external` array in tsup, so
// sibling hook imports were being inlined — duplicating side-effecting
// isMainModule() guards and producing invalid double-JSON output (e.g. "{}{}").
// Fix: use an esbuild plugin to mark sibling .mjs imports as external before
// tsup's noExternal logic runs.
const hookExternalSet = new Set(
  entries.map((e) => `./${e.replace("hooks/src/", "").replace(".mts", ".mjs")}`),
);

export default defineConfig({
  entry: entries,
  format: ["esm"],
  outDir: "hooks",
  outExtension: () => ({ js: ".mjs" }),
  bundle: true,
  splitting: false,
  noExternal: [/.*/], // bundle ALL npm deps — plugins can't install
  sourcemap: false,
  dts: false,
  clean: false, // don't wipe hooks/ — it has hooks.json, src/, etc.
  target: "node20",
  define: {
    __VERCEL_PLUGIN_VERSION__: JSON.stringify(packageJson.version),
  },
  esbuildPlugins: [
    {
      name: "externalize-sibling-hooks",
      setup(build) {
        // Mark sibling hook imports (./foo.mjs) as external so they're not
        // inlined. This runs before tsup's noExternal catch-all.
        build.onResolve({ filter: /^\.\/.*\.mjs$/ }, (args) => {
          if (hookExternalSet.has(args.path)) {
            return { path: args.path, external: true };
          }
          return undefined;
        });
      },
    },
  ],
  // No banner — source files that need a shebang already include #!/usr/bin/env node
});
