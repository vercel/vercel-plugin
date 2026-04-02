import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Module paths (resolved to .mjs compiled outputs)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_STORE_MODULE = resolve(ROOT, "hooks", "src", "skill-store.mjs");
const PROJECT_MANIFEST_MODULE = resolve(
  ROOT,
  "hooks",
  "src",
  "project-skill-manifest.mjs",
);
const LOADER_MODULE = resolve(
  ROOT,
  "hooks",
  "src",
  "project-installed-skill-state.mts",
);

// ---------------------------------------------------------------------------
// Helpers — mock the two dependencies
// ---------------------------------------------------------------------------

function setupMocks(args: {
  storeInstalled: string[];
  projectInstalledSlugs: string[];
}) {
  mock.module(SKILL_STORE_MODULE, () => ({
    createSkillStore: () => ({
      listInstalledSkills: () => [...args.storeInstalled],
      resolveSkill: () => null,
      resolveSkillContent: () => null,
    }),
  }));

  mock.module(PROJECT_MANIFEST_MODULE, () => ({
    readProjectSkillState: () => ({
      projectSkillStatePath: "/repo/skills-lock.json",
      source: "skills-lock.json",
      installedSlugs: [...args.projectInstalledSlugs],
      skillsDir: "/repo/.skills",
      lockVersion: 1,
    }),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadProjectInstalledSkillState — lockfile-canonical readback", () => {
  test("lockfile-only install is included when store is empty", async () => {
    setupMocks({
      storeInstalled: [],
      projectInstalledSlugs: ["nextjs"],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-1`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["nextjs"]);
    expect(state.cacheStatus.missingSkills).toEqual([]);
  });

  test("store-only install is preserved when lockfile is empty", async () => {
    setupMocks({
      storeInstalled: ["react-best-practices"],
      projectInstalledSlugs: [],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-2`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: ["react-best-practices"],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["react-best-practices"]);
    expect(state.cacheStatus.missingSkills).toEqual([]);
  });

  test("union of store and lockfile is sorted and deduplicated", async () => {
    setupMocks({
      storeInstalled: ["nextjs", "ai-sdk"],
      projectInstalledSlugs: ["nextjs", "blob-storage"],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-3`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: ["nextjs", "ai-sdk", "blob-storage"],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["ai-sdk", "blob-storage", "nextjs"]);
    expect(state.cacheStatus.missingSkills).toEqual([]);
  });

  test("missing skills computed correctly against union", async () => {
    setupMocks({
      storeInstalled: ["ai-sdk"],
      projectInstalledSlugs: ["nextjs"],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-4`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: ["nextjs", "ai-sdk", "blob-storage"],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["ai-sdk", "nextjs"]);
    expect(state.cacheStatus.missingSkills).toEqual(["blob-storage"]);
  });

  test("empty strings and whitespace are filtered out", async () => {
    setupMocks({
      storeInstalled: ["nextjs", "", "  "],
      projectInstalledSlugs: ["", "ai-sdk"],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-5`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: [],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["ai-sdk", "nextjs"]);
  });

  test("canonicalizes registry alias slugs from lockfile state", async () => {
    setupMocks({
      storeInstalled: ["next-best-practices"],
      projectInstalledSlugs: ["vercel-react-best-practices"],
    });

    const mod = await import(`${LOADER_MODULE}?t=${Date.now()}-6`);
    const state = mod.loadProjectInstalledSkillState({
      projectRoot: "/repo",
      pluginRoot: "/plugin",
      likelySkills: ["nextjs", "react-best-practices"],
      bundledFallbackEnabled: true,
    });

    expect(state.installedSkills).toEqual(["nextjs", "react-best-practices"]);
    expect(state.cacheStatus.missingSkills).toEqual([]);
  });
});
