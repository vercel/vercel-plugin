// hooks/src/opencode-plugin.mts
import { exec, execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join, sep } from "path";
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
var OPENCODE_PLUGIN_ID = "vercel-plugin";
var OPENCODE_COMMAND_NAMESPACE = "vercel";
var SKILL_TOOL_ID = "skill";
var CLI_STATUS_TTL_MS = 60 * 60 * 1e3;
var CLI_EXEC_TIMEOUT_MS = 3e3;
var MAX_TRACKED_SESSIONS = 500;
function readMarkdownFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    logCaughtError(log, "opencode-plugin:read-dir-failed", error, { dir });
    return [];
  }
}
function parseMarkdown(path) {
  const raw = safeReadFile(path);
  if (raw === null) return null;
  const { yaml, body } = extractFrontmatter(raw);
  try {
    const frontmatter = parseSkillFrontmatter(yaml);
    return {
      name: frontmatter.name || void 0,
      description: frontmatter.description || void 0,
      body: body.trim()
    };
  } catch (error) {
    logCaughtError(log, "opencode-plugin:frontmatter-parse-failed", error, { path });
    return null;
  }
}
function loadOpenCodeSkills(root) {
  const skillsDir = join(root, "skills");
  const skills = [];
  for (const entry of readMarkdownFiles(skillsDir)) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const parsed = parseMarkdown(path);
    if (!parsed) continue;
    skills.push({
      id: entry.name,
      name: parsed.name ?? entry.name,
      description: parsed.description,
      path,
      content: parsed.body
    });
  }
  return skills;
}
function loadOpenCodeCommands(root) {
  const commandsDir = join(root, "commands");
  const commands = [];
  for (const entry of readMarkdownFiles(commandsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_")) continue;
    const parsed = parseMarkdown(join(commandsDir, entry.name));
    if (!parsed) continue;
    commands.push({
      name: `${OPENCODE_COMMAND_NAMESPACE}:${entry.name.slice(0, -".md".length)}`,
      description: parsed.description,
      template: parsed.body
    });
  }
  return commands;
}
function loadOpenCodeAgents(root) {
  const agentsDir = join(root, "agents");
  const agents = [];
  for (const entry of readMarkdownFiles(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseMarkdown(join(agentsDir, entry.name));
    if (!parsed) continue;
    agents.push({
      id: parsed.name ?? entry.name.slice(0, -".md".length),
      description: parsed.description,
      system: parsed.body
    });
  }
  return agents;
}
function loadOpenCodeMcpServers(root) {
  const config = safeReadJson(join(root, ".mcp.json"));
  const servers = [];
  for (const [name, server] of Object.entries(config?.mcpServers ?? {})) {
    if ((server.type === "http" || server.type === "sse") && server.url) {
      servers.push([name, { type: "remote", url: server.url, ...server.headers ? { headers: server.headers } : {} }]);
    } else if ((server.type === void 0 || server.type === "stdio") && server.command) {
      servers.push([name, {
        type: "local",
        command: [server.command, ...server.args ?? []],
        ...server.env ? { environment: server.env } : {}
      }]);
    } else {
      log.debug("opencode-plugin:mcp-server-skipped", { name, type: server.type });
    }
  }
  return servers;
}
function renderOpenCodeCommand(template, args) {
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
async function checkVercelCliAsync(run = runBinary) {
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) return { installed: false, needsUpdate: false };
  let currentVersion;
  try {
    const lines = (await run(vercelBinary, VERCEL_VERSION_ARGS)).split("\n").map((l) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "opencode-plugin:vercel-version-check-failed", error, { command: vercelBinary });
    return { installed: true, needsUpdate: false };
  }
  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) return { installed: true, currentVersion, needsUpdate: false };
  let latestVersion;
  try {
    latestVersion = await run(npmBinary, NPM_VIEW_ARGS);
  } catch (error) {
    logCaughtError(log, "opencode-plugin:npm-latest-version-check-failed", error, { command: npmBinary });
    return { installed: true, currentVersion, needsUpdate: false };
  }
  const comparison = currentVersion && latestVersion ? compareVersionSegments(currentVersion, latestVersion) : null;
  const needsUpdate = comparison === null ? !!(currentVersion && latestVersion && currentVersion !== latestVersion) : comparison < 0;
  return { installed: true, currentVersion, latestVersion, needsUpdate };
}
function sessionStartActivation(directory, env) {
  const greenfield = checkGreenfield(directory);
  const greenfieldOverride = env.VERCEL_PLUGIN_GREENFIELD === "true";
  const profilerActive = greenfield !== null || !existsSync(directory) || hasSessionStartActivationMarkers(directory);
  return { greenfield, greenfieldOverride, profilerActive, active: profilerActive || greenfieldOverride };
}
function buildOpenCodeSessionContext(directory, root, cliStatus, env = process.env) {
  const { greenfield, greenfieldOverride, profilerActive } = sessionStartActivation(directory, env);
  if (!profilerActive && !greenfieldOverride) return null;
  const profilerMessages = profilerActive ? buildSessionStartProfilerUserMessages(greenfield, cliStatus) : [];
  const knowledgeUpdateRaw = safeReadFile(join(root, "skills", "knowledge-update", "SKILL.md"));
  const injectParts = buildInjectClaudeMdParts(
    safeReadFile(join(root, "vercel-session.md")),
    env,
    knowledgeUpdateRaw === null ? null : extractFrontmatter(knowledgeUpdateRaw).body.trim(),
    greenfield !== null || greenfieldOverride
  );
  const text = [...profilerMessages, ...injectParts].join("\n\n");
  return text === "" ? null : text;
}
var defaultDeps = {
  root: pluginRoot(import.meta.url),
  env: process.env,
  checkVercelCli: () => checkVercelCliAsync(),
  isVercelCliOnPath: () => resolveBinaryFromPath("vercel") !== null,
  cliStatusWaitMs: 3e3,
  refreshActiveSessionMarker: () => refreshActiveSessionMarker(),
  trackDauActiveToday: (now, context) => trackDauActiveToday(now, context),
  trackSkillEvents: (key, skills, context) => trackSkillEvents(key, skills, context)
};
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== void 0) map.delete(oldest);
  }
  return value;
}
function listItems(value) {
  if (Array.isArray(value)) return value;
  const data = value?.data;
  return Array.isArray(data) ? data : [];
}
function createOpenCodePlugin(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  let cliStatus = null;
  function vercelCliStatus() {
    if (!cliStatus || Date.now() - cliStatus.startedAt > CLI_STATUS_TTL_MS) {
      cliStatus = {
        startedAt: Date.now(),
        promise: deps.checkVercelCli().catch(() => ({ installed: true, needsUpdate: false }))
      };
    }
    return cliStatus.promise;
  }
  async function vercelCliStatusWithin(ms) {
    if (!deps.isVercelCliOnPath()) return { installed: false, needsUpdate: false };
    let timer;
    const fallback = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ installed: true, needsUpdate: false }), ms);
    });
    try {
      return await Promise.race([vercelCliStatus(), fallback]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    id: OPENCODE_PLUGIN_ID,
    async setup(ctx) {
      const telemetryEnabled = () => ctx.options.telemetry !== false && isDauTelemetryEnabled(deps.env);
      const skills = loadOpenCodeSkills(deps.root);
      const commands = loadOpenCodeCommands(deps.root);
      const agents = loadOpenCodeAgents(deps.root);
      const mcpServers = loadOpenCodeMcpServers(deps.root);
      const pluginSkillIds = new Set(skills.map((skill) => skill.id));
      const skillsDir = join(deps.root, "skills") + sep;
      const sessions = /* @__PURE__ */ new Map();
      const telemetrySessionIds = /* @__PURE__ */ new Map();
      await ctx.skill.transform((editor) => {
        for (const skill of skills) {
          if (!editor.get(skill.id)) editor.add(skill);
        }
      });
      await ctx.agent.transform((editor) => {
        for (const agent of agents) {
          if (editor.get(agent.id)) continue;
          editor.update(agent.id, (draft) => {
            draft.name = agent.id;
            draft.description = agent.description;
            draft.mode = "subagent";
            draft.system = agent.system;
          });
        }
      });
      await ctx.mcp.transform((editor) => {
        for (const [name, config] of mcpServers) {
          if (!editor.get(name)) editor.set(name, config);
        }
      });
      await ctx.command.transform((editor) => {
        for (const command of commands) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                delivery,
                text: renderOpenCodeCommand(command.template, prompt.text ?? "")
              });
            }
          });
        }
      });
      async function resolveSession(sessionID) {
        const session = await ctx.session.get({ sessionID });
        if (session.parentID) {
          const parent = await sessionState(session.parentID);
          return { rootSessionID: parent.rootSessionID, context: null };
        }
        if (telemetryEnabled()) {
          deps.refreshActiveSessionMarker();
          void deps.trackDauActiveToday(/* @__PURE__ */ new Date(), { agentHarness: "opencode" }).catch(() => {
          });
        }
        const directory = session.location.directory;
        const status = sessionStartActivation(directory, deps.env).active ? await vercelCliStatusWithin(deps.cliStatusWaitMs) : { installed: true, needsUpdate: false };
        return {
          rootSessionID: sessionID,
          context: buildOpenCodeSessionContext(directory, deps.root, status, deps.env)
        };
      }
      function sessionState(sessionID) {
        const existing = sessions.get(sessionID);
        if (existing) return existing;
        const state = resolveSession(sessionID).catch((error) => {
          sessions.delete(sessionID);
          throw error;
        });
        return remember(sessions, sessionID, state);
      }
      await ctx.session.hook("context", async (event) => {
        try {
          const state = await sessionState(event.sessionID);
          if (state.context) event.system.push({ type: "text", text: state.context });
        } catch (error) {
          logCaughtError(log, "opencode-plugin:session-context-failed", error, { sessionID: event.sessionID });
        }
      });
      async function reportSkillInvocation(sessionID, skillID) {
        const loaded = listItems(await ctx.skill.list()).find((skill) => skill.id === skillID);
        if (typeof loaded?.path !== "string" || !loaded.path.startsWith(skillsDir)) return;
        const { rootSessionID } = await sessionState(sessionID);
        const telemetrySessionId = telemetrySessionIds.get(rootSessionID) ?? remember(telemetrySessionIds, rootSessionID, randomUUID());
        await deps.trackSkillEvents(SKILL_INVOKED_EVENT_KEY, [skillID], {
          telemetrySessionId,
          agentHarness: "opencode"
        });
      }
      await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SKILL_TOOL_ID || event.status !== "completed" || !telemetryEnabled()) return;
        const skillID = event.input?.id;
        if (typeof skillID !== "string" || !pluginSkillIds.has(skillID)) return;
        void reportSkillInvocation(event.sessionID, skillID).catch((error) => {
          logCaughtError(log, "opencode-plugin:skill-telemetry-failed", error, { skillID });
        });
      });
      log.debug("opencode-plugin:setup", {
        directory: ctx.location.directory,
        skills: skills.length,
        commands: commands.length,
        agents: agents.length,
        mcpServers: mcpServers.length
      });
      return () => {
        sessions.clear();
        telemetrySessionIds.clear();
      };
    }
  };
}
var opencode_plugin_default = createOpenCodePlugin();
export {
  OPENCODE_COMMAND_NAMESPACE,
  OPENCODE_PLUGIN_ID,
  buildOpenCodeSessionContext,
  checkVercelCliAsync,
  createOpenCodePlugin,
  opencode_plugin_default as default,
  loadOpenCodeAgents,
  loadOpenCodeCommands,
  loadOpenCodeMcpServers,
  loadOpenCodeSkills,
  renderOpenCodeCommand
};
