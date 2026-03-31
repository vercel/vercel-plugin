/**
 * Centralized project installed-skill state loader.
 *
 * Combines skill store resolution, installed-skill listing, CLI-produced
 * project state, and cache status into a single call so SessionStart and
 * PostToolUse don't duplicate the refresh logic.
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
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the full installed-skill state for a project in one call.
 *
 * Creates a fresh skill store, lists installed skills, reads CLI-produced
 * project state (skills-lock.json → manifest.json → directory scan), and
 * computes cache status against the likely skills set.
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
    bundledFallback: args.bundledFallbackEnabled,
  });

  const installedSkills = skillStore.listInstalledSkills(args.logger);
  const projectState = readProjectSkillState(args.projectRoot);

  const cacheStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
  });

  return { skillStore, installedSkills, projectState, cacheStatus };
}
