// hooks/src/project-skill-manifest.mts
import { existsSync, readdirSync } from "fs";
import { join, normalize, resolve } from "path";
import { safeReadJson } from "./hook-env.mjs";
import { resolveProjectStatePaths } from "./project-state-paths.mjs";
function uniqueMergedSlugs(...lists) {
  return [...new Set(lists.flat())].sort();
}
function listSkillSlugs(skillsDir) {
  try {
    return readdirSync(skillsDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))
    ).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function readProjectSkillLock(lockfilePath) {
  if (!existsSync(lockfilePath)) return null;
  const parsed = safeReadJson(lockfilePath);
  if (!parsed || typeof parsed !== "object" || !parsed.skills || typeof parsed.skills !== "object" || Array.isArray(parsed.skills)) {
    return null;
  }
  const skills = Object.fromEntries(
    Object.entries(parsed.skills).filter(
      ([slug, entry]) => slug.trim() !== "" && entry !== null && typeof entry === "object" && !Array.isArray(entry)
    )
  );
  return {
    version: typeof parsed.version === "number" ? parsed.version : null,
    skills
  };
}
function readProjectSkillState(projectRoot) {
  const statePaths = resolveProjectStatePaths(projectRoot);
  const skillsDir = statePaths.skillsDir;
  const lockfilePath = statePaths.lockfilePath;
  const projectClaudeSkillsDir = join(normalize(resolve(projectRoot)), ".claude", "skills");
  if (existsSync(lockfilePath)) {
    const parsedLock = readProjectSkillLock(lockfilePath);
    const scannedSlugs = uniqueMergedSlugs(listSkillSlugs(skillsDir), listSkillSlugs(projectClaudeSkillsDir));
    return {
      projectSkillStatePath: lockfilePath,
      source: "skills-lock.json",
      installedSlugs: scannedSlugs,
      skillsDir,
      lockVersion: parsedLock?.version ?? null,
      lockSkills: parsedLock?.skills ?? {}
    };
  }
  const installedSlugs = uniqueMergedSlugs(listSkillSlugs(skillsDir), listSkillSlugs(projectClaudeSkillsDir));
  const manifestPath = join(skillsDir, "manifest.json");
  if (existsSync(manifestPath)) {
    return {
      projectSkillStatePath: manifestPath,
      source: "manifest.json",
      installedSlugs,
      skillsDir,
      lockVersion: null,
      lockSkills: {}
    };
  }
  if (installedSlugs.length > 0) {
    return {
      projectSkillStatePath: skillsDir,
      source: "directory",
      installedSlugs,
      skillsDir,
      lockVersion: null,
      lockSkills: {}
    };
  }
  return {
    projectSkillStatePath: null,
    source: "none",
    installedSlugs: [],
    skillsDir,
    lockVersion: null,
    lockSkills: {}
  };
}
export {
  readProjectSkillState
};
