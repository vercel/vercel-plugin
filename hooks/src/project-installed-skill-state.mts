/**
 * Centralized project installed-skill state loader.
 *
 * Combines layered cache resolution with CLI-produced project state so
 * `skills-lock.json` can immediately affect orchestration decisions even
 * before `.skills/<slug>/SKILL.md` fully materializes.
 */

import {
  buildSkillCacheStatus,
  type SkillCacheStatus,
} from "./skill-cache-banner.mjs";
import {
  readProjectSkillState,
  type ProjectSkillState,
} from "./project-skill-manifest.mjs";
import {
  createSkillStore,
  type SkillStore,
  type SkillStoreLogger,
} from "./skill-store.mjs";
import { canonicalizeInstalledSkillNames } from "./registry-skill-metadata.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectInstalledSkillState {
  skillStore: SkillStore;
  installedSkills: string[];
  projectState: ProjectSkillState;
  cacheStatus: SkillCacheStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the full installed-skill state for a project in one call.
 *
 * Creates a fresh skill store, lists installed skills, reads CLI-produced
 * project state (skills-lock.json → manifest.json → directory scan), and
 * computes cache status against the likely skills set.
 *
 * The returned `installedSkills` is the union of the layered store
 * (project + global cache) and `projectState.installedSlugs` so that
 * lockfile-only installs (before `.skills/<slug>/SKILL.md` materializes)
 * are immediately visible to plan refresh and cache-status computation.
 *
 * Call this again after auto-install to pick up newly installed skills.
 */
export function loadProjectInstalledSkillState(args: {
  projectRoot: string;
  pluginRoot: string;
  likelySkills: string[];
  bundledFallbackEnabled: boolean;
  logger?: SkillStoreLogger;
}): ProjectInstalledSkillState {
  const skillStore = createSkillStore({
    projectRoot: args.projectRoot,
    pluginRoot: args.pluginRoot,
    includeRulesManifest: args.bundledFallbackEnabled,
  });

  const projectState = readProjectSkillState(args.projectRoot);

  // Preserve layered cache semantics (project + global) while making the
  // project-side read path lockfile-canonical.
  const installedSkills = uniqueSorted([
    ...canonicalizeInstalledSkillNames(skillStore.listInstalledSkills(args.logger)),
    ...canonicalizeInstalledSkillNames(projectState.installedSlugs),
  ]);

  const cacheStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
  });

  return { skillStore, installedSkills, projectState, cacheStatus };
}
