// hooks/src/skill-cache-banner.mts
import { join } from "path";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  createRegistryClient
} from "./registry-client.mjs";
import { readProjectSkillState } from "./project-skill-manifest.mjs";
function uniqueSorted(values) {
  return [
    ...new Set(
      (values ?? []).filter(
        (value) => typeof value === "string" && value.trim() !== ""
      )
    )
  ].sort();
}
function buildProjectSkillInstallCommand(args) {
  const missing = uniqueSorted(args.missingSkills);
  return missing.length === 0 ? null : buildSkillsAddCommand(
    args.skillsSource,
    missing,
    args.agent ?? "claude-code"
  )?.printable ?? null;
}
function buildProjectSkillInstallQuestion(missingSkills) {
  const missing = uniqueSorted(missingSkills);
  return missing.length === 0 ? null : `I detected Vercel skills for ${missing.join(", ")}. Want me to install them into .skills for this project?`;
}
function buildSkillCacheStatus(args) {
  const likelySkills = uniqueSorted(args.likelySkills);
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const likelySet = new Set(likelySkills);
  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill)
  );
  const extraInstalledSkills = installedSkills.filter(
    (skill) => !likelySet.has(skill)
  );
  return {
    likelySkills,
    installedSkills,
    missingSkills,
    extraInstalledSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    zeroBundleReady: likelySkills.length > 0 && missingSkills.length === 0
  };
}
function buildSkillCacheBanner(input) {
  if (input.likelySkills.length === 0) return null;
  const detectedLine = `Detected: ${input.likelySkills.join(", ")}`;
  const cachedLine = `Cached: ${input.installedSkills.length > 0 ? input.installedSkills.join(", ") : "none"}`;
  if (input.missingSkills.length === 0) {
    const extraLine = input.extraInstalledSkills.length > 0 ? `Also cached: ${input.extraInstalledSkills.join(", ")}` : null;
    return [
      "### Vercel skill cache",
      "- Status: ready",
      `- ${detectedLine}`,
      `- ${cachedLine}`,
      extraLine ? `- ${extraLine}` : null
    ].filter(Boolean).join("\n");
  }
  const installQuestion = buildProjectSkillInstallQuestion(
    input.missingSkills
  );
  const installCmd = buildProjectSkillInstallCommand({
    missingSkills: input.missingSkills
  });
  const statusLine = input.bundledFallbackEnabled ? "Status: incomplete cache \u2014 bundled fallback can cover the gap during migration" : "Status: incomplete cache \u2014 missing skills will not inject until installed";
  return [
    "### Vercel skill cache",
    `- ${statusLine}`,
    `- ${detectedLine}`,
    `- ${cachedLine}`,
    `- Missing: ${input.missingSkills.join(", ")}`,
    `- Project cache: ${join(input.projectRoot, ".skills")}`,
    installQuestion ? `- Ask once: "${installQuestion}"` : null,
    installCmd ? `- Install: \`${installCmd}\`` : null
  ].filter(Boolean).join("\n");
}
async function resolveSkillCacheBanner(args) {
  const initialStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: args.installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled
  });
  if (!args.autoInstall || initialStatus.missingSkills.length === 0) {
    return {
      status: initialStatus,
      banner: buildSkillCacheBanner({
        ...initialStatus,
        projectRoot: args.projectRoot
      }),
      installResult: null
    };
  }
  const client = args.registryClient ?? createRegistryClient({
    source: args.skillsSource,
    agent: args.agent ?? "claude-code",
    timeoutMs: args.timeoutMs ?? 4e3
  });
  let installResult;
  try {
    installResult = await client.installSkills({
      projectRoot: args.projectRoot,
      skillNames: initialStatus.missingSkills
    });
  } catch {
    return {
      status: initialStatus,
      banner: buildSkillCacheBanner({
        ...initialStatus,
        projectRoot: args.projectRoot
      }),
      installResult: null
    };
  }
  const projectState = readProjectSkillState(args.projectRoot);
  const nextStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: projectState.installedSlugs,
    bundledFallbackEnabled: args.bundledFallbackEnabled
  });
  return {
    status: nextStatus,
    banner: buildSkillCacheBanner({
      ...nextStatus,
      projectRoot: args.projectRoot
    }),
    installResult
  };
}
export {
  buildProjectSkillInstallCommand,
  buildProjectSkillInstallQuestion,
  buildSkillCacheBanner,
  buildSkillCacheStatus,
  resolveSkillCacheBanner
};
