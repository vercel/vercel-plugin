/**
 * Orchestrator Action Runner — explicit-only execution layer.
 *
 * Reads the persisted `.skills/install-plan.json`, delegates to the
 * existing registry-client (npx skills) and vercel-cli-delegator
 * adapters, then refreshes the plan from on-disk state.
 *
 * Not auto-invoked from any hook path — called explicitly via CLI
 * or agent Bash execution.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createRegistryClient,
  type InstallSkillsResult,
  type RegistryClient,
} from "./registry-client.mjs";
import {
  createVercelCliDelegator,
  type VercelCliDelegator,
  type VercelCliRunResult,
} from "./vercel-cli-delegator.mjs";
import type { SkillInstallPlan } from "./orchestrator-install-plan.mjs";
import {
  requirePersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan,
} from "./orchestrator-install-plan-state.mjs";
import {
  ORCHESTRATOR_ACTION_IDS,
  type OrchestratorRunnerActionId,
} from "./orchestrator-action-command.mjs";
import {
  getOrchestratorActionSpec,
  type OrchestratorStepSpec,
} from "./orchestrator-action-spec.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorActionRunResult {
  schemaVersion: 1;
  type: "vercel-plugin-orchestrator-action-result";
  ok: boolean;
  actionId: OrchestratorRunnerActionId;
  projectRoot: string;
  commands: string[];
  installResult: InstallSkillsResult | null;
  vercelResults: VercelCliRunResult[];
  refreshedPlan: SkillInstallPlan;
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type OrchestratorActionRunErrorCode =
  | "MISSING_INSTALL_PLAN"
  | "INVALID_ACTION"
  | "RUNNER_ERROR";

export interface OrchestratorActionRunError {
  schemaVersion: 1;
  type: "vercel-plugin-orchestrator-action-error";
  ok: false;
  code: OrchestratorActionRunErrorCode;
  message: string;
  hint: string | null;
  actionId: OrchestratorRunnerActionId | null;
  projectRoot: string | null;
}

function classifyOrchestratorActionError(
  error: unknown,
): OrchestratorActionRunErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Missing install plan")) {
    return "MISSING_INSTALL_PLAN";
  }
  if (message.includes("Invalid --action")) {
    return "INVALID_ACTION";
  }
  return "RUNNER_ERROR";
}

export function buildOrchestratorActionError(args: {
  error: unknown;
  actionId: OrchestratorRunnerActionId | null;
  projectRoot: string | null;
}): OrchestratorActionRunError {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  const code = classifyOrchestratorActionError(args.error);
  return {
    schemaVersion: 1,
    type: "vercel-plugin-orchestrator-action-error",
    ok: false,
    code,
    message,
    hint:
      code === "MISSING_INSTALL_PLAN"
        ? "Run SessionStart first so .skills/install-plan.json exists before calling the wrapper."
        : code === "INVALID_ACTION"
          ? `Use one of: ${ORCHESTRATOR_ACTION_IDS.join(", ")}`
          : "Inspect the delegated CLI output, fix the failing step, then rerun this wrapper action.",
    actionId: args.actionId,
    projectRoot: args.projectRoot,
  };
}

// ---------------------------------------------------------------------------
// Human output formatters
// ---------------------------------------------------------------------------

function deriveHumanStatus(result: OrchestratorActionRunResult): string {
  if (result.ok) return "success";
  const hasPartialProgress =
    result.vercelResults.some((entry) => entry.ok) ||
    (result.installResult
      ? result.installResult.installed.length > 0 ||
        result.installResult.reused.length > 0
      : false);
  return hasPartialProgress ? "partial" : "failed";
}

function formatVercelResultLine(result: VercelCliRunResult): string {
  if (result.ok) {
    return `- ${result.subcommand}: ok (\`${result.command}\`)`;
  }
  const detail = result.stderr.trim() || "delegated CLI failed";
  return `- ${result.subcommand}: failed (\`${result.command}\`) — ${detail}`;
}

function formatNextStep(plan: SkillInstallPlan): string {
  if (!plan.vercelLinked) {
    return "Run the wrapper's `vercel-link` action next.";
  }
  if (!plan.hasEnvLocal) {
    return "Run the wrapper's `vercel-env-pull` action next.";
  }
  if (plan.missingSkills.length > 0) {
    return `Rerun \`install-missing\` after fixing the CLI/auth issue for: ${plan.missingSkills.join(", ")}.`;
  }
  if (plan.zeroBundleReady) {
    return "Project cache is ready; cache-only mode can be enabled if desired.";
  }
  return "Wrapper action completed.";
}

export function formatOrchestratorActionHumanOutput(
  result: OrchestratorActionRunResult,
): string {
  const lines: string[] = [
    "### Vercel wrapper result",
    `- Status: ${deriveHumanStatus(result)}`,
    `- Action: ${result.actionId}`,
    `- Linked: ${result.refreshedPlan.vercelLinked ? "yes" : "no"}`,
    `- .env.local: ${result.refreshedPlan.hasEnvLocal ? "present" : "missing"}`,
    `- Missing skills: ${
      result.refreshedPlan.missingSkills.length > 0
        ? result.refreshedPlan.missingSkills.join(", ")
        : "none"
    }`,
  ];

  if (result.commands.length > 0) {
    lines.push(`- Commands run: ${result.commands.length}`);
  }

  for (const entry of result.vercelResults) {
    lines.push(formatVercelResultLine(entry));
  }

  if (result.installResult?.installed.length) {
    lines.push(
      `- Installed now: ${result.installResult.installed.join(", ")}`,
    );
  }
  if (result.installResult?.reused.length) {
    lines.push(
      `- Already cached: ${result.installResult.reused.join(", ")}`,
    );
  }
  if (result.installResult?.missing.length) {
    lines.push(
      `- Still missing: ${result.installResult.missing.join(", ")}`,
    );
  }

  lines.push(`- Next: ${formatNextStep(result.refreshedPlan)}`);

  return lines.join("\n");
}

export function formatOrchestratorActionErrorHumanOutput(
  error: OrchestratorActionRunError,
): string {
  return [
    "### Vercel wrapper result",
    "- Status: failed",
    error.actionId ? `- Action: ${error.actionId}` : null,
    error.projectRoot ? `- Project: ${error.projectRoot}` : null,
    `- Error: ${error.message}`,
    error.hint ? `- Next: ${error.hint}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runOrchestratorAction(args: {
  projectRoot: string;
  actionId: OrchestratorRunnerActionId;
  registryClient?: RegistryClient;
  vercelDelegator?: VercelCliDelegator;
}): Promise<OrchestratorActionRunResult> {
  let plan = requirePersistedSkillInstallPlan({
    projectRoot: args.projectRoot,
  });

  const spec = getOrchestratorActionSpec(plan, args.actionId);
  const registryClient = args.registryClient ?? createRegistryClient();
  const vercelDelegator = args.vercelDelegator ?? createVercelCliDelegator();

  const state: {
    commands: string[];
    vercelResults: VercelCliRunResult[];
    installResult: InstallSkillsResult | null;
  } = { commands: [], vercelResults: [], installResult: null };

  async function refreshPlan(): Promise<SkillInstallPlan> {
    plan = refreshPersistedSkillInstallPlan({
      projectRoot: args.projectRoot,
      previousPlan: plan,
    });
    return plan;
  }

  async function runVercel(subcommand: "link" | "env-pull" | "deploy") {
    const result = await vercelDelegator.run({
      projectRoot: args.projectRoot,
      subcommand,
    });
    state.vercelResults.push(result);
    state.commands.push(result.command);
    return result;
  }

  async function runInstallMissing() {
    await refreshPlan();
    if (plan.missingSkills.length === 0) {
      return null;
    }
    const result = await registryClient.installSkills({
      projectRoot: args.projectRoot,
      skillNames: plan.missingSkills,
    });
    state.installResult = result;
    if (result.command) {
      state.commands.push(result.command);
    }
    return result;
  }

  async function runStep(stepSpec: OrchestratorStepSpec): Promise<void> {
    switch (stepSpec.step) {
      case "vercel-link": {
        const alreadyLinked = existsSync(join(args.projectRoot, ".vercel"));
        if (stepSpec.mode === "if-needed" && alreadyLinked) {
          return;
        }
        await runVercel("link");
        return;
      }
      case "vercel-env-pull": {
        const linked = existsSync(join(args.projectRoot, ".vercel"));
        const hasEnvLocal = existsSync(
          join(args.projectRoot, ".env.local"),
        );
        if (stepSpec.mode === "if-needed" && (!linked || hasEnvLocal)) {
          return;
        }
        await runVercel("env-pull");
        return;
      }
      case "install-missing":
        await runInstallMissing();
        return;
      case "vercel-deploy":
        await runVercel("deploy");
        return;
    }
  }

  for (const step of spec.steps) {
    await runStep(step);
  }

  const refreshedPlan = await refreshPlan();

  const ok =
    state.vercelResults.every((result) => result.ok) &&
    (state.installResult ? state.installResult.missing.length === 0 : true);

  return {
    schemaVersion: 1,
    type: "vercel-plugin-orchestrator-action-result",
    ok,
    actionId: args.actionId,
    projectRoot: args.projectRoot,
    commands: state.commands,
    installResult: state.installResult,
    vercelResults: state.vercelResults,
    refreshedPlan,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function getOptionalArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function getRequiredArg(flag: string): string {
  const value = getOptionalArg(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

function isOrchestratorActionId(
  value: string,
): value is OrchestratorRunnerActionId {
  return ORCHESTRATOR_ACTION_IDS.includes(
    value as OrchestratorRunnerActionId,
  );
}

async function main(): Promise<void> {
  const projectRoot = getRequiredArg("--project-root");
  const rawAction = getRequiredArg("--action");
  if (!isOrchestratorActionId(rawAction)) {
    throw new Error(`Invalid --action: ${rawAction}`);
  }

  const result = await runOrchestratorAction({ projectRoot, actionId: rawAction });

  const wantJson = process.argv.includes("--json");
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  process.stdout.write(formatOrchestratorActionHumanOutput(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

const isEntrypoint =
  process.argv[1]?.endsWith("/orchestrator-action-runner.mjs") ?? false;

if (isEntrypoint) {
  const wantJson = process.argv.includes("--json");
  const projectRoot = getOptionalArg("--project-root");
  const rawAction = getOptionalArg("--action");
  const actionId =
    rawAction && isOrchestratorActionId(rawAction) ? rawAction : null;

  await main().catch((error: unknown) => {
    const formatted = buildOrchestratorActionError({
      error,
      actionId,
      projectRoot,
    });
    if (wantJson) {
      process.stdout.write(JSON.stringify(formatted, null, 2) + "\n");
    } else {
      process.stderr.write(
        formatOrchestratorActionErrorHumanOutput(formatted) + "\n",
      );
    }
    process.exitCode = 1;
  });
}
