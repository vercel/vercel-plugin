import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifestPath = ".antigravity-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64) {
  throw new Error("Invalid Antigravity plugin name");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Invalid Antigravity plugin version");
}
const output = join(root, "dist", "antigravity");
const plugin = join(output, manifest.name);
rmSync(output, { recursive: true, force: true });
mkdirSync(plugin, { recursive: true });

for (const file of [manifestPath, "mcp_config.json", manifest.logo, "README.md", "LICENSE"]) {
  const target = join(plugin, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}
cpSync(join(root, "skills"), join(plugin, "skills"), {
  recursive: true,
  filter: (source) => !relative(join(root, "skills"), source).split(/[\\/]/).some(
    (part) => part === "upstream" || part === "overlay.yaml" || part.startsWith("."),
  ),
});
mkdirSync(join(plugin, "agents"));
for (const name of readdirSync(join(root, "agents")).filter((name) => name.endsWith(".md"))) {
  cpSync(join(root, "agents", name), join(plugin, "agents", name));
}

const routed: string[] = [];
for (const name of readdirSync(join(plugin, "skills"))) {
  const skill = join(plugin, "skills", name, "SKILL.md");
  if (!existsSync(skill)) continue;
  const match = readFileSync(skill, "utf8").match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error(`Missing frontmatter: ${name}`);
  if (Buffer.byteLength(match[2]) <= 24_000) continue;
  // Antigravity truncates skill bodies at 24 KB. Keep the full guide alongside
  // SKILL.md so its existing relative links still resolve from the same directory.
  const guide = join(dirname(skill), "antigravity-guide.md");
  if (existsSync(guide)) throw new Error(`Guide already exists: ${name}`);
  writeFileSync(guide, match[2]);
  writeFileSync(skill, `${match[1]}\n# ${name}\n\nRead [the complete guide](./antigravity-guide.md) before performing this skill's task. It contains the required guidance, examples, and links to supporting references.\n`);
  routed.push(name);
}

const files: string[] = [];
function collect(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else files.push(relative(output, path));
  }
}
collect(plugin);
files.sort();
const timestamp = new Date("2026-01-01T00:00:00Z");
for (const file of files) utimesSync(join(output, file), timestamp, timestamp);
const archive = `${manifest.name}-antigravity-${manifest.version}.zip`;
const zip = spawnSync("zip", ["-X", "-q", archive, "-@"], {
  cwd: output,
  input: `${files.join("\n")}\n`,
  encoding: "utf8",
  env: { ...process.env, TZ: "UTC" },
});
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(zip.stderr || "zip failed");
console.log(`Built ${join(output, archive)} (${files.length} files)`);
console.log(`Full guides loaded on demand: ${routed.join(", ") || "none"}`);
