/**
 * CLI-produced project skill state reader.
 *
 * Instead of building a plugin-owned `.skills/manifest.json` from frontmatter
 * scanning, this module reads whatever the `npx skills` CLI has written into
 * the project — `skills-lock.json`, `.skills/manifest.json`, or simply the
 * set of `.skills/<slug>/SKILL.md` entries on disk.
 *
 * Downstream consumers (install plan, env vars, profile cache) receive a
 * stable `projectSkillStatePath` that points to the best available CLI
 * artifact, and a list of skill slugs the CLI has installed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectSkillState {
  /** Path to the best CLI-produced artifact found, or null if none. */
  projectSkillStatePath: string | null;
  /** Which artifact was found: lockfile, manifest, directory scan, or none. */
  source: "skills-lock.json" | "manifest.json" | "directory" | "none";
  /** Skill slugs discovered from the project `.skills/` directory. */
  installedSlugs: string[];
  /** The `.skills/` directory that was scanned. */
  skillsDir: string;
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

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read CLI-produced project skill state from the `.skills/` directory.
 *
 * Resolution order (first match wins):
 * 1. `<projectRoot>/skills-lock.json` — written by `npx skills add`
 * 2. `<projectRoot>/.skills/manifest.json` — may be written by CLI or left
 *    from a previous plugin version
 * 3. `<projectRoot>/.skills/` directory scan — always available if skills
 *    have been installed
 *
 * The returned `projectSkillStatePath` can be stored in env vars and passed
 * to downstream hooks. The `installedSlugs` list is derived from the
 * directory scan regardless of which artifact was found.
 */
export function readProjectSkillState(projectRoot: string): ProjectSkillState {
  const skillsDir = resolve(projectRoot, ".skills");
  const installedSlugs = listSkillSlugs(skillsDir);

  // 1. skills-lock.json (canonical CLI output)
  const lockfilePath = join(projectRoot, "skills-lock.json");
  if (existsSync(lockfilePath)) {
    return {
      projectSkillStatePath: lockfilePath,
      source: "skills-lock.json",
      installedSlugs,
      skillsDir,
    };
  }

  // 2. .skills/manifest.json (CLI-written or legacy)
  const manifestPath = join(skillsDir, "manifest.json");
  if (existsSync(manifestPath)) {
    return {
      projectSkillStatePath: manifestPath,
      source: "manifest.json",
      installedSlugs,
      skillsDir,
    };
  }

  // 3. Directory scan only — skills exist but no artifact file
  if (installedSlugs.length > 0) {
    return {
      projectSkillStatePath: skillsDir,
      source: "directory",
      installedSlugs,
      skillsDir,
    };
  }

  // 4. Nothing found
  return {
    projectSkillStatePath: null,
    source: "none",
    installedSlugs: [],
    skillsDir,
  };
}
