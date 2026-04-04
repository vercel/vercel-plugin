// hooks/src/session-start-profiler.mts
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { delimiter, join, resolve } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  formatOutput,
  normalizeInput,
  setSessionEnv
} from "./compat.mjs";
import { pluginRoot, profileCachePath, safeReadJson, writeSessionFile } from "./hook-env.mjs";
import { writePersistedSkillInstallPlan } from "./orchestrator-install-plan-state.mjs";
import { resolveProjectStatePaths } from "./project-state-paths.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { loadProjectInstalledSkillState } from "./project-installed-skill-state.mjs";
import { trackBaseEvents, getOrCreateDeviceId } from "./telemetry.mjs";
import {
  buildSkillInstallPlan,
  formatSkillInstallPalette,
  serializeSkillInstallPlan
} from "./orchestrator-install-plan.mjs";
import {
  createRegistryClient,
  formatCommandWithCwd
} from "./registry-client.mjs";
import { loadRegistrySkillMetadata } from "./registry-skill-metadata.mjs";
import {
  createVercelCliDelegator
} from "./vercel-cli-delegator.mjs";
import { formatOrchestratorActionPalette } from "./orchestrator-action-palette.mjs";
var FILE_MARKERS = [
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
  { file: "backend/main.go", skills: ["vercel-services"] }
];
var PACKAGE_MARKERS = {
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
  "@t3-oss/env-nextjs": ["next-forge"]
};
var SETUP_ENV_TEMPLATE_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template"
];
var SETUP_DB_SCRIPT_MARKERS = [
  "db:push",
  "db:seed",
  "db:migrate",
  "db:generate"
];
var SETUP_AUTH_DEPENDENCIES = /* @__PURE__ */ new Set([
  "next-auth",
  "@auth/core",
  "better-auth"
]);
var SETUP_RESOURCE_DEPENDENCIES = {
  "@neondatabase/serverless": "postgres",
  "drizzle-orm": "postgres",
  "@upstash/redis": "redis",
  "@vercel/blob": "blob",
  "@vercel/edge-config": "edge-config"
};
var SETUP_MODE_THRESHOLD = 3;
var GREENFIELD_SETUP_SIGNALS = {
  bootstrapHints: ["greenfield"],
  resourceHints: [],
  setupMode: true
};
var SESSION_GREENFIELD_KIND = "greenfield";
var SESSION_LIKELY_SKILLS_KIND = "likely-skills";
var log = createLogger();
function readPackageJson(projectRoot) {
  return safeReadJson(join(projectRoot, "package.json"));
}
function hasEnvFiles(projectRoot) {
  try {
    const entries = readdirSync(projectRoot);
    return entries.some((entry) => entry === ".env" || entry.startsWith(".env.") && entry.length > 5);
  } catch (error) {
    logCaughtError(log, "session-start-profiler:env-file-scan-failed", error, { projectRoot });
    return false;
  }
}
function hasAiGatewayDependency(pkg) {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.["@ai-sdk/gateway"] || pkg.devDependencies?.["@ai-sdk/gateway"]);
}
function collectProjectFacts(args) {
  const facts = /* @__PURE__ */ new Set();
  if (args.greenfield) {
    facts.add("greenfield");
  }
  if (args.setupSignals.setupMode) {
    facts.add("setup-mode");
  }
  if (!hasEnvFiles(args.projectRoot)) {
    facts.add("no-env-files");
  }
  if (!hasAiGatewayDependency(args.packageJson ?? null)) {
    facts.add("no-ai-gateway-dep");
  }
  return [...facts].sort();
}
function upsertSkillDetection(map, skill, reason) {
  const existing = map.get(skill);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  map.set(skill, { skill, reasons: [reason] });
}
function profileProjectDetections(projectRoot) {
  const detections = /* @__PURE__ */ new Map();
  for (const marker of FILE_MARKERS) {
    if (!existsSync(join(projectRoot, marker.file))) continue;
    for (const skill of marker.skills) {
      upsertSkillDetection(detections, skill, {
        kind: "file",
        source: marker.file,
        detail: `matched file marker ${marker.file}`
      });
    }
  }
  const pkg = readPackageJson(projectRoot);
  if (pkg) {
    const allDeps = {
      ...pkg.dependencies || {},
      ...pkg.devDependencies || {}
    };
    for (const [dep, skills] of Object.entries(PACKAGE_MARKERS)) {
      if (!(dep in allDeps)) continue;
      for (const skill of skills) {
        upsertSkillDetection(detections, skill, {
          kind: "dependency",
          source: dep,
          detail: `matched dependency ${dep}`
        });
      }
    }
  }
  const vercelConfig = safeReadJson(
    join(projectRoot, "vercel.json")
  );
  if (vercelConfig) {
    if (vercelConfig.crons) {
      upsertSkillDetection(detections, "cron-jobs", {
        kind: "vercel-json",
        source: "vercel.json#crons",
        detail: "detected crons config"
      });
    }
    if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
      upsertSkillDetection(detections, "routing-middleware", {
        kind: "vercel-json",
        source: "vercel.json#rewrites|redirects|headers",
        detail: "detected routing config"
      });
    }
    if (vercelConfig.functions) {
      upsertSkillDetection(detections, "vercel-functions", {
        kind: "vercel-json",
        source: "vercel.json#functions",
        detail: "detected function config"
      });
    }
    if (vercelConfig.experimentalServices) {
      upsertSkillDetection(detections, "vercel-services", {
        kind: "vercel-json",
        source: "vercel.json#experimentalServices",
        detail: "detected services config"
      });
    }
  }
  return [...detections.values()].map((detection) => ({
    skill: detection.skill,
    reasons: [...detection.reasons].sort(
      (a, b) => a.source.localeCompare(b.source)
    )
  })).sort((a, b) => a.skill.localeCompare(b.skill));
}
function profileProject(projectRoot) {
  return profileProjectDetections(projectRoot).map((detection) => detection.skill);
}
function profileBootstrapSignals(projectRoot) {
  const bootstrapHints = /* @__PURE__ */ new Set();
  const resourceHints = /* @__PURE__ */ new Set();
  if (SETUP_ENV_TEMPLATE_FILES.some((file) => existsSync(join(projectRoot, file)))) {
    bootstrapHints.add("env-example");
  }
  try {
    const dirents = readdirSync(projectRoot, { withFileTypes: true });
    if (dirents.some((d) => d.isFile() && d.name.toLowerCase().startsWith("readme"))) {
      bootstrapHints.add("readme");
    }
    if (dirents.some((d) => d.isFile() && /^drizzle\.config\./i.test(d.name))) {
      bootstrapHints.add("drizzle-config");
      bootstrapHints.add("postgres");
      resourceHints.add("postgres");
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:profile-bootstrap-signals-readdir-failed", error, { projectRoot });
  }
  if (existsSync(join(projectRoot, "prisma", "schema.prisma"))) {
    bootstrapHints.add("prisma-schema");
    bootstrapHints.add("postgres");
    resourceHints.add("postgres");
  }
  const pkg = readPackageJson(projectRoot);
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const scriptEntries = Object.entries(scripts).map(([name, cmd]) => `${name} ${typeof cmd === "string" ? cmd : ""}`).join("\n");
    for (const marker of SETUP_DB_SCRIPT_MARKERS) {
      if (scriptEntries.includes(marker)) {
        bootstrapHints.add(marker.replace(":", "-"));
      }
    }
    const allDeps = {
      ...pkg.dependencies || {},
      ...pkg.devDependencies || {}
    };
    for (const dep of Object.keys(allDeps)) {
      const resource = SETUP_RESOURCE_DEPENDENCIES[dep];
      if (resource) {
        bootstrapHints.add(resource);
        resourceHints.add(resource);
      }
      if (SETUP_AUTH_DEPENDENCIES.has(dep)) {
        bootstrapHints.add("auth-secret");
      }
    }
  }
  const hints = [...bootstrapHints].sort();
  const resources = [...resourceHints].sort();
  return {
    bootstrapHints: hints,
    resourceHints: resources,
    setupMode: hints.length >= SETUP_MODE_THRESHOLD
  };
}
function checkGreenfield(projectRoot) {
  let dirents;
  try {
    dirents = readdirSync(projectRoot, { withFileTypes: true });
  } catch (error) {
    logCaughtError(log, "session-start-profiler:check-greenfield-readdir-failed", error, { projectRoot });
    return null;
  }
  const hasNonDotDir = dirents.some((d) => !d.name.startsWith("."));
  const hasDotFile = dirents.some((d) => d.name.startsWith(".") && d.isFile());
  if (!hasNonDotDir && !hasDotFile) {
    return { entries: dirents.map((d) => d.name).sort() };
  }
  return null;
}
var VERCEL_VERSION_ARGS = "--version".split(" ");
var NPM_VIEW_ARGS = "view vercel version".split(" ");
var SPAWN_STDIO = "ignore pipe ignore".split(" ");
var EXEC_SYNC_TIMEOUT_MS = 3e3;
var NUMERIC_VERSION_RE = /\d+(?:\.\d+)*/;
var WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
function getBinaryPathCandidates(binaryName) {
  if (process.platform !== "win32") {
    return [binaryName];
  }
  const hasExecutableExtension = /\.[^./\\]+$/.test(binaryName);
  const suffixes = hasExecutableExtension ? [""] : ["", ...WINDOWS_EXECUTABLE_EXTENSIONS];
  return suffixes.map((suffix) => `${binaryName}${suffix}`);
}
function resolveBinaryFromPath(binaryName) {
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
      binaryName
    });
    return null;
  }
  log.debug("session-start-profiler:binary-resolution-skipped", {
    binaryName,
    reason: "not-found"
  });
  return null;
}
function parseVersionSegments(version) {
  const matchedVersion = version.match(NUMERIC_VERSION_RE)?.[0];
  if (!matchedVersion) {
    return null;
  }
  return matchedVersion.split(".").map((segment) => Number.parseInt(segment, 10));
}
function compareVersionSegments(leftVersion, rightVersion) {
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
function checkVercelCli() {
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) {
    return { installed: false, needsUpdate: false };
  }
  let currentVersion;
  try {
    const raw = execFileSync(vercelBinary, VERCEL_VERSION_ARGS, {
      timeout: EXEC_SYNC_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: SPAWN_STDIO
    }).trim();
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "session-start-profiler:vercel-version-check-failed", error, {
      command: vercelBinary,
      args: VERCEL_VERSION_ARGS.join(" ")
    });
    return { installed: false, needsUpdate: false };
  }
  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) {
    return { installed: true, currentVersion, needsUpdate: false };
  }
  let latestVersion;
  try {
    const raw = execFileSync(npmBinary, NPM_VIEW_ARGS, {
      timeout: EXEC_SYNC_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: SPAWN_STDIO
    }).trim();
    latestVersion = raw;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:npm-latest-version-check-failed", error, {
      command: npmBinary,
      args: NPM_VIEW_ARGS.join(" "),
      currentVersion
    });
    return { installed: true, currentVersion, needsUpdate: false };
  }
  const versionComparison = currentVersion && latestVersion ? compareVersionSegments(currentVersion, latestVersion) : null;
  const needsUpdate = versionComparison === null ? !!(currentVersion && latestVersion && currentVersion !== latestVersion) : versionComparison < 0;
  return { installed: true, currentVersion, latestVersion, needsUpdate };
}
var AGENT_BROWSER_BINARY = "agent-browser";
function checkAgentBrowser() {
  return resolveBinaryFromPath(AGENT_BROWSER_BINARY) !== null;
}
function parseSessionStartInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectSessionStartPlatform(input, env = process.env) {
  if (typeof env.CLAUDE_ENV_FILE === "string" && env.CLAUDE_ENV_FILE.trim() !== "") {
    return "claude-code";
  }
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }
  return "claude-code";
}
function normalizeSessionStartSessionId(input) {
  if (!input) return null;
  const sessionId = normalizeInput(input).sessionId;
  return sessionId || null;
}
function resolveSessionStartProjectRoot(env = process.env) {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}
function scanBrokenEngineRules(engineDir) {
  const broken = [];
  let entries;
  try {
    entries = readdirSync(engineDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return broken;
  }
  for (const file of entries) {
    try {
      const content = readFileSync(join(engineDir, file), "utf-8");
      if (/\t/.test(content.split("\n---")[0] ?? "")) {
        broken.push(file.replace(/\.md$/, ""));
        continue;
      }
      if (!content.startsWith("---")) {
        broken.push(file.replace(/\.md$/, ""));
        continue;
      }
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx === -1) {
        broken.push(file.replace(/\.md$/, ""));
        continue;
      }
      const yaml = content.slice(4, endIdx);
      if (!/^name\s*:/m.test(yaml)) {
        broken.push(file.replace(/\.md$/, ""));
      }
    } catch {
      broken.push(file.replace(/\.md$/, ""));
    }
  }
  return broken;
}
function logBrokenEngineFrontmatterSummary(rootDir = pluginRoot(), logger = log) {
  if (!logger.isEnabled("summary")) {
    return null;
  }
  try {
    const engineDir = join(rootDir, "engine");
    if (!existsSync(engineDir)) {
      return null;
    }
    const brokenSkills = scanBrokenEngineRules(engineDir);
    if (brokenSkills.length === 0) {
      return null;
    }
    const message = `WARNING: ${brokenSkills.length} engine rules have broken frontmatter: ${brokenSkills.join(", ")}`;
    logger.summary("session-start-profiler:broken-engine-frontmatter", {
      message,
      brokenEngineRuleCount: brokenSkills.length,
      brokenEngineRules: brokenSkills
    });
    return message;
  } catch (error) {
    logCaughtError(logger, "session-start-profiler:broken-engine-frontmatter-check-failed", error, {
      rootDir
    });
    return null;
  }
}
function buildSessionStartProfilerEnvVars(args) {
  const envVars = {
    VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE: args.agentBrowserAvailable ? "1" : "0"
  };
  if (args.greenfield) {
    envVars.VERCEL_PLUGIN_GREENFIELD = "true";
  }
  if (args.likelySkills.length > 0) {
    envVars.VERCEL_PLUGIN_LIKELY_SKILLS = args.likelySkills.join(",");
  }
  if (args.projectFacts && args.projectFacts.length > 0) {
    envVars.VERCEL_PLUGIN_PROJECT_FACTS = args.projectFacts.join(",");
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
function buildSessionStartProfilerUserMessages(greenfield, cliStatus) {
  const messages = [];
  if (greenfield) {
    messages.push(
      "This is a greenfield project. Skip exploration \u2014 there is no existing code to discover. Start executing immediately."
    );
  }
  if (!cliStatus.installed) {
    messages.push(
      [
        "IMPORTANT: The Vercel CLI is not installed.",
        "Strongly recommend the user install it with `npm i -g vercel` to unlock agentic features like `vercel env pull`, `vercel deploy`, and `vercel logs`."
      ].join("\n")
    );
  } else if (cliStatus.needsUpdate) {
    messages.push(
      [
        `IMPORTANT: The Vercel CLI is outdated (${cliStatus.currentVersion} \u2192 ${cliStatus.latestVersion}).`,
        "Strongly recommend the user upgrade with `npm i -g vercel@latest` or `pnpm add -g vercel@latest` for best compatibility.",
        "The latest version includes significant agentic features and improvements that will greatly enhance their development experience."
      ].join("\n")
    );
  }
  return messages;
}
function formatSessionStartProfilerCursorOutput(envVars, userMessages) {
  const additionalContext = userMessages.join("\n\n");
  return JSON.stringify(formatOutput("cursor", {
    additionalContext: additionalContext || void 0,
    env: envVars
  }));
}
function emitProgressBlock(platform, lines) {
  if (platform !== "claude-code" || lines.length === 0) return;
  process.stdout.write(`${lines.join("\n")}

`);
}
function buildAutoInstallStartBlock(args) {
  return [
    "### Vercel skill cache",
    `- Installing ${args.missingSkills.length} detected skill${args.missingSkills.length === 1 ? "" : "s"} before the session starts`,
    `- Queue: ${args.missingSkills.join(", ")}`,
    `- State root: ${args.stateRoot}`,
    `- Skill cache: ${args.skillsDir}`,
    `- Install plan: ${args.installPlanPath}`
  ];
}
function buildAutoInstallResultBlock(args) {
  const { result } = args;
  const retryCommand = formatCommandWithCwd(
    result.command,
    result.commandCwd
  );
  const outcome = args.refreshedMissingSkills.length === 0 ? "ready" : result.installed.length > 0 || result.reused.length > 0 ? "partial" : "needs attention";
  return [
    `### Vercel skill cache (${outcome})`,
    result.installed.length > 0 ? `- Installed now: ${result.installed.join(", ")}` : null,
    result.reused.length > 0 ? `- Already cached: ${result.reused.join(", ")}` : null,
    args.refreshedInstalledSkills.length > 0 ? `- Cached after refresh: ${args.refreshedInstalledSkills.join(", ")}` : null,
    `- Remaining missing: ${args.refreshedMissingSkills.length > 0 ? args.refreshedMissingSkills.join(", ") : "none"}`,
    `- State root: ${args.stateRoot}`,
    `- Skill cache: ${args.skillsDir}`,
    `- Install plan: ${args.installPlanPath}`,
    retryCommand && args.refreshedMissingSkills.length > 0 ? `- Retry: ${retryCommand}` : null
  ].filter((line) => Boolean(line)).join("\n");
}
function loadRegistryMap(rootDir = pluginRoot()) {
  const map = /* @__PURE__ */ new Map();
  for (const [name, metadata] of loadRegistrySkillMetadata(rootDir)) {
    if (metadata.registry.length > 0) {
      map.set(name, metadata.registry);
    }
  }
  return map;
}
function mergeInstallResults(results) {
  const installed = /* @__PURE__ */ new Set();
  const reused = /* @__PURE__ */ new Set();
  const missing = /* @__PURE__ */ new Set();
  const commands = [];
  let commandCwd = null;
  for (const result of results) {
    result.installed.forEach((skill) => installed.add(skill));
    result.reused.forEach((skill) => reused.add(skill));
    result.missing.forEach((skill) => missing.add(skill));
    if (result.command) {
      commands.push(result.command);
      commandCwd = commandCwd ?? result.commandCwd;
    }
  }
  installed.forEach((skill) => missing.delete(skill));
  reused.forEach((skill) => missing.delete(skill));
  return {
    installed: [...installed].sort(),
    reused: [...reused].sort(),
    missing: [...missing].sort(),
    command: commands.length > 0 ? commands.join(" && ") : null,
    commandCwd
  };
}
function shouldAutoInstall(args) {
  if (args.greenfield) return false;
  if (process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL === "1") return true;
  if (args.installedSkillCount === 0 && args.missingSkillCount > 0) return true;
  return false;
}
async function autoInstallDetectedSkills(args) {
  const emptyResult = {
    installed: [],
    reused: [],
    missing: [...args.missingSkills],
    command: null,
    commandCwd: null
  };
  if (args.missingSkills.length === 0) {
    return emptyResult;
  }
  const registryMetadata = args.registryMetadata ?? loadRegistrySkillMetadata();
  const registryMap = args.registryMap ?? new Map(
    [...registryMetadata].map(([skill, metadata]) => [skill, metadata.registry])
  );
  const registryBacked = args.missingSkills.filter((s) => registryMap.has(s));
  const skipped = args.missingSkills.filter((s) => !registryMap.has(s));
  args.logger?.debug("session-start-profiler-auto-install-start", {
    projectRoot: args.projectRoot,
    missingSkills: args.missingSkills,
    registryBacked,
    skippedNonRegistry: skipped,
    registryMetadataCount: registryMetadata.size
  });
  if (registryBacked.length === 0) {
    return {
      ...emptyResult,
      missing: args.missingSkills
    };
  }
  const installGroups = /* @__PURE__ */ new Map();
  for (const skill of registryBacked) {
    const registry = registryMap.get(skill);
    if (!registry) continue;
    const group = installGroups.get(registry) ?? [];
    const metadata = registryMetadata.get(skill);
    group.push({
      requestedName: skill,
      installName: metadata?.registrySlug ?? skill
    });
    installGroups.set(registry, group);
  }
  try {
    const results = [];
    for (const [registry, installTargets] of installGroups) {
      const client = createRegistryClient({
        source: args.skillsSource ?? registry
      });
      results.push(await client.installSkills({
        projectRoot: args.projectRoot,
        source: args.skillsSource ?? registry,
        skillNames: installTargets.map((target) => target.requestedName),
        installTargets
      }));
    }
    const result = mergeInstallResults(results);
    args.logger?.debug("session-start-profiler-auto-install-result", {
      projectRoot: args.projectRoot,
      installed: result.installed,
      reused: result.reused,
      missing: result.missing,
      skippedNonRegistry: skipped,
      command: result.command
    });
    return {
      ...result,
      missing: [...result.missing, ...skipped]
    };
  } catch (error) {
    logCaughtError(
      args.logger ?? log,
      "session-start-profiler:auto-install-failed",
      error,
      {
        projectRoot: args.projectRoot,
        missingSkillCount: args.missingSkills.length
      }
    );
    return emptyResult;
  }
}
async function autoPullProjectEnv(args) {
  if (process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL !== "1" || !args.vercelLinked || args.hasEnvLocal) {
    return null;
  }
  const delegator = args.delegator ?? createVercelCliDelegator();
  const result = await delegator.run({
    projectRoot: args.projectRoot,
    subcommand: "env-pull"
  });
  if (!result.ok) {
    logCaughtError(
      args.logger ?? log,
      "session-start-profiler:auto-env-pull-failed",
      new Error(result.stderr || "vercel env pull failed"),
      { projectRoot: args.projectRoot, command: result.command }
    );
  }
  return result;
}
async function main() {
  const hookInput = parseSessionStartInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartPlatform(hookInput);
  const sessionId = normalizeSessionStartSessionId(hookInput);
  const projectRoot = resolveSessionStartProjectRoot();
  const statePaths = resolveProjectStatePaths(projectRoot);
  log.debug("session-start-profiler-state-paths", {
    projectRoot,
    stateRoot: statePaths.stateRoot,
    skillsDir: statePaths.skillsDir,
    installPlanPath: statePaths.installPlanPath
  });
  logBrokenEngineFrontmatterSummary();
  const greenfield = checkGreenfield(projectRoot);
  const cliStatus = checkVercelCli();
  const userMessages = buildSessionStartProfilerUserMessages(greenfield, cliStatus);
  const detections = greenfield ? [] : profileProjectDetections(projectRoot);
  const likelySkills = detections.map((detection) => detection.skill);
  if (!greenfield && !likelySkills.includes("observability")) {
    likelySkills.push("observability");
    detections.push({
      skill: "observability",
      reasons: [
        {
          kind: "profiler-default",
          source: "profiler-default",
          detail: "auto-boosted for non-greenfield debugging coverage"
        }
      ]
    });
  }
  likelySkills.sort();
  const packageJson = readPackageJson(projectRoot);
  const setupSignals = greenfield ? GREENFIELD_SETUP_SIGNALS : profileBootstrapSignals(projectRoot);
  const projectFacts = collectProjectFacts({
    greenfield: greenfield !== null,
    setupSignals,
    projectRoot,
    packageJson
  });
  const greenfieldValue = greenfield ? "true" : "";
  const likelySkillsValue = likelySkills.join(",");
  const agentBrowserAvailable = checkAgentBrowser();
  const bundledFallbackEnabled = process.env.VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK !== "1";
  let installedState = loadProjectInstalledSkillState({
    projectRoot,
    pluginRoot: pluginRoot(),
    likelySkills,
    bundledFallbackEnabled,
    logger: log
  });
  let skillStore = installedState.skillStore;
  let installedSkills = installedState.installedSkills;
  let skillCacheStatus = installedState.cacheStatus;
  const missingBeforeInstall = [...skillCacheStatus.missingSkills];
  const autoInstallEnabled = shouldAutoInstall({
    installedSkillCount: installedSkills.length,
    missingSkillCount: missingBeforeInstall.length,
    greenfield: greenfield !== null
  });
  const registryMetadata = loadRegistrySkillMetadata(pluginRoot());
  const registryMap = new Map(
    [...registryMetadata].map(([skill, metadata]) => [skill, metadata.registry])
  );
  const registryBackedMissing = missingBeforeInstall.filter((s) => registryMap.has(s));
  log.debug("session-start-profiler-auto-install-gate", {
    autoInstallEnabled,
    missingBeforeInstall,
    registryBackedMissing,
    installedSkillCount: installedSkills.length,
    envVar: process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL ?? null
  });
  if (autoInstallEnabled && registryBackedMissing.length > 0) {
    emitProgressBlock(
      platform,
      buildAutoInstallStartBlock({
        missingSkills: registryBackedMissing,
        stateRoot: statePaths.stateRoot,
        skillsDir: statePaths.skillsDir,
        installPlanPath: statePaths.installPlanPath
      })
    );
  }
  const installResult = await (autoInstallEnabled ? autoInstallDetectedSkills({
    projectRoot,
    missingSkills: registryBackedMissing,
    registryMap,
    registryMetadata,
    logger: log
  }) : Promise.resolve({
    installed: [],
    reused: [],
    missing: missingBeforeInstall,
    command: null,
    commandCwd: null
  }));
  if (autoInstallEnabled && registryBackedMissing.length > 0) {
    installedState = loadProjectInstalledSkillState({
      projectRoot,
      pluginRoot: pluginRoot(),
      likelySkills,
      bundledFallbackEnabled,
      logger: log
    });
    skillStore = installedState.skillStore;
    installedSkills = installedState.installedSkills;
    skillCacheStatus = installedState.cacheStatus;
    log.debug("session-start-profiler-post-install-refresh", {
      projectRoot,
      installedSkills,
      missingBeforeInstall,
      installResultInstalled: installResult.installed,
      installResultReused: installResult.reused,
      installResultMissing: installResult.missing,
      cacheStatusMissing: skillCacheStatus.missingSkills
    });
    log.debug("session-start-profiler-auto-install-rendered-status", {
      projectRoot,
      refreshedInstalledSkills: installedSkills,
      refreshedMissingSkills: skillCacheStatus.missingSkills,
      renderedOutcome: skillCacheStatus.missingSkills.length === 0 ? "ready" : installResult.installed.length > 0 || installResult.reused.length > 0 ? "partial" : "needs attention",
      retryCommand: formatCommandWithCwd(
        installResult.command,
        installResult.commandCwd
      )
    });
  }
  if (autoInstallEnabled && registryBackedMissing.length > 0) {
    userMessages.unshift(
      buildAutoInstallResultBlock({
        result: installResult,
        stateRoot: statePaths.stateRoot,
        skillsDir: statePaths.skillsDir,
        installPlanPath: statePaths.installPlanPath,
        refreshedInstalledSkills: installedSkills,
        refreshedMissingSkills: skillCacheStatus.missingSkills
      })
    );
  }
  const projectSkillManifestPath = installedState.projectState.projectSkillStatePath;
  let vercelLinked = existsSync(join(projectRoot, ".vercel"));
  let hasEnvLocal = existsSync(join(projectRoot, ".env.local"));
  const envPullResult = await autoPullProjectEnv({
    projectRoot,
    vercelLinked,
    hasEnvLocal,
    logger: log
  });
  vercelLinked = existsSync(join(projectRoot, ".vercel"));
  hasEnvLocal = existsSync(join(projectRoot, ".env.local"));
  if (envPullResult?.ok && envPullResult.changed) {
    userMessages.unshift(
      [
        "### Vercel CLI delegation",
        "- Delegated: vercel env pull",
        `- Command: \`${envPullResult.command}\``,
        `- Created: ${join(projectRoot, ".env.local")}`
      ].join("\n")
    );
  }
  const installPlan = buildSkillInstallPlan({
    projectRoot,
    detections,
    installedSkills,
    bundledFallbackEnabled,
    zeroBundleReady: skillCacheStatus.zeroBundleReady,
    projectSkillManifestPath,
    vercelLinked,
    hasEnvLocal
  });
  log.debug("session-start-profiler-install-plan-install-action", {
    projectRoot,
    installAction: installPlan.actions.find((action) => action.id === "install-missing") ?? null
  });
  try {
    writePersistedSkillInstallPlan(installPlan, log);
  } catch (error) {
    logCaughtError(log, "session-start-profiler:write-install-plan-failed", error, {
      projectRoot
    });
  }
  const installPalette = formatSkillInstallPalette(installPlan);
  if (installPalette) {
    userMessages.unshift(installPalette);
  }
  const wrapperPalette = formatOrchestratorActionPalette({
    pluginRoot: pluginRoot(),
    plan: installPlan
  });
  if (wrapperPalette) {
    userMessages.unshift(wrapperPalette);
  }
  const envVars = buildSessionStartProfilerEnvVars({
    agentBrowserAvailable,
    greenfield: greenfield !== null,
    likelySkills,
    projectFacts,
    installedSkills,
    missingSkills: skillCacheStatus.missingSkills,
    zeroBundleReady: skillCacheStatus.zeroBundleReady,
    projectSkillManifestPath,
    setupSignals
  });
  envVars.VERCEL_PLUGIN_INSTALL_PLAN = serializeSkillInstallPlan(installPlan);
  const cursorOutput = platform === "cursor" ? formatSessionStartProfilerCursorOutput(envVars, userMessages) : null;
  if (sessionId) {
    writeSessionFile(sessionId, SESSION_GREENFIELD_KIND, greenfieldValue);
    writeSessionFile(sessionId, SESSION_LIKELY_SKILLS_KIND, likelySkillsValue);
  }
  try {
    if (platform === "claude-code") {
      for (const [key, value] of Object.entries(envVars)) {
        setSessionEnv(platform, key, value);
      }
    }
  } catch (error) {
    logCaughtError(log, "session-start-profiler:append-env-export-failed", error, {
      platform,
      projectRoot,
      envVarCount: Object.keys(envVars).length
    });
  }
  const telemetryPrefPath = join(homedir(), ".claude", "vercel-plugin-telemetry-preference");
  let telemetryPref = null;
  try {
    telemetryPref = readFileSync(telemetryPrefPath, "utf-8").trim();
  } catch {
  }
  if (telemetryPref === "enabled") {
    try {
      setSessionEnv(platform, "VERCEL_PLUGIN_TELEMETRY", "on");
    } catch (error) {
      logCaughtError(log, "session-start-profiler:telemetry-env-export-failed", error, {
        platform
      });
    }
  }
  const additionalContext = userMessages.join("\n\n");
  if (platform === "claude-code" && additionalContext) {
    process.stdout.write(`${additionalContext}

`);
  }
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
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      writeFileSync(profileCachePath(sessionId), JSON.stringify(cache), "utf-8");
    } catch (error) {
      logCaughtError(log, "session-start-profiler:write-profile-cache-failed", error, {
        sessionId,
        projectRoot
      });
    }
  }
  if (sessionId) {
    const deviceId = getOrCreateDeviceId();
    await trackBaseEvents(sessionId, [
      { key: "session:device_id", value: deviceId },
      { key: "session:platform", value: process.platform },
      { key: "session:likely_skills", value: likelySkills.join(",") },
      { key: "session:greenfield", value: String(greenfield !== null) },
      { key: "session:vercel_cli_installed", value: String(cliStatus.installed) },
      { key: "session:vercel_cli_version", value: cliStatus.currentVersion || "" }
    ]).catch(() => {
    });
  }
  if (cursorOutput) {
    process.stdout.write(cursorOutput);
  }
  process.exit(0);
}
var SESSION_START_PROFILER_ENTRYPOINT = fileURLToPath(import.meta.url);
var isSessionStartProfilerEntrypoint = process.argv[1] ? resolve(process.argv[1]) === SESSION_START_PROFILER_ENTRYPOINT : false;
if (isSessionStartProfilerEntrypoint) {
  main();
}
export {
  autoInstallDetectedSkills,
  autoPullProjectEnv,
  buildAutoInstallResultBlock,
  buildAutoInstallStartBlock,
  buildSessionStartProfilerEnvVars,
  buildSessionStartProfilerUserMessages,
  checkAgentBrowser,
  checkGreenfield,
  collectProjectFacts,
  detectSessionStartPlatform,
  emitProgressBlock,
  formatSessionStartProfilerCursorOutput,
  loadRegistryMap,
  logBrokenEngineFrontmatterSummary,
  normalizeSessionStartSessionId,
  parseSessionStartInput,
  profileBootstrapSignals,
  profileProject,
  profileProjectDetections,
  resolveSessionStartProjectRoot,
  shouldAutoInstall
};
