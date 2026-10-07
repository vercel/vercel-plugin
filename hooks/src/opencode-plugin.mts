/**
 * OpenCode 2 plugin entry, loaded through package.json `exports`.
 *
 * Registers the same surfaces as the Claude Code plugin: skills, commands,
 * agents, and the Vercel MCP server. The SessionStart hooks (profiler and
 * inject-claude-md) become a per-session `context` hook, and the Skill
 * PostToolUse telemetry hook becomes a `tool` hook. State stays in memory
 * because the OpenCode server is long-lived, so there is nothing to clean up
 * at session end.
 */

import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
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
  resolveBinaryFromPath,
  type VercelCliStatus,
} from "./session-start-profiler.mjs";
import { extractFrontmatter, parseSkillFrontmatter } from "./skill-map-frontmatter.mjs";
import {
  SKILL_INVOKED_EVENT_KEY,
  isDauTelemetryEnabled,
  refreshActiveSessionMarker,
  trackDauActiveToday,
  trackSkillEvents,
  type SkillTelemetryContext,
  type TelemetryContext,
} from "./telemetry.mjs";

const log = createLogger();

export const OPENCODE_PLUGIN_ID = "vercel-plugin";
/** Mirrors Claude Code's `/vercel:<command>` namespace. */
export const OPENCODE_COMMAND_NAMESPACE = "vercel";
const SKILL_TOOL_ID = "skill";
const CLI_STATUS_TTL_MS = 60 * 60 * 1000;
const CLI_EXEC_TIMEOUT_MS = 3_000;
const MAX_TRACKED_SESSIONS = 500;

// ---------------------------------------------------------------------------
// The subset of the OpenCode 2 plugin context this entry uses
// (@opencode/plugin `Context`). Kept local so the plugin has no runtime or
// install-time dependency on OpenCode packages.
// ---------------------------------------------------------------------------

export interface OpenCodeSkillInfo {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}

export interface OpenCodeAgentDraft {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  system?: string;
}

export type OpenCodeMcpServerConfig =
  | { type: "remote"; url: string; headers?: Record<string, string> }
  | { type: "local"; command: string[]; environment?: Record<string, string> };

export interface OpenCodeCommandInvocation {
  sessionID: string;
  prompt: { text: string } & Record<string, unknown>;
  delivery: "steer" | "queue";
}

interface OpenCodeSessionInfo {
  id: string;
  parentID?: string;
  location: { directory: string };
}

export interface OpenCodeContextEvent {
  readonly sessionID: string;
  system: Array<{ type: "text"; text: string }>;
}

export type OpenCodeToolAfterEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
} & ({ readonly status: "completed" } | { readonly status: "error" });

export interface OpenCodePluginContext {
  readonly location: { directory: string };
  readonly options: Record<string, unknown>;
  readonly skill: {
    transform(callback: (editor: {
      get(id: string): OpenCodeSkillInfo | undefined;
      add(skill: OpenCodeSkillInfo): void;
    }) => void): Promise<unknown>;
    list(): Promise<unknown>;
  };
  readonly command: {
    transform(callback: (editor: {
      add(definition: {
        name: string;
        description?: string;
        execute(input: OpenCodeCommandInvocation): Promise<void>;
      }): void;
    }) => void): Promise<unknown>;
  };
  readonly agent: {
    transform(callback: (editor: {
      get(id: string): unknown;
      update(id: string, update: (agent: OpenCodeAgentDraft) => void): void;
    }) => void): Promise<unknown>;
  };
  readonly mcp: {
    transform(callback: (editor: {
      get(name: string): unknown;
      set(name: string, config: OpenCodeMcpServerConfig): void;
    }) => void): Promise<unknown>;
  };
  readonly session: {
    get(input: { sessionID: string }): Promise<OpenCodeSessionInfo>;
    prompt(input: Record<string, unknown>): Promise<unknown>;
    hook(name: "context", callback: (event: OpenCodeContextEvent) => Promise<void> | void): Promise<unknown>;
  };
  readonly tool: {
    hook(name: "execute.after", callback: (event: OpenCodeToolAfterEvent) => Promise<void> | void): Promise<unknown>;
  };
}

export interface OpenCodePlugin {
  readonly id: string;
  readonly setup: (ctx: OpenCodePluginContext) => Promise<() => void>;
}

// ---------------------------------------------------------------------------
// Plugin components, read from the same files Claude Code loads
// ---------------------------------------------------------------------------

export interface OpenCodeCommandSource {
  name: string;
  description?: string;
  template: string;
}

export interface OpenCodeAgentSource {
  id: string;
  description?: string;
  system: string;
}

function readMarkdownFiles(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    logCaughtError(log, "opencode-plugin:read-dir-failed", error, { dir });
    return [];
  }
}

function parseMarkdown(path: string): { name?: string; description?: string; body: string } | null {
  const raw = safeReadFile(path);
  if (raw === null) return null;

  const { yaml, body } = extractFrontmatter(raw);
  try {
    const frontmatter = parseSkillFrontmatter(yaml);
    return {
      name: frontmatter.name || undefined,
      description: frontmatter.description || undefined,
      body: body.trim(),
    };
  } catch (error) {
    logCaughtError(log, "opencode-plugin:frontmatter-parse-failed", error, { path });
    return null;
  }
}

/** Every `skills/<slug>/SKILL.md`, keyed by directory name like the other harnesses. */
export function loadOpenCodeSkills(root: string): OpenCodeSkillInfo[] {
  const skillsDir = join(root, "skills");
  const skills: OpenCodeSkillInfo[] = [];

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
      content: parsed.body,
    });
  }

  return skills;
}

/** Every `commands/<slug>.md` except `_`-prefixed conventions files. */
export function loadOpenCodeCommands(root: string): OpenCodeCommandSource[] {
  const commandsDir = join(root, "commands");
  const commands: OpenCodeCommandSource[] = [];

  for (const entry of readMarkdownFiles(commandsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_")) continue;
    const parsed = parseMarkdown(join(commandsDir, entry.name));
    if (!parsed) continue;

    commands.push({
      name: `${OPENCODE_COMMAND_NAMESPACE}:${entry.name.slice(0, -".md".length)}`,
      description: parsed.description,
      template: parsed.body,
    });
  }

  return commands;
}

/** Every `agents/<slug>.md`, registered as OpenCode subagents. */
export function loadOpenCodeAgents(root: string): OpenCodeAgentSource[] {
  const agentsDir = join(root, "agents");
  const agents: OpenCodeAgentSource[] = [];

  for (const entry of readMarkdownFiles(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseMarkdown(join(agentsDir, entry.name));
    if (!parsed) continue;

    agents.push({
      id: parsed.name ?? entry.name.slice(0, -".md".length),
      description: parsed.description,
      system: parsed.body,
    });
  }

  return agents;
}

interface ClaudeMcpServer {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Translates the Claude Code `.mcp.json` servers into OpenCode server configs. */
export function loadOpenCodeMcpServers(root: string): Array<[string, OpenCodeMcpServerConfig]> {
  const config = safeReadJson<{ mcpServers?: Record<string, ClaudeMcpServer> }>(join(root, ".mcp.json"));
  const servers: Array<[string, OpenCodeMcpServerConfig]> = [];

  for (const [name, server] of Object.entries(config?.mcpServers ?? {})) {
    if ((server.type === "http" || server.type === "sse") && server.url) {
      servers.push([name, { type: "remote", url: server.url, ...(server.headers ? { headers: server.headers } : {}) }]);
    } else if ((server.type === undefined || server.type === "stdio") && server.command) {
      servers.push([name, {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.env ? { environment: server.env } : {}),
      }]);
    } else {
      log.debug("opencode-plugin:mcp-server-skipped", { name, type: server.type });
    }
  }

  return servers;
}

/** Same argument rules as OpenCode markdown commands: fill `$ARGUMENTS`, else append. */
export function renderOpenCodeCommand(template: string, args: string): string {
  const trimmed = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", trimmed);
  return trimmed ? `${template}\n\n${trimmed}` : template;
}

// ---------------------------------------------------------------------------
// Session-start context (session-start-profiler + inject-claude-md)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

async function runBinary(binaryPath: string, args: string[]): Promise<string> {
  const options = { timeout: CLI_EXEC_TIMEOUT_MS, encoding: "utf-8" as const, windowsHide: true };
  const { stdout } = binaryNeedsShell(binaryPath)
    ? await execAsync(buildShellCommand(binaryPath, args), options)
    : await execFileAsync(binaryPath, args, options);
  return stdout.trim();
}

/**
 * Non-blocking twin of the profiler's `checkVercelCli`: the OpenCode server is
 * one long-lived process, so the sync version would stall every session.
 */
export async function checkVercelCliAsync(
  run: (binaryPath: string, args: string[]) => Promise<string> = runBinary,
): Promise<VercelCliStatus> {
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) return { installed: false, needsUpdate: false };

  let currentVersion: string | undefined;
  try {
    const lines = (await run(vercelBinary, VERCEL_VERSION_ARGS)).split("\n").map((l) => l.trim()).filter(Boolean);
    currentVersion = lines[lines.length - 1];
  } catch (error) {
    logCaughtError(log, "opencode-plugin:vercel-version-check-failed", error, { command: vercelBinary });
    return { installed: true, needsUpdate: false };
  }

  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) return { installed: true, currentVersion, needsUpdate: false };

  let latestVersion: string | undefined;
  try {
    latestVersion = await run(npmBinary, NPM_VIEW_ARGS);
  } catch (error) {
    logCaughtError(log, "opencode-plugin:npm-latest-version-check-failed", error, { command: npmBinary });
    return { installed: true, currentVersion, needsUpdate: false };
  }

  const comparison = currentVersion && latestVersion ? compareVersionSegments(currentVersion, latestVersion) : null;
  const needsUpdate = comparison === null
    ? !!(currentVersion && latestVersion && currentVersion !== latestVersion)
    : comparison < 0;
  return { installed: true, currentVersion, latestVersion, needsUpdate };
}

function sessionStartActivation(directory: string, env: NodeJS.ProcessEnv) {
  const greenfield = checkGreenfield(directory);
  const greenfieldOverride = env.VERCEL_PLUGIN_GREENFIELD === "true";
  const profilerActive = greenfield !== null || !existsSync(directory) || hasSessionStartActivationMarkers(directory);
  return { greenfield, greenfieldOverride, profilerActive, active: profilerActive || greenfieldOverride };
}

/**
 * The text Claude Code receives from the SessionStart profiler and
 * inject-claude-md hooks for `directory`, in the same order and under the same
 * activation rules. Null when neither hook would output anything.
 */
export function buildOpenCodeSessionContext(
  directory: string,
  root: string,
  cliStatus: VercelCliStatus,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const { greenfield, greenfieldOverride, profilerActive } = sessionStartActivation(directory, env);
  if (!profilerActive && !greenfieldOverride) return null;

  const profilerMessages = profilerActive ? buildSessionStartProfilerUserMessages(greenfield, cliStatus) : [];
  const knowledgeUpdateRaw = safeReadFile(join(root, "skills", "knowledge-update", "SKILL.md"));
  const injectParts = buildInjectClaudeMdParts(
    safeReadFile(join(root, "vercel-session.md")),
    env,
    knowledgeUpdateRaw === null ? null : extractFrontmatter(knowledgeUpdateRaw).body.trim(),
    greenfield !== null || greenfieldOverride,
  );

  const text = [...profilerMessages, ...injectParts].join("\n\n");
  return text === "" ? null : text;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface OpenCodePluginDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  checkVercelCli: () => Promise<VercelCliStatus>;
  isVercelCliOnPath: () => boolean;
  /** How long a session waits for the CLI version probes before going without them. */
  cliStatusWaitMs: number;
  refreshActiveSessionMarker: () => void;
  trackDauActiveToday: (now: Date, context: TelemetryContext) => Promise<void>;
  trackSkillEvents: (
    key: typeof SKILL_INVOKED_EVENT_KEY,
    skills: readonly string[],
    context: SkillTelemetryContext,
  ) => Promise<boolean>;
}

const defaultDeps: OpenCodePluginDeps = {
  root: pluginRoot(import.meta.url),
  env: process.env,
  checkVercelCli: () => checkVercelCliAsync(),
  isVercelCliOnPath: () => resolveBinaryFromPath("vercel") !== null,
  cliStatusWaitMs: 3_000,
  refreshActiveSessionMarker: () => refreshActiveSessionMarker(),
  trackDauActiveToday: (now, context) => trackDauActiveToday(now, context),
  trackSkillEvents: (key, skills, context) => trackSkillEvents(key, skills, context),
};

interface SessionState {
  rootSessionID: string;
  context: string | null;
}

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.set(key, value);
  if (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return value;
}

function listItems(value: unknown): Array<{ id?: unknown; path?: unknown }> {
  if (Array.isArray(value)) return value;
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

export function createOpenCodePlugin(overrides: Partial<OpenCodePluginDeps> = {}): OpenCodePlugin {
  const deps: OpenCodePluginDeps = { ...defaultDeps, ...overrides };
  let cliStatus: { promise: Promise<VercelCliStatus>; startedAt: number } | null = null;

  function vercelCliStatus(): Promise<VercelCliStatus> {
    if (!cliStatus || Date.now() - cliStatus.startedAt > CLI_STATUS_TTL_MS) {
      cliStatus = {
        startedAt: Date.now(),
        promise: deps.checkVercelCli().catch(() => ({ installed: true, needsUpdate: false })),
      };
    }
    return cliStatus.promise;
  }

  async function vercelCliStatusWithin(ms: number): Promise<VercelCliStatus> {
    // A missing CLI is always reported; only the slower version probes are capped.
    if (!deps.isVercelCliOnPath()) return { installed: false, needsUpdate: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<VercelCliStatus>((resolve) => {
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
      const sessions = new Map<string, Promise<SessionState>>();
      const telemetrySessionIds = new Map<string, string>();

      // OpenCode applies user skills and agents after plugin transforms, so a
      // user definition with the same ID wins. The guards keep that true for
      // anything registered before this plugin.
      await ctx.skill.transform((editor) => {
        for (const skill of skills) {
          if (!editor.get(skill.id)) editor.add(skill);
        }
      });

      await ctx.agent.transform((editor) => {
        for (const agent of agents) {
          if (editor.get(agent.id)) continue;
          // AgentEditor has no `add`; updating a missing ID creates the agent.
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
                text: renderOpenCodeCommand(command.template, prompt.text ?? ""),
              });
            },
          });
        }
      });

      async function resolveSession(sessionID: string): Promise<SessionState> {
        const session = await ctx.session.get({ sessionID });
        if (session.parentID) {
          // Claude Code runs SessionStart hooks for the lead agent only, and
          // subagent skill events belong to the lead agent's session.
          const parent = await sessionState(session.parentID);
          return { rootSessionID: parent.rootSessionID, context: null };
        }

        if (telemetryEnabled()) {
          deps.refreshActiveSessionMarker();
          void deps.trackDauActiveToday(new Date(), { agentHarness: "opencode" }).catch(() => {});
        }

        const directory = session.location.directory;
        const status = sessionStartActivation(directory, deps.env).active
          ? await vercelCliStatusWithin(deps.cliStatusWaitMs)
          : { installed: true, needsUpdate: false };
        return {
          rootSessionID: sessionID,
          context: buildOpenCodeSessionContext(directory, deps.root, status, deps.env),
        };
      }

      function sessionState(sessionID: string): Promise<SessionState> {
        const existing = sessions.get(sessionID);
        if (existing) return existing;
        const state = resolveSession(sessionID).catch((error) => {
          sessions.delete(sessionID);
          throw error;
        });
        return remember(sessions, sessionID, state);
      }

      // The context is computed once per session and reused verbatim so the
      // system prompt stays stable for prompt caching.
      await ctx.session.hook("context", async (event) => {
        try {
          const state = await sessionState(event.sessionID);
          if (state.context) event.system.push({ type: "text", text: state.context });
        } catch (error) {
          logCaughtError(log, "opencode-plugin:session-context-failed", error, { sessionID: event.sessionID });
        }
      });

      async function reportSkillInvocation(sessionID: string, skillID: string): Promise<void> {
        // Only count the plugin's copy, not a same-ID user skill that shadows it.
        const loaded = listItems(await ctx.skill.list()).find((skill) => skill.id === skillID);
        if (typeof loaded?.path !== "string" || !loaded.path.startsWith(skillsDir)) return;

        const { rootSessionID } = await sessionState(sessionID);
        const telemetrySessionId =
          telemetrySessionIds.get(rootSessionID) ?? remember(telemetrySessionIds, rootSessionID, randomUUID());
        await deps.trackSkillEvents(SKILL_INVOKED_EVENT_KEY, [skillID], {
          telemetrySessionId,
          agentHarness: "opencode",
        });
      }

      await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SKILL_TOOL_ID || event.status !== "completed" || !telemetryEnabled()) return;
        const skillID = (event.input as { id?: unknown } | null)?.id;
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
        mcpServers: mcpServers.length,
      });

      return () => {
        sessions.clear();
        telemetrySessionIds.clear();
      };
    },
  };
}

export default createOpenCodePlugin();
