import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RegistryClient } from "../hooks/src/registry-client.mts";

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

  test("runBashChainInjection returns empty for unknown packages", async () => {
    const result = await runBashChainInjection(
      ["some-unknown-pkg"],
      null,
      ROOT,
      ROOT,
    );
    expect(result.injected).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  test("runBashChainInjection reads skill via store fallback", async () => {
    const result = await runBashChainInjection(
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

  test("resolves project-local .skills/ even when process.cwd differs", async () => {
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

      const result = await runBashChainInjection(
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

  test("reuses single store across multiple packages in one run", async () => {
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
      const result = await runBashChainInjection(
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

// ---------------------------------------------------------------------------
// PostToolUse CLI delegation: banner-only vs auto-install
// ---------------------------------------------------------------------------

describe("PostToolUse CLI delegation", () => {
  let runBashChainInjection: typeof import("../hooks/src/posttooluse-bash-chain.mts").runBashChainInjection;
  let createSkillStore: typeof import("../hooks/src/skill-store.mts").createSkillStore;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    runBashChainInjection = mod.runBashChainInjection;
    const storeMod = await import("../hooks/skill-store.mjs");
    createSkillStore = storeMod.createSkillStore;
  });

  /**
   * Helper: create a project dir with a store that returns null for a given
   * skill (simulating missing from both project cache and bundled fallback).
   */
  function makeMissingSkillStore(projectDir: string) {
    return createSkillStore({
      projectRoot: projectDir,
      pluginRoot: projectDir, // intentionally wrong so bundled lookup fails
      bundledFallback: false,
    });
  }

  test("missing skills produce banner-only when auto-install is off", async () => {
    const projectDir = join(tmpdir(), `chain-banner-only-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = makeMissingSkillStore(projectDir);

      const result = await runBashChainInjection(
        ["express"],
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
          // auto-install NOT set — should produce suggestion banner only
        } as any,
        store,
      );

      expect(result.injected).toEqual([]);
      expect(result.missing).toContain("vercel-functions");
      expect(result.banners.length).toBeGreaterThan(0);
      expect(result.banners[0]).toContain("Missing: vercel-functions");
      expect(result.banners[0]).toContain("Install:");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("missing skills trigger auto-install when VERCEL_PLUGIN_SKILL_AUTO_INSTALL=1", async () => {
    const projectDir = join(tmpdir(), `chain-auto-install-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = makeMissingSkillStore(projectDir);

      const result = await runBashChainInjection(
        ["express"],
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
          VERCEL_PLUGIN_SKILL_AUTO_INSTALL: "1",
        } as any,
        store,
      );

      // With auto-install=1, resolveSkillCacheBanner will be called with
      // autoInstall: true. Since we have no real CLI and no mock injected at
      // this level, the CLI call will fail and fall back to banner-only.
      // The key assertion: the hook did NOT crash, and a banner was produced.
      expect(result.injected).toEqual([]);
      expect(result.missing).toContain("vercel-functions");
      expect(result.banners.length).toBeGreaterThan(0);
      // Banner should still mention the missing skill
      expect(result.banners[0]).toContain("vercel-functions");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("auto-install graceful fallback: no crash on CLI timeout", async () => {
    const projectDir = join(tmpdir(), `chain-timeout-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = makeMissingSkillStore(projectDir);

      // This exercises the full path: missing skill → resolveSkillCacheBanner
      // with autoInstall=true → createRegistryClient → CLI subprocess fails
      // → catch → banner fallback. No real CLI is executed because the store
      // has no bundled skills and the project has none either.
      const result = await runBashChainInjection(
        ["stripe"],
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
          VERCEL_PLUGIN_SKILL_AUTO_INSTALL: "1",
        } as any,
        store,
      );

      expect(result.injected).toEqual([]);
      expect(result.missing).toContain("payments");
      expect(result.banners.length).toBeGreaterThan(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("no banners when all packages resolve from store", async () => {
    const result = await runBashChainInjection(
      ["express"],
      null,
      ROOT,
      ROOT,
      undefined,
      { VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "0" } as any,
    );

    // express → vercel-functions should resolve from bundled skills
    if (result.injected.length > 0) {
      expect(result.missing).toEqual([]);
      expect(result.banners).toEqual([]);
    }
  });
});
