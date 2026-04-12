import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dedupClaimDirPath, listSessionKeys, removeSessionClaimDir } from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const UNLIMITED_BUDGET = "999999";

let testSession: string;
const cleanupPaths: string[] = [];

beforeEach(() => {
  testSession = `scope-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  cleanupPaths.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runPreToolUse(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({
    session_id: testSession,
    ...input,
  });

  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      VERCEL_PLUGIN_LOG_LEVEL: "off",
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
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  return Array.isArray(si.injectedSkills) ? si.injectedSkills : [];
}

// ---------------------------------------------------------------------------
// Tests: parent and subagent dedup isolation
// ---------------------------------------------------------------------------

describe("subagent-scope-dedup: isolated dedup scopes", () => {
  const nextjsPagePath = "/Users/me/my-app/app/page.tsx";

  test("parent injection does not suppress the same skill in a subagent", async () => {
    // Step 1: Lead agent injects nextjs
    const leadResult = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: nextjsPagePath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(leadResult.code).toBe(0);
    const leadInjected = parseInjectedSkills(leadResult.stdout);
    expect(leadInjected).toContain("nextjs");

    // Step 2: Lead's second call should be deduped
    const leadSeen = leadInjected.join(",");
    const leadSecond = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: nextjsPagePath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: leadSeen },
    );
    expect(leadSecond.code).toBe(0);
    expect(JSON.parse(leadSecond.stdout)).toEqual({});

    // Step 3: Subagent with its own agent_id and NO inherited seen-skills
    // should still get nextjs injected (isolated scope)
    const subSession = `scope-dedup-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const origSession = testSession;
    testSession = subSession;
    try {
      const subResult = await runPreToolUse(
        {
          tool_name: "Read",
          tool_input: { file_path: nextjsPagePath },
          agent_id: "subagent-explore-1",
        },
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(subResult.code).toBe(0);
      expect(parseInjectedSkills(subResult.stdout)).toContain("nextjs");
    } finally {
      testSession = origSession;
    }
  });

  test("agent-scoped claims do not suppress parent injections", async () => {
    // Subagent injects first
    const subSession = `scope-dedup-sub2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const origSession = testSession;

    testSession = subSession;
    try {
      const subResult = await runPreToolUse(
        {
          tool_name: "Read",
          tool_input: { file_path: nextjsPagePath },
          agent_id: "subagent-plan-1",
        },
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(subResult.code).toBe(0);
      expect(parseInjectedSkills(subResult.stdout)).toContain("nextjs");
    } finally {
      testSession = origSession;
    }

    // Parent should still be able to inject nextjs independently
    const parentResult = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: nextjsPagePath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(parentResult.code).toBe(0);
    expect(parseInjectedSkills(parentResult.stdout)).toContain("nextjs");
  });

  test("resumed agent reuses its existing scope (dedup works across invocations)", async () => {
    const agentId = "subagent-gp-resume-1";

    // First invocation: inject nextjs
    const first = await runPreToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: nextjsPagePath },
        agent_id: agentId,
      },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(first.code).toBe(0);
    const firstInjected = parseInjectedSkills(first.stdout);
    expect(firstInjected).toContain("nextjs");

    // Second invocation with same agent_id and session: should be deduped
    const second = await runPreToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: nextjsPagePath },
        agent_id: agentId,
      },
      { VERCEL_PLUGIN_SEEN_SKILLS: firstInjected.join(",") },
    );
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({});
  });
});

describe("subagent-scope-dedup: multiple concurrent subagents", () => {
  const slackRoutePath = "/Users/me/slack-clone/app/api/slack/route.ts";

  test("two subagents with different agent_ids both get injections", async () => {
    const [sub1, sub2] = await Promise.all([
      (async () => {
        const s = `scope-dedup-multi1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const orig = testSession;
        testSession = s;
        try {
          return await runPreToolUse(
            {
              tool_name: "Read",
              tool_input: { file_path: slackRoutePath },
              agent_id: "sub-alpha",
            },
            { VERCEL_PLUGIN_SEEN_SKILLS: "" },
          );
        } finally {
          testSession = orig;
        }
      })(),
      (async () => {
        const s = `scope-dedup-multi2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const orig = testSession;
        testSession = s;
        try {
          return await runPreToolUse(
            {
              tool_name: "Read",
              tool_input: { file_path: slackRoutePath },
              agent_id: "sub-beta",
            },
            { VERCEL_PLUGIN_SEEN_SKILLS: "" },
          );
        } finally {
          testSession = orig;
        }
      })(),
    ]);

    expect(sub1.code).toBe(0);
    expect(sub2.code).toBe(0);

    const skills1 = parseInjectedSkills(sub1.stdout);
    const skills2 = parseInjectedSkills(sub2.stdout);

    // Both should get chat-sdk since they're reading a slack route
    expect(skills1).toContain("chat-sdk");
    expect(skills2).toContain("chat-sdk");
  });
});
