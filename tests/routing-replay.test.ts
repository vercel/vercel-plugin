import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import {
  appendRoutingDecisionTrace,
  traceDir,
  type RoutingDecisionTrace,
} from "../hooks/src/routing-decision-trace.mts";
import {
  appendSkillExposure,
  sessionExposurePath,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  replayRoutingSession,
  type RoutingReplayReport,
} from "../hooks/src/routing-replay.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SESSION = "test-session-replay-" + Date.now();
const TEST_PROJECT = "/tmp/test-project-replay";

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";
const T4 = "2026-03-27T04:04:00.000Z";
const T5 = "2026-03-27T04:05:00.000Z";

function makeTrace(
  overrides: Partial<RoutingDecisionTrace> = {},
): RoutingDecisionTrace {
  return {
    version: 2,
    decisionId: "replay-test-" + Math.random().toString(36).slice(2, 10),
    sessionId: TEST_SESSION,
    hook: "PreToolUse",
    toolName: "Bash",
    toolTarget: "npm run dev",
    timestamp: T0,
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/dashboard",
      targetBoundary: "uiRender",
    },
    observedRoute: null,
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

function makeExposure(overrides: Partial<SkillExposure> = {}): SkillExposure {
  return {
    id: `${TEST_SESSION}:test-skill:${Date.now()}-${Math.random()}`,
    sessionId: TEST_SESSION,
    projectRoot: TEST_PROJECT,
    storyId: "story-1",
    storyKind: "flow-verification",
    route: "/dashboard",
    hook: "PreToolUse",
    toolName: "Bash",
    skill: "agent-browser-verify",
    targetBoundary: "uiRender",
    exposureGroupId: null,
    attributionRole: "candidate",
    candidateSkill: null,
    createdAt: T0,
    resolvedAt: null,
    outcome: "pending",
    ...overrides,
  };
}

function cleanup() {
  try {
    rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });
  } catch {}
  try {
    unlinkSync(sessionExposurePath(TEST_SESSION));
  } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing-replay", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // Empty session
  // -------------------------------------------------------------------------

  test("returns empty report for session with no traces or exposures", () => {
    const report = replayRoutingSession(TEST_SESSION);
    expect(report.version).toBe(1);
    expect(report.sessionId).toBe(TEST_SESSION);
    expect(report.traceCount).toBe(0);
    expect(report.scenarioCount).toBe(0);
    expect(report.scenarios).toEqual([]);
    expect(report.recommendations).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Determinism — byte-for-byte identical output
  // -------------------------------------------------------------------------

  test("produces identical JSON for identical input (deterministic)", () => {
    // Write traces
    appendRoutingDecisionTrace(makeTrace({ timestamp: T0 }));
    appendRoutingDecisionTrace(makeTrace({ timestamp: T1 }));

    // Write exposures with wins
    appendSkillExposure(
      makeExposure({ createdAt: T0, resolvedAt: T1, outcome: "win" }),
    );
    appendSkillExposure(
      makeExposure({ createdAt: T1, resolvedAt: T2, outcome: "win" }),
    );

    const report1 = replayRoutingSession(TEST_SESSION);
    const report2 = replayRoutingSession(TEST_SESSION);

    expect(JSON.stringify(report1)).toBe(JSON.stringify(report2));
  });

  // -------------------------------------------------------------------------
  // Scenario grouping
  // -------------------------------------------------------------------------

  test("groups exposures by scenario key", () => {
    appendRoutingDecisionTrace(makeTrace());

    // Two different scenarios
    appendSkillExposure(
      makeExposure({
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        outcome: "win",
        resolvedAt: T1,
      }),
    );
    appendSkillExposure(
      makeExposure({
        hook: "UserPromptSubmit",
        storyKind: "none",
        targetBoundary: null,
        toolName: "Read",
        skill: "next-config",
        outcome: "win",
        resolvedAt: T2,
      }),
    );

    const report = replayRoutingSession(TEST_SESSION);

    // Should have at least 2 scenarios (one from trace, others from exposures)
    expect(report.scenarioCount).toBeGreaterThanOrEqual(2);

    // Scenarios must be sorted lexicographically
    const names = report.scenarios.map((s) => s.scenario);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  // -------------------------------------------------------------------------
  // Win / directive-win / stale-miss accounting
  // -------------------------------------------------------------------------

  test("counts wins, directive-wins, and stale-misses correctly", () => {
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";
    appendRoutingDecisionTrace(
      makeTrace({ policyScenario: scenario }),
    );

    // 2 plain wins
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T1 }));
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T2 }));

    // 1 directive-win (also counts as a win)
    appendSkillExposure(
      makeExposure({ outcome: "directive-win", resolvedAt: T3 }),
    );

    // 1 stale-miss
    appendSkillExposure(
      makeExposure({ outcome: "stale-miss", resolvedAt: T4 }),
    );

    // 1 pending (only exposure count)
    appendSkillExposure(makeExposure({ outcome: "pending" }));

    const report = replayRoutingSession(TEST_SESSION);
    const s = report.scenarios.find((sc) => sc.scenario === scenario);

    expect(s).toBeDefined();
    expect(s!.exposures).toBe(5);
    expect(s!.wins).toBe(3); // 2 win + 1 directive-win
    expect(s!.directiveWins).toBe(1);
    expect(s!.staleMisses).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Null-route attribution (strict scoping)
  // -------------------------------------------------------------------------

  test("separates null-route and non-null-route into distinct scenarios", () => {
    // Exposure with route
    appendSkillExposure(
      makeExposure({
        route: "/dashboard",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        outcome: "win",
        resolvedAt: T1,
      }),
    );

    // Exposure with null route — different storyKind produces different scenario
    appendSkillExposure(
      makeExposure({
        route: null,
        storyKind: "none",
        targetBoundary: null,
        outcome: "stale-miss",
        resolvedAt: T2,
      }),
    );

    const report = replayRoutingSession(TEST_SESSION);

    // The two exposures should land in different scenarios because
    // buildScenarioKey uses storyKind and targetBoundary
    const withBoundary = report.scenarios.find(
      (s) => s.scenario === "PreToolUse|flow-verification|uiRender|Bash",
    );
    const withoutBoundary = report.scenarios.find(
      (s) => s.scenario === "PreToolUse|none|none|Bash",
    );

    expect(withBoundary).toBeDefined();
    expect(withBoundary!.wins).toBe(1);
    expect(withBoundary!.staleMisses).toBe(0);

    expect(withoutBoundary).toBeDefined();
    expect(withoutBoundary!.wins).toBe(0);
    expect(withoutBoundary!.staleMisses).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Promote recommendation
  // -------------------------------------------------------------------------

  test("recommends promote for high success rate (>=80%, >=3 exposures)", () => {
    // 4 wins out of 4 exposures
    for (let i = 0; i < 4; i++) {
      appendSkillExposure(
        makeExposure({ outcome: "win", resolvedAt: T1 }),
      );
    }

    const report = replayRoutingSession(TEST_SESSION);
    const promo = report.recommendations.find((r) => r.action === "promote");

    expect(promo).toBeDefined();
    expect(promo!.skill).toBe("agent-browser-verify");
    expect(promo!.suggestedBoost).toBe(8);
    expect(promo!.confidence).toBeGreaterThanOrEqual(0.99);
  });

  // -------------------------------------------------------------------------
  // Demote recommendation
  // -------------------------------------------------------------------------

  test("recommends demote for low success rate (<15%, >=5 exposures)", () => {
    // 0 wins out of 6 exposures (all stale-miss)
    for (let i = 0; i < 6; i++) {
      appendSkillExposure(
        makeExposure({ outcome: "stale-miss", resolvedAt: T1 }),
      );
    }

    const report = replayRoutingSession(TEST_SESSION);
    const demote = report.recommendations.find((r) => r.action === "demote");

    expect(demote).toBeDefined();
    expect(demote!.skill).toBe("agent-browser-verify");
    expect(demote!.suggestedBoost).toBe(-2);
    expect(demote!.confidence).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Investigate recommendation
  // -------------------------------------------------------------------------

  test("recommends investigate for mixed results (40-65%, >=3 exposures)", () => {
    // 2 wins out of 4 exposures = 50%
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T1 }));
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T2 }));
    appendSkillExposure(
      makeExposure({ outcome: "stale-miss", resolvedAt: T3 }),
    );
    appendSkillExposure(
      makeExposure({ outcome: "stale-miss", resolvedAt: T4 }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    const inv = report.recommendations.find((r) => r.action === "investigate");

    expect(inv).toBeDefined();
    expect(inv!.skill).toBe("agent-browser-verify");
    expect(inv!.suggestedBoost).toBe(0);
    expect(inv!.confidence).toBe(0.5);
  });

  // -------------------------------------------------------------------------
  // No recommendation in dead zone
  // -------------------------------------------------------------------------

  test("produces no recommendation for insufficient data", () => {
    // Only 2 exposures — below all thresholds
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T1 }));
    appendSkillExposure(
      makeExposure({ outcome: "stale-miss", resolvedAt: T2 }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    expect(report.recommendations).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Directive-win vs plain win tracking
  // -------------------------------------------------------------------------

  test("tracks directive-wins separately within win count", () => {
    appendSkillExposure(makeExposure({ outcome: "win", resolvedAt: T1 }));
    appendSkillExposure(
      makeExposure({ outcome: "directive-win", resolvedAt: T2 }),
    );
    appendSkillExposure(
      makeExposure({ outcome: "directive-win", resolvedAt: T3 }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    const s = report.scenarios[0];

    expect(s.wins).toBe(3);
    expect(s.directiveWins).toBe(2);
    expect(s.topSkills[0].wins).toBe(3);
    expect(s.topSkills[0].directiveWins).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Stable skill ordering within scenario
  // -------------------------------------------------------------------------

  test("sorts skills by wins desc, exposures desc, name asc", () => {
    // skill-b: 3 wins out of 3
    for (let i = 0; i < 3; i++) {
      appendSkillExposure(
        makeExposure({ skill: "skill-b", outcome: "win", resolvedAt: T1 }),
      );
    }

    // skill-a: 2 wins out of 4
    appendSkillExposure(
      makeExposure({ skill: "skill-a", outcome: "win", resolvedAt: T1 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "skill-a", outcome: "win", resolvedAt: T2 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "skill-a", outcome: "stale-miss", resolvedAt: T3 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "skill-a", outcome: "stale-miss", resolvedAt: T4 }),
    );

    // skill-c: 2 wins out of 2 (same wins as skill-a, fewer exposures)
    appendSkillExposure(
      makeExposure({ skill: "skill-c", outcome: "win", resolvedAt: T1 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "skill-c", outcome: "win", resolvedAt: T2 }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    const skills = report.scenarios[0].topSkills.map((s) => s.skill);

    // skill-b (3 wins) > skill-a (2 wins, 4 exp) > skill-c (2 wins, 2 exp)
    expect(skills).toEqual(["skill-b", "skill-a", "skill-c"]);
  });

  // -------------------------------------------------------------------------
  // Recommendation stable ordering
  // -------------------------------------------------------------------------

  test("sorts recommendations by scenario asc then skill asc", () => {
    // Two scenarios with promotable skills
    for (let i = 0; i < 4; i++) {
      appendSkillExposure(
        makeExposure({
          hook: "UserPromptSubmit",
          storyKind: "none",
          targetBoundary: null,
          toolName: "Read",
          skill: "next-config",
          outcome: "win",
          resolvedAt: T1,
        }),
      );
    }
    for (let i = 0; i < 4; i++) {
      appendSkillExposure(
        makeExposure({
          skill: "agent-browser-verify",
          outcome: "win",
          resolvedAt: T1,
        }),
      );
    }

    const report = replayRoutingSession(TEST_SESSION);
    const recs = report.recommendations;

    expect(recs.length).toBeGreaterThanOrEqual(2);

    // Verify stable sort
    for (let i = 1; i < recs.length; i++) {
      const cmp =
        recs[i - 1].scenario.localeCompare(recs[i].scenario) ||
        recs[i - 1].skill.localeCompare(recs[i].skill);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Traces without exposures produce empty scenarios
  // -------------------------------------------------------------------------

  test("traces seed scenario keys even with no matching exposures", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
      }),
    );

    const report = replayRoutingSession(TEST_SESSION);

    expect(report.traceCount).toBe(1);
    expect(report.scenarioCount).toBe(1);
    expect(report.scenarios[0].exposures).toBe(0);
    expect(report.scenarios[0].topSkills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Multi-skill per scenario
  // -------------------------------------------------------------------------

  test("tracks multiple skills within the same scenario independently", () => {
    appendSkillExposure(
      makeExposure({ skill: "alpha", outcome: "win", resolvedAt: T1 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "alpha", outcome: "stale-miss", resolvedAt: T2 }),
    );
    appendSkillExposure(
      makeExposure({ skill: "beta", outcome: "win", resolvedAt: T3 }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    const s = report.scenarios[0];

    expect(s.topSkills.length).toBe(2);

    const alpha = s.topSkills.find((sk) => sk.skill === "alpha");
    const beta = s.topSkills.find((sk) => sk.skill === "beta");

    expect(alpha).toBeDefined();
    expect(alpha!.exposures).toBe(2);
    expect(alpha!.wins).toBe(1);

    expect(beta).toBeDefined();
    expect(beta!.exposures).toBe(1);
    expect(beta!.wins).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Synthetic injection fidelity — traces with synthetic markers
  // -------------------------------------------------------------------------

  test("includes traces with synthetic ranked skills in trace count", () => {
    appendRoutingDecisionTrace(
      makeTrace({
        ranked: [
          {
            skill: "react-best-practices",
            basePriority: 6,
            effectivePriority: 6,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: true,
            droppedReason: null,
          },
        ],
      }),
    );

    const report = replayRoutingSession(TEST_SESSION);
    expect(report.traceCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Report version and structure
  // -------------------------------------------------------------------------

  test("report has version 1 and all required fields", () => {
    const report = replayRoutingSession(TEST_SESSION);

    expect(report.version).toBe(1);
    expect(report.sessionId).toBe(TEST_SESSION);
    expect(typeof report.traceCount).toBe("number");
    expect(typeof report.scenarioCount).toBe("number");
    expect(Array.isArray(report.scenarios)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
  });
});
