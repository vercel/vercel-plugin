/**
 * Session-start repo profiler hook.
 *
 * Scans the current working directory for common config files and package
 * dependencies, then persists likely skill slugs and greenfield state for the
 * active session. Claude Code keeps these session-scoped values in temp files,
 * while Cursor also emits JSON `{ env, additional_context }`.
 *
 * This pre-primes the skill matcher so the first tool call can skip
 * cold-scanning for obvious frameworks.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  formatOutput,
  normalizeInput,
  setSessionEnv,
  type HookPlatform,
} from "./compat.mjs";
import { pluginRoot, profileCachePath, safeReadJson, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";
import { buildSkillMap } from "./skill-map-frontmatter.mjs";
import { trackBaseEvents, getOrCreateDeviceId } from "./telemetry.mjs";

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
  { file: "vercel.json", skills: ["vercel-cli", "deployments-cicd", "vercel-functions"] },
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
  "@ai-sdk/react": ["ai-sdk"],
  "@ai-sdk/gateway": ["ai-sdk", "ai-gateway"],
  "@vercel/blob": ["vercel-storage"],
  "@vercel/kv": ["vercel-storage"],
  "@vercel/postgres": ["vercel-storage"],
  "@vercel/edge-config": ["vercel-storage"],
  "@vercel/workflow": ["workflow"],
  "@vercel/sandbox": ["vercel-sandbox"],
  "@repo/auth": ["next-forge"],
  "@repo/database": ["next-forge"],
  "@repo/design-system": ["next-forge"],
  "@repo/payments": ["next-forge"],
  "@t3-oss/env-nextjs": ["next-forge"],
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
const SESSION_GREENFIELD_KIND = "greenfield";
const SESSION_LIKELY_SKILLS_KIND = "likely-skills";

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
const EXEC_SYNC_TIMEOUT_MS = 3_000;
const NUMERIC_VERSION_RE = /\d+(?:\.\d+)*/;
const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
  .split(";")
  .filter(Boolean);

function getBinaryPathCandidates(binaryName: string): string[] {
  if (process.platform !== "win32") {
    return [binaryName];
  }

  const hasExecutableExtension = /\.[^./\\]+$/.test(binaryName);
  const suffixes = hasExecutableExtension ? [""] : ["", ...WINDOWS_EXECUTABLE_EXTENSIONS];
  return suffixes.map((suffix: string) => `${binaryName}${suffix}`);
}

function resolveBinaryFromPath(binaryName: string): string | null {
  try {
    const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);
    for (const pathEntry of pathEntries) {
      for (const candidateName of getBinaryPathCandidates(binaryName)) {
        const candidatePath = join(pathEntry, candidateName);
        try {
          accessSync(candidatePath, fsConstants.X_OK);
          return candidatePath;
        } catch {
          continue;
        }
      }
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:binary-resolution-failed", error, {
      binaryName,
    });
    return null;
  }

  log.debug("session-start-profiler:binary-resolution-skipped", {
    binaryName,
    reason: "not-found",
  });
  return null;
}

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
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) {
    return { installed: false, needsUpdate: false };
  }

  // 1. Check if vercel is installed
  let currentVersion: string | undefined;
  try {
    const raw: string = execFileSync(vercelBinary, VERCEL_VERSION_ARGS, {
      timeout: EXEC_SYNC_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: SPAWN_STDIO,
    }).trim();
    // Output may include extra lines; version is typically last non-empty line
    const lines: string[] = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "session-start-profiler:vercel-version-check-failed", error, {
      command: vercelBinary,
      args: VERCEL_VERSION_ARGS.join(" "),
    });
    return { installed: false, needsUpdate: false };
  }

  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) {
    return { installed: true, currentVersion, needsUpdate: false };
  }

  // 2. Fetch latest version from npm registry
  let latestVersion: string | undefined;
  try {
    const raw: string = execFileSync(npmBinary, NPM_VIEW_ARGS, {
      timeout: EXEC_SYNC_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: SPAWN_STDIO,
    }).trim();
    latestVersion = raw;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:npm-latest-version-check-failed", error, {
      command: npmBinary,
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
// Main entry point — profile the project and write env vars.
// ---------------------------------------------------------------------------

interface SessionStartInput {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  workspace_roots?: string[];
  cwd?: string;
  [key: string]: unknown;
}

export function parseSessionStartInput(raw: string): SessionStartInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SessionStartInput;
  } catch {
    return null;
  }
}

export function detectSessionStartPlatform(
  input: SessionStartInput | null,
  env: NodeJS.ProcessEnv = process.env,
): HookPlatform {
  if (typeof env.CLAUDE_ENV_FILE === "string" && env.CLAUDE_ENV_FILE.trim() !== "") {
    return "claude-code";
  }

  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }

  return "claude-code";
}

export function normalizeSessionStartSessionId(input: SessionStartInput | null): string | null {
  if (!input) return null;

  const sessionId = normalizeInput(input as Record<string, unknown>).sessionId;
  return sessionId || null;
}

export function resolveSessionStartProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}

function collectBrokenSkillFrontmatterNames(files: string[]): string[] {
  return [...new Set(
    files
      .map((file: string) => file.replaceAll("\\", "/").split("/").at(-2) || "")
      .filter((skill: string) => skill !== ""),
  )].sort();
}

export function logBrokenSkillFrontmatterSummary(
  rootDir: string = pluginRoot(),
  logger: Logger = log,
): string | null {
  if (!logger.isEnabled("summary")) {
    return null;
  }

  try {
    const built = buildSkillMap(join(rootDir, "skills"));
    const brokenSkills = collectBrokenSkillFrontmatterNames(
      built.diagnostics.map((diagnostic) => diagnostic.file),
    );

    if (brokenSkills.length === 0) {
      return null;
    }

    const message = `WARNING: ${brokenSkills.length} skills have broken frontmatter: ${brokenSkills.join(", ")}`;
    logger.summary("session-start-profiler:broken-skill-frontmatter", {
      message,
      brokenSkillCount: brokenSkills.length,
      brokenSkills,
    });
    return message;
  } catch (error) {
    logCaughtError(logger, "session-start-profiler:broken-skill-frontmatter-check-failed", error, {
      rootDir,
    });
    return null;
  }
}

export function buildSessionStartProfilerEnvVars(args: {
  greenfield: boolean;
  likelySkills: string[];
  setupSignals: BootstrapSignals;
}): Record<string, string> {
  const envVars: Record<string, string> = {};

  if (args.greenfield) {
    envVars.VERCEL_PLUGIN_GREENFIELD = "true";
  }
  if (args.likelySkills.length > 0) {
    envVars.VERCEL_PLUGIN_LIKELY_SKILLS = args.likelySkills.join(",");
  }
  if (args.setupSignals.bootstrapHints.length > 0) {
    envVars.VERCEL_PLUGIN_BOOTSTRAP_HINTS = args.setupSignals.bootstrapHints.join(",");
  }
  if (args.setupSignals.resourceHints.length > 0) {
    envVars.VERCEL_PLUGIN_RESOURCE_HINTS = args.setupSignals.resourceHints.join(",");
  }
  if (args.setupSignals.setupMode) {
    envVars.VERCEL_PLUGIN_SETUP_MODE = "1";
  }

  return envVars;
}

export function buildSessionStartProfilerUserMessages(
  greenfield: GreenfieldResult | null,
  cliStatus: VercelCliStatus,
): string[] {
  const messages: string[] = [];

  if (greenfield) {
    messages.push(
      "This is a greenfield project. Skip exploration — there is no existing code to discover. Start executing immediately.",
    );
  }

  if (!cliStatus.installed) {
    messages.push(
      [
        "IMPORTANT: The Vercel CLI is not installed.",
        "Strongly recommend the user install it with `npm i -g vercel` to unlock agentic features like `vercel env pull`, `vercel deploy`, and `vercel logs`.",
      ].join("\n"),
    );
  } else if (cliStatus.needsUpdate) {
    messages.push(
      [
        `IMPORTANT: The Vercel CLI is outdated (${cliStatus.currentVersion} → ${cliStatus.latestVersion}).`,
        "Strongly recommend the user upgrade with `npm i -g vercel@latest` or `pnpm add -g vercel@latest` for best compatibility.",
        "The latest version includes significant agentic features and improvements that will greatly enhance their development experience.",
      ].join("\n"),
    );
  }

  return messages;
}

export function formatSessionStartProfilerCursorOutput(
  envVars: Record<string, string>,
  userMessages: string[],
): string {
  const additionalContext = userMessages.join("\n\n");
  return JSON.stringify(formatOutput("cursor", {
    additionalContext: additionalContext || undefined,
    env: envVars,
  }));
}

async function main(): Promise<void> {
  const hookInput = parseSessionStartInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartPlatform(hookInput);
  const sessionId = normalizeSessionStartSessionId(hookInput);
  const projectRoot = resolveSessionStartProjectRoot();

  logBrokenSkillFrontmatterSummary();

  // Greenfield check — seed defaults and skip repository exploration.
  const greenfield: GreenfieldResult | null = checkGreenfield(projectRoot);

  // Vercel CLI version check
  const cliStatus: VercelCliStatus = checkVercelCli();
  const userMessages = buildSessionStartProfilerUserMessages(greenfield, cliStatus);

  const likelySkills: string[] = greenfield
    ? GREENFIELD_DEFAULT_SKILLS
    : profileProject(projectRoot);

  const setupSignals: BootstrapSignals = greenfield
    ? GREENFIELD_SETUP_SIGNALS
    : profileBootstrapSignals(projectRoot);
  const greenfieldValue = greenfield ? "true" : "";
  const likelySkillsValue = likelySkills.join(",");

  const envVars = buildSessionStartProfilerEnvVars({
    greenfield: greenfield !== null,
    likelySkills,
    setupSignals,
  });
  const cursorOutput = platform === "cursor"
    ? formatSessionStartProfilerCursorOutput(envVars, userMessages)
    : null;

  if (sessionId) {
    writeSessionFile(sessionId, SESSION_GREENFIELD_KIND, greenfieldValue);
    writeSessionFile(sessionId, SESSION_LIKELY_SKILLS_KIND, likelySkillsValue);
  }

  try {
    if (platform === "claude-code") {
      for (const [key, value] of Object.entries(envVars)) {
        if (key === "VERCEL_PLUGIN_GREENFIELD" || key === "VERCEL_PLUGIN_LIKELY_SKILLS") {
          continue;
        }
        setSessionEnv(platform, key, value);
      }
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:append-env-export-failed", error, {
      platform,
      projectRoot,
      envVarCount: Object.keys(envVars).length,
    });
  }

  const additionalContext = userMessages.join("\n\n");
  if (platform === "claude-code" && additionalContext) {
    process.stdout.write(`${additionalContext}\n\n`);
  }

  // Write profile cache so SubagentStart hooks can read it without re-profiling
  if (sessionId) {
    try {
      const cache = {
        projectRoot,
        likelySkills,
        greenfield: greenfield !== null,
        bootstrapHints: setupSignals.bootstrapHints,
        resourceHints: setupSignals.resourceHints,
        setupMode: setupSignals.setupMode,
        timestamp: new Date().toISOString(),
      };
      writeFileSync(profileCachePath(sessionId), JSON.stringify(cache), "utf-8");
    } catch (error) {
      logCaughtError(log, "session-start-profiler:write-profile-cache-failed", error, {
        sessionId,
        projectRoot,
      });
    }
  }

  // Base telemetry — enabled by default unless VERCEL_PLUGIN_TELEMETRY=off
  if (sessionId) {
    const deviceId = getOrCreateDeviceId();
    await trackBaseEvents(sessionId, [
      { key: "session:device_id", value: deviceId },
      { key: "session:platform", value: process.platform },
      { key: "session:likely_skills", value: likelySkills.join(",") },
      { key: "session:greenfield", value: String(greenfield !== null) },
      { key: "session:vercel_cli_installed", value: String(cliStatus.installed) },
      { key: "session:vercel_cli_version", value: cliStatus.currentVersion || "" },
    ]).catch(() => {});
  }

  if (cursorOutput) {
    process.stdout.write(cursorOutput);
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
