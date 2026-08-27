var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/detect-agent/dist/index.js
var require_dist = __commonJS({
  "node_modules/detect-agent/dist/index.js"(exports, module) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports = {};
    __export(index_exports, {
      KNOWN_AGENTS: () => KNOWN_AGENTS,
      determineAgent: () => determineAgent
    });
    module.exports = __toCommonJS(index_exports);
    var agents_default = {
      $schema: "./agents.schema.json",
      version: 1,
      description: "Language-agnostic specification for detecting AI agents and automated development environments. Agents are evaluated in array order; the first agent whose `match` condition is satisfied wins. Every agent's `match` is a combinator (`anyOf`/`allOf`) whose `conditions` are evaluated as a tree: combinators nest, and `env_set`/`env_value`/`file_exists` are leaf checks. See agents.schema.json for the full structure.",
      aiAgentVar: "AI_AGENT",
      agents: [
        {
          key: "CURSOR",
          name: "cursor",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "CURSOR_TRACE_ID" }]
          }
        },
        {
          key: "CURSOR_CLI",
          name: "cursor-cli",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "CURSOR_AGENT" },
              {
                type: "env_value",
                name: "CURSOR_EXTENSION_HOST_ROLE",
                value: "agent-exec"
              }
            ]
          }
        },
        {
          key: "KIMI",
          name: "kimi",
          description: "Kimi Code plugin hooks. KIMI_CODE_HOME may be configured outside an active Kimi session, so detection uses the plugin-scoped KIMI_PLUGIN_ROOT marker.",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "KIMI_PLUGIN_ROOT" }]
          }
        },
        {
          key: "GROK",
          name: "grok",
          description: "Grok Build plugin hooks. Evaluated before Claude Code because Grok supports Claude Code plugins and may expose compatibility markers.",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "GROK_PLUGIN_ROOT" },
              { type: "env_set", name: "GROK_PLUGIN_DATA" }
            ]
          }
        },
        {
          key: "GEMINI",
          name: "gemini_cli",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "GEMINI_CLI" }]
          }
        },
        {
          key: "CLINE",
          name: "cline",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "CLINE_ACTIVE" }]
          }
        },
        {
          key: "CODEX",
          name: "codex_cli",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "CODEX_SANDBOX" },
              { type: "env_set", name: "CODEX_CI" },
              { type: "env_set", name: "CODEX_THREAD_ID" },
              { type: "env_set", name: "CODEX_SANDBOX_NETWORK_DISABLED" }
            ]
          }
        },
        {
          key: "ANTIGRAVITY",
          name: "antigravity",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "ANTIGRAVITY_AGENT" },
              { type: "env_set", name: "ANTIGRAVITY_CLI_ALIAS" }
            ]
          }
        },
        {
          key: "AUGMENT_CLI",
          name: "augment-cli",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "AUGMENT_AGENT" }]
          }
        },
        {
          key: "OPENCODE",
          name: "open_code",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "OPENCODE_CLIENT" },
              { type: "env_set", name: "OPENCODE" }
            ]
          }
        },
        {
          key: "GOOSE",
          name: "goose",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "GOOSE_PROVIDER" }]
          }
        },
        {
          key: "JUNIE",
          name: "junie",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "JUNIE_DATA" },
              { type: "env_set", name: "JUNIE_SHIM_PATH" }
            ]
          }
        },
        {
          key: "PI",
          name: "pi",
          description: "Matches when the PATH contains a '.pi/agent' (or '.pi\\\\agent') segment.",
          match: {
            type: "anyOf",
            conditions: [
              {
                type: "env_matches",
                name: "PATH",
                pattern: "\\.pi[\\\\/]agent"
              }
            ]
          }
        },
        {
          key: "COWORK",
          name: "cowork",
          description: "Claude Cowork. Evaluated before `claude_code` so the more specific COWORK marker wins. Requires CLAUDE_CODE_IS_COWORK plus a Claude Code marker.",
          match: {
            type: "allOf",
            conditions: [
              { type: "env_set", name: "CLAUDE_CODE_IS_COWORK" },
              {
                type: "anyOf",
                conditions: [
                  { type: "env_set", name: "CLAUDECODE" },
                  { type: "env_set", name: "CLAUDE_CODE" }
                ]
              }
            ]
          }
        },
        {
          key: "CLAUDE",
          name: "claude_code",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "CLAUDECODE" },
              { type: "env_set", name: "CLAUDE_CODE" }
            ]
          }
        },
        {
          key: "REPLIT",
          name: "replit",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "REPL_ID" }]
          }
        },
        {
          key: "GITHUB_COPILOT",
          name: "github-copilot",
          match: {
            type: "anyOf",
            conditions: [
              { type: "env_set", name: "COPILOT_MODEL" },
              { type: "env_set", name: "COPILOT_ALLOW_ALL" },
              { type: "env_set", name: "COPILOT_GITHUB_TOKEN" }
            ]
          }
        },
        {
          key: "KIRO",
          name: "kiro",
          description: "AWS Kiro. TERM_PROGRAM=kiro is set by both the IDE terminal and the CLI agent, so gate on no_tty to avoid misdetecting a human at the integrated terminal.",
          match: {
            type: "allOf",
            conditions: [
              { type: "env_matches", name: "TERM_PROGRAM", pattern: "kiro" },
              { type: "no_tty" }
            ]
          }
        },
        {
          key: "OPENCLAW",
          name: "openclaw",
          match: {
            type: "anyOf",
            conditions: [{ type: "env_set", name: "OPENCLAW_SHELL" }]
          }
        },
        {
          key: "DEVIN",
          name: "devin",
          match: {
            type: "anyOf",
            conditions: [{ type: "file_exists", path: "/opt/.devin" }]
          }
        }
      ]
    };
    var import_promises = __require("fs/promises");
    var import_node_fs2 = __require("fs");
    async function evaluateCondition(condition) {
      switch (condition.type) {
        case "env_set":
          return Boolean(process.env[condition.name]);
        case "env_value":
          return process.env[condition.name] === condition.value;
        case "env_matches": {
          const value = process.env[condition.name];
          if (!value) {
            return false;
          }
          try {
            return new RegExp(condition.pattern).test(value);
          } catch {
            return false;
          }
        }
        case "no_tty":
          return !process.stdout?.isTTY;
        case "file_exists":
          try {
            await (0, import_promises.access)(condition.path, import_node_fs2.constants.F_OK);
            return true;
          } catch {
            return false;
          }
        case "anyOf":
          for (const sub of condition.conditions) {
            if (await evaluateCondition(sub)) {
              return true;
            }
          }
          return false;
        case "allOf":
          for (const sub of condition.conditions) {
            if (!await evaluateCondition(sub)) {
              return false;
            }
          }
          return true;
        default:
          return false;
      }
    }
    var KNOWN_AGENTS = Object.fromEntries(
      agents_default.agents.map(({ key, name }) => [key, name])
    );
    var agents = agents_default.agents;
    var aiAgentVar = agents_default.aiAgentVar;
    function resolveAiAgentStandard() {
      const raw = process.env[aiAgentVar];
      if (!raw) {
        return void 0;
      }
      const value = raw.trim();
      if (!value) {
        return void 0;
      }
      return value;
    }
    async function determineAgent() {
      const aiAgentStandard = resolveAiAgentStandard();
      if (aiAgentStandard) {
        return { isAgent: true, agent: { name: aiAgentStandard } };
      }
      for (const agent of agents) {
        if (await evaluateCondition(agent.match)) {
          return { isAgent: true, agent: { name: agent.name } };
        }
      }
      return { isAgent: false, agent: void 0 };
    }
  }
});

// hooks/src/session-start-profiler.mts
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync
} from "fs";
import { delimiter, join, resolve } from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  formatOutput,
  normalizeInput,
  setSessionEnv
} from "./compat.mjs";
import { pluginRoot, safeReadJson, writeSessionFile } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { hasSessionStartActivationMarkers } from "./session-start-activation.mjs";
import { buildSkillMap } from "./skill-map-frontmatter.mjs";
import {
  refreshActiveSessionMarker,
  trackDauActiveToday
} from "./telemetry.mjs";
var FILE_MARKERS = [
  { file: ".eve", skills: ["eve"] },
  { file: "next.config.js", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mjs", skills: ["nextjs", "turbopack"] },
  { file: "next.config.ts", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mts", skills: ["nextjs", "turbopack"] },
  { file: "vercel.json", skills: ["vercel-cli", "deployments-cicd", "vercel-functions"] },
  { file: "middleware.ts", skills: ["routing-middleware"] },
  { file: "middleware.js", skills: ["routing-middleware"] },
  { file: "components.json", skills: ["shadcn"] },
  { file: "flags.ts", skills: ["flags-sdk"] },
  { file: ".env.local", skills: ["env-vars"] }
];
var PACKAGE_MARKERS = {
  "eve": ["eve"],
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
  "@vercel/global-config": ["vercel-storage"],
  "@vercel/workflow": ["workflow"],
  "@vercel/sandbox": ["vercel-sandbox"],
  "flags": ["flags-sdk"],
  "@flags-sdk/vercel": ["flags-sdk"],
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
  "@vercel/edge-config": "global-config",
  "@vercel/global-config": "global-config"
};
var SETUP_MODE_THRESHOLD = 3;
var GREENFIELD_DEFAULT_SKILLS = [
  "nextjs",
  "ai-sdk",
  "vercel-cli",
  "env-vars"
];
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
function profileProject(projectRoot) {
  const skills = /* @__PURE__ */ new Set();
  for (const marker of FILE_MARKERS) {
    if (existsSync(join(projectRoot, marker.file))) {
      for (const s of marker.skills) skills.add(s);
    }
  }
  const pkg = readPackageJson(projectRoot);
  if (pkg) {
    const allDeps = {
      ...pkg.dependencies || {},
      ...pkg.devDependencies || {}
    };
    for (const [dep, skillSlugs] of Object.entries(PACKAGE_MARKERS)) {
      if (dep in allDeps) {
        for (const s of skillSlugs) skills.add(s);
      }
    }
  }
  const vercelConfig = safeReadJson(join(projectRoot, "vercel.json"));
  if (vercelConfig) {
    if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
      skills.add("routing-middleware");
    }
    if (vercelConfig.functions) skills.add("vercel-functions");
    if (vercelConfig.services) {
      skills.add("vercel-services");
    }
  }
  return [...skills].sort();
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
  if (dirents.some((d) => d.name === ".eve" && d.isDirectory())) {
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
function normalizeDetectedAgentHarness(name) {
  switch (name) {
    case "cursor":
    case "cursor-cli":
      return "cursor";
    case "claude_code":
    case "cowork":
      return "claude-code";
    case "codex_cli":
      return "codex";
    case "github-copilot":
      return "github-copilot";
    case "kimi":
      return "kimi";
    case "grok":
      return "grok";
    default:
      return name === void 0 ? "unknown" : "other";
  }
}
async function determineAgentWithBundledPackage() {
  const hookGlobal = globalThis;
  hookGlobal.require ??= createRequire(import.meta.url);
  const { determineAgent } = await Promise.resolve().then(() => __toESM(require_dist(), 1));
  return determineAgent();
}
async function detectAgentHarness(input, detector = determineAgentWithBundledPackage) {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }
  try {
    const result = await detector();
    return normalizeDetectedAgentHarness(result.isAgent ? result.agent.name : void 0);
  } catch {
    return "unknown";
  }
}
function normalizeSessionStartSessionId(input) {
  if (!input) return null;
  const sessionId = normalizeInput(input).sessionId;
  return sessionId || null;
}
function resolveSessionStartProjectRoot(env = process.env) {
  return env.CLAUDE_PROJECT_ROOT ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
}
function collectBrokenSkillFrontmatterNames(files) {
  return [...new Set(
    files.map((file) => file.replaceAll("\\", "/").split("/").at(-2) || "").filter((skill) => skill !== "")
  )].sort();
}
function logBrokenSkillFrontmatterSummary(rootDir = pluginRoot(), logger = log) {
  if (!logger.isEnabled("summary")) {
    return null;
  }
  try {
    const built = buildSkillMap(join(rootDir, "skills"));
    const brokenSkills = collectBrokenSkillFrontmatterNames(
      built.diagnostics.map((diagnostic) => diagnostic.file)
    );
    if (brokenSkills.length === 0) {
      return null;
    }
    const message = `WARNING: ${brokenSkills.length} skills have broken frontmatter: ${brokenSkills.join(", ")}`;
    logger.summary("session-start-profiler:broken-skill-frontmatter", {
      message,
      brokenSkillCount: brokenSkills.length,
      brokenSkills
    });
    return message;
  } catch (error) {
    logCaughtError(logger, "session-start-profiler:broken-skill-frontmatter-check-failed", error, {
      rootDir
    });
    return null;
  }
}
function buildSessionStartProfilerEnvVars(args) {
  const envVars = {};
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
async function main() {
  const hookInput = parseSessionStartInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartPlatform(hookInput);
  const agentHarness = await detectAgentHarness(hookInput);
  const sessionId = normalizeSessionStartSessionId(hookInput);
  const projectRoot = resolveSessionStartProjectRoot();
  refreshActiveSessionMarker();
  const greenfield = checkGreenfield(projectRoot);
  const shouldActivate = greenfield !== null || !existsSync(projectRoot) || hasSessionStartActivationMarkers(projectRoot);
  if (!shouldActivate) {
    log.debug("session-start-profiler:skipped-non-vercel-project", {
      projectRoot,
      reason: "non-empty-without-vercel-markers"
    });
    if (sessionId) {
      writeSessionFile(sessionId, SESSION_GREENFIELD_KIND, "");
      writeSessionFile(sessionId, SESSION_LIKELY_SKILLS_KIND, "");
    }
    if (platform === "cursor") {
      process.stdout.write(JSON.stringify(formatOutput("cursor", {})));
    }
    await trackDauActiveToday(/* @__PURE__ */ new Date(), { agentHarness }).catch(() => {
    });
    process.exit(0);
  }
  logBrokenSkillFrontmatterSummary();
  const cliStatus = checkVercelCli();
  const userMessages = buildSessionStartProfilerUserMessages(greenfield, cliStatus);
  const likelySkills = greenfield ? GREENFIELD_DEFAULT_SKILLS : profileProject(projectRoot);
  const setupSignals = greenfield ? GREENFIELD_SETUP_SIGNALS : profileBootstrapSignals(projectRoot);
  const greenfieldValue = greenfield ? "true" : "";
  const likelySkillsValue = likelySkills.join(",");
  const envVars = buildSessionStartProfilerEnvVars({
    greenfield: greenfield !== null,
    likelySkills,
    setupSignals
  });
  const cursorOutput = platform === "cursor" ? formatSessionStartProfilerCursorOutput(envVars, userMessages) : null;
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
      envVarCount: Object.keys(envVars).length
    });
  }
  const additionalContext = userMessages.join("\n\n");
  if (platform === "claude-code" && additionalContext) {
    process.stdout.write(`${additionalContext}

`);
  }
  await trackDauActiveToday(/* @__PURE__ */ new Date(), { agentHarness }).catch(() => {
  });
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
  buildSessionStartProfilerEnvVars,
  buildSessionStartProfilerUserMessages,
  checkGreenfield,
  detectAgentHarness,
  detectSessionStartPlatform,
  formatSessionStartProfilerCursorOutput,
  logBrokenSkillFrontmatterSummary,
  normalizeDetectedAgentHarness,
  normalizeSessionStartSessionId,
  parseSessionStartInput,
  profileBootstrapSignals,
  profileProject,
  resolveSessionStartProjectRoot
};
