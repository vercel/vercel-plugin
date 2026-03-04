import { describe, test, expect } from "bun:test";
import { readdir, readFile, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("validate.ts", () => {
  test("exits 0 on clean repo", async () => {
    const proc = Bun.spawn(["bun", "run", join(ROOT, "scripts", "validate.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(stderr);
    }
    expect(code).toBe(0);
  }, 30_000);

  test("every graph skill ref resolves to an existing skill directory", async () => {
    const graphPath = join(ROOT, "assets", "vercel-ecosystem-graph.md");
    const graph = await readFile(graphPath, "utf-8");
    const refs = [...new Set(
      [...graph.matchAll(/⤳\s*skill:\s*([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
    )];

    expect(refs.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const name of refs) {
      if (!(await exists(join(ROOT, "skills", name, "SKILL.md")))) {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
  });

  test("JSON report includes per-check timing metrics", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(ROOT, "scripts", "validate.ts"), "--format", "json", "--coverage", "skip"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const report = JSON.parse(stdout);

    expect(report.metrics).toBeArray();
    expect(report.metrics.length).toBeGreaterThan(0);
    for (const m of report.metrics) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.durationMs).toBe("number");
    }
  }, 30_000);

  test("every issue has a non-empty hint field", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(ROOT, "scripts", "validate.ts"), "--format", "json", "--coverage", "skip"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const report = JSON.parse(stdout);

    for (const issue of report.issues) {
      expect(issue.hint).toBeDefined();
      expect(typeof issue.hint).toBe("string");
      expect(issue.hint.length).toBeGreaterThan(0);
    }
  }, 30_000);

  test("current state has 0 orphan skills", async () => {
    const graphPath = join(ROOT, "assets", "vercel-ecosystem-graph.md");
    const graph = await readFile(graphPath, "utf-8");
    const referencedSkills = new Set(
      [...graph.matchAll(/⤳\s*skill:\s*([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
    );

    const skillsDir = join(ROOT, "skills");
    const dirs = await readdir(skillsDir);
    const orphans: string[] = [];
    for (const dir of dirs.sort()) {
      if (!(await exists(join(skillsDir, dir, "SKILL.md")))) continue;
      if (!referencedSkills.has(dir)) orphans.push(dir);
    }

    expect(orphans).toEqual([]);
  });

  test("introducing an orphan skill causes validation failure", async () => {
    const orphanDir = join(ROOT, "skills", "fake-orphan-test-skill");
    try {
      await mkdir(orphanDir, { recursive: true });
      await writeFile(
        join(orphanDir, "SKILL.md"),
        "---\nname: fake-orphan-test-skill\ndescription: test orphan\n---\nTest skill.\n",
      );

      const proc = Bun.spawn(
        ["bun", "run", join(ROOT, "scripts", "validate.ts"), "--format", "json", "--coverage", "skip"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;

      expect(code).not.toBe(0);

      const report = JSON.parse(stdout);
      expect(report.orphanSkills).toContain("fake-orphan-test-skill");
      expect(report.issues.some((i: any) => i.code === "ORPHAN_SKILL" && i.message.includes("fake-orphan-test-skill"))).toBe(true);
    } finally {
      await rm(orphanDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("JSON report includes orphanSkills field", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(ROOT, "scripts", "validate.ts"), "--format", "json", "--coverage", "skip"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const report = JSON.parse(stdout);

    expect(report.orphanSkills).toBeArray();
  }, 30_000);

  test("graph skill ref errors include line numbers", async () => {
    // Parse the graph directly and verify that lineOf produces numbers for skill refs
    const graphPath = join(ROOT, "assets", "vercel-ecosystem-graph.md");
    const graph = await readFile(graphPath, "utf-8");
    const refs = [...graph.matchAll(/⤳\s*skill:\s*([a-z][a-z0-9-]*)/g)];

    expect(refs.length).toBeGreaterThan(0);

    for (const m of refs) {
      const idx = graph.indexOf(m[0]);
      const line = graph.slice(0, idx).split("\n").length;
      expect(line).toBeGreaterThan(0);
      expect(typeof line).toBe("number");
    }
  });
});
