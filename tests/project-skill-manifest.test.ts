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
  });

  test("returns 'none' when .skills/ is empty", () => {
    mkdirSync(SKILLS_DIR, { recursive: true });

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("none");
    expect(state.projectSkillStatePath).toBeNull();
    expect(state.installedSlugs).toEqual([]);
  });

  test("returns 'directory' when skills exist but no artifact files", () => {
    writeSkill("nextjs");
    writeSkill("ai-sdk");

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("directory");
    expect(state.projectSkillStatePath).toBe(resolve(PROJECT_ROOT, ".skills"));
    expect(state.installedSlugs).toEqual(["ai-sdk", "nextjs"]);
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
  });

  test("returns 'skills-lock.json' when lockfile exists (highest priority)", () => {
    writeSkill("nextjs");
    // Both lockfile and manifest exist — lockfile wins
    writeFileSync(
      join(SKILLS_DIR, "manifest.json"),
      JSON.stringify({ version: 2, skills: {} }),
      "utf-8",
    );
    writeFileSync(
      join(PROJECT_ROOT, "skills-lock.json"),
      JSON.stringify({ lockfileVersion: 1, skills: {} }),
      "utf-8",
    );

    const state = readProjectSkillState(PROJECT_ROOT);

    expect(state.source).toBe("skills-lock.json");
    expect(state.projectSkillStatePath).toBe(
      join(PROJECT_ROOT, "skills-lock.json"),
    );
    expect(state.installedSlugs).toEqual(["nextjs"]);
  });

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
