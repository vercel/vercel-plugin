import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globToRegex } from "../hooks/patterns.mjs";
import { createSkillStore } from "../hooks/src/skill-store.mts";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = join(tmpdir(), `vercel-plugin-skill-store-${Date.now()}`);
const HOME = join(TMP, "home");
const PROJECT = join(TMP, "project");
const GLOBAL = join(TMP, "global-skills");
const PLUGIN = join(TMP, "plugin");

function projectState() {
  return resolveProjectStatePaths(PROJECT);
}

function projectSkillsDir() {
  return projectState().skillsDir;
}

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

function writeRulesManifest(
  pluginRoot: string,
  slug: string,
  priority: number,
  pathPattern = "**/*.ts",
): void {
  const manifest = {
    version: 3,
    generatedAt: new Date().toISOString(),
    skills: {
      [slug]: {
        priority,
        summary: `${slug} summary`,
        docs: [`https://example.com/${slug}`],
        pathPatterns: [pathPattern],
        bashPatterns: [],
        importPatterns: [],
        pathRegexSources: [globToRegex(pathPattern).source],
        bashRegexSources: [],
        importRegexSources: [],
      },
    },
  };
  mkdirSync(join(pluginRoot, "generated"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "generated", "skill-rules.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(projectSkillsDir(), { recursive: true });
  mkdirSync(GLOBAL, { recursive: true });
  mkdirSync(join(PLUGIN, "generated"), { recursive: true });

  // Set home dir for project-state-paths resolution
  process.env.VERCEL_PLUGIN_HOME_DIR = HOME;
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.VERCEL_PLUGIN_HOME_DIR;
});

describe("skill-store", () => {
  test("project-cache root uses project .claude/skills path", () => {
    const state = projectState();
    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
    });
    expect(store.roots[0].rootDir).toBe(resolve(PROJECT));
    expect(store.roots[0].skillsDir).toBe(join(resolve(PROJECT), ".claude", "skills"));
    // Second project-cache root is the hashed state path
    expect(store.roots[1].rootDir).toBe(state.stateRoot);
    expect(store.roots[1].skillsDir).toBe(state.skillsDir);
  });

  test("merges project, global, and rules-manifest roots with project precedence", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");
    writeSkill(GLOBAL, "ai-sdk", 7, "app/api/**/*.ts");
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

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
  });

  test("project-cache skill takes precedence over rules-manifest with same slug", () => {
    writeSkill(projectSkillsDir(), "nextjs", 10, "app/**/*.tsx");
    writeRulesManifest(PLUGIN, "nextjs", 5, "pages/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    // Project cache (priority 10) wins over rules-manifest (priority 5)
    expect(loaded!.skillMap["nextjs"].priority).toBe(10);
    expect(loaded!.origins["nextjs"].source).toBe("project-cache");
    expect(store.resolveSkillBody("nextjs")!.source).toBe("project-cache");
  });

  test("falls back to lower-precedence compiled matchers when project manifest entry has none", () => {
    mkdirSync(join(projectSkillsDir(), "next-cache-components"), { recursive: true });
    writeFileSync(
      join(projectSkillsDir(), "next-cache-components", "SKILL.md"),
      `---
name: next-cache-components
description: next-cache-components
summary: next-cache-components summary
metadata:
  priority: 10
---
# next-cache-components

Use next-cache-components.
`,
      "utf-8",
    );
    writeFileSync(
      join(projectSkillsDir(), "manifest.json"),
      JSON.stringify(
        {
          version: 2,
          generatedAt: new Date().toISOString(),
          skills: {
            "next-cache-components": {
              priority: 10,
              summary: "next-cache-components summary",
              docs: [],
              pathPatterns: [],
              bashPatterns: [],
              importPatterns: [],
              pathRegexSources: [],
              bashRegexSources: [],
              importRegexSources: [],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeRulesManifest(PLUGIN, "next-cache-components", 5, "app/**");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    expect(loaded!.skillMap["next-cache-components"].priority).toBe(10);
    expect(loaded!.origins["next-cache-components"].source).toBe("project-cache");
    const entry = loaded!.compiledSkills.find((candidate) => candidate.skill === "next-cache-components");
    expect(entry).toBeDefined();
    expect(entry!.compiledPaths.length).toBeGreaterThan(0);
    expect(entry!.compiledPaths[0].regex.test("app/page.tsx")).toBe(true);
    expect(store.resolveSkillBody("next-cache-components")!.source).toBe("project-cache");
  });

  test("uses cache manifest when present", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");
    writeCacheManifest(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

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

  test("listInstalledSkills excludes rules-manifest fallback", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");
    writeSkill(GLOBAL, "ai-sdk", 7, "app/api/**/*.ts");
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

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
    });

    // rules-manifest has no skills file either, so all roots are empty
    expect(store.loadSkillSet()).toBeNull();
  });

  test("resolveSkillBody returns body without frontmatter", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

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
    });

    expect(store.resolveSkillBody("non-existent")).toBeNull();
  });

  test("rules-manifest root is included by default", () => {
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    expect(store.roots.length).toBe(4);
    expect(store.roots[3].source).toBe("rules-manifest");
    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    expect(loaded!.skillMap["vercel-cli"]).toBeDefined();
  });

  test("rules-manifest root excluded when includeRulesManifest is false", () => {
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      includeRulesManifest: false,
    });

    expect(store.roots.length).toBe(3);
    expect(store.roots.every((r) => r.source !== "rules-manifest")).toBe(true);
    // No cached skills exist, so loadSkillSet returns null
    expect(store.loadSkillSet()).toBeNull();
  });

  test("rules-manifest root excluded when VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1", () => {
    const prev = process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK;
    process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK = "1";
    try {
      writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

      const store = createSkillStore({
        projectRoot: PROJECT,
        pluginRoot: PLUGIN,
        globalCacheDir: GLOBAL,
      });

      expect(store.roots.length).toBe(3);
      expect(store.roots.every((r) => r.source !== "rules-manifest")).toBe(true);
      expect(store.loadSkillSet()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK;
      else process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK = prev;
    }
  });

  test("uncached skill not resolved when includeRulesManifest is false", () => {
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");
    // Put a real skill in project cache so loadSkillSet isn't null
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      includeRulesManifest: false,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    // nextjs is cached and should resolve
    expect(loaded!.skillMap["nextjs"]).toBeDefined();
    // vercel-cli is only in rules-manifest which is excluded
    expect(loaded!.skillMap["vercel-cli"]).toBeUndefined();
    expect(store.resolveSkillPayload("vercel-cli")).toBeNull();
  });

  test("uncached skill resolves to summary when includeRulesManifest is true", () => {
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
      includeRulesManifest: true,
    });

    const loaded = store.loadSkillSet();
    expect(loaded).not.toBeNull();
    expect(loaded!.skillMap["vercel-cli"]).toBeDefined();
    const payload = store.resolveSkillPayload("vercel-cli");
    expect(payload).not.toBeNull();
    expect(payload!.mode).toBe("summary");
    expect(payload!.source).toBe("rules-manifest");
  });

  test("resolveSkillPayload returns mode:body when cached body exists", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const payload = store.resolveSkillPayload("nextjs");
    expect(payload).not.toBeNull();
    expect(payload!.mode).toBe("body");
    expect(payload!.source).toBe("project-cache");
    expect(payload!.body).toContain("# nextjs");
    expect(payload!.path).toContain("SKILL.md");
    expect(payload!.summary).toBe("nextjs summary");
  });

  test("resolveSkillPayload returns mode:summary when only rules-manifest metadata exists", () => {
    writeRulesManifest(PLUGIN, "vercel-cli", 5, "vercel.json");

    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    const payload = store.resolveSkillPayload("vercel-cli");
    expect(payload).not.toBeNull();
    expect(payload!.mode).toBe("summary");
    expect(payload!.source).toBe("rules-manifest");
    expect(payload!.body).toBeNull();
    expect(payload!.path).toBeNull();
    expect(payload!.summary).toBe("vercel-cli summary");
    expect(payload!.docs).toEqual(["https://example.com/vercel-cli"]);
  });

  test("resolveSkillPayload returns null for unknown skill", () => {
    const store = createSkillStore({
      projectRoot: PROJECT,
      pluginRoot: PLUGIN,
      globalCacheDir: GLOBAL,
    });

    expect(store.resolveSkillPayload("non-existent")).toBeNull();
  });

  test("compiled skills include correct regex patterns", () => {
    writeSkill(projectSkillsDir(), "nextjs", 9, "app/**/*.tsx");

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
  test("reads project-local cache before rules-manifest fallback", async () => {
    const projectDir = join(TMP, "loadskills-project");
    const projectState = resolveProjectStatePaths(projectDir, HOME);
    mkdirSync(join(projectState.skillsDir, "custom-skill"), {
      recursive: true,
    });
    writeFileSync(
      join(projectState.skillsDir, "custom-skill", "SKILL.md"),
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
