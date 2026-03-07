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
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { requireEnvFile, safeReadJson } from "./hook-env.mjs";

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
  "ai": ["ai-sdk"],
  "@ai-sdk/openai": ["ai-sdk"],
  "@ai-sdk/anthropic": ["ai-sdk"],
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse package.json from project root.
 */
function readPackageJson(projectRoot: string): PackageJson | null {
  return safeReadJson<PackageJson>(join(projectRoot, "package.json"));
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
  } catch {
    // Ignore unreadable project roots
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
  } catch {
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
  } catch {
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
  } catch {
    // Can't reach registry — skip comparison
    return { installed: true, currentVersion, needsUpdate: false };
  }

  const needsUpdate: boolean = !!(currentVersion && latestVersion && currentVersion !== latestVersion);

  return { installed: true, currentVersion, latestVersion, needsUpdate };
}

// ---------------------------------------------------------------------------
// Main entry point — profile the project and write env vars.
// ---------------------------------------------------------------------------

function main(): void {
  const envFile: string = requireEnvFile();

  // Use CLAUDE_PROJECT_ROOT if available, otherwise cwd
  const projectRoot: string = process.env.CLAUDE_PROJECT_ROOT || process.cwd();

  // Greenfield check — if the project only has dot-directories, skip profiling
  // and inject a short context hint instead.
  const greenfield: GreenfieldResult | null = checkGreenfield(projectRoot);
  if (greenfield) {
    try {
      appendFileSync(envFile, `export VERCEL_PLUGIN_GREENFIELD="true"\n`);
    } catch {
      // ignore
    }
    const dirs: string = greenfield.entries.map((e: string) => `  ${e}/`).join("\n");
    process.stdout.write(
      `This is a greenfield project with only these directories:\n${dirs}\nSkip codebase exploration — there is no existing code to discover.\n`,
    );
    process.exit(0);
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

  const likelySkills: string[] = profileProject(projectRoot);
  const setupSignals: BootstrapSignals = profileBootstrapSignals(projectRoot);

  try {
    if (likelySkills.length > 0) {
      appendFileSync(envFile, `export VERCEL_PLUGIN_LIKELY_SKILLS="${likelySkills.join(",")}"\n`);
    }
    if (setupSignals.bootstrapHints.length > 0) {
      appendFileSync(
        envFile,
        `export VERCEL_PLUGIN_BOOTSTRAP_HINTS="${setupSignals.bootstrapHints.join(",")}"\n`,
      );
    }
    if (setupSignals.resourceHints.length > 0) {
      appendFileSync(
        envFile,
        `export VERCEL_PLUGIN_RESOURCE_HINTS="${setupSignals.resourceHints.join(",")}"\n`,
      );
    }
    if (setupSignals.setupMode) {
      appendFileSync(envFile, "export VERCEL_PLUGIN_SETUP_MODE=\"1\"\n");
    }
  } catch {
    // Cannot write env file — exit silently
  }

  process.exit(0);
}

main();
