// hooks/src/orchestrator-install-plan.mts
import { buildSkillsAddCommand } from "./skills-cli-command.mjs";
import {
  buildVercelCliCommand
} from "./vercel-cli-command.mjs";
import { buildVercelCliCommand as buildVercelCliCommand2, vercelSubcommands } from "./vercel-cli-command.mjs";
function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
function formatReasonList(detection) {
  return detection.reasons.map((reason) => `${reason.kind}:${reason.source}`).join(", ");
}
function buildSkillInstallPlan(args) {
  const likelySkills = uniqueSorted(
    args.detections.map((d) => d.skill)
  );
  const installedSkills = uniqueSorted(args.installedSkills);
  const installedSet = new Set(installedSkills);
  const missingSkills = likelySkills.filter(
    (skill) => !installedSet.has(skill)
  );
  const installCommand = buildSkillsAddCommand(
    args.skillsSource,
    missingSkills,
    args.skillsAgent ?? "claude-code"
  )?.printable ?? null;
  const vercelLinked = args.vercelLinked ?? false;
  const hasEnvLocal = args.hasEnvLocal ?? false;
  const actions = [
    {
      id: "install-missing",
      label: "Install detected skills",
      description: missingSkills.length === 0 ? "All detected skills are already cached." : `Install ${missingSkills.length} missing skill${missingSkills.length === 1 ? "" : "s"} into .skills/.`,
      command: installCommand,
      default: !args.zeroBundleReady
    },
    {
      id: "activate-cache-only",
      label: "Use cache-only mode",
      description: args.zeroBundleReady ? "All detected skills are cached. This session can disable bundled fallback." : "Cache-only mode is blocked until the missing skills are installed.",
      command: args.zeroBundleReady ? "export VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK=1" : null,
      default: args.zeroBundleReady
    },
    {
      id: "explain",
      label: "Explain detections",
      description: "Open the persisted install plan with full detection reasons.",
      command: "cat .skills/install-plan.json"
    }
  ];
  if (!vercelLinked) {
    actions.push({
      id: "vercel-link",
      label: "Link Vercel project",
      description: "No .vercel/ directory found. Link this project to a Vercel project.",
      command: buildVercelCliCommand("link").printable
    });
  }
  if (!hasEnvLocal) {
    actions.push({
      id: "vercel-env-pull",
      label: "Pull environment variables",
      description: vercelLinked ? "Pull .env.local from the linked Vercel project." : "Link the project first, then pull .env.local.",
      command: vercelLinked ? buildVercelCliCommand("env-pull").printable : null
    });
  }
  actions.push({
    id: "vercel-deploy",
    label: "Deploy to Vercel",
    description: vercelLinked ? "Deploy the current project to Vercel." : "Link the project first, then deploy.",
    command: vercelLinked ? buildVercelCliCommand("deploy").printable : null
  });
  return {
    schemaVersion: 1,
    createdAt: (args.now ? args.now() : /* @__PURE__ */ new Date()).toISOString(),
    projectRoot: args.projectRoot,
    likelySkills,
    installedSkills,
    missingSkills,
    bundledFallbackEnabled: args.bundledFallbackEnabled,
    zeroBundleReady: args.zeroBundleReady,
    projectSkillManifestPath: args.projectSkillManifestPath ?? null,
    vercelLinked,
    hasEnvLocal,
    detections: [...args.detections].sort(
      (a, b) => a.skill.localeCompare(b.skill)
    ),
    actions
  };
}
function serializeSkillInstallPlan(plan) {
  return JSON.stringify(plan);
}
function formatSkillInstallPalette(plan) {
  if (plan.likelySkills.length === 0) return null;
  const lines = [
    "### Vercel skill orchestrator",
    `- Detected: ${plan.likelySkills.join(", ")}`,
    `- Cached: ${plan.installedSkills.length > 0 ? plan.installedSkills.join(", ") : "none"}`,
    `- Missing: ${plan.missingSkills.length > 0 ? plan.missingSkills.join(", ") : "none"}`,
    `- Zero-bundle ready: ${plan.zeroBundleReady ? "yes" : "no"}`,
    `- Cache manifest: ${plan.projectSkillManifestPath ?? "none"}`
  ];
  const installAction = plan.actions.find(
    (action) => action.id === "install-missing"
  );
  if (installAction?.command) {
    lines.push(`- [1] Install now: ${installAction.command}`);
  }
  const cacheOnlyAction = plan.actions.find(
    (action) => action.id === "activate-cache-only"
  );
  if (cacheOnlyAction?.command) {
    lines.push(`- [2] Cache only: ${cacheOnlyAction.command}`);
  }
  lines.push("- [3] Explain: cat .skills/install-plan.json");
  const vercelLinkAction = plan.actions.find(
    (action) => action.id === "vercel-link"
  );
  if (vercelLinkAction?.command) {
    lines.push(`- [4] Link project: ${vercelLinkAction.command}`);
  }
  const envPullAction = plan.actions.find(
    (action) => action.id === "vercel-env-pull"
  );
  if (envPullAction?.command) {
    lines.push(`- [5] Pull env: ${envPullAction.command}`);
  }
  const deployAction = plan.actions.find(
    (action) => action.id === "vercel-deploy"
  );
  if (deployAction?.command) {
    lines.push(`- [6] Deploy: ${deployAction.command}`);
  }
  if (plan.detections.length > 0) {
    lines.push("", "Detection reasons:");
    for (const detection of plan.detections) {
      lines.push(`- ${detection.skill}: ${formatReasonList(detection)}`);
    }
  }
  return lines.join("\n");
}
export {
  buildSkillInstallPlan,
  buildVercelCliCommand2 as buildVercelCliCommand,
  formatSkillInstallPalette,
  serializeSkillInstallPlan,
  vercelSubcommands
};
