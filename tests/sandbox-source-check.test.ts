import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSandboxSource } from "../scripts/check-sandbox-source";

const ROOT = resolve(import.meta.dir, "..");
const temporary: string[] = [];
const source = "---\nname: sandbox\ndescription: Canonical description\n---\n\n# Sandbox\nRun a command.\n";

function write(path: string, text: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function fixture(skillSource = source) {
  const root = mkdtempSync(join(tmpdir(), "sandbox-source-check-"));
  temporary.push(root);
  const canonical = join(root, "canonical");
  const skill = join(root, "skills/vercel-sandbox");
  write(join(canonical, "SKILL.md"), skillSource);
  write(join(canonical, "references/nested/cli.md"), "Run sandbox exec.\n");
  cpSync(canonical, join(skill, "upstream"), { recursive: true });
  write(join(skill, "overlay.yaml"), "name: vercel-sandbox\ndescription: Plugin description\nmetadata:\n  priority: 4\n");
  mkdirSync(join(root, "scripts"));
  cpSync(join(ROOT, "scripts/build-skills.ts"), join(root, "scripts/build-skills.ts"));
  cpSync(join(ROOT, "scripts/check-sandbox-source.ts"), join(root, "scripts/check-sandbox-source.ts"));
  const build = Bun.spawnSync([process.execPath, "run", join(root, "scripts/build-skills.ts"), "vercel-sandbox"]);
  expect(build.exitCode).toBe(0);
  return { root, canonical, skill };
}

function snapshot(root: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(snapshot(path))) output[`${entry.name}/${name}`] = content;
    } else output[entry.name] = readFileSync(path).toString("base64");
  }
  return output;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Sandbox canonical source check", () => {
  test("accepts a real build with plugin-specific frontmatter and nested references", () => {
    const { canonical, root, skill } = fixture();
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("name: vercel-sandbox");
    expect(checkSandboxSource(canonical, root)).toEqual([]);
  });

  test("uses the builder's frontmatter rules for whitespace-padded fences", () => {
    const padded = source.replace("---\n\n# Sandbox", "--- \n\n# Sandbox") + "\n---\nMore guidance.\n";
    const { canonical, root } = fixture(padded);
    expect(checkSandboxSource(canonical, root)).toEqual([]);
  });

  test("detects changed canonical content even when the local build is current, without writes", () => {
    const { canonical, root } = fixture();
    write(join(canonical, "SKILL.md"), source.replace("Run a command.", "Run sandbox exec --stdin."));
    const before = snapshot(root);
    expect(checkSandboxSource(canonical, root)).toEqual(["Bundled source: changed SKILL.md"]);
    expect(snapshot(root)).toEqual(before);
  });

  test("detects added and removed upstream reference files", () => {
    const { canonical, root } = fixture();
    rmSync(join(canonical, "references/nested/cli.md"));
    write(join(canonical, "references/jobs.md"), "Wait for a job.\n");
    expect(checkSandboxSource(canonical, root)).toEqual([
      "Bundled source: missing references/jobs.md",
      "Bundled source: extra references/nested/cli.md",
    ]);
  });

  test("detects edited or missing generated skill without regenerating it", () => {
    const { canonical, root, skill } = fixture();
    write(join(skill, "SKILL.md"), "stale output");
    const before = snapshot(root);
    expect(checkSandboxSource(canonical, root)).toEqual(["Generated skill: changed SKILL.md"]);
    expect(snapshot(root)).toEqual(before);
    rmSync(join(skill, "SKILL.md"));
    expect(checkSandboxSource(canonical, root)).toEqual(["Generated skill: missing SKILL.md"]);
  });

  test("detects stale generated metadata after an overlay edit", () => {
    const { canonical, root, skill } = fixture();
    write(join(skill, "overlay.yaml"), "name: vercel-sandbox\nmetadata:\n  priority: 6\n");
    expect(checkSandboxSource(canonical, root)).toEqual(["Generated skill: changed SKILL.md"]);
  });

  test("detects changed, missing and extra generated references", () => {
    const { canonical, root, skill } = fixture();
    write(join(skill, "references/nested/cli.md"), "outdated");
    write(join(skill, "references/removed.md"), "removed upstream");
    expect(checkSandboxSource(canonical, root)).toEqual([
      "Generated skill: changed references/nested/cli.md",
      "Generated skill: extra references/removed.md",
    ]);
    rmSync(join(skill, "references/nested/cli.md"));
    expect(checkSandboxSource(canonical, root)).toContain("Generated skill: missing references/nested/cli.md");
  });

  test.each(["AGENTS.md", "rules/rule.md", "templates/example.md", "command/run.md"])("checks generated %s", (file) => {
    const { canonical, root, skill } = fixture();
    write(join(canonical, file), "Canonical guidance\n");
    write(join(skill, "upstream", file), "Canonical guidance\n");
    expect(checkSandboxSource(canonical, root)).toContain(`Generated skill: missing ${file}`);
    write(join(skill, file), "Canonical guidance\n");
    expect(checkSandboxSource(canonical, root)).toEqual([]);
    write(join(skill, file), "Stale guidance\n");
    expect(checkSandboxSource(canonical, root)).toContain(`Generated skill: changed ${file}`);
  });

  test("does not report plugin-only metadata or README as canonical differences", () => {
    const { canonical, root, skill } = fixture();
    write(join(skill, "README.md"), "Plugin-specific maintenance notes");
    expect(checkSandboxSource(canonical, root)).toEqual([]);
  });

  test("fails closed for missing, empty, or linked source", () => {
    const { canonical, root } = fixture();
    expect(() => checkSandboxSource(join(root, "missing"), root)).toThrow();
    rmSync(join(canonical, "SKILL.md"));
    expect(() => checkSandboxSource(canonical, root)).toThrow("must contain SKILL.md");
    write(join(canonical, "SKILL.md"), "   \n");
    expect(() => checkSandboxSource(canonical, root)).toThrow("must not be empty");
    write(join(canonical, "SKILL.md"), source);
    symlinkSync(join(canonical, "SKILL.md"), join(canonical, "linked.md"));
    expect(() => checkSandboxSource(canonical, root)).toThrow("regular file or directory");
  });

  test("CLI distinguishes a match, drift, and an incomplete check", () => {
    const { canonical, root } = fixture();
    const script = join(root, "scripts/check-sandbox-source.ts");
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", script, ...args]);
    const match = run(canonical);
    expect(match.exitCode).toBe(0);
    expect(match.stdout.toString()).toContain("match");
    write(join(canonical, "SKILL.md"), source + "Changed.\n");
    const drift = run(canonical);
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain("Bundled source: changed SKILL.md");
    expect(run(join(root, "unavailable")).exitCode).toBe(2);
    expect(run().exitCode).toBe(2);
  });
});
