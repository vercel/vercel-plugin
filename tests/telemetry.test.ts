import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const USER_PROMPT_HOOK = join(ROOT, "hooks", "user-prompt-submit-telemetry.mjs");
const NODE_BIN = Bun.which("node") || "node";

let tempHome: string;

async function runTelemetryProbe(options: {
  telemetryEnv?: string;
  preference?: "enabled" | "disabled";
}): Promise<{ baseEnabled: boolean; contentEnabled: boolean; calls: number }> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: tempHome,
  };

  if (options.telemetryEnv === undefined) {
    delete mergedEnv.VERCEL_PLUGIN_TELEMETRY;
  } else {
    mergedEnv.VERCEL_PLUGIN_TELEMETRY = options.telemetryEnv;
  }

  const script = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { homedir } from "node:os";
    import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};

    const preference = ${options.preference ? JSON.stringify(options.preference) : "null"};
    if (preference) {
      mkdirSync(join(homedir(), ".claude"), { recursive: true });
      writeFileSync(join(homedir(), ".claude", "vercel-plugin-telemetry-preference"), preference, "utf-8");
    }

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    const baseEnabled = telemetry.isBaseTelemetryEnabled();
    const contentEnabled = telemetry.isContentTelemetryEnabled();
    await telemetry.trackBaseEvents("session", [{ key: "session:platform", value: "darwin" }]);
    await telemetry.trackContentEvents("session", [{ key: "prompt:text", value: "hello from prompt" }]);

    console.log(JSON.stringify({ baseEnabled, contentEnabled, calls }));
  `;

  const proc = Bun.spawn([NODE_BIN, "--input-type=module", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (code !== 0) {
    throw new Error(stderr || `telemetry probe exited with code ${code}`);
  }

  return JSON.parse(stdout.trim()) as { baseEnabled: boolean; contentEnabled: boolean; calls: number };
}

async function runPromptHook(env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }

  const proc = Bun.spawn([NODE_BIN, USER_PROMPT_HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  proc.stdin.write(JSON.stringify({
    session_id: "telemetry-session",
    prompt: "show me the telemetry behavior",
  }));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "telemetry-home-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("telemetry controls", () => {
  test("VERCEL_PLUGIN_TELEMETRY=off disables all telemetry sends", async () => {
    const result = await runTelemetryProbe({ telemetryEnv: "off" });
    expect(result.baseEnabled).toBe(false);
    expect(result.contentEnabled).toBe(false);
    expect(result.calls).toBe(0);
  });

  test("disabled preference blocks content telemetry but not default base telemetry", async () => {
    const result = await runTelemetryProbe({ preference: "disabled" });
    expect(result.baseEnabled).toBe(true);
    expect(result.contentEnabled).toBe(false);
    expect(result.calls).toBe(1);
  });

  test("prompt hook does not ask for telemetry when VERCEL_PLUGIN_TELEMETRY=off", async () => {
    const prefPath = join(tempHome, ".claude", "vercel-plugin-telemetry-preference");
    const result = await runPromptHook({
      HOME: tempHome,
      VERCEL_PLUGIN_TELEMETRY: "off",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}");
    expect(existsSync(prefPath)).toBe(false);
  });
});
