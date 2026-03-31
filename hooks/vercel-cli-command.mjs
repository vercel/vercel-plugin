// hooks/src/vercel-cli-command.mts
var SUBCOMMAND_SPECS = {
  "env-pull": {
    args: ["env", "pull"],
    defaultFlags: ["--yes"]
  },
  link: {
    args: ["link"],
    defaultFlags: ["--yes"]
  },
  deploy: {
    args: ["deploy"],
    defaultFlags: []
  }
};
var SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;
function quoteShellArg(value) {
  return SAFE_SHELL_ARG_RE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
function buildVercelCliCommand(subcommand, options = {}) {
  const spec = SUBCOMMAND_SPECS[subcommand];
  const binary = options.binary ?? (process.platform === "win32" ? "vercel.cmd" : "vercel");
  const extraFlags = options.flags ?? [];
  const args = [...spec.args, ...spec.defaultFlags, ...extraFlags];
  return {
    file: binary,
    args,
    printable: ["vercel", ...args].map(quoteShellArg).join(" ")
  };
}
function vercelSubcommands() {
  return Object.keys(SUBCOMMAND_SPECS);
}
export {
  buildVercelCliCommand,
  vercelSubcommands
};
