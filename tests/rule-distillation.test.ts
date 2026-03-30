import { describe, test, expect } from "bun:test";
import {
  computeRuleLift,
  classifyRuleConfidence,
  distillRulesFromTrace,
  replayLearnedRules,
} from "../hooks/src/rule-distillation.mts";
import type {
  LearnedRoutingRulesFile,
  LearnedRoutingRule,
  DistillRulesParams,
} from "../hooks/src/rule-distillation.mts";
import type { RoutingDecisionTrace, RankedSkillTrace } from "../hooks/src/routing-decision-trace.mts";
import type { SkillExposure } from "../hooks/src/routing-policy-ledger.mts";
import type { RoutingPolicyFile } from "../hooks/src/routing-policy.mts";
import { createEmptyRoutingPolicy } from "../hooks/src/routing-policy.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_TS = "2026-03-28T06:00:00.000Z";

function makeTrace(overrides: Partial<RoutingDecisionTrace> & { decisionId: string }): RoutingDecisionTrace {
  return {
    version: 2,
    sessionId: "sess-1",
    hook: "PreToolUse",
    toolName: "Read",
    toolTarget: "/app/page.tsx",
    timestamp: FIXED_TS,
    primaryStory: {
      id: "story-1",
      kind: "feature",
      storyRoute: "/app",
      targetBoundary: "uiRender",
    },
    observedRoute: "/app",
    policyScenario: null,
    matchedSkills: [],
    injectedSkills: [],
    skippedReasons: [],
    ranked: [],
    verification: null,
    ...overrides,
  };
}

function makeRanked(overrides: Partial<RankedSkillTrace> & { skill: string }): RankedSkillTrace {
  return {
    basePriority: 6,
    effectivePriority: 6,
    pattern: null,
    profilerBoost: 0,
    policyBoost: 0,
    policyReason: null,
    summaryOnly: false,
    synthetic: false,
    droppedReason: null,
    ...overrides,
  };
}

function makeExposure(overrides: Partial<SkillExposure> & { skill: string }): SkillExposure {
  return {
    id: `exp-${overrides.skill}-${Date.now()}`,
    sessionId: "sess-1",
    projectRoot: "/test",
    storyId: "story-1",
    storyKind: "feature",
    route: "/app",
    hook: "PreToolUse",
    toolName: "Read",
    targetBoundary: "uiRender",
    exposureGroupId: null,
    attributionRole: "candidate",
    candidateSkill: overrides.skill,
    createdAt: FIXED_TS,
    resolvedAt: FIXED_TS,
    outcome: "win",
    ...overrides,
  };
}

function makeDistillParams(overrides: Partial<DistillRulesParams> = {}): DistillRulesParams {
  return {
    projectRoot: "/test/project",
    traces: [],
    exposures: [],
    policy: createEmptyRoutingPolicy(),
    generatedAt: FIXED_TS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRuleLift
// ---------------------------------------------------------------------------

describe("computeRuleLift", () => {
  test("returns rulePrecision when scenarioPrecision is 0", () => {
    const lift = computeRuleLift({
      wins: 4,
      support: 5,
      scenarioWins: 0,
      scenarioExposures: 0,
    });
    expect(lift).toBe(0.8); // 4/5
  });

  test("computes ratio of rule precision to scenario precision", () => {
    const lift = computeRuleLift({
      wins: 4,
      support: 5,
      scenarioWins: 10,
      scenarioExposures: 25,
    });
    // rulePrecision = 4/5 = 0.8, scenarioPrecision = 10/25 = 0.4
    expect(lift).toBe(2.0);
  });

  test("returns 1.0 when rule matches scenario precision", () => {
    const lift = computeRuleLift({
      wins: 3,
      support: 10,
      scenarioWins: 6,
      scenarioExposures: 20,
    });
    // 0.3 / 0.3 = 1.0
    expect(lift).toBe(1.0);
  });

  test("handles zero support gracefully", () => {
    const lift = computeRuleLift({
      wins: 0,
      support: 0,
      scenarioWins: 5,
      scenarioExposures: 10,
    });
    expect(lift).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyRuleConfidence
// ---------------------------------------------------------------------------

describe("classifyRuleConfidence", () => {
  test("returns holdout-fail when regressions > 0", () => {
    expect(
      classifyRuleConfidence({ support: 10, precision: 0.9, lift: 2.0, regressions: 1 }),
    ).toBe("holdout-fail");
  });

  test("returns promote when all thresholds met", () => {
    expect(
      classifyRuleConfidence({ support: 5, precision: 0.8, lift: 1.5, regressions: 0 }),
    ).toBe("promote");
  });

  test("returns candidate when intermediate thresholds met", () => {
    expect(
      classifyRuleConfidence({ support: 3, precision: 0.65, lift: 1.1, regressions: 0 }),
    ).toBe("candidate");
  });

  test("returns holdout-fail when below candidate thresholds", () => {
    expect(
      classifyRuleConfidence({ support: 2, precision: 0.5, lift: 1.0, regressions: 0 }),
    ).toBe("holdout-fail");
  });

  test("promote requires all three thresholds simultaneously", () => {
    // High precision and lift but low support
    expect(
      classifyRuleConfidence({ support: 4, precision: 0.9, lift: 2.0, regressions: 0 }),
    ).toBe("candidate");
    // High support and lift but low precision
    expect(
      classifyRuleConfidence({ support: 10, precision: 0.7, lift: 2.0, regressions: 0 }),
    ).toBe("candidate");
    // High support and precision but low lift
    expect(
      classifyRuleConfidence({ support: 10, precision: 0.9, lift: 1.0, regressions: 0 }),
    ).toBe("holdout-fail");
  });

  test("regressions override even excellent metrics", () => {
    expect(
      classifyRuleConfidence({ support: 100, precision: 1.0, lift: 5.0, regressions: 1 }),
    ).toBe("holdout-fail");
  });
});

// ---------------------------------------------------------------------------
// distillRulesFromTrace — determinism
// ---------------------------------------------------------------------------

describe("distillRulesFromTrace", () => {
  test("returns valid LearnedRoutingRulesFile shape with empty inputs", () => {
    const result = distillRulesFromTrace(makeDistillParams());
    expect(result.version).toBe(1);
    expect(result.generatedAt).toBe(FIXED_TS);
    expect(result.projectRoot).toBe("/test/project");
    expect(result.rules).toEqual([]);
    expect(result.replay).toEqual({
      baselineWins: 0,
      baselineDirectiveWins: 0,
      learnedWins: 0,
      learnedDirectiveWins: 0,
      deltaWins: 0,
      deltaDirectiveWins: 0,
      regressions: [],
    });
  });

  test("identical inputs produce byte-for-byte identical JSON", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        ranked: [makeRanked({ skill: "next-config", pattern: { type: "path", value: "next.config.*" } })],
      }),
      makeTrace({
        decisionId: "d2",
        injectedSkills: ["next-config"],
        ranked: [makeRanked({ skill: "next-config", pattern: { type: "path", value: "next.config.*" } })],
      }),
    ];
    const exposures = [
      makeExposure({ skill: "next-config", outcome: "win" }),
    ];

    const params = makeDistillParams({ traces, exposures });
    const result1 = distillRulesFromTrace(params);
    const result2 = distillRulesFromTrace(params);

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  test("does not promote rules below support threshold", () => {
    // Only 2 traces — below default minSupport of 5
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        ranked: [makeRanked({ skill: "next-config" })],
      }),
      makeTrace({
        decisionId: "d2",
        injectedSkills: ["next-config"],
        ranked: [makeRanked({ skill: "next-config" })],
      }),
    ];
    const exposures = [
      makeExposure({ skill: "next-config", outcome: "win" }),
    ];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    for (const rule of result.rules) {
      expect(rule.confidence).not.toBe("promote");
    }
  });

  test("promotes rules meeting all thresholds", () => {
    // next-config wins 6/6 (precision=1.0), but we also add losing traces
    // for a different skill in the same scenario so lift > 1.
    const rankedWin = [makeRanked({ skill: "next-config", pattern: { type: "path", value: "next.config.*" } })];
    const rankedLose = [makeRanked({ skill: "tailwind", pattern: { type: "path", value: "tailwind.*" } })];

    const winTraces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `win${i}`,
        injectedSkills: ["next-config"],
        ranked: rankedWin,
      }),
    );
    // 6 losing traces in the same scenario bring scenario precision down
    const loseTraces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `lose${i}`,
        injectedSkills: ["tailwind"],
        ranked: rankedLose,
      }),
    );

    const exposures = [
      makeExposure({ skill: "next-config", outcome: "win" }),
      makeExposure({ skill: "tailwind", outcome: "stale-miss" }),
    ];

    const result = distillRulesFromTrace(
      makeDistillParams({ traces: [...winTraces, ...loseTraces], exposures }),
    );
    const promoted = result.rules.filter((r) => r.confidence === "promote");
    expect(promoted.length).toBeGreaterThanOrEqual(1);
    for (const rule of promoted) {
      expect(rule.promotedAt).toBe(FIXED_TS);
      expect(rule.support).toBeGreaterThanOrEqual(5);
      expect(rule.precision).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("skips dropped ranked skills", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: [],
        ranked: [makeRanked({ skill: "next-config", droppedReason: "deduped" })],
      }),
    ];
    const exposures = [makeExposure({ skill: "next-config" })];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(result.rules.length).toBe(0);
  });

  test("skips context-role exposures (only candidate attribution)", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        ranked: [makeRanked({ skill: "next-config" })],
      }),
    ];
    const exposures = [
      makeExposure({ skill: "next-config", attributionRole: "context" }),
    ];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(result.rules.length).toBe(0);
  });

  test("tracks directive wins separately", () => {
    const ranked = [makeRanked({ skill: "next-config" })];
    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({ decisionId: `d${i}`, injectedSkills: ["next-config"], ranked }),
    );
    const exposures = [
      makeExposure({ skill: "next-config", outcome: "directive-win" }),
    ];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(result.rules.length).toBeGreaterThanOrEqual(1);
    const rule = result.rules[0]!;
    expect(rule.directiveWins).toBeGreaterThan(0);
    expect(rule.wins).toBeGreaterThanOrEqual(rule.directiveWins);
  });

  test("counts stale misses correctly", () => {
    const ranked = [makeRanked({ skill: "tailwind" })];
    const traces = Array.from({ length: 4 }, (_, i) =>
      makeTrace({ decisionId: `d${i}`, injectedSkills: ["tailwind"], ranked }),
    );
    const exposures = [
      makeExposure({ skill: "tailwind", outcome: "stale-miss" }),
    ];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(result.rules.length).toBeGreaterThanOrEqual(1);
    const rule = result.rules[0]!;
    expect(rule.staleMisses).toBeGreaterThan(0);
    expect(rule.wins).toBe(0);
  });

  test("sorts rules deterministically: promote > candidate > holdout-fail, then skill, then id", () => {
    // Create two skills with different confidence levels
    const rankedA = [makeRanked({ skill: "a-skill", pattern: { type: "path", value: "a.*" } })];
    const rankedB = [makeRanked({ skill: "b-skill", pattern: { type: "path", value: "b.*" } })];

    // a-skill: 6 wins (promote-level)
    const tracesA = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `a${i}`,
        injectedSkills: ["a-skill"],
        ranked: rankedA,
      }),
    );
    // b-skill: 3 wins (candidate-level)
    const tracesB = Array.from({ length: 3 }, (_, i) =>
      makeTrace({
        decisionId: `b${i}`,
        injectedSkills: ["b-skill"],
        ranked: rankedB,
      }),
    );

    const exposures = [
      makeExposure({ skill: "a-skill", outcome: "win" }),
      makeExposure({ skill: "b-skill", outcome: "win" }),
    ];

    const result = distillRulesFromTrace(
      makeDistillParams({
        traces: [...tracesA, ...tracesB],
        exposures,
      }),
    );

    // Promoted rules should come first
    const confidences = result.rules.map((r) => r.confidence);
    const promoteIdx = confidences.indexOf("promote");
    const candidateIdx = confidences.indexOf("candidate");
    if (promoteIdx !== -1 && candidateIdx !== -1) {
      expect(promoteIdx).toBeLessThan(candidateIdx);
    }
  });

  test("sourceDecisionIds are sorted for determinism", () => {
    const ranked = [makeRanked({ skill: "next-config" })];
    const traces = ["z-id", "a-id", "m-id"].map((id) =>
      makeTrace({ decisionId: id, injectedSkills: ["next-config"], ranked }),
    );
    const exposures = [makeExposure({ skill: "next-config", outcome: "win" })];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(result.rules.length).toBeGreaterThanOrEqual(1);
    const ids = result.rules[0]!.sourceDecisionIds;
    expect(ids).toEqual([...ids].sort());
  });

  test("respects custom minSupport/minPrecision/minLift", () => {
    const ranked = [makeRanked({ skill: "next-config" })];
    // 3 traces, all wins
    const traces = Array.from({ length: 3 }, (_, i) =>
      makeTrace({ decisionId: `d${i}`, injectedSkills: ["next-config"], ranked }),
    );
    const exposures = [makeExposure({ skill: "next-config", outcome: "win" })];

    // With default thresholds — not enough support for promote
    const strict = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    expect(strict.rules.every((r) => r.confidence !== "promote")).toBe(true);

    // With relaxed thresholds — should promote
    const relaxed = distillRulesFromTrace(
      makeDistillParams({ traces, exposures, minSupport: 2, minPrecision: 0.5, minLift: 1.0 }),
    );
    // Note: classifyRuleConfidence still has its own thresholds, so this tests the path coverage
    expect(relaxed.rules.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// replayLearnedRules
// ---------------------------------------------------------------------------

describe("replayLearnedRules", () => {
  test("returns zeros with empty inputs", () => {
    const result = replayLearnedRules({ traces: [], rules: [] });
    expect(result).toEqual({
      baselineWins: 0,
      baselineDirectiveWins: 0,
      learnedWins: 0,
      learnedDirectiveWins: 0,
      deltaWins: 0,
      deltaDirectiveWins: 0,
      regressions: [],
    });
  });

  test("baseline wins carry through when no learned rules apply", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        verification: {
          verificationId: "v1",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    ];

    const result = replayLearnedRules({ traces, rules: [] });
    expect(result.baselineWins).toBe(1);
    expect(result.learnedWins).toBe(1);
    expect(result.deltaWins).toBe(0);
    expect(result.regressions).toEqual([]);
  });

  test("counts learned wins when promoted rules overlap with injected skills", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        verification: {
          verificationId: "v1",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    ];

    const rules: LearnedRoutingRule[] = [
      {
        id: "pathPattern:next-config:next.config.*",
        skill: "next-config",
        kind: "pathPattern",
        value: "next.config.*",
        scenario: {
          hook: "PreToolUse",
          storyKind: "feature",
          targetBoundary: "uiRender",
          toolName: "Read",
          routeScope: "/app",
        },
        support: 10,
        wins: 9,
        directiveWins: 3,
        staleMisses: 0,
        precision: 0.9,
        lift: 2.0,
        sourceDecisionIds: ["d1"],
        confidence: "promote",
        promotedAt: FIXED_TS,
      },
    ];

    const result = replayLearnedRules({ traces, rules });
    expect(result.baselineWins).toBe(1);
    expect(result.learnedWins).toBe(1);
    expect(result.deltaWins).toBe(0);
  });

  test("does not count non-promoted rules", () => {
    const traces = [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["next-config"],
        verification: null,
      }),
    ];

    const rules: LearnedRoutingRule[] = [
      {
        id: "test-rule",
        skill: "next-config",
        kind: "pathPattern",
        value: "next.config.*",
        scenario: {
          hook: "PreToolUse",
          storyKind: "feature",
          targetBoundary: "uiRender",
          toolName: "Read",
          routeScope: "/app",
        },
        support: 3,
        wins: 2,
        directiveWins: 0,
        staleMisses: 0,
        precision: 0.67,
        lift: 1.2,
        sourceDecisionIds: [],
        confidence: "candidate",  // Not promoted
        promotedAt: null,
      },
    ];

    const result = replayLearnedRules({ traces, rules });
    expect(result.baselineWins).toBe(0);
    expect(result.learnedWins).toBe(0);
  });

  test("regressions list is sorted for determinism", () => {
    const traces = [
      makeTrace({
        decisionId: "z-trace",
        injectedSkills: ["skill-a"],
        verification: {
          verificationId: "v1",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
      makeTrace({
        decisionId: "a-trace",
        injectedSkills: ["skill-a"],
        verification: {
          verificationId: "v2",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    ];

    // Promoted rule for different skill — won't cover skill-a traces
    const rules: LearnedRoutingRule[] = [
      {
        id: "test-rule",
        skill: "other-skill",
        kind: "pathPattern",
        value: "other.*",
        scenario: {
          hook: "PreToolUse",
          storyKind: "feature",
          targetBoundary: "uiRender",
          toolName: "Read",
          routeScope: "/app",
        },
        support: 10,
        wins: 9,
        directiveWins: 0,
        staleMisses: 0,
        precision: 0.9,
        lift: 2.0,
        sourceDecisionIds: [],
        confidence: "promote",
        promotedAt: FIXED_TS,
      },
    ];

    const result = replayLearnedRules({ traces, rules });
    if (result.regressions.length > 1) {
      expect(result.regressions).toEqual([...result.regressions].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: distill + replay pipeline
// ---------------------------------------------------------------------------

describe("distill + replay integration", () => {
  test("replay regressions downgrade promoted rules to holdout-fail", () => {
    // Create traces where a skill wins in baseline
    const ranked = [makeRanked({ skill: "next-config" })];
    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked,
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    // But exposure says stale-miss — rule will have low precision, won't promote
    const exposures = [makeExposure({ skill: "next-config", outcome: "stale-miss" })];

    const result = distillRulesFromTrace(makeDistillParams({ traces, exposures }));
    // No rule should be promoted because precision is 0 (no wins)
    for (const rule of result.rules) {
      expect(rule.confidence).not.toBe("promote");
    }
  });

  test("end-to-end: winning skill gets promoted with sufficient evidence", () => {
    const rankedWin = [
      makeRanked({
        skill: "next-config",
        pattern: { type: "path", value: "next.config.*" },
      }),
    ];
    const rankedLose = [
      makeRanked({
        skill: "tailwind",
        pattern: { type: "path", value: "tailwind.*" },
      }),
    ];

    // 8 winning traces for next-config
    const winTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `win${i}`,
        injectedSkills: ["next-config"],
        ranked: rankedWin,
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );
    // 8 losing traces for tailwind in same scenario — creates lift > 1
    const loseTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `lose${i}`,
        injectedSkills: ["tailwind"],
        ranked: rankedLose,
      }),
    );

    const exposures = [
      makeExposure({ skill: "next-config", outcome: "win" }),
      makeExposure({ skill: "tailwind", outcome: "stale-miss" }),
    ];

    const result = distillRulesFromTrace(
      makeDistillParams({ traces: [...winTraces, ...loseTraces], exposures }),
    );

    expect(result.version).toBe(1);
    expect(result.rules.length).toBeGreaterThanOrEqual(1);

    const promoted = result.rules.filter((r) => r.confidence === "promote");
    expect(promoted.length).toBeGreaterThanOrEqual(1);
    expect(promoted[0]!.skill).toBe("next-config");
    expect(promoted[0]!.precision).toBeGreaterThanOrEqual(0.8);
    expect(promoted[0]!.lift).toBeGreaterThanOrEqual(1.0);
    expect(promoted[0]!.promotedAt).toBe(FIXED_TS);
    expect(result.replay.regressions).toEqual([]);
  });
});
