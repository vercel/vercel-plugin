import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globToRegex } from "../hooks/patterns.mjs";
import { createSkillStore } from "../hooks/src/skill-store.mts";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = join(tmpdir(), `vercel-plugin-skill-store-${Date.now()}`);
const PROJECT = join(TMP, "project");
const PROJECT_SKILLS = join(PROJECT, ".skills");
const GLOBAL = join(TMP, "global-skills");
const PLUGIN = join(TMP, "plugin");

function writeSkill(
  skillsRoot: string,
  slug: string,
  priority: number,
  pathPattern = "**/*.ts",
): void {
  mkdirSync(join(skillsRoot, slug), { recursive: true });
  writeFileSync(
    join(skillsRoot, slug, "SKILL.md"),
    `---
name: ${slug}
description: ${slug}
summary: ${slug} summary
metadata:
  priority: ${priority}
  pathPatterns:
    - "${pathPattern}"
---
# ${slug}

Use ${slug}.
`,
    "utf-8",
  );
}

function writeCacheManifest(
  skillsRoot: string,
  slug: string,
  priority: number,
  pathPattern = "**/*.ts",
): void {
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    skills: {
      [slug]: {
        priority,
        summary: `${slug} summary`,
        docs: [],
        pathPatterns: [pathPattern],
        bashPatterns: [],
        importPatterns: [],
        pathRegexSources: [globToRegex(pathPattern).source],
        bashRegexSources: [],
        importRegexSources: [],
      },
    },
  };
  writeFileSync(
    join(skillsRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(PROJECT_SKILLS, { recursive: true });
  mkdirSync(GLOBAL, { recursive: true });
  mkdirSync(join(PLUGIN, "skills"), { recursive: true });
  mkdirSync(join(PLUGIN, "generated"), { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("skill-store", () => {
  test("merges project, global, and bundled roots with project precedence", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");
    writeSkill(GLOBAL, "ai-sdk", 7, "app/api/**/*.ts");
    writeSkill(join(PLUGIN, "skills"), "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.skillMap).sort()).toEqual([
      "ai-sdk",
      "nextjs",
      "vercel-cli",
    ]);
    expect(store.resolveSkill("nextjs")!.priority).toBe(9);
    expect(store.resolveSkill("ai-sdk")!.priority).toBe(7);
    expect(store.resolveSkillBody("vercel-cli")!.source).toBe("bundled");
  });

  test("project-cache skill takes precedence over bundled with same slug", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 10, "app/**/*.tsx");
    writeSkill(join(PLUGIN, "skills"), "nextjs", 5, "pages/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    // Project cache (priority 10) wins over bundled (priority 5)
    expect(loaded!.skillMap["nextjs"].priority).toBe(10);
    expect(loaded!.origins["nextjs"].source).toBe("project-cache");
    expect(store.resolveSkillBody("nextjs")!.source).toBe("project-cache");
  });

  test("uses cache manifest when present", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");
    writeCacheManifest(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    expect(loaded!.usedManifest).toBe(true);
    expect(loaded!.compiledSkills.map((entry) => entry.skill)).toContain(
      "nextjs",
    );
  });

  test("listInstalledSkills excludes bundled fallback", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");
    writeSkill(GLOBAL, "ai-sdk", 7, "app/api/**/*.ts");
    writeSkill(join(PLUGIN, "skills"), "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    expect(store.listInstalledSkills()).toEqual(["ai-sdk", "nextjs"]);
  });

  test("returns null when no roots have skills", () => {
    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      bundledFallback: false,
    });

    expect(store.loadSkillSet()).toBeNull();
  });

  test("resolveSkillBody returns body without frontmatter", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const body = store.resolveSkillBody("nextjs");
    expect(body).not.toBeNull();
    expect(body!.body).toContain("# nextjs");
    expect(body!.body).not.toContain("---");
    expect(body!.source).toBe("project-cache");
  });

  test("resolveSkillBody returns null for non-existent skill", () => {
    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      bundledFallback: false,
    });

    expect(store.resolveSkillBody("non-existent")).toBeNull();
  });

  test("bundledFallback: false excludes bundled root", () => {
    writeSkill(join(PLUGIN, "skills"), "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      bundledFallback: false,
    });

    expect(store.loadSkillSet()).toBeNull();
    expect(store.roots.length).toBe(2);
    expect(store.roots.every((r) => r.source !== "bundled")).toBe(true);
  });

  test("compiled skills include correct regex patterns", () => {
    writeSkill(PROJECT_SKILLS, "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    const nextjsEntry = loaded!.compiledSkills.find(
      (e) => e.skill === "nextjs",
    );
    expect(nextjsEntry).toBeDefined();
    expect(nextjsEntry!.compiledPaths.length).toBeGreaterThan(0);
    expect(nextjsEntry!.compiledPaths[0].regex.test("app/page.tsx")).toBe(
      true,
    );
  });
});

describe("loadSkills with installed cache", () => {
  test("reads project-local .skills before bundled fallback", async () => {
    const projectDir = join(TMP, "loadskills-project");
    mkdirSync(join(projectDir, ".skills", "custom-skill"), {
      recursive: true,
    });
    writeFileSync(
      join(projectDir, ".skills", "custom-skill", "SKILL.md"),
      `---
name: custom-skill
description: Custom
summary: Custom summary
metadata:
  priority: 9
  pathPatterns:
    - "src/custom/**/*.ts"
---
# Custom skill

Use the custom skill.
`,
      "utf-8",
    );

    const { loadSkills } = await import(
      "../hooks/src/pretooluse-skill-inject.mts"
    );
    const loaded = loadSkills(ROOT, undefined, projectDir);
    expect(loaded).not.toBeNull();
    expect(
      loaded!.compiledSkills.map((entry: { skill: string }) => entry.skill),
    ).toContain("custom-skill");
    expect(loaded!.skillMap["custom-skill"].priority).toBe(9);
    expect(loaded!.skillStore).toBeDefined();
  });
});
