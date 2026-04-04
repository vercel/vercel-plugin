import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

export interface ProjectStatePaths {
  projectRoot: string;
  normalizedProjectRoot: string;
  projectHash: string;
  stateRoot: string;
  skillsDir: string;
  manifestPath: string;
  lockfilePath: string;
  installPlanPath: string;
  legacyProjectSkillsDir: string;
  legacyProjectInstallPlanPath: string;
}

export function resolveVercelPluginHome(homeDir?: string): string {
  return resolve(
    homeDir
      ?? (process.env.VERCEL_PLUGIN_HOME_DIR && process.env.VERCEL_PLUGIN_HOME_DIR.trim() !== ""
        ? process.env.VERCEL_PLUGIN_HOME_DIR
        : homedir()),
    ".vercel-plugin",
  );
}

export function hashProjectRoot(projectRoot: string): string {
  const normalizedProjectRoot = normalize(resolve(projectRoot));
  return createHash("sha256")
    .update(normalizedProjectRoot)
    .digest("hex")
    .slice(0, 16);
}

export function resolveProjectStatePaths(
  projectRoot: string,
  homeDir?: string,
): ProjectStatePaths {
  const normalizedProjectRoot = normalize(resolve(projectRoot));
  const projectHash = hashProjectRoot(normalizedProjectRoot);
  const stateRoot = join(
    resolveVercelPluginHome(homeDir),
    "projects",
    projectHash,
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
      "install-plan.json",
    ),
  };
}

export function ensureProjectStateRoot(
  paths: ProjectStatePaths,
): ProjectStatePaths {
  mkdirSync(paths.skillsDir, { recursive: true });
  return paths;
}
