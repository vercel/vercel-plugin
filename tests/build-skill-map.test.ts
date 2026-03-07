import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-manifest.ts");
const SKILLS_DIR = join(ROOT, "skills");
const MANIFEST_PATH = join(ROOT, "generated", "skill-manifest.json");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readManifest(): any {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function countSkillDirs(): number {
  return readdirSync(SKILLS_DIR).filter((d) => {
    try {
      return existsSync(join(SKILLS_DIR, d, "SKILL.md"));
    } catch {
      return false;
    }
  }).length;
}

async function runBuild(): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", BUILD_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

async function runHook(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const session = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({ ...input, session_id: session });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_SEEN_SKILLS: "" },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("build-manifest.ts", () => {
  test("build script exits 0 and produces manifest", async () => {
    const { code, stdout } = await runBuild();
    expect(code).toBe(0);
    expect(stdout).toContain("skills to");
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  test("manifest is valid JSON with expected structure", () => {
    const manifest = readManifest();
    expect(manifest).toHaveProperty("generatedAt");
    expect(manifest).toHaveProperty("skills");
    expect(typeof manifest.generatedAt).toBe("string");
    expect(typeof manifest.skills).toBe("object");
    // Should have parsed a valid ISO date
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
  });

  test("manifest skill count matches skills/ directory", () => {
    const manifest = readManifest();
    const expected = countSkillDirs();
    expect(Object.keys(manifest.skills).length).toBe(expected);
  });

  test("each manifest skill has required fields", () => {
    const manifest = readManifest();
    for (const [slug, config] of Object.entries(manifest.skills) as [string, any][]) {
      expect(typeof config.priority).toBe("number");
      expect(Array.isArray(config.pathPatterns)).toBe(true);
      expect(Array.isArray(config.bashPatterns)).toBe(true);
      expect(config.bodyPath).toBe(`skills/${slug}/SKILL.md`);
    }
  });

  test("manifest pathPatterns contain only strings", () => {
    const manifest = readManifest();
    for (const [slug, config] of Object.entries(manifest.skills) as [string, any][]) {
      for (const p of config.pathPatterns) {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
      }
    }
  });

  test("manifest bashPatterns contain only strings", () => {
    const manifest = readManifest();
    for (const [slug, config] of Object.entries(manifest.skills) as [string, any][]) {
      for (const p of config.bashPatterns) {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
      }
    }
  });

  test("well-known skills are present in manifest", () => {
    const manifest = readManifest();
    const slugs = Object.keys(manifest.skills);
    // These skills should always exist
    expect(slugs).toContain("nextjs");
    expect(slugs).toContain("vercel-cli");
    expect(slugs).toContain("ai-sdk");
  });

  test("nextjs skill has expected path patterns", () => {
    const manifest = readManifest();
    const nextjs = manifest.skills["nextjs"];
    expect(nextjs).toBeDefined();
    const patterns = nextjs.pathPatterns;
    // Should match next.config files
    expect(patterns.some((p: string) => p.includes("next.config"))).toBe(true);
  });
});

describe("manifest-backed hook loading", () => {
  test("hook uses manifest when present and still matches skills", async () => {
    // Ensure manifest exists
    expect(existsSync(MANIFEST_PATH)).toBe(true);

    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "next.config.ts" },
    });
    expect(code).toBe(0);

    const output = JSON.parse(stdout);
    expect(output).toHaveProperty("hookSpecificOutput");
    expect(output.hookSpecificOutput).toHaveProperty("additionalContext");
    const ctx = output.hookSpecificOutput?.additionalContext || "";
    const siMatch = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
    expect(siMatch).not.toBeNull();
    const si = JSON.parse(siMatch![1]);
    expect(si.injectedSkills).toContain("nextjs");
  });

  test("hook produces same matches with and without manifest", async () => {
    // Run with manifest
    const withManifest = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "middleware.ts" },
    });
    expect(withManifest.code).toBe(0);
    const withOutput = JSON.parse(withManifest.stdout);

    // Temporarily rename manifest
    const backupPath = MANIFEST_PATH + ".bak";
    const { renameSync } = await import("node:fs");
    renameSync(MANIFEST_PATH, backupPath);

    try {
      const withoutManifest = await runHook({
        tool_name: "Read",
        tool_input: { file_path: "middleware.ts" },
      });
      expect(withoutManifest.code).toBe(0);
      const withoutOutput = JSON.parse(withoutManifest.stdout);

      // Both should inject the same skills
      const withCtx = withOutput.hookSpecificOutput?.additionalContext || "";
      const withMatch = withCtx.match(/<!-- skillInjection: (\{.*?\}) -->/);
      const withSkills = withMatch ? JSON.parse(withMatch[1]).injectedSkills ?? [] : [];
      const withoutCtx = withoutOutput.hookSpecificOutput?.additionalContext || "";
      const withoutMatch = withoutCtx.match(/<!-- skillInjection: (\{.*?\}) -->/);
      const withoutSkills = withoutMatch ? JSON.parse(withoutMatch[1]).injectedSkills ?? [] : [];
      expect(withSkills.sort()).toEqual(withoutSkills.sort());
    } finally {
      // Restore manifest
      renameSync(backupPath, MANIFEST_PATH);
    }
  });
});

describe("loadSkills pipeline stage", () => {
  test("loadSkills returns compiledSkills from manifest", async () => {
    const { loadSkills } = await import("../hooks/pretooluse-skill-inject.mjs");
    const result = loadSkills(ROOT);
    expect(result).not.toBeNull();
    expect(result.usedManifest).toBe(true);
    expect(Array.isArray(result.compiledSkills)).toBe(true);
    expect(result.compiledSkills.length).toBe(countSkillDirs());

    // Each compiled skill should have paired pattern+regex arrays
    for (const entry of result.compiledSkills) {
      expect(typeof entry.skill).toBe("string");
      expect(typeof entry.priority).toBe("number");
      expect(Array.isArray(entry.compiledPaths)).toBe(true);
      expect(Array.isArray(entry.compiledBash)).toBe(true);
      // Each pair should have a pattern string and RegExp instance
      for (const cp of entry.compiledPaths) {
        expect(typeof cp.pattern).toBe("string");
        expect(cp.regex).toBeInstanceOf(RegExp);
      }
      for (const cp of entry.compiledBash) {
        expect(typeof cp.pattern).toBe("string");
        expect(cp.regex).toBeInstanceOf(RegExp);
      }
    }
  });

  test("loadSkills falls back to live scan when manifest is absent", async () => {
    const { renameSync } = await import("node:fs");
    const backupPath = MANIFEST_PATH + ".bak";
    renameSync(MANIFEST_PATH, backupPath);

    try {
      // Need fresh import to avoid caching
      const hookPath = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
      const mod = await import(hookPath + `?t=${Date.now()}`);
      const result = mod.loadSkills(ROOT);
      expect(result).not.toBeNull();
      expect(result.usedManifest).toBe(false);
      expect(Array.isArray(result.compiledSkills)).toBe(true);
      expect(result.compiledSkills.length).toBe(countSkillDirs());
    } finally {
      renameSync(backupPath, MANIFEST_PATH);
    }
  });
});

describe("manifest with temp directory", () => {
  const TMP = join(tmpdir(), `build-manifest-test-${Date.now()}`);
  const SKILLS = join(TMP, "skills");
  const GEN = join(TMP, "generated");
  const HOOKS = join(TMP, "hooks");

  beforeAll(() => {
    mkdirSync(SKILLS, { recursive: true });
    mkdirSync(GEN, { recursive: true });
    mkdirSync(HOOKS, { recursive: true });

    // Create a minimal skill
    const skillDir = join(SKILLS, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: Test Skill
description: A test skill
metadata:
  priority: 7
  pathPatterns:
    - "test/**/*.ts"
  bashPatterns:
    - "\\\\btest\\\\b"
---
# Test Skill
This is test content.
`);

    // Copy hook modules
    const hookFiles = [
      "pretooluse-skill-inject.mjs",
      "skill-map-frontmatter.mjs",
      "patterns.mjs",
      "vercel-config.mjs",
      "logger.mjs",
      "hook-env.mjs",
    ];
    for (const f of hookFiles) {
      const src = join(ROOT, "hooks", f);
      if (existsSync(src)) {
        writeFileSync(join(HOOKS, f), readFileSync(src, "utf-8"));
      }
    }
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("loadSkills works without manifest (live scan)", async () => {
    const hookPath = join(HOOKS, "pretooluse-skill-inject.mjs");
    const mod = await import(hookPath + `?t=${Date.now()}`);
    const result = mod.loadSkills(TMP);
    expect(result).not.toBeNull();
    expect(result.usedManifest).toBe(false);
    expect(result.compiledSkills.length).toBe(1);
    expect(result.compiledSkills[0].skill).toBe("test-skill");
    expect(result.compiledSkills[0].priority).toBe(7);
  });

  test("loadSkills prefers manifest when present", async () => {
    // Write a manifest
    const manifest = {
      generatedAt: new Date().toISOString(),
      skills: {
        "test-skill": {
          priority: 7,
          pathPatterns: ["test/**/*.ts"],
          bashPatterns: ["\\btest\\b"],
          bodyPath: "skills/test-skill/SKILL.md",
        },
      },
    };
    writeFileSync(join(GEN, "skill-manifest.json"), JSON.stringify(manifest));

    const hookPath = join(HOOKS, "pretooluse-skill-inject.mjs");
    const mod = await import(hookPath + `?t2=${Date.now()}`);
    const result = mod.loadSkills(TMP);
    expect(result).not.toBeNull();
    expect(result.usedManifest).toBe(true);
    expect(result.compiledSkills.length).toBe(1);
    expect(result.compiledSkills[0].skill).toBe("test-skill");
  });

  test("loadSkills falls back on corrupt manifest", async () => {
    writeFileSync(join(GEN, "skill-manifest.json"), "NOT JSON");

    const hookPath = join(HOOKS, "pretooluse-skill-inject.mjs");
    const mod = await import(hookPath + `?t3=${Date.now()}`);
    const result = mod.loadSkills(TMP);
    expect(result).not.toBeNull();
    expect(result.usedManifest).toBe(false);
    expect(result.compiledSkills.length).toBe(1);
  });

  test("loadSkills falls back on manifest without skills key", async () => {
    writeFileSync(join(GEN, "skill-manifest.json"), JSON.stringify({ generatedAt: "x" }));

    const hookPath = join(HOOKS, "pretooluse-skill-inject.mjs");
    const mod = await import(hookPath + `?t4=${Date.now()}`);
    const result = mod.loadSkills(TMP);
    expect(result).not.toBeNull();
    expect(result.usedManifest).toBe(false);
  });
});
