import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import {
  appendRoutingDecisionTrace,
  traceDir,
  type RoutingDecisionTrace,
} from "../hooks/src/routing-decision-trace.mts";
import {
  runRoutingExplain,
  type RoutingExplainResult,
} from "../src/commands/routing-explain.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SESSION = "test-session-rexplain-" + Date.now();

function makeTrace(
  overrides: Partial<RoutingDecisionTrace> = {},
): RoutingDecisionTrace {
  return {
    version: 1,
    decisionId: "deadbeef01234567",
    sessionId: TEST_SESSION,
    hook: "PreToolUse",
    toolName: "Bash",
    toolTarget: "npm run dev",
    timestamp: "2026-03-27T08:00:00.000Z",
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      route: "/settings",
      targetBoundary: "uiRender",
    },
    policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
    matchedSkills: ["agent-browser-verify"],
    injectedSkills: ["agent-browser-verify"],
    skippedReasons: [],
    ranked: [
      {
        skill: "agent-browser-verify",
        basePriority: 7,
        effectivePriority: 15,
        pattern: { type: "bashPattern", value: "dev server" },
        profilerBoost: 0,
        policyBoost: 8,
        policyReason: "4/5 wins",
        summaryOnly: false,
        synthetic: false,
        droppedReason: null,
      },
    ],
    verification: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

describe("routing-explain JSON mode", () => {
  test("returns parseable JSON with ok, decisionCount, latest when traces exist", () => {
    const trace = makeTrace();
    appendRoutingDecisionTrace(trace);

    const output = runRoutingExplain(TEST_SESSION, true);
    const result: RoutingExplainResult = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.decisionCount).toBe(1);
    expect(result.latest).not.toBeNull();
    expect(result.latest!.decisionId).toBe("deadbeef01234567");
    expect(result.latest!.hook).toBe("PreToolUse");
    expect(result.latest!.injectedSkills).toEqual(["agent-browser-verify"]);
  });

  test("returns latest trace when multiple exist", () => {
    appendRoutingDecisionTrace(
      makeTrace({ decisionId: "aaaa000000000000", timestamp: "2026-03-27T08:00:00.000Z" }),
    );
    appendRoutingDecisionTrace(
      makeTrace({ decisionId: "bbbb000000000000", timestamp: "2026-03-27T09:00:00.000Z" }),
    );

    const output = runRoutingExplain(TEST_SESSION, true);
    const result: RoutingExplainResult = JSON.parse(output);

    expect(result.decisionCount).toBe(2);
    expect(result.latest!.decisionId).toBe("bbbb000000000000");
  });

  test("returns clean result when no traces exist", () => {
    const output = runRoutingExplain(TEST_SESSION, true);
    const result: RoutingExplainResult = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.decisionCount).toBe(0);
    expect(result.latest).toBeNull();
  });

  test("returns clean result for null session", () => {
    const output = runRoutingExplain(null, true);
    const result: RoutingExplainResult = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.decisionCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

describe("routing-explain text mode", () => {
  test("prints decision id, hook, tool target, story, injected skills", () => {
    appendRoutingDecisionTrace(makeTrace());

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("Decision: deadbeef01234567");
    expect(output).toContain("Hook: PreToolUse");
    expect(output).toContain("Tool: Bash");
    expect(output).toContain("Target: npm run dev");
    expect(output).toContain("Story: flow-verification (/settings)");
    expect(output).toContain("Injected: agent-browser-verify");
  });

  test("prints ranked candidates with effective priority and policy boost", () => {
    appendRoutingDecisionTrace(makeTrace());

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("Ranked:");
    expect(output).toContain("agent-browser-verify");
    expect(output).toContain("effective=15");
    expect(output).toContain("base=7");
    expect(output).toContain("policy=+8");
    expect(output).toContain("4/5 wins");
  });

  test("prints policy scenario", () => {
    appendRoutingDecisionTrace(makeTrace());

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("Policy scenario: PreToolUse|flow-verification|uiRender|Bash");
  });

  test("returns clean non-throwing result when no traces exist", () => {
    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("No routing decision traces found.");
    expect(output).toContain("session-explain --json");
  });

  test("prints skipped reasons for story-less routing", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        primaryStory: { id: null, kind: null, route: null, targetBoundary: null },
        policyScenario: null,
        skippedReasons: ["no_active_verification_story"],
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("Skipped: no_active_verification_story");
    expect(output).toContain("Story: none");
  });

  test("prints skipped reasons for budget and cap drops", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        skippedReasons: [
          "cap_exceeded:some-skill",
          "budget_exhausted:another-skill",
        ],
        ranked: [
          {
            skill: "some-skill",
            basePriority: 6,
            effectivePriority: 6,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: "cap_exceeded",
          },
          {
            skill: "another-skill",
            basePriority: 5,
            effectivePriority: 5,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: "budget_exhausted",
          },
        ],
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("cap_exceeded:some-skill");
    expect(output).toContain("budget_exhausted:another-skill");
    expect(output).toContain("dropped=cap_exceeded");
    expect(output).toContain("dropped=budget_exhausted");
  });

  test("prints verification closure info for PostToolUse traces", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        hook: "PostToolUse",
        verification: {
          verificationId: "verif-abc",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("Verification:");
    expect(output).toContain("id: verif-abc");
    expect(output).toContain("boundary: uiRender");
    expect(output).toContain("matched action: true");
  });

  test("prints profiler boost when present", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        ranked: [
          {
            skill: "agent-browser-verify",
            basePriority: 7,
            effectivePriority: 20,
            pattern: { type: "bashPattern", value: "dev server" },
            profilerBoost: 5,
            policyBoost: 8,
            policyReason: "4/5 wins",
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("profiler=+5");
  });

  test("prints undertrained policy as zero boost without reason", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        ranked: [
          {
            skill: "some-skill",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "pathPattern", value: "**/*.ts" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("effective=6");
    expect(output).toContain("base=6");
    // No policy line when boost is 0
    expect(output).not.toContain("policy=");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic sufficiency
// ---------------------------------------------------------------------------

describe("routing-explain diagnostic completeness", () => {
  test("undertrained routing is distinguishable from story-less routing", () => {
    // Undertrained: has story but policy boost is 0
    appendRoutingDecisionTrace(
      makeTrace({
        decisionId: "undertrained-0001",
        skippedReasons: [],
        ranked: [
          {
            skill: "some-skill",
            basePriority: 6,
            effectivePriority: 6,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );

    const undertrainedOutput = runRoutingExplain(TEST_SESSION, false);

    // Clean up for next trace
    rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });

    // Story-less: no active verification story
    appendRoutingDecisionTrace(
      makeTrace({
        decisionId: "storyless-00001",
        primaryStory: { id: null, kind: null, route: null, targetBoundary: null },
        policyScenario: null,
        skippedReasons: ["no_active_verification_story"],
      }),
    );

    const storylessOutput = runRoutingExplain(TEST_SESSION, false);

    // These two outputs must be distinguishable
    expect(storylessOutput).toContain("no_active_verification_story");
    expect(undertrainedOutput).not.toContain("no_active_verification_story");
    expect(undertrainedOutput).toContain("Story: flow-verification");
    expect(storylessOutput).toContain("Story: none");
  });

  test("drop-by-budget and drop-by-cap are distinguishable in output", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        skippedReasons: ["cap_exceeded:skill-a", "budget_exhausted:skill-b"],
      }),
    );

    const output = runRoutingExplain(TEST_SESSION, false);

    expect(output).toContain("cap_exceeded:skill-a");
    expect(output).toContain("budget_exhausted:skill-b");
  });
});
