import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSessionFile } from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILER = join(ROOT, "hooks", "session-start-profiler.mjs");
const NODE_BIN = Bun.which("node") || "node";

let tempDir: string;
let envFile: string;
let testSessionId: string;

async function runProfiler(projectRoot: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([NODE_BIN, PROFILER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectRoot,
    },
  });

  proc.stdin.write(JSON.stringify({ session_id: testSessionId }));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "session-start-activation-"));
  envFile = join(tempDir, "claude.env");
  writeFileSync(envFile, "", "utf-8");
  testSessionId = `session-start-activation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session-start activation", () => {
  test("greenfield directories still activate", async () => {
    const projectDir = join(tempDir, "greenfield");
    mkdirSync(projectDir);

    const result = await runProfiler(projectDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("greenfield project");
    expect(readSessionFile(testSessionId, "greenfield")).toBe("true");
    expect(readSessionFile(testSessionId, "likely-skills")).toContain("nextjs");
  });

  test("non-empty unrelated directories skip activation", async () => {
    const projectDir = join(tempDir, "plain-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Plain project");

    const result = await runProfiler(projectDir);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(readFileSync(envFile, "utf-8")).toBe("");
    expect(readSessionFile(testSessionId, "greenfield")).toBe("");
    expect(readSessionFile(testSessionId, "likely-skills")).toBe("");
  });

  test("detected vercel projects still activate", async () => {
    const projectDir = join(tempDir, "next-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const result = await runProfiler(projectDir);

    expect(result.code).toBe(0);
    expect(readSessionFile(testSessionId, "likely-skills")).toContain("nextjs");
  });

  test("package.json vercel signals are enough to activate", async () => {
    const projectDir = join(tempDir, "pkg-signals");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@vercel/blob": "^1.0.0",
        },
      }),
    );

    const result = await runProfiler(projectDir);

    expect(result.code).toBe(0);
    expect(readSessionFile(testSessionId, "likely-skills")).toContain("vercel-storage");
  });
});
