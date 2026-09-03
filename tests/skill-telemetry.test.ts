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
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const NODE_BIN = Bun.which("node") || "node";

interface HooksJson {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
}

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "vercel-plugin-skill-telemetry-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function runHook(stdin: string, env: Record<string, string | undefined> = {}) {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>), HOME: tempHome };
  delete mergedEnv.VERCEL_PLUGIN_TELEMETRY;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete mergedEnv[key];
    else mergedEnv[key] = value;
  }
  return spawnSync(NODE_BIN, [HOOK_PATH], { input: stdin, encoding: "utf-8", env: mergedEnv });
}

function sessionTempEntries(sessionId: string): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`vercel-plugin-${sessionId}-`));
}

async function runInProcessProbe(script: string, env: Record<string, string | undefined> = {}): Promise<unknown> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>), HOME: tempHome };
  delete mergedEnv.VERCEL_PLUGIN_TELEMETRY;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete mergedEnv[key];
    else mergedEnv[key] = value;
  }
  const result = spawnSync(NODE_BIN, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    env: mergedEnv,
  });
  if (result.status !== 0) {
    throw new Error(`probe failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe("skill invocation allowlist", () => {
  test("only plugin-shipped skills and commands are reported", async () => {
    const result = (await runInProcessProbe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      import { loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      const cases = {
        namespaced: telemetry.normalizeSkillInvocation("vercel:nextjs", known),
        slashNamespaced: telemetry.normalizeSkillInvocation("/vercel-plugin:ai-sdk", known),
        bare: telemetry.normalizeSkillInvocation("nextjs", known),
        command: telemetry.normalizeSkillInvocation("vercel:deploy", known),
        upperCase: telemetry.normalizeSkillInvocation("vercel:NextJS", known),
        thirdParty: telemetry.normalizeSkillInvocation("someone-else:nextjs-pro", known),
        conventions: telemetry.normalizeSkillInvocation("vercel:_conventions", known),
        pathLike: telemetry.normalizeSkillInvocation("vercel:../../etc/passwd", known),
        notAString: telemetry.normalizeSkillInvocation({ skill: "nextjs" }, known),
        empty: telemetry.normalizeSkillInvocation("", known),
      };
      process.stdout.write(JSON.stringify({ knownCount: known.size, hasCommands: known.has("bootstrap"), cases }));
    `)) as { knownCount: number; hasCommands: boolean; cases: Record<string, string | null> };

    expect(result.knownCount).toBeGreaterThan(30);
    expect(result.hasCommands).toBe(true);
    expect(result.cases).toEqual({
      namespaced: "nextjs",
      slashNamespaced: "ai-sdk",
      bare: "nextjs",
      command: "deploy",
      upperCase: "nextjs",
      thirdParty: null,
      conventions: null,
      pathLike: null,
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

    const result = (await runInProcessProbe(`
      import { loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      process.stdout.write(JSON.stringify([...loadKnownPluginSkills(${JSON.stringify(ROOT)})].sort()));
    `)) as string[];

    expect(result).toEqual([...new Set([...skillDirs, ...commands])].sort());
  });
});

describe("skill invocation payload", () => {
  test("builds a payload with a plugin-minted session UUID, never the harness session id", async () => {
    const sessionId = `skill-telemetry-${process.pid}-${Date.now()}`;
    try {
      const result = (await runInProcessProbe(`
        import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
        const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
        const input = {
          session_id: ${JSON.stringify(sessionId)},
          tool_name: "Skill",
          tool_input: { skill: "vercel:nextjs", args: "do not send this" },
        };
        const first = buildSkillInvocationPayload(input, known);
        const second = buildSkillInvocationPayload({ ...input, tool_input: { skill: "vercel:deploy" } }, known);
        process.stdout.write(JSON.stringify({ first, second }));
      `)) as { first: Record<string, string>; second: Record<string, string> };

      expect(result.first.skill).toBe("nextjs");
      expect(result.second.skill).toBe("deploy");
      expect(Object.keys(result.first).sort()).toEqual(["skill", "telemetrySessionId"]);
      expect(result.first.telemetrySessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.first.telemetrySessionId).not.toBe(sessionId);
      expect(result.second.telemetrySessionId).toBe(result.first.telemetrySessionId);
      expect(JSON.stringify(result)).not.toContain("do not send this");
      expect(sessionTempEntries(sessionId)).toEqual([`vercel-plugin-${sessionId}-telemetry-session-id.txt`]);
    } finally {
      for (const entry of sessionTempEntries(sessionId)) {
        rmSync(join(tmpdir(), entry), { force: true });
      }
    }
  });

  test("returns null for other tools, unknown skills, or telemetry off", async () => {
    const result = (await runInProcessProbe(`
      import { buildSkillInvocationPayload, loadKnownPluginSkills } from ${JSON.stringify(HOOK_PATH)};
      const known = loadKnownPluginSkills(${JSON.stringify(ROOT)});
      process.stdout.write(JSON.stringify({
        otherTool: buildSkillInvocationPayload({ tool_name: "Bash", tool_input: { command: "vercel:nextjs" } }, known),
        unknownSkill: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "other:thing" } }, known),
        off: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }, known, { VERCEL_PLUGIN_TELEMETRY: "off" }),
        nullInput: buildSkillInvocationPayload(null, known),
        noSession: buildSkillInvocationPayload({ tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }, known),
      }));
    `)) as Record<string, unknown>;

    expect(result.otherTool).toBeNull();
    expect(result.unknownSkill).toBeNull();
    expect(result.off).toBeNull();
    expect(result.nullInput).toBeNull();
    expect(result.noSession).toEqual({ skill: "nextjs" });
  });
});

describe("skill invocation send", () => {
  test("sends skill:invoked with version and install id on the generic topic", async () => {
    const result = (await runInProcessProbe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers).entries()) });
        return new Response(null, { status: 204 });
      };
      const telemetrySessionId = "6f1d2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c";
      const sent = await telemetry.trackSkillInvocation("nextjs", { telemetrySessionId });
      const sentAgain = await telemetry.trackSkillInvocation("deploy", { telemetrySessionId });
      const unlinked = await telemetry.trackSkillInvocation("ai-sdk", {});
      process.stdout.write(JSON.stringify({ sent, sentAgain, unlinked, requests }));
    `)) as {
      sent: boolean;
      sentAgain: boolean;
      unlinked: boolean;
      requests: Array<{ url: string; body: Array<{ key: string; value: string }>; headers: Record<string, string> }>;
    };

    expect(result.sent).toBe(true);
    expect(result.sentAgain).toBe(true);
    expect(result.unlinked).toBe(true);
    expect(result.requests).toHaveLength(3);

    const [first, second, third] = result.requests;
    expect(first.url).toBe("https://telemetry.vercel.com/api/vercel-plugin/v1/events");
    expect(first.headers["x-vercel-plugin-topic-id"]).toBe("generic");
    expect(first.headers["x-vercel-plugin-version"]).toBe(PLUGIN_VERSION);
    expect(first.headers["x-vercel-plugin-session-id"]).toBe("6f1d2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c");
    expect(second.headers["x-vercel-plugin-session-id"]).toBe(first.headers["x-vercel-plugin-session-id"]);
    expect(third.headers["x-vercel-plugin-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(third.headers["x-vercel-plugin-session-id"]).not.toBe(first.headers["x-vercel-plugin-session-id"]);

    const keys = first.body.map((event) => event.key).sort();
    expect(keys).toEqual(["plugin:install_id", "plugin:version", "skill:invoked"]);
    expect(first.body.find((event) => event.key === "skill:invoked")?.value).toBe("nextjs");
    expect(first.body.find((event) => event.key === "plugin:version")?.value).toBe(PLUGIN_VERSION);
    expect(second.body.find((event) => event.key === "skill:invoked")?.value).toBe("deploy");

    const installationId = readFileSync(join(tempHome, ".config", "vercel-plugin", "installation-id"), "utf-8").trim();
    expect(first.body.find((event) => event.key === "plugin:install_id")?.value).toBe(installationId);

    for (const request of result.requests) {
      for (const event of request.body) {
        expect(Object.keys(event).sort()).toEqual(["event_time", "id", "key", "value"]);
      }
    }
  });

  test("VERCEL_PLUGIN_TELEMETRY=off never sends and never creates an installation id", async () => {
    const result = (await runInProcessProbe(`
      import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};
      let calls = 0;
      globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
      const sent = await telemetry.trackSkillInvocation("nextjs", {});
      process.stdout.write(JSON.stringify({ sent, calls }));
    `, { VERCEL_PLUGIN_TELEMETRY: "off" })) as { sent: boolean; calls: number };

    expect(result.sent).toBe(false);
    expect(result.calls).toBe(0);
    expect(existsSync(join(tempHome, ".config", "vercel-plugin", "installation-id"))).toBe(false);
  });

  test("--send payload parsing rejects malformed input", async () => {
    const result = (await runInProcessProbe(`
      import { parseSendPayload } from ${JSON.stringify(HOOK_PATH)};
      process.stdout.write(JSON.stringify({
        ok: parseSendPayload(["node", "hook", "--send", JSON.stringify({ skill: "nextjs", telemetrySessionId: "6f1d2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c" })]),
        badSession: parseSendPayload(["node", "hook", "--send", JSON.stringify({ skill: "nextjs", telemetrySessionId: "not-a-uuid" })]),
        missing: parseSendPayload(["node", "hook", "--send"]),
        garbage: parseSendPayload(["node", "hook", "--send", "{nope"]),
        noFlag: parseSendPayload(["node", "hook"]),
      }));
    `)) as Record<string, unknown>;

    expect(result.ok).toEqual({ skill: "nextjs", telemetrySessionId: "6f1d2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c" });
    expect(result.badSession).toEqual({ skill: "nextjs" });
    expect(result.missing).toBeNull();
    expect(result.garbage).toBeNull();
    expect(result.noFlag).toBeNull();
  });
});

describe("compiled hook process", () => {
  test("exits 0 with empty stdout and no side effects when telemetry is off", () => {
    const sessionId = `skill-telemetry-off-${process.pid}-${Date.now()}`;
    const result = runHook(
      JSON.stringify({ session_id: sessionId, tool_name: "Skill", tool_input: { skill: "vercel:nextjs" } }),
      { VERCEL_PLUGIN_TELEMETRY: "off" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(sessionTempEntries(sessionId)).toEqual([]);
    expect(existsSync(join(tempHome, ".config", "vercel-plugin"))).toBe(false);
  });

  test("exits 0 with empty stdout for non-plugin skills and malformed input", () => {
    const sessionId = `skill-telemetry-unknown-${process.pid}-${Date.now()}`;
    for (const stdin of [
      JSON.stringify({ session_id: sessionId, tool_name: "Skill", tool_input: { skill: "someone:else" } }),
      JSON.stringify({ session_id: sessionId, tool_name: "Read", tool_input: { file_path: "/tmp/x" } }),
      "not json",
      "",
    ]) {
      const result = runHook(stdin);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(sessionTempEntries(sessionId)).toEqual([]);
  });

  test("compiled hook never reads skill arguments or other tool content", () => {
    const source = readFileSync(HOOK_PATH, "utf-8");
    expect(source.includes(".args")).toBe(false);
    expect(source.includes("tool_response")).toBe(false);
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
