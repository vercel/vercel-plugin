// hooks/src/skill-cache-banner.mts
import { join } from "path";
import { logCaughtError } from "./logger.mjs";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  createRegistryClient
} from "./registry-client.mjs";
import {
  readProjectSkillState
} from "./project-skill-manifest.mjs";
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
function formatProjectSkillStateLine(args) {
  const source = args.source ?? "none";
  const path = args.path ?? null;
  if (source === "none") return null;
  const label = source === "skills-lock.json" ? "Read from: skills-lock.json" : source === "manifest.json" ? "Read from: .skills/manifest.json" : "Read from: .skills directory";
  return path ? `${label} (${path})` : label;
}
function buildResolvedSkillCacheBanner(args) {
  const {
    projectRoot,
    status,
    outcome,
    installResult,
    skillsSource,
    agent,
    projectStateSource,
    projectStatePath
  } = args;
  if (status.likelySkills.length === 0) return null;
  const detectedLine = `Detected: ${status.likelySkills.join(", ")}`;
  const cachedLine = `Cached: ${status.installedSkills.length > 0 ? status.installedSkills.join(", ") : "none"}`;
  const readStateLine = formatProjectSkillStateLine({
    source: projectStateSource,
    path: projectStatePath
  });
  const statusLine = outcome === "installed" ? "Status: installed now \u2014 project cache is ready" : outcome === "partial" ? "Status: partially installed \u2014 some skills are ready, some still need install" : outcome === "failed" ? status.bundledFallbackEnabled ? "Status: auto-install failed \u2014 bundled fallback can cover the gap during migration" : "Status: auto-install failed \u2014 missing skills will not inject until installed" : status.missingSkills.length === 0 ? "Status: ready" : status.bundledFallbackEnabled ? "Status: incomplete cache \u2014 bundled fallback can cover the gap during migration" : "Status: incomplete cache \u2014 missing skills will not inject until installed";
  const showAskOnce = outcome === "suggest";
  const installQuestion = showAskOnce && status.missingSkills.length > 0 ? buildProjectSkillInstallQuestion(status.missingSkills) : null;
  const installCommand = status.missingSkills.length > 0 ? buildProjectSkillInstallCommand({
    missingSkills: status.missingSkills,
    skillsSource,
    agent
  }) : null;
  const extraLine = status.extraInstalledSkills.length > 0 && status.missingSkills.length === 0 ? `Also cached: ${status.extraInstalledSkills.join(", ")}` : null;
  return [
    "### Vercel skill cache",
    `- ${statusLine}`,
    `- ${detectedLine}`,
    `- ${cachedLine}`,
    readStateLine ? `- ${readStateLine}` : null,
    extraLine ? `- ${extraLine}` : null,
    installResult?.installed.length ? `- Installed now: ${installResult.installed.join(", ")}` : null,
    installResult?.reused.length ? `- Already cached: ${installResult.reused.join(", ")}` : null,
    status.missingSkills.length > 0 ? `- Missing: ${status.missingSkills.join(", ")}` : null,
    status.missingSkills.length > 0 || outcome === "installed" || outcome === "partial" || outcome === "failed" ? `- Project cache: ${join(projectRoot, ".skills")}` : null,
    installQuestion ? `- Ask once: "${installQuestion}"` : null,
    installCommand ? `- Install: \`${installCommand}\`` : null
  ].filter(Boolean).join("\n");
}
function buildSkillCacheBanner(input) {
  return buildResolvedSkillCacheBanner({
    projectRoot: input.projectRoot,
    status: input,
    outcome: input.missingSkills.length === 0 ? "ready" : "suggest"
  });
}
async function resolveSkillCacheBanner(args) {
  const initialProjectState = readProjectSkillState(args.projectRoot);
  const initialStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: args.installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled
  });
  if (!args.autoInstall || initialStatus.missingSkills.length === 0) {
    const outcome2 = initialStatus.missingSkills.length === 0 ? "ready" : "suggest";
    return {
      status: initialStatus,
      banner: buildResolvedSkillCacheBanner({
        projectRoot: args.projectRoot,
        status: initialStatus,
        outcome: outcome2,
        skillsSource: args.skillsSource,
        agent: args.agent ?? "claude-code",
        projectStateSource: initialProjectState.source,
        projectStatePath: initialProjectState.projectSkillStatePath
      }),
      installResult: null,
      outcome: outcome2
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
  } catch (error) {
    if (args.logger) {
      logCaughtError(
        args.logger,
        "skill-cache-banner:auto-install-failed",
        error,
        {
          projectRoot: args.projectRoot,
          missingSkills: initialStatus.missingSkills
        }
      );
    }
    return {
      status: initialStatus,
      banner: buildResolvedSkillCacheBanner({
        projectRoot: args.projectRoot,
        status: initialStatus,
        outcome: "failed",
        skillsSource: args.skillsSource,
        agent: args.agent ?? "claude-code",
        projectStateSource: initialProjectState.source,
        projectStatePath: initialProjectState.projectSkillStatePath
      }),
      installResult: null,
      outcome: "failed"
    };
  }
  const projectState = readProjectSkillState(args.projectRoot);
  const nextStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: projectState.installedSlugs,
    bundledFallbackEnabled: args.bundledFallbackEnabled
  });
  const outcome = nextStatus.missingSkills.length === 0 ? "installed" : installResult.installed.length > 0 || installResult.reused.length > 0 ? "partial" : "failed";
  return {
    status: nextStatus,
    banner: buildResolvedSkillCacheBanner({
      projectRoot: args.projectRoot,
      status: nextStatus,
      outcome,
      installResult,
      skillsSource: args.skillsSource,
      agent: args.agent ?? "claude-code",
      projectStateSource: projectState.source,
      projectStatePath: projectState.projectSkillStatePath
    }),
    installResult,
    outcome
  };
}
export {
  buildProjectSkillInstallCommand,
  buildProjectSkillInstallQuestion,
  buildResolvedSkillCacheBanner,
  buildSkillCacheBanner,
  buildSkillCacheStatus,
  formatProjectSkillStateLine,
  resolveSkillCacheBanner
};
