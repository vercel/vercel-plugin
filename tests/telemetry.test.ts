import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const NODE_BIN = Bun.which("node") || "node";

let tempHome: string;

async function runTelemetryProbe(options: {
  telemetryEnv?: string;
}): Promise<{
  dauEnabled: boolean;
  calls: number;
  stampPath: string;
  dauPayloads: unknown[];
}> {
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
    import * as telemetry from ${JSON.stringify(TELEMETRY_MODULE)};

    let calls = 0;
    const dauPayloads = [];
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      dauPayloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    };

    const dauEnabled = telemetry.isDauTelemetryEnabled();
    await telemetry.trackDauActiveToday();
    await telemetry.trackDauActiveToday();

    const stampPath = telemetry.getDauStampPath();
    console.log(JSON.stringify({ dauEnabled, calls, stampPath, dauPayloads }));
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

  return JSON.parse(stdout.trim()) as {
    dauEnabled: boolean;
    calls: number;
    stampPath: string;
    dauPayloads: unknown[];
  };
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
    expect(result.dauEnabled).toBe(false);
    expect(result.calls).toBe(0);
    expect(existsSync(result.stampPath)).toBe(false);
  });

  test("default telemetry is DAU-only", async () => {
    const result = await runTelemetryProbe({});
    expect(result.dauEnabled).toBe(true);
    expect(result.calls).toBe(1);
    expect(result.stampPath).toBe(join(tempHome, ".config", "vercel-plugin", "dau-stamp"));
    expect(existsSync(result.stampPath)).toBe(true);
    expect(result.dauPayloads).toEqual([
      [
        expect.objectContaining({
          key: "dau:active_today",
          value: "1",
        }),
      ],
    ]);
  });

  test("compiled hooks do not emit prompt, tool, or skill-injection telemetry keys", () => {
    const pretoolHook = readFileSync(join(ROOT, "hooks", "pretooluse-skill-inject.mjs"), "utf-8");
    const promptSkillInjectHook = readFileSync(join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs"), "utf-8");

    expect(pretoolHook.includes("tool_call:tool_name")).toBe(false);
    expect(pretoolHook.includes("tool_call:command")).toBe(false);
    expect(pretoolHook.includes("skill:injected")).toBe(false);
    expect(pretoolHook.includes("skill:hook")).toBe(false);
    expect(promptSkillInjectHook.includes("skill:injected")).toBe(false);
    expect(promptSkillInjectHook.includes("skill:hook")).toBe(false);
    expect(promptSkillInjectHook.includes("prompt:text")).toBe(false);
  });

  test("session-start profiler source only references the DAU ping telemetry key", () => {
    const profilerHook = readFileSync(join(ROOT, "hooks", "session-start-profiler.mjs"), "utf-8");

    expect(profilerHook.includes("trackDauActiveToday")).toBe(true);
    expect(profilerHook.includes("session:device_id")).toBe(false);
    expect(profilerHook.includes("session:vercel_cli_version")).toBe(false);
    expect(profilerHook.includes("session:platform")).toBe(false);
    expect(profilerHook.includes("session:likely_skills")).toBe(false);
    expect(profilerHook.includes("session:greenfield")).toBe(false);
    expect(profilerHook.includes("session:vercel_cli_installed")).toBe(false);
  });
});
