import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const ENGINE_DIR = join(ROOT, "engine");
const UNLIMITED_BUDGET = "999999";
let testSession: string;
let testHomeDir: string;

const EXPECTED_SLACK_ROUTE_SKILLS = ["chat-sdk", "vercel-functions", "next-cache-components"] as const;

function seedSeenSkills(skills: string[], session?: string): void {
  const sid = session ?? testSession;
  writeFileSync(join(tmpdir(), `vercel-plugin-${sid}-seen-skills.txt`), skills.join(","), "utf-8");
}

function cleanupSessionDedup(session?: string): void {
  const prefix = `vercel-plugin-${session ?? testSession}-`;
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith(prefix)) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  } catch {}
}

function createTempHomeDir(prefix = "vercel-plugin-home"): string {
  return join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function seedProjectCache(homeDir: string, projectRoot: string, engineDir: string): void {
  const statePaths = resolveProjectStatePaths(projectRoot, homeDir);
  mkdirSync(statePaths.skillsDir, { recursive: true });

  for (const entry of readdirSync(engineDir)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.replace(/\.md$/, "");
    const skillDir = join(statePaths.skillsDir, slug);
    mkdirSync(skillDir, { recursive: true });
    const content = readFileSync(join(engineDir, entry), "utf-8");
    writeFileSync(join(skillDir, "SKILL.md"), content);
  }
}

beforeAll(() => {
  testHomeDir = createTempHomeDir();
  seedProjectCache(testHomeDir, ROOT, ENGINE_DIR);
});

beforeEach(() => {
  testSession = `subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterAll(() => {
  rmSync(testHomeDir, { recursive: true, force: true });
});

afterEach(() => {
  cleanupSessionDedup();
});

async function runHookEnv(
  input: { tool_name: string; tool_input: Record<string, string> },
  env: Record<string, string | undefined>,
  opts?: { omitSessionId?: boolean; omitSeenSkillsEnv?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = opts?.omitSessionId
    ? JSON.stringify(input)
    : JSON.stringify({ ...input, session_id: testSession });
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    VERCEL_PLUGIN_HOME_DIR: testHomeDir,
    VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
    ...env,
  };
  delete childEnv.VERCEL_PLUGIN_SEEN_SKILLS;
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
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
  return Array.isArray(injectedSkills) ? injectedSkills : [];
}

function parseMatchedSkills(stdout: string): string[] {
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  const matchedSkills = si.matchedSkills;
  return Array.isArray(matchedSkills) ? matchedSkills : [];
}

function parseDebugLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("subagent fresh env dedup behavior", () => {
  const slackRoutePath = "/Users/me/slack-clone/app/api/slack/route.ts";

  test("fresh subagent without inherited seen-skills re-injects the same skills as the lead agent", async () => {
    // Lead agent injects skills
    const { code: leadCode, stdout: leadStdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );

    expect(leadCode).toBe(0);
    const leadInjected = parseInjectedSkills(leadStdout);
    expect(leadInjected).toEqual(EXPECTED_SLACK_ROUTE_SKILLS);

    // Second call with file-based dedup — should be deduped
    seedSeenSkills(parseMatchedSkills(leadStdout));
    const { code: leadSecondCode, stdout: leadSecondStdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      {},
    );

    expect(leadSecondCode).toBe(0);
    expect(JSON.parse(leadSecondStdout)).toEqual({});

    // Fresh subagent with a new session — no dedup state — re-injects
    const leadSession = testSession;
    const subagentSession = `subagent-child-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testSession = subagentSession;
    let subagentResult: { code: number; stdout: string; stderr: string };
    try {
      subagentResult = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
        { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      );
    } finally {
      cleanupSessionDedup(subagentSession);
      testSession = leadSession;
    }

    expect(subagentResult.code).toBe(0);
    expect(parseInjectedSkills(subagentResult.stdout)).toEqual(EXPECTED_SLACK_ROUTE_SKILLS);

    const subagentDebugLines = parseDebugLines(subagentResult.stderr);
    const dedupStrategy = subagentDebugLines.find((line) => line.event === "dedup-strategy");
    expect(dedupStrategy).toBeDefined();
    expect(dedupStrategy?.strategy).toBe("file");
  });

  test("fresh subagent uses file strategy and injects skills", async () => {
    const { code, stdout, stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );

    expect(code).toBe(0);
    expect(parseInjectedSkills(stdout)).toEqual(EXPECTED_SLACK_ROUTE_SKILLS);

    const debugLines = parseDebugLines(stderr);
    const dedupStrategy = debugLines.find((line) => line.event === "dedup-strategy");
    expect(dedupStrategy).toBeDefined();
    expect(dedupStrategy?.strategy).toBe("file");
  });

  test("subagent that inherits the lead seen-skills via file dedup is deduped", async () => {
    const { stdout: leadStdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      {},
    );
    seedSeenSkills(parseMatchedSkills(leadStdout));
    const { code, stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      {},
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("subagent with agent_id uses isolated scope so parent dedup does not suppress it", async () => {
    // Lead agent injects skills first
    const { code: leadCode, stdout: leadStdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
      {},
    );
    expect(leadCode).toBe(0);
    const leadInjected = parseInjectedSkills(leadStdout);
    expect(leadInjected).toEqual(EXPECTED_SLACK_ROUTE_SKILLS);

    // Subagent with distinct session and no inherited seen-skills
    // simulates scope isolation — skills re-inject
    const subSession = `subagent-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const origSession = testSession;
    testSession = subSession;
    try {
      const { code, stdout } = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: slackRoutePath } },
        { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
        { omitSeenSkillsEnv: true },
      );
      expect(code).toBe(0);
      const subInjected = parseInjectedSkills(stdout);
      // Subagent gets the same skills despite parent having injected them
      expect(subInjected).toEqual(EXPECTED_SLACK_ROUTE_SKILLS);
    } finally {
      testSession = origSession;
    }
  });
});
