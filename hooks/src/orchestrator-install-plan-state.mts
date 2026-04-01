/**
 * Shared install-plan persistence — read, write, and refresh
 * `.skills/install-plan.json` from current on-disk project state.
 *
 * Used by session-start-profiler, orchestrator-action-runner, and
 * posttooluse-bash-chain so that the persisted plan is always the
 * single source of truth after any delegated CLI mutation.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pluginRoot, safeReadJson } from "./hook-env.mjs";
import {
  buildSkillInstallPlan,
  type SkillInstallPlan,
} from "./orchestrator-install-plan.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function installPlanPath(projectRoot: string): string {
  return join(projectRoot, ".skills", "install-plan.json");
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function parseInstallPlan(
  raw: string | null | undefined,
): SkillInstallPlan | null {
  if (!raw || raw.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(raw) as SkillInstallPlan;
  } catch {
    return null;
  }
}

function matchesProjectRoot(
  plan: SkillInstallPlan | null,
  projectRoot: string,
): plan is SkillInstallPlan {
  return plan?.projectRoot === projectRoot;
}

function planTimestamp(plan: SkillInstallPlan | null): number {
  if (!plan) return -1;
  const value = Date.parse(plan.createdAt);
  return Number.isFinite(value) ? value : -1;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the persisted install plan, preferring the newer of the env-var
 * snapshot and the on-disk file.  Returns `null` when neither exists.
 */
export function readPersistedSkillInstallPlan(args: {
  projectRoot: string;
  rawEnvPlan?: string | null;
}): SkillInstallPlan | null {
  const fromEnvCandidate = parseInstallPlan(args.rawEnvPlan ?? null);
  const fromEnv = matchesProjectRoot(fromEnvCandidate, args.projectRoot)
    ? fromEnvCandidate
    : null;
  const fromFileCandidate = safeReadJson<SkillInstallPlan>(
    installPlanPath(args.projectRoot),
  );
  const fromFile = matchesProjectRoot(fromFileCandidate, args.projectRoot)
    ? fromFileCandidate
    : null;
  if (fromEnv && fromFile) {
    return planTimestamp(fromFile) >= planTimestamp(fromEnv)
      ? fromFile
      : fromEnv;
  }
  return fromFile ?? fromEnv;
}

/**
 * Like `readPersistedSkillInstallPlan` but throws when no plan exists.
 */
export function requirePersistedSkillInstallPlan(args: {
  projectRoot: string;
  rawEnvPlan?: string | null;
}): SkillInstallPlan {
  const plan = readPersistedSkillInstallPlan(args);
  if (plan) {
    return plan;
  }
  throw new Error(
    `Missing install plan at ${installPlanPath(args.projectRoot)}. Run SessionStart first.`,
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writePersistedSkillInstallPlan(
  plan: SkillInstallPlan,
): void {
  mkdirSync(join(plan.projectRoot, ".skills"), { recursive: true });
  writeFileSync(
    installPlanPath(plan.projectRoot),
    JSON.stringify(plan, null, 2) + "\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Rebuild the install plan from current on-disk state (installed skills,
 * .vercel/, .env.local) and persist it.  Returns the refreshed plan.
 */
export function refreshPersistedSkillInstallPlan(args: {
  projectRoot: string;
  previousPlan: SkillInstallPlan;
  pluginRootOverride?: string;
}): SkillInstallPlan {
  const bundledFallbackEnabled =
    process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1" &&
    args.previousPlan.bundledFallbackEnabled;

  const installedState = loadProjectInstalledSkillState({
    projectRoot: args.projectRoot,
    pluginRoot: args.pluginRootOverride ?? pluginRoot(),
    likelySkills: args.previousPlan.likelySkills,
    bundledFallbackEnabled,
  });

  const refreshed = buildSkillInstallPlan({
    projectRoot: args.projectRoot,
    detections: args.previousPlan.detections,
    installedSkills: installedState.installedSkills,
    bundledFallbackEnabled,
    zeroBundleReady: installedState.cacheStatus.zeroBundleReady,
    projectSkillManifestPath:
      installedState.projectState.projectSkillStatePath,
    vercelLinked: existsSync(join(args.projectRoot, ".vercel")),
    hasEnvLocal: existsSync(join(args.projectRoot, ".env.local")),
  });

  writePersistedSkillInstallPlan(refreshed);
  return refreshed;
}
