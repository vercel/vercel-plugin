/**
 * Profile Next Actions — shared builder for Fast Lane cache entries.
 *
 * Derives Fast Lane entries from `getOrchestratorActionSpecs(installPlan)`,
 * keeps only visible Fast Lane action IDs, preserves spec order via
 * descending numeric priority, and emits `buildOrchestratorRunnerCommand(...)`
 * for every returned action.
 */

import type { SkillInstallPlan } from "./orchestrator-install-plan.mjs";
import {
  buildOrchestratorRunnerCommand,
  type OrchestratorRunnerActionId,
} from "./orchestrator-action-command.mjs";
import { getOrchestratorActionSpecs } from "./orchestrator-action-spec.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileNextAction {
  id: OrchestratorRunnerActionId;
  title: string;
  reason: string;
  command: string | null;
  priority: number;
}

// ---------------------------------------------------------------------------
// Fast Lane visibility filter
// ---------------------------------------------------------------------------

const FAST_LANE_ACTION_IDS: readonly OrchestratorRunnerActionId[] = [
  "bootstrap-project",
  "install-missing",
  "vercel-link",
  "vercel-env-pull",
  "vercel-deploy",
];

function isFastLaneActionId(
  value: string,
): value is OrchestratorRunnerActionId {
  return (FAST_LANE_ACTION_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildProfileNextActions(args: {
  pluginRoot: string;
  projectRoot: string;
  installPlan: SkillInstallPlan;
}): ProfileNextAction[] {
  const visibleSpecs = getOrchestratorActionSpecs(args.installPlan).filter(
    (spec) => spec.visible && isFastLaneActionId(spec.id),
  );

  const total = visibleSpecs.length;

  return visibleSpecs.map((spec, index) => ({
    id: spec.id,
    title: spec.label,
    reason: spec.description,
    command: buildOrchestratorRunnerCommand({
      pluginRoot: args.pluginRoot,
      projectRoot: args.projectRoot,
      actionId: spec.id,
      json: false,
    }),
    priority: total - index,
  }));
}
