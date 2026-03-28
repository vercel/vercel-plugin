import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import {
  EXCLUDED_SKILL_PATTERN,
  getSkillExclusion,
  filterExcludedSkillMap,
} from "../src/shared/skill-exclusion-policy.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = join(ROOT, "generated", "skill-manifest.json");
const CLI = join(ROOT, "src", "cli", "index.ts");

function readManifest(): any {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Unit tests for the shared policy module
// ---------------------------------------------------------------------------

describe("skill-exclusion-policy", () => {
  test("EXCLUDED_SKILL_PATTERN matches test-only slugs", () => {
    expect(EXCLUDED_SKILL_PATTERN.test("fake-banned-test-skill")).toBe(true);
    expect(EXCLUDED_SKILL_PATTERN.test("fake-something")).toBe(true);
  });

  test("EXCLUDED_SKILL_PATTERN rejects production slugs", () => {
    expect(EXCLUDED_SKILL_PATTERN.test("nextjs")).toBe(false);
    expect(EXCLUDED_SKILL_PATTERN.test("vercel-cli")).toBe(false);
    expect(EXCLUDED_SKILL_PATTERN.test("ai-sdk")).toBe(false);
  });

  test("getSkillExclusion returns exclusion record for test slugs", () => {
    const result = getSkillExclusion("fake-banned-test-skill");
    expect(result).toEqual({
      slug: "fake-banned-test-skill",
      reason: "test-only-pattern",
    });
  });

  test("getSkillExclusion returns null for production slugs", () => {
    expect(getSkillExclusion("nextjs")).toBeNull();
    expect(getSkillExclusion("vercel-cli")).toBeNull();
  });

  test("filterExcludedSkillMap partitions correctly", () => {
    const input = {
      nextjs: { priority: 6 },
      "fake-banned-test-skill": { priority: 1 },
      "ai-sdk": { priority: 5 },
    };

    const { included, excluded } = filterExcludedSkillMap(input);

    expect(Object.keys(included)).toEqual(["nextjs", "ai-sdk"]);
    expect(included).not.toHaveProperty("fake-banned-test-skill");
    expect(excluded).toEqual([
      { slug: "fake-banned-test-skill", reason: "test-only-pattern" },
    ]);
  });

  test("filterExcludedSkillMap sorts excluded entries by slug", () => {
    const input = {
      "fake-z": { priority: 1 },
      "fake-a": { priority: 1 },
      nextjs: { priority: 6 },
    };

    const { excluded } = filterExcludedSkillMap(input);
    expect(excluded.map((e) => e.slug)).toEqual(["fake-a", "fake-z"]);
  });
});

// ---------------------------------------------------------------------------
// Manifest integration: excludedSkills provenance
// ---------------------------------------------------------------------------

describe("manifest excludedSkills provenance", () => {
  test("manifest contains excludedSkills array with provenance", () => {
    const manifest = readManifest();
    expect(manifest.excludedSkills).toEqual([
      { slug: "fake-banned-test-skill", reason: "test-only-pattern" },
    ]);
  });

  test("excluded skills are absent from manifest.skills", () => {
    const manifest = readManifest();
    expect(manifest.skills).not.toHaveProperty("fake-banned-test-skill");
  });

  test("test fixture still exists on disk", () => {
    expect(
      existsSync(join(ROOT, "skills", "fake-banned-test-skill", "SKILL.md")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI explain: excluded skills never surface as runtime candidates
// ---------------------------------------------------------------------------

describe("explain excludes test-only skills", () => {
  test("fake-banned-test-skill does not appear as a match in JSON mode", async () => {
    // fake-banned-test-skill has pathPatterns — but it must not surface
    const { stdout, exitCode } = await runCli(
      "explain",
      "some-test-file.ts",
      "--json",
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    const matchedSlugs = (result.matches ?? []).map(
      (m: any) => m.skill,
    );
    expect(matchedSlugs).not.toContain("fake-banned-test-skill");
  });
});

// ---------------------------------------------------------------------------
// Doctor: excluded skills do not cause false parity errors
// ---------------------------------------------------------------------------

describe("doctor respects exclusion policy", () => {
  test("doctor does not report fake-banned-test-skill as a parity error", async () => {
    const { stdout, exitCode } = await runCli("doctor", "--json");
    // doctor exits 0 or 1 depending on other issues, but check the
    // parity-related issues specifically
    const result = JSON.parse(stdout);
    const parityIssues = (result.issues ?? []).filter(
      (i: any) => i.check === "manifest-parity",
    );
    const mentionsFake = parityIssues.some(
      (i: any) =>
        i.message.includes("fake-banned-test-skill"),
    );
    expect(mentionsFake).toBe(false);
  });
});
