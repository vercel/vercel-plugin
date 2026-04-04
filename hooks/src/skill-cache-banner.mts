import { join, normalize, resolve } from "node:path";
import { logCaughtError, type Logger } from "./logger.mjs";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  createRegistryClient,
  type InstallSkillsResult,
  type RegistryClient,
} from "./registry-client.mjs";
import {
  readProjectSkillState,
  type ProjectSkillState,
} from "./project-skill-manifest.mjs";
import { resolveProjectStatePaths } from "./project-state-paths.mjs";
import { createSkillStore } from "./skill-store.mjs";
import { pluginRoot as resolvePluginRoot } from "./hook-env.mjs";
import { canonicalizeInstalledSkillNames } from "./registry-skill-metadata.mjs";

export interface SkillCacheStatus {
  likelySkills: string[];
  installedSkills: string[];
  missingSkills: string[];
  extraInstalledSkills: string[];
  bundledFallbackEnabled: boolean;
  zeroBundleReady: boolean;
}

export interface SkillCacheBannerInput extends SkillCacheStatus {
  projectRoot: string;
  projectStateSource?: ProjectSkillState["source"];
  projectStatePath?: string | null;
}

export interface ResolveSkillCacheBannerArgs extends SkillCacheBannerInput {
  autoInstall?: boolean;
  skillsSource?: string;
  agent?: string;
  timeoutMs?: number;
  registryClient?: RegistryClient;
  logger?: Logger;
  projectState?: ProjectSkillState;
  pluginRootOverride?: string;
}

export type SkillCacheBannerOutcome =
  | "ready"
  | "suggest"
  | "installed"
  | "partial"
  | "failed";

export interface ResolveSkillCacheBannerResult {
  status: SkillCacheStatus;
  banner: string | null;
  installResult: InstallSkillsResult | null;
  outcome: SkillCacheBannerOutcome;
  projectState: ProjectSkillState;
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      ),
    ),
  ].sort();
}

export function buildProjectSkillInstallCommand(args: {
  missingSkills: string[];
  skillsSource?: string;
  agent?: string;
}): string | null {
  const missing = uniqueSorted(args.missingSkills);
  return missing.length === 0
    ? null
    : buildSkillsAddCommand(
        args.skillsSource,
        missing,
        args.agent ?? "claude-code",
      )?.printable ?? null;
}

export function buildProjectSkillInstallQuestion(
  missingSkills: string[],
): string | null {
  const missing = uniqueSorted(missingSkills);
  return missing.length === 0
    ? null
    : `I detected Vercel skills for ${missing.join(", ")}. Want me to install them into this project's skill cache?`;
}

export function buildSkillCacheStatus(args: {
  likelySkills: string[];
  installedSkills?: string[];
  bundledFallbackEnabled: boolean;
}): SkillCacheStatus {
  const likelySkills = uniqueSorted(args.likelySkills);
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const likelySet = new Set(likelySkills);

  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill),
  );
  const extraInstalledSkills = installedSkills.filter(
    (skill) => !likelySet.has(skill),
  );

  return {
    likelySkills,
    installedSkills,
    missingSkills,
    extraInstalledSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    zeroBundleReady: likelySkills.length > 0 && missingSkills.length === 0,
  };
}

export function formatProjectSkillStateLine(args: {
  source?: ProjectSkillState["source"];
  path?: string | null;
}): string | null {
  const source = args.source ?? "none";
  const path = args.path ?? null;
  if (source === "none") return null;
  const label =
    source === "skills-lock.json"
      ? "Read from: skills-lock.json"
      : source === "manifest.json"
        ? "Read from: project skill manifest"
        : "Read from: project skill cache";
  return path ? `${label} (${path})` : label;
}

export function buildResolvedSkillCacheBanner(args: {
  projectRoot: string;
  status: SkillCacheStatus;
  outcome: SkillCacheBannerOutcome;
  installResult?: InstallSkillsResult | null;
  skillsSource?: string;
  agent?: string;
  projectStateSource?: ProjectSkillState["source"];
  projectStatePath?: string | null;
}): string | null {
  const {
    projectRoot,
    status,
    outcome,
    installResult,
    skillsSource,
    agent,
    projectStateSource,
    projectStatePath,
  } = args;
  if (status.likelySkills.length === 0) return null;

  const detectedLine = `Detected: ${status.likelySkills.join(", ")}`;
  const cachedLine = `Cached: ${
    status.installedSkills.length > 0
      ? status.installedSkills.join(", ")
      : "none"
  }`;

  const readStateLine = formatProjectSkillStateLine({
    source: projectStateSource,
    path: projectStatePath,
  });

  const statusLine =
    outcome === "installed"
      ? "Status: installed now — project cache is ready"
      : outcome === "partial"
        ? "Status: partially installed — some skills are ready, some still need install"
        : outcome === "failed"
          ? "Status: auto-install failed — summary-only injection from rules manifest until cached"
          : status.missingSkills.length === 0
            ? "Status: ready"
            : "Status: incomplete cache — summary-only injection from rules manifest until cached";

  const showAskOnce = outcome === "suggest";
  const installQuestion =
    showAskOnce && status.missingSkills.length > 0
      ? buildProjectSkillInstallQuestion(status.missingSkills)
      : null;
  const installCommand =
    status.missingSkills.length > 0
      ? buildProjectSkillInstallCommand({
          missingSkills: status.missingSkills,
          skillsSource,
          agent,
        })
      : null;

  const extraLine =
    status.extraInstalledSkills.length > 0 && status.missingSkills.length === 0
      ? `Also cached: ${status.extraInstalledSkills.join(", ")}`
      : null;

  return [
    "### Vercel skill cache",
    `- ${statusLine}`,
    `- ${detectedLine}`,
    `- ${cachedLine}`,
    readStateLine ? `- ${readStateLine}` : null,
    extraLine ? `- ${extraLine}` : null,
    installResult?.installed.length
      ? `- Installed now: ${installResult.installed.join(", ")}`
      : null,
    installResult?.reused.length
      ? `- Already cached: ${installResult.reused.join(", ")}`
      : null,
    status.missingSkills.length > 0
      ? `- Missing: ${status.missingSkills.join(", ")}`
      : null,
    status.missingSkills.length > 0 ||
    outcome === "installed" ||
    outcome === "partial" ||
    outcome === "failed"
      ? `- Project skill dir: ${join(normalize(resolve(projectRoot)), ".claude", "skills")}`
      : null,
    installQuestion ? `- Ask once: "${installQuestion}"` : null,
    installCommand ? `- Install: \`${installCommand}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSkillCacheBanner(
  input: SkillCacheBannerInput,
): string | null {
  return buildResolvedSkillCacheBanner({
    projectRoot: input.projectRoot,
    status: input,
    outcome: input.missingSkills.length === 0 ? "ready" : "suggest",
  });
}

/**
 * Resolve the union of installed skills from the layered cache (project +
 * global) and project state (lockfile/directory scan). This mirrors the
 * same union logic used by `loadProjectInstalledSkillState()` so that
 * global-cache-only or lockfile-only installs are not misreported as missing.
 */
function resolveInstalledSkillUnion(args: {
  projectRoot: string;
  projectState: ProjectSkillState;
  pluginRootOverride?: string;
}): string[] {
  const store = createSkillStore({
    projectRoot: args.projectRoot,
    pluginRoot: args.pluginRootOverride ?? resolvePluginRoot(),
  });
  return uniqueSorted([
    ...canonicalizeInstalledSkillNames(store.listInstalledSkills()),
    ...canonicalizeInstalledSkillNames(args.projectState.installedSlugs),
  ]);
}

/**
 * Resolve a skill cache banner, optionally auto-installing missing skills
 * via CLI delegation when `autoInstall` is true.
 *
 * When auto-install is disabled or there are no missing skills, this is a
 * pure formatting function. When enabled, it delegates to the registry
 * client (which shells out to `npx skills add`), then rereads project
 * state to produce an updated banner.
 */
export async function resolveSkillCacheBanner(
  args: ResolveSkillCacheBannerArgs,
): Promise<ResolveSkillCacheBannerResult> {
  const initialProjectState =
    args.projectState ?? readProjectSkillState(args.projectRoot);
  const initialStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: args.installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
  });

  if (!args.autoInstall || initialStatus.missingSkills.length === 0) {
    const outcome: SkillCacheBannerOutcome =
      initialStatus.missingSkills.length === 0 ? "ready" : "suggest";
    return {
      status: initialStatus,
      banner: buildResolvedSkillCacheBanner({
        projectRoot: args.projectRoot,
        status: initialStatus,
        outcome,
        skillsSource: args.skillsSource,
        agent: args.agent ?? "claude-code",
        projectStateSource: initialProjectState.source,
        projectStatePath: initialProjectState.projectSkillStatePath,
      }),
      installResult: null,
      outcome,
      projectState: initialProjectState,
    };
  }

  const client =
    args.registryClient ??
    createRegistryClient({
      source: args.skillsSource,
      agent: args.agent ?? "claude-code",
      timeoutMs: args.timeoutMs ?? 4_000,
    });

  let installResult: InstallSkillsResult;
  try {
    installResult = await client.installSkills({
      projectRoot: args.projectRoot,
      skillNames: initialStatus.missingSkills,
    });
  } catch (error) {
    if (args.logger) {
      logCaughtError(
        args.logger,
        "skill-cache-banner:auto-install-failed",
        error,
        {
          projectRoot: args.projectRoot,
          missingSkills: initialStatus.missingSkills,
        },
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
        projectStatePath: initialProjectState.projectSkillStatePath,
      }),
      installResult: null,
      outcome: "failed",
      projectState: initialProjectState,
    };
  }

  const projectState = readProjectSkillState(args.projectRoot);

  const installedSkills = resolveInstalledSkillUnion({
    projectRoot: args.projectRoot,
    projectState,
    pluginRootOverride: args.pluginRootOverride,
  });

  args.logger?.debug?.("skill-cache-banner-status-refreshed", {
    projectRoot: args.projectRoot,
    installedSkills,
    projectStateSource: projectState.source,
    projectStatePath: projectState.projectSkillStatePath,
  });

  const nextStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
  });

  const outcome: SkillCacheBannerOutcome =
    nextStatus.missingSkills.length === 0
      ? "installed"
      : installResult.installed.length > 0 || installResult.reused.length > 0
        ? "partial"
        : "failed";

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
      projectStatePath: projectState.projectSkillStatePath,
    }),
    installResult,
    outcome,
    projectState,
  };
}
