// hooks/src/orchestrator-install-plan-state.mts
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { pluginRoot, safeReadJson } from "./hook-env.mjs";
import { logCaughtError } from "./logger.mjs";
import {
  buildSkillInstallPlan
} from "./orchestrator-install-plan.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
import {
  ensureProjectStateRoot,
  resolveProjectStatePaths
} from "./project-state-paths.mjs";
function installPlanPath(projectRoot) {
  return resolveProjectStatePaths(projectRoot).installPlanPath;
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
  const planPath = installPlanPath(args.projectRoot);
  throw new Error(
    `Missing install plan at ${planPath}. Run SessionStart first.`
  );
}
function writePersistedSkillInstallPlan(plan, logger) {
  const paths = ensureProjectStateRoot(
    resolveProjectStatePaths(plan.projectRoot)
  );
  writeFileSync(
    paths.installPlanPath,
    JSON.stringify(plan, null, 2) + "\n",
    "utf-8"
  );
  logger?.debug("install-plan-persisted", {
    installPlanPath: paths.installPlanPath,
    projectRoot: plan.projectRoot,
    stateRoot: paths.stateRoot
  });
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
  try {
    writePersistedSkillInstallPlan(refreshed, args.logger);
  } catch (error) {
    if (args.logger) {
      logCaughtError(args.logger, "install-plan-refresh-persist-failed", error, {
        installPlanPath: installPlanPath(args.projectRoot),
        projectRoot: args.projectRoot
      });
    }
  }
  return refreshed;
}
export {
  installPlanPath,
  readPersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan,
  requirePersistedSkillInstallPlan,
  writePersistedSkillInstallPlan
};
