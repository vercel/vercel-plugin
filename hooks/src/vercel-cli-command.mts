/**
 * Vercel CLI command builder — constructs `vercel` subcommand invocations.
 *
 * Single source of truth for the CLI command shape used by:
 * - session-start-profiler.mts (detection → delegation)
 * - orchestrator-install-plan.mts (plan action commands)
 *
 * Mirrors the subprocess abstraction in skills-cli-command.mts so both
 * CLI families use the same { file, args, printable } contract and the
 * same injectable execFile pattern for testing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VercelSubcommand = "env-pull" | "link" | "deploy";

export interface VercelCliCommand {
  file: string;
  args: string[];
  printable: string;
}

export interface VercelCliCommandOptions {
  /** Additional CLI flags appended after the subcommand args. */
  flags?: string[];
  /**
   * Project root passed as `--cwd` when set.
   * Not included in the command by default — callers set `cwd` on the
   * subprocess instead.
   */
  cwd?: string;
  /** Override the vercel binary name (default: "vercel" / "vercel.cmd"). */
  binary?: string;
}

// ---------------------------------------------------------------------------
// Subcommand definitions
// ---------------------------------------------------------------------------

interface SubcommandSpec {
  /** CLI positional args for this subcommand. */
  args: string[];
  /** Default flags that ensure non-interactive, automation-safe execution. */
  defaultFlags: string[];
}

const SUBCOMMAND_SPECS: Record<VercelSubcommand, SubcommandSpec> = {
  "env-pull": {
    args: ["env", "pull"],
    defaultFlags: ["--yes"],
  },
  link: {
    args: ["link"],
    defaultFlags: ["--yes"],
  },
  deploy: {
    args: ["deploy"],
    defaultFlags: [],
  },
};

const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@-]+$/;

function quoteShellArg(value: string): string {
  return SAFE_SHELL_ARG_RE.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildVercelCliCommand(
  subcommand: VercelSubcommand,
  options: VercelCliCommandOptions = {},
): VercelCliCommand {
  const spec = SUBCOMMAND_SPECS[subcommand];
  const binary = options.binary ?? (process.platform === "win32" ? "vercel.cmd" : "vercel");
  const extraFlags = options.flags ?? [];

  const args = [...spec.args, ...spec.defaultFlags, ...extraFlags];

  return {
    file: binary,
    args,
    printable: ["vercel", ...args].map(quoteShellArg).join(" "),
  };
}

// ---------------------------------------------------------------------------
// Convenience: list all available subcommands
// ---------------------------------------------------------------------------

export function vercelSubcommands(): VercelSubcommand[] {
  return Object.keys(SUBCOMMAND_SPECS) as VercelSubcommand[];
}
