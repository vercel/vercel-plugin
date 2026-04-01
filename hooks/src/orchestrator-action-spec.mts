/**
 * Orchestrator Action Spec — shared wrapper metadata and step ordering.
 *
 * This keeps the wrapper palette and the wrapper runner in sync:
 * - the palette asks "what should I show?"
 * - the runner asks "what steps should I execute?"
 */

import type { SkillInstallPlan } from "./orchestrator-install-plan.mjs";
import type { OrchestratorRunnerActionId } from "./orchestrator-action-command.mjs";

export type OrchestratorDelegatedStep =
  | "install-missing"
  | "vercel-link"
  | "vercel-env-pull"
  | "vercel-deploy";

export type OrchestratorStepMode = "always" | "if-needed";

export interface OrchestratorStepSpec {
  step: OrchestratorDelegatedStep;
  mode: OrchestratorStepMode;
}

export interface OrchestratorActionSpec {
  id: OrchestratorRunnerActionId;
  label: string;
  description: string;
  visible: boolean;
  steps: OrchestratorStepSpec[];
}

function planActionMap(
  plan: SkillInstallPlan,
): Map<string, SkillInstallPlan["actions"][number]> {
  return new Map(plan.actions.map((action) => [action.id, action]));
}

export function getOrchestratorActionSpecs(
  plan: SkillInstallPlan,
): OrchestratorActionSpec[] {
  const actions = planActionMap(plan);

  const installMissing = actions.get("install-missing");
  const vercelLink = actions.get("vercel-link");
  const vercelEnvPull = actions.get("vercel-env-pull");
  const vercelDeploy = actions.get("vercel-deploy");

  return [
    {
      id: "bootstrap-project",
      label: "Bootstrap project (link + env + skills)",
      description:
        "Link the project if needed, pull `.env.local` if missing, then install detected skills.",
      visible:
        !plan.vercelLinked ||
        !plan.hasEnvLocal ||
        plan.missingSkills.length > 0,
      steps: [
        { step: "vercel-link", mode: "if-needed" },
        { step: "vercel-env-pull", mode: "if-needed" },
        { step: "install-missing", mode: "always" },
      ],
    },
    {
      id: "install-missing",
      label: "Install missing skills into .skills",
      description:
        installMissing?.description ?? "Install detected skills into `.skills/`.",
      visible: plan.missingSkills.length > 0,
      steps: [{ step: "install-missing", mode: "always" }],
    },
    {
      id: "vercel-link",
      label: vercelLink?.label ?? "Link Vercel project",
      description:
        vercelLink?.description ?? "Link this project to a Vercel project.",
      visible: !plan.vercelLinked,
      steps: [{ step: "vercel-link", mode: "always" }],
    },
    {
      id: "vercel-env-pull",
      label: "Pull .env.local from Vercel",
      description:
        vercelEnvPull?.description ??
        "Pull `.env.local` from the linked Vercel project.",
      visible: plan.vercelLinked && !plan.hasEnvLocal,
      steps: [{ step: "vercel-env-pull", mode: "always" }],
    },
    {
      id: "vercel-deploy",
      label: vercelDeploy?.label ?? "Deploy to Vercel",
      description:
        vercelDeploy?.description ??
        "Deploy the current project to Vercel.",
      visible: plan.vercelLinked,
      steps: [{ step: "vercel-deploy", mode: "always" }],
    },
  ];
}

export function getOrchestratorActionSpec(
  plan: SkillInstallPlan,
  actionId: OrchestratorRunnerActionId,
): OrchestratorActionSpec {
  const spec = getOrchestratorActionSpecs(plan).find(
    (entry) => entry.id === actionId,
  );
  if (!spec) {
    throw new Error(`Invalid --action: ${actionId}`);
  }
  return spec;
}
