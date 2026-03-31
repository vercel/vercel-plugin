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
function buildVercelCliCommand(subcommand, options = {}) {
  const spec = SUBCOMMAND_SPECS[subcommand];
  const binary = options.binary ?? (process.platform === "win32" ? "vercel.cmd" : "vercel");
  const extraFlags = options.flags ?? [];
  const args = [...spec.args, ...spec.defaultFlags, ...extraFlags];
  return {
    file: binary,
    args,
    printable: ["vercel", ...args].join(" ")
  };
}
function vercelSubcommands() {
  return Object.keys(SUBCOMMAND_SPECS);
}
export {
  buildVercelCliCommand,
  vercelSubcommands
};
