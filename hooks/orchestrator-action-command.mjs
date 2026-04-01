// hooks/src/orchestrator-action-command.mts
var ORCHESTRATOR_ACTION_IDS = [
  "bootstrap-project",
  "install-missing",
  "vercel-link",
  "vercel-env-pull",
  "vercel-deploy"
];
var SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;
function quoteShellArg(value) {
  return SAFE_SHELL_ARG_RE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
function buildOrchestratorRunnerCommand(args) {
  const runnerPath = `${args.pluginRoot}/hooks/orchestrator-action-runner.mjs`;
  const argv = [
    "node",
    runnerPath,
    "--project-root",
    args.projectRoot,
    "--action",
    args.actionId
  ];
  if (args.json !== false) {
    argv.push("--json");
  }
  return argv.map(quoteShellArg).join(" ");
}
export {
  ORCHESTRATOR_ACTION_IDS,
  buildOrchestratorRunnerCommand
};
