import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { readSessionFile } from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILER = join(ROOT, "hooks", "session-start-profiler.mjs");
const NODE_BIN = Bun.which("node") || "node";
let testSessionId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runProfiler(
  env: Record<string, string | undefined>,
  options?: {
    input?: Record<string, unknown>;
    nodeArgs?: string[];
  },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
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

  const proc = Bun.spawn([NODE_BIN, ...(options?.nodeArgs ?? []), PROFILER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  proc.stdin.write(JSON.stringify(options?.input ?? { session_id: testSessionId }));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function parseLikelySkills(_envFileContent?: string): string[] {
  return readSessionFile(testSessionId, "likely-skills").split(",").filter(Boolean);
}

function parseCsvEnvVar(envFileContent: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = envFileContent.match(new RegExp(`export ${escapedKey}="([^"]*)"`));
  if (!match) return [];
  return match[1].split(",").filter(Boolean);
}

function readGreenfieldState(): string {
  return readSessionFile(testSessionId, "greenfield");
}

function makeMockCommand(
  binDir: string,
  commandName: string,
  options: {
    stdoutLine?: string;
    exitCode?: number;
    sleepSeconds?: number;
  },
): void {
  if (process.platform === "win32") {
    const commandPath = join(binDir, `${commandName}.cmd`);
    const lines = ["@echo off"];

    if (options.sleepSeconds) {
      lines.push(`powershell -NoProfile -Command "Start-Sleep -Seconds ${options.sleepSeconds}"`);
    }
    if (options.stdoutLine) {
      lines.push(`echo ${options.stdoutLine}`);
    }

    lines.push(`exit /b ${options.exitCode ?? 0}`);
    writeFileSync(commandPath, `${lines.join("\r\n")}\r\n`, "utf-8");
    return;
  }

  const lines = ["#!/bin/sh"];

  if (options.sleepSeconds) {
    lines.push(`sleep ${options.sleepSeconds}`);
  }
  if (options.stdoutLine) {
    const escapedLine = options.stdoutLine.replace(/'/g, `'\\''`);
    lines.push(`printf '%s\\n' '${escapedLine}'`);
  }

  lines.push(`exit ${options.exitCode ?? 0}`);

  const commandPath = join(binDir, commandName);
  writeFileSync(commandPath, `${lines.join("\n")}\n`, "utf-8");
  chmodSync(commandPath, 0o755);
}

function createTelemetryPreload(capturePath: string): string {
  const preloadPath = join(tempDir, `mock-fetch-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(preloadPath, `
import { writeFileSync } from "node:fs";

globalThis.fetch = async (_url, init) => {
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    headers: init?.headers,
    body: typeof init?.body === "string" ? init.body : null,
  }), "utf-8");
  return new Response(null, { status: 204 });
};
`, "utf-8");
  return preloadPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let envFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "profiler-"));
  envFile = join(tempDir, "claude.env");
  writeFileSync(envFile, "", "utf-8");
  testSessionId = `session-start-profiler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-start-profiler", () => {
  test("script exists", () => {
    expect(existsSync(PROFILER)).toBe(true);
  });

  test("exits cleanly without CLAUDE_ENV_FILE", async () => {
    const result = await runProfiler({ CLAUDE_ENV_FILE: undefined });
    expect(result.code).toBe(0);
  });

  test("detects empty project as greenfield (seeds default skills)", async () => {
    const projectDir = join(tempDir, "empty-project");
    mkdirSync(projectDir);

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("true");
    // Greenfield projects get seeded with default skills but NOT observability
    const skills = parseLikelySkills();
    expect(skills).toContain("nextjs");
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("vercel-cli");
    expect(skills).toContain("env-vars");
    expect(skills).not.toContain("observability");
  });

  test("detects Next.js project via next.config.ts", async () => {
    const projectDir = join(tempDir, "nextjs-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("nextjs");
    expect(skills).toContain("turbopack");
  });

  test("detects Turborepo project via turbo.json", async () => {
    const projectDir = join(tempDir, "turbo-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "turbo.json"), "{}");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ devDependencies: { turbo: "^2.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("turborepo");
  });

  test("detects plain Vercel project (vercel.json only)", async () => {
    const projectDir = join(tempDir, "vercel-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "vercel.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-cli");
    expect(skills).toContain("deployments-cicd");
    expect(skills).toContain("vercel-functions");
  });

  test("detects vercel.json key-specific skills (crons, rewrites)", async () => {
    const projectDir = join(tempDir, "vercel-crons");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "vercel.json"),
      JSON.stringify({
        crons: [{ path: "/api/cron", schedule: "0 * * * *" }],
        rewrites: [{ source: "/old", destination: "/new" }],
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("cron-jobs");
    expect(skills).toContain("routing-middleware");
  });

  test("detects AI SDK dependencies from package.json", async () => {
    const projectDir = join(tempDir, "ai-project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          ai: "^4.0.0",
          "@ai-sdk/gateway": "^1.0.0",
          "@vercel/analytics": "^1.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("ai-gateway");
    expect(skills).toContain("observability");
  });

  test("detects ai-elements via ai-elements or @ai-sdk/react packages", async () => {
    const projectDir = join(tempDir, "ai-elements-project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "ai-elements": "^0.1.0",
          "@ai-sdk/react": "^1.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("ai-elements");
    expect(skills).toContain("ai-sdk");
  });

  test("primes ai-elements when ai package is present", async () => {
    const projectDir = join(tempDir, "ai-implies-elements");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          ai: "^4.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("ai-elements");
  });

  test("detects .mcp.json for vercel-api skill", async () => {
    const projectDir = join(tempDir, "mcp-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".mcp.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-api");
  });

  test("detects middleware.ts for routing-middleware skill", async () => {
    const projectDir = join(tempDir, "middleware-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "middleware.ts"), "export function middleware() {}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("routing-middleware");
  });

  test("detects shadcn via components.json", async () => {
    const projectDir = join(tempDir, "shadcn-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "components.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("shadcn");
  });

  test("detects .env.local for env-vars skill", async () => {
    const projectDir = join(tempDir, "env-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".env.local"), "SECRET=foo");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("env-vars");
  });

  test("detects setup signals and enables setup mode when threshold is met", async () => {
    const projectDir = join(tempDir, "bootstrap-signals");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".env.example"), "DATABASE_URL=");
    writeFileSync(join(projectDir, "README.md"), "# Setup");
    writeFileSync(join(projectDir, "drizzle.config.ts"), "export default {};");
    mkdirSync(join(projectDir, "prisma"), { recursive: true });
    writeFileSync(join(projectDir, "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" }");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        scripts: {
          "db:push": "drizzle-kit push",
          "db:seed": "tsx scripts/seed.ts",
        },
        dependencies: {
          "@neondatabase/serverless": "^1.0.0",
          "@upstash/redis": "^1.0.0",
          "@vercel/blob": "^1.0.0",
          "next-auth": "^5.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const content = readFileSync(envFile, "utf-8");
    const bootstrapHints = parseCsvEnvVar(content, "VERCEL_PLUGIN_BOOTSTRAP_HINTS");
    const resourceHints = parseCsvEnvVar(content, "VERCEL_PLUGIN_RESOURCE_HINTS");

    expect(bootstrapHints).toContain("env-example");
    expect(bootstrapHints).toContain("readme");
    expect(bootstrapHints).toContain("drizzle-config");
    expect(bootstrapHints).toContain("prisma-schema");
    expect(bootstrapHints).toContain("db-push");
    expect(bootstrapHints).toContain("db-seed");
    expect(bootstrapHints).toContain("postgres");
    expect(bootstrapHints).toContain("redis");
    expect(bootstrapHints).toContain("blob");
    expect(bootstrapHints).toContain("auth-secret");

    expect(resourceHints).toContain("postgres");
    expect(resourceHints).toContain("redis");
    expect(resourceHints).toContain("blob");
    expect(content).toContain('VERCEL_PLUGIN_SETUP_MODE="1"');
  });

  test("does not enable setup mode below threshold", async () => {
    const projectDir = join(tempDir, "bootstrap-under-threshold");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".env.example"), "FOO=bar");
    writeFileSync(join(projectDir, "README.md"), "# Hello");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const content = readFileSync(envFile, "utf-8");
    const bootstrapHints = parseCsvEnvVar(content, "VERCEL_PLUGIN_BOOTSTRAP_HINTS");

    expect(bootstrapHints).toEqual(["env-example", "readme"]);
    expect(content).not.toContain("VERCEL_PLUGIN_SETUP_MODE");
    expect(parseCsvEnvVar(content, "VERCEL_PLUGIN_RESOURCE_HINTS")).toEqual([]);
  });

  test("handles full Next.js + Turbo + AI stack", async () => {
    const projectDir = join(tempDir, "full-stack");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.mjs"), "export default {};");
    writeFileSync(join(projectDir, "turbo.json"), "{}");
    writeFileSync(join(projectDir, "vercel.json"), JSON.stringify({ crons: [] }));
    writeFileSync(join(projectDir, ".mcp.json"), "{}");
    writeFileSync(join(projectDir, "middleware.ts"), "");
    writeFileSync(join(projectDir, ".env.local"), "");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          next: "15.0.0",
          ai: "^4.0.0",
          "@vercel/blob": "^1.0.0",
          "@vercel/flags": "^1.0.0",
        },
        devDependencies: {
          turbo: "^2.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));

    // Should detect all major stacks
    expect(skills).toContain("nextjs");
    expect(skills).toContain("turbopack");
    expect(skills).toContain("turborepo");
    expect(skills).toContain("vercel-cli");
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("vercel-storage");
    expect(skills).toContain("vercel-flags");
    expect(skills).toContain("vercel-api");
    expect(skills).toContain("routing-middleware");
    expect(skills).toContain("env-vars");
    expect(skills).toContain("cron-jobs");

    // Skills should be sorted
    const sorted = [...skills].sort();
    expect(skills).toEqual(sorted);
  });

  test("auto-boosts observability for non-greenfield projects", async () => {
    const projectDir = join(tempDir, "obs-boost");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("observability");
    expect(skills).toContain("nextjs");
    // Should remain sorted
    expect(skills).toEqual([...skills].sort());
  });

  test("does not double-add observability when already detected", async () => {
    const projectDir = join(tempDir, "obs-dedup");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { "@vercel/analytics": "^1.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    // observability detected via @vercel/analytics — should appear once
    const count = skills.filter((s) => s === "observability").length;
    expect(count).toBe(1);
  });

  test("survives malformed package.json gracefully", async () => {
    const projectDir = join(tempDir, "bad-pkg");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), "NOT JSON {{{");
    writeFileSync(join(projectDir, "next.config.js"), "");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    // Should still detect file markers despite bad package.json
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("nextjs");
  });

  test("survives malformed vercel.json gracefully", async () => {
    const projectDir = join(tempDir, "bad-vercel");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "vercel.json"), "NOT JSON");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    // Should still detect vercel.json as a marker file
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-cli");
  });

  test("output is sorted and deduplicated", async () => {
    const projectDir = join(tempDir, "dedup-project");
    mkdirSync(projectDir);
    // next.config.ts gives nextjs+turbopack, package.json also gives nextjs
    writeFileSync(join(projectDir, "next.config.ts"), "");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const content = readFileSync(envFile, "utf-8");
    const skills = parseLikelySkills(content);

    // No duplicates
    expect(skills.length).toBe(new Set(skills).size);

    // Sorted
    expect(skills).toEqual([...skills].sort());
  });

  test("persists likely skills and greenfield in session files without exporting them", async () => {
    const projectDir = join(tempDir, "session-file-project");
    mkdirSync(projectDir);

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readSessionFile(testSessionId, "likely-skills")).toContain("nextjs");
    expect(readGreenfieldState()).toBe("true");
  });

  test("uses the hook payload root for linked project telemetry", async () => {
    const envProjectDir = join(tempDir, "env-project-root");
    const payloadProjectDir = join(tempDir, "payload-project-root");
    const capturePath = join(tempDir, "session-start-telemetry.json");
    const binDir = join(tempDir, "empty-bin");
    mkdirSync(join(envProjectDir, ".vercel"), { recursive: true });
    mkdirSync(join(payloadProjectDir, ".vercel"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(
      join(envProjectDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_env", orgId: "team_env" }),
      "utf-8",
    );
    writeFileSync(
      join(payloadProjectDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_payload", orgId: "team_payload" }),
      "utf-8",
    );
    const preloadPath = createTelemetryPreload(capturePath);

    const result = await runProfiler(
      {
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_PROJECT_ROOT: envProjectDir,
        PATH: binDir,
      },
      {
        input: {
          session_id: testSessionId,
          cwd: payloadProjectDir,
        },
        nodeArgs: ["--import", preloadPath],
      },
    );

    expect(result.code).toBe(0);
    const captured = JSON.parse(readFileSync(capturePath, "utf-8")) as {
      body: string;
    };
    const events = JSON.parse(captured.body) as Array<{ key: string; value: string }>;
    expect(events.some((event) => event.key === "session:vercel_project_id" && event.value === "prj_payload")).toBe(true);
    expect(events.some((event) => event.key === "session:vercel_org_id" && event.value === "team_payload")).toBe(true);
    expect(events.some((event) => event.key === "session:vercel_project_id" && event.value === "prj_env")).toBe(false);
    expect(events.some((event) => event.key === "session:vercel_org_id" && event.value === "team_env")).toBe(false);
  });

  test("hooks.json registers profiler after seen-skills init", () => {
    const hooksJson = JSON.parse(
      readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
    );
    const sessionStart = hooksJson.hooks.SessionStart[0];
    const commands = sessionStart.hooks.map(
      (h: { command: string }) => h.command,
    );

    // Profiler must come after seen-skills and before inject-claude-md
    const seenIdx = commands.findIndex((c: string) =>
      c.includes("session-start-seen-skills.mjs"),
    );
    const profilerIdx = commands.findIndex((c: string) =>
      c.includes("session-start-profiler.mjs"),
    );
    const injectIdx = commands.findIndex((c: string) =>
      c.includes("inject-claude-md.mjs"),
    );

    expect(seenIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThan(seenIdx);
    expect(profilerIdx).toBeLessThan(injectIdx);
  });

  test("treats 1.9.0 as older than 1.10.0 when checking Vercel CLI", async () => {
    const projectDir = join(tempDir, "semver-project");
    const binDir = join(tempDir, "mock-bin");
    mkdirSync(projectDir);
    mkdirSync(binDir);
    makeMockCommand(binDir, "vercel", { stdoutLine: "Vercel CLI 1.9.0" });
    makeMockCommand(binDir, "npm", { stdoutLine: "1.10.0" });

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The Vercel CLI is outdated");
    expect(result.stdout).toContain("Vercel CLI 1.9.0");
    expect(result.stdout).toContain("1.10.0");
    expect(result.stdout).toContain("npm i -g vercel@latest");
    expect(result.stdout).toContain("pnpm add -g vercel@latest");
  });

  test("skips npm registry lookup when npm binary cannot be resolved", async () => {
    const projectDir = join(tempDir, "missing-npm-project");
    const binDir = join(tempDir, "missing-npm-bin");
    mkdirSync(projectDir);
    mkdirSync(binDir);
    makeMockCommand(binDir, "vercel", { stdoutLine: "Vercel CLI 44.0.0" });

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      PATH: binDir,
      VERCEL_PLUGIN_LOG_LEVEL: "debug",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("The Vercel CLI is outdated");
    expect(result.stderr).toContain("session-start-profiler:binary-resolution-skipped");
    expect(result.stderr).toContain('"binaryName":"npm"');
  });

  test("times out slow vercel version checks after three seconds", async () => {
    const projectDir = join(tempDir, "slow-vercel-project");
    const binDir = join(tempDir, "slow-vercel-bin");
    mkdirSync(projectDir);
    mkdirSync(binDir);
    makeMockCommand(binDir, "vercel", { sleepSeconds: 5 });

    const startedAt = Date.now();
    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
      VERCEL_PLUGIN_LOG_LEVEL: "debug",
    });
    const durationMs = Date.now() - startedAt;

    expect(result.code).toBe(0);
    expect(durationMs).toBeLessThan(4_700);
    expect(result.stderr).toContain("session-start-profiler:vercel-version-check-failed");
  });

  test("emits debug logs when swallowed profiler errors occur", async () => {
    const binDir = join(tempDir, "debug-bin");
    mkdirSync(binDir);
    makeMockCommand(binDir, "vercel", { exitCode: 1 });

    const result = await runProfiler({
      CLAUDE_ENV_FILE: join(tempDir, "missing-dir", "claude.env"),
      CLAUDE_PROJECT_ROOT: join(tempDir, "missing-project-root"),
      PATH: binDir,
      VERCEL_PLUGIN_LOG_LEVEL: "debug",
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("session-start-profiler:check-greenfield-readdir-failed");
    expect(result.stderr).toContain("session-start-profiler:profile-bootstrap-signals-readdir-failed");
    expect(result.stderr).toContain("session-start-profiler:vercel-version-check-failed");
    expect(result.stderr).toContain("session-start-profiler:binary-resolution-skipped");
    expect(result.stderr).toContain('"binaryName":"agent-browser"');
    expect(result.stderr).toContain("session-start-profiler:append-env-export-failed");
    expect(result.stderr).toContain("hook-env:safe-read-file-failed");
  });
});

// ---------------------------------------------------------------------------
// Greenfield detection (integration)
// ---------------------------------------------------------------------------

describe("greenfield detection", () => {
  test("detects greenfield project (only dot-dirs)", async () => {
    const projectDir = join(tempDir, "greenfield");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    mkdirSync(join(projectDir, ".claude"));

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("true");
    // Greenfield projects get default skills but NOT observability boost
    const skills = parseLikelySkills();
    expect(skills).not.toContain("observability");
    expect(result.stdout).toContain("greenfield project");
    expect(result.stdout).toContain("Skip exploration");
  });

  test("completely empty dir is greenfield", async () => {
    const projectDir = join(tempDir, "greenfield-empty");
    mkdirSync(projectDir);

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("true");
    expect(result.stdout).toContain("greenfield project");
  });

  test("not greenfield when non-dot files exist", async () => {
    const projectDir = join(tempDir, "not-greenfield");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    writeFileSync(join(projectDir, "package.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("");
    expect(result.stdout).not.toContain("greenfield");
  });

  test("not greenfield when non-dot directory exists", async () => {
    const projectDir = join(tempDir, "has-src");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    mkdirSync(join(projectDir, "src"));

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// profileProject unit tests (imported directly)
// ---------------------------------------------------------------------------

describe("profileProject (unit)", () => {
  test("returns empty array for empty directory", async () => {
    // Dynamic import to test the exported function directly
    const { profileProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-empty");
    mkdirSync(projectDir);

    const result = profileProject(projectDir);
    expect(result).toEqual([]);
  });

  test("returns sorted skills for mixed project", async () => {
    const { profileProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-mixed");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.js"), "");
    writeFileSync(join(projectDir, "turbo.json"), "{}");

    const result = profileProject(projectDir);
    expect(result).toContain("nextjs");
    expect(result).toContain("turbopack");
    expect(result).toContain("turborepo");
    expect(result).toEqual([...result].sort());
  });
});

describe("session-start telemetry helpers (unit)", () => {
  test("reads linked Vercel project IDs from .vercel/project.json", async () => {
    const { readLinkedVercelProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-vercel-link");
    mkdirSync(join(projectDir, ".vercel"), { recursive: true });
    writeFileSync(
      join(projectDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_123", orgId: "team_456" }),
      "utf-8",
    );

    expect(readLinkedVercelProject(projectDir)).toEqual({
      projectId: "prj_123",
      orgId: "team_456",
    });
  });

  test("ignores malformed linked Vercel project metadata", async () => {
    const { readLinkedVercelProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-vercel-link-malformed");
    mkdirSync(join(projectDir, ".vercel"), { recursive: true });
    writeFileSync(join(projectDir, ".vercel", "project.json"), "{not valid json", "utf-8");

    expect(readLinkedVercelProject(projectDir)).toBeNull();
  });

  test("ignores incomplete linked Vercel project metadata", async () => {
    const { readLinkedVercelProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-vercel-link-incomplete");
    mkdirSync(join(projectDir, ".vercel"), { recursive: true });
    writeFileSync(
      join(projectDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_123" }),
      "utf-8",
    );

    expect(readLinkedVercelProject(projectDir)).toBeNull();
  });

  test("includes linked Vercel project IDs in session telemetry only when present", async () => {
    const { buildSessionStartTelemetryEntries } = await import("../hooks/session-start-profiler.mjs");

    const withLink = buildSessionStartTelemetryEntries({
      deviceId: "device_123",
      likelySkills: ["nextjs", "vercel-cli"],
      greenfield: false,
      cliStatus: {
        installed: true,
        currentVersion: "44.7.3",
        needsUpdate: false,
      },
      vercelProjectLink: {
        projectId: "prj_123",
        orgId: "team_456",
      },
    });
    expect(withLink).toContainEqual({
      key: "session:vercel_project_id",
      value: "prj_123",
    });
    expect(withLink).toContainEqual({
      key: "session:vercel_org_id",
      value: "team_456",
    });

    const withoutLink = buildSessionStartTelemetryEntries({
      deviceId: "device_123",
      likelySkills: ["nextjs", "vercel-cli"],
      greenfield: false,
      cliStatus: {
        installed: true,
        currentVersion: "44.7.3",
        needsUpdate: false,
      },
      vercelProjectLink: null,
    });
    expect(withoutLink.find((entry) => entry.key === "session:vercel_project_id")).toBeUndefined();
    expect(withoutLink.find((entry) => entry.key === "session:vercel_org_id")).toBeUndefined();
  });

  test("skips linked project lookup when base telemetry is disabled", async () => {
    const { trackSessionStartTelemetry } = await import("../hooks/session-start-profiler.mjs");
    let readProjectLinkCalls = 0;
    let trackEventsCalls = 0;

    await trackSessionStartTelemetry({
      sessionId: "session-disabled-telemetry",
      projectRoot: join(tempDir, "telemetry-off-project"),
      likelySkills: ["nextjs"],
      greenfield: false,
      cliStatus: {
        installed: true,
        currentVersion: "44.7.3",
        needsUpdate: false,
      },
      telemetryEnabled: false,
      getDeviceId: () => "device_123",
      readProjectLink: () => {
        readProjectLinkCalls += 1;
        return { projectId: "prj_123", orgId: "team_456" };
      },
      trackEvents: async () => {
        trackEventsCalls += 1;
      },
    });

    expect(readProjectLinkCalls).toBe(0);
    expect(trackEventsCalls).toBe(0);
  });
});

describe("logBrokenSkillFrontmatterSummary (unit)", () => {
  test("emits one summary warning when a skill has malformed frontmatter", async () => {
    const { logBrokenSkillFrontmatterSummary } = await import("../hooks/session-start-profiler.mjs");
    const pluginDir = join(tempDir, "plugin-root");
    const brokenSkillDir = join(pluginDir, "skills", "broken-skill");
    mkdirSync(brokenSkillDir, { recursive: true });
    writeFileSync(
      join(brokenSkillDir, "SKILL.md"),
      "---\nname: broken-skill\nmetadata:\n\tpathPatterns: []\n---\n# Broken\n",
      "utf-8",
    );

    const summaries: Array<{ event: string; data: Record<string, unknown> }> = [];
    const logger = {
      level: "summary",
      active: true,
      t0: 0,
      now: () => 0,
      elapsed: () => 0,
      summary: (event: string, data: Record<string, unknown>) => {
        summaries.push({ event, data });
      },
      issue: () => {},
      complete: () => {},
      debug: () => {},
      trace: () => {},
      isEnabled: (minLevel: string) => minLevel === "summary" || minLevel === "off",
    };

    const message = logBrokenSkillFrontmatterSummary(pluginDir, logger as any);

    expect(message).toBe("WARNING: 1 skills have broken frontmatter: broken-skill");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event).toBe("session-start-profiler:broken-skill-frontmatter");
    expect(summaries[0].data).toEqual({
      message: "WARNING: 1 skills have broken frontmatter: broken-skill",
      brokenSkillCount: 1,
      brokenSkills: ["broken-skill"],
    });
  });
});

describe("profileBootstrapSignals (unit)", () => {
  test("collects script and dependency-derived hints", async () => {
    const { profileBootstrapSignals } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-bootstrap-signals");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".env.sample"), "DATABASE_URL=");
    writeFileSync(join(projectDir, "README.setup.md"), "# Setup");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        scripts: {
          start: "npm run db:migrate",
        },
        dependencies: {
          "@vercel/edge-config": "^1.0.0",
          "@auth/core": "^1.0.0",
        },
      }),
    );

    const result = profileBootstrapSignals(projectDir);

    expect(result.bootstrapHints).toContain("env-example");
    expect(result.bootstrapHints).toContain("readme");
    expect(result.bootstrapHints).toContain("db-migrate");
    expect(result.bootstrapHints).toContain("edge-config");
    expect(result.bootstrapHints).toContain("auth-secret");
    expect(result.resourceHints).toContain("edge-config");
    expect(result.setupMode).toBe(true);
  });

  test("handles malformed package.json without throwing", async () => {
    const { profileBootstrapSignals } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-bootstrap-bad-pkg");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Setup");
    writeFileSync(join(projectDir, "package.json"), "{not valid json");

    const result = profileBootstrapSignals(projectDir);

    expect(result.bootstrapHints).toEqual(["readme"]);
    expect(result.resourceHints).toEqual([]);
    expect(result.setupMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkGreenfield unit tests
// ---------------------------------------------------------------------------

describe("checkGreenfield (unit)", () => {
  test("returns entries for dot-only directory", async () => {
    const { checkGreenfield } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-gf-dots");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    mkdirSync(join(projectDir, ".claude"));

    const result = checkGreenfield(projectDir);
    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([".claude", ".git"]);
  });

  test("returns entries for empty directory", async () => {
    const { checkGreenfield } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-gf-empty");
    mkdirSync(projectDir);

    const result = checkGreenfield(projectDir);
    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([]);
  });

  test("returns null when non-dot content exists", async () => {
    const { checkGreenfield } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-gf-real");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    writeFileSync(join(projectDir, "README.md"), "# Hello");

    const result = checkGreenfield(projectDir);
    expect(result).toBeNull();
  });

  test("returns null for non-existent directory", async () => {
    const { checkGreenfield } = await import("../hooks/session-start-profiler.mjs");
    const result = checkGreenfield(join(tempDir, "does-not-exist"));
    expect(result).toBeNull();
  });
});
