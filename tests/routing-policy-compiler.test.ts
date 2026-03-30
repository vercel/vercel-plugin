import { describe, test, expect } from "bun:test";
import {
  compilePolicyPatch,
  applyPolicyPatch,
  evaluatePromotionGate,
  type PolicyPatchReport,
  type PolicyPatchEntry,
  type PromotionArtifact,
  type PromotionGateResult,
} from "../hooks/src/routing-policy-compiler.mts";
import {
  createEmptyRoutingPolicy,
  recordExposure,
  recordOutcome,
  derivePolicyBoost,
  applyRulebookBoosts,
  type RoutingPolicyFile,
} from "../hooks/src/routing-policy.mts";
import type {
  RoutingReplayReport,
  RoutingRecommendation,
} from "../hooks/src/routing-replay.mts";
import type { ReplayResult } from "../hooks/src/rule-distillation.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";

const SCENARIO_A = "PreToolUse|flow-verification|uiRender|Bash";
const SCENARIO_B = "UserPromptSubmit|none|none|Prompt";

function makeReport(
  overrides: Partial<RoutingReplayReport> = {},
): RoutingReplayReport {
  return {
    version: 1,
    sessionId: "test-session-compiler",
    traceCount: 10,
    scenarioCount: 1,
    scenarios: [],
    recommendations: [],
    ...overrides,
  };
}

function makeRec(
  overrides: Partial<RoutingRecommendation> = {},
): RoutingRecommendation {
  return {
    scenario: SCENARIO_A,
    skill: "agent-browser-verify",
    action: "promote",
    suggestedBoost: 8,
    confidence: 0.99,
    reason: "4/4 wins in " + SCENARIO_A,
    ...overrides,
  };
}

// Helper: build a policy with stats that produce a known boost
function policyWithBoost(
  scenario: string,
  skill: string,
  targetBoost: number,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  const base = {
    hook: "PreToolUse" as const,
    storyKind: scenario.split("|")[1] === "none" ? null : scenario.split("|")[1],
    targetBoundary:
      scenario.split("|")[2] === "none"
        ? null
        : (scenario.split("|")[2] as "uiRender"),
    toolName: scenario.split("|")[3] as "Bash",
  };

  if (targetBoost === 8) {
    // 5 exposures, 5 wins → rate 1.0 → boost 8
    for (let i = 0; i < 5; i++) {
      recordExposure(policy, { ...base, skill, now: T0 });
      recordOutcome(policy, { ...base, skill, outcome: "win", now: T0 });
    }
  } else if (targetBoost === 5) {
    // 10 exposures, 7 wins → rate 0.70 → boost 5
    for (let i = 0; i < 10; i++) {
      recordExposure(policy, { ...base, skill, now: T0 });
    }
    for (let i = 0; i < 7; i++) {
      recordOutcome(policy, { ...base, skill, outcome: "win", now: T0 });
    }
  } else if (targetBoost === 2) {
    // 4 exposures, 2 wins → rate 0.50 → boost 2
    for (let i = 0; i < 4; i++) {
      recordExposure(policy, { ...base, skill, now: T0 });
    }
    for (let i = 0; i < 2; i++) {
      recordOutcome(policy, { ...base, skill, outcome: "win", now: T0 });
    }
  } else if (targetBoost === -2) {
    // 10 exposures, 1 win → rate 0.10 → boost -2
    for (let i = 0; i < 10; i++) {
      recordExposure(policy, { ...base, skill, now: T0 });
    }
    recordOutcome(policy, { ...base, skill, outcome: "win", now: T0 });
  }
  // targetBoost 0 → empty policy
  return policy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing-policy-compiler", () => {
  // -------------------------------------------------------------------------
  // Pure function contract
  // -------------------------------------------------------------------------

  describe("compilePolicyPatch is a pure function", () => {
    test("does not mutate the input policy", () => {
      const policy = createEmptyRoutingPolicy();
      const policySnapshot = JSON.stringify(policy);
      const report = makeReport({
        recommendations: [makeRec({ action: "promote" })],
      });

      compilePolicyPatch(policy, report);
      expect(JSON.stringify(policy)).toBe(policySnapshot);
    });

    test("does not mutate the input report", () => {
      const policy = createEmptyRoutingPolicy();
      const report = makeReport({
        recommendations: [makeRec({ action: "promote" })],
      });
      const reportSnapshot = JSON.stringify(report);

      compilePolicyPatch(policy, report);
      expect(JSON.stringify(report)).toBe(reportSnapshot);
    });

    test("returns version 1 with all required fields", () => {
      const patch = compilePolicyPatch(
        createEmptyRoutingPolicy(),
        makeReport(),
      );
      expect(patch.version).toBe(1);
      expect(typeof patch.sessionId).toBe("string");
      expect(typeof patch.patchCount).toBe("number");
      expect(Array.isArray(patch.entries)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Promote case
  // -------------------------------------------------------------------------

  describe("promote", () => {
    test("emits promote when policy has no existing boost", () => {
      const policy = createEmptyRoutingPolicy();
      const report = makeReport({
        recommendations: [makeRec({ action: "promote", suggestedBoost: 8 })],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      expect(patch.entries[0].action).toBe("promote");
      expect(patch.entries[0].currentBoost).toBe(0);
      expect(patch.entries[0].proposedBoost).toBe(8);
      expect(patch.entries[0].delta).toBe(8);
    });

    test("emits promote when current boost is lower than proposed", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", 2);
      const report = makeReport({
        recommendations: [makeRec({ action: "promote", suggestedBoost: 8 })],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      expect(patch.entries[0].action).toBe("promote");
      expect(patch.entries[0].currentBoost).toBe(2);
      expect(patch.entries[0].proposedBoost).toBe(8);
      expect(patch.entries[0].delta).toBe(6);
    });

    test("no-op when policy already has boost 8 for promote recommendation", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", 8);
      const report = makeReport({
        recommendations: [makeRec({ action: "promote", suggestedBoost: 8 })],
      });

      const patch = compilePolicyPatch(policy, report);
      // delta is 0, action is not investigate → filtered out
      expect(patch.patchCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Demote case
  // -------------------------------------------------------------------------

  describe("demote", () => {
    test("emits demote when policy has no existing boost", () => {
      const policy = createEmptyRoutingPolicy();
      const report = makeReport({
        recommendations: [
          makeRec({
            action: "demote",
            suggestedBoost: -2,
            confidence: 1.0,
            reason: "0/6 wins",
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      expect(patch.entries[0].action).toBe("demote");
      expect(patch.entries[0].currentBoost).toBe(0);
      expect(patch.entries[0].proposedBoost).toBe(-2);
      expect(patch.entries[0].delta).toBe(-2);
    });

    test("emits demote when current boost is higher than proposed", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", 5);
      const report = makeReport({
        recommendations: [
          makeRec({
            action: "demote",
            suggestedBoost: -2,
            confidence: 0.95,
            reason: "0/7 wins",
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      expect(patch.entries[0].action).toBe("demote");
      expect(patch.entries[0].currentBoost).toBe(5);
      expect(patch.entries[0].proposedBoost).toBe(-2);
      expect(patch.entries[0].delta).toBe(-7);
    });

    test("no-op when policy already at -2 for demote recommendation", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", -2);
      const report = makeReport({
        recommendations: [
          makeRec({
            action: "demote",
            suggestedBoost: -2,
            confidence: 1.0,
            reason: "0/10 wins",
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Investigate case
  // -------------------------------------------------------------------------

  describe("investigate", () => {
    test("always emits investigate entry even when delta is 0", () => {
      const policy = createEmptyRoutingPolicy();
      const report = makeReport({
        recommendations: [
          makeRec({
            action: "investigate",
            suggestedBoost: 0,
            confidence: 0.5,
            reason: "2/4 mixed results",
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      expect(patch.entries[0].action).toBe("investigate");
      expect(patch.entries[0].proposedBoost).toBe(0);
      expect(patch.entries[0].delta).toBe(0);
    });

    test("investigate with non-zero current boost still shows as investigate", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", 5);
      const report = makeReport({
        recommendations: [
          makeRec({
            action: "investigate",
            suggestedBoost: 0,
            confidence: 0.45,
            reason: "3/7 mixed results",
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(1);
      // Even though delta is -5, investigate action is preserved
      expect(patch.entries[0].action).toBe("investigate");
      expect(patch.entries[0].currentBoost).toBe(5);
      expect(patch.entries[0].delta).toBe(-5);
    });
  });

  // -------------------------------------------------------------------------
  // No-op case (empty recommendations)
  // -------------------------------------------------------------------------

  describe("no-op", () => {
    test("empty patch for report with no recommendations", () => {
      const patch = compilePolicyPatch(
        createEmptyRoutingPolicy(),
        makeReport({ recommendations: [] }),
      );
      expect(patch.patchCount).toBe(0);
      expect(patch.entries).toEqual([]);
    });

    test("filters out recommendations where current boost matches proposed", () => {
      const policy = policyWithBoost(SCENARIO_A, "agent-browser-verify", 8);
      const report = makeReport({
        recommendations: [makeRec({ action: "promote", suggestedBoost: 8 })],
      });

      const patch = compilePolicyPatch(policy, report);
      expect(patch.patchCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic ordering
  // -------------------------------------------------------------------------

  describe("deterministic patch ordering", () => {
    test("entries are sorted by scenario asc, skill asc", () => {
      const report = makeReport({
        recommendations: [
          makeRec({ scenario: SCENARIO_B, skill: "z-skill", action: "promote" }),
          makeRec({ scenario: SCENARIO_A, skill: "b-skill", action: "promote" }),
          makeRec({ scenario: SCENARIO_A, skill: "a-skill", action: "promote" }),
          makeRec({ scenario: SCENARIO_B, skill: "a-skill", action: "promote" }),
        ],
      });

      const patch = compilePolicyPatch(createEmptyRoutingPolicy(), report);

      const keys = patch.entries.map((e) => `${e.scenario}|${e.skill}`);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    test("produces identical JSON for identical input (deterministic)", () => {
      const policy = createEmptyRoutingPolicy();
      const report = makeReport({
        recommendations: [
          makeRec({ scenario: SCENARIO_A, skill: "skill-x", action: "promote" }),
          makeRec({
            scenario: SCENARIO_B,
            skill: "skill-y",
            action: "demote",
            suggestedBoost: -2,
          }),
        ],
      });

      const patch1 = compilePolicyPatch(policy, report);
      const patch2 = compilePolicyPatch(policy, report);

      expect(JSON.stringify(patch1)).toBe(JSON.stringify(patch2));
    });
  });

  // -------------------------------------------------------------------------
  // derivePolicyBoost alignment
  // -------------------------------------------------------------------------

  describe("reuses derivePolicyBoost thresholds", () => {
    test("promote maps to boost +8 (same as derivePolicyBoost >=80%)", () => {
      const patch = compilePolicyPatch(
        createEmptyRoutingPolicy(),
        makeReport({
          recommendations: [makeRec({ action: "promote" })],
        }),
      );
      expect(patch.entries[0].proposedBoost).toBe(8);
    });

    test("demote maps to boost -2 (same as derivePolicyBoost <15%)", () => {
      const patch = compilePolicyPatch(
        createEmptyRoutingPolicy(),
        makeReport({
          recommendations: [
            makeRec({ action: "demote", suggestedBoost: -2 }),
          ],
        }),
      );
      expect(patch.entries[0].proposedBoost).toBe(-2);
    });

    test("investigate maps to boost 0 (same as derivePolicyBoost no-change zone)", () => {
      const patch = compilePolicyPatch(
        createEmptyRoutingPolicy(),
        makeReport({
          recommendations: [
            makeRec({ action: "investigate", suggestedBoost: 0 }),
          ],
        }),
      );
      expect(patch.entries[0].proposedBoost).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-scenario, multi-skill fixture
  // -------------------------------------------------------------------------

  describe("complex fixture: multi-scenario multi-skill", () => {
    test("handles promote + demote + investigate in one report", () => {
      const policy = policyWithBoost(SCENARIO_A, "skill-stable", 8);
      const report = makeReport({
        sessionId: "complex-fixture",
        recommendations: [
          // promote from 0 → 8
          makeRec({
            scenario: SCENARIO_A,
            skill: "skill-new",
            action: "promote",
            suggestedBoost: 8,
            confidence: 0.95,
          }),
          // already at 8 → no-op (filtered)
          makeRec({
            scenario: SCENARIO_A,
            skill: "skill-stable",
            action: "promote",
            suggestedBoost: 8,
            confidence: 0.99,
          }),
          // demote from 0 → -2
          makeRec({
            scenario: SCENARIO_B,
            skill: "skill-bad",
            action: "demote",
            suggestedBoost: -2,
            confidence: 1.0,
          }),
          // investigate from 0 → 0
          makeRec({
            scenario: SCENARIO_B,
            skill: "skill-mixed",
            action: "investigate",
            suggestedBoost: 0,
            confidence: 0.5,
          }),
        ],
      });

      const patch = compilePolicyPatch(policy, report);

      // skill-stable filtered (no-op), 3 entries remain
      expect(patch.patchCount).toBe(3);
      expect(patch.sessionId).toBe("complex-fixture");

      const actions = patch.entries.map((e) => e.action);
      expect(actions).toContain("promote");
      expect(actions).toContain("demote");
      expect(actions).toContain("investigate");

      // Verify ordering
      for (let i = 1; i < patch.entries.length; i++) {
        const cmp =
          patch.entries[i - 1].scenario.localeCompare(
            patch.entries[i].scenario,
          ) ||
          patch.entries[i - 1].skill.localeCompare(patch.entries[i].skill);
        expect(cmp).toBeLessThanOrEqual(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Apply path
  // -------------------------------------------------------------------------

  describe("applyPolicyPatch", () => {
    test("promote: produces PromotionArtifact with boost 8", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "apply-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-a",
            action: "promote",
            currentBoost: 0,
            proposedBoost: 8,
            delta: 8,
            confidence: 0.99,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.applied).toBe(1);
      expect(artifact.rules).toHaveLength(1);
      expect(artifact.rules[0].action).toBe("promote");
      expect(artifact.rules[0].boost).toBe(8);
      expect(artifact.rules[0].skill).toBe("skill-a");
      expect(artifact.rules[0].scenario).toBe(SCENARIO_A);
    });

    test("demote: produces PromotionArtifact with positive boost magnitude", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "apply-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-b",
            action: "demote",
            currentBoost: 0,
            proposedBoost: -2,
            delta: -2,
            confidence: 1.0,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.applied).toBe(1);
      expect(artifact.rules).toHaveLength(1);
      expect(artifact.rules[0].action).toBe("demote");
      expect(artifact.rules[0].boost).toBe(2);
    });

    test("compiler-produced demote rule lowers runtime priority", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "apply-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-b",
            action: "demote",
            currentBoost: 0,
            proposedBoost: -2,
            delta: -2,
            confidence: 1.0,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      const gate = evaluatePromotionGate({
        artifact,
        replay: {
          baselineWins: 1,
          baselineDirectiveWins: 1,
          learnedWins: 1,
          learnedDirectiveWins: 1,
          deltaWins: 0,
          deltaDirectiveWins: 0,
          regressions: [],
        },
      });

      expect(gate.accepted).toBe(true);
      if (!gate.rulebook) return;

      const boosted = applyRulebookBoosts(
        [{
          skill: "skill-b",
          priority: 8,
          effectivePriority: 8,
          policyBoost: 0,
          policyReason: null,
        }],
        gate.rulebook,
        {
          hook: "PreToolUse",
          storyKind: "flow-verification",
          targetBoundary: "uiRender",
          toolName: "Bash",
        },
        "/tmp/test-rulebook.json",
      );

      expect(boosted[0].ruleBoost).toBe(-2);
      expect(boosted[0].effectivePriority).toBe(6);
    });

    test("investigate: skipped, not included in rules", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "apply-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-c",
            action: "investigate",
            currentBoost: 0,
            proposedBoost: 0,
            delta: 0,
            confidence: 0.5,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.applied).toBe(0);
      expect(artifact.rules).toHaveLength(0);
    });

    test("no-op: skipped, not included in rules", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "apply-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-d",
            action: "no-op",
            currentBoost: 8,
            proposedBoost: 8,
            delta: 0,
            confidence: 0.99,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.applied).toBe(0);
      expect(artifact.rules).toHaveLength(0);
    });

    test("idempotent: applying same patch twice produces identical artifacts", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "idempotent-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-idem",
            action: "promote",
            currentBoost: 0,
            proposedBoost: 8,
            delta: 8,
            confidence: 0.99,
            reason: "test",
          },
        ],
      };

      const artifact1 = applyPolicyPatch(patch, T1);
      const artifact2 = applyPolicyPatch(patch, T1);

      expect(JSON.stringify(artifact1)).toBe(JSON.stringify(artifact2));
    });

    test("sets promotedAt to provided timestamp", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "ts-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-ts",
            action: "promote",
            currentBoost: 0,
            proposedBoost: 8,
            delta: 8,
            confidence: 0.99,
            reason: "test",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.promotedAt).toBe(T1);
    });

    test("does not mutate any RoutingPolicyFile (evidence preservation)", () => {
      const policy = policyWithBoost(SCENARIO_A, "skill-evidence", 2);
      const policySnapshot = JSON.stringify(policy);

      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "evidence-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-evidence",
            action: "promote",
            currentBoost: 2,
            proposedBoost: 8,
            delta: 6,
            confidence: 0.99,
            reason: "test",
          },
        ],
      };

      // applyPolicyPatch no longer takes a policy — it cannot mutate one
      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.applied).toBe(1);

      // Policy remains completely untouched
      expect(JSON.stringify(policy)).toBe(policySnapshot);
    });

    test("repeated application does not inflate counters or corrupt evidence", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "no-corruption-test",
        patchCount: 2,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-x",
            action: "promote",
            currentBoost: 0,
            proposedBoost: 8,
            delta: 8,
            confidence: 0.99,
            reason: "test",
          },
          {
            scenario: SCENARIO_B,
            skill: "skill-y",
            action: "demote",
            currentBoost: 5,
            proposedBoost: -2,
            delta: -7,
            confidence: 1.0,
            reason: "test",
          },
        ],
      };

      // Apply 10 times — artifact is always the same
      const artifacts: PromotionArtifact[] = [];
      for (let i = 0; i < 10; i++) {
        artifacts.push(applyPolicyPatch(patch, T1));
      }

      const first = JSON.stringify(artifacts[0]);
      for (const a of artifacts) {
        expect(JSON.stringify(a)).toBe(first);
      }
      expect(artifacts[0].applied).toBe(2);
      expect(artifacts[0].rules).toHaveLength(2);
    });

    test("preserves confidence and reason in PromotedRule", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "passthrough-test",
        patchCount: 1,
        entries: [
          {
            scenario: SCENARIO_A,
            skill: "skill-pass",
            action: "promote",
            currentBoost: 0,
            proposedBoost: 8,
            delta: 8,
            confidence: 0.73,
            reason: "4/5 wins in scenario",
          },
        ],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.rules[0].confidence).toBe(0.73);
      expect(artifact.rules[0].reason).toBe("4/5 wins in scenario");
    });

    test("version and sessionId are set correctly on artifact", () => {
      const patch: PolicyPatchReport = {
        version: 1,
        sessionId: "meta-test",
        patchCount: 0,
        entries: [],
      };

      const artifact = applyPolicyPatch(patch, T1);
      expect(artifact.version).toBe(1);
      expect(artifact.sessionId).toBe("meta-test");
      expect(artifact.promotedAt).toBe(T1);
      expect(artifact.applied).toBe(0);
      expect(artifact.rules).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Confidence passthrough
  // -------------------------------------------------------------------------

  test("preserves confidence from recommendation in patch entry", () => {
    const patch = compilePolicyPatch(
      createEmptyRoutingPolicy(),
      makeReport({
        recommendations: [
          makeRec({ confidence: 0.73, action: "promote" }),
        ],
      }),
    );

    expect(patch.entries[0].confidence).toBe(0.73);
  });

  // -------------------------------------------------------------------------
  // Reason passthrough
  // -------------------------------------------------------------------------

  test("preserves reason from recommendation in patch entry", () => {
    const reason = "4/5 wins in " + SCENARIO_A;
    const patch = compilePolicyPatch(
      createEmptyRoutingPolicy(),
      makeReport({
        recommendations: [makeRec({ reason, action: "promote" })],
      }),
    );

    expect(patch.entries[0].reason).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

describe("evaluatePromotionGate", () => {
  function makeArtifact(
    overrides: Partial<PromotionArtifact> = {},
  ): PromotionArtifact {
    return {
      version: 1,
      sessionId: "gate-test",
      promotedAt: T1,
      applied: 1,
      rules: [
        {
          scenario: SCENARIO_A,
          skill: "agent-browser-verify",
          action: "promote",
          boost: 8,
          confidence: 0.95,
          reason: "4/4 wins",
        },
      ],
      ...overrides,
    };
  }

  function makeReplay(overrides: Partial<ReplayResult> = {}): ReplayResult {
    return {
      baselineWins: 4,
      baselineDirectiveWins: 2,
      learnedWins: 4,
      learnedDirectiveWins: 2,
      deltaWins: 0,
      deltaDirectiveWins: 0,
      regressions: [],
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Acceptance
  // -----------------------------------------------------------------------

  test("accepts when no regressions and learnedWins >= baselineWins", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay(),
    });
    expect(result.accepted).toBe(true);
    expect(result.errorCode).toBeNull();
    expect(result.rulebook).not.toBeNull();
    expect(result.rulebook!.rules).toHaveLength(1);
    expect(result.rulebook!.rules[0].skill).toBe("agent-browser-verify");
    expect(result.rulebook!.rules[0].action).toBe("promote");
  });

  test("accepted rulebook has deterministic rule IDs", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay(),
    });
    expect(result.rulebook!.rules[0].id).toBe(
      `${SCENARIO_A}|agent-browser-verify`,
    );
  });

  test("accepted rulebook evidence matches replay", () => {
    const replay = makeReplay({
      baselineWins: 6,
      baselineDirectiveWins: 3,
      learnedWins: 7,
      learnedDirectiveWins: 4,
    });
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay,
    });
    const evidence = result.rulebook!.rules[0].evidence;
    expect(evidence.baselineWins).toBe(6);
    expect(evidence.baselineDirectiveWins).toBe(3);
    expect(evidence.learnedWins).toBe(7);
    expect(evidence.learnedDirectiveWins).toBe(4);
    expect(evidence.regressionCount).toBe(0);
  });

  test("accepted rulebook sessionId and createdAt from artifact", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact({ sessionId: "my-session", promotedAt: T0 }),
      replay: makeReplay(),
    });
    expect(result.rulebook!.sessionId).toBe("my-session");
    expect(result.rulebook!.createdAt).toBe(T0);
  });

  test("accepts when learnedWins > baselineWins (improvement)", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay({ learnedWins: 6, baselineWins: 4, deltaWins: 2 }),
    });
    expect(result.accepted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Rejection: regressions
  // -----------------------------------------------------------------------

  test("rejects when regressions > 0", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay({ regressions: ["d1", "d2"] }),
    });
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("RULEBOOK_PROMOTION_REJECTED_REGRESSION");
    expect(result.rulebook).toBeNull();
    expect(result.reason).toContain("regression");
  });

  test("rejects with single regression", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay({ regressions: ["d1"] }),
    });
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("RULEBOOK_PROMOTION_REJECTED_REGRESSION");
  });

  // -----------------------------------------------------------------------
  // Rejection: learnedWins < baselineWins
  // -----------------------------------------------------------------------

  test("rejects when learnedWins < baselineWins", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: makeReplay({
        baselineWins: 5,
        learnedWins: 3,
        deltaWins: -2,
        regressions: [],
      }),
    });
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("RULEBOOK_PROMOTION_REJECTED_REGRESSION");
    expect(result.rulebook).toBeNull();
    expect(result.reason).toContain("learned wins");
    expect(result.reason).toContain("baseline wins");
  });

  // -----------------------------------------------------------------------
  // Pure function / determinism
  // -----------------------------------------------------------------------

  test("same inputs produce identical output", () => {
    const artifact = makeArtifact();
    const replay = makeReplay();
    const r1 = evaluatePromotionGate({ artifact, replay });
    const r2 = evaluatePromotionGate({ artifact, replay });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  test("does not mutate the input artifact", () => {
    const artifact = makeArtifact();
    const snapshot = JSON.stringify(artifact);
    evaluatePromotionGate({ artifact, replay: makeReplay() });
    expect(JSON.stringify(artifact)).toBe(snapshot);
  });

  // -----------------------------------------------------------------------
  // Deterministic ordering
  // -----------------------------------------------------------------------

  test("multi-rule accepted rulebook has deterministic ordering", () => {
    const artifact = makeArtifact({
      rules: [
        { scenario: SCENARIO_B, skill: "z-skill", action: "promote", boost: 8, confidence: 0.9, reason: "test" },
        { scenario: SCENARIO_A, skill: "b-skill", action: "promote", boost: 8, confidence: 0.9, reason: "test" },
        { scenario: SCENARIO_A, skill: "a-skill", action: "promote", boost: 8, confidence: 0.9, reason: "test" },
      ],
      applied: 3,
    });
    const result = evaluatePromotionGate({
      artifact,
      replay: makeReplay(),
    });
    // Rules should be in the order they came from the artifact;
    // serialization via serializeRulebook handles final ordering
    expect(result.rulebook!.rules).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // replay is always returned
  // -----------------------------------------------------------------------

  test("replay is returned in both accepted and rejected results", () => {
    const replay = makeReplay({ baselineWins: 10, learnedWins: 10 });
    const accepted = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay,
    });
    expect(accepted.replay).toBe(replay);

    const rejectedReplay = makeReplay({ regressions: ["d1"] });
    const rejected = evaluatePromotionGate({
      artifact: makeArtifact(),
      replay: rejectedReplay,
    });
    expect(rejected.replay).toBe(rejectedReplay);
  });

  // -----------------------------------------------------------------------
  // Empty artifact
  // -----------------------------------------------------------------------

  test("empty artifact accepted produces empty rulebook", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact({ rules: [], applied: 0 }),
      replay: makeReplay({ baselineWins: 0, learnedWins: 0 }),
    });
    expect(result.accepted).toBe(true);
    expect(result.rulebook!.rules).toHaveLength(0);
  });

  test("accepted demote rulebook preserves positive stored magnitude", () => {
    const result = evaluatePromotionGate({
      artifact: makeArtifact({
        applied: 1,
        rules: [{
          scenario: SCENARIO_A,
          skill: "agent-browser-verify",
          action: "demote",
          boost: 2,
          confidence: 0.95,
          reason: "1/10 wins",
        }],
      }),
      replay: makeReplay(),
    });

    expect(result.accepted).toBe(true);
    expect(result.rulebook!.rules[0].action).toBe("demote");
    expect(result.rulebook!.rules[0].boost).toBe(2);
  });
});
