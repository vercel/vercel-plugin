/**
 * Skills CLI command builder — constructs `npx skills add` invocations.
 *
 * Single source of truth for the CLI command shape used by:
 * - registry-client.mts (subprocess execution)
 * - orchestrator-install-plan.mts (plan action commands)
 * - skill-cache-banner.mts (user-facing install suggestions)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillsAddCommand {
  file: string;
  args: string[];
  printable: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE = "vercel/vercel-skills";
const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;

function quoteShellArg(value: string): string {
  return SAFE_SHELL_ARG_RE.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildSkillsAddCommand(
  source: string | undefined,
  skillNames: string[],
  agent = "claude-code",
): SkillsAddCommand | null {
  const resolvedSource = (source ?? "").trim() || DEFAULT_SOURCE;
  const skills = [
    ...new Set(skillNames.map((s) => s.trim()).filter(Boolean)),
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
    "--copy",
  ];

  return {
    file,
    args,
    printable: ["npx", ...args].map(quoteShellArg).join(" "),
  };
}
