// hooks/src/opencode-plugin.mts
import { exec, execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join, sep } from "path";
import { setTimeout as delay } from "timers/promises";
import { promisify } from "util";
import { pluginRoot, safeReadFile, safeReadJson } from "./hook-env.mjs";
import { buildInjectClaudeMdParts } from "./inject-claude-md.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
import { hasSessionStartActivationMarkers } from "./session-start-activation.mjs";
import {
  NPM_VIEW_ARGS,
  VERCEL_VERSION_ARGS,
  binaryNeedsShell,
  buildSessionStartProfilerUserMessages,
  buildShellCommand,
  checkGreenfield,
  compareVersionSegments,
  resolveBinaryFromPath
} from "./session-start-profiler.mjs";
import { extractFrontmatter, parseSkillFrontmatter } from "./skill-map-frontmatter.mjs";
import {
  SKILL_INVOKED_EVENT_KEY,
  isDauTelemetryEnabled,
  refreshActiveSessionMarker,
  trackDauActiveToday,
  trackSkillEvents
} from "./telemetry.mjs";
var log = createLogger();
var CLI_STATUS_TTL_MS = 60 * 60 * 1e3;
var CLI_EXEC_TIMEOUT_MS = 3e3;
var MAX_TRACKED_SESSIONS = 500;
var UNKNOWN_CLI_STATUS = { installed: true, needsUpdate: false };
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    logCaughtError(log, "opencode-plugin:read-dir-failed", error, { dir });
    return [];
  }
}
function readMarkdown(path, slug) {
  const raw = safeReadFile(path);
  if (raw === null) return null;
  const { yaml, body } = extractFrontmatter(raw);
  try {
    const { name, description } = parseSkillFrontmatter(yaml);
    return { slug, name: name || void 0, description: description || void 0, body: body.trim() };
  } catch (error) {
    logCaughtError(log, "opencode-plugin:frontmatter-parse-failed", error, { path });
    return null;
  }
}
function loadSkills(root) {
  const skillsDir = join(root, "skills");
  return listDir(skillsDir).flatMap((entry) => {
    const path = join(skillsDir, entry.name, "SKILL.md");
    const skill = entry.isDirectory() && existsSync(path) ? readMarkdown(path, entry.name) : null;
    if (!skill) return [];
    return [{ id: skill.slug, name: skill.name ?? skill.slug, description: skill.description, path, content: skill.body }];
  });
}
function loadMarkdownDir(dir) {
  return listDir(dir).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_")) return [];
    const file = readMarkdown(join(dir, entry.name), entry.name.slice(0, -".md".length));
    return file ? [file] : [];
  });
}
function loadMcpServers(root) {
  const config = safeReadJson(join(root, ".mcp.json"));
  return Object.entries(config?.mcpServers ?? {}).flatMap(([name, server]) => {
    if (server.type === "http" && server.url) {
      return [[name, { type: "remote", url: server.url, ...server.headers && { headers: server.headers } }]];
    }
    if ((server.type === void 0 || server.type === "stdio") && server.command) {
      const command = [server.command, ...server.args ?? []];
      return [[name, { type: "local", command, ...server.env && { environment: server.env } }]];
    }
    log.debug("opencode-plugin:mcp-server-skipped", { name, type: server.type });
    return [];
  });
}
function renderCommand(template, args) {
  const trimmed = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", trimmed);
  return trimmed ? `${template}

${trimmed}` : template;
}
var execFileAsync = promisify(execFile);
var execAsync = promisify(exec);
async function runBinary(binaryPath, args) {
  const options = { timeout: CLI_EXEC_TIMEOUT_MS, encoding: "utf-8", windowsHide: true };
  const { stdout } = binaryNeedsShell(binaryPath) ? await execAsync(buildShellCommand(binaryPath, args), options) : await execFileAsync(binaryPath, args, options);
  return stdout.trim();
}
async function checkVercelCliAsync() {
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) return { installed: false, needsUpdate: false };
  let currentVersion;
  try {
    const output = await runBinary(vercelBinary, VERCEL_VERSION_ARGS);
    currentVersion = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  } catch (error) {
    logCaughtError(log, "opencode-plugin:vercel-version-check-failed", error, { command: vercelBinary });
    return UNKNOWN_CLI_STATUS;
  }
  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) return { installed: true, currentVersion, needsUpdate: false };
  let latestVersion;
  try {
    latestVersion = await runBinary(npmBinary, NPM_VIEW_ARGS);
  } catch (error) {
    logCaughtError(log, "opencode-plugin:npm-latest-version-check-failed", error, { command: npmBinary });
    return { installed: true, currentVersion, needsUpdate: false };
  }
  const comparison = currentVersion && latestVersion ? compareVersionSegments(currentVersion, latestVersion) : null;
  const needsUpdate = comparison === null ? !!(currentVersion && latestVersion && currentVersion !== latestVersion) : comparison < 0;
  return { installed: true, currentVersion, latestVersion, needsUpdate };
}
async function buildSessionContext(directory, root, env, cliStatus) {
  const greenfield = checkGreenfield(directory);
  const greenfieldOverride = env.VERCEL_PLUGIN_GREENFIELD === "true";
  const profilerActive = greenfield !== null || !existsSync(directory) || hasSessionStartActivationMarkers(directory);
  if (!profilerActive && !greenfieldOverride) return null;
  const profilerMessages = profilerActive ? buildSessionStartProfilerUserMessages(greenfield, await cliStatus()) : [];
  const knowledgeUpdate = safeReadFile(join(root, "skills", "knowledge-update", "SKILL.md"));
  const injectParts = buildInjectClaudeMdParts(
    safeReadFile(join(root, "vercel-session.md")),
    env,
    knowledgeUpdate === null ? null : extractFrontmatter(knowledgeUpdate).body.trim(),
    greenfield !== null || greenfieldOverride
  );
  return [...profilerMessages, ...injectParts].join("\n\n") || null;
}
var defaultDeps = {
  root: pluginRoot(import.meta.url),
  env: process.env,
  checkVercelCli: checkVercelCliAsync,
  cliStatusWaitMs: 3e3,
  refreshActiveSessionMarker,
  trackDauActiveToday,
  trackSkillEvents
};
function createOpenCodePlugin(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  let cliStatus = null;
  function vercelCliStatus() {
    if (!cliStatus || Date.now() - cliStatus.startedAt > CLI_STATUS_TTL_MS) {
      cliStatus = { startedAt: Date.now(), promise: deps.checkVercelCli().catch(() => UNKNOWN_CLI_STATUS) };
    }
    return Promise.race([cliStatus.promise, delay(deps.cliStatusWaitMs, UNKNOWN_CLI_STATUS, { ref: false })]);
  }
  return {
    id: "vercel-plugin",
    async setup(ctx) {
      const telemetryEnabled = () => ctx.options.telemetry !== false && isDauTelemetryEnabled(deps.env);
      const skills = loadSkills(deps.root);
      const pluginSkillIds = new Set(skills.map((skill) => skill.id));
      const skillsDir = join(deps.root, "skills") + sep;
      const sessions = /* @__PURE__ */ new Map();
      await ctx.skill.transform((editor) => {
        for (const skill of skills) {
          if (!editor.get(skill.id)) editor.add(skill);
        }
      });
      const agents = loadMarkdownDir(join(deps.root, "agents"));
      await ctx.agent.transform((editor) => {
        for (const agent of agents) {
          const id = agent.name ?? agent.slug;
          if (editor.get(id)) continue;
          editor.update(id, (draft) => {
            draft.name = id;
            draft.description = agent.description;
            draft.mode = "subagent";
            draft.system = agent.body;
          });
        }
        for (const { id } of editor.list()) {
          editor.update(id, (draft) => {
            draft.permissions.push({ action: "external_directory", resource: join(skillsDir, "*"), effect: "allow" });
          });
        }
      });
      const mcpServers = loadMcpServers(deps.root);
      await ctx.mcp.transform((editor) => {
        for (const [name, config] of mcpServers) {
          if (!editor.get(name)) editor.set(name, config);
        }
      });
      const commands = loadMarkdownDir(join(deps.root, "commands"));
      await ctx.command.transform((editor) => {
        for (const command of commands) {
          editor.add({
            // Mirrors Claude Code's `/vercel:<command>`.
            name: `vercel:${command.slug}`,
            description: command.description,
            execute: async ({ sessionID, prompt, delivery }) => {
              const text = renderCommand(command.body, prompt.text ?? "");
              await ctx.session.prompt({ ...prompt, sessionID, delivery, text });
            }
          });
        }
      });
      async function resolveSession(sessionID) {
        const session = await ctx.session.get({ sessionID });
        if (session.parentID) {
          const parent = await sessionState(session.parentID);
          return { context: null, telemetrySessionId: parent.telemetrySessionId };
        }
        if (telemetryEnabled()) {
          deps.refreshActiveSessionMarker();
          void deps.trackDauActiveToday(/* @__PURE__ */ new Date(), { agentHarness: "opencode" }).catch(() => {
          });
        }
        const context = await buildSessionContext(session.location.directory, deps.root, deps.env, vercelCliStatus);
        return { context, telemetrySessionId: randomUUID() };
      }
      function sessionState(sessionID) {
        let state = sessions.get(sessionID);
        if (!state) {
          state = resolveSession(sessionID);
          state.catch(() => sessions.delete(sessionID));
          sessions.set(sessionID, state);
          if (sessions.size > MAX_TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value);
        }
        return state;
      }
      await ctx.session.hook("context", async (event) => {
        try {
          const { context } = await sessionState(event.sessionID);
          if (context) event.system.push({ type: "text", text: context });
        } catch (error) {
          logCaughtError(log, "opencode-plugin:session-context-failed", error, { sessionID: event.sessionID });
        }
      });
      async function reportSkillInvocation(sessionID, skillID) {
        const loaded = (await ctx.skill.list()).data.find((skill) => skill.id === skillID);
        if (!loaded?.path.startsWith(skillsDir)) return;
        const { telemetrySessionId } = await sessionState(sessionID);
        await deps.trackSkillEvents(SKILL_INVOKED_EVENT_KEY, [skillID], {
          telemetrySessionId,
          agentHarness: "opencode"
        });
      }
      await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== "skill" || event.status !== "completed" || !telemetryEnabled()) return;
        const skillID = event.input?.id;
        if (typeof skillID !== "string" || !pluginSkillIds.has(skillID)) return;
        reportSkillInvocation(event.sessionID, skillID).catch((error) => {
          logCaughtError(log, "opencode-plugin:skill-telemetry-failed", error, { skillID });
        });
      });
    }
  };
}
var opencode_plugin_default = createOpenCodePlugin();
export {
  createOpenCodePlugin,
  opencode_plugin_default as default
};
