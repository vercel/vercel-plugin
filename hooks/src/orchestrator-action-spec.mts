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
  discoverable: boolean;
  visible: boolean;
  runnable: boolean;
  blockedReason: string | null;
  steps: OrchestratorStepSpec[];
}

function planActionMap(
  plan: SkillInstallPlan,
): Map<string, SkillInstallPlan["actions"][number]> {
  return new Map(plan.actions.map((action) => [action.id, action]));
}

function blockedReasonForAction(
  plan: SkillInstallPlan,
  actionId: OrchestratorRunnerActionId,
): string | null {
  switch (actionId) {
    case "bootstrap-project":
    case "install-missing":
    case "vercel-link":
      return null;
    case "vercel-env-pull":
      if (!plan.vercelLinked) {
        return "Link the project first; `vercel env pull` requires a linked Vercel project.";
      }
      if (plan.hasEnvLocal) {
        return "`.env.local` already exists; env pull is not needed.";
      }
      return null;
    case "vercel-deploy":
      return plan.vercelLinked
        ? null
        : "Link the project first; `vercel deploy` is only runnable after the project is linked.";
  }
}

function withRunState(
  plan: SkillInstallPlan,
  spec: Omit<OrchestratorActionSpec, "runnable" | "blockedReason">,
): OrchestratorActionSpec {
  const blockedReason = blockedReasonForAction(plan, spec.id);
  return {
    ...spec,
    runnable: blockedReason === null,
    blockedReason,
  };
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
    withRunState(plan, {
      id: "bootstrap-project",
      label: "Bootstrap project (link + env + skills)",
      description:
        "Link the project if needed, pull `.env.local` if missing, then install detected skills.",
      discoverable:
        !plan.vercelLinked ||
        !plan.hasEnvLocal ||
        plan.missingSkills.length > 0,
      visible:
        !plan.vercelLinked ||
        !plan.hasEnvLocal ||
        plan.missingSkills.length > 0,
      steps: [
        { step: "vercel-link", mode: "if-needed" },
        { step: "vercel-env-pull", mode: "if-needed" },
        { step: "install-missing", mode: "always" },
      ],
    }),
    withRunState(plan, {
      id: "install-missing",
      label: "Install missing skills into cache",
      description:
        installMissing?.description ?? "Install detected skills into the project skill cache.",
      discoverable: plan.missingSkills.length > 0,
      visible: plan.missingSkills.length > 0,
      steps: [{ step: "install-missing", mode: "always" }],
    }),
    withRunState(plan, {
      id: "vercel-link",
      label: vercelLink?.label ?? "Link Vercel project",
      description:
        vercelLink?.description ?? "Link this project to a Vercel project.",
      discoverable: !plan.vercelLinked,
      visible: !plan.vercelLinked,
      steps: [{ step: "vercel-link", mode: "always" }],
    }),
    withRunState(plan, {
      id: "vercel-env-pull",
      label: "Pull .env.local from Vercel",
      description:
        vercelEnvPull?.description ??
        "Pull `.env.local` from the linked Vercel project.",
      discoverable: !plan.hasEnvLocal,
      visible: plan.vercelLinked && !plan.hasEnvLocal,
      steps: [{ step: "vercel-env-pull", mode: "always" }],
    }),
    withRunState(plan, {
      id: "vercel-deploy",
      label: vercelDeploy?.label ?? "Deploy to Vercel",
      description:
        vercelDeploy?.description ??
        "Deploy the current project to Vercel.",
      discoverable: plan.vercelLinked,
      visible: plan.vercelLinked,
      steps: [{ step: "vercel-deploy", mode: "always" }],
    }),
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
