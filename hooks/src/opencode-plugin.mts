/**
 * OpenCode 2 plugin entry, loaded through package.json `exports`.
 *
 * Registers the same skills, commands, agents, and MCP servers as the Claude
 * Code plugin. The SessionStart profiler and inject-claude-md output becomes a
 * `context` hook, and the Skill telemetry hook becomes a `tool` hook. State
 * lives in memory because the OpenCode server is long-lived, so there is no
 * session-end cleanup.
 */

import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
} from "./telemetry.mjs";

const log = createLogger();

const CLI_STATUS_TTL_MS = 60 * 60 * 1000;
const CLI_EXEC_TIMEOUT_MS = 3_000;
const MAX_TRACKED_SESSIONS = 500;
const UNKNOWN_CLI_STATUS: VercelCliStatus = { installed: true, needsUpdate: false };

// The subset of the @opencode/plugin `Context` this entry uses, kept local so
// the plugin has no dependency on OpenCode packages.

interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}

type McpServerConfig =
  | { type: "remote"; url: string; headers?: Record<string, string> }
  | { type: "local"; command: string[]; environment?: Record<string, string> };

interface CommandInvocation {
  sessionID: string;
  prompt: { text: string } & Record<string, unknown>;
  delivery: "steer" | "queue";
}

type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<unknown>;

interface AgentDraft {
  name: string;
  description?: string;
  mode: string;
  system?: string;
}

interface CommandDefinition {
  name: string;
  description?: string;
  execute(input: CommandInvocation): Promise<void>;
}

interface ContextEvent {
  sessionID: string;
  system: Array<{ type: "text"; text: string }>;
}

interface ToolAfterEvent {
  tool: string;
  sessionID: string;
  input: unknown;
  status: string;
}

interface PluginContext {
  readonly options: Record<string, unknown>;
  readonly skill: {
    transform: Transform<{ get(id: string): unknown; add(skill: SkillInfo): void }>;
    list(): Promise<{ data: Array<{ id: string; path: string }> }>;
  };
  readonly command: { transform: Transform<{ add(command: CommandDefinition): void }> };
  readonly agent: {
    transform: Transform<{ get(id: string): unknown; update(id: string, update: (agent: AgentDraft) => void): void }>;
  };
  readonly mcp: { transform: Transform<{ get(name: string): unknown; set(name: string, config: McpServerConfig): void }> };
  readonly session: {
    get(input: { sessionID: string }): Promise<{ parentID?: string; location: { directory: string } }>;
    prompt(input: Record<string, unknown>): Promise<unknown>;
    hook(name: "context", callback: (event: ContextEvent) => Promise<void>): Promise<unknown>;
  };
  readonly tool: { hook(name: "execute.after", callback: (event: ToolAfterEvent) => void): Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Components, read from the same files Claude Code loads
// ---------------------------------------------------------------------------

interface MarkdownFile {
  slug: string;
  name?: string;
  description?: string;
  body: string;
}

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    logCaughtError(log, "opencode-plugin:read-dir-failed", error, { dir });
    return [];
  }
}

function readMarkdown(path: string, slug: string): MarkdownFile | null {
  const raw = safeReadFile(path);
  if (raw === null) return null;

  const { yaml, body } = extractFrontmatter(raw);
  try {
    const { name, description } = parseSkillFrontmatter(yaml);
    return { slug, name: name || undefined, description: description || undefined, body: body.trim() };
  } catch (error) {
    logCaughtError(log, "opencode-plugin:frontmatter-parse-failed", error, { path });
    return null;
  }
}

/** Every `skills/<slug>/SKILL.md`. */
function loadSkills(root: string): SkillInfo[] {
  const skillsDir = join(root, "skills");
  return listDir(skillsDir).flatMap((entry) => {
    const path = join(skillsDir, entry.name, "SKILL.md");
    const skill = entry.isDirectory() && existsSync(path) ? readMarkdown(path, entry.name) : null;
    if (!skill) return [];
    return [{ id: skill.slug, name: skill.name ?? skill.slug, description: skill.description, path, content: skill.body }];
  });
}

/** Every `<dir>/<slug>.md` except `_`-prefixed conventions files. */
function loadMarkdownDir(dir: string): MarkdownFile[] {
  return listDir(dir).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith("_")) return [];
    const file = readMarkdown(join(dir, entry.name), entry.name.slice(0, -".md".length));
    return file ? [file] : [];
  });
}

/** Translates `.mcp.json` into OpenCode servers. OpenCode has no SSE transport, so SSE servers are skipped. */
function loadMcpServers(root: string): Array<[string, McpServerConfig]> {
  type ClaudeServer = {
    type?: string;
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  const config = safeReadJson<{ mcpServers?: Record<string, ClaudeServer> }>(join(root, ".mcp.json"));

  return Object.entries(config?.mcpServers ?? {}).flatMap(([name, server]): Array<[string, McpServerConfig]> => {
    if (server.type === "http" && server.url) {
      return [[name, { type: "remote", url: server.url, ...(server.headers && { headers: server.headers }) }]];
    }
    if ((server.type === undefined || server.type === "stdio") && server.command) {
      const command = [server.command, ...(server.args ?? [])];
      return [[name, { type: "local", command, ...(server.env && { environment: server.env }) }]];
    }
    log.debug("opencode-plugin:mcp-server-skipped", { name, type: server.type });
    return [];
  });
}

/** Same argument rules as OpenCode markdown commands: fill `$ARGUMENTS`, else append. */
function renderCommand(template: string, args: string): string {
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
 * Async twin of the profiler's `checkVercelCli`. The OpenCode server is one
 * long-lived process, so the sync version would stall every session.
 */
async function checkVercelCliAsync(): Promise<VercelCliStatus> {
  const vercelBinary = resolveBinaryFromPath("vercel");
  if (!vercelBinary) return { installed: false, needsUpdate: false };

  let currentVersion: string | undefined;
  try {
    const output = await runBinary(vercelBinary, VERCEL_VERSION_ARGS);
    currentVersion = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  } catch (error) {
    logCaughtError(log, "opencode-plugin:vercel-version-check-failed", error, { command: vercelBinary });
    return UNKNOWN_CLI_STATUS;
  }

  const npmBinary = resolveBinaryFromPath("npm");
  if (!npmBinary) return { installed: true, currentVersion, needsUpdate: false };

  let latestVersion: string | undefined;
  try {
    latestVersion = await runBinary(npmBinary, NPM_VIEW_ARGS);
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

/**
 * What Claude Code receives from the SessionStart profiler and inject-claude-md
 * hooks for `directory`, in the same order and under the same activation rules.
 * Like the profiler, the Vercel CLI is only checked when the directory activates.
 */
async function buildSessionContext(
  directory: string,
  root: string,
  env: NodeJS.ProcessEnv,
  cliStatus: () => Promise<VercelCliStatus>,
): Promise<string | null> {
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
    greenfield !== null || greenfieldOverride,
  );
  return [...profilerMessages, ...injectParts].join("\n\n") || null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface OpenCodePluginDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  checkVercelCli: () => Promise<VercelCliStatus>;
  /** How long a session waits for the CLI version probes before going without them. */
  cliStatusWaitMs: number;
  refreshActiveSessionMarker: () => void;
  trackDauActiveToday: typeof trackDauActiveToday;
  trackSkillEvents: typeof trackSkillEvents;
}

const defaultDeps: OpenCodePluginDeps = {
  root: pluginRoot(import.meta.url),
  env: process.env,
  checkVercelCli: checkVercelCliAsync,
  cliStatusWaitMs: 3_000,
  refreshActiveSessionMarker,
  trackDauActiveToday,
  trackSkillEvents,
};

interface SessionState {
  context: string | null;
  /** Random UUID shared by skill events of a lead session and its subagents. */
  telemetrySessionId: string;
}

export function createOpenCodePlugin(overrides: Partial<OpenCodePluginDeps> = {}) {
  const deps: OpenCodePluginDeps = { ...defaultDeps, ...overrides };
  let cliStatus: { promise: Promise<VercelCliStatus>; startedAt: number } | null = null;

  /** Cached for an hour; a session waits at most `cliStatusWaitMs` for it. */
  function vercelCliStatus(): Promise<VercelCliStatus> {
    if (!cliStatus || Date.now() - cliStatus.startedAt > CLI_STATUS_TTL_MS) {
      cliStatus = { startedAt: Date.now(), promise: deps.checkVercelCli().catch(() => UNKNOWN_CLI_STATUS) };
    }
    return Promise.race([cliStatus.promise, delay(deps.cliStatusWaitMs, UNKNOWN_CLI_STATUS, { ref: false })]);
  }

  return {
    id: "vercel-plugin",
    async setup(ctx: PluginContext): Promise<void> {
      const telemetryEnabled = () => ctx.options.telemetry !== false && isDauTelemetryEnabled(deps.env);
      const skills = loadSkills(deps.root);
      const pluginSkillIds = new Set(skills.map((skill) => skill.id));
      const skillsDir = join(deps.root, "skills") + sep;
      const sessions = new Map<string, Promise<SessionState>>();

      // OpenCode applies user skills and agents after plugin transforms, so a
      // user definition with the same ID wins. The guards keep that true for
      // anything registered before this plugin.
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
          // AgentEditor has no `add`; updating a missing ID creates the agent.
          editor.update(id, (draft) => {
            draft.name = id;
            draft.description = agent.description;
            draft.mode = "subagent";
            draft.system = agent.body;
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
            },
          });
        }
      });

      async function resolveSession(sessionID: string): Promise<SessionState> {
        const session = await ctx.session.get({ sessionID });
        if (session.parentID) {
          // Claude Code runs SessionStart hooks for the lead agent only.
          const parent = await sessionState(session.parentID);
          return { context: null, telemetrySessionId: parent.telemetrySessionId };
        }

        if (telemetryEnabled()) {
          deps.refreshActiveSessionMarker();
          void deps.trackDauActiveToday(new Date(), { agentHarness: "opencode" }).catch(() => {});
        }
        const context = await buildSessionContext(session.location.directory, deps.root, deps.env, vercelCliStatus);
        return { context, telemetrySessionId: randomUUID() };
      }

      function sessionState(sessionID: string): Promise<SessionState> {
        let state = sessions.get(sessionID);
        if (!state) {
          state = resolveSession(sessionID);
          state.catch(() => sessions.delete(sessionID));
          sessions.set(sessionID, state);
          if (sessions.size > MAX_TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value!);
        }
        return state;
      }

      // Computed once per session and reused verbatim so the system prompt
      // stays stable for prompt caching.
      await ctx.session.hook("context", async (event) => {
        try {
          const { context } = await sessionState(event.sessionID);
          if (context) event.system.push({ type: "text", text: context });
        } catch (error) {
          logCaughtError(log, "opencode-plugin:session-context-failed", error, { sessionID: event.sessionID });
        }
      });

      async function reportSkillInvocation(sessionID: string, skillID: string): Promise<void> {
        // Only count the plugin's copy, not a same-ID user skill that shadows it.
        const loaded = (await ctx.skill.list()).data.find((skill) => skill.id === skillID);
        if (!loaded?.path.startsWith(skillsDir)) return;

        const { telemetrySessionId } = await sessionState(sessionID);
        await deps.trackSkillEvents(SKILL_INVOKED_EVENT_KEY, [skillID], {
          telemetrySessionId,
          agentHarness: "opencode",
        });
      }

      await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== "skill" || event.status !== "completed" || !telemetryEnabled()) return;
        const skillID = (event.input as { id?: unknown } | null)?.id;
        if (typeof skillID !== "string" || !pluginSkillIds.has(skillID)) return;

        reportSkillInvocation(event.sessionID, skillID).catch((error) => {
          logCaughtError(log, "opencode-plugin:skill-telemetry-failed", error, { skillID });
        });
      });
    },
  };
}

export default createOpenCodePlugin();
