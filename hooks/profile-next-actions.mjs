// hooks/src/profile-next-actions.mts
import {
  buildOrchestratorRunnerCommand
} from "./orchestrator-action-command.mjs";
import { getOrchestratorActionSpecs } from "./orchestrator-action-spec.mjs";
var FAST_LANE_ACTION_IDS = [
  "bootstrap-project",
  "install-missing",
  "vercel-link",
  "vercel-env-pull",
  "vercel-deploy"
];
function isFastLaneActionId(value) {
  return FAST_LANE_ACTION_IDS.includes(value);
}
function buildProfileNextActions(args) {
  const visibleSpecs = getOrchestratorActionSpecs(args.installPlan).filter(
    (spec) => spec.visible && isFastLaneActionId(spec.id)
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
      json: false
    }),
    priority: total - index
  }));
}
export {
  buildProfileNextActions
};
