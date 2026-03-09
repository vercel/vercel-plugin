import { existsSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireEnvFile, safeReadJson } from "./hook-env.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
const FILE_MARKERS = [
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
  { file: ".env.local", skills: ["env-vars"] }
];
const PACKAGE_MARKERS = {
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
  "turbo": ["turborepo"]
};
const SETUP_ENV_TEMPLATE_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template"
];
const SETUP_DB_SCRIPT_MARKERS = [
  "db:push",
  "db:seed",
  "db:migrate",
  "db:generate"
];
const SETUP_AUTH_DEPENDENCIES = /* @__PURE__ */ new Set([
  "next-auth",
  "@auth/core",
  "better-auth"
]);
const SETUP_RESOURCE_DEPENDENCIES = {
  "@neondatabase/serverless": "postgres",
  "drizzle-orm": "postgres",
  "@upstash/redis": "redis",
  "@vercel/blob": "blob",
  "@vercel/edge-config": "edge-config"
};
const SETUP_MODE_THRESHOLD = 3;
const GREENFIELD_DEFAULT_SKILLS = [
  "nextjs",
  "ai-sdk",
  "vercel-cli",
  "env-vars"
];
const GREENFIELD_SETUP_SIGNALS = {
  bootstrapHints: ["greenfield"],
  resourceHints: [],
  setupMode: true
};
const log = createLogger();
function readPackageJson(projectRoot) {
  return safeReadJson(join(projectRoot, "package.json"));
}
function escapeShellEnvValue(value) {
  return value.replace(/(["\\$`])/g, "\\$1");
}
function formatEnvExport(key, value) {
  return `export ${key}="${escapeShellEnvValue(value)}"
`;
}
function appendEnvExport(envFile, key, value) {
  appendFileSync(envFile, formatEnvExport(key, value));
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
    if (vercelConfig.crons) skills.add("cron-jobs");
    if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
      skills.add("routing-middleware");
    }
    if (vercelConfig.functions) skills.add("vercel-functions");
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
  const hasNonDotDir = dirents.some((d) => !d.name.startsWith("."));
  const hasDotFile = dirents.some((d) => d.name.startsWith(".") && d.isFile());
  if (!hasNonDotDir && !hasDotFile) {
    return { entries: dirents.map((d) => d.name).sort() };
  }
  return null;
}
const VERCEL_VERSION_ARGS = "--version".split(" ");
const NPM_VIEW_ARGS = "view vercel version".split(" ");
const SPAWN_STDIO = "ignore pipe ignore".split(" ");
const NUMERIC_VERSION_RE = /\d+(?:\.\d+)*/;
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
  let currentVersion;
  try {
    const raw = execFileSync("vercel", VERCEL_VERSION_ARGS, {
      timeout: 5e3,
      encoding: "utf-8",
      stdio: SPAWN_STDIO
    }).trim();
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "session-start-profiler:vercel-version-check-failed", error, {
      command: "vercel",
      args: VERCEL_VERSION_ARGS.join(" ")
    });
    return { installed: false, needsUpdate: false };
  }
  let latestVersion;
  try {
    const raw = execFileSync("npm", NPM_VIEW_ARGS, {
      timeout: 5e3,
      encoding: "utf-8",
      stdio: SPAWN_STDIO
    }).trim();
    latestVersion = raw;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:npm-latest-version-check-failed", error, {
      command: "npm",
      args: NPM_VIEW_ARGS.join(" "),
      currentVersion
    });
    return { installed: true, currentVersion, needsUpdate: false };
  }
  const versionComparison = currentVersion && latestVersion ? compareVersionSegments(currentVersion, latestVersion) : null;
  const needsUpdate = versionComparison === null ? !!(currentVersion && latestVersion && currentVersion !== latestVersion) : versionComparison < 0;
  return { installed: true, currentVersion, latestVersion, needsUpdate };
}
const WHICH_ARGS = "agent-browser".split(" ");
function checkAgentBrowser() {
  try {
    execFileSync("which", WHICH_ARGS, {
      timeout: 3e3,
      encoding: "utf-8",
      stdio: SPAWN_STDIO
    });
    return true;
  } catch (error) {
    logCaughtError(log, "session-start-profiler:agent-browser-check-failed", error, {
      command: "which",
      args: WHICH_ARGS.join(" ")
    });
    return false;
  }
}
function main() {
  const envFile = requireEnvFile();
  const projectRoot = process.env.CLAUDE_PROJECT_ROOT || process.cwd();
  const greenfield = checkGreenfield(projectRoot);
  if (greenfield) {
    process.stdout.write(
      "This is a greenfield project. Skip exploration \u2014 there is no existing code to discover. Start executing immediately.\n"
    );
  }
  const cliStatus = checkVercelCli();
  if (!cliStatus.installed) {
    process.stdout.write(
      [
        "IMPORTANT: The Vercel CLI is not installed.",
        "Strongly recommend the user install it with `npm i -g vercel` to unlock agentic features like `vercel env pull`, `vercel deploy`, and `vercel logs`.",
        ""
      ].join("\n")
    );
  } else if (cliStatus.needsUpdate) {
    process.stdout.write(
      [
        `IMPORTANT: The Vercel CLI is outdated (${cliStatus.currentVersion} \u2192 ${cliStatus.latestVersion}).`,
        "Strongly recommend the user upgrade with `npm i -g vercel@latest`.",
        "The latest version includes significant agentic features and improvements that will greatly enhance their development experience.",
        ""
      ].join("\n")
    );
  }
  const likelySkills = greenfield ? GREENFIELD_DEFAULT_SKILLS : profileProject(projectRoot);
  if (!greenfield && !likelySkills.includes("observability")) {
    likelySkills.push("observability");
    likelySkills.sort();
  }
  const setupSignals = greenfield ? GREENFIELD_SETUP_SIGNALS : profileBootstrapSignals(projectRoot);
  const agentBrowserAvailable = checkAgentBrowser();
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
      setupMode: setupSignals.setupMode
    });
  }
  process.exit(0);
}
const SESSION_START_PROFILER_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartProfilerEntrypoint = process.argv[1] ? resolve(process.argv[1]) === SESSION_START_PROFILER_ENTRYPOINT : false;
if (isSessionStartProfilerEntrypoint) {
  main();
}
export {
  checkAgentBrowser,
  checkGreenfield,
  escapeShellEnvValue,
  formatEnvExport,
  profileBootstrapSignals,
  profileProject
};
