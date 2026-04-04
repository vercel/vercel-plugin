/**
 * Orchestrator Install Plan — machine-readable skill detection and install plan.
 *
 * Produces a structured plan that describes which skills were detected,
 * which are already cached, and which are missing. The plan is persisted
 * under the hashed home-state root and surfaced as a human-readable
 * palette in SessionStart output.
 */

import { normalize, resolve, join } from "node:path";
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  buildVercelCliCommand,
  type VercelSubcommand,
} from "./vercel-cli-command.mjs";
import { resolveProjectStatePaths } from "./project-state-paths.mjs";
import { formatCommandWithCwd } from "./registry-client.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionReasonKind =
  | "file"
  | "dependency"
  | "vercel-json"
  | "greenfield"
  | "profiler-default";

export interface DetectionReason {
  kind: DetectionReasonKind;
  source: string;
  detail: string;
}

export interface SkillDetection {
  skill: string;
  reasons: DetectionReason[];
}

export interface SkillInstallAction {
  id: "install-missing" | "explain" | "activate-cache-only" | "vercel-link" | "vercel-env-pull" | "vercel-deploy";
  label: string;
  description: string;
  command: string | null;
  cwd: string | null;
  default?: boolean;
}

export interface SkillInstallPlan {
  schemaVersion: 1;
  createdAt: string;
  projectRoot: string;
  projectStateRoot: string;
  skillsCacheDir: string;
  installPlanPath: string;
  likelySkills: string[];
  installedSkills: string[];
  missingSkills: string[];
  bundledFallbackEnabled: boolean;
  zeroBundleReady: boolean;
  projectSkillManifestPath: string | null;
  vercelLinked: boolean;
  hasEnvLocal: boolean;
  detections: SkillDetection[];
  actions: SkillInstallAction[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { buildVercelCliCommand, vercelSubcommands } from "./vercel-cli-command.mjs";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function formatReasonList(detection: SkillDetection): string {
  return detection.reasons
    .map((reason) => `${reason.kind}:${reason.source}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildSkillInstallPlan(args: {
  projectRoot: string;
  detections: SkillDetection[];
  installedSkills: string[];
  bundledFallbackEnabled: boolean;
  zeroBundleReady: boolean;
  projectSkillManifestPath?: string | null;
  skillsSource?: string;
  skillsAgent?: string;
  vercelLinked?: boolean;
  hasEnvLocal?: boolean;
  now?: () => Date;
}): SkillInstallPlan {
  const statePaths = resolveProjectStatePaths(args.projectRoot);

  const likelySkills = uniqueSorted(
    args.detections.map((d) => d.skill),
  );
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill),
  );

  const installCommand =
    buildSkillsAddCommand(
      args.skillsSource,
      missingSkills,
      args.skillsAgent ?? "claude-code",
    )?.printable ?? null;

  const vercelLinked = args.vercelLinked ?? false;
  const hasEnvLocal = args.hasEnvLocal ?? false;

  const actions: SkillInstallAction[] = [
    {
      id: "install-missing",
      label: "Install detected skills",
      description:
        missingSkills.length === 0
          ? "All detected skills are already cached."
          : `Install ${missingSkills.length} missing skill${missingSkills.length === 1 ? "" : "s"} into ${statePaths.skillsDir}.`,
      command: installCommand,
      cwd: installCommand ? args.projectRoot : null,
      default: !args.zeroBundleReady,
    },
    {
      id: "activate-cache-only",
      label: "Use body-cache-only mode",
      description: args.zeroBundleReady
        ? "All detected skills are cached. Disables the rules-manifest summary fallback so only cached skill bodies are used."
        : "Body-cache-only mode is blocked until the missing skills are installed.",
      command: args.zeroBundleReady
        ? "export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1"
        : null,
      cwd: null,
      default: args.zeroBundleReady,
    },
    {
      id: "explain",
      label: "Explain detections",
      description:
        "Open the persisted install plan with full detection reasons.",
      command: `cat "${statePaths.installPlanPath}"`,
      cwd: null,
    },
  ];

  // Vercel CLI delegation actions — surfaced when the project needs them.
  if (!vercelLinked) {
    actions.push({
      id: "vercel-link",
      label: "Link Vercel project",
      description: "No .vercel/ directory found. Link this project to a Vercel project.",
      command: buildVercelCliCommand("link").printable,
      cwd: args.projectRoot,
    });
  }

  if (!hasEnvLocal) {
    actions.push({
      id: "vercel-env-pull",
      label: "Pull environment variables",
      description: vercelLinked
        ? "Pull .env.local from the linked Vercel project."
        : "Link the project first, then pull .env.local.",
      command: vercelLinked
        ? buildVercelCliCommand("env-pull").printable
        : null,
      cwd: vercelLinked ? args.projectRoot : null,
    });
  }

  actions.push({
    id: "vercel-deploy",
    label: "Deploy to Vercel",
    description: vercelLinked
      ? "Deploy the current project to Vercel."
      : "Link the project first, then deploy.",
    command: vercelLinked
      ? buildVercelCliCommand("deploy").printable
      : null,
    cwd: vercelLinked ? args.projectRoot : null,
  });

  return {
    schemaVersion: 1,
    createdAt: (args.now ? args.now() : new Date()).toISOString(),
    projectRoot: args.projectRoot,
    projectStateRoot: statePaths.stateRoot,
    skillsCacheDir: join(normalize(resolve(args.projectRoot)), ".claude", "skills"),
    installPlanPath: statePaths.installPlanPath,
    likelySkills,
    installedSkills,
    missingSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    zeroBundleReady: args.zeroBundleReady,
    projectSkillManifestPath: args.projectSkillManifestPath ?? null,
    vercelLinked,
    hasEnvLocal,
    detections: [...args.detections].sort((a, b) =>
      a.skill.localeCompare(b.skill),
    ),
    actions,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeSkillInstallPlan(plan: SkillInstallPlan): string {
  return JSON.stringify(plan);
}

// ---------------------------------------------------------------------------
// Human-readable palette
// ---------------------------------------------------------------------------

export function formatSkillInstallPalette(
  plan: SkillInstallPlan,
): string | null {
  if (plan.likelySkills.length === 0) return null;

  const lines: string[] = [
    "### Vercel skill orchestrator",
    `- Detected: ${plan.likelySkills.join(", ")}`,
    `- Cached: ${plan.installedSkills.length > 0 ? plan.installedSkills.join(", ") : "none"}`,
    `- Missing: ${plan.missingSkills.length > 0 ? plan.missingSkills.join(", ") : "none"}`,
    `- State root: ${plan.projectStateRoot}`,
    `- Skill cache: ${plan.skillsCacheDir}`,
    `- Install plan: ${plan.installPlanPath}`,
    `- Zero-bundle ready: ${plan.zeroBundleReady ? "yes" : "no"}`,
  ];

  const installAction = plan.actions.find(
    (action) => action.id === "install-missing",
  );
  const installDisplay = installAction
    ? formatCommandWithCwd(installAction.command, installAction.cwd)
    : null;
  if (installDisplay) {
    lines.push(`- [1] Install now: ${installDisplay}`);
  }

  const cacheOnlyAction = plan.actions.find(
    (action) => action.id === "activate-cache-only",
  );
  const cacheOnlyDisplay = cacheOnlyAction
    ? formatCommandWithCwd(cacheOnlyAction.command, cacheOnlyAction.cwd)
    : null;
  if (cacheOnlyDisplay) {
    lines.push(`- [2] Cache only: ${cacheOnlyDisplay}`);
  }

  lines.push(`- [3] Explain: cat "${plan.installPlanPath}"`);

  const vercelLinkAction = plan.actions.find(
    (action) => action.id === "vercel-link",
  );
  const vercelLinkDisplay = vercelLinkAction
    ? formatCommandWithCwd(vercelLinkAction.command, vercelLinkAction.cwd)
    : null;
  if (vercelLinkDisplay) {
    lines.push(`- [4] Link project: ${vercelLinkDisplay}`);
  }

  const envPullAction = plan.actions.find(
    (action) => action.id === "vercel-env-pull",
  );
  const envPullDisplay = envPullAction
    ? formatCommandWithCwd(envPullAction.command, envPullAction.cwd)
    : null;
  if (envPullDisplay) {
    lines.push(`- [5] Pull env: ${envPullDisplay}`);
  }

  const deployAction = plan.actions.find(
    (action) => action.id === "vercel-deploy",
  );
  const deployDisplay = deployAction
    ? formatCommandWithCwd(deployAction.command, deployAction.cwd)
    : null;
  if (deployDisplay) {
    lines.push(`- [6] Deploy: ${deployDisplay}`);
  }

  if (plan.detections.length > 0) {
    lines.push("", "Detection reasons:");
    for (const detection of plan.detections) {
      lines.push(`- ${detection.skill}: ${formatReasonList(detection)}`);
    }
  }

  return lines.join("\n");
}
