import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const NODE_BIN = Bun.which("node") || "node";

let tempHome: string;

async function runTelemetryProbe(options: {
  telemetryEnv?: string;
  agentHarness?: string;
  agentHarnesses?: string[];
  refreshActiveSessionMarker?: boolean;
}): Promise<{
  dauEnabled: boolean;
  calls: number;
  stampPath: string;
  firstUseStampPath: string;
  installationIdPath: string;
  installationId: string | null;
  activeSessionMarkerPath: string;
  activeSessionMarker: unknown;
  dauPayloads: unknown[];
  dauHeaders: Array<Record<string, string>>;
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
    const dauHeaders = [];
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      dauPayloads.push(JSON.parse(init.body));
      dauHeaders.push(Object.fromEntries(new Headers(init.headers).entries()));
      return new Response(null, { status: 204 });
    };

    const dauEnabled = telemetry.isDauTelemetryEnabled();
    const agentHarnesses = ${JSON.stringify(
      options.agentHarnesses ?? [options.agentHarness ?? "unknown", options.agentHarness ?? "unknown"],
    )};
    for (const agentHarness of agentHarnesses) {
      await telemetry.trackDauActiveToday(undefined, { agentHarness });
    }

    const stampPath = telemetry.getDauStampPath();
    const firstUseStampPath = telemetry.getFirstUseStampPath();
    const installationIdPath = telemetry.getInstallationIdPath();
    const installationId = await import("node:fs").then((fs) =>
      fs.existsSync(installationIdPath)
        ? fs.readFileSync(installationIdPath, "utf-8").trim()
        : null
    );
    const activeSessionMarkerPath = telemetry.getActiveSessionMarkerPath();
    if (${JSON.stringify(options.refreshActiveSessionMarker ?? true)}) {
      telemetry.refreshActiveSessionMarker(new Date("2026-05-15T12:00:00.000Z"));
    }
    const activeSessionMarker = await import("node:fs").then((fs) =>
      fs.existsSync(activeSessionMarkerPath)
        ? JSON.parse(fs.readFileSync(activeSessionMarkerPath, "utf-8"))
        : null
    );
    console.log(JSON.stringify({ dauEnabled, calls, stampPath, firstUseStampPath, installationIdPath, installationId, activeSessionMarkerPath, activeSessionMarker, dauPayloads, dauHeaders }));
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
    firstUseStampPath: string;
    installationIdPath: string;
    installationId: string | null;
    activeSessionMarkerPath: string;
    activeSessionMarker: unknown;
    dauPayloads: unknown[];
    dauHeaders: Array<Record<string, string>>;
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
    expect(existsSync(result.firstUseStampPath)).toBe(false);
    expect(existsSync(result.installationIdPath)).toBe(false);
    expect(result.installationId).toBeNull();
    expect(existsSync(result.activeSessionMarkerPath)).toBe(false);
    expect(result.activeSessionMarker).toBeNull();
  });

  test("default telemetry sends DAU and first-use once", async () => {
    const result = await runTelemetryProbe({ agentHarness: "codex" });
    expect(result.dauEnabled).toBe(true);
    expect(result.calls).toBe(1);
    expect(result.stampPath).toBe(join(tempHome, ".config", "vercel-plugin", "dau-stamp"));
    expect(result.firstUseStampPath).toBe(join(tempHome, ".config", "vercel-plugin", "first-use-stamp"));
    expect(result.installationIdPath).toBe(join(tempHome, ".config", "vercel-plugin", "installation-id"));
    expect(result.activeSessionMarkerPath).toBe(join(tempHome, ".config", "vercel-plugin", "active-session.json"));
    expect(existsSync(result.stampPath)).toBe(true);
    expect(existsSync(result.firstUseStampPath)).toBe(true);
    expect(existsSync(result.installationIdPath)).toBe(true);
    expect(result.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(existsSync(result.activeSessionMarkerPath)).toBe(true);
    expect(result.activeSessionMarker).toEqual({
      schema: 1,
      active: true,
      pluginVersion: "0.48.1",
      updatedAt: Date.parse("2026-05-15T12:00:00.000Z"),
      expiresAt: Date.parse("2026-05-15T13:00:00.000Z"),
    });
    expect(result.dauPayloads).toEqual([
      [
        expect.objectContaining({
          key: "dau:active_today",
          value: "1",
        }),
        expect.objectContaining({
          key: "plugin:first_use",
          value: "1",
        }),
        expect.objectContaining({
          key: "plugin:version",
          value: "0.48.1",
        }),
        expect.objectContaining({
          key: "plugin:install_id",
          value: result.installationId,
        }),
        expect.objectContaining({
          key: "plugin:agent_harness",
          value: "codex",
        }),
      ],
    ]);
    expect(result.dauHeaders).toHaveLength(1);
    expect(result.dauHeaders[0]["x-vercel-plugin-installation-id"]).toBeUndefined();
    expect(result.dauHeaders[0]["x-vercel-plugin-agent-harness"]).toBeUndefined();

    const repeated = await runTelemetryProbe({ agentHarness: "codex" });
    expect(repeated.installationId).toBe(result.installationId);
    expect(repeated.calls).toBe(0);
  });

  test("repairs an invalid installation ID before sending telemetry", async () => {
    const installationIdPath = join(tempHome, ".config", "vercel-plugin", "installation-id");
    mkdirSync(join(tempHome, ".config", "vercel-plugin"), { recursive: true });
    writeFileSync(installationIdPath, "not-a-uuid\n");

    const result = await runTelemetryProbe({ agentHarness: "codex" });

    expect(result.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(readFileSync(installationIdPath, "utf8").trim()).toBe(result.installationId);
    expect(
      (result.dauPayloads[0] as Array<{ key: string; value: string }>).find(
        (event) => event.key === "plugin:install_id",
      )?.value,
    ).toBe(result.installationId);
  });

  test("concurrent invalid-file repairs leave a valid installation ID", async () => {
    const installationIdPath = join(tempHome, ".config", "vercel-plugin", "installation-id");
    mkdirSync(join(tempHome, ".config", "vercel-plugin"), { recursive: true });
    writeFileSync(installationIdPath, "not-a-uuid\n");

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runTelemetryProbe({ agentHarness: "codex", refreshActiveSessionMarker: false }),
      ),
    );
    const storedInstallationId = readFileSync(installationIdPath, "utf8").trim();

    expect(storedInstallationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    for (const result of results) {
      expect(result.installationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }
  });

  test("telemetry opt-out does not repair an invalid installation ID", async () => {
    const installationIdPath = join(tempHome, ".config", "vercel-plugin", "installation-id");
    mkdirSync(join(tempHome, ".config", "vercel-plugin"), { recursive: true });
    writeFileSync(installationIdPath, "not-a-uuid\n");

    const result = await runTelemetryProbe({ telemetryEnv: "off", agentHarness: "codex" });

    expect(result.calls).toBe(0);
    expect(readFileSync(installationIdPath, "utf8")).toBe("not-a-uuid\n");
  });

  test("reports each harness once per UTC day without inflating DAU", async () => {
    const result = await runTelemetryProbe({
      agentHarnesses: ["claude-code", "claude-code", "cursor", "cursor"],
    });

    expect(result.calls).toBe(2);
    expect(result.dauPayloads).toHaveLength(2);

    const events = result.dauPayloads.flat() as Array<{ key: string; value: string }>;
    expect(events.filter((event) => event.key === "dau:active_today")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.key === "plugin:agent_harness")
        .map((event) => event.value),
    ).toEqual(["claude-code", "cursor"]);

    const secondPayload = result.dauPayloads[1] as Array<{ key: string; value: string }>;
    expect(secondPayload.some((event) => event.key === "dau:active_today")).toBe(false);
    expect(secondPayload.some((event) => event.key === "plugin:version")).toBe(true);
    expect(secondPayload.some((event) => event.key === "plugin:install_id")).toBe(true);
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
