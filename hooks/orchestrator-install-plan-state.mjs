// hooks/src/orchestrator-install-plan-state.mts
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pluginRoot, safeReadJson } from "./hook-env.mjs";
import {
  buildSkillInstallPlan
} from "./orchestrator-install-plan.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
function installPlanPath(projectRoot) {
  return join(projectRoot, ".skills", "install-plan.json");
}
function parseInstallPlan(raw) {
  if (!raw || raw.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function matchesProjectRoot(plan, projectRoot) {
  return plan?.projectRoot === projectRoot;
}
function planTimestamp(plan) {
  if (!plan) return -1;
  const value = Date.parse(plan.createdAt);
  return Number.isFinite(value) ? value : -1;
}
function readPersistedSkillInstallPlan(args) {
  const fromEnvCandidate = parseInstallPlan(args.rawEnvPlan ?? null);
  const fromEnv = matchesProjectRoot(fromEnvCandidate, args.projectRoot) ? fromEnvCandidate : null;
  const fromFileCandidate = safeReadJson(
    installPlanPath(args.projectRoot)
  );
  const fromFile = matchesProjectRoot(fromFileCandidate, args.projectRoot) ? fromFileCandidate : null;
  if (fromEnv && fromFile) {
    return planTimestamp(fromFile) >= planTimestamp(fromEnv) ? fromFile : fromEnv;
  }
  return fromFile ?? fromEnv;
}
function requirePersistedSkillInstallPlan(args) {
  const plan = readPersistedSkillInstallPlan(args);
  if (plan) {
    return plan;
  }
  throw new Error(
    `Missing install plan at ${installPlanPath(args.projectRoot)}. Run SessionStart first.`
  );
}
function writePersistedSkillInstallPlan(plan) {
  mkdirSync(join(plan.projectRoot, ".skills"), { recursive: true });
  writeFileSync(
    installPlanPath(plan.projectRoot),
    JSON.stringify(plan, null, 2) + "\n",
    "utf-8"
  );
}
function refreshPersistedSkillInstallPlan(args) {
  const bundledFallbackEnabled = process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1" && args.previousPlan.bundledFallbackEnabled;
  const installedState = loadProjectInstalledSkillState({
    projectRoot: args.projectRoot,
    pluginRoot: args.pluginRootOverride ?? pluginRoot(),
    likelySkills: args.previousPlan.likelySkills,
    bundledFallbackEnabled
  });
  const refreshed = buildSkillInstallPlan({
    projectRoot: args.projectRoot,
    detections: args.previousPlan.detections,
    installedSkills: installedState.installedSkills,
    bundledFallbackEnabled,
    zeroBundleReady: installedState.cacheStatus.zeroBundleReady,
    projectSkillManifestPath: installedState.projectState.projectSkillStatePath,
    vercelLinked: existsSync(join(args.projectRoot, ".vercel")),
    hasEnvLocal: existsSync(join(args.projectRoot, ".env.local"))
  });
  writePersistedSkillInstallPlan(refreshed);
  return refreshed;
}
export {
  installPlanPath,
  readPersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan,
  requirePersistedSkillInstallPlan,
  writePersistedSkillInstallPlan
};
