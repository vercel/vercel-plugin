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

export interface ResolveSkillCacheBannerResult {
  status: SkillCacheStatus;
  banner: string | null;
  installResult: InstallSkillsResult | null;
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

export function buildSkillCacheBanner(
  input: SkillCacheBannerInput,
): string | null {
  if (input.likelySkills.length === 0) return null;

  const detectedLine = `Detected: ${input.likelySkills.join(", ")}`;
  const cachedLine = `Cached: ${
    input.installedSkills.length > 0
      ? input.installedSkills.join(", ")
      : "none"
  }`;

  if (input.missingSkills.length === 0) {
    const extraLine =
      input.extraInstalledSkills.length > 0
        ? `Also cached: ${input.extraInstalledSkills.join(", ")}`
        : null;
    return [
      "### Vercel skill cache",
      "- Status: ready",
      `- ${detectedLine}`,
      `- ${cachedLine}`,
      extraLine ? `- ${extraLine}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const installQuestion = buildProjectSkillInstallQuestion(
    input.missingSkills,
  );
  const installCmd = buildProjectSkillInstallCommand({
    missingSkills: input.missingSkills,
  });

  const statusLine = input.bundledFallbackEnabled
    ? "Status: incomplete cache — bundled fallback can cover the gap during migration"
    : "Status: incomplete cache — missing skills will not inject until installed";

  return [
    "### Vercel skill cache",
    `- ${statusLine}`,
    `- ${detectedLine}`,
    `- ${cachedLine}`,
    `- Missing: ${input.missingSkills.join(", ")}`,
    `- Project cache: ${join(input.projectRoot, ".skills")}`,
    installQuestion ? `- Ask once: "${installQuestion}"` : null,
    installCmd ? `- Install: \`${installCmd}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");
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
    return {
      status: initialStatus,
      banner: buildSkillCacheBanner({
        ...initialStatus,
        projectRoot: args.projectRoot,
      }),
      installResult: null,
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
      banner: buildSkillCacheBanner({
        ...initialStatus,
        projectRoot: args.projectRoot,
      }),
      installResult: null,
    };
  }

  const projectState = readProjectSkillState(args.projectRoot);

  const nextStatus = buildSkillCacheStatus({
    likelySkills: args.likelySkills,
    installedSkills: projectState.installedSlugs,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
  });

  return {
    status: nextStatus,
    banner: buildSkillCacheBanner({
      ...nextStatus,
      projectRoot: args.projectRoot,
    }),
    installResult,
  };
}
