/**
 * Canonical Vercel CLI command reference for documentation validation.
 *
 * This module provides the single source of truth for valid Vercel CLI commands,
 * subcommands, and known-bad patterns used by the plugin's validation pipeline.
 *
 * @source Vercel CLI GitHub repo — https://github.com/vercel/vercel/tree/main/packages/cli/src/commands
 * @source Official CLI docs — https://vercel.com/docs/cli
 * @verified 2026-03-04
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A top-level Vercel CLI command entry. */
export interface CommandEntry {
  /** Valid subcommands. Empty array means the command takes no subcommands (only positional args / flags). */
  subcommands: string[];
  /** Alternative top-level names (e.g. `ls` for `list`, `rm` for `remove`). */
  aliases?: string[];
}

/** A banned CLI pattern with an explanation for documentation authors. */
export interface BannedPattern {
  /** Regex matched against individual lines inside code fences. */
  pattern: RegExp;
  /** Human-readable fix suggestion surfaced in validation output. */
  hint: string;
}

// ---------------------------------------------------------------------------
// VERCEL_CLI_COMMANDS — canonical allowlist
// ---------------------------------------------------------------------------

/**
 * Maps every `vercel <command>` to its valid subcommands and aliases.
 *
 * Derived from `packages/cli/src/commands/<cmd>/command.ts` in the
 * [vercel/vercel](https://github.com/vercel/vercel) repository and
 * cross-checked against https://vercel.com/docs/cli.
 */
export const VERCEL_CLI_COMMANDS: Record<string, CommandEntry> = {
  // --- Deployment lifecycle ---------------------------------------------------
  deploy: { subcommands: [] },
  dev: { subcommands: [] },
  build: { subcommands: [] },
  redeploy: { subcommands: [] },
  promote: { subcommands: ["status"] },
  rollback: { subcommands: ["status"] },
  remove: { subcommands: [], aliases: ["rm"] },
  inspect: { subcommands: [] },
  list: { subcommands: [], aliases: ["ls"] },
  logs: { subcommands: [] },
  bisect: { subcommands: [] },

  // --- Project & linking -----------------------------------------------------
  init: { subcommands: [] },
  link: { subcommands: [] },
  pull: { subcommands: [] },
  open: { subcommands: [] },
  project: {
    subcommands: ["list", "ls", "add", "inspect", "remove", "rm", "token"],
    aliases: ["projects"],
  },

  // --- Environment variables -------------------------------------------------
  env: {
    subcommands: ["list", "ls", "add", "update", "remove", "rm", "pull", "run"],
  },

  // --- Domains & DNS ---------------------------------------------------------
  domains: {
    subcommands: [
      "list", "ls", "inspect", "add", "buy", "move", "transfer-in", "remove", "rm",
    ],
    aliases: ["domain"],
  },
  dns: {
    subcommands: ["list", "ls", "add", "remove", "rm", "import"],
  },

  // --- Certificates ----------------------------------------------------------
  certs: {
    subcommands: ["list", "ls", "issue", "add", "remove", "rm"],
    aliases: ["cert"],
  },

  // --- Aliases ---------------------------------------------------------------
  alias: {
    subcommands: ["set", "list", "ls", "remove", "rm"],
    aliases: ["aliases", "ln"],
  },

  // --- Teams & auth ----------------------------------------------------------
  teams: {
    subcommands: ["add", "create", "list", "ls", "switch", "change", "invite"],
    aliases: ["team"],
  },
  switch: { subcommands: [] },
  login: { subcommands: [] },
  logout: { subcommands: [] },
  whoami: { subcommands: [] },

  // --- Integrations & marketplace --------------------------------------------
  integration: {
    subcommands: ["add", "balance", "discover", "guide", "list", "ls", "open", "remove"],
  },
  "integration-resource": {
    subcommands: ["remove", "rm", "disconnect", "create-threshold"],
  },
  install: { subcommands: [] }, // alias for `integration add`

  // --- Cache -----------------------------------------------------------------
  cache: {
    subcommands: ["purge", "invalidate", "dangerously-delete"],
  },

  // --- Storage ---------------------------------------------------------------
  blob: {
    subcommands: [
      "list", "ls", "put", "get", "del", "copy", "cp",
      "create-store", "delete-store", "get-store", "store",
    ],
  },

  // --- Git integration -------------------------------------------------------
  git: {
    subcommands: ["connect", "disconnect"],
  },

  // --- Telemetry & guidance --------------------------------------------------
  telemetry: {
    subcommands: ["status", "enable", "disable", "flush"],
  },
  guidance: {
    subcommands: ["status", "enable", "disable"],
  },

  // --- Microfrontends --------------------------------------------------------
  microfrontends: {
    subcommands: ["pull"],
  },

  // --- Rolling releases ------------------------------------------------------
  "rolling-release": {
    subcommands: ["configure", "start", "approve", "abort", "complete", "fetch"],
    aliases: ["rr"],
  },

  // --- Redirects -------------------------------------------------------------
  redirects: {
    subcommands: [
      "list", "ls", "list-versions", "ls-versions",
      "add", "upload", "import", "remove", "rm", "promote", "restore",
    ],
  },

  // --- Webhooks (beta) -------------------------------------------------------
  webhooks: {
    subcommands: ["list", "ls", "get", "inspect", "create", "add", "remove", "rm", "delete"],
  },

  // --- Custom environments ---------------------------------------------------
  target: {
    subcommands: ["list", "ls"],
  },

  // --- MCP -------------------------------------------------------------------
  mcp: { subcommands: [] },

  // --- Utilities -------------------------------------------------------------
  curl: { subcommands: [] },
  httpstat: { subcommands: [] },
  help: { subcommands: [] },
};

// ---------------------------------------------------------------------------
// BANNED_CLI_PATTERNS — known-bad commands for documentation linting
// ---------------------------------------------------------------------------

/**
 * Patterns that should **never** appear in documentation code fences.
 *
 * Used by `validate.ts` check [7] to catch hallucinated or deprecated CLI
 * invocations before they ship in plugin content.
 */
export const BANNED_CLI_PATTERNS: BannedPattern[] = [
  {
    pattern: /vercel\s+logs\s+.*--build/,
    hint: "The --build flag does not exist for 'vercel logs'. Use 'vercel inspect <deployment-url>' for build details.",
  },
  {
    pattern: /vercel\s+logs\s+drain/,
    hint: "Log drains are configured via the Vercel Dashboard or REST API, not the CLI. See https://vercel.com/docs/log-drains",
  },
  {
    pattern: /vercel\s+integration\s+(dev|deploy|publish|status)\b/,
    hint: "This 'vercel integration' subcommand does not exist. Valid: add, balance, discover, guide, list, ls, open, remove.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a command name (including aliases) to its entry. */
function resolveCommand(cmd: string): CommandEntry | undefined {
  if (VERCEL_CLI_COMMANDS[cmd]) return VERCEL_CLI_COMMANDS[cmd];
  for (const entry of Object.values(VERCEL_CLI_COMMANDS)) {
    if (entry.aliases?.includes(cmd)) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// isValidVercelCommand
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `line` contains a syntactically valid `vercel` invocation
 * according to the canonical command reference.
 *
 * Handles optional `npx`/`bunx`/`pnpx` prefixes. Does **not** validate flags
 * or positional arguments beyond the first subcommand — use
 * {@link BANNED_CLI_PATTERNS} for deeper semantic checks.
 *
 * @example
 * ```ts
 * isValidVercelCommand("vercel deploy --prod")      // true
 * isValidVercelCommand("vercel env ls")              // true
 * isValidVercelCommand("npx vercel integration add") // true
 * isValidVercelCommand("vercel logs drain ls")       // false — logs has no subcommands
 * isValidVercelCommand("vercel foo")                 // false — unknown command
 * ```
 */
export function isValidVercelCommand(line: string): boolean {
  const trimmed = line.trim();

  // Match `vercel <cmd>` with optional runner prefix
  const match = trimmed.match(
    /(?:npx\s+|bunx\s+|pnpx\s+)?vercel(?:\s+(.*))?/,
  );
  if (!match) return false;

  const rest = match[1]?.trim();

  // Bare `vercel` (no args) is valid
  if (!rest) return true;

  // Global flags like --version, --help, -v
  if (rest.startsWith("-")) return true;

  // Split into tokens
  const tokens = rest.split(/\s+/);
  const cmd = tokens[0];

  const entry = resolveCommand(cmd);
  if (!entry) return false;

  // No subcommands defined → any arguments are positional/flags, always valid
  if (entry.subcommands.length === 0) return true;

  // No second token → bare command (shows help), valid
  if (tokens.length < 2) return true;

  const nextArg = tokens[1];

  // Flags are always valid
  if (nextArg.startsWith("-")) return true;

  // Check subcommand
  return entry.subcommands.includes(nextArg);
}
