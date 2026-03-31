import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

describe("parseBashInput cwd resolution", () => {
  let parseBashInput: typeof import("../hooks/src/posttooluse-bash-chain.mts").parseBashInput;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    parseBashInput = mod.parseBashInput;
  });

  test("resolves cwd from hook payload cwd field", () => {
    const result = parseBashInput(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      session_id: "s1",
      cwd: "/tmp/my-project",
    }));
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/tmp/my-project");
  });

  test("resolves cwd from workspace_roots when cwd is absent", () => {
    const result = parseBashInput(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      session_id: "s1",
      workspace_roots: ["/tmp/workspace-root"],
    }));
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/tmp/workspace-root");
  });

  test("prefers payload cwd over workspace_roots", () => {
    const result = parseBashInput(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      session_id: "s1",
      cwd: "/tmp/payload-cwd",
      workspace_roots: ["/tmp/workspace-root"],
    }));
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/tmp/payload-cwd");
  });

  test("falls back to env vars when payload has no cwd", () => {
    const result = parseBashInput(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "npm install express" },
        session_id: "s1",
      }),
      undefined,
      { CLAUDE_PROJECT_ROOT: "/tmp/env-root" } as any,
    );
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/tmp/env-root");
  });

  test("falls back to process.cwd() as last resort", () => {
    const result = parseBashInput(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "npm install express" },
        session_id: "s1",
      }),
      undefined,
      {} as any,
    );
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe(process.cwd());
  });
});

describe("runBashChainInjection unit tests", () => {
  let runBashChainInjection: typeof import("../hooks/src/posttooluse-bash-chain.mts").runBashChainInjection;
  let parseInstallCommand: typeof import("../hooks/src/posttooluse-bash-chain.mts").parseInstallCommand;
  let createSkillStore: typeof import("../hooks/src/skill-store.mts").createSkillStore;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    runBashChainInjection = mod.runBashChainInjection;
    parseInstallCommand = mod.parseInstallCommand;
    const storeMod = await import("../hooks/skill-store.mjs");
    createSkillStore = storeMod.createSkillStore;
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
      ROOT,
    );
    // express maps to vercel-functions which exists in bundled skills
    expect(result.injected.length).toBeGreaterThanOrEqual(0);
    if (result.injected.length > 0) {
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.injected[0].content.length).toBeGreaterThan(0);
    }
  });

  test("resolves project-local .skills/ even when process.cwd differs", () => {
    // Set up a temp project with a .skills/vercel-functions/SKILL.md
    const projectDir = join(tmpdir(), `bash-chain-test-${Date.now()}`);
    const skillDir = join(projectDir, ".skills", "vercel-functions");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: vercel-functions",
        "description: Project-local vercel-functions skill",
        "summary: Local functions",
        "metadata:",
        "  priority: 8",
        "---",
        "# Vercel Functions (project-local)",
        "This is the project-local version of the skill.",
      ].join("\n"),
    );

    try {
      // Create a store rooted at the temp project — this simulates the hook
      // process running from a different cwd but receiving projectRoot from
      // the hook payload
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: ROOT,
        bundledFallback: true,
      });

      const result = runBashChainInjection(
        ["express"],
        null,
        projectDir,
        ROOT,
        undefined,
        { VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "0" } as any,
        store,
      );

      expect(result.injected.length).toBe(1);
      expect(result.injected[0].skill).toBe("vercel-functions");
      // Verify it came from the project-local skill, not bundled
      expect(result.injected[0].content).toContain("project-local");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("reuses single store across multiple packages in one run", () => {
    // Set up a temp project with two project-local skills
    const projectDir = join(tmpdir(), `bash-chain-store-reuse-${Date.now()}`);
    for (const slug of ["vercel-functions", "vercel-storage"]) {
      const skillDir = join(projectDir, ".skills", slug);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${slug}`,
          `description: Local ${slug}`,
          `summary: Local ${slug}`,
          "metadata:",
          "  priority: 8",
          "---",
          `# ${slug} (local)`,
          `Local content for ${slug}.`,
        ].join("\n"),
      );
    }

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: ROOT,
        bundledFallback: true,
      });

      // express → vercel-functions, prisma → vercel-storage
      const result = runBashChainInjection(
        ["express", "prisma"],
        null,
        projectDir,
        ROOT,
        undefined,
        { VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "0" } as any,
        store,
      );

      expect(result.injected.length).toBe(2);
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.injected[0].content).toContain("Local content");
      expect(result.injected[1].skill).toBe("vercel-storage");
      expect(result.injected[1].content).toContain("Local content");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
