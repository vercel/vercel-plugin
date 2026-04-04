import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistryClient,
} from "../hooks/src/registry-client.mts";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const TMP = join(tmpdir(), `vercel-plugin-registry-client-${Date.now()}`);
const TEST_HOME = join(tmpdir(), `vercel-plugin-registry-home-${Date.now()}`);

function projectState(projectRoot: string) {
  return resolveProjectStatePaths(projectRoot, TEST_HOME);
}

function ensureStateRoot(projectRoot: string) {
  const state = projectState(projectRoot);
  mkdirSync(state.stateRoot, { recursive: true });
  return state;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
  process.env.VERCEL_PLUGIN_HOME_DIR = TEST_HOME;
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.VERCEL_PLUGIN_HOME_DIR;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ExecCall = { file: string; args: string[]; cwd?: string };

function mockExecFile(
  sideEffect?: (call: ExecCall) => void,
): {
  calls: ExecCall[];
  impl: (
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
} {
  const calls: ExecCall[] = [];
  return {
    calls,
    impl: async (file, args, options) => {
      const call = { file, args, cwd: options.cwd };
      calls.push(call);
      sideEffect?.(call);
      return { stdout: "", stderr: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// installSkills — CLI delegation
// ---------------------------------------------------------------------------

describe("installSkills", () => {
  test("delegates to npx skills add and infers installed skills from .skills", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      // Simulate CLI writing a skill
      mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
      writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    expect(exec.calls).toEqual([
      {
        file: process.platform === "win32" ? "npx.cmd" : "npx",
        args: [
          "skills", "add", "my-org/skills",
          "--skill", "nextjs",
          "--agent", "claude-code",
          "-y", "--copy",
        ],
        cwd: PROJECT,
      },
    ]);
    expect(result.installed).toEqual(["nextjs"]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.command).toContain("npx skills add my-org/skills --skill nextjs");
  });

  test("installs multiple skills with sorted --skill flags", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      for (const skill of ["ai-sdk", "nextjs"]) {
        mkdirSync(join(state.skillsDir, skill), { recursive: true });
        writeFileSync(join(state.skillsDir, skill, "SKILL.md"), `# ${skill}`, "utf-8");
      }
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs", "ai-sdk"],
    });

    // Skills in args should be sorted
    expect(exec.calls[0].args).toContain("ai-sdk");
    const aiIdx = exec.calls[0].args.indexOf("ai-sdk");
    const nextIdx = exec.calls[0].args.indexOf("nextjs");
    expect(aiIdx).toBeLessThan(nextIdx);

    expect(result.installed).toEqual(["ai-sdk", "nextjs"]);
    expect(result.missing).toEqual([]);
  });

  test("reports reused when skills already exist before CLI call", async () => {
    const PROJECT = join(TMP, "project");
    const state = ensureStateRoot(PROJECT);
    // Pre-seed existing skill
    mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
    writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");

    const exec = mockExecFile(); // CLI is a no-op

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual(["nextjs"]);
    expect(result.missing).toEqual([]);
  });

  test("reports missing when CLI fails to produce skill directory", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    ensureStateRoot(PROJECT);

    const exec = mockExecFile(); // CLI produces nothing

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nonexistent"],
    });

    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual(["nonexistent"]);
  });

  test("reports missing when CLI throws (subprocess error)", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    ensureStateRoot(PROJECT);

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: async () => {
        throw new Error("subprocess timeout");
      },
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    // Still infers from filesystem — no skill appeared
    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(["nextjs"]);
  });

  test("deduplicates skill names", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
      writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs", "nextjs", "nextjs"],
    });

    // Only one CLI call, skill appears once in args
    expect(exec.calls.length).toBe(1);
    const skillFlags = exec.calls[0].args.filter((a) => a === "nextjs");
    expect(skillFlags.length).toBe(1);
    expect(result.installed).toEqual(["nextjs"]);
  });

  test("returns null command for empty skill names", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    ensureStateRoot(PROJECT);

    const exec = mockExecFile();

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: [],
    });

    expect(exec.calls.length).toBe(0);
    expect(result.command).toBeNull();
  });

  test("uses default source when none provided", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
      writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
    });

    const client = createRegistryClient({
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    expect(exec.calls[0].args[2]).toBe("vercel/vercel-skills");
    expect(result.command).toContain("vercel/vercel-skills");
  });

  test("recognises installed skills from skills-lock.json when SKILL.md exists on disk", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      // CLI writes lockfile and materialises SKILL.md
      mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
      writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
      writeFileSync(
        state.lockfilePath,
        JSON.stringify({
          version: 1,
          skills: { nextjs: { source: "vercel/vercel-skills" } },
        }),
        "utf-8",
      );
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    expect(result.installed).toEqual(["nextjs"]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  test("lockfile-only entry without SKILL.md on disk is reported as missing", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      // CLI writes lockfile but has NOT materialised .skills/nextjs/SKILL.md
      writeFileSync(
        state.lockfilePath,
        JSON.stringify({
          version: 1,
          skills: { nextjs: { source: "vercel/vercel-skills" } },
        }),
        "utf-8",
      );
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    // No SKILL.md on disk — stale lockfile entries don't count as installed
    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual(["nextjs"]);
  });

  test("reports reused from lockfile when skill exists on disk before CLI call", async () => {
    const PROJECT = join(TMP, "project");
    const state = ensureStateRoot(PROJECT);
    // Pre-seed lockfile and SKILL.md with skill already present
    mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
    writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
    writeFileSync(
      state.lockfilePath,
      JSON.stringify({
        version: 1,
        skills: { nextjs: { source: "vercel/vercel-skills" } },
      }),
      "utf-8",
    );

    const exec = mockExecFile(); // CLI is a no-op

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
    });

    expect(result.installed).toEqual([]);
    expect(result.reused).toEqual(["nextjs"]);
    expect(result.missing).toEqual([]);
  });

  test("lockfile-only install with partial directory state", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      // CLI writes lockfile with two skills but only one directory
      mkdirSync(join(state.skillsDir, "nextjs"), { recursive: true });
      writeFileSync(join(state.skillsDir, "nextjs", "SKILL.md"), "# Next.js", "utf-8");
      writeFileSync(
        state.lockfilePath,
        JSON.stringify({
          version: 1,
          skills: {
            nextjs: { source: "vercel/vercel-skills" },
            "ai-sdk": { source: "vercel/vercel-skills" },
          },
        }),
        "utf-8",
      );
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs", "ai-sdk"],
    });

    // Only nextjs has SKILL.md on disk; ai-sdk is lockfile-only → missing
    expect(result.installed).toEqual(["nextjs"]);
    expect(result.missing).toEqual(["ai-sdk"]);
  });

  test("mixed install/reused/missing results", async () => {
    const PROJECT = join(TMP, "project");
    const state = ensureStateRoot(PROJECT);
    // Pre-seed one existing skill
    mkdirSync(join(state.skillsDir, "existing"), { recursive: true });
    writeFileSync(join(state.skillsDir, "existing", "SKILL.md"), "# Existing", "utf-8");

    const exec = mockExecFile(() => {
      // CLI installs one new skill, doesn't produce "broken"
      mkdirSync(join(state.skillsDir, "new-skill"), { recursive: true });
      writeFileSync(join(state.skillsDir, "new-skill", "SKILL.md"), "# New", "utf-8");
    });

    const client = createRegistryClient({
      source: "my-org/skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["new-skill", "existing", "broken"],
    });

    expect(result.installed).toEqual(["new-skill"]);
    expect(result.reused).toEqual(["existing"]);
    expect(result.missing).toEqual(["broken"]);
  });

  test("maps registrySlug installs back to engine slugs", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    const state = ensureStateRoot(PROJECT);

    const exec = mockExecFile(() => {
      // CLI installs under registry slug and writes lockfile + SKILL.md
      mkdirSync(join(state.skillsDir, "next-best-practices"), { recursive: true });
      writeFileSync(join(state.skillsDir, "next-best-practices", "SKILL.md"), "# Next.js", "utf-8");
      writeFileSync(
        state.lockfilePath,
        JSON.stringify({
          version: 1,
          skills: {
            "next-best-practices": { source: "vercel/vercel-skills" },
          },
        }),
        "utf-8",
      );
    });

    const client = createRegistryClient({
      source: "vercel/vercel-skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["nextjs"],
      installTargets: [{ requestedName: "nextjs", installName: "next-best-practices" }],
    });

    expect(exec.calls[0]?.args).toEqual([
      "skills", "add", "vercel/vercel-skills",
      "--skill", "next-best-practices",
      "--agent", "claude-code",
      "-y", "--copy",
    ]);
    expect(result.installed).toEqual(["nextjs"]);
    expect(result.reused).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  test("does not send skills from a different registry source in the same command", async () => {
    const PROJECT = join(TMP, "project");
    mkdirSync(PROJECT, { recursive: true });
    ensureStateRoot(PROJECT);

    const exec = mockExecFile();
    const client = createRegistryClient({
      source: "vercel/vercel-skills",
      execFileImpl: exec.impl,
    });

    const result = await client.installSkills({
      projectRoot: PROJECT,
      skillNames: ["ai-sdk", "vercel-cli"],
      installTargets: [
        { requestedName: "ai-sdk", installName: "ai-sdk" },
      ],
    });

    expect(exec.calls[0]?.args).toEqual([
      "skills", "add", "vercel/vercel-skills",
      "--skill", "ai-sdk",
      "--agent", "claude-code",
      "-y", "--copy",
    ]);
    expect(result.missing).toEqual(["ai-sdk"]);
  });
});
