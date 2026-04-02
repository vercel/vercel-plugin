import { describe, expect, test } from "bun:test";
import {
  buildProjectSkillInstallCommand,
  buildSkillCacheBanner,
  buildSkillCacheStatus,
} from "./src/skill-cache-banner.mts";
import { resolveProjectStatePaths } from "./src/project-state-paths.mts";

describe("buildSkillCacheStatus", () => {
  test("sorts and deduplicates likelySkills and installedSkills", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["shadcn", "ai-sdk", "nextjs", "ai-sdk"],
      installedSkills: ["nextjs", "nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.likelySkills).toEqual(["ai-sdk", "nextjs", "shadcn"]);
    expect(status.installedSkills).toEqual(["nextjs"]);
    expect(status.missingSkills).toEqual(["ai-sdk", "shadcn"]);
    expect(status.extraInstalledSkills).toEqual([]);
  });

  test("computes extraInstalledSkills for skills not in likelySkills", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs", "turborepo"],
      bundledFallbackEnabled: false,
    });
    expect(status.extraInstalledSkills).toEqual(["turborepo"]);
    expect(status.missingSkills).toEqual([]);
  });

  test("zeroBundleReady is true when all likely skills are installed", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs", "ai-sdk"],
      installedSkills: ["ai-sdk", "nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.zeroBundleReady).toBe(true);
    expect(status.missingSkills).toEqual([]);
  });

  test("zeroBundleReady is false when skills are missing", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs", "ai-sdk"],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.zeroBundleReady).toBe(false);
  });

  test("zeroBundleReady is false when no likely skills", () => {
    const status = buildSkillCacheStatus({
      likelySkills: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
    });
    expect(status.zeroBundleReady).toBe(false);
  });

  test("filters empty strings and whitespace from inputs", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs", "", "  ", "ai-sdk"],
      installedSkills: ["", "nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.likelySkills).toEqual(["ai-sdk", "nextjs"]);
    expect(status.installedSkills).toEqual(["nextjs"]);
    expect(status.missingSkills).toEqual(["ai-sdk"]);
  });

  test("handles undefined installedSkills", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });
    expect(status.installedSkills).toEqual([]);
    expect(status.missingSkills).toEqual(["nextjs"]);
  });
});

describe("buildProjectSkillInstallCommand", () => {
  test("returns null for no missing skills", () => {
    expect(buildProjectSkillInstallCommand({ missingSkills: [] })).toBeNull();
  });

  test("returns sorted npx skills add command for missing skills", () => {
    expect(buildProjectSkillInstallCommand({ missingSkills: ["shadcn", "ai-sdk"] })).toBe(
      "npx skills add vercel/vercel-skills --skill ai-sdk --skill shadcn --agent claude-code -y --copy",
    );
  });

  test("deduplicates missing skills", () => {
    expect(
      buildProjectSkillInstallCommand({ missingSkills: ["ai-sdk", "ai-sdk", "shadcn"] }),
    ).toBe("npx skills add vercel/vercel-skills --skill ai-sdk --skill shadcn --agent claude-code -y --copy");
  });

  test("uses custom source when provided", () => {
    expect(
      buildProjectSkillInstallCommand({ missingSkills: ["ai-sdk"], skillsSource: "my-org/skills" }),
    ).toBe("npx skills add my-org/skills --skill ai-sdk --agent claude-code -y --copy");
  });
});

describe("buildSkillCacheBanner", () => {
  test("returns null when no likely skills", () => {
    const status = buildSkillCacheStatus({
      likelySkills: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
    });
    expect(
      buildSkillCacheBanner({ ...status, projectRoot: "/work/app" }),
    ).toBeNull();
  });

  test("returns ready banner when nothing is missing", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["ai-sdk", "nextjs"],
      bundledFallbackEnabled: true,
    });
    const banner = buildSkillCacheBanner({
      ...status,
      projectRoot: "/work/app",
    });
    expect(banner).toContain("Status: ready");
    expect(banner).toContain("Detected: ai-sdk, nextjs");
    expect(banner).toContain("Cached: ai-sdk, nextjs");
    expect(banner).not.toContain("Missing:");
  });

  test("shows extra cached skills in ready banner", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs", "turborepo"],
      bundledFallbackEnabled: true,
    });
    const banner = buildSkillCacheBanner({
      ...status,
      projectRoot: "/work/app",
    });
    expect(banner).toContain("Status: ready");
    expect(banner).toContain("Also cached: turborepo");
  });

  test("returns incomplete banner with bundled fallback enabled", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["ai-sdk", "nextjs", "shadcn"],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });
    const banner = buildSkillCacheBanner({
      ...status,
      projectRoot: "/work/app",
    });
    expect(banner).toContain(
      "Status: incomplete cache — summary-only injection from rules manifest until cached",
    );
    expect(banner).toContain("Detected: ai-sdk, nextjs, shadcn");
    expect(banner).toContain("Cached: nextjs");
    expect(banner).toContain("Missing: ai-sdk, shadcn");
    expect(banner).toContain(`Project cache: ${resolveProjectStatePaths("/work/app").skillsDir}`);
    expect(banner).toContain(
      'Ask once: "I detected Vercel skills for ai-sdk, shadcn. Want me to install them into this project\'s skill cache?"',
    );
    expect(banner).toContain(
      "Install: `npx skills add vercel/vercel-skills --skill ai-sdk --skill shadcn --agent claude-code -y --copy`",
    );
  });

  test("returns incomplete banner with bundled fallback disabled", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: [],
      bundledFallbackEnabled: false,
    });
    const banner = buildSkillCacheBanner({
      ...status,
      projectRoot: "/tmp/proj",
    });
    expect(banner).toContain(
      "Status: incomplete cache — summary-only injection from rules manifest until cached",
    );
    expect(banner).toContain("Cached: none");
    expect(banner).toContain("Missing: ai-sdk, nextjs");
  });

  test("full sample output matches expected format", () => {
    const status = buildSkillCacheStatus({
      likelySkills: ["nextjs", "ai-sdk", "shadcn"],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
    });
    const banner = buildSkillCacheBanner({
      ...status,
      projectRoot: "/work/app",
    });
    expect(banner).toBe(
      [
        "### Vercel skill cache",
        "- Status: incomplete cache — summary-only injection from rules manifest until cached",
        "- Detected: ai-sdk, nextjs, shadcn",
        "- Cached: nextjs",
        "- Missing: ai-sdk, shadcn",
        `- Project cache: ${resolveProjectStatePaths("/work/app").skillsDir}`,
        '- Ask once: "I detected Vercel skills for ai-sdk, shadcn. Want me to install them into this project\'s skill cache?"',
        "- Install: `npx skills add vercel/vercel-skills --skill ai-sdk --skill shadcn --agent claude-code -y --copy`",
      ].join("\n"),
    );
  });
});
