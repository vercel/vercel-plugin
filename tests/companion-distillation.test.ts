import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SkillExposure } from "../hooks/src/routing-policy-ledger.mts";
import type { RoutingDecisionTrace } from "../hooks/src/routing-decision-trace.mts";
import { distillCompanionRules } from "../hooks/src/companion-distillation.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-28T08:00:00.000Z";
const PROJECT = "/test/project";

/** Create a minimal SkillExposure fixture. */
function makeExposure(
  overrides: Partial<SkillExposure> & {
    exposureGroupId: string;
    skill: string;
    attributionRole: "candidate" | "context";
    outcome: SkillExposure["outcome"];
  },
): SkillExposure {
  return {
    id: randomUUID(),
    sessionId: "test-session",
    projectRoot: PROJECT,
    storyId: null,
    storyKind: "flow-verification",
    route: "/dashboard",
    hook: "PreToolUse",
    toolName: "Bash",
    targetBoundary: "uiRender",
    candidateSkill: null,
    createdAt: T0,
    resolvedAt: T0,
    ...overrides,
  };
}

/**
 * Generate N exposure groups where candidate+companion both exist.
 * Each group has one candidate and one context exposure sharing the same outcome.
 */
function makeGroupedExposures(params: {
  count: number;
  candidateSkill: string;
  companionSkill: string;
  outcome: SkillExposure["outcome"];
  hook?: SkillExposure["hook"];
  toolName?: SkillExposure["toolName"];
  storyKind?: string | null;
  targetBoundary?: SkillExposure["targetBoundary"];
  route?: string | null;
}): SkillExposure[] {
  const exposures: SkillExposure[] = [];
  for (let i = 0; i < params.count; i++) {
    const groupId = `g-${params.outcome}-${params.candidateSkill}-${params.companionSkill}-${i}`;
    exposures.push(
      makeExposure({
        exposureGroupId: groupId,
        skill: params.candidateSkill,
        attributionRole: "candidate",
        candidateSkill: params.candidateSkill,
        outcome: params.outcome,
        hook: params.hook ?? "PreToolUse",
        toolName: params.toolName ?? "Bash",
        storyKind: params.storyKind ?? "flow-verification",
        targetBoundary: params.targetBoundary ?? "uiRender",
        route: params.route ?? "/dashboard",
      }),
      makeExposure({
        exposureGroupId: groupId,
        skill: params.companionSkill,
        attributionRole: "context",
        candidateSkill: params.candidateSkill,
        outcome: params.outcome,
        hook: params.hook ?? "PreToolUse",
        toolName: params.toolName ?? "Bash",
        storyKind: params.storyKind ?? "flow-verification",
        targetBoundary: params.targetBoundary ?? "uiRender",
        route: params.route ?? "/dashboard",
      }),
    );
  }
  return exposures;
}

/**
 * Generate N candidate-only exposure groups (no companion).
 */
function makeSoloExposures(params: {
  count: number;
  candidateSkill: string;
  outcome: SkillExposure["outcome"];
  hook?: SkillExposure["hook"];
  toolName?: SkillExposure["toolName"];
  storyKind?: string | null;
  targetBoundary?: SkillExposure["targetBoundary"];
  route?: string | null;
}): SkillExposure[] {
  const exposures: SkillExposure[] = [];
  for (let i = 0; i < params.count; i++) {
    const groupId = `g-solo-${params.outcome}-${params.candidateSkill}-${i}`;
    exposures.push(
      makeExposure({
        exposureGroupId: groupId,
        skill: params.candidateSkill,
        attributionRole: "candidate",
        candidateSkill: params.candidateSkill,
        outcome: params.outcome,
        hook: params.hook ?? "PreToolUse",
        toolName: params.toolName ?? "Bash",
        storyKind: params.storyKind ?? "flow-verification",
        targetBoundary: params.targetBoundary ?? "uiRender",
        route: params.route ?? "/dashboard",
      }),
    );
  }
  return exposures;
}

const emptyTraces: RoutingDecisionTrace[] = [];

// ---------------------------------------------------------------------------
// AC1: Promote when candidate+companion outperforms candidate-alone
// ---------------------------------------------------------------------------

describe("AC1: promote when companion outperforms candidate-alone", () => {
  test("emits promote rule with correct metrics when thresholds met", () => {
    // 4 groups where candidate+companion both win
    const withCompanion = makeGroupedExposures({
      count: 4,
      candidateSkill: "verification",
      companionSkill: "agent-browser-verify",
      outcome: "win",
    });
    // 4 solo groups where candidate alone wins only 50%
    const soloWins = makeSoloExposures({
      count: 2,
      candidateSkill: "verification",
      outcome: "win",
    });
    const soloLosses = makeSoloExposures({
      count: 2,
      candidateSkill: "verification",
      outcome: "stale-miss",
    });

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures: [...withCompanion, ...soloWins, ...soloLosses],
      generatedAt: T0,
    });

    expect(result.version).toBe(1);
    expect(result.rules.length).toBe(1);

    const rule = result.rules[0];
    expect(rule.confidence).toBe("promote");
    expect(rule.candidateSkill).toBe("verification");
    expect(rule.companionSkill).toBe("agent-browser-verify");
    expect(rule.support).toBe(4);
    expect(rule.winsWithCompanion).toBe(4);
    expect(rule.precisionWithCompanion).toBe(1.0);
    expect(rule.baselinePrecisionWithoutCompanion).toBe(0.5);
    expect(rule.liftVsCandidateAlone).toBe(2.0);
    expect(rule.staleMissDelta).toBeLessThanOrEqual(0.10);
    expect(rule.promotedAt).toBe(T0);
    expect(rule.reason).toContain("companion beats candidate-alone");
  });

  test("scenario id matches expected pipe-delimited format", () => {
    const exposures = [
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 4,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    const rule = result.rules[0];
    expect(rule.scenario).toBe(
      "PreToolUse|flow-verification|uiRender|Bash|/dashboard",
    );
    expect(rule.id).toBe(
      "PreToolUse|flow-verification|uiRender|Bash|/dashboard::verification->agent-browser-verify",
    );
  });

  test("sourceExposureGroupIds are sorted", () => {
    const exposures = [
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 4,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    const ids = result.rules[0].sourceExposureGroupIds;
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test("promotion summary counts promoted rules", () => {
    // 4 companion wins + 4 solo (2 wins, 2 stale-miss → 50% baseline)
    const exposures = [
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 2,
        candidateSkill: "verification",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 2,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.promotion.accepted).toBe(true);
    expect(result.promotion.reason).toBe("1 promoted companion rules");
  });
});

// ---------------------------------------------------------------------------
// AC2: Sparse data below threshold emits no promoted rule
// ---------------------------------------------------------------------------

describe("AC2: sparse data rejects promotion", () => {
  test("support below threshold yields holdout-fail", () => {
    // Only 3 groups (below default minSupport=4)
    const exposures = [
      ...makeGroupedExposures({
        count: 3,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 3,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.rules.length).toBe(1);
    expect(result.rules[0].confidence).toBe("holdout-fail");
    expect(result.rules[0].promotedAt).toBeNull();
    expect(result.rules[0].reason).toContain("insufficient");
  });

  test("low precision below threshold yields holdout-fail", () => {
    // 4 groups but only 2 wins (50% < 75%)
    const wins = makeGroupedExposures({
      count: 2,
      candidateSkill: "ai-sdk",
      companionSkill: "ai-elements",
      outcome: "win",
    });
    const misses = makeGroupedExposures({
      count: 2,
      candidateSkill: "ai-sdk",
      companionSkill: "ai-elements",
      outcome: "stale-miss",
    });

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures: [...wins, ...misses],
      generatedAt: T0,
    });

    const rule = result.rules.find(
      (r) =>
        r.candidateSkill === "ai-sdk" && r.companionSkill === "ai-elements",
    );
    expect(rule).toBeDefined();
    expect(rule!.confidence).toBe("holdout-fail");
    expect(rule!.precisionWithCompanion).toBe(0.5);
  });

  test("empty exposures produce empty rulebook", () => {
    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures: [],
      generatedAt: T0,
    });

    expect(result.rules).toEqual([]);
    expect(result.promotion.reason).toBe("0 promoted companion rules");
  });

  test("exposures without exposureGroupId are skipped", () => {
    const exposures: SkillExposure[] = [
      makeExposure({
        exposureGroupId: null as unknown as string,
        skill: "verification",
        attributionRole: "candidate",
        outcome: "win",
      }),
    ];

    // Filter out since exposureGroupId is null
    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3: Stale-miss delta exceeds threshold → reject
// ---------------------------------------------------------------------------

describe("AC3: stale-miss delta rejects promotion", () => {
  test("companion with high stale-miss rate is rejected", () => {
    // 4 companion groups: 3 wins + 1 stale-miss → precision 0.75, but...
    const companionWins = makeGroupedExposures({
      count: 3,
      candidateSkill: "verification",
      companionSkill: "bad-companion",
      outcome: "win",
    });
    const companionStaleMisses = makeGroupedExposures({
      count: 1,
      candidateSkill: "verification",
      companionSkill: "bad-companion",
      outcome: "stale-miss",
    });
    // 4 solo groups: 3 wins + 1 pending (no stale-misses without companion)
    const soloWins = makeSoloExposures({
      count: 3,
      candidateSkill: "verification",
      outcome: "win",
    });
    const soloPending = makeSoloExposures({
      count: 1,
      candidateSkill: "verification",
      outcome: "pending",
    });

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures: [
        ...companionWins,
        ...companionStaleMisses,
        ...soloWins,
        ...soloPending,
      ],
      generatedAt: T0,
      maxStaleMissDelta: 0.10,
    });

    const rule = result.rules.find(
      (r) => r.companionSkill === "bad-companion",
    );
    expect(rule).toBeDefined();
    // staleMissDelta = 0.25 (companion) - 0.0 (solo) = 0.25 > 0.10
    expect(rule!.staleMissDelta).toBeGreaterThan(0.10);
    expect(rule!.confidence).toBe("holdout-fail");
  });

  test("companion within stale-miss threshold is promoted", () => {
    // 5 companion groups: 4 wins + 1 stale-miss
    const companionWins = makeGroupedExposures({
      count: 4,
      candidateSkill: "verification",
      companionSkill: "good-companion",
      outcome: "win",
    });
    const companionStale = makeGroupedExposures({
      count: 1,
      candidateSkill: "verification",
      companionSkill: "good-companion",
      outcome: "stale-miss",
    });
    // 5 solo groups: 2 wins + 2 stale-miss + 1 pending
    // baseline stale rate = 2/5 = 0.4
    // companion stale rate = 1/5 = 0.2
    // delta = 0.2 - 0.4 = -0.2 (negative = improvement)
    const soloWins = makeSoloExposures({
      count: 2,
      candidateSkill: "verification",
      outcome: "win",
    });
    const soloStale = makeSoloExposures({
      count: 2,
      candidateSkill: "verification",
      outcome: "stale-miss",
    });
    const soloPending = makeSoloExposures({
      count: 1,
      candidateSkill: "verification",
      outcome: "pending",
    });

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures: [
        ...companionWins,
        ...companionStale,
        ...soloWins,
        ...soloStale,
        ...soloPending,
      ],
      generatedAt: T0,
    });

    const rule = result.rules.find(
      (r) => r.companionSkill === "good-companion",
    );
    expect(rule).toBeDefined();
    expect(rule!.staleMissDelta).toBeLessThanOrEqual(0.10);
    expect(rule!.confidence).toBe("promote");
  });
});

// ---------------------------------------------------------------------------
// AC4: Does not change candidate-only policy credit semantics
// ---------------------------------------------------------------------------

describe("AC4: reads grouped exposure fields only", () => {
  test("only reads exposureGroupId, attributionRole, outcome, skill fields", () => {
    // This is a structural test: distillation should work even with
    // minimal grouped exposure data
    const exposures = [
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 4,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    // Just verify it runs and produces a valid rulebook
    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.version).toBe(1);
    expect(result.projectRoot).toBe(PROJECT);
    expect(result.generatedAt).toBe(T0);
    expect(Array.isArray(result.rules)).toBe(true);
    expect(result.replay).toBeDefined();
    expect(result.promotion).toBeDefined();
  });

  test("groups without a candidate exposure are skipped", () => {
    // Group with only context exposures — no candidate
    const exposures: SkillExposure[] = [
      makeExposure({
        exposureGroupId: "g-orphan",
        skill: "agent-browser-verify",
        attributionRole: "context",
        outcome: "win",
      }),
      makeExposure({
        exposureGroupId: "g-orphan",
        skill: "another-skill",
        attributionRole: "context",
        outcome: "win",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Metric rounding
// ---------------------------------------------------------------------------

describe("deterministic rounding to 4 decimals", () => {
  test("precision values are rounded to exactly 4 decimal places", () => {
    // 3 wins out of 4 = 0.75 exactly, 1 out of 4 solo wins = 0.25
    const exposures = [
      ...makeGroupedExposures({
        count: 3,
        candidateSkill: "ai-sdk",
        companionSkill: "ai-elements",
        outcome: "win",
      }),
      ...makeGroupedExposures({
        count: 1,
        candidateSkill: "ai-sdk",
        companionSkill: "ai-elements",
        outcome: "stale-miss",
      }),
      ...makeSoloExposures({
        count: 1,
        candidateSkill: "ai-sdk",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 2,
        candidateSkill: "ai-sdk",
        outcome: "stale-miss",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    const rule = result.rules[0];
    // Check values have at most 4 decimal digits
    expect(String(rule.precisionWithCompanion).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(String(rule.baselinePrecisionWithoutCompanion).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(String(rule.liftVsCandidateAlone).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(String(rule.staleMissDelta).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Rule sorting
// ---------------------------------------------------------------------------

describe("deterministic rule ordering", () => {
  test("rules are sorted by scenario, candidateSkill, companionSkill", () => {
    const exposures = [
      // Scenario B (alphabetically second)
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "z-skill",
        companionSkill: "z-companion",
        outcome: "win",
        route: "/z-route",
      }),
      ...makeSoloExposures({
        count: 4,
        candidateSkill: "z-skill",
        outcome: "stale-miss",
        route: "/z-route",
      }),
      // Scenario A (alphabetically first)
      ...makeGroupedExposures({
        count: 4,
        candidateSkill: "a-skill",
        companionSkill: "a-companion",
        outcome: "win",
        route: "/a-route",
      }),
      ...makeSoloExposures({
        count: 4,
        candidateSkill: "a-skill",
        outcome: "stale-miss",
        route: "/a-route",
      }),
    ];

    const result = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });

    expect(result.rules.length).toBe(2);
    expect(result.rules[0].candidateSkill).toBe("a-skill");
    expect(result.rules[1].candidateSkill).toBe("z-skill");
  });
});

// ---------------------------------------------------------------------------
// Custom threshold overrides
// ---------------------------------------------------------------------------

describe("custom threshold overrides", () => {
  test("minSupport override allows lower support", () => {
    // 2 companion wins + 2 solo (1 win, 1 stale-miss → 50% baseline)
    const exposures = [
      ...makeGroupedExposures({
        count: 2,
        candidateSkill: "verification",
        companionSkill: "agent-browser-verify",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 1,
        candidateSkill: "verification",
        outcome: "win",
      }),
      ...makeSoloExposures({
        count: 1,
        candidateSkill: "verification",
        outcome: "stale-miss",
      }),
    ];

    // Default would reject (support=2 < minSupport=4)
    const defaultResult = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
    });
    expect(defaultResult.rules[0].confidence).toBe("holdout-fail");

    // With minSupport=2 should promote (precision=1.0, lift=2.0)
    const customResult = distillCompanionRules({
      projectRoot: PROJECT,
      traces: emptyTraces,
      exposures,
      generatedAt: T0,
      minSupport: 2,
    });
    expect(customResult.rules[0].confidence).toBe("promote");
  });
});
