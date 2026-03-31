// hooks/src/project-skill-manifest.mts
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
function listSkillSlugs(skillsDir) {
  try {
    return readdirSync(skillsDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))
    ).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function readProjectSkillState(projectRoot) {
  const skillsDir = resolve(projectRoot, ".skills");
  const installedSlugs = listSkillSlugs(skillsDir);
  const lockfilePath = join(projectRoot, "skills-lock.json");
  if (existsSync(lockfilePath)) {
    return {
      projectSkillStatePath: lockfilePath,
      source: "skills-lock.json",
      installedSlugs,
      skillsDir
    };
  }
  const manifestPath = join(skillsDir, "manifest.json");
  if (existsSync(manifestPath)) {
    return {
      projectSkillStatePath: manifestPath,
      source: "manifest.json",
      installedSlugs,
      skillsDir
    };
  }
  if (installedSlugs.length > 0) {
    return {
      projectSkillStatePath: skillsDir,
      source: "directory",
      installedSlugs,
      skillsDir
    };
  }
  return {
    projectSkillStatePath: null,
    source: "none",
    installedSlugs: [],
    skillsDir
  };
}
export {
  readProjectSkillState
};
