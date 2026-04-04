// hooks/src/project-state-paths.mts
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join, normalize, resolve } from "path";
function resolveVercelPluginHome(homeDir) {
  return resolve(
    homeDir ?? (process.env.VERCEL_PLUGIN_HOME_DIR && process.env.VERCEL_PLUGIN_HOME_DIR.trim() !== "" ? process.env.VERCEL_PLUGIN_HOME_DIR : homedir()),
    ".vercel-plugin"
  );
}
function hashProjectRoot(projectRoot) {
  const normalizedProjectRoot = normalize(resolve(projectRoot));
  return createHash("sha256").update(normalizedProjectRoot).digest("hex").slice(0, 16);
}
function resolveProjectStatePaths(projectRoot, homeDir) {
  const normalizedProjectRoot = normalize(resolve(projectRoot));
  const projectHash = hashProjectRoot(normalizedProjectRoot);
  const stateRoot = join(
    resolveVercelPluginHome(homeDir),
    "projects",
    projectHash
  );
  const skillsDir = join(stateRoot, ".skills");
  return {
    projectRoot,
    normalizedProjectRoot,
    projectHash,
    stateRoot,
    skillsDir,
    manifestPath: join(skillsDir, "manifest.json"),
    lockfilePath: join(stateRoot, "skills-lock.json"),
    installPlanPath: join(skillsDir, "install-plan.json"),
    legacyProjectSkillsDir: join(normalizedProjectRoot, ".skills"),
    legacyProjectInstallPlanPath: join(
      normalizedProjectRoot,
      ".skills",
      "install-plan.json"
    )
  };
}
function ensureProjectStateRoot(paths) {
  mkdirSync(paths.skillsDir, { recursive: true });
  return paths;
}
export {
  ensureProjectStateRoot,
  hashProjectRoot,
  resolveProjectStatePaths,
  resolveVercelPluginHome
};
