import { afterAll, beforeEach, describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import type { InstallSkillsResult, RegistryClient } from "../hooks/src/registry-client.mts";
import { resolveProjectStatePaths } from "../hooks/project-state-paths.mjs";

const {
  buildSkillCacheStatus,
  buildSkillCacheBanner,
  buildProjectSkillInstallCommand,
  buildProjectSkillInstallQuestion,
  resolveSkillCacheBanner,
} = await import("../hooks/skill-cache-banner.mjs");

const TEST_HOME = join(tmpdir(), `vercel-plugin-skill-cache-banner-home-${Date.now()}`);

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  process.env.VERCEL_PLUGIN_HOME_DIR = TEST_HOME;
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.VERCEL_PLUGIN_HOME_DIR;
});

// ---------------------------------------------------------------------------
// buildSkillCacheStatus
// ---------------------------------------------------------------------------

describe("buildSkillCacheStatus", () => {
  test("all likely skills installed → zeroBundleReady", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["ai-sdk", "nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.missingSkills).toEqual([]);
    expect(status.zeroBundleReady).toBe(true);
  });

  test("some missing → zeroBundleReady false", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.missingSkills).toEqual(["ai-sdk"]);
    expect(status.zeroBundleReady).toBe(false);
  });

  test("extra installed skills detected", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs", "payments"],
      bundledFallbackEnabled: true,
    });
    expect(status.extraInstalledSkills).toEqual(["payments"]);
  });

  test("empty likely skills → zeroBundleReady false", () => {
    const status = buildSkillCacheStatus({
      likelySkills: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
    });
    expect(status.zeroBundleReady).toBe(false);
  });

  test("deduplicates and sorts inputs", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs", "ai-sdk", "nextjs"],
      installedSkills: ["ai-sdk", "ai-sdk"],
      bundledFallbackEnabled: false,
    });
    expect(status.likelySkills).toEqual(["ai-sdk", "nextjs"]);
    expect(status.installedSkills).toEqual(["ai-sdk"]);
  });
});

// ---------------------------------------------------------------------------
// buildSkillCacheBanner
// ---------------------------------------------------------------------------

describe("buildSkillCacheBanner", () => {
  test("returns null when no likely skills", () => {
    expect(
      buildSkillCacheBanner({
        likelySkills: [],
        installedSkills: [],
        missingSkills: [],
        extraInstalledSkills: [],
        bundledFallbackEnabled: true,
        zeroBundleReady: false,
        projectRoot: "/repo",
      }),
    ).toBeNull();
  });

  test("ready banner when all skills cached", () => {
    const banner = buildSkillCacheBanner({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["ai-sdk", "nextjs"],
      missingSkills: [],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      projectRoot: "/repo",
    });
    expect(banner).toContain("Status: ready");
    expect(banner).toContain("Detected: ai-sdk, nextjs");
    expect(banner).toContain("Cached: ai-sdk, nextjs");
    expect(banner).not.toContain("Missing:");
  });

  test("incomplete banner with summary-only fallback", () => {
    const banner = buildSkillCacheBanner({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["nextjs"],
      missingSkills: ["ai-sdk"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      projectRoot: "/repo",
    });
    expect(banner).toContain("summary-only injection from rules manifest until cached");
    expect(banner).toContain("Missing: ai-sdk");
    expect(banner).toContain("Install:");
  });

  test("incomplete banner without bundled fallback also shows summary-only", () => {
    const banner = buildSkillCacheBanner({
      likelySkills: ["ai-sdk"],
      installedSkills: [],
      missingSkills: ["ai-sdk"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: false,
      zeroBundleReady: false,
      projectRoot: "/repo",
    });
    expect(banner).toContain("summary-only injection from rules manifest until cached");
  });

  test("shows extra installed skills in ready banner", () => {
    const banner = buildSkillCacheBanner({
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs", "payments"],
      missingSkills: [],
      extraInstalledSkills: ["payments"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      projectRoot: "/repo",
    });
    expect(banner).toContain("Also cached: payments");
  });
});

// ---------------------------------------------------------------------------
// buildProjectSkillInstallCommand / Question
// ---------------------------------------------------------------------------

describe("buildProjectSkillInstallCommand", () => {
  test("returns null for empty missing list", () => {
    expect(buildProjectSkillInstallCommand({ missingSkills: [] })).toBeNull();
  });

  test("returns npx skills add command", () => {
    const cmd = buildProjectSkillInstallCommand({
      missingSkills: ["ai-sdk", "nextjs"],
    });
    expect(cmd).toContain("npx skills add");
    expect(cmd).toContain("--skill ai-sdk");
    expect(cmd).toContain("--skill nextjs");
    expect(cmd).toContain("--agent claude-code");
  });
});

describe("buildProjectSkillInstallQuestion", () => {
  test("returns null for empty list", () => {
    expect(buildProjectSkillInstallQuestion([])).toBeNull();
  });

  test("includes skill names", () => {
    const q = buildProjectSkillInstallQuestion(["ai-sdk", "nextjs"]);
    expect(q).toContain("ai-sdk");
    expect(q).toContain("nextjs");
    expect(q).toContain("Want me to install");
    expect(q).toContain("project's skill cache");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillCacheBanner
// ---------------------------------------------------------------------------

describe("resolveSkillCacheBanner", () => {
  test("suggestion-only when autoInstall is false", async () => {
    const result = await resolveSkillCacheBanner({
      projectRoot: "/repo",
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["nextjs"],
      missingSkills: ["ai-sdk"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      autoInstall: false,
    });
    expect(result.installResult).toBeNull();
    expect(result.status.missingSkills).toEqual(["ai-sdk"]);
    expect(result.banner).toContain("Missing: ai-sdk");
    expect(result.banner).toContain("Install:");
  });

  test("suggestion-only when autoInstall is undefined", async () => {
    const result = await resolveSkillCacheBanner({
      projectRoot: "/repo",
      likelySkills: ["ai-sdk"],
      installedSkills: [],
      missingSkills: ["ai-sdk"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
    });
    expect(result.installResult).toBeNull();
    expect(result.banner).toContain("Missing: ai-sdk");
  });

  test("no-op when nothing is missing even with autoInstall", async () => {
    const result = await resolveSkillCacheBanner({
      projectRoot: "/repo",
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs"],
      missingSkills: [],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      autoInstall: true,
    });
    expect(result.installResult).toBeNull();
    expect(result.banner).toContain("Status: ready");
  });

  test("auto-install success updates status via filesystem readback", async () => {
    // Create a temp project; the mock client writes to the default global state dir
    const projectDir = join(tmpdir(), `banner-auto-install-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    // Compute the actual state paths (uses ~/.vercel-plugin/ by default)
    const statePaths = resolveProjectStatePaths(projectDir);

    try {
      const mockClient: RegistryClient = {
        async installSkills(args) {
          // Simulate CLI writing skill files to the global state dir
          for (const skill of args.skillNames) {
            const dir = join(statePaths.skillsDir, skill);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, "SKILL.md"),
              `---\nname: ${skill}\n---\n# ${skill}\nInstalled.`,
            );
          }
          return {
            installed: args.skillNames,
            reused: [],
            missing: [],
            command: `npx skills add vercel/vercel-skills --skill ${args.skillNames.join(" --skill ")} --agent claude-code -y --copy`,
          };
        },
      };

      const result = await resolveSkillCacheBanner({
        projectRoot: projectDir,
        likelySkills: ["ai-sdk", "nextjs"],
        installedSkills: [],
        missingSkills: ["ai-sdk", "nextjs"],
        extraInstalledSkills: [],
        bundledFallbackEnabled: true,
        zeroBundleReady: false,
        autoInstall: true,
        registryClient: mockClient,
      });

      expect(result.installResult).not.toBeNull();
      expect(result.installResult!.installed).toEqual(["ai-sdk", "nextjs"]);
      expect(result.status.missingSkills).toEqual([]);
      expect(result.status.zeroBundleReady).toBe(true);
      expect(result.banner).toContain("Status: installed now");
      expect(result.outcome).toBe("installed");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(statePaths.stateRoot, { recursive: true, force: true });
    }
  });

  test("auto-install partial success reflects remaining missing", async () => {
    const projectDir = join(tmpdir(), `banner-partial-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    const statePaths = resolveProjectStatePaths(projectDir);

    try {
      const mockClient: RegistryClient = {
        async installSkills(args) {
          // Only install the first skill — write to global state dir
          const installed = args.skillNames.slice(0, 1);
          for (const skill of installed) {
            const dir = join(statePaths.skillsDir, skill);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, "SKILL.md"),
              `---\nname: ${skill}\n---\n# ${skill}`,
            );
          }
          return {
            installed,
            reused: [],
            missing: args.skillNames.slice(1),
            command: "npx skills add ...",
            commandCwd: null,
          };
        },
      };

      const result = await resolveSkillCacheBanner({
        projectRoot: projectDir,
        likelySkills: ["ai-sdk", "nextjs"],
        installedSkills: [],
        missingSkills: ["ai-sdk", "nextjs"],
        extraInstalledSkills: [],
        bundledFallbackEnabled: true,
        zeroBundleReady: false,
        autoInstall: true,
        registryClient: mockClient,
      });

      expect(result.installResult!.installed).toEqual(["ai-sdk"]);
      expect(result.status.installedSkills).toEqual(["ai-sdk"]);
      expect(result.status.missingSkills).toEqual(["nextjs"]);
      expect(result.banner).toContain("Missing: nextjs");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(statePaths.stateRoot, { recursive: true, force: true });
    }
  });

  test("auto-install failure falls back to suggestion-only banner", async () => {
    const mockClient: RegistryClient = {
      async installSkills() {
        throw new Error("CLI timed out");
      },
    };

    const result = await resolveSkillCacheBanner({
      projectRoot: "/repo",
      likelySkills: ["ai-sdk"],
      installedSkills: [],
      missingSkills: ["ai-sdk"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      autoInstall: true,
      registryClient: mockClient,
    });

    // Should not crash, should return suggestion-only banner
    expect(result.installResult).toBeNull();
    expect(result.status.missingSkills).toEqual(["ai-sdk"]);
    expect(result.banner).toContain("Missing: ai-sdk");
    expect(result.banner).toContain("Install:");
  });

  test("auto-install timeout falls back gracefully", async () => {
    const mockClient: RegistryClient = {
      async installSkills() {
        throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    };

    const result = await resolveSkillCacheBanner({
      projectRoot: "/repo",
      likelySkills: ["nextjs"],
      installedSkills: [],
      missingSkills: ["nextjs"],
      extraInstalledSkills: [],
      bundledFallbackEnabled: false,
      zeroBundleReady: false,
      autoInstall: true,
      registryClient: mockClient,
    });

    expect(result.installResult).toBeNull();
    expect(result.banner).toContain("summary-only injection from rules manifest until cached");
  });
});
