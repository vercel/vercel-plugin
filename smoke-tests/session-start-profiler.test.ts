import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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
import { join, resolve } from "node:path";
import { readSessionFile, profileCachePath } from "../hooks/src/hook-env.mts";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILER = join(ROOT, "hooks", "session-start-profiler.mjs");
const NODE_BIN = Bun.which("node") || "node";
let testSessionId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runProfiler(env: Record<string, string | undefined>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Disable auto-install by default so tests don't trigger real `npx skills add`
    // calls. Tests that specifically verify auto-install set the env var explicitly.
    VERCEL_PLUGIN_SKILL_AUTO_INSTALL: "0",
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }

  const proc = Bun.spawn([NODE_BIN, PROFILER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  proc.stdin.write(JSON.stringify({ session_id: testSessionId }));
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

function makeMockCommand(binDir: string, commandName: string, body: string): void {
  const commandPath = join(binDir, commandName);
  writeFileSync(commandPath, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(commandPath, 0o755);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let envFile: string;
let testHomeDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "profiler-"));
  testHomeDir = mkdtempSync(join(tmpdir(), "vercel-plugin-home-"));
  envFile = join(tempDir, "claude.env");
  writeFileSync(envFile, "", "utf-8");
  testSessionId = `session-start-profiler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(testHomeDir, { recursive: true, force: true });
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

  test("detects empty project as greenfield (no profiler detections)", async () => {
    const projectDir = join(tempDir, "empty-project");
    mkdirSync(projectDir);

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);
    expect(readGreenfieldState()).toBe("true");
    // Greenfield projects get zero profiler detections — the UserPromptSubmit
    // hook handles skill discovery based on the user's actual request.
    const skills = parseLikelySkills();
    expect(skills).toEqual([]);
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
    // Use a non-greenfield project so detections produce likely-skills
    const projectDir = join(tempDir, "session-file-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    expect(readSessionFile(testSessionId, "likely-skills")).toContain("nextjs");
    // Non-greenfield project
    expect(readGreenfieldState()).toBe("");
  });

  test("hooks.json registers profiler after seen-skills init", () => {
    const hooksJson = JSON.parse(
      readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
    );
    const sessionStart = hooksJson.hooks.SessionStart[0];
    const commands = sessionStart.hooks.map(
      (h: { command: string }) => h.command,
    );

    // Profiler must come after seen-skills and before engine-context
    const seenIdx = commands.findIndex((c: string) =>
      c.includes("session-start-seen-skills.mjs"),
    );
    const profilerIdx = commands.findIndex((c: string) =>
      c.includes("session-start-profiler.mjs"),
    );
    const engineCtxIdx = commands.findIndex((c: string) =>
      c.includes("session-start-engine-context.mjs"),
    );

    expect(seenIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThanOrEqual(0);
    expect(engineCtxIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThan(seenIdx);
    expect(profilerIdx).toBeLessThan(engineCtxIdx);
  });

  test("treats 1.9.0 as older than 1.10.0 when checking Vercel CLI", async () => {
    const projectDir = join(tempDir, "semver-project");
    const binDir = join(tempDir, "mock-bin");
    mkdirSync(projectDir);
    mkdirSync(binDir);
    makeMockCommand(binDir, "vercel", "printf 'Vercel CLI 1.9.0\\n'");
    makeMockCommand(binDir, "npm", "printf '1.10.0\\n'");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      PATH: `${binDir}:${process.env.PATH || ""}`,
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
    makeMockCommand(binDir, "vercel", "printf 'Vercel CLI 44.0.0\\n'");

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
    makeMockCommand(binDir, "vercel", "sleep 5");

    const startedAt = Date.now();
    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      PATH: `${binDir}:${process.env.PATH || ""}`,
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
    makeMockCommand(binDir, "vercel", "exit 1");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: join(tempDir, "missing-dir", "claude.env"),
      CLAUDE_PROJECT_ROOT: join(tempDir, "missing-project-root"),
      PATH: binDir,
      VERCEL_PLUGIN_LOG_LEVEL: "debug",
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
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
  test("exports installed skills from hashed project cache", async () => {
    const projectDir = join(tempDir, "installed-skills-project");
    const statePaths = resolveProjectStatePaths(projectDir, testHomeDir);
    mkdirSync(join(statePaths.skillsDir, "nextjs"), { recursive: true });
    writeFileSync(
      join(statePaths.skillsDir, "nextjs", "SKILL.md"),
      `---
name: nextjs
description: Next.js
summary: Next.js summary
metadata:
  priority: 7
  pathPatterns:
    - "app/**/*.tsx"
---
# Next.js
`,
      "utf-8",
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    // installedSkills should appear in profile cache
    const cachePath = profileCachePath(testSessionId);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSkills).toEqual(["nextjs"]);
  });

  test("omits VERCEL_PLUGIN_INSTALLED_SKILLS when no installed skills exist", async () => {
    const projectDir = join(tempDir, "no-installed-skills");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    // Profile cache should have empty installedSkills
    const cachePath = profileCachePath(testSessionId);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSkills).toEqual([]);
  });

  test("treats registrySlug lockfile entries as installed engine skills", async () => {
    const projectDir = join(tempDir, "registry-alias-installed");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");
    const statePaths = resolveProjectStatePaths(projectDir, testHomeDir);
    mkdirSync(statePaths.stateRoot, { recursive: true });
    writeFileSync(
      statePaths.lockfilePath,
      JSON.stringify({
        version: 1,
        skills: {
          "next-best-practices": { source: "vercel/vercel-skills" },
        },
      }),
      "utf-8",
    );
    // The profiler requires actual SKILL.md files on disk (not just lockfile
    // entries) to count a skill as installed. Create the file under the
    // registrySlug name — canonicalization maps it to the engine skill name.
    mkdirSync(join(statePaths.skillsDir, "next-best-practices"), { recursive: true });
    writeFileSync(
      join(statePaths.skillsDir, "next-best-practices", "SKILL.md"),
      "---\nname: next-best-practices\ndescription: Next.js\nsummary: Next.js\nmetadata:\n  priority: 7\n---\n# Next.js\n",
      "utf-8",
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    const cachePath = profileCachePath(testSessionId);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSkills).toContain("nextjs");
    expect(cache.installedSkills).not.toContain("next-best-practices");
  });

  test("install plan includes vercel-link action when .vercel dir is absent", async () => {
    const projectDir = join(tempDir, "no-vercel-link");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    const planPath = resolveProjectStatePaths(projectDir, testHomeDir).installPlanPath;
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(plan.vercelLinked).toBe(false);
    const linkAction = plan.actions.find((a: { id: string }) => a.id === "vercel-link");
    expect(linkAction).toBeDefined();
    expect(linkAction.command).toBe("vercel link --yes");
  });

  test("install plan omits vercel-link action when .vercel dir exists", async () => {
    const projectDir = join(tempDir, "vercel-linked");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".vercel"));
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    const planPath = resolveProjectStatePaths(projectDir, testHomeDir).installPlanPath;
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(plan.vercelLinked).toBe(true);
    const linkAction = plan.actions.find((a: { id: string }) => a.id === "vercel-link");
    expect(linkAction).toBeUndefined();
  });

  test("install plan shows env-pull command when linked and no .env.local", async () => {
    const projectDir = join(tempDir, "needs-env-pull");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".vercel"));
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    const planPath = resolveProjectStatePaths(projectDir, testHomeDir).installPlanPath;
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(plan.hasEnvLocal).toBe(false);
    const envPullAction = plan.actions.find((a: { id: string }) => a.id === "vercel-env-pull");
    expect(envPullAction).toBeDefined();
    expect(envPullAction.command).toBe("vercel env pull --yes");
  });

  test("install plan omits env-pull action when .env.local exists", async () => {
    const projectDir = join(tempDir, "has-env-local");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".vercel"));
    writeFileSync(join(projectDir, ".env.local"), "SECRET=foo");
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    });

    expect(result.code).toBe(0);

    const planPath = resolveProjectStatePaths(projectDir, testHomeDir).installPlanPath;
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(plan.hasEnvLocal).toBe(true);
    const envPullAction = plan.actions.find((a: { id: string }) => a.id === "vercel-env-pull");
    expect(envPullAction).toBeUndefined();
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
    expect(result.stdout).not.toContain("greenfield project");
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

describe("logBrokenEngineFrontmatterSummary (unit)", () => {
  test("emits one summary warning when an engine rule has malformed frontmatter", async () => {
    const { logBrokenEngineFrontmatterSummary } = await import("../hooks/session-start-profiler.mjs");
    const pluginDir = join(tempDir, "plugin-root");
    const engineDir = join(pluginDir, "engine");
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(
      join(engineDir, "broken-skill.md"),
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

    const message = logBrokenEngineFrontmatterSummary(pluginDir, logger as any);

    expect(message).toBe("WARNING: 1 engine rules have broken frontmatter: broken-skill");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].event).toBe("session-start-profiler:broken-engine-frontmatter");
    expect(summaries[0].data).toEqual({
      message: "WARNING: 1 engine rules have broken frontmatter: broken-skill",
      brokenEngineRuleCount: 1,
      brokenEngineRules: ["broken-skill"],
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

// ---------------------------------------------------------------------------
// autoPullProjectEnv
// ---------------------------------------------------------------------------

describe("autoPullProjectEnv", () => {
  test("runs env pull when linked and missing .env.local", async () => {
    process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL = "1";
    try {
      const { autoPullProjectEnv } = await import(
        "../hooks/src/session-start-profiler.mts"
      );
      const projectDir = join(tempDir, "auto-env-pull");
      mkdirSync(projectDir);
      mkdirSync(join(projectDir, ".vercel"));

      const result = await autoPullProjectEnv({
        projectRoot: projectDir,
        vercelLinked: true,
        hasEnvLocal: false,
        delegator: {
          async run() {
            writeFileSync(join(projectDir, ".env.local"), "TOKEN=1\n");
            return {
              ok: true,
              subcommand: "env-pull" as const,
              command: "vercel env pull --yes",
              stdout: "",
              stderr: "",
              changed: true,
            };
          },
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.command).toBe("vercel env pull --yes");
      expect(existsSync(join(projectDir, ".env.local"))).toBe(true);
    } finally {
      delete process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL;
    }
  });

  test("skips when project is not linked", async () => {
    process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL = "1";
    try {
      const { autoPullProjectEnv } = await import(
        "../hooks/src/session-start-profiler.mts"
      );

      const result = await autoPullProjectEnv({
        projectRoot: "/repo",
        vercelLinked: false,
        hasEnvLocal: false,
        delegator: {
          async run() {
            throw new Error("should not run");
          },
        },
      });

      expect(result).toBeNull();
    } finally {
      delete process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL;
    }
  });

  test("skips when .env.local already exists", async () => {
    process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL = "1";
    try {
      const { autoPullProjectEnv } = await import(
        "../hooks/src/session-start-profiler.mts"
      );

      const result = await autoPullProjectEnv({
        projectRoot: "/repo",
        vercelLinked: true,
        hasEnvLocal: true,
        delegator: {
          async run() {
            throw new Error("should not run");
          },
        },
      });

      expect(result).toBeNull();
    } finally {
      delete process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL;
    }
  });

  test("skips when env var is not set", async () => {
    delete process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL;

    const { autoPullProjectEnv } = await import(
      "../hooks/src/session-start-profiler.mts"
    );

    const result = await autoPullProjectEnv({
      projectRoot: "/repo",
      vercelLinked: true,
      hasEnvLocal: false,
      delegator: {
        async run() {
          throw new Error("should not run");
        },
      },
    });

    expect(result).toBeNull();
  });

  test("returns failed result on CLI error without throwing", async () => {
    process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL = "1";
    try {
      const { autoPullProjectEnv } = await import(
        "../hooks/src/session-start-profiler.mts"
      );

      const result = await autoPullProjectEnv({
        projectRoot: "/repo",
        vercelLinked: true,
        hasEnvLocal: false,
        delegator: {
          async run() {
            return {
              ok: false,
              subcommand: "env-pull" as const,
              command: "vercel env pull --yes",
              stdout: "",
              stderr: "Error: not authenticated",
              changed: false,
            };
          },
        },
      });

      expect(result?.ok).toBe(false);
      expect(result?.changed).toBe(false);
    } finally {
      delete process.env.VERCEL_PLUGIN_VERCEL_AUTO_ENV_PULL;
    }
  });
});

// ---------------------------------------------------------------------------
// shouldAutoInstall gating (unit)
// ---------------------------------------------------------------------------

describe("shouldAutoInstall (unit)", () => {
  test("returns true when VERCEL_PLUGIN_SKILL_AUTO_INSTALL=1", async () => {
    const { shouldAutoInstall } = await import("../hooks/session-start-profiler.mjs");
    const saved = process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
    try {
      process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL = "1";
      expect(shouldAutoInstall({ installedSkillCount: 5, missingSkillCount: 2 })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      else process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL = saved;
    }
  });

  test("returns true on first session (no cached skills)", async () => {
    const { shouldAutoInstall } = await import("../hooks/session-start-profiler.mjs");
    const saved = process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
    try {
      delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      expect(shouldAutoInstall({ installedSkillCount: 0, missingSkillCount: 3 })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      else process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL = saved;
    }
  });

  test("returns false when some skills cached and env var not set", async () => {
    const { shouldAutoInstall } = await import("../hooks/session-start-profiler.mjs");
    const saved = process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
    try {
      delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      expect(shouldAutoInstall({ installedSkillCount: 2, missingSkillCount: 3 })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      else process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL = saved;
    }
  });

  test("returns false when no missing skills", async () => {
    const { shouldAutoInstall } = await import("../hooks/session-start-profiler.mjs");
    const saved = process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
    try {
      delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      expect(shouldAutoInstall({ installedSkillCount: 0, missingSkillCount: 0 })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL;
      else process.env.VERCEL_PLUGIN_SKILL_AUTO_INSTALL = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// loadRegistryMap (unit)
// ---------------------------------------------------------------------------

describe("loadRegistryMap (unit)", () => {
  test("loads registry fields from generated manifest", async () => {
    const { loadRegistryMap } = await import("../hooks/session-start-profiler.mjs");
    const map = loadRegistryMap(ROOT);
    // Should have entries for skills with registry field in engine/*.md
    expect(map.size).toBeGreaterThan(0);
    expect(map.get("nextjs")).toBe("vercel/vercel-skills");
    expect(map.get("vercel-cli")).toBe("vercel-labs/agent-skills");
  });

  test("returns empty map for non-existent directory", async () => {
    const { loadRegistryMap } = await import("../hooks/session-start-profiler.mjs");
    const map = loadRegistryMap("/nonexistent/path");
    expect(map.size).toBe(0);
  });

  test("excludes skills without registry field", async () => {
    const { loadRegistryMap } = await import("../hooks/session-start-profiler.mjs");
    const map = loadRegistryMap(ROOT);
    // ai-gateway has no registry field
    expect(map.has("ai-gateway")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// autoInstallDetectedSkills registry filtering (unit)
// ---------------------------------------------------------------------------

describe("autoInstallDetectedSkills registry filtering (unit)", () => {
  test("skips non-registry skills and passes only registry-backed to installer", async () => {
    const { autoInstallDetectedSkills } = await import("../hooks/session-start-profiler.mjs");
    const registryMap = new Map([["nextjs", "vercel/vercel-skills"]]);

    const result = await autoInstallDetectedSkills({
      projectRoot: tempDir,
      missingSkills: ["nextjs", "custom-skill-no-registry"],
      registryMap,
      // No real CLI — the client will fail, but we test filtering not execution
      skillsSource: "test-source",
    });

    // custom-skill-no-registry should appear in missing since it was filtered out
    expect(result.missing).toContain("custom-skill-no-registry");
  });

  test("returns empty result when no missing skills have registry backing", async () => {
    const { autoInstallDetectedSkills } = await import("../hooks/session-start-profiler.mjs");
    const registryMap = new Map<string, string>();

    const result = await autoInstallDetectedSkills({
      projectRoot: tempDir,
      missingSkills: ["custom-a", "custom-b"],
      registryMap,
    });

    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual(["custom-a", "custom-b"]);
    expect(result.command).toBeNull();
  });

  test("groups installs by registry and maps registrySlug aliases", async () => {
    const projectRoot = join(tempDir, "grouped-install-project");
    mkdirSync(projectRoot, { recursive: true });
    const statePaths = resolveProjectStatePaths(projectRoot, testHomeDir);
    mkdirSync(statePaths.stateRoot, { recursive: true });

    const installCalls: Array<{
      source?: string;
      projectRoot: string;
      skillNames: string[];
      installTargets?: Array<{ requestedName: string; installName: string }>;
    }> = [];

    mock.module(resolve(ROOT, "hooks", "registry-client.mjs"), () => ({
      createRegistryClient: ({ source }: { source?: string }) => ({
        installSkills: async (args: {
          projectRoot: string;
          skillNames: string[];
          installTargets?: Array<{ requestedName: string; installName: string }>;
        }) => {
          installCalls.push({ source, ...args });
          const printable = [
            "npx",
            "skills",
            "add",
            source ?? "vercel/vercel-skills",
            ...((args.installTargets ?? []).flatMap((target) => ["--skill", target.installName])),
            "--agent",
            "claude-code",
            "-y",
            "--copy",
          ].join(" ");
          return {
            installed: args.skillNames,
            reused: [],
            missing: [],
            command: printable,
            commandCwd: statePaths.stateRoot,
          };
        },
      }),
    }));

    const { autoInstallDetectedSkills } = await import(
      `../hooks/session-start-profiler.mjs?grouped=${Date.now()}-${Math.random()}`
    );

    const result = await autoInstallDetectedSkills({
      projectRoot,
      missingSkills: ["nextjs", "vercel-cli"],
      registryMap: new Map([
        ["nextjs", "vercel/vercel-skills"],
        ["vercel-cli", "vercel-labs/agent-skills"],
      ]),
      registryMetadata: new Map([
        [
          "nextjs",
          { registry: "vercel/vercel-skills", registrySlug: "next-best-practices" },
        ],
        [
          "vercel-cli",
          { registry: "vercel-labs/agent-skills", registrySlug: "vercel-cli-with-tokens" },
        ],
      ]),
      logger: undefined,
    });

    expect(installCalls).toHaveLength(2);
    expect(installCalls).toEqual([
      {
        source: "vercel/vercel-skills",
        projectRoot,
        skillNames: ["nextjs"],
        installTargets: [
          { requestedName: "nextjs", installName: "next-best-practices" },
        ],
      },
      {
        source: "vercel-labs/agent-skills",
        projectRoot,
        skillNames: ["vercel-cli"],
        installTargets: [
          {
            requestedName: "vercel-cli",
            installName: "vercel-cli-with-tokens",
          },
        ],
      },
    ]);
    expect(result.command).toContain("vercel/vercel-skills");
    expect(result.command).toContain("vercel-labs/agent-skills");
    expect(result.command).toContain("next-best-practices");
    expect(result.command).toContain("vercel-cli-with-tokens");
  });
});
