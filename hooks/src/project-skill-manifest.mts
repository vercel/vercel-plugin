/**
 * CLI-produced project skill state reader.
 *
 * Instead of building a plugin-owned `.skills/manifest.json` from frontmatter
 * scanning, this module reads whatever the `npx skills` CLI has written into
 * the project — `skills-lock.json`, `.skills/manifest.json`, or simply the
 * set of `.skills/<slug>/SKILL.md` entries on disk.
 *
 * When a valid `skills-lock.json` is present, its `skills` record keys are
 * the canonical source of installed skill slugs — the directory scan is only
 * used as a fallback when the lockfile is missing or malformed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeReadJson } from "./hook-env.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectSkillLockEntry {
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  ref?: string;
  skillPath?: string;
  skillFolderHash?: string;
  installedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ProjectSkillLockFile {
  version?: number;
  skills?: Record<string, ProjectSkillLockEntry>;
  [key: string]: unknown;
}

export interface ProjectSkillState {
  /** Path to the best CLI-produced artifact found, or null if none. */
  projectSkillStatePath: string | null;
  /** Which artifact was found: lockfile, manifest, directory scan, or none. */
  source: "skills-lock.json" | "manifest.json" | "directory" | "none";
  /** Skill slugs — from lockfile keys when available, else directory scan. */
  installedSlugs: string[];
  /** The `.skills/` directory that was scanned. */
  skillsDir: string;
  /** Lock file version, if a valid lockfile was found. */
  lockVersion: number | null;
  /** Lock file skills record, if a valid lockfile was found. */
  lockSkills: Record<string, ProjectSkillLockEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * List skill slugs present in a `.skills/` directory by looking for
 * subdirectories that contain a `SKILL.md` file.
 */
function listSkillSlugs(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(skillsDir, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Parse a `skills-lock.json` file into a structured lock record.
 * Returns null if the file doesn't exist or is malformed.
 */
function readProjectSkillLock(
  lockfilePath: string,
): { version: number | null; skills: Record<string, ProjectSkillLockEntry> } | null {
  if (!existsSync(lockfilePath)) return null;

  const parsed = safeReadJson<ProjectSkillLockFile>(lockfilePath);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.skills ||
    typeof parsed.skills !== "object" ||
    Array.isArray(parsed.skills)
  ) {
    return null;
  }

  const skills = Object.fromEntries(
    Object.entries(parsed.skills).filter(
      ([slug, entry]) =>
        slug.trim() !== "" &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry),
    ),
  ) as Record<string, ProjectSkillLockEntry>;

  return {
    version: typeof parsed.version === "number" ? parsed.version : null,
    skills,
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read CLI-produced project skill state from the project root.
 *
 * Resolution order (first match wins):
 * 1. `<projectRoot>/skills-lock.json` — written by `npx skills add`.
 *    When valid, lockfile `skills` keys are the canonical installed slugs.
 *    When present but malformed, falls through to directory scan for slugs.
 * 2. `<projectRoot>/.skills/manifest.json` — may be written by CLI or left
 *    from a previous plugin version
 * 3. `<projectRoot>/.skills/` directory scan — always available if skills
 *    have been installed
 */
export function readProjectSkillState(projectRoot: string): ProjectSkillState {
  const skillsDir = resolve(projectRoot, ".skills");
  const lockfilePath = join(projectRoot, "skills-lock.json");

  // 1. skills-lock.json (canonical CLI output)
  if (existsSync(lockfilePath)) {
    const parsedLock = readProjectSkillLock(lockfilePath);
    const scannedSlugs = listSkillSlugs(skillsDir);

    return {
      projectSkillStatePath: lockfilePath,
      source: "skills-lock.json",
      // Canonical: derive slugs from lockfile keys when valid and non-empty,
      // fall back to directory scan when lockfile is malformed or empty.
      installedSlugs:
        parsedLock && Object.keys(parsedLock.skills).length > 0
          ? Object.keys(parsedLock.skills).sort()
          : scannedSlugs,
      skillsDir,
      lockVersion: parsedLock?.version ?? null,
      lockSkills: parsedLock?.skills ?? {},
    };
  }

  // 2. .skills/manifest.json (CLI-written or legacy)
  const installedSlugs = listSkillSlugs(skillsDir);
  const manifestPath = join(skillsDir, "manifest.json");
  if (existsSync(manifestPath)) {
    return {
      projectSkillStatePath: manifestPath,
      source: "manifest.json",
      installedSlugs,
      skillsDir,
      lockVersion: null,
      lockSkills: {},
    };
  }

  // 3. Directory scan only — skills exist but no artifact file
  if (installedSlugs.length > 0) {
    return {
      projectSkillStatePath: skillsDir,
      source: "directory",
      installedSlugs,
      skillsDir,
      lockVersion: null,
      lockSkills: {},
    };
  }

  // 4. Nothing found
  return {
    projectSkillStatePath: null,
    source: "none",
    installedSlugs: [],
    skillsDir,
    lockVersion: null,
    lockSkills: {},
  };
}
