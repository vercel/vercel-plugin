import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_MODULE = join(ROOT, "hooks", "opencode-plugin.mjs");
const NODE_BIN = Bun.which("node") || "node";

const plugin = await import(PLUGIN_MODULE);
const { buildSessionStartProfilerUserMessages } = await import(join(ROOT, "hooks", "session-start-profiler.mjs"));

type Status = { installed: boolean; currentVersion?: string; latestVersion?: string; needsUpdate: boolean };

interface FakeSession {
  id: string;
  parentID?: string;
  location: { directory: string };
}

function createFakeContext(options: {
  directory?: string;
  sessions?: FakeSession[];
  existingSkills?: Array<{ id: string; path: string }>;
  existingAgents?: string[];
  existingMcp?: Record<string, unknown>;
  pluginOptions?: Record<string, unknown>;
} = {}) {
  const skills = new Map<string, any>((options.existingSkills ?? []).map((s) => [s.id, { name: s.id, content: "", ...s }]));
  const agents = new Map<string, any>(
    (options.existingAgents ?? []).map((id) => [id, { name: id, mode: "primary", description: "user agent", permissions: [] }]),
  );
  const mcp = new Map<string, unknown>(Object.entries(options.existingMcp ?? {}));
  const commands = new Map<string, any>();
  const sessions = new Map((options.sessions ?? []).map((s) => [s.id, s]));
  const prompts: Array<Record<string, unknown>> = [];
  const sessionGets: string[] = [];
  const hooks: { context?: (event: any) => Promise<void>; toolAfter?: (event: any) => void } = {};

  const ctx = {
    location: { directory: options.directory ?? ROOT },
    options: options.pluginOptions ?? {},
    skill: {
      transform: async (cb: any) => cb({ get: (id: string) => skills.get(id), add: (skill: any) => skills.set(skill.id, skill) }),
      list: async () => ({ data: [...skills.values()] }),
    },
    command: { transform: async (cb: any) => cb({ add: (definition: any) => commands.set(definition.name, definition) }) },
    agent: {
      transform: async (cb: any) =>
        cb({
          list: () => [...agents.keys()].map((id) => ({ id })),
          get: (id: string) => agents.get(id),
          update: (id: string, update: (draft: any) => void) => {
            const draft = agents.get(id) ?? { name: id, mode: "all", permissions: [] };
            update(draft);
            agents.set(id, draft);
          },
        }),
    },
    mcp: { transform: async (cb: any) => cb({ get: (name: string) => mcp.get(name), set: (name: string, config: unknown) => mcp.set(name, config) }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionGets.push(sessionID);
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`unknown session ${sessionID}`);
        return session;
      },
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input);
      },
      hook: async (name: string, cb: any) => {
        if (name === "context") hooks.context = cb;
      },
    },
    tool: {
      hook: async (name: string, cb: any) => {
        if (name === "execute.after") hooks.toolAfter = cb;
      },
    },
  };

  async function contextFor(sessionID: string): Promise<string[]> {
    const event = { sessionID, system: [] as Array<{ type: string; text: string }> };
    await hooks.context!(event);
    return event.system.map((part) => part.text);
  }

  return { ctx, skills, agents, mcp, commands, prompts, sessionGets, hooks, contextFor };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const calls = { dau: [] as unknown[], marker: 0, skill: [] as Array<{ key: string; skills: string[]; context: any }>, cliChecks: 0 };
  const deps = {
    root: ROOT,
    env: {} as Record<string, string>,
    checkVercelCli: async (): Promise<Status> => {
      calls.cliChecks += 1;
      return { installed: true, currentVersion: "62.0.0", latestVersion: "62.0.0", needsUpdate: false };
    },
    cliStatusWaitMs: 50,
    refreshActiveSessionMarker: () => {
      calls.marker += 1;
    },
    trackDauActiveToday: async (_now: Date, context: unknown) => {
      calls.dau.push(context);
    },
    trackSkillEvents: async (key: string, skills: string[], context: unknown) => {
      calls.skill.push({ key, skills: [...skills], context });
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function pluginSkillSlugs(): string[] {
  return readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vercel-plugin-opencode-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeDir(name: string, files: Record<string, string> = {}): string {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const nextPackageJson = JSON.stringify({ dependencies: { next: "16.0.0" } });

describe("OpenCode package contract", () => {
  test("package.json exports an OpenCode 2 plugin definition", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const entry = await import(join(ROOT, pkg.exports["."]));
    expect(entry.default.id).toBe("vercel-plugin");
    expect(typeof entry.default.setup).toBe("function");
  });
});

describe("skills", () => {
  test("registers every skills/<slug>/SKILL.md under its directory name", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect([...fake.skills.keys()].sort()).toEqual(pluginSkillSlugs());
    const vercelCli = fake.skills.get("vercel-cli");
    expect(vercelCli.path).toBe(join(ROOT, "skills", "vercel-cli", "SKILL.md"));
    expect(vercelCli.name).toBe("vercel-cli");
    expect(vercelCli.description).toContain("Vercel CLI");
    expect(vercelCli.content.startsWith("---")).toBe(false);
    expect(vercelCli.content.length).toBeGreaterThan(100);
  });

  test("keeps a skill the user already registered with the same ID", async () => {
    const fake = createFakeContext({ existingSkills: [{ id: "vercel-cli", path: "/home/me/skills/vercel-cli/SKILL.md" }] });
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect(fake.skills.get("vercel-cli").path).toBe("/home/me/skills/vercel-cli/SKILL.md");
    expect(fake.skills.get("ai-sdk").path).toBe(join(ROOT, "skills", "ai-sdk", "SKILL.md"));
  });
});

describe("commands", () => {
  test("registers each command as vercel:<name>, skipping conventions files", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    const expected = readdirSync(join(ROOT, "commands"))
      .filter((file) => file.endsWith(".md") && !file.startsWith("_"))
      .map((file) => `vercel:${file.slice(0, -3)}`)
      .sort();
    expect([...fake.commands.keys()].sort()).toEqual(expected);
    expect(fake.commands.get("vercel:deploy").description).toContain("Deploy the current project to Vercel");
  });

  test("executing a command prompts the session with the rendered template", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    const files = [{ uri: "file:///repo/vercel.json" }];
    await fake.commands.get("vercel:deploy").execute({ sessionID: "ses_1", prompt: { text: "prod", files }, delivery: "queue" });

    expect(fake.prompts).toHaveLength(1);
    const [sent] = fake.prompts;
    expect(sent.sessionID).toBe("ses_1");
    expect(sent.delivery).toBe("queue");
    expect(sent.files).toEqual(files);
    expect(sent.text).toContain("# Deploy to Vercel");
    expect(sent.text).toContain('If "prod" contains "prod" or "production"');
    expect(sent.text).not.toContain("$ARGUMENTS");
    expect(sent.text.startsWith("---")).toBe(false);
  });

  test("a command without $ARGUMENTS gets its arguments appended, like OpenCode markdown commands", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);
    const status = fake.commands.get("vercel:status");

    await status.execute({ sessionID: "ses_1", prompt: { text: " verbose " }, delivery: "steer" });
    await status.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" });

    const [withArgs, withoutArgs] = fake.prompts.map((sent) => sent.text as string);
    expect(withArgs).toBe(`${withoutArgs}\n\nverbose`);
    expect(withoutArgs).toContain("# Vercel Project Status");
  });
});

describe("agents", () => {
  test("registers each agent as a subagent with its markdown body as system prompt", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect([...fake.agents.keys()].sort()).toEqual(["ai-architect", "deployment-expert", "performance-optimizer"]);
    const agent = fake.agents.get("deployment-expert");
    expect(agent.mode).toBe("subagent");
    expect(agent.name).toBe("deployment-expert");
    expect(agent.description).toContain("deployment strategies");
    expect(agent.system).toContain("You are a Vercel deployment specialist");
    expect(agent.system.startsWith("---")).toBe(false);
  });

  test("leaves an existing agent with the same ID untouched", async () => {
    const fake = createFakeContext({ existingAgents: ["deployment-expert"] });
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    const agent = fake.agents.get("deployment-expert");
    expect(agent.description).toBe("user agent");
    expect(agent.mode).toBe("primary");
  });

  test("every agent may read the plugin's skill files without an external_directory prompt", async () => {
    const fake = createFakeContext({ existingAgents: ["build", "explore"] });
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    const rule = { action: "external_directory", resource: join(ROOT, "skills", "*"), effect: "allow" };
    for (const id of ["build", "explore", "deployment-expert"]) {
      expect(fake.agents.get(id).permissions).toContainEqual(rule);
    }
  });
});

describe("MCP", () => {
  test("configures the Vercel MCP server from .mcp.json", async () => {
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect(fake.mcp.get("vercel")).toEqual({ type: "remote", url: "https://mcp.vercel.com" });
  });

  test("keeps a user-configured server with the same name", async () => {
    const userServer = { type: "remote", url: "https://example.com/mcp", disabled: true };
    const fake = createFakeContext({ existingMcp: { vercel: userServer } });
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect(fake.mcp.get("vercel")).toEqual(userServer);
  });

  test("translates stdio servers and skips transports OpenCode lacks", async () => {
    const root = makeDir("plugin-root", {
      ".mcp.json": JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"], env: { A: "1" } },
          legacy: { type: "sse", url: "https://example.com/sse" },
          unknown: { type: "websocket", url: "wss://example.com" },
        },
      }),
    });
    const fake = createFakeContext();
    await plugin.createOpenCodePlugin(createDeps({ root }).deps).setup(fake.ctx);

    expect([...fake.mcp.entries()]).toEqual([
      ["local", { type: "local", command: ["node", "server.js"], environment: { A: "1" } }],
    ]);
  });
});

describe("session-start context", () => {
  async function runInjectClaudeMdHook(directory: string, env: Record<string, string> = {}): Promise<string> {
    const proc = Bun.spawn([NODE_BIN, join(ROOT, "hooks", "inject-claude-md.mjs")], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s" })),
      env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_ROOT: directory, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  }

  async function setupWithSession(directory: string, deps = createDeps().deps, extraSessions: FakeSession[] = []) {
    const fake = createFakeContext({ sessions: [{ id: "ses_root", location: { directory } }, ...extraSessions] });
    await plugin.createOpenCodePlugin(deps).setup(fake.ctx);
    return fake;
  }

  test("a Vercel project gets exactly what the Claude Code inject-claude-md hook prints", async () => {
    const directory = makeDir("next-app", { "package.json": nextPackageJson, "app/page.tsx": "export default null" });
    const fake = await setupWithSession(directory);

    const injected = await fake.contextFor("ses_root");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe(await runInjectClaudeMdHook(directory));
    expect(injected[0]).toContain("# Vercel Plugin Session Context");
  });

  test("an unrelated project gets no context", async () => {
    const directory = makeDir("express-app", { "package.json": JSON.stringify({ dependencies: { express: "5" } }) });
    const fake = await setupWithSession(directory);

    expect(await fake.contextFor("ses_root")).toEqual([]);
    expect(await runInjectClaudeMdHook(directory)).toBe("");
  });

  test("a greenfield directory gets the profiler message and greenfield mode", async () => {
    const directory = makeDir("empty");
    mkdirSync(join(directory, ".git"));
    const fake = await setupWithSession(directory);

    const [text] = await fake.contextFor("ses_root");
    const profilerMessages = buildSessionStartProfilerUserMessages({ entries: [".git"] }, { installed: true, needsUpdate: false });
    expect(text).toBe([...profilerMessages, await runInjectClaudeMdHook(directory)].join("\n\n"));
    expect(text).toContain("Greenfield execution mode");
  });

  test("VERCEL_PLUGIN_GREENFIELD=true activates like the Claude Code hook", async () => {
    const directory = makeDir("express-app", { "README.md": "hi" });
    const { deps } = createDeps({ env: { VERCEL_PLUGIN_GREENFIELD: "true" } });
    const fake = await setupWithSession(directory, deps);

    const [text] = await fake.contextFor("ses_root");
    expect(text).toBe(await runInjectClaudeMdHook(directory, { VERCEL_PLUGIN_GREENFIELD: "true" }));
  });

  test("an unrelated project never runs the Vercel CLI check", async () => {
    const directory = makeDir("express-app", { "package.json": JSON.stringify({ dependencies: { express: "5" } }) });
    const { deps, calls } = createDeps();
    const fake = await setupWithSession(directory, deps);

    await fake.contextFor("ses_root");
    expect(calls.cliChecks).toBe(0);
  });

  test("slow version probes are skipped after the wait cap", async () => {
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    const { deps } = createDeps({
      cliStatusWaitMs: 10,
      checkVercelCli: () => new Promise<Status>(() => {}),
    });
    const fake = await setupWithSession(directory, deps);

    const [text] = await fake.contextFor("ses_root");
    expect(text.startsWith("# Vercel Plugin Session Context")).toBe(true);
  });

  test("the context is computed once per session and stays identical", async () => {
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    const { deps, calls } = createDeps();
    const fake = await setupWithSession(directory, deps);

    const first = await fake.contextFor("ses_root");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { express: "5" } }));
    const second = await fake.contextFor("ses_root");
    expect(second).toEqual(first);
    expect(fake.sessionGets).toEqual(["ses_root"]);
    expect(calls.cliChecks).toBe(1);
  });

  test("child sessions get no context, like Claude Code subagents", async () => {
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    const fake = await setupWithSession(directory, createDeps().deps, [
      { id: "ses_child", parentID: "ses_root", location: { directory } },
    ]);

    expect(await fake.contextFor("ses_child")).toEqual([]);
    expect(await fake.contextFor("ses_root")).toHaveLength(1);
  });

  test("a failing session lookup never breaks the model call", async () => {
    const fake = createFakeContext({ sessions: [] });
    await plugin.createOpenCodePlugin(createDeps().deps).setup(fake.ctx);

    expect(await fake.contextFor("ses_missing")).toEqual([]);
  });
});

describe("telemetry", () => {
  async function setupTelemetry(overrides: Record<string, unknown> = {}, ctxOptions: Parameters<typeof createFakeContext>[0] = {}) {
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    const { deps, calls } = createDeps(overrides);
    const fake = createFakeContext({
      sessions: [
        { id: "ses_root", location: { directory } },
        { id: "ses_child", parentID: "ses_root", location: { directory } },
        { id: "ses_other", location: { directory } },
      ],
      ...ctxOptions,
    });
    await plugin.createOpenCodePlugin(deps).setup(fake.ctx);
    return { fake, calls };
  }

  const skillCall = (sessionID: string, id: string, status = "completed") => ({ tool: "skill", sessionID, input: { id }, status });

  test("reports skill:invoked for plugin skills, tagged with the opencode harness", async () => {
    const { fake, calls } = await setupTelemetry();
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli"));
    await flush();

    expect(calls.skill).toHaveLength(1);
    expect(calls.skill[0].key).toBe("skill:invoked");
    expect(calls.skill[0].skills).toEqual(["vercel-cli"]);
    expect(calls.skill[0].context.agentHarness).toBe("opencode");
    expect(calls.skill[0].context.telemetrySessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("subagent skill loads share the lead session's telemetry ID", async () => {
    const { fake, calls } = await setupTelemetry();
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli"));
    fake.hooks.toolAfter!(skillCall("ses_child", "ai-sdk"));
    fake.hooks.toolAfter!(skillCall("ses_other", "workflow"));
    await flush();

    const idFor = (skill: string) => calls.skill.find((call) => call.skills[0] === skill)?.context.telemetrySessionId;
    expect(idFor("ai-sdk")).toBe(idFor("vercel-cli"));
    expect(idFor("workflow")).not.toBe(idFor("vercel-cli"));
  });

  test("never reports other skills, other tools, or failed loads", async () => {
    const { fake, calls } = await setupTelemetry({}, { existingSkills: [{ id: "my-skill", path: "/home/me/skills/my-skill/SKILL.md" }] });
    fake.hooks.toolAfter!(skillCall("ses_root", "my-skill"));
    fake.hooks.toolAfter!(skillCall("ses_root", "opencode"));
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli", "error"));
    fake.hooks.toolAfter!({ tool: "read", sessionID: "ses_root", input: { id: "vercel-cli" }, status: "completed" });
    await flush();

    expect(calls.skill).toEqual([]);
  });

  test("does not report a user skill that shadows a plugin skill", async () => {
    const { fake, calls } = await setupTelemetry({}, { existingSkills: [{ id: "vercel-cli", path: "/home/me/skills/vercel-cli/SKILL.md" }] });
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli"));
    await flush();

    expect(calls.skill).toEqual([]);
  });

  test("pings DAU and refreshes the active-session marker once per lead session", async () => {
    const { fake, calls } = await setupTelemetry();
    await fake.contextFor("ses_root");
    await fake.contextFor("ses_root");
    await fake.contextFor("ses_child");
    await flush();

    expect(calls.dau).toEqual([{ agentHarness: "opencode" }]);
    expect(calls.marker).toBe(1);
  });

  test("VERCEL_PLUGIN_TELEMETRY=off disables every event", async () => {
    const { fake, calls } = await setupTelemetry({ env: { VERCEL_PLUGIN_TELEMETRY: "off" } });
    await fake.contextFor("ses_root");
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli"));
    await flush();

    expect(calls.dau).toEqual([]);
    expect(calls.marker).toBe(0);
    expect(calls.skill).toEqual([]);
  });

  test("the telemetry: false plugin option disables every event", async () => {
    const { fake, calls } = await setupTelemetry({}, { pluginOptions: { telemetry: false } });
    await fake.contextFor("ses_root");
    fake.hooks.toolAfter!(skillCall("ses_root", "vercel-cli"));
    await flush();

    expect(calls.dau).toEqual([]);
    expect(calls.skill).toEqual([]);
  });

  test("the default plugin sends the bridge payloads with the opencode harness", async () => {
    const home = makeDir("home");
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    const script = `
      const payloads = [];
      globalThis.fetch = async (_url, init) => {
        payloads.push({ topic: new Headers(init.headers).get("x-vercel-plugin-topic-id"), body: JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      };
      const { default: plugin } = await import(${JSON.stringify(PLUGIN_MODULE)});
      const hooks = {};
      const skills = new Map();
      const ctx = {
        location: { directory: ${JSON.stringify(directory)} },
        options: {},
        skill: { transform: async (cb) => cb({ get: (id) => skills.get(id), add: (s) => skills.set(s.id, s) }), list: async () => ({ data: [...skills.values()] }) },
        command: { transform: async () => {} },
        agent: { transform: async () => {} },
        mcp: { transform: async () => {} },
        session: {
          get: async ({ sessionID }) => ({ id: sessionID, location: { directory: ${JSON.stringify(directory)} } }),
          prompt: async () => {},
          hook: async (name, cb) => { hooks[name] = cb; },
        },
        tool: { hook: async (name, cb) => { hooks[name] = cb; } },
      };
      await plugin.setup(ctx);
      hooks["execute.after"]({ tool: "skill", sessionID: "ses_1", input: { id: "vercel-cli" }, status: "completed" });
      await new Promise((r) => setTimeout(r, 200));
      console.log(JSON.stringify(payloads));
    `;
    const env = { ...(process.env as Record<string, string>), HOME: home, PATH: "" };
    delete env.VERCEL_PLUGIN_TELEMETRY;
    const proc = Bun.spawn([NODE_BIN, "--input-type=module", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const payloads = JSON.parse(stdout.trim().split("\n").at(-1)!);
    const generic = payloads.filter((p: any) => p.topic === "generic").flatMap((p: any) => p.body);
    expect(generic.find((e: any) => e.key === "skill:invoked")?.value).toBe("vercel-cli");
    expect(generic.find((e: any) => e.key === "plugin:agent_harness")?.value).toBe("opencode");
  });
});

describe("Vercel CLI check", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function stubBinaries(binaries: Record<string, string>): void {
    const bin = makeDir("bin");
    for (const [name, output] of Object.entries(binaries)) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '${output}'\n`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = bin;
  }

  async function contextWithRealCliCheck(): Promise<string> {
    const directory = makeDir("next-app", { "package.json": nextPackageJson });
    // A cap longer than the test timeout proves a missing CLI never waits on it.
    const { checkVercelCli: _fake, ...deps } = createDeps({ cliStatusWaitMs: 60_000 }).deps;
    const fake = createFakeContext({ sessions: [{ id: "ses_root", location: { directory } }] });
    await plugin.createOpenCodePlugin(deps).setup(fake.ctx);
    const [text] = await fake.contextFor("ses_root");
    return text;
  }

  test("reports an outdated CLI from `vercel --version` and `npm view vercel version`", async () => {
    stubBinaries({ vercel: "Vercel CLI 59.5.0\\n59.5.0\\n", npm: "62.7.0\\n" });
    expect((await contextWithRealCliCheck()).startsWith("IMPORTANT: The Vercel CLI is outdated (59.5.0 → 62.7.0).")).toBe(true);
  });

  test("reports a CLI missing from PATH", async () => {
    stubBinaries({});
    expect((await contextWithRealCliCheck()).startsWith("IMPORTANT: The Vercel CLI is not installed.")).toBe(true);
  });
});
