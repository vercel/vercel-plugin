// hooks/src/orchestrator-action-runner.mts
import { existsSync } from "fs";
import { join } from "path";
import {
  createRegistryClient
} from "./registry-client.mjs";
import {
  createVercelCliDelegator
} from "./vercel-cli-delegator.mjs";
import {
  requirePersistedSkillInstallPlan,
  refreshPersistedSkillInstallPlan
} from "./orchestrator-install-plan-state.mjs";
async function runOrchestratorAction(args) {
  let plan = requirePersistedSkillInstallPlan({
    projectRoot: args.projectRoot
  });
  const registryClient = args.registryClient ?? createRegistryClient();
  const vercelDelegator = args.vercelDelegator ?? createVercelCliDelegator();
  const state = { commands: [], vercelResults: [], installResult: null };
  async function runVercel(subcommand) {
    const result = await vercelDelegator.run({
      projectRoot: args.projectRoot,
      subcommand
    });
    state.vercelResults.push(result);
    state.commands.push(result.command);
    return result;
  }
  async function runInstallMissing() {
    plan = refreshPersistedSkillInstallPlan({
      projectRoot: args.projectRoot,
      previousPlan: plan
    });
    if (plan.missingSkills.length === 0) {
      return null;
    }
    const result = await registryClient.installSkills({
      projectRoot: args.projectRoot,
      skillNames: plan.missingSkills
    });
    state.installResult = result;
    if (result.command) {
      state.commands.push(result.command);
    }
    return result;
  }
  switch (args.actionId) {
    case "bootstrap-project": {
      if (!existsSync(join(args.projectRoot, ".vercel"))) {
        await runVercel("link");
      }
      if (existsSync(join(args.projectRoot, ".vercel")) && !existsSync(join(args.projectRoot, ".env.local"))) {
        await runVercel("env-pull");
      }
      await runInstallMissing();
      break;
    }
    case "install-missing":
      await runInstallMissing();
      break;
    case "vercel-link":
      await runVercel("link");
      break;
    case "vercel-env-pull":
      await runVercel("env-pull");
      break;
    case "vercel-deploy":
      await runVercel("deploy");
      break;
  }
  const refreshedPlan = refreshPersistedSkillInstallPlan({
    projectRoot: args.projectRoot,
    previousPlan: plan
  });
  const ok = state.vercelResults.every((result) => result.ok) && (state.installResult ? state.installResult.missing.length === 0 : true);
  return {
    schemaVersion: 1,
    type: "vercel-plugin-orchestrator-action-result",
    ok,
    actionId: args.actionId,
    projectRoot: args.projectRoot,
    commands: state.commands,
    installResult: state.installResult,
    vercelResults: state.vercelResults,
    refreshedPlan
  };
}
function getRequiredArg(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}
async function main() {
  const projectRoot = getRequiredArg("--project-root");
  const actionId = getRequiredArg(
    "--action"
  );
  const result = await runOrchestratorAction({ projectRoot, actionId });
  const wantJson = process.argv.includes("--json");
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  process.stdout.write(
    [
      `ok=${result.ok}`,
      `action=${result.actionId}`,
      ...result.commands.map((command) => `command=${command}`),
      `missing=${result.refreshedPlan.missingSkills.join(",")}`
    ].join("\n") + "\n"
  );
  process.exitCode = result.ok ? 0 : 1;
}
var isEntrypoint = process.argv[1]?.endsWith("/orchestrator-action-runner.mjs") ?? false;
if (isEntrypoint) {
  await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  });
}
export {
  runOrchestratorAction
};
