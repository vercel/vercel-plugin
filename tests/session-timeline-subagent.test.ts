import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SESSION_START_SCRIPT = join(ROOT, "hooks", "session-start-seen-skills.mjs");
const ENGINE_DIR = join(ROOT, "engine");
const UNLIMITED_BUDGET = "999999";
let testSession: string;
let testHomeDir: string;

function seedProjectCache(homeDir: string): void {
  const paths = resolveProjectStatePaths(ROOT, homeDir);
  mkdirSync(paths.skillsDir, { recursive: true });

  for (const entry of readdirSync(ENGINE_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.replace(/\.md$/, "");
    const skillDir = join(paths.skillsDir, slug);
    mkdirSync(skillDir, { recursive: true });
    const content = readFileSync(join(ENGINE_DIR, entry), "utf-8");
    writeFileSync(join(skillDir, "SKILL.md"), content);
  }
}

beforeAll(() => {
  testHomeDir = join(
    tmpdir(),
    `vercel-plugin-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  seedProjectCache(testHomeDir);
});

beforeEach(() => {
  testSession = `timeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterAll(() => {
  rmSync(testHomeDir, { recursive: true, force: true });
});

async function runSessionStart(envFilePath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", SESSION_START_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_ENV_FILE: envFilePath },
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

async function runHookEnv(
  input: { tool_name: string; tool_input: Record<string, string> },
  env: Record<string, string | undefined>,
  opts?: { sessionId?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: opts?.sessionId ?? testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
    env: {
      ...process.env,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
      VERCEL_PLUGIN_DISABLE_BASE_TELEMETRY: "1",
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      ...env,
    },
  });

  proc.stdin.write(payload);
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

function parseInjectedSkills(stdout: string): string[] {
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  const injectedSkills = si.injectedSkills;

  if (!Array.isArray(injectedSkills)) {
    return [];
  }

  return injectedSkills.filter((skill): skill is string => typeof skill === "string");
}

function parseDebugLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { line };
      }
    });
}

describe("session timeline subagent integration", () => {
  test("session-start-seen-skills.mjs preserves CLAUDE_ENV_FILE contents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-timeline-lead-"));
    const leadEnvPath = join(tempDir, "lead.env");

    try {
      writeFileSync(leadEnvPath, "export SEEDED=1\n", "utf-8");

      const result = await runSessionStart(leadEnvPath);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const content = readFileSync(leadEnvPath, "utf-8");
      expect(content).toBe("export SEEDED=1\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("lead scaffold timeline dedups in the lead session but a fresh subagent gets its own nextjs injection", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-timeline-subagent-"));
    const leadEnvPath = join(tempDir, "lead.env");
    const subagentEnvPath = join(tempDir, "subagent.env");

    try {
      writeFileSync(leadEnvPath, "", "utf-8");
      writeFileSync(subagentEnvPath, "", "utf-8");

      const leadSessionStart = await runSessionStart(leadEnvPath);
      expect(leadSessionStart.code).toBe(0);

      const leadScaffold = await runHookEnv(
        { tool_name: "Bash", tool_input: { command: "npx create-next-app@latest notion-clone --ts --app" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      );

      expect(leadScaffold.code).toBe(0);
      expect(parseInjectedSkills(leadScaffold.stdout)).toContain("nextjs");

      const leadRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
      );

      expect(leadRead.code).toBe(0);
      const leadInjected = parseInjectedSkills(leadRead.stdout);
      expect(leadInjected).not.toContain("nextjs");
      expect(leadInjected).toContain("next-cache-components");

      const subagentSessionStart = await runSessionStart(subagentEnvPath);
      expect(subagentSessionStart.code).toBe(0);

      const subagentSession = `timeline-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const subagentRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
        { sessionId: subagentSession },
      );

      expect(subagentRead.code).toBe(0);
      expect(parseInjectedSkills(subagentRead.stdout)).toContain("nextjs");

      const debugLines = parseDebugLines(subagentRead.stderr);
      const dedupStrategyLine = debugLines.find((line) => line.event === "dedup-strategy");
      expect(dedupStrategyLine).toBeDefined();
      expect(dedupStrategyLine?.strategy).toBe("file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("subagent with isolated session re-injects skills that the lead already deduped via file claims", async () => {
    const tempDir2 = mkdtempSync(join(tmpdir(), "session-timeline-scope-"));
    const leadEnvPath = join(tempDir2, "lead.env");
    const subagentEnvPath = join(tempDir2, "subagent.env");

    try {
      writeFileSync(leadEnvPath, "", "utf-8");
      writeFileSync(subagentEnvPath, "", "utf-8");

      // Lead session start
      const leadSessionStart = await runSessionStart(leadEnvPath);
      expect(leadSessionStart.code).toBe(0);

      // Lead injects nextjs via page.tsx read
      const leadRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      );
      expect(leadRead.code).toBe(0);
      const leadInjected = parseInjectedSkills(leadRead.stdout);
      expect(leadInjected).toContain("nextjs");

      // Lead second read — deduped
      const leadSecond = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: leadInjected.join(",") },
      );
      expect(leadSecond.code).toBe(0);
      const leadSecondInjected = parseInjectedSkills(leadSecond.stdout);
      expect(leadSecondInjected).toEqual([]);

      // Subagent session start
      const subagentSessionStart = await runSessionStart(subagentEnvPath);
      expect(subagentSessionStart.code).toBe(0);

      // Subagent with different session ID — scope isolation means nextjs re-injects
      const subagentSession = `timeline-scope-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const subagentRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
        { sessionId: subagentSession },
      );
      expect(subagentRead.code).toBe(0);
      const subInjected = parseInjectedSkills(subagentRead.stdout);
      expect(subInjected).toContain("nextjs");

      // Verify it's a fresh file-based dedup scope
      const subDebug = parseDebugLines(subagentRead.stderr);
      const subDedup = subDebug.find((line) => line.event === "dedup-strategy");
      expect(subDedup).toBeDefined();
      expect(subDedup?.strategy).toBe("file");
    } finally {
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });
});
