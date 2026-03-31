// hooks/src/skills-cli-command.mts
var DEFAULT_SOURCE = "vercel/vercel-skills";
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
    printable: ["npx", ...args].join(" ")
  };
}
export {
  buildSkillsAddCommand
};
