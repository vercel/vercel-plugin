import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProjectSkillState } from "../hooks/src/project-skill-manifest.mts";

const TMP = join(tmpdir(), `vercel-plugin-project-state-${Date.now()}`);
const PROJECT_ROOT = TMP;
const SKILLS_DIR = join(TMP, ".skills");

function writeSkill(slug: string, body = `# ${slug}\n\nUse ${slug}.`): void {
  const dir = join(SKILLS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
}

function writeLockfile(
  content: Record<string, unknown>,
  path = join(PROJECT_ROOT, "skills-lock.json"),
): void {
  writeFileSync(path, JSON.stringify(content), "utf-8");
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readProjectSkillState
// ---------------------------------------------------------------------------

describe("readProjectSkillState", () => {
  test("returns 'none' when .skills/ does not exist", () => {
    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("none");
    expect(state.projectSkillStatePath).toBeNull();
    expect(state.installedSlugs).toEqual([]);
    expect(state.skillsDir).toBe(resolve(PROJECT_ROOT, ".skills"));
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("returns 'none' when .skills/ is empty", () => {
    mkdirSync(SKILLS_DIR, { recursive: true });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("none");
    expect(state.projectSkillStatePath).toBeNull();
    expect(state.installedSlugs).toEqual([]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("returns 'directory' when skills exist but no artifact files", () => {
    writeSkill("nextjs");
    writeSkill("ai-sdk");

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("directory");
    expect(state.projectSkillStatePath).toBe(resolve(PROJECT_ROOT, ".skills"));
    expect(state.installedSlugs).toEqual(["ai-sdk", "nextjs"]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("returns 'manifest.json' when .skills/manifest.json exists", () => {
    writeSkill("nextjs");
    writeFileSync(
      join(SKILLS_DIR, "manifest.json"),
      JSON.stringify({ version: 2, skills: {} }),
      "utf-8",
    );

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("manifest.json");
    expect(state.projectSkillStatePath).toBe(join(SKILLS_DIR, "manifest.json"));
    expect(state.installedSlugs).toEqual(["nextjs"]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Lockfile precedence and canonical slug derivation
  // -------------------------------------------------------------------------

  test("returns 'skills-lock.json' when lockfile exists (highest priority)", () => {
    writeSkill("nextjs");
    // Both lockfile and manifest exist — lockfile wins
    writeFileSync(
      join(SKILLS_DIR, "manifest.json"),
      JSON.stringify({ version: 2, skills: {} }),
      "utf-8",
    );
    writeLockfile({
      version: 3,
      skills: {
        nextjs: {
          source: "vercel/vercel-skills",
          sourceType: "github",
          skillPath: "skills/nextjs/SKILL.md",
          skillFolderHash: "abc123",
        },
        "ai-sdk": {
          source: "vercel/vercel-skills",
          sourceType: "github",
          skillPath: "skills/ai-sdk/SKILL.md",
          skillFolderHash: "def456",
        },
      },
    });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    expect(state.projectSkillStatePath).toBe(
      join(PROJECT_ROOT, "skills-lock.json"),
    );
    // Canonical: slugs come from lockfile keys, sorted
    expect(state.installedSlugs).toEqual(["ai-sdk", "nextjs"]);
    expect(state.lockVersion).toBe(3);
    expect(state.lockSkills).toEqual({
      nextjs: expect.objectContaining({ source: "vercel/vercel-skills" }),
      "ai-sdk": expect.objectContaining({ source: "vercel/vercel-skills" }),
    });
  });

  test("lockfile keys are canonical even when directory has different skills", () => {
    // Directory has nextjs + payments, but lockfile only lists nextjs + ai-sdk
    writeSkill("nextjs");
    writeSkill("payments");
    writeLockfile({
      version: 1,
      skills: {
        nextjs: { source: "vercel/vercel-skills" },
        "ai-sdk": { source: "vercel/vercel-skills" },
      },
    });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    // Slugs come from lockfile, not directory
    expect(state.installedSlugs).toEqual(["ai-sdk", "nextjs"]);
    expect(state.lockVersion).toBe(1);
  });

  test("lockfile with empty skills record falls back to directory scan for slugs", () => {
    writeSkill("nextjs");
    writeLockfile({ version: 2, skills: {} });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    // Empty lockfile skills → fall back to directory scan
    expect(state.installedSlugs).toEqual(["nextjs"]);
    expect(state.lockVersion).toBe(2);
    expect(state.lockSkills).toEqual({});
  });

  test("malformed lockfile (no skills key) falls back to directory scan", () => {
    writeSkill("nextjs");
    writeLockfile({ version: 1 }); // missing skills key

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    // Malformed lock → fall back to directory scan for slugs
    expect(state.installedSlugs).toEqual(["nextjs"]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("malformed lockfile (skills is array) falls back to directory scan", () => {
    writeSkill("ai-sdk");
    writeLockfile({ version: 1, skills: ["ai-sdk"] });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    expect(state.installedSlugs).toEqual(["ai-sdk"]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("malformed lockfile (not valid JSON) falls back to directory scan", () => {
    writeSkill("nextjs");
    writeFileSync(
      join(PROJECT_ROOT, "skills-lock.json"),
      "not valid json",
      "utf-8",
    );

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    expect(state.installedSlugs).toEqual(["nextjs"]);
    expect(state.lockVersion).toBeNull();
    expect(state.lockSkills).toEqual({});
  });

  test("lockfile filters out empty-key and null-entry skills", () => {
    writeLockfile({
      version: 3,
      skills: {
        nextjs: { source: "vercel/vercel-skills" },
        "": { source: "bad" },
        "ai-sdk": null,
        zod: { source: "vercel/vercel-skills" },
      },
    });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.installedSlugs).toEqual(["nextjs", "zod"]);
    expect(state.lockSkills).toEqual({
      nextjs: expect.objectContaining({ source: "vercel/vercel-skills" }),
      zod: expect.objectContaining({ source: "vercel/vercel-skills" }),
    });
  });

  test("lockVersion is null when version field is not a number", () => {
    writeLockfile({ version: "latest", skills: { nextjs: {} } });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.lockVersion).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Pre-existing tests
  // -------------------------------------------------------------------------

  test("ignores subdirectories without SKILL.md", () => {
    writeSkill("nextjs");
    // Create a directory without SKILL.md — should be ignored
    mkdirSync(join(SKILLS_DIR, "not-a-skill"), { recursive: true });
    writeFileSync(join(SKILLS_DIR, "not-a-skill", "README.md"), "# Not a skill", "utf-8");

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.installedSlugs).toEqual(["nextjs"]);
  });

  test("returns sorted slugs", () => {
    writeSkill("zod");
    writeSkill("ai-sdk");
    writeSkill("nextjs");

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.installedSlugs).toEqual(["ai-sdk", "nextjs", "zod"]);
  });

  test("skillsDir is always the resolved .skills/ path", () => {
    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.skillsDir).toBe(resolve(PROJECT_ROOT, ".skills"));
  });
});
