import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(ROOT, ".plugin", "plugin.json"), "utf-8"),
).version as string;
const HOOK_PATH = join(ROOT, "hooks", "posttooluse-skill-telemetry.mjs");
const LIB_PATH = join(ROOT, "hooks", "skill-telemetry.mjs");
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const PROFILER_PATH = join(ROOT, "hooks", "session-start-profiler.mjs");
const NODE_BIN = Bun.which("node") || "node";
const SESSION_UUID = "6f1d2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c";

interface HooksJson {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
}

let tempHome: string;
const sessionIds: string[] = [];

function newSessionId(label: string): string {
  const id = `skill-telemetry-${label}-${process.pid}-${Date.now()}-${sessionIds.length}`;
  sessionIds.push(id);
  return id;
}

function sessionTempEntries(sessionId: string): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`vercel-plugin-${sessionId}-`)).sort();
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "vercel-plugin-skill-telemetry-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  for (const sessionId of sessionIds.splice(0)) {
    for (const entry of sessionTempEntries(sessionId)) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
});

function buildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>), HOME: tempHome };
  // The test preload sets this to "off" for the whole suite; these tests opt
  // back in deliberately and mock fetch wherever a send could happen.
  delete mergedEnv.VERCEL_PLUGIN_TELEMETRY;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete mergedEnv[key];
    else mergedEnv[key] = value;
  }
  return mergedEnv;
}

function runHook(stdin: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(NODE_BIN, [HOOK_PATH], { input: stdin, encoding: "utf-8", env: buildEnv(env) });
}

async function probe(script: string, env: Record<string, string | undefined> = {}): Promise<unknown> {
  const result = spawnSync(NODE_BIN, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    env: buildEnv(env),
  });
  if (result.status !== 0) {
    throw new Error(`probe failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe("skill invocation allowlist", () => {
  test("only plugin-namespaced, plugin-shipped skills and commands are reported", async () => {
    const result = (await probe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      import { loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      const n = (value) => telemetry.normalizeSkillInvocation(value, known);
      process.stdout.write(JSON.stringify({
        knownCount: known.size,
        cases: {
          vercelNamespace: n("vercel:nextjs"),
          pluginNamespaceWithSlash: n("/vercel-plugin:ai-sdk"),
          command: n("vercel:deploy"),
          upperCase: n("Vercel:NextJS"),
          whitespace: n("  vercel:nextjs  "),
          bareSlug: n("nextjs"),
          bareCommand: n("deploy"),
          otherPluginSameSlug: n("other-plugin:deploy"),
          netlify: n("netlify:deploy"),
          team: n("my-team:auth"),
          unknownSlugOurNamespace: n("vercel:not-a-real-skill"),
          conventions: n("vercel:_conventions"),
          pathLike: n("vercel:../../etc/passwd"),
          nestedNamespace: n("vercel:sub:nextjs"),
          notAString: n({ skill: "vercel:nextjs" }),
          empty: n(""),
        },
      }));
    `)) as { knownCount: number; cases: Record<string, string | null> };

    expect(result.knownCount).toBeGreaterThan(30);
    expect(result.cases).toEqual({
      vercelNamespace: "nextjs",
      pluginNamespaceWithSlash: "ai-sdk",
      command: "deploy",
      upperCase: "nextjs",
      whitespace: "nextjs",
      bareSlug: null,
      bareCommand: null,
      otherPluginSameSlug: null,
      netlify: null,
      team: null,
      unknownSlugOurNamespace: null,
      conventions: null,
      pathLike: null,
      nestedNamespace: null,
      notAString: null,
      empty: null,
    });
  });

  test("known skill set matches skills/ and commands/ on disk", async () => {
    const skillDirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "skills", entry.name, "SKILL.md")))
      .map((entry) => entry.name);
    const commands = readdirSync(join(ROOT, "commands"))
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .map((name) => name.replace(/\.md$/, ""));

    const result = (await probe(`
      import { loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      process.stdout.write(JSON.stringify([...loadKnownPluginSkills(${JSON.stringify(ROOT)})].sort()));
    `)) as string[];

    expect(result).toEqual([...new Set([...skillDirs, ...commands])].sort());
  });
});

describe("skill invocation payload", () => {
  test("mints one session UUID per agent session and never sends the harness session id", async () => {
    const sessionId = newSessionId("payload");
    const result = (await probe(`
      import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      const input = {
        session_id: ${JSON.stringify(sessionId)},
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: "vercel:nextjs", args: "do not send this" },
        tool_response: "do not send this either",
      };
      const first = buildSkillInvocationPayload(input, known);
      const second = buildSkillInvocationPayload({ ...input, tool_input: { skill: "vercel:deploy" } }, known);
      process.stdout.write(JSON.stringify({ first, second }));
    `)) as { first: Record<string, unknown>; second: Record<string, unknown> };

    expect(result.first).toEqual({
      key: "skill:invoked",
      skills: ["nextjs"],
      telemetrySessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(result.second.skills).toEqual(["deploy"]);
    expect(result.first.telemetrySessionId).not.toBe(sessionId);
    expect(result.second.telemetrySessionId).toBe(result.first.telemetrySessionId);
    expect(JSON.stringify(result)).not.toContain("do not send");
    expect(sessionTempEntries(sessionId)).toEqual([`vercel-plugin-${sessionId}-telemetry-session-id.txt`]);
  });

  test("accepts Cursor-shaped payloads (conversation_id, tool_output)", async () => {
    const sessionId = newSessionId("cursor");
    const result = (await probe(`
      import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      process.stdout.write(JSON.stringify(buildSkillInvocationPayload({
        conversation_id: ${JSON.stringify(sessionId)},
        cursor_version: "2.4.0",
        workspace_roots: ["/tmp/project"],
        hook_event_name: "postToolUse",
        tool_name: "Skill",
        tool_input: { skill: "vercel:ai-sdk" },
        tool_output: "{}",
      }, known)));
    `)) as Record<string, unknown>;

    expect(result).toEqual({
      key: "skill:invoked",
      skills: ["ai-sdk"],
      telemetrySessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test("tags the batch with the harness the session-start profiler recorded", async () => {
    const sessionId = newSessionId("harness");
    const result = (await probe(`
      import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      import { writeSessionAgentHarness, readSessionAgentHarness } from ${JSON.stringify(LIB_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      const input = { session_id: ${JSON.stringify(sessionId)}, tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } };
      const before = buildSkillInvocationPayload(input, known);
      writeSessionAgentHarness(${JSON.stringify(sessionId)}, "cursor");
      const after = buildSkillInvocationPayload(input, known);
      const readBack = readSessionAgentHarness(${JSON.stringify(sessionId)});
      process.stdout.write(JSON.stringify({ before, after, readBack }));
    `)) as { before: Record<string, unknown>; after: Record<string, unknown>; readBack: string };

    expect(result.before.agentHarness).toBeUndefined();
    expect(result.after.agentHarness).toBe("cursor");
    expect(result.readBack).toBe("cursor");
    expect(sessionTempEntries(sessionId)).toEqual([
      `vercel-plugin-${sessionId}-agent-harness.txt`,
      `vercel-plugin-${sessionId}-telemetry-session-id.txt`,
    ]);
  });

  test("ignores a corrupted harness session file", async () => {
    const sessionId = newSessionId("bad-harness");
    const result = (await probe(`
      import { readSessionAgentHarness } from ${JSON.stringify(LIB_PATH)};
      import { writeSessionFile } from ${JSON.stringify(join(ROOT, "hooks", "hook-env.mjs"))};
      writeSessionFile(${JSON.stringify(sessionId)}, "agent-harness", "definitely-not-a-harness");
      process.stdout.write(JSON.stringify({ harness: readSessionAgentHarness(${JSON.stringify(sessionId)}) ?? null }));
    `)) as { harness: string | null };

    expect(result.harness).toBeNull();
  });

  test("returns null for other tools, foreign skills, or telemetry off", async () => {
    const result = (await probe(`
      import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      process.stdout.write(JSON.stringify({
        otherTool: buildSkillInvocationPayload({ tool_name: "Bash", tool_input: { command: "vercel:nextjs" } }, known),
        readTool: buildSkillInvocationPayload({ tool_name: "Read", tool_input: { file_path: "skills/nextjs/SKILL.md" } }, known),
        foreignSkill: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "other:deploy" } }, known),
        bareSkill: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "nextjs" } }, known),
        off: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }, known, { VERCEL_PLUGIN_TELEMETRY: "off" }),
        nullInput: buildSkillInvocationPayload(null, known),
        noSession: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }, known),
      }));
    `)) as Record<string, unknown>;

    expect(result.otherTool).toBeNull();
    expect(result.readTool).toBeNull();
    expect(result.foreignSkill).toBeNull();
    expect(result.bareSkill).toBeNull();
    expect(result.off).toBeNull();
    expect(result.nullInput).toBeNull();
    expect(result.noSession).toEqual({ key: "skill:invoked", skills: ["nextjs"] });
  });
});

describe("skill:injected payloads", () => {
  test("batches injected skills under skill:injected with the session envelope", async () => {
    const sessionId = newSessionId("injected");
    const result = (await probe(`
      import { buildSkillTelemetryPayload, writeSessionAgentHarness } from ${JSON.stringify(LIB_PATH)};
      writeSessionAgentHarness(${JSON.stringify(sessionId)}, "claude-code");
      process.stdout.write(JSON.stringify({
        batch: buildSkillTelemetryPayload("skill:injected", ["nextjs", "ai-sdk", "nextjs"], ${JSON.stringify(sessionId)}),
        empty: buildSkillTelemetryPayload("skill:injected", [], ${JSON.stringify(sessionId)}),
        off: buildSkillTelemetryPayload("skill:injected", ["nextjs"], ${JSON.stringify(sessionId)}, { VERCEL_PLUGIN_TELEMETRY: "off" }),
      }));
    `)) as { batch: Record<string, unknown>; empty: unknown; off: unknown };

    expect(result.batch).toEqual({
      key: "skill:injected",
      skills: ["nextjs", "ai-sdk"],
      telemetrySessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      agentHarness: "claude-code",
    });
    expect(result.empty).toBeNull();
    expect(result.off).toBeNull();
  });

  test("compiled inject hooks queue skill:injected once the loaded set is final", () => {
    for (const file of ["pretooluse-skill-inject.mjs", "user-prompt-submit-skill-inject.mjs"]) {
      const source = readFileSync(join(ROOT, "hooks", file), "utf-8");
      const auditIndex = source.indexOf("injectedSkills: loaded");
      const queueIndex = source.indexOf("queueSkillTelemetry(");
      expect(auditIndex).toBeGreaterThan(-1);
      expect(queueIndex).toBeGreaterThan(auditIndex);
      expect(source.includes("SKILL_INJECTED_EVENT_KEY")).toBe(true);
    }
  });
});

describe("skill telemetry send", () => {
  test("sends one event per skill plus version, install id, and harness on the generic topic", async () => {
    const result = (await probe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers).entries()) });
        return new Response(null, { status: 204 });
      };
      const context = { telemetrySessionId: ${JSON.stringify(SESSION_UUID)}, agentHarness: "claude-code" };
      const invoked = await telemetry.trackSkillEvents("skill:invoked", ["nextjs"], context);
      const injected = await telemetry.trackSkillEvents("skill:injected", ["deploy", "env-vars"], context);
      const unlinked = await telemetry.trackSkillEvents("skill:invoked", ["ai-sdk"], {});
      const empty = await telemetry.trackSkillEvents("skill:invoked", [], context);
      process.stdout.write(JSON.stringify({ invoked, injected, unlinked, empty, requests }));
    `)) as {
      invoked: boolean;
      injected: boolean;
      unlinked: boolean;
      empty: boolean;
      requests: Array<{ url: string; body: Array<{ key: string; value: string }>; headers: Record<string, string> }>;
    };

    expect(result.invoked).toBe(true);
    expect(result.injected).toBe(true);
    expect(result.unlinked).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.requests).toHaveLength(3);

    const [first, second, third] = result.requests;
    const installationId = readFileSync(join(tempHome, ".config", "vercel-plugin", "installation-id"), "utf-8").trim();

    expect(first.url).toBe("https://telemetry.vercel.com/api/vercel-plugin/v1/events");
    expect(first.headers["x-vercel-plugin-topic-id"]).toBe("generic");
    expect(first.headers["x-vercel-plugin-version"]).toBe(PLUGIN_VERSION);
    expect(first.headers["x-vercel-plugin-session-id"]).toBe(SESSION_UUID);
    expect(first.body.map((e) => [e.key, e.value]).sort()).toEqual([
      ["plugin:agent_harness", "claude-code"],
      ["plugin:install_id", installationId],
      ["plugin:version", PLUGIN_VERSION],
      ["skill:invoked", "nextjs"],
    ]);

    expect(second.headers["x-vercel-plugin-session-id"]).toBe(SESSION_UUID);
    expect(second.body.filter((e) => e.key === "skill:injected").map((e) => e.value).sort()).toEqual(["deploy", "env-vars"]);
    expect(second.body.some((e) => e.key === "skill:invoked")).toBe(false);

    expect(third.headers["x-vercel-plugin-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(third.headers["x-vercel-plugin-session-id"]).not.toBe(SESSION_UUID);
    expect(third.body.some((e) => e.key === "plugin:agent_harness")).toBe(false);

    for (const request of result.requests) {
      for (const event of request.body) {
        expect(Object.keys(event).sort()).toEqual(["event_time", "id", "key", "value"]);
      }
    }
  });

  test("VERCEL_PLUGIN_TELEMETRY=off never sends and never creates an installation id", async () => {
    const result = (await probe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
      const sent = await telemetry.trackSkillEvents("skill:invoked", ["nextjs"], {});
      process.stdout.write(JSON.stringify({ sent, calls }));
    `, { VERCEL_PLUGIN_TELEMETRY: "off" })) as { sent: boolean; calls: number };

    expect(result.sent).toBe(false);
    expect(result.calls).toBe(0);
    expect(existsSync(join(tempHome, ".config", "vercel-plugin", "installation-id"))).toBe(false);
  });

  test("--send payload parsing rejects malformed input and unknown keys/harnesses", async () => {
    const result = (await probe(`
      import { parseSendPayload } from ${JSON.stringify(LIB_PATH)};
      const p = (payload) => parseSendPayload(["node", "hook", "--send", typeof payload === "string" ? payload : JSON.stringify(payload)]);
      process.stdout.write(JSON.stringify({
        ok: p({ key: "skill:invoked", skills: ["nextjs"], telemetrySessionId: ${JSON.stringify(SESSION_UUID)}, agentHarness: "cursor" }),
        injected: p({ key: "skill:injected", skills: ["nextjs", "ai-sdk"] }),
        badSession: p({ key: "skill:invoked", skills: ["nextjs"], telemetrySessionId: "not-a-uuid" }),
        badHarness: p({ key: "skill:invoked", skills: ["nextjs"], agentHarness: "netscape" }),
        badKey: p({ key: "prompt:text", skills: ["nextjs"] }),
        noSkills: p({ key: "skill:invoked", skills: [] }),
        legacyShape: p({ skill: "nextjs" }),
        garbage: p("{nope"),
        missing: parseSendPayload(["node", "hook", "--send"]),
        noFlag: parseSendPayload(["node", "hook"]),
      }));
    `)) as Record<string, unknown>;

    expect(result.ok).toEqual({ key: "skill:invoked", skills: ["nextjs"], telemetrySessionId: SESSION_UUID, agentHarness: "cursor" });
    expect(result.injected).toEqual({ key: "skill:injected", skills: ["nextjs", "ai-sdk"] });
    expect(result.badSession).toEqual({ key: "skill:invoked", skills: ["nextjs"] });
    expect(result.badHarness).toEqual({ key: "skill:invoked", skills: ["nextjs"] });
    expect(result.badKey).toBeNull();
    expect(result.noSkills).toBeNull();
    expect(result.legacyShape).toBeNull();
    expect(result.garbage).toBeNull();
    expect(result.missing).toBeNull();
    expect(result.noFlag).toBeNull();
  });
});

describe("compiled hook process", () => {
  test("exits 0 with empty stdout and no side effects when telemetry is off", () => {
    const sessionId = newSessionId("off");
    const result = runHook(
      JSON.stringify({ session_id: sessionId, tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }),
      { VERCEL_PLUGIN_TELEMETRY: "off" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(sessionTempEntries(sessionId)).toEqual([]);
    expect(existsSync(join(tempHome, ".config", "vercel-plugin"))).toBe(false);
  });

  test("exits 0 with empty stdout for foreign skills and malformed input", () => {
    const sessionId = newSessionId("foreign");
    for (const stdin of [
      JSON.stringify({ session_id: sessionId, tool_name: "Skill", tool_input: { skill: "someone:else" } }),
      JSON.stringify({ session_id: sessionId, tool_name: "Skill", tool_input: { skill: "nextjs" } }),
      JSON.stringify({ session_id: sessionId, tool_name: "Read", tool_input: { file_path: "/tmp/x" } }),
      "not json",
      "[]",
      "",
    ]) {
      const result = runHook(stdin);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(sessionTempEntries(sessionId)).toEqual([]);
  });

  test("compiled hook never reads skill arguments or tool output", () => {
    const source = readFileSync(HOOK_PATH, "utf-8");
    expect(source.includes(".args")).toBe(false);
    expect(source.includes("toolOutput")).toBe(false);
    expect(source.includes("tool_response")).toBe(false);
  });
});

describe("harness detection", () => {
  test("normalizes AI_AGENT-style names to the approved harness set", async () => {
    const result = (await probe(`
      import { normalizeDetectedAgentHarness } from ${JSON.stringify(PROFILER_PATH)};
      const names = [
        "claude_code", "cowork", "claude-code_2-1-259_agent", "Claude-Code_3-0-0_agent", "cowork_1-0_agent",
        "cursor", "cursor-cli", "cursor_2-4-0_agent",
        "codex_cli", "codex_0-50-0_agent",
        "github-copilot", "copilot_1-0_agent",
        "kimi", "kimi_1-0_agent", "grok", "grok_1-0_agent",
        "windsurf", "my-custom-agent", "",
      ];
      process.stdout.write(JSON.stringify({
        undefinedName: normalizeDetectedAgentHarness(undefined),
        named: Object.fromEntries(names.map((name) => [name, normalizeDetectedAgentHarness(name)])),
      }));
    `)) as { undefinedName: string; named: Record<string, string> };

    expect(result.undefinedName).toBe("unknown");
    expect(result.named).toEqual({
      claude_code: "claude-code",
      cowork: "claude-code",
      "claude-code_2-1-259_agent": "claude-code",
      "Claude-Code_3-0-0_agent": "claude-code",
      "cowork_1-0_agent": "claude-code",
      cursor: "cursor",
      "cursor-cli": "cursor",
      "cursor_2-4-0_agent": "cursor",
      codex_cli: "codex",
      "codex_0-50-0_agent": "codex",
      "github-copilot": "github-copilot",
      "copilot_1-0_agent": "github-copilot",
      kimi: "kimi",
      "kimi_1-0_agent": "kimi",
      grok: "grok",
      "grok_1-0_agent": "grok",
      windsurf: "other",
      "my-custom-agent": "other",
      "": "other",
    });
  });

  test("session-start profiler records the harness for the session unless telemetry is off", () => {
    // fetch is stubbed in the child so the profiler's DAU ping never reaches the bridge.
    const run = (sessionId: string, env: Record<string, string | undefined>) =>
      spawnSync(NODE_BIN, ["--import", join(ROOT, "tests", "_stub-fetch.mjs"), PROFILER_PATH], {
        input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", source: "startup", cwd: tempHome }),
        encoding: "utf-8",
        env: buildEnv({ ...env, CLAUDE_PROJECT_ROOT: tempHome, AI_AGENT: "claude-code_2-1-259_agent" }),
      });

    const offSession = newSessionId("profiler-off");
    expect(run(offSession, { VERCEL_PLUGIN_TELEMETRY: "off" }).status).toBe(0);
    expect(sessionTempEntries(offSession)).not.toContain(`vercel-plugin-${offSession}-agent-harness.txt`);

    const onSession = newSessionId("profiler-on");
    expect(run(onSession, {}).status).toBe(0);
    const harnessFile = join(tmpdir(), `vercel-plugin-${onSession}-agent-harness.txt`);
    expect(existsSync(harnessFile)).toBe(true);
    expect(readFileSync(harnessFile, "utf-8").trim()).toBe("claude-code");
  });
});

describe("hooks.json wiring", () => {
  test("skill telemetry is registered as a PostToolUse hook matched to the Skill tool with a short timeout", async () => {
    const hooksJson = (await import(join(ROOT, "hooks", "hooks.json"))) as HooksJson;
    const groups = hooksJson.hooks.PostToolUse ?? [];
    const group = groups.find((entry) =>
      entry.hooks.some((hook) => hook.command.includes("posttooluse-skill-telemetry.mjs")),
    );

    expect(group).toBeDefined();
    expect(group?.matcher).toBe("Skill");
    const hook = group?.hooks.find((entry) => entry.command.includes("posttooluse-skill-telemetry.mjs"));
    expect(hook?.timeout).toBeLessThanOrEqual(5);
  });
});
