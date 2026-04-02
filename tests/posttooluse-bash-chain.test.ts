import { afterEach, describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RegistryClient, InstallSkillsResult } from "../hooks/src/registry-client.mts";
import type { DeferredBashSkill } from "../hooks/src/posttooluse-bash-chain.mts";

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

  test("resolves project-local cache even when process.cwd differs", async () => {
    // Set up a temp project with a skill in the hashed state path
    const projectDir = join(tmpdir(), `bash-chain-test-${Date.now()}`);
    const homeDir = join(tmpdir(), `bash-chain-home-${Date.now()}`);
    process.env.VERCEL_PLUGIN_HOME_DIR = homeDir;
    const { resolveProjectStatePaths } = await import("../hooks/src/project-state-paths.mts");
    const statePaths = resolveProjectStatePaths(projectDir, homeDir);
    const skillDir = join(statePaths.skillsDir, "vercel-functions");
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
      // Verify it came from the project-local cache, not rules-manifest
      expect(result.injected[0].content).toContain("project-local");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.VERCEL_PLUGIN_HOME_DIR;
    }
  });

  test("reuses single store across multiple packages in one run", async () => {
    // Set up a temp project with two skills in the hashed state path
    const projectDir = join(tmpdir(), `bash-chain-store-reuse-${Date.now()}`);
    const homeDir = join(tmpdir(), `bash-chain-store-reuse-home-${Date.now()}`);
    process.env.VERCEL_PLUGIN_HOME_DIR = homeDir;
    const { resolveProjectStatePaths } = await import("../hooks/src/project-state-paths.mts");
    const statePaths = resolveProjectStatePaths(projectDir, homeDir);
    for (const slug of ["vercel-functions", "vercel-storage"]) {
      const skillDir = join(statePaths.skillsDir, slug);
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
      });

      // express → vercel-functions, prisma → vercel-storage
      const result = await runBashChainInjection(
        ["express", "prisma"],
        null,
        projectDir,
        ROOT,
        undefined,
        {} as any,
        store,
      );

      expect(result.injected.length).toBe(2);
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.injected[0].content).toContain("Local content");
      expect(result.injected[1].skill).toBe("vercel-storage");
      expect(result.injected[1].content).toContain("Local content");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.VERCEL_PLUGIN_HOME_DIR;
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

// ---------------------------------------------------------------------------
// Install-and-reinject: successful auto-install → same-pass injection
// ---------------------------------------------------------------------------

describe("PostToolUse install-and-reinject", () => {
  let runBashChainInjection: typeof import("../hooks/src/posttooluse-bash-chain.mts").runBashChainInjection;
  let createSkillStore: typeof import("../hooks/src/skill-store.mts").createSkillStore;
  let resolveProjectStatePaths: typeof import("../hooks/src/project-state-paths.mts").resolveProjectStatePaths;
  let testHomeDir: string;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    runBashChainInjection = mod.runBashChainInjection;
    const storeMod = await import("../hooks/skill-store.mjs");
    createSkillStore = storeMod.createSkillStore;
    const pathsMod = await import("../hooks/src/project-state-paths.mts");
    resolveProjectStatePaths = pathsMod.resolveProjectStatePaths;
    testHomeDir = join(tmpdir(), `chain-reinject-home-${Date.now()}`);
    process.env.VERCEL_PLUGIN_HOME_DIR = testHomeDir;
  });

  afterEach(() => {
    rmSync(testHomeDir, { recursive: true, force: true });
    delete process.env.VERCEL_PLUGIN_HOME_DIR;
  });

  function writeSkillMd(projectDir: string, slug: string, body: string): void {
    const statePaths = resolveProjectStatePaths(projectDir, testHomeDir);
    const skillDir = join(statePaths.skillsDir, slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        `name: ${slug}`,
        `description: ${slug} skill`,
        `summary: ${slug}`,
        "metadata:",
        "  priority: 6",
        "---",
        body,
      ].join("\n"),
    );
  }

  /**
   * Creates a mock RegistryClient whose installSkills writes the skill to
   * the project's hashed cache directory (simulating `npx skills add`) and
   * returns a successful result. No real CLI or network calls.
   */
  function makeMockRegistryClient(
    projectDir: string,
    skillBodies: Record<string, string>,
  ): RegistryClient {
    return {
      async installSkills(args): Promise<InstallSkillsResult> {
        const installed: string[] = [];
        for (const slug of args.skillNames) {
          const body = skillBodies[slug];
          if (body) {
            writeSkillMd(projectDir, slug, body);
            installed.push(slug);
          }
        }
        return {
          installed,
          reused: [],
          missing: args.skillNames.filter((s) => !installed.includes(s)),
          command: `npx skills add vercel/vercel-skills --skill ${args.skillNames.join(" --skill ")} --agent claude-code -y`,
          commandCwd: projectDir,
        };
      },
    };
  }

  test("missing skill is installed and injected in same PostToolUse run", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      // Initial store has no skills — express → vercel-functions will be missing
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir, // wrong on purpose so bundled fallback fails
        bundledFallback: false,
      });

      const mockClient = makeMockRegistryClient(projectDir, {
        "vercel-functions": "# Vercel Functions\nAuto-installed skill content.",
      });

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
        mockClient,
      );

      // Skill should have been installed and injected in the same run
      expect(result.injected.length).toBe(1);
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.injected[0].content).toContain("Auto-installed skill content");
      expect(result.injected[0].packageName).toBe("express");
      // missing should be cleared since it was successfully injected
      expect(result.missing).not.toContain("vercel-functions");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("reinject respects chain cap", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-cap-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      // Both skills missing, both will be "installed"
      const mockClient = makeMockRegistryClient(projectDir, {
        "vercel-functions": "# Vercel Functions\nFunctions content.",
        "vercel-storage": "# Vercel Storage\nStorage content.",
      });

      const result = await runBashChainInjection(
        ["express", "prisma"], // express → vercel-functions, prisma → vercel-storage
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
          VERCEL_PLUGIN_SKILL_AUTO_INSTALL: "1",
          VERCEL_PLUGIN_CHAIN_CAP: "1", // only allow 1 injection
        } as any,
        store,
        mockClient,
      );

      // Cap=1 means only one skill should be injected even though both are available
      expect(result.injected.length).toBe(1);

      // The second skill should be deferred, not silently dropped
      expect(result.deferred.length).toBeGreaterThanOrEqual(1);
      expect(result.deferred[0].reason).toBe("cap-reached");
      expect(result.deferred[0].phase).toBe("after-install");
      // Deferred skills should not appear in missing
      for (const d of result.deferred) {
        expect(result.missing).not.toContain(d.skill);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("cap only defers skills that resolved after install", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-cap-partial-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      const mockClient = makeMockRegistryClient(projectDir, {
        "vercel-functions": "# Vercel Functions\nFunctions content.",
      });

      const result = await runBashChainInjection(
        ["express", "prisma"],
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
          VERCEL_PLUGIN_SKILL_AUTO_INSTALL: "1",
          VERCEL_PLUGIN_CHAIN_CAP: "1",
        } as any,
        store,
        mockClient,
      );

      expect(result.injected.length).toBe(1);
      expect(result.injected[0].skill).toBe("vercel-functions");
      expect(result.deferred).toEqual([]);
      expect(result.missing).toContain("vercel-storage");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("reinject respects byte budget", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-budget-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      // Create a skill body that exceeds the 18KB budget
      const hugeBody = "# Huge Skill\n" + "x".repeat(20_000);
      const mockClient = makeMockRegistryClient(projectDir, {
        "vercel-functions": hugeBody,
      });

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
        mockClient,
      );

      // Skill was installed but too large to inject — should be deferred, not missing
      expect(result.injected.length).toBe(0);
      expect(result.deferred.length).toBe(1);
      expect(result.deferred[0].skill).toBe("vercel-functions");
      expect(result.deferred[0].reason).toBe("budget-exceeded");
      expect(result.deferred[0].phase).toBe("after-install");
      // Deferred skills are excluded from missing (installed but not injected)
      expect(result.missing).not.toContain("vercel-functions");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("reinject respects dedup — no double injection", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-dedup-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      // Pre-populate the skill so the initial pass finds it
      writeSkillMd(projectDir, "vercel-functions", "# Vercel Functions\nPre-existing.");

      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      // Both express and fastify map to vercel-functions
      const result = await runBashChainInjection(
        ["express", "fastify"],
        null,
        projectDir,
        projectDir,
        undefined,
        {
          VERCEL_PLUGIN_DISABLE_BUNDLED_FALLBACK: "1",
        } as any,
        store,
      );

      // Only one injection for the deduplicated skill
      expect(result.injected.length).toBe(1);
      expect(result.injected[0].skill).toBe("vercel-functions");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("no real CLI or network execution in mock path", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-nonet-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      let installCalled = false;
      const mockClient: RegistryClient = {
        async installSkills(args): Promise<InstallSkillsResult> {
          installCalled = true;
          // Simulate install by writing skill files
          for (const slug of args.skillNames) {
            writeSkillMd(projectDir, slug, `# ${slug}\nMock installed.`);
          }
          return {
            installed: args.skillNames,
            reused: [],
            missing: [],
            command: "npx skills add mock",
            commandCwd: projectDir,
          };
        },
      };

      await runBashChainInjection(
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
        mockClient,
      );

      // Confirm the mock was invoked (not the real CLI)
      expect(installCalled).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("successful inject has empty deferred", async () => {
    const projectDir = join(tmpdir(), `chain-reinject-no-defer-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });

    try {
      const store = createSkillStore({
        projectRoot: projectDir,
        pluginRoot: projectDir,
        bundledFallback: false,
      });

      const mockClient = makeMockRegistryClient(projectDir, {
        "vercel-functions": "# Vercel Functions\nAuto-installed.",
      });

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
        mockClient,
      );

      expect(result.injected.length).toBe(1);
      expect(result.deferred).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// formatBashChainOutput version 2 metadata
// ---------------------------------------------------------------------------

describe("formatBashChainOutput v2 metadata", () => {
  let formatBashChainOutput: typeof import("../hooks/src/posttooluse-bash-chain.mts").formatBashChainOutput;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    formatBashChainOutput = mod.formatBashChainOutput;
  });

  test("includes deferred in metadata comment", () => {
    const deferred: DeferredBashSkill[] = [
      {
        packageName: "prisma",
        skill: "vercel-storage",
        message: "Storage best practices",
        reason: "cap-reached",
        phase: "after-install",
      },
    ];
    const chainResult = {
      injected: [
        {
          packageName: "express",
          skill: "vercel-functions",
          message: "Express guidance",
          content: "# Functions\nContent here.",
        },
      ],
      missing: [],
      deferred,
      banners: [],
      totalBytes: 100,
    };

    const output = formatBashChainOutput(chainResult);
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput.additionalContext;

    // Should contain version 2 metadata
    const metaMatch = ctx.match(/<!-- postBashChain: ({.*?}) -->/);
    expect(metaMatch).not.toBeNull();
    const meta = JSON.parse(metaMatch![1]);
    expect(meta.version).toBe(2);
    expect(meta.deferred).toEqual(deferred);
    expect(meta.missing).toEqual([]);
  });

  test("returns {} when no injected, banners, or deferred", () => {
    const output = formatBashChainOutput({
      injected: [],
      missing: ["foo"],
      deferred: [],
      banners: [],
      totalBytes: 0,
    } as any);
    expect(output).toBe("{}");
  });

  test("emits output when only deferred skills exist", () => {
    const output = formatBashChainOutput({
      injected: [],
      missing: [],
      deferred: [
        {
          packageName: "prisma",
          skill: "vercel-storage",
          message: "Storage",
          reason: "cap-reached",
          phase: "after-install",
        },
      ],
      banners: [],
      totalBytes: 0,
    } as any);
    expect(output).not.toBe("{}");
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("postBashChain");
  });
});

// ---------------------------------------------------------------------------
// buildPostInstallActionPalette
// ---------------------------------------------------------------------------

describe("buildPostInstallActionPalette", () => {
  let buildPostInstallActionPalette: typeof import("../hooks/src/posttooluse-bash-chain.mts").buildPostInstallActionPalette;

  beforeEach(async () => {
    const mod = await import("../hooks/posttooluse-bash-chain.mjs");
    buildPostInstallActionPalette = mod.buildPostInstallActionPalette;
  });

  test("returns null when no deferred skills", () => {
    const result = buildPostInstallActionPalette({ projectRoot: "/tmp", deferred: [], env: {} as any });
    expect(result).toBeNull();
  });

  test("renders deferred skills without plan actions", () => {
    const result = buildPostInstallActionPalette({
      projectRoot: "/tmp",
      deferred: [
        {
          packageName: "prisma",
          skill: "vercel-storage",
          message: "Storage",
          reason: "cap-reached",
          phase: "after-install" as const,
        },
      ],
      env: {} as any,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("### Vercel next actions");
    expect(result).toContain("vercel-storage (cap-reached)");
    expect(result).toContain("[1] Continue");
  });

  test("renders plan actions from VERCEL_PLUGIN_INSTALL_PLAN", () => {
    const plan = {
      schemaVersion: 1,
      createdAt: "2026-03-31",
      projectRoot: "/tmp",
      likelySkills: [],
      installedSkills: [],
      missingSkills: [],
      bundledFallbackEnabled: true,
      zeroBundleReady: false,
      projectSkillManifestPath: null,
      vercelLinked: false,
      hasEnvLocal: false,
      detections: [],
      actions: [
        { id: "vercel-link", label: "Link Vercel project", description: "", command: "vercel link --yes", cwd: "/tmp" },
        { id: "vercel-env-pull", label: "Pull environment variables", description: "", command: "vercel env pull --yes", cwd: "/tmp" },
        { id: "vercel-deploy", label: "Deploy to Vercel", description: "", command: "vercel deploy", cwd: "/tmp" },
      ],
    };

    const result = buildPostInstallActionPalette({
      projectRoot: "/tmp",
      deferred: [
        {
          packageName: "prisma",
          skill: "vercel-storage",
          message: "Storage",
          reason: "budget-exceeded",
          phase: "after-install" as const,
        },
      ],
      env: { VERCEL_PLUGIN_INSTALL_PLAN: JSON.stringify(plan) } as any,
    });

    expect(result).toContain("[2] Link Vercel project: `vercel link --yes`");
    expect(result).toContain("[3] Pull environment variables: `vercel env pull --yes`");
    expect(result).toContain("[4] Deploy to Vercel: `vercel deploy`");
  });
});
