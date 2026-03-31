// hooks/src/project-skill-manifest.mts
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { safeReadJson } from "./hook-env.mjs";
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
  const skillsDir = resolve(projectRoot, ".skills");
  const lockfilePath = join(projectRoot, "skills-lock.json");
  if (existsSync(lockfilePath)) {
    const parsedLock = readProjectSkillLock(lockfilePath);
    const scannedSlugs = listSkillSlugs(skillsDir);
    return {
      projectSkillStatePath: lockfilePath,
      source: "skills-lock.json",
      // Canonical: derive slugs from lockfile keys when valid and non-empty,
      // fall back to directory scan when lockfile is malformed or empty.
      installedSlugs: parsedLock && Object.keys(parsedLock.skills).length > 0 ? Object.keys(parsedLock.skills).sort() : scannedSlugs,
      skillsDir,
      lockVersion: parsedLock?.version ?? null,
      lockSkills: parsedLock?.skills ?? {}
    };
  }
  const installedSlugs = listSkillSlugs(skillsDir);
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
