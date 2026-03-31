// hooks/src/skills-cli-command.mts
var DEFAULT_SOURCE = "vercel/vercel-skills";
var SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;
function quoteShellArg(value) {
  return SAFE_SHELL_ARG_RE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
function buildSkillsAddCommand(source, skillNames, agent = "claude-code") {
  const resolvedSource = (source ?? "").trim() || DEFAULT_SOURCE;
  const skills = [
    ...new Set(skillNames.map((s) => s.trim()).filter(Boolean))
  ].sort();
  if (skills.length === 0) return null;
  const file = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "skills",
    "add",
    resolvedSource,
    ...skills.flatMap((skill) => ["--skill", skill]),
    "--agent",
    agent,
    "-y",
    "--copy"
  ];
  return {
    file,
    args,
    printable: ["npx", ...args].map(quoteShellArg).join(" ")
  };
}
export {
  buildSkillsAddCommand
};
