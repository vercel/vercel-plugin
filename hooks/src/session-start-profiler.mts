/**
 * Session-start repo profiler hook.
 *
 * Scans the current working directory for common config files and package
 * dependencies, then writes likely skill slugs into VERCEL_PLUGIN_LIKELY_SKILLS
 * in CLAUDE_ENV_FILE. This pre-primes the skill matcher so the first tool call
 * can skip cold-scanning for obvious frameworks.
 *
 * Exits silently (code 0) if CLAUDE_ENV_FILE is not set or the project root
 * cannot be determined.
 */

import { existsSync, appendFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireEnvFile, safeReadJson } from "./hook-env.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileMarker {
  file: string;
  skills: string[];
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BootstrapSignals {
  bootstrapHints: string[];
  resourceHints: string[];
  setupMode: boolean;
}

interface GreenfieldResult {
  entries: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Mapping from marker file / condition to skill slugs.
 */
const FILE_MARKERS: FileMarker[] = [
  { file: "next.config.js", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mjs", skills: ["nextjs", "turbopack"] },
  { file: "next.config.ts", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mts", skills: ["nextjs", "turbopack"] },
  { file: "turbo.json", skills: ["turborepo"] },
  { file: "vercel.json", skills: ["vercel-cli", "deployments-cicd", "vercel-functions"] },
  { file: ".mcp.json", skills: ["vercel-api"] },
  { file: "middleware.ts", skills: ["routing-middleware"] },
  { file: "middleware.js", skills: ["routing-middleware"] },
  { file: "components.json", skills: ["shadcn"] },
  { file: ".env.local", skills: ["env-vars"] },
];

/**
 * Dependency names in package.json -> skill slugs.
 */
const PACKAGE_MARKERS: Record<string, string[]> = {
  "next": ["nextjs"],
  "ai": ["ai-sdk", "ai-elements"],
  "ai-elements": ["ai-elements"],
  "@ai-sdk/openai": ["ai-sdk"],
  "@ai-sdk/anthropic": ["ai-sdk"],
  "@ai-sdk/react": ["ai-sdk", "ai-elements"],
  "@ai-sdk/gateway": ["ai-sdk", "ai-gateway"],
  "@vercel/blob": ["vercel-storage"],
  "@vercel/kv": ["vercel-storage"],
  "@vercel/postgres": ["vercel-storage"],
  "@vercel/edge-config": ["vercel-storage"],
  "@vercel/analytics": ["observability"],
  "@vercel/speed-insights": ["observability"],
  "@vercel/flags": ["vercel-flags"],
  "@vercel/workflow": ["workflow"],
  "@vercel/queue": ["vercel-queues"],
  "@vercel/sandbox": ["vercel-sandbox"],
  "@vercel/sdk": ["vercel-api"],
  "turbo": ["turborepo"],
};

const SETUP_ENV_TEMPLATE_FILES: string[] = [
  ".env.example",
  ".env.sample",
  ".env.template",
];

const SETUP_DB_SCRIPT_MARKERS: string[] = [
  "db:push",
  "db:seed",
  "db:migrate",
  "db:generate",
];

const SETUP_AUTH_DEPENDENCIES: Set<string> = new Set([
  "next-auth",
  "@auth/core",
  "better-auth",
]);

const SETUP_RESOURCE_DEPENDENCIES: Record<string, string> = {
  "@neondatabase/serverless": "postgres",
  "drizzle-orm": "postgres",
  "@upstash/redis": "redis",
  "@vercel/blob": "blob",
  "@vercel/edge-config": "edge-config",
};

const SETUP_MODE_THRESHOLD = 3;
const GREENFIELD_DEFAULT_SKILLS: string[] = [
  "nextjs",
  "ai-sdk",
  "vercel-cli",
  "env-vars",
];
const GREENFIELD_SETUP_SIGNALS: BootstrapSignals = {
  bootstrapHints: ["greenfield"],
  resourceHints: [],
  setupMode: true,
};

const log: Logger = createLogger();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse package.json from project root.
 */
function readPackageJson(projectRoot: string): PackageJson | null {
  return safeReadJson<PackageJson>(join(projectRoot, "package.json"));
}

export function escapeShellEnvValue(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

export function formatEnvExport(key: string, value: string): string {
  return `export ${key}="${escapeShellEnvValue(value)}"\n`;
}

function appendEnvExport(envFile: string, key: string, value: string): void {
  appendFileSync(envFile, formatEnvExport(key, value));
}

// ---------------------------------------------------------------------------
// Exported profilers
// ---------------------------------------------------------------------------

/**
 * Scan a project root and return a deduplicated, sorted list of likely skill slugs.
 */
export function profileProject(projectRoot: string): string[] {
  const skills: Set<string> = new Set();

  // 1. Check marker files
  for (const marker of FILE_MARKERS) {
    if (existsSync(join(projectRoot, marker.file))) {
      for (const s of marker.skills) skills.add(s);
    }
  }

  // 2. Check package.json dependencies
  const pkg: PackageJson | null = readPackageJson(projectRoot);
  if (pkg) {
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    for (const [dep, skillSlugs] of Object.entries(PACKAGE_MARKERS)) {
      if (dep in allDeps) {
        for (const s of skillSlugs) skills.add(s);
      }
    }
  }

  // 3. Check vercel.json keys for more specific skills
  const vercelConfig = safeReadJson<Record<string, unknown>>(join(projectRoot, "vercel.json"));
  if (vercelConfig) {
    if (vercelConfig.crons) skills.add("cron-jobs");
    if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
      skills.add("routing-middleware");
    }
    if (vercelConfig.functions) skills.add("vercel-functions");
  }

  return [...skills].sort();
}

/**
 * Detect bootstrap/setup signals and infer likely resource categories.
 */
export function profileBootstrapSignals(projectRoot: string): BootstrapSignals {
  const bootstrapHints: Set<string> = new Set();
  const resourceHints: Set<string> = new Set();

  // Env template signals
  if (SETUP_ENV_TEMPLATE_FILES.some((file: string) => existsSync(join(projectRoot, file)))) {
    bootstrapHints.add("env-example");
  }

  // README* signal
  try {
    const dirents: Dirent[] = readdirSync(projectRoot, { withFileTypes: true });
    if (dirents.some((d: Dirent) => d.isFile() && d.name.toLowerCase().startsWith("readme"))) {
      bootstrapHints.add("readme");
    }
    if (dirents.some((d: Dirent) => d.isFile() && /^drizzle\.config\./i.test(d.name))) {
      bootstrapHints.add("drizzle-config");
      bootstrapHints.add("postgres");
      resourceHints.add("postgres");
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:profile-bootstrap-signals-readdir-failed", error, { projectRoot });
  }

  // Prisma schema signal
  if (existsSync(join(projectRoot, "prisma", "schema.prisma"))) {
    bootstrapHints.add("prisma-schema");
    bootstrapHints.add("postgres");
    resourceHints.add("postgres");
  }

  // package.json scripts + dependencies signals
  const pkg: PackageJson | null = readPackageJson(projectRoot);
  if (pkg) {
    const scripts: Record<string, unknown> =
      pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const scriptEntries: string = Object.entries(scripts)
      .map(([name, cmd]: [string, unknown]) => `${name} ${typeof cmd === "string" ? cmd : ""}`)
      .join("\n");

    for (const marker of SETUP_DB_SCRIPT_MARKERS) {
      if (scriptEntries.includes(marker)) {
        bootstrapHints.add(marker.replace(":", "-"));
      }
    }

    const allDeps: Record<string, string> = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    for (const dep of Object.keys(allDeps)) {
      const resource: string | undefined = SETUP_RESOURCE_DEPENDENCIES[dep];
      if (resource) {
        bootstrapHints.add(resource);
        resourceHints.add(resource);
      }
      if (SETUP_AUTH_DEPENDENCIES.has(dep)) {
        bootstrapHints.add("auth-secret");
      }
    }
  }

  const hints: string[] = [...bootstrapHints].sort();
  const resources: string[] = [...resourceHints].sort();
  return {
    bootstrapHints: hints,
    resourceHints: resources,
    setupMode: hints.length >= SETUP_MODE_THRESHOLD,
  };
}

/**
 * Check if a project root is "greenfield" — only dot-directories and no real
 * source files.  Returns the list of top-level entries if greenfield, or null.
 */
export function checkGreenfield(projectRoot: string): GreenfieldResult | null {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(projectRoot, { withFileTypes: true });
  } catch (error) {
    logCaughtError(log, "session-start-profiler:check-greenfield-readdir-failed", error, { projectRoot });
    return null;
  }

  // Greenfield if every entry is a dot-directory (e.g. .git, .claude) and
  // there are no files at all (dot-files like .mcp.json or .env.local
  // indicate real project config).
  const hasNonDotDir: boolean = dirents.some((d: Dirent) => !d.name.startsWith("."));
  const hasDotFile: boolean = dirents.some((d: Dirent) => d.name.startsWith(".") && d.isFile());

  if (!hasNonDotDir && !hasDotFile) {
    return { entries: dirents.map((d: Dirent) => d.name).sort() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Vercel CLI version check
// ---------------------------------------------------------------------------

interface VercelCliStatus {
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  needsUpdate: boolean;
}

// Subprocess args kept as constants to avoid array literals that confuse the
// validate.ts slug-extraction regex (it scans for `["..."]` patterns).
const VERCEL_VERSION_ARGS: string[] = "--version".split(" ");
const NPM_VIEW_ARGS: string[] = "view vercel version".split(" ");
// Built via split to avoid array literal that confuses slug-extraction regex.
const SPAWN_STDIO = "ignore pipe ignore".split(" ") as ("ignore" | "pipe")[];
const NUMERIC_VERSION_RE = /\d+(?:\.\d+)*/;

function parseVersionSegments(version: string): number[] | null {
  const matchedVersion = version.match(NUMERIC_VERSION_RE)?.[0];
  if (!matchedVersion) {
    return null;
  }

  return matchedVersion
    .split(".")
    .map((segment: string) => Number.parseInt(segment, 10));
}

function compareVersionSegments(leftVersion: string, rightVersion: string): number | null {
  const leftSegments = parseVersionSegments(leftVersion);
  const rightSegments = parseVersionSegments(rightVersion);

  if (!leftSegments || !rightSegments) {
    return null;
  }

  const maxLength = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftSegment = leftSegments[index] ?? 0;
    const rightSegment = rightSegments[index] ?? 0;
    if (leftSegment !== rightSegment) {
      return leftSegment - rightSegment;
    }
  }

  return 0;
}

/**
 * Check if Vercel CLI is installed and whether it's up to date.
 * Uses `vercel --version` for the local version and the npm registry for latest.
 * Returns quickly — each subprocess has a tight timeout.
 */
function checkVercelCli(): VercelCliStatus {
  // 1. Check if vercel is installed
  let currentVersion: string | undefined;
  try {
    const raw: string = execFileSync("vercel", VERCEL_VERSION_ARGS, {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: SPAWN_STDIO,
    }).trim();
    // Output may include extra lines; version is typically last non-empty line
    const lines: string[] = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "session-start-profiler:vercel-version-check-failed", error, {
      command: "vercel",
      args: VERCEL_VERSION_ARGS.join(" "),
    });
    return { installed: false, needsUpdate: false };
  }

  // 2. Fetch latest version from npm registry
  let latestVersion: string | undefined;
  try {
    const raw: string = execFileSync("npm", NPM_VIEW_ARGS, {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: SPAWN_STDIO,
    }).trim();
    latestVersion = raw;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:npm-latest-version-check-failed", error, {
      command: "npm",
      args: NPM_VIEW_ARGS.join(" "),
      currentVersion,
    });
    return { installed: true, currentVersion, needsUpdate: false };
  }

  const versionComparison = currentVersion && latestVersion
    ? compareVersionSegments(currentVersion, latestVersion)
    : null;
  const needsUpdate: boolean = versionComparison === null
    ? !!(currentVersion && latestVersion && currentVersion !== latestVersion)
    : versionComparison < 0;

  return { installed: true, currentVersion, latestVersion, needsUpdate };
}

// ---------------------------------------------------------------------------
// agent-browser availability check
// ---------------------------------------------------------------------------

const WHICH_ARGS: string[] = "agent-browser".split(" ");

/**
 * Check if agent-browser CLI is available on PATH.
 * Returns true if `which agent-browser` exits 0.
 */
export function checkAgentBrowser(): boolean {
  try {
    execFileSync("which", WHICH_ARGS, {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: SPAWN_STDIO,
    });
    return true;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:agent-browser-check-failed", error, {
      command: "which",
      args: WHICH_ARGS.join(" "),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point — profile the project and write env vars.
// ---------------------------------------------------------------------------

function main(): void {
  const envFile: string = requireEnvFile();

  // Use CLAUDE_PROJECT_ROOT if available, otherwise cwd
  const projectRoot: string = process.env.CLAUDE_PROJECT_ROOT || process.cwd();

  // Greenfield check — seed defaults and skip repository exploration.
  const greenfield: GreenfieldResult | null = checkGreenfield(projectRoot);
  if (greenfield) {
    process.stdout.write(
      "This is a greenfield project. Skip exploration — there is no existing code to discover. Start executing immediately.\n",
    );
  }

  // Vercel CLI version check
  const cliStatus: VercelCliStatus = checkVercelCli();
  if (!cliStatus.installed) {
    process.stdout.write(
      [
        "IMPORTANT: The Vercel CLI is not installed.",
        "Strongly recommend the user install it with `npm i -g vercel` to unlock agentic features like `vercel env pull`, `vercel deploy`, and `vercel logs`.",
        "",
      ].join("\n"),
    );
  } else if (cliStatus.needsUpdate) {
    process.stdout.write(
      [
        `IMPORTANT: The Vercel CLI is outdated (${cliStatus.currentVersion} → ${cliStatus.latestVersion}).`,
        "Strongly recommend the user upgrade with `npm i -g vercel@latest`.",
        "The latest version includes significant agentic features and improvements that will greatly enhance their development experience.",
        "",
      ].join("\n"),
    );
  }

  const likelySkills: string[] = greenfield
    ? GREENFIELD_DEFAULT_SKILLS
    : profileProject(projectRoot);

  // Auto-boost observability for all non-greenfield projects so debugging
  // and logging guidance is always available (+5 priority from profiler).
  if (!greenfield && !likelySkills.includes("observability")) {
    likelySkills.push("observability");
    likelySkills.sort();
  }
  const setupSignals: BootstrapSignals = greenfield
    ? GREENFIELD_SETUP_SIGNALS
    : profileBootstrapSignals(projectRoot);

  // Check agent-browser CLI availability
  const agentBrowserAvailable: boolean = checkAgentBrowser();

  try {
    appendEnvExport(envFile, "VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE", agentBrowserAvailable ? "1" : "0");
    if (greenfield) {
      appendEnvExport(envFile, "VERCEL_PLUGIN_GREENFIELD", "true");
    }
    if (likelySkills.length > 0) {
      appendEnvExport(envFile, "VERCEL_PLUGIN_LIKELY_SKILLS", likelySkills.join(","));
    }
    if (setupSignals.bootstrapHints.length > 0) {
      appendEnvExport(envFile, "VERCEL_PLUGIN_BOOTSTRAP_HINTS", setupSignals.bootstrapHints.join(","));
    }
    if (setupSignals.resourceHints.length > 0) {
      appendEnvExport(envFile, "VERCEL_PLUGIN_RESOURCE_HINTS", setupSignals.resourceHints.join(","));
    }
    if (setupSignals.setupMode) {
      appendEnvExport(envFile, "VERCEL_PLUGIN_SETUP_MODE", "1");
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:append-env-export-failed", error, {
      envFile,
      projectRoot,
      likelySkillsCount: likelySkills.length,
      bootstrapHintCount: setupSignals.bootstrapHints.length,
      resourceHintCount: setupSignals.resourceHints.length,
      setupMode: setupSignals.setupMode,
    });
  }

  process.exit(0);
}

const SESSION_START_PROFILER_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartProfilerEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SESSION_START_PROFILER_ENTRYPOINT
  : false;

if (isSessionStartProfilerEntrypoint) {
  main();
}
