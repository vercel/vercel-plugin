import { join } from "node:path";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  createRegistryClient,
  type InstallSkillsResult,
  type RegistryClient,
} from "./registry-client.mjs";
import { readProjectSkillState } from "./project-skill-manifest.mjs";

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
}

export interface ResolveSkillCacheBannerArgs extends SkillCacheBannerInput {
  autoInstall?: boolean;
  skillsSource?: string;
  agent?: string;
  timeoutMs?: number;
  registryClient?: RegistryClient;
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
    : `I detected Vercel skills for ${missing.join(", ")}. Want me to install them into .skills for this project?`;
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

export function buildResolvedSkillCacheBanner(args: {
  projectRoot: string;
  status: SkillCacheStatus;
  outcome: SkillCacheBannerOutcome;
  installResult?: InstallSkillsResult | null;
}): string | null {
  const { projectRoot, status, outcome, installResult } = args;
  if (status.likelySkills.length === 0) return null;

  const detectedLine = `Detected: ${status.likelySkills.join(", ")}`;
  const cachedLine = `Cached: ${
    status.installedSkills.length > 0
      ? status.installedSkills.join(", ")
      : "none"
  }`;

  const statusLine =
    outcome === "installed"
      ? "Status: installed now — project cache is ready"
      : outcome === "partial"
        ? "Status: partially installed — some skills are ready, some still need install"
        : outcome === "failed"
          ? status.bundledFallbackEnabled
            ? "Status: auto-install failed — bundled fallback can cover the gap during migration"
            : "Status: auto-install failed — missing skills will not inject until installed"
          : status.missingSkills.length === 0
            ? "Status: ready"
            : status.bundledFallbackEnabled
              ? "Status: incomplete cache — bundled fallback can cover the gap during migration"
              : "Status: incomplete cache — missing skills will not inject until installed";

  const installQuestion =
    status.missingSkills.length > 0
      ? buildProjectSkillInstallQuestion(status.missingSkills)
      : null;
  const installCommand =
    status.missingSkills.length > 0
      ? buildProjectSkillInstallCommand({ missingSkills: status.missingSkills })
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
    status.missingSkills.length > 0 || outcome === "installed" || outcome === "partial" || outcome === "failed"
      ? `- Project cache: ${join(projectRoot, ".skills")}`
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
      }),
      installResult: null,
      outcome,
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
  } catch {
    // CLI failure/timeout — fall back to suggestion-only banner
    return {
      status: initialStatus,
      banner: buildResolvedSkillCacheBanner({
        projectRoot: args.projectRoot,
        status: initialStatus,
        outcome: "failed",
      }),
      installResult: null,
      outcome: "failed",
    };
  }

  const projectState = readProjectSkillState(args.projectRoot);

  const nextStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: projectState.installedSlugs,
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
    }),
    installResult,
    outcome,
  };
}
