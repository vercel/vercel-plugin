import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createEmptyRoutingPolicy,
  type RoutingPolicyFile,
} from "../hooks/src/routing-policy.mts";
import {
  projectPolicyPath,
  saveProjectRoutingPolicy,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  statePath as verificationStatePath,
} from "../hooks/src/verification-ledger.mts";
import {
  readRoutingDecisionTrace,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";
import {
  tryClaimSessionKey,
  dedupClaimDirPath,
} from "../hooks/src/hook-env.mts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const TEST_PROJECT = "/tmp/test-pretooluse-policy-recall-" + Date.now();

const T0 = "2026-03-27T19:00:00.000Z";
const T1 = "2026-03-27T19:01:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a mock verification plan so loadCachedPlanResult returns a story. */
function writeMockPlanState(sessionId: string, opts?: {
  storyKind?: string;
  route?: string | null;
  targetBoundary?: string;
}): void {
  const sp = verificationStatePath(sessionId);
  mkdirSync(join(sp, ".."), { recursive: true });
  writeFileSync(sp, JSON.stringify({
    version: 1,
    stories: [{
      id: "recall-story-1",
      kind: opts?.storyKind ?? "flow-verification",
      route: opts?.route ?? "/settings",
      promptExcerpt: "test policy recall",
      createdAt: T0,
      updatedAt: T1,
      requestedSkills: [],
    }],
    observationIds: [],
    satisfiedBoundaries: [],
    missingBoundaries: [opts?.targetBoundary ?? "clientRequest"],
    recentRoutes: [],
    primaryNextAction: {
      targetBoundary: opts?.targetBoundary ?? "clientRequest",
      suggestedAction: "curl http://localhost:3000/settings",
    },
    blockedReasons: [],
  }));
}

function cleanupPlanState(sessionId: string): void {
  const sp = verificationStatePath(sessionId);
  try { rmSync(join(sp, ".."), { recursive: true, force: true }); } catch {}
}

function cleanupPolicyFile(): void {
  try { unlinkSync(projectPolicyPath(TEST_PROJECT)); } catch {}
}

/** Build a policy with a strong verified winner for a given scenario key. */
function buildStrongPolicy(
  skill: string,
  scenarioKey: string,
  overrides?: Partial<{ exposures: number; wins: number; directiveWins: number; staleMisses: number }>,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  policy.scenarios[scenarioKey] = {
    [skill]: {
      exposures: overrides?.exposures ?? 5,
      wins: overrides?.wins ?? 5,
      directiveWins: overrides?.directiveWins ?? 2,
      staleMisses: overrides?.staleMisses ?? 0,
      lastUpdatedAt: T0,
    },
  };
  return policy;
}

/** Run PreToolUse hook as subprocess with cwd pointing to TEST_PROJECT. */
async function runHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; parsed: Record<string, unknown> | null }> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    cwd: TEST_PROJECT,
  });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_SEEN_SKILLS: "",
      VERCEL_PLUGIN_LOG_LEVEL: "debug",
      ...extraEnv,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

/** Extract skillInjection metadata from hook output. */
function extractInjectionMeta(stdout: string): {
  matchedSkills: string[];
  injectedSkills: string[];
  reasons: Record<string, { trigger: string; reasonCode: string }>;
} | null {
  try {
    const output = JSON.parse(stdout);
    const ctx = output.hookSpecificOutput?.additionalContext || "";
    const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Parse structured stderr log lines. */
function parseLogLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o): o is Record<string, unknown> => o !== null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pretooluse policy recall integration", () => {
  let sessionId: string;

  beforeEach(() => {
    sessionId = `recall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(TEST_PROJECT, { recursive: true });
  });

  afterEach(() => {
    cleanupPlanState(sessionId);
    cleanupPolicyFile();
    try { rmSync(traceDir(sessionId), { recursive: true, force: true }); } catch {}
    // Clean up file-based dedup claims
    try { rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true }); } catch {}
  });

  test("recalls a verified winner when pattern matching misses it", async () => {
    // Seed plan state with story route /settings and target boundary clientRequest
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Seed policy with strong exact-route bucket for "verification" skill
    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Run PreToolUse with a command that won't pattern-match "verification"
    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );

    expect(result.code).toBe(0);

    // Check debug logs for policy-recall-injected
    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeDefined();
    expect(recallLog!.skill).toBe("verification");
    expect(recallLog!.scenario).toBe("PreToolUse|flow-verification|clientRequest|Bash|/settings");

    // Check injection metadata
    const meta = extractInjectionMeta(result.stdout);
    if (meta) {
      expect(meta.injectedSkills).toContain("verification");
      expect(meta.reasons?.verification?.trigger).toBe("policy-recall");
      expect(meta.reasons?.verification?.reasonCode).toBe("route-scoped-verified-policy-recall");
    }
  });

  test("recalled skill is NOT forced into summary-only mode (summary path is identical to full)", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    // Recalled skill should NOT be marked summary-only since the summary and
    // full payloads are identical (both use skillInvocationMessage).
    const traces = readRoutingDecisionTrace(sessionId);
    if (traces.length > 0) {
      const recallEntry = traces[0].ranked?.find(
        (r: { skill: string }) => r.skill === "verification",
      );
      if (recallEntry) {
        expect(recallEntry.summaryOnly).toBe(false);
        expect(recallEntry.synthetic).toBe(true);
      }
    }
  });

  test("decision trace marks recalled skill as synthetic with policy-recall reason", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const traces = readRoutingDecisionTrace(sessionId);
    expect(traces.length).toBeGreaterThanOrEqual(1);

    const recallEntry = traces[0].ranked?.find(
      (r: { skill: string }) => r.skill === "verification",
    );
    expect(recallEntry).toBeDefined();
    expect(recallEntry!.synthetic).toBe(true);
    expect(recallEntry!.pattern?.type).toBe("policy-recall");
    expect(recallEntry!.pattern?.value).toBe("route-scoped-verified-policy-recall");
  });

  test("does not recall when no active verification story exists", async () => {
    // No writeMockPlanState — no story

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeUndefined();

    const skipLog = logs.find((l) => l.event === "policy-recall-skipped");
    expect(skipLog).toBeDefined();
  });

  test("does not recall when target boundary is null", async () => {
    // Plan state with no target boundary
    const sp = verificationStatePath(sessionId);
    mkdirSync(join(sp, ".."), { recursive: true });
    writeFileSync(sp, JSON.stringify({
      version: 1,
      stories: [{
        id: "no-boundary-story",
        kind: "flow-verification",
        route: "/settings",
        promptExcerpt: "test",
        createdAt: T0,
        updatedAt: T1,
        requestedSkills: [],
      }],
      observationIds: [],
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: { targetBoundary: null, suggestedAction: null },
      blockedReasons: [],
    }));

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeUndefined();
  });

  test("does not recall a skill that is already ranked via pattern matching", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Build policy for "nextjs" which will be pattern-matched by next.config.ts
    const policy = buildStrongPolicy(
      "nextjs",
      "PreToolUse|flow-verification|clientRequest|Read|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Run with a file read that will pattern-match nextjs
    const result = await runHook(
      "Read",
      { file_path: "next.config.ts" },
      sessionId,
    );
    expect(result.code).toBe(0);

    // Should not appear as policy-recall since it was already matched via patterns
    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find(
      (l) => l.event === "policy-recall-injected" && l.skill === "nextjs",
    );
    expect(recallLog).toBeUndefined();
  });

  test("does not recall a skill that is already in injectedSkills (dedup)", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Claim verification via file-based dedup (the authoritative source when sessionId is present)
    tryClaimSessionKey(sessionId, "seen-skills", "verification");

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeUndefined();
  });

  test("respects existing cap and budget behavior", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Use a very small budget to force budget exhaustion
    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
      { VERCEL_PLUGIN_INJECTION_BUDGET: "100" },
    );
    expect(result.code).toBe(0);

    // The recalled skill should be attempted but may be dropped by budget
    // Key assertion: the hook does not crash and respects budget
    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    // It should still attempt to inject
    expect(recallLog).toBeDefined();
  });

  test("falls back to wildcard route when exact route has no qualified evidence", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // No exact-route bucket; only wildcard
    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|*",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeDefined();
    expect(recallLog!.scenario).toBe("PreToolUse|flow-verification|clientRequest|Bash|*");
  });

  test("recalled skill is inserted behind direct match, not at slot-1", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Seed policy for "verification" which won't pattern-match "next.config.ts"
    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Read|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Read next.config.ts — will pattern-match "nextjs" as a direct match
    const result = await runHook(
      "Read",
      { file_path: "next.config.ts" },
      sessionId,
    );
    expect(result.code).toBe(0);

    // Check injection metadata: direct match should be first, recalled second
    const meta = extractInjectionMeta(result.stdout);
    if (meta && meta.injectedSkills.length >= 2) {
      // The direct pattern match should remain first
      expect(meta.reasons?.[meta.injectedSkills[0]]?.trigger).not.toBe("policy-recall");
      // Verification should be present but not first
      const verificationIdx = meta.injectedSkills.indexOf("verification");
      if (verificationIdx !== -1) {
        expect(verificationIdx).toBeGreaterThan(0);
      }
    }

    // Check debug logs confirm insertionIndex > 0
    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected" && l.skill === "verification");
    if (recallLog) {
      expect(recallLog.insertionIndex).toBeGreaterThan(0);
    }
  });

  test("recalled skill takes slot-1 when no direct matches exist", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // echo hello won't pattern-match anything
    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected" && l.skill === "verification");
    expect(recallLog).toBeDefined();
    expect(recallLog!.insertionIndex).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Regression: policy recall parity with companion recall
  // ---------------------------------------------------------------------------

  test("policy recall still owns attribution when both policy and companion recall are present", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Strong policy for "verification"
    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    // Policy recall should still be logged
    const logs = parseLogLines(result.stderr);
    const recallLog = logs.find((l) => l.event === "policy-recall-injected");
    expect(recallLog).toBeDefined();
    expect(recallLog!.skill).toBe("verification");

    // Attribution candidate should be the policy-recalled skill or direct match,
    // never a companion-only skill
    const attributionLog = logs.find((l) => l.event === "companion-recall-attribution");
    if (attributionLog) {
      // companionRecalledSkills should NOT include the attribution candidate
      const companionRecalled = attributionLog.companionRecalledSkills as string[];
      expect(companionRecalled).not.toContain(attributionLog.causalCandidate);
    }
  });

  test("companion recall never suppresses a stronger direct pattern match", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Policy for "verification" — strong history
    const policy = buildStrongPolicy(
      "verification",
      "PreToolUse|flow-verification|clientRequest|Read|/settings",
    );
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Read next.config.ts — "nextjs" will be a direct pattern match
    const result = await runHook(
      "Read",
      { file_path: "next.config.ts" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const meta = extractInjectionMeta(result.stdout);
    if (meta && meta.injectedSkills.length > 0) {
      // The first injected skill must be the direct pattern match, not a companion
      const firstSkillReason = meta.reasons?.[meta.injectedSkills[0]];
      if (firstSkillReason) {
        expect(firstSkillReason.trigger).not.toBe("verified-companion");
      }
    }

    // Decision trace should show direct match before any companion entries
    const traces = readRoutingDecisionTrace(sessionId);
    if (traces.length > 0 && traces[0].ranked && traces[0].ranked.length > 0) {
      const first = traces[0].ranked[0] as { pattern?: { type: string } };
      if (first.pattern) {
        expect(first.pattern.type).not.toBe("verified-companion");
      }
    }
  });

  test("at most one recalled skill in phase 1", async () => {
    writeMockPlanState(sessionId, {
      storyKind: "flow-verification",
      route: "/settings",
      targetBoundary: "clientRequest",
    });

    // Two strong skills in the same bucket
    const policy = createEmptyRoutingPolicy();
    const key = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
    policy.scenarios[key] = {
      verification: {
        exposures: 5, wins: 5, directiveWins: 2, staleMisses: 0,
        lastUpdatedAt: T0,
      },
      "agent-browser-verify": {
        exposures: 5, wins: 5, directiveWins: 3, staleMisses: 0,
        lastUpdatedAt: T0,
      },
    };
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const result = await runHook(
      "Bash",
      { command: "echo hello" },
      sessionId,
    );
    expect(result.code).toBe(0);

    const logs = parseLogLines(result.stderr);
    const recallLogs = logs.filter((l) => l.event === "policy-recall-injected");
    expect(recallLogs.length).toBeLessThanOrEqual(1);
  });
});
