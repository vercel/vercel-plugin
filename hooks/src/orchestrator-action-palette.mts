/**
 * Orchestrator Action Palette — wrapper-specific command palette.
 *
 * Renders a second palette block (beside the existing raw-CLI palette)
 * with copy-pasteable `node orchestrator-action-runner.mjs` invocations.
 * The existing [1]-[6] numbered palette is not modified.
 */

import type { SkillInstallPlan } from "./orchestrator-install-plan.mjs";
import { buildOrchestratorRunnerCommand } from "./orchestrator-action-command.mjs";
import { getOrchestratorActionSpecs } from "./orchestrator-action-spec.mjs";

export function formatOrchestratorActionPalette(args: {
  pluginRoot: string;
  plan: SkillInstallPlan;
}): string | null {
  const visibleActions = getOrchestratorActionSpecs(args.plan).filter(
    (entry) => entry.visible,
  );

  if (visibleActions.length === 0) {
    return null;
  }

  const lines = [
    "### Vercel wrapper palette",
    "- These commands run the real `npx skills` / `vercel` CLIs and print a readable wrapper summary.",
  ];

  for (const [index, entry] of visibleActions.entries()) {
    const command = buildOrchestratorRunnerCommand({
      pluginRoot: args.pluginRoot,
      projectRoot: args.plan.projectRoot,
      actionId: entry.id,
      json: false,
    });
    lines.push(`- [${index + 1}] ${entry.label}: \`${command}\``);
    lines.push(`  ${entry.description}`);
  }

  return lines.join("\n");
}
