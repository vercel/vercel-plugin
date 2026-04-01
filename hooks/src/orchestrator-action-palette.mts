/**
 * Orchestrator Action Palette — wrapper-specific command palette.
 *
 * Renders a second palette block (beside the existing raw-CLI palette)
 * with copy-pasteable `node orchestrator-action-runner.mjs` invocations.
 * The existing [1]-[6] numbered palette is not modified.
 */

import type { SkillInstallPlan } from "./orchestrator-install-plan.mjs";
import {
  buildOrchestratorRunnerCommand,
  type OrchestratorRunnerActionId,
} from "./orchestrator-action-command.mjs";

// ---------------------------------------------------------------------------
// Visibility rules
// ---------------------------------------------------------------------------

function shouldShowAction(
  plan: SkillInstallPlan,
  actionId: OrchestratorRunnerActionId,
): boolean {
  switch (actionId) {
    case "bootstrap-project":
      return (
        !plan.vercelLinked ||
        !plan.hasEnvLocal ||
        plan.missingSkills.length > 0
      );
    case "install-missing":
      return plan.missingSkills.length > 0;
    case "vercel-link":
      return !plan.vercelLinked;
    case "vercel-env-pull":
      return plan.vercelLinked && !plan.hasEnvLocal;
    case "vercel-deploy":
      return plan.vercelLinked;
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export function formatOrchestratorActionPalette(args: {
  pluginRoot: string;
  plan: SkillInstallPlan;
}): string | null {
  const ordered: Array<{
    id: OrchestratorRunnerActionId;
    label: string;
  }> = [
    { id: "bootstrap-project", label: "Bootstrap project (link + env + skills)" },
    { id: "install-missing", label: "Install missing skills into .skills" },
    { id: "vercel-link", label: "Link Vercel project" },
    { id: "vercel-env-pull", label: "Pull .env.local from Vercel" },
    { id: "vercel-deploy", label: "Deploy to Vercel" },
  ];

  const planActionById = new Map(
    args.plan.actions.map((action) => [action.id, action] as const),
  );

  const descriptionById: Record<OrchestratorRunnerActionId, string> = {
    "bootstrap-project":
      "Link the project if needed, pull `.env.local` if missing, then install detected skills.",
    "install-missing":
      planActionById.get("install-missing")?.description ??
      "Install detected skills into `.skills/`.",
    "vercel-link":
      planActionById.get("vercel-link")?.description ??
      "Link this project to a Vercel project.",
    "vercel-env-pull":
      planActionById.get("vercel-env-pull")?.description ??
      "Pull `.env.local` from the linked Vercel project.",
    "vercel-deploy":
      planActionById.get("vercel-deploy")?.description ??
      "Deploy the current project to Vercel.",
  };

  const lines = [
    "### Vercel wrapper palette",
    "- These commands run the real `npx skills` / `vercel` CLIs and print a readable wrapper summary.",
  ];
  let index = 1;

  for (const entry of ordered) {
    if (!shouldShowAction(args.plan, entry.id)) continue;
    const command = buildOrchestratorRunnerCommand({
      pluginRoot: args.pluginRoot,
      projectRoot: args.plan.projectRoot,
      actionId: entry.id,
      json: false,
    });
    lines.push(`- [${index}] ${entry.label}: \`${command}\``);
    lines.push(`  ${descriptionById[entry.id]}`);
    index += 1;
  }

  return index === 1 ? null : lines.join("\n");
}
