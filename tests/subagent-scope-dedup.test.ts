import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dedupClaimDirPath, listSessionKeys, removeSessionClaimDir } from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const BOOTSTRAP_SCRIPT = join(ROOT, "hooks", "subagent-start-bootstrap.mjs");
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

async function runBootstrap(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({
    session_id: testSession,
    ...input,
  });

  const proc = Bun.spawn(["node", BOOTSTRAP_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
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
    expect(parseInjectedSkills(leadSecond.stdout)).toEqual([]);

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
    expect(parseInjectedSkills(second.stdout)).toEqual([]);
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

// ---------------------------------------------------------------------------
// Tests: SubagentStart bootstrap writes dedup claims
// ---------------------------------------------------------------------------

describe("subagent-scope-dedup: bootstrap dedup claims", () => {
  const nextjsPagePath = "/Users/me/my-app/app/page.tsx";
  const bootstrapAgentId = "gp-bootstrap-1";

  afterEach(() => {
    removeSessionClaimDir(testSession, "seen-skills");
    removeSessionClaimDir(testSession, "seen-skills", bootstrapAgentId);
  });

  test("bootstrap writes dedup claims scoped by agent_id", async () => {
    const result = await runBootstrap(
      { agent_type: "general-purpose", agent_id: bootstrapAgentId },
      { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,ai-sdk" },
    );
    expect(result.code).toBe(0);

    // Verify the hook produced additionalContext
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toBeDefined();

    // Verify claims were written to the agent-scoped claim dir
    const claimed = listSessionKeys(testSession, "seen-skills", bootstrapAgentId);
    expect(claimed).toContain("nextjs");
    expect(claimed).toContain("ai-sdk");

    // Unscoped claim dir should be empty (no cross-contamination)
    const unscopedClaimed = listSessionKeys(testSession, "seen-skills");
    expect(unscopedClaimed).not.toContain("nextjs");
    expect(unscopedClaimed).not.toContain("ai-sdk");
  });

  test("PreToolUse within same agent does not re-inject skills already claimed by bootstrap", async () => {
    // Step 1: Run bootstrap to claim skills (scoped by agent_id)
    const bootstrapResult = await runBootstrap(
      { agent_type: "general-purpose", agent_id: bootstrapAgentId },
      { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs" },
    );
    expect(bootstrapResult.code).toBe(0);

    // Verify bootstrap claimed nextjs in scoped dir
    const claimed = listSessionKeys(testSession, "seen-skills", bootstrapAgentId);
    expect(claimed).toContain("nextjs");

    // Step 2: Run PreToolUse with same agent_id — should see the scoped claim
    const preToolResult = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: nextjsPagePath }, agent_id: bootstrapAgentId },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(preToolResult.code).toBe(0);

    // nextjs should NOT be re-injected because bootstrap already claimed it
    const injected = parseInjectedSkills(preToolResult.stdout);
    expect(injected).not.toContain("nextjs");
  });
});

// ---------------------------------------------------------------------------
// Tests: Two concurrent same-type subagents get independent bootstrap claims
// ---------------------------------------------------------------------------

describe("subagent-scope-dedup: concurrent same-type bootstrap", () => {
  const explore1 = "explore-concurrent-1";
  const explore2 = "explore-concurrent-2";

  afterEach(() => {
    removeSessionClaimDir(testSession, "seen-skills", explore1);
    removeSessionClaimDir(testSession, "seen-skills", explore2);
  });

  test("two Explore agents launched simultaneously receive independent skill sets", async () => {
    // Both use the SAME session but different agent_ids
    const [result1, result2] = await Promise.all([
      runBootstrap(
        { agent_type: "Explore", agent_id: explore1 },
        { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,ai-sdk" },
      ),
      runBootstrap(
        { agent_type: "Explore", agent_id: explore2 },
        { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,ai-sdk" },
      ),
    ]);

    expect(result1.code).toBe(0);
    expect(result2.code).toBe(0);

    // Both should produce context
    const ctx1 = JSON.parse(result1.stdout)?.hookSpecificOutput?.additionalContext ?? "";
    const ctx2 = JSON.parse(result2.stdout)?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx1).toContain("nextjs");
    expect(ctx2).toContain("nextjs");

    // Each agent has its own scoped claims
    const claims1 = listSessionKeys(testSession, "seen-skills", explore1);
    const claims2 = listSessionKeys(testSession, "seen-skills", explore2);
    expect(claims1).toContain("nextjs");
    expect(claims1).toContain("ai-sdk");
    expect(claims2).toContain("nextjs");
    expect(claims2).toContain("ai-sdk");

    // Claims are independent — PreToolUse within each agent sees its own scope
    const [preTool1, preTool2] = await Promise.all([
      runPreToolUse(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/my-app/app/page.tsx" }, agent_id: explore1 },
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      ),
      runPreToolUse(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/my-app/app/page.tsx" }, agent_id: explore2 },
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      ),
    ]);

    expect(preTool1.code).toBe(0);
    expect(preTool2.code).toBe(0);

    // Both should be deduped (nextjs already claimed by their own bootstrap)
    const injected1 = parseInjectedSkills(preTool1.stdout);
    const injected2 = parseInjectedSkills(preTool2.stdout);
    expect(injected1).not.toContain("nextjs");
    expect(injected2).not.toContain("nextjs");
  });
});
