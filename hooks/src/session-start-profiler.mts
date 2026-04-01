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
  mkdirSync,
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
import { writePersistedSkillInstallPlan } from "./orchestrator-install-plan-state.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";
import { buildSkillMap } from "./skill-map-frontmatter.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
import { trackBaseEvents, getOrCreateDeviceId } from "./telemetry.mjs";
import {
  buildSkillInstallPlan,
  formatSkillInstallPalette,
  serializeSkillInstallPlan,
  type DetectionReason,
  type SkillDetection,
  type SkillInstallPlan,
} from "./orchestrator-install-plan.mjs";
import {
  createRegistryClient,
  type InstallSkillsResult,
} from "./registry-client.mjs";
import {
  createVercelCliDelegator,
  type VercelCliDelegator,
  type VercelCliRunResult,
} from "./vercel-cli-delegator.mjs";
import { formatOrchestratorActionPalette } from "./orchestrator-action-palette.mjs";

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
  { file: "pnpm-workspace.yaml", skills: ["turborepo"] },
  { file: "backend/pyproject.toml", skills: ["vercel-services"] },
  { file: "backend/main.py", skills: ["vercel-services"] },
  { file: "backend/go.mod", skills: ["vercel-services"] },
  { file: "backend/main.go", skills: ["vercel-services"] },
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
 * Collect skill detections with structured reasons from marker files,
 * package.json dependencies, and vercel.json config keys.
 */
function upsertSkillDetection(
  map: Map<string, SkillDetection>,
  skill: string,
  reason: DetectionReason,
): void {
  const existing = map.get(skill);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  map.set(skill, { skill, reasons: [reason] });
}

export function profileProjectDetections(projectRoot: string): SkillDetection[] {
  const detections = new Map<string, SkillDetection>();

  // 1. Check marker files
  for (const marker of FILE_MARKERS) {
    if (!existsSync(join(projectRoot, marker.file))) continue;
    for (const skill of marker.skills) {
      upsertSkillDetection(detections, skill, {
        kind: "file",
        source: marker.file,
        detail: `matched file marker ${marker.file}`,
      });
    }
  }

  // 2. Check package.json dependencies
  const pkg: PackageJson | null = readPackageJson(projectRoot);
  if (pkg) {
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    for (const [dep, skills] of Object.entries(PACKAGE_MARKERS)) {
      if (!(dep in allDeps)) continue;
      for (const skill of skills) {
        upsertSkillDetection(detections, skill, {
          kind: "dependency",
          source: dep,
          detail: `matched dependency ${dep}`,
        });
      }
    }
  }

  // 3. Check vercel.json keys
  const vercelConfig = safeReadJson<Record<string, unknown>>(
    join(projectRoot, "vercel.json"),
  );
  if (vercelConfig) {
    if (vercelConfig.crons) {
      upsertSkillDetection(detections, "cron-jobs", {
        kind: "vercel-json",
        source: "vercel.json#crons",
        detail: "detected crons config",
      });
    }
    if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
      upsertSkillDetection(detections, "routing-middleware", {
        kind: "vercel-json",
        source: "vercel.json#rewrites|redirects|headers",
        detail: "detected routing config",
      });
    }
    if (vercelConfig.functions) {
      upsertSkillDetection(detections, "vercel-functions", {
        kind: "vercel-json",
        source: "vercel.json#functions",
        detail: "detected function config",
      });
    }
    if (vercelConfig.experimentalServices) {
      upsertSkillDetection(detections, "vercel-services", {
        kind: "vercel-json",
        source: "vercel.json#experimentalServices",
        detail: "detected services config",
      });
    }
  }

  return [...detections.values()]
    .map((detection) => ({
      skill: detection.skill,
      reasons: [...detection.reasons].sort((a, b) =>
        a.source.localeCompare(b.source),
      ),
    }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/**
 * Scan a project root and return a deduplicated, sorted list of likely skill slugs.
 */
export function profileProject(projectRoot: string): string[] {
  return profileProjectDetections(projectRoot).map((detection) => detection.skill);
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
// agent-browser availability check
// ---------------------------------------------------------------------------

const AGENT_BROWSER_BINARY = "agent-browser";

/**
 * Check if agent-browser CLI is available on PATH.
 * Returns true if `agent-browser` resolves on PATH.
 */
export function checkAgentBrowser(): boolean {
  return resolveBinaryFromPath(AGENT_BROWSER_BINARY) !== null;
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
  agentBrowserAvailable: boolean;
  greenfield: boolean;
  likelySkills: string[];
  installedSkills?: string[];
  missingSkills?: string[];
  zeroBundleReady?: boolean;
  projectSkillManifestPath?: string | null;
  setupSignals: BootstrapSignals;
}): Record<string, string> {
  const envVars: Record<string, string> = {
    VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE: args.agentBrowserAvailable ? "1" : "0",
  };

  if (args.greenfield) {
    envVars.VERCEL_PLUGIN_GREENFIELD = "true";
  }
  if (args.likelySkills.length > 0) {
    envVars.VERCEL_PLUGIN_LIKELY_SKILLS = args.likelySkills.join(",");
  }
  if (args.installedSkills && args.installedSkills.length > 0) {
    envVars.VERCEL_PLUGIN_INSTALLED_SKILLS = args.installedSkills.join(",");
  }
  if (args.missingSkills && args.missingSkills.length > 0) {
    envVars.VERCEL_PLUGIN_MISSING_SKILLS = args.missingSkills.join(",");
  }
  if (args.zeroBundleReady) {
    envVars.VERCEL_PLUGIN_ZERO_BUNDLE_READY = "1";
    envVars.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK = "1";
  }
  if (args.projectSkillManifestPath) {
    envVars.VERCEL_PLUGIN_PROJECT_SKILL_MANIFEST = args.projectSkillManifestPath;
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

/**
 * When VERCEL_PLUGIN_SKILL_AUTO_INSTALL=1, install missing detected skills
 * from the registry into the project's .skills/ cache directory.
 */
export async function autoInstallDetectedSkills(args: {
  projectRoot: string;
  missingSkills: string[];
  skillsSource?: string;
  logger?: Logger;
}): Promise<InstallSkillsResult> {
  const emptyResult: InstallSkillsResult = {
    installed: [],
    reused: [],
    missing: [...args.missingSkills],
    command: null,
  };

  if (
    args.missingSkills.length === 0 ||
    process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL !== "1"
  ) {
    return emptyResult;
  }

  const client = createRegistryClient({
    source: args.skillsSource,
  });
  let result: InstallSkillsResult;
  try {
    result = await client.installSkills({
      projectRoot: args.projectRoot,
      skillNames: args.missingSkills,
    });
  } catch (error) {
    logCaughtError(
      args.logger ?? log,
      "session-start-profiler:auto-install-failed",
      error,
      {
        projectRoot: args.projectRoot,
        missingSkillCount: args.missingSkills.length,
      },
    );
    return emptyResult;
  }

  args.logger?.debug("session-start-profiler-auto-install", {
    installed: result.installed,
    reused: result.reused,
    missing: result.missing,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Vercel CLI delegation — auto env pull
// ---------------------------------------------------------------------------

export async function autoPullProjectEnv(args: {
  projectRoot: string;
  vercelLinked: boolean;
  hasEnvLocal: boolean;
  logger?: Logger;
  delegator?: VercelCliDelegator;
}): Promise<VercelCliRunResult | null> {
  if (
    process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL !== "1" ||
    !args.vercelLinked ||
    args.hasEnvLocal
  ) {
    return null;
  }

  const delegator = args.delegator ?? createVercelCliDelegator();
  const result = await delegator.run({
    projectRoot: args.projectRoot,
    subcommand: "env-pull",
  });

  if (!result.ok) {
    logCaughtError(
      args.logger ?? log,
      "session-start-profiler:auto-env-pull-failed",
      new Error(result.stderr || "vercel env pull failed"),
      { projectRoot: args.projectRoot, command: result.command },
    );
  }

  return result;
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

  const detections: SkillDetection[] = greenfield
    ? GREENFIELD_DEFAULT_SKILLS.map((skill) => ({
        skill,
        reasons: [
          {
            kind: "greenfield" as const,
            source: "project-root",
            detail: "seeded from greenfield defaults",
          },
        ],
      }))
    : profileProjectDetections(projectRoot);

  const likelySkills: string[] = detections.map((detection) => detection.skill);

  // Auto-boost observability for all non-greenfield projects so debugging
  // and logging guidance is always available (+5 priority from profiler).
  if (!greenfield && !likelySkills.includes("observability")) {
    likelySkills.push("observability");
    detections.push({
      skill: "observability",
      reasons: [
        {
          kind: "profiler-default" as const,
          source: "profiler-default",
          detail: "auto-boosted for non-greenfield debugging coverage",
        },
      ],
    });
  }
  likelySkills.sort();
  const setupSignals: BootstrapSignals = greenfield
    ? GREENFIELD_SETUP_SIGNALS
    : profileBootstrapSignals(projectRoot);
  const greenfieldValue = greenfield ? "true" : "";
  const likelySkillsValue = likelySkills.join(",");

  // Check agent-browser CLI availability
  const agentBrowserAvailable: boolean = checkAgentBrowser();

  // Discover installed skills from project and global caches via shared loader
  const bundledFallbackEnabled = process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1";
  let installedState = loadProjectInstalledSkillState({
    projectRoot,
    pluginRoot: pluginRoot(),
    likelySkills,
    bundledFallbackEnabled,
    logger: log,
  });
  let skillStore = installedState.skillStore;
  let installedSkills = installedState.installedSkills;
  let skillCacheStatus = installedState.cacheStatus;

  // Auto-install missing skills from registry when opted in
  const installResult = await autoInstallDetectedSkills({
    projectRoot,
    missingSkills: skillCacheStatus.missingSkills,
    logger: log,
  });

  if (installResult.installed.length > 0 || installResult.reused.length > 0) {
    // Refresh via shared loader after installing new skills
    installedState = loadProjectInstalledSkillState({
      projectRoot,
      pluginRoot: pluginRoot(),
      likelySkills,
      bundledFallbackEnabled,
      logger: log,
    });
    skillStore = installedState.skillStore;
    installedSkills = installedState.installedSkills;
    skillCacheStatus = installedState.cacheStatus;

    // Surface a visible callout so the user knows auto-install happened
    const installedOrReusedNow = [
      ...installResult.installed,
      ...installResult.reused,
    ];
    if (installedOrReusedNow.length > 0) {
      userMessages.unshift(
        [
          "### Vercel skill cache",
          installResult.installed.length > 0
            ? `- Installed now: ${installResult.installed.join(", ")}`
            : null,
          installResult.reused.length > 0
            ? `- Already cached: ${installResult.reused.join(", ")}`
            : null,
          `- Project cache: ${join(projectRoot, ".skills")}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  // Read CLI-produced project skill state from the shared loader
  const projectSkillManifestPath = installedState.projectState.projectSkillStatePath;

  // Detect Vercel project state for CLI delegation actions
  let vercelLinked = existsSync(join(projectRoot, ".vercel"));
  let hasEnvLocal = existsSync(join(projectRoot, ".env.local"));

  // Optional real Vercel CLI delegation for the safest SessionStart action.
  const envPullResult = await autoPullProjectEnv({
    projectRoot,
    vercelLinked,
    hasEnvLocal,
    logger: log,
  });

  // Re-read after delegation so the install plan reflects reality.
  vercelLinked = existsSync(join(projectRoot, ".vercel"));
  hasEnvLocal = existsSync(join(projectRoot, ".env.local"));

  if (envPullResult?.ok && envPullResult.changed) {
    userMessages.unshift(
      [
        "### Vercel CLI delegation",
        "- Delegated: vercel env pull",
        `- Command: \`${envPullResult.command}\``,
        `- Created: ${join(projectRoot, ".env.local")}`,
      ].join("\n"),
    );
  }

  // Build and persist the machine-readable install plan
  const installPlan = buildSkillInstallPlan({
    projectRoot,
    detections,
    installedSkills,
    bundledFallbackEnabled,
    zeroBundleReady: skillCacheStatus.zeroBundleReady,
    projectSkillManifestPath,
    vercelLinked,
    hasEnvLocal,
  });

  try {
    writePersistedSkillInstallPlan(installPlan);
  } catch (error) {
    logCaughtError(log, "session-start-profiler:write-install-plan-failed", error, {
      projectRoot,
    });
  }

  const installPalette = formatSkillInstallPalette(installPlan);
  if (installPalette) {
    userMessages.unshift(installPalette);
  }

  const wrapperPalette = formatOrchestratorActionPalette({
    pluginRoot: pluginRoot(),
    plan: installPlan,
  });
  if (wrapperPalette) {
    userMessages.unshift(wrapperPalette);
  }

  const envVars = buildSessionStartProfilerEnvVars({
    agentBrowserAvailable,
    greenfield: greenfield !== null,
    likelySkills,
    installedSkills,
    missingSkills: skillCacheStatus.missingSkills,
    zeroBundleReady: skillCacheStatus.zeroBundleReady,
    projectSkillManifestPath,
    setupSignals,
  });
  envVars.VERCEL_PLUGIN_INSTALL_PLAN = serializeSkillInstallPlan(installPlan);

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
        if (key === "VERCEL_PLUGIN_GREENFIELD") {
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

  // Prompt telemetry opt-in check (base telemetry is always-on)
  const telemetryPrefPath = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
  let telemetryPref: string | null = null;
  try {
    telemetryPref = readFileSync(telemetryPrefPath, "utf-8").trim();
  } catch {
    // File doesn't exist — user hasn't been asked yet
  }

  if (telemetryPref === "enabled") {
    try {
      setSessionEnv(platform, "VERCEL_PLUGIN_TELEMETRY", "on");
    } catch (error) {
      logCaughtError(log, "session-start-profiler:telemetry-env-export-failed", error, {
        platform,
      });
    }
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
        installedSkills,
        missingSkills: skillCacheStatus.missingSkills,
        zeroBundleReady: skillCacheStatus.zeroBundleReady,
        projectSkillManifestPath,
        greenfield: greenfield !== null,
        bootstrapHints: setupSignals.bootstrapHints,
        resourceHints: setupSignals.resourceHints,
        setupMode: setupSignals.setupMode,
        agentBrowserAvailable,
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

  // Base telemetry — always-on (no opt-in required)
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
