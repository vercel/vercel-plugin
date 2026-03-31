/**
 * Orchestrator Install Plan — machine-readable skill detection and install plan.
 *
 * Produces a structured plan that describes which skills were detected,
 * which are already cached, and which are missing. The plan is both
 * persisted to `.skills/install-plan.json` and surfaced as a human-readable
 * palette in SessionStart output.
 */

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
  id: "install-missing" | "explain" | "offline";
  label: string;
  description: string;
  command: string | null;
  default?: boolean;
}

export interface SkillInstallPlan {
  schemaVersion: 1;
  createdAt: string;
  projectRoot: string;
  likelySkills: string[];
  installedSkills: string[];
  missingSkills: string[];
  bundledFallbackEnabled: boolean;
  detections: SkillDetection[];
  actions: SkillInstallAction[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  now?: () => Date;
}): SkillInstallPlan {
  const likelySkills = uniqueSorted(
    args.detections.map((d) => d.skill),
  );
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill),
  );

  const installCommand =
    missingSkills.length === 0
      ? null
      : `npx skills install ${missingSkills.join(" ")} --dir .skills`;

  return {
    schemaVersion: 1,
    createdAt: (args.now ? args.now() : new Date()).toISOString(),
    projectRoot: args.projectRoot,
    likelySkills,
    installedSkills,
    missingSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    detections: [...args.detections].sort((a, b) =>
      a.skill.localeCompare(b.skill),
    ),
    actions: [
      {
        id: "install-missing",
        label: "Install detected skills",
        description:
          missingSkills.length === 0
            ? "All detected skills are already cached."
            : `Install ${missingSkills.length} missing skill${missingSkills.length === 1 ? "" : "s"} into .skills/.`,
        command: installCommand,
        default: true,
      },
      {
        id: "explain",
        label: "Explain detections",
        description:
          "Open the persisted install plan with full detection reasons.",
        command: "cat .skills/install-plan.json",
      },
      {
        id: "offline",
        label: "Work offline from cache",
        description: args.bundledFallbackEnabled
          ? "Disable bundled fallback and rely on cached skills only."
          : "Bundled fallback is already disabled.",
        command: "export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1",
      },
    ],
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
  ];

  const installAction = plan.actions.find(
    (action) => action.id === "install-missing",
  );
  if (installAction?.command) {
    lines.push(`- [1] Install now: ${installAction.command}`);
  }

  lines.push("- [2] Explain: cat .skills/install-plan.json");
  lines.push(
    "- [3] Offline cache only: export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1",
  );

  if (plan.detections.length > 0) {
    lines.push("", "Detection reasons:");
    for (const detection of plan.detections) {
      lines.push(`- ${detection.skill}: ${formatReasonList(detection)}`);
    }
  }

  return lines.join("\n");
}
