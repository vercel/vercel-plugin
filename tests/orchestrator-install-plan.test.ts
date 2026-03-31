import { describe, expect, test } from "bun:test";
import {
  buildSkillInstallPlan,
  formatSkillInstallPalette,
  serializeSkillInstallPlan,
  type SkillDetection,
  type SkillInstallPlan,
} from "../hooks/src/orchestrator-install-plan.mts";

const FIXED_NOW = () => new Date("2026-03-31T12:00:00.000Z");

function makeDetection(skill: string): SkillDetection {
  return {
    skill,
    reasons: [
      {
        kind: "dependency",
        source: skill,
        detail: `matched dependency ${skill}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildSkillInstallPlan
// ---------------------------------------------------------------------------

describe("buildSkillInstallPlan", () => {
  test("zeroBundleReady and projectSkillManifestPath appear in plan", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      projectSkillManifestPath: "/repo/.skills/manifest.json",
      now: FIXED_NOW,
    });

    expect(plan.zeroBundleReady).toBe(true);
    expect(plan.projectSkillManifestPath).toBe("/repo/.skills/manifest.json");
  });

  test("zeroBundleReady false when skills are missing", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs"), makeDetection("ai-sdk")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    expect(plan.zeroBundleReady).toBe(false);
    expect(plan.projectSkillManifestPath).toBeNull();
    expect(plan.missingSkills).toEqual(["ai-sdk"]);
  });

  test("projectSkillManifestPath defaults to null when omitted", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    expect(plan.projectSkillManifestPath).toBeNull();
  });

  test("activate-cache-only action has command when zeroBundleReady", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "activate-cache-only");
    expect(action).toBeDefined();
    expect(action!.command).toBe("export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1");
    expect(action!.default).toBe(true);
  });

  test("activate-cache-only action has null command when not ready", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs"), makeDetection("ai-sdk")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "activate-cache-only");
    expect(action).toBeDefined();
    expect(action!.command).toBeNull();
    expect(action!.default).toBe(false);
  });

  test("install-missing default is true when not zeroBundleReady", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "install-missing");
    expect(action!.default).toBe(true);
  });

  test("install-missing default is false when zeroBundleReady", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "install-missing");
    expect(action!.default).toBe(false);
  });

  test("no offline action — replaced by activate-cache-only", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const offlineAction = plan.actions.find((a) => (a.id as string) === "offline");
    expect(offlineAction).toBeUndefined();
  });

  test("actions include explain with cat command", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "explain");
    expect(action).toBeDefined();
    expect(action!.command).toBe("cat .skills/install-plan.json");
  });

  test("schemaVersion is 1", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    expect(plan.schemaVersion).toBe(1);
  });

  test("vercel-link action appears when project is not linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-link");
    expect(action).toBeDefined();
    expect(action!.command).toBe("vercel link --yes");
    expect(plan.vercelLinked).toBe(false);
  });

  test("vercel-link action absent when project is linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-link");
    expect(action).toBeUndefined();
    expect(plan.vercelLinked).toBe(true);
  });

  test("vercel-env-pull action with command when linked and no .env.local", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      hasEnvLocal: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-env-pull");
    expect(action).toBeDefined();
    expect(action!.command).toBe("vercel env pull --yes");
  });

  test("vercel-env-pull action has null command when not linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: false,
      hasEnvLocal: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-env-pull");
    expect(action).toBeDefined();
    expect(action!.command).toBeNull();
  });

  test("vercel-env-pull action absent when .env.local exists", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      hasEnvLocal: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-env-pull");
    expect(action).toBeUndefined();
  });

  test("vercel-deploy action with command when linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-deploy");
    expect(action).toBeDefined();
    expect(action!.command).toBe("vercel deploy");
  });

  test("vercel-deploy action has null command when not linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: false,
      now: FIXED_NOW,
    });

    const action = plan.actions.find((a) => a.id === "vercel-deploy");
    expect(action).toBeDefined();
    expect(action!.command).toBeNull();
  });

  test("vercelLinked and hasEnvLocal default to false when omitted", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    expect(plan.vercelLinked).toBe(false);
    expect(plan.hasEnvLocal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeSkillInstallPlan
// ---------------------------------------------------------------------------

describe("serializeSkillInstallPlan", () => {
  test("serialized JSON includes zeroBundleReady and projectSkillManifestPath", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      projectSkillManifestPath: "/repo/.skills/manifest.json",
      now: FIXED_NOW,
    });

    const json = serializeSkillInstallPlan(plan);
    const parsed = JSON.parse(json);

    expect(parsed.zeroBundleReady).toBe(true);
    expect(parsed.projectSkillManifestPath).toBe("/repo/.skills/manifest.json");
  });

  test("serialized JSON has null projectSkillManifestPath when not set", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const json = serializeSkillInstallPlan(plan);
    const parsed = JSON.parse(json);

    expect(parsed.projectSkillManifestPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatSkillInstallPalette
// ---------------------------------------------------------------------------

describe("formatSkillInstallPalette", () => {
  test("shows zero-bundle readiness and cache manifest", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      projectSkillManifestPath: "/repo/.skills/manifest.json",
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan);
    expect(palette).not.toBeNull();
    expect(palette).toContain("Zero-bundle ready: yes");
    expect(palette).toContain("Cache manifest: /repo/.skills/manifest.json");
  });

  test("shows zero-bundle not ready", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan);
    expect(palette).toContain("Zero-bundle ready: no");
    expect(palette).toContain("Cache manifest: none");
  });

  test("shows cache-only command when zeroBundleReady", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[2] Cache only: export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1");
  });

  test("omits cache-only line when not ready", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).not.toContain("[2] Cache only");
  });

  test("shows install command when skills are missing", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs"), makeDetection("ai-sdk")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[1] Install now: npx skills add vercel/vercel-skills --skill ai-sdk --agent claude-code -y --copy");
  });

  test("omits install line when all skills cached", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).not.toContain("[1] Install now");
  });

  test("always shows explain line", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[3] Explain: cat .skills/install-plan.json");
  });

  test("returns null for empty detections", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [],
      installedSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      now: FIXED_NOW,
    });

    expect(formatSkillInstallPalette(plan)).toBeNull();
  });

  test("shows detection reasons", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("Detection reasons:");
    expect(palette).toContain("nextjs: dependency:nextjs");
  });

  test("shows vercel link command when not linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[4] Link project: vercel link --yes");
  });

  test("shows env pull command when linked but no .env.local", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      hasEnvLocal: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[5] Pull env: vercel env pull --yes");
    // Should not show link since already linked
    expect(palette).not.toContain("[4] Link project");
  });

  test("shows deploy command when linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: true,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    expect(palette).toContain("[6] Deploy: vercel deploy");
  });

  test("omits deploy and env-pull commands when not linked", () => {
    const plan = buildSkillInstallPlan({
      projectRoot: "/repo",
      detections: [makeDetection("nextjs")],
      installedSkills: ["nextjs"],
      bundledFallbackEnabled: true,
      zeroBundleReady: true,
      vercelLinked: false,
      hasEnvLocal: false,
      now: FIXED_NOW,
    });

    const palette = formatSkillInstallPalette(plan)!;
    // Link should be shown
    expect(palette).toContain("[4] Link project: vercel link --yes");
    // Env pull / deploy have null commands so should not appear
    expect(palette).not.toContain("[5] Pull env");
    expect(palette).not.toContain("[6] Deploy");
  });
});
