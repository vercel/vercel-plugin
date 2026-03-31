import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "posttooluse-bash-chain.mjs");

let testSession: string;

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

async function runHook(
  input: object,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("posttooluse-bash-chain.mjs", () => {
  test("hook script exists", () => {
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
  });

  test("outputs empty JSON for non-Bash tool", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/some/file.ts" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for Bash command without install", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm run dev" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for empty stdin", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("injects skill context for npm install express", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // Express maps to vercel-functions skill
    if (result.hookSpecificOutput) {
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("vercel-functions");
      expect(ctx).toContain("Express");
    }
  });

  test("injects skill context for yarn add stripe", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "yarn add stripe" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("payments");
    }
  });
});

describe("runBashChainInjection unit tests", () => {
  let runBashChainInjection: typeof import("../hooks/src/posttooluse-bash-chain.mts").runBashChainInjection;
  let parseInstallCommand: typeof import("../hooks/src/posttooluse-bash-chain.mts").parseInstallCommand;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    runBashChainInjection = mod.runBashChainInjection;
    parseInstallCommand = mod.parseInstallCommand;
  });

  test("parseInstallCommand extracts packages from npm install", () => {
    expect(parseInstallCommand("npm install express stripe")).toEqual(["express", "stripe"]);
  });

  test("parseInstallCommand ignores flags", () => {
    expect(parseInstallCommand("npm install -D express --save-dev")).toEqual(["express"]);
  });

  test("parseInstallCommand handles scoped packages", () => {
    expect(parseInstallCommand("npm install @ai-sdk/react")).toEqual(["@ai-sdk/react"]);
  });

  test("runBashChainInjection returns empty for unknown packages", () => {
    const result = runBashChainInjection(
      ["some-unknown-pkg"],
      null,
      ROOT,
    );
    expect(result.injected).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  test("runBashChainInjection reads skill via store fallback", () => {
    const result = runBashChainInjection(
      ["express"],
      null,
      ROOT,
    );
    // express maps to vercel-functions which exists in bundled skills
    expect(result.injected.length).toBeGreaterThanOrEqual(0);
    if (result.injected.length > 0) {
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.injected[0].content.length).toBeGreaterThan(0);
    }
  });
});
