import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  listSessionKeys,
  removeSessionClaimDir,
} from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const BOOTSTRAP_SCRIPT = join(ROOT, "hooks", "subagent-start-bootstrap.mjs");
const PRETOOLUSE_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const STOP_SCRIPT = join(ROOT, "hooks", "subagent-stop-sync.mjs");
const UNLIMITED_BUDGET = "999999";

let testSession: string;
const cleanupPaths: string[] = [];

beforeEach(() => {
  testSession = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  // Clean up dedup claim dirs (both unscoped and agent-scoped) and ledger files
  removeSessionClaimDir(testSession, "seen-skills");
  // Clean up scoped claim dirs used by tests
  for (const agentId of ["explore-agent-1", "explore-1", "plan-1", "gp-agent-2", "explore-concurrent-a", "explore-concurrent-b"]) {
    removeSessionClaimDir(testSession, "seen-skills", agentId);
  }
  const ledger = join(
    tmpdir(),
    `vercel-plugin-${testSession}-subagent-ledger.jsonl`,
  );
  if (existsSync(ledger)) {
    rmSync(ledger, { force: true });
  }
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

async function runHook(
  script: string,
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ session_id: testSession, ...input });

  const proc = Bun.spawn(["node", script], {
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

function runBootstrap(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  return runHook(BOOTSTRAP_SCRIPT, input, env);
}

function runPreToolUse(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  return runHook(PRETOOLUSE_SCRIPT, input, {
    VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
    ...env,
  });
}

function runStop(
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  return runHook(STOP_SCRIPT, input, env);
}

function parseInjectedSkills(stdout: string): string[] {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  return Array.isArray(si.injectedSkills) ? si.injectedSkills : [];
}

function readLedger(
  sessionId: string,
): Array<Record<string, unknown>> {
  const path = join(
    tmpdir(),
    `vercel-plugin-${sessionId}-subagent-ledger.jsonl`,
  );
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  return lines.filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests: Full SubagentStart → PreToolUse → SubagentStop lifecycle
// ---------------------------------------------------------------------------

describe("subagent-lifecycle-integration", () => {
  const nextjsPagePath = "/Users/me/my-app/app/page.tsx";
  const agentId = "explore-agent-1";
  const agentType = "general-purpose";

  test("full lifecycle: bootstrap → PreToolUse dedup → stop ledger", async () => {
    // -----------------------------------------------------------------------
    // Step 1: SubagentStart bootstrap injects skills and writes dedup claims
    // -----------------------------------------------------------------------
    const bootstrapResult = await runBootstrap(
      { agent_type: agentType, agent_id: agentId },
      { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,ai-sdk" },
    );
    expect(bootstrapResult.code).toBe(0);

    // Bootstrap should produce additionalContext
    const bootstrapOutput = JSON.parse(bootstrapResult.stdout);
    expect(bootstrapOutput.hookSpecificOutput?.additionalContext).toBeDefined();

    // Verify dedup claims were written for bootstrapped skills (scoped by agent_id)
    const claimedAfterBootstrap = listSessionKeys(testSession, "seen-skills", agentId);
    expect(claimedAfterBootstrap).toContain("nextjs");
    expect(claimedAfterBootstrap).toContain("ai-sdk");

    // -----------------------------------------------------------------------
    // Step 2: PreToolUse runs within the SAME subagent (same agent_id) for a
    //         file that would normally trigger nextjs
    //         → must NOT re-inject already-bootstrapped skills
    // -----------------------------------------------------------------------
    const preToolResult = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: nextjsPagePath }, agent_id: agentId },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(preToolResult.code).toBe(0);

    const injectedByPreTool = parseInjectedSkills(preToolResult.stdout);
    // nextjs and ai-sdk were already claimed by bootstrap — must not appear
    expect(injectedByPreTool).not.toContain("nextjs");
    expect(injectedByPreTool).not.toContain("ai-sdk");

    // -----------------------------------------------------------------------
    // Step 3: Verify dedup claim dir has exactly the expected skill names
    //         (bootstrap claims + any new PreToolUse claims, all scoped)
    // -----------------------------------------------------------------------
    const allClaimed = listSessionKeys(testSession, "seen-skills", agentId);
    // Must still contain the bootstrap claims
    expect(allClaimed).toContain("nextjs");
    expect(allClaimed).toContain("ai-sdk");
    // Any skills PreToolUse injected should also be claimed
    for (const skill of injectedByPreTool) {
      expect(allClaimed).toContain(skill);
    }

    // -----------------------------------------------------------------------
    // Step 4: SubagentStop appends ledger entry
    // -----------------------------------------------------------------------
    const stopResult = await runStop(
      {
        agent_id: agentId,
        agent_type: agentType,
        agent_transcript_path: "/tmp/fake-transcript.jsonl",
      },
      {},
    );
    expect(stopResult.code).toBe(0);

    // Verify ledger JSONL contains the expected agent entry
    const ledgerEntries = readLedger(testSession);
    expect(ledgerEntries.length).toBe(1);

    const entry = ledgerEntries[0];
    expect(entry.session_id).toBe(testSession);
    expect(entry.agent_id).toBe(agentId);
    expect(entry.agent_type).toBe(agentType);
    expect(entry.agent_transcript_path).toBe("/tmp/fake-transcript.jsonl");
    expect(entry.timestamp).toBeDefined();
  });

  test("multiple subagents each get their own ledger entries", async () => {
    const agents = [
      { id: "explore-1", type: "Explore" },
      { id: "plan-1", type: "Plan" },
    ];

    for (const agent of agents) {
      const stopResult = await runStop(
        {
          agent_id: agent.id,
          agent_type: agent.type,
        },
        {},
      );
      expect(stopResult.code).toBe(0);
    }

    const ledgerEntries = readLedger(testSession);
    expect(ledgerEntries.length).toBe(2);
    expect(ledgerEntries[0].agent_id).toBe("explore-1");
    expect(ledgerEntries[0].agent_type).toBe("Explore");
    expect(ledgerEntries[1].agent_id).toBe("plan-1");
    expect(ledgerEntries[1].agent_type).toBe("Plan");
  });

  test("bootstrap dedup prevents re-injection even with multiple likely skills", async () => {
    // Bootstrap with several skills
    const bootstrapResult = await runBootstrap(
      { agent_type: "general-purpose", agent_id: "gp-agent-2" },
      { VERCEL_PLUGIN_LIKELY_SKILLS: "nextjs,react-best-practices,typescript" },
    );
    expect(bootstrapResult.code).toBe(0);

    const claimed = listSessionKeys(testSession, "seen-skills", "gp-agent-2");
    // Only skills whose content was actually included are claimed.
    // typescript has no summary/body in the manifest, so it is not claimed.
    expect(claimed).toContain("nextjs");
    expect(claimed).toContain("react-best-practices");

    // PreToolUse within the same subagent for a .tsx file
    const preToolResult = await runPreToolUse(
      {
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/my-app/components/Button.tsx" },
        agent_id: "gp-agent-2",
      },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(preToolResult.code).toBe(0);

    const injected = parseInjectedSkills(preToolResult.stdout);
    // None of the bootstrapped skills should be re-injected
    expect(injected).not.toContain("nextjs");
    expect(injected).not.toContain("react-best-practices");
    expect(injected).not.toContain("typescript");
  });

  test("concurrent same-type subagents get independent skill injection", async () => {
    const agentA = "explore-concurrent-a";
    const agentB = "explore-concurrent-b";
    const sharedType = "Explore";
    const likelySkills = "nextjs,ai-sdk";

    // -----------------------------------------------------------------------
    // Step 1: Bootstrap both Explore subagents concurrently against same session
    // -----------------------------------------------------------------------
    const [bootstrapA, bootstrapB] = await Promise.all([
      runBootstrap(
        { agent_type: sharedType, agent_id: agentA },
        { VERCEL_PLUGIN_LIKELY_SKILLS: likelySkills },
      ),
      runBootstrap(
        { agent_type: sharedType, agent_id: agentB },
        { VERCEL_PLUGIN_LIKELY_SKILLS: likelySkills },
      ),
    ]);

    expect(bootstrapA.code).toBe(0);
    expect(bootstrapB.code).toBe(0);

    // Both should produce additionalContext (not suppressed by sibling)
    const outputA = JSON.parse(bootstrapA.stdout);
    const outputB = JSON.parse(bootstrapB.stdout);
    expect(outputA.hookSpecificOutput?.additionalContext).toBeDefined();
    expect(outputB.hookSpecificOutput?.additionalContext).toBeDefined();

    // -----------------------------------------------------------------------
    // Step 2: Explore agents use minimal budget — no skills are included in
    // the context, so no dedup claims are written. This is intentional:
    // only skills whose content was actually injected are claimed.
    // -----------------------------------------------------------------------
    const claimsA = listSessionKeys(testSession, "seen-skills", agentA);
    const claimsB = listSessionKeys(testSession, "seen-skills", agentB);
    expect(claimsA).toEqual([]);
    expect(claimsB).toEqual([]);

    // -----------------------------------------------------------------------
    // Step 3: Since Explore agents don't claim skills, PreToolUse can still
    // inject matching skills when the agent reads relevant files.
    // -----------------------------------------------------------------------
    const preToolA = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: "/Users/me/app/page.tsx" }, agent_id: agentA },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(preToolA.code).toBe(0);

    const preToolB = await runPreToolUse(
      { tool_name: "Read", tool_input: { file_path: "/Users/me/app/page.tsx" }, agent_id: agentB },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(preToolB.code).toBe(0);

    // -----------------------------------------------------------------------
    // Step 4: Both agents get independent stop ledger entries
    // -----------------------------------------------------------------------
    const [stopA, stopB] = await Promise.all([
      runStop({ agent_id: agentA, agent_type: sharedType }, {}),
      runStop({ agent_id: agentB, agent_type: sharedType }, {}),
    ]);
    expect(stopA.code).toBe(0);
    expect(stopB.code).toBe(0);

    const ledger = readLedger(testSession);
    expect(ledger.length).toBe(2);

    const ledgerAgentIds = ledger.map((e) => e.agent_id).sort();
    expect(ledgerAgentIds).toEqual([agentA, agentB].sort());
    // Both should be recorded as the same type
    expect(ledger.every((e) => e.agent_type === sharedType)).toBe(true);
  });
});
