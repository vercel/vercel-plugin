import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseSessionVercelProjectLinkState,
  readSessionVercelProjectLinkState,
  resolveHookProjectRoot,
  shouldRefreshSessionVercelProjectLink,
  writeSessionVercelProjectLinkState,
} from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const TELEMETRY_MODULE = join(ROOT, "hooks", "telemetry.mjs");
const USER_PROMPT_HOOK = join(ROOT, "hooks", "user-prompt-submit-telemetry.mjs");
const NODE_BIN = Bun.which("node") || "node";

let tempHome: string;

async function runTelemetryProbe(options: {
  telemetryEnv?: string;
  preference?: "enabled" | "disabled";
}): Promise<{ baseEnabled: boolean; promptEnabled: boolean; calls: number }> {
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
    const promptEnabled = telemetry.isPromptTelemetryEnabled();
    await telemetry.trackBaseEvents("session", [{ key: "session:platform", value: "darwin" }]);
    await telemetry.trackEvents("session", [{ key: "prompt:text", value: "hello from prompt" }]);

    console.log(JSON.stringify({ baseEnabled, promptEnabled, calls }));
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

  return JSON.parse(stdout.trim()) as { baseEnabled: boolean; promptEnabled: boolean; calls: number };
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

async function runPromptHookWithCapture(args: {
  env?: Record<string, string | undefined>;
  payload?: Record<string, unknown>;
}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  requests: Array<{ url: string; body: string | null; headers: Record<string, string> | null }>;
}> {
  const captureFile = join(tempHome, `prompt-hook-capture-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const preloadFile = join(tempHome, `prompt-hook-preload-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    preloadFile,
    [
      'import { appendFileSync } from "node:fs";',
      'const captureFile = process.env.VERCEL_PLUGIN_CAPTURE_FILE;',
      'globalThis.fetch = async (url, options = {}) => {',
      '  if (captureFile) {',
      '    appendFileSync(captureFile, JSON.stringify({',
      '      url: String(url),',
      '      body: typeof options.body === "string" ? options.body : null,',
      '      headers: options.headers && typeof options.headers === "object" ? options.headers : null,',
      '    }) + "\\n", "utf-8");',
      '  }',
      '  return new Response(null, { status: 204 });',
      '};',
    ].join("\n"),
    "utf-8",
  );

  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VERCEL_PLUGIN_CAPTURE_FILE: captureFile,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(preloadFile).href}`,
    ].filter(Boolean).join(" "),
  };

  for (const [key, value] of Object.entries(args.env ?? {})) {
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

  proc.stdin.write(JSON.stringify(args.payload ?? {
    session_id: "telemetry-session",
    prompt: "show me the telemetry behavior",
  }));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const requests = existsSync(captureFile)
    ? readFileSync(captureFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { url: string; body: string | null; headers: Record<string, string> | null })
    : [];

  rmSync(captureFile, { force: true });
  rmSync(preloadFile, { force: true });

  return { code, stdout, stderr, requests };
}

function writePromptTelemetryPreference(value: "enabled" | "disabled"): void {
  const claudeDir = join(tempHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "vercel-plugin-telemetry-preference"), value, "utf-8");
}

function parseTrackedEntries(body: string | null): Array<{ key: string; value: string }> {
  return (JSON.parse(body ?? "[]") as Array<{ key: string; value: string }>)
    .map((entry) => ({ key: entry.key, value: entry.value }));
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
    expect(result.promptEnabled).toBe(false);
    expect(result.calls).toBe(0);
  });

  test("disabled preference blocks prompt text but not default base telemetry", async () => {
    const result = await runTelemetryProbe({ preference: "disabled" });
    expect(result.baseEnabled).toBe(true);
    expect(result.promptEnabled).toBe(false);
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

describe("Vercel project link refresh", () => {
  test("prefers per-prompt roots over stale session env roots", () => {
    const promptRoot = join(tempHome, "apps", "web");
    const workspaceRoot = join(tempHome, "apps", "api");
    const envRoot = join(tempHome, "stale-session-root");

    expect(resolveHookProjectRoot({ cwd: promptRoot }, { CLAUDE_PROJECT_ROOT: envRoot })).toBe(promptRoot);
    expect(
      resolveHookProjectRoot(
        { workspace_roots: [workspaceRoot] },
        { CLAUDE_PROJECT_ROOT: envRoot },
      ),
    ).toBe(workspaceRoot);
  });

  test("parses last sent project metadata from session state", () => {
    expect(
      parseSessionVercelProjectLinkState(JSON.stringify({
        lastResolvedAt: 123,
        projectId: "prj_current",
        orgId: "team_current",
        lastSentProjectId: "prj_sent",
        lastSentOrgId: "team_sent",
      })),
    ).toEqual({
      lastResolvedAt: 123,
      projectId: "prj_current",
      orgId: "team_current",
      lastSentProjectId: "prj_sent",
      lastSentOrgId: "team_sent",
    });
  });

  test("refreshes when the cached link is missing, unsent, or at least an hour old", () => {
    const now = Date.now();

    expect(shouldRefreshSessionVercelProjectLink(null, now, 3_600_000)).toBe(true);
    expect(
      shouldRefreshSessionVercelProjectLink(
        { lastResolvedAt: now - 1, projectId: "prj_unsent", orgId: "team_unsent" },
        now,
        3_600_000,
      ),
    ).toBe(true);
    expect(
      shouldRefreshSessionVercelProjectLink(
        {
          lastResolvedAt: now - 3_599_999,
          projectId: "prj_sent",
          orgId: "team_sent",
          lastSentProjectId: "prj_sent",
          lastSentOrgId: "team_sent",
        },
        now,
        3_600_000,
      ),
    ).toBe(false);
    expect(
      shouldRefreshSessionVercelProjectLink(
        {
          lastResolvedAt: now - 3_600_000,
          projectId: "prj_sent",
          orgId: "team_sent",
          lastSentProjectId: "prj_sent",
          lastSentOrgId: "team_sent",
        },
        now,
        3_600_000,
      ),
    ).toBe(true);
  });

  test("prompt hook re-emits linked project ids when cwd resolves to a different linked project", async () => {
    const sessionId = `telemetry-project-link-change-${Date.now()}`;
    const staleRoot = join(tempHome, "stale-root");
    const currentRoot = join(tempHome, "apps", "web");
    mkdirSync(join(staleRoot, ".vercel"), { recursive: true });
    mkdirSync(join(currentRoot, ".vercel"), { recursive: true });
    writeFileSync(
      join(staleRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_stale", orgId: "team_stale" }),
      "utf-8",
    );
    writeFileSync(
      join(currentRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_current", orgId: "team_current" }),
      "utf-8",
    );
    writeSessionVercelProjectLinkState(sessionId, {
      lastResolvedAt: Date.now() - 3_600_000,
      projectId: "prj_stale",
      orgId: "team_stale",
      lastSentProjectId: "prj_stale",
      lastSentOrgId: "team_stale",
    });
    writePromptTelemetryPreference("disabled");

    const result = await runPromptHookWithCapture({
      env: {
        HOME: tempHome,
        CLAUDE_PROJECT_ROOT: staleRoot,
      },
      payload: {
        session_id: sessionId,
        prompt: "refresh project telemetry",
        cwd: currentRoot,
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}");
    expect(result.requests).toHaveLength(1);
    expect(parseTrackedEntries(result.requests[0].body)).toEqual([
      { key: "session:vercel_project_id", value: "prj_current" },
      { key: "session:vercel_org_id", value: "team_current" },
    ]);
    expect(readSessionVercelProjectLinkState(sessionId)).toMatchObject({
      projectId: "prj_current",
      orgId: "team_current",
      lastSentProjectId: "prj_current",
      lastSentOrgId: "team_current",
    });
  });

  test("prompt hook clears cached project ids when the current project is no longer linked", async () => {
    const sessionId = `telemetry-project-link-removed-${Date.now()}`;
    const staleRoot = join(tempHome, "old-linked-root");
    const unlinkedRoot = join(tempHome, "plain-project");
    mkdirSync(join(staleRoot, ".vercel"), { recursive: true });
    mkdirSync(unlinkedRoot, { recursive: true });
    writeFileSync(
      join(staleRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_old", orgId: "team_old" }),
      "utf-8",
    );
    writeSessionVercelProjectLinkState(sessionId, {
      lastResolvedAt: Date.now() - 3_600_000,
      projectId: "prj_old",
      orgId: "team_old",
      lastSentProjectId: "prj_old",
      lastSentOrgId: "team_old",
    });
    writePromptTelemetryPreference("disabled");

    const result = await runPromptHookWithCapture({
      env: {
        HOME: tempHome,
        CLAUDE_PROJECT_ROOT: staleRoot,
      },
      payload: {
        session_id: sessionId,
        prompt: "refresh project telemetry",
        cwd: unlinkedRoot,
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}");
    expect(result.requests).toHaveLength(0);
    const state = readSessionVercelProjectLinkState(sessionId);
    expect(state?.projectId).toBeUndefined();
    expect(state?.orgId).toBeUndefined();
    expect(state?.lastSentProjectId).toBe("prj_old");
    expect(state?.lastSentOrgId).toBe("team_old");
    expect(state?.lastResolvedAt).toEqual(expect.any(Number));
  });

  test("prompt hook does not re-emit linked project ids within the refresh window", async () => {
    const sessionId = `telemetry-project-link-unchanged-${Date.now()}`;
    const linkedRoot = join(tempHome, "steady-linked-root");
    mkdirSync(join(linkedRoot, ".vercel"), { recursive: true });
    writeFileSync(
      join(linkedRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_same", orgId: "team_same" }),
      "utf-8",
    );
    const initialState = {
      lastResolvedAt: Date.now(),
      projectId: "prj_same",
      orgId: "team_same",
      lastSentProjectId: "prj_same",
      lastSentOrgId: "team_same",
    };
    writeSessionVercelProjectLinkState(sessionId, initialState);
    writePromptTelemetryPreference("disabled");

    const result = await runPromptHookWithCapture({
      env: {
        HOME: tempHome,
      },
      payload: {
        session_id: sessionId,
        prompt: "refresh project telemetry",
        cwd: linkedRoot,
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}");
    expect(result.requests).toHaveLength(0);
    expect(readSessionVercelProjectLinkState(sessionId)).toEqual(initialState);
  });
});
