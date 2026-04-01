/**
 * Orchestrator Action Command — builds copy-pasteable runner invocations.
 *
 * Kept separate from the runner itself so palette rendering doesn't
 * import the full execution graph.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestratorRunnerActionId =
  | "bootstrap-project"
  | "install-missing"
  | "vercel-link"
  | "vercel-env-pull"
  | "vercel-deploy";

export const ORCHESTRATOR_ACTION_IDS: readonly OrchestratorRunnerActionId[] = [
  "bootstrap-project",
  "install-missing",
  "vercel-link",
  "vercel-env-pull",
  "vercel-deploy",
];

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;

function quoteShellArg(value: string): string {
  return SAFE_SHELL_ARG_RE.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export function buildOrchestratorRunnerCommand(args: {
  pluginRoot: string;
  projectRoot: string;
  actionId: OrchestratorRunnerActionId;
  json?: boolean;
}): string {
  const runnerPath = `${args.pluginRoot}/hooks/orchestrator-action-runner.mjs`;
  const argv = [
    "node",
    runnerPath,
    "--project-root",
    args.projectRoot,
    "--action",
    args.actionId,
  ];
  if (args.json !== false) {
    argv.push("--json");
  }
  return argv.map(quoteShellArg).join(" ");
}
