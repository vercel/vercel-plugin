// hooks/src/project-installed-skill-state.mts
import {
  buildSkillCacheStatus
} from "./skill-cache-banner.mjs";
import {
  readProjectSkillState
} from "./project-skill-manifest.mjs";
import {
  createSkillStore
} from "./skill-store.mjs";
function loadProjectInstalledSkillState(args) {
  const skillStore = createSkillStore({
    projectRoot: args.projectRoot,
    pluginRoot: args.pluginRoot,
    bundledFallback: args.bundledFallbackEnabled
  });
  const installedSkills = skillStore.listInstalledSkills(args.logger);
  const projectState = readProjectSkillState(args.projectRoot);
  const cacheStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled
  });
  return { skillStore, installedSkills, projectState, cacheStatus };
}
export {
  loadProjectInstalledSkillState
};
