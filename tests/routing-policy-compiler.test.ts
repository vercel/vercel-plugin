import { describe, test, expect } from "bun:test";
import {
  compilePolicyPatch,
  applyPolicyPatch,
  type PolicyPatchReport,
  type PolicyPatchEntry,
} from "../hooks/src/routing-policy-compiler.mts";
import {
  createEmptyRoutingPolicy,
  recordExposure,
  recordOutcome,
  derivePolicyBoost,
  type RoutingPolicyFile,
} from "../hooks/src/routing-policy.mts";
import type {
  RoutingReplayReport,
  RoutingRecommendation,
} from "../hooks/src/routing-replay.mts";

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
    test("promote: after apply, derivePolicyBoost returns 8", () => {
      const policy = createEmptyRoutingPolicy();
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

      const applied = applyPolicyPatch(policy, patch, T1);
      expect(applied).toBe(1);

      const stats = policy.scenarios[SCENARIO_A]["skill-a"];
      expect(derivePolicyBoost(stats)).toBe(8);
    });

    test("demote: after apply, derivePolicyBoost returns -2", () => {
      const policy = createEmptyRoutingPolicy();
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

      const applied = applyPolicyPatch(policy, patch, T1);
      expect(applied).toBe(1);

      const stats = policy.scenarios[SCENARIO_A]["skill-b"];
      expect(derivePolicyBoost(stats)).toBe(-2);
    });

    test("investigate: skipped, no mutation", () => {
      const policy = createEmptyRoutingPolicy();
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

      const applied = applyPolicyPatch(policy, patch, T1);
      expect(applied).toBe(0);
      expect(policy.scenarios[SCENARIO_A]).toBeUndefined();
    });

    test("no-op: skipped, no mutation", () => {
      const policy = createEmptyRoutingPolicy();
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

      const applied = applyPolicyPatch(policy, patch, T1);
      expect(applied).toBe(0);
    });

    test("idempotent: applying same patch twice produces same result", () => {
      const policy = createEmptyRoutingPolicy();
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

      applyPolicyPatch(policy, patch, T1);
      const snapshot1 = JSON.stringify(policy);

      applyPolicyPatch(policy, patch, T1);
      const snapshot2 = JSON.stringify(policy);

      expect(snapshot1).toBe(snapshot2);
    });

    test("sets lastUpdatedAt to provided timestamp", () => {
      const policy = createEmptyRoutingPolicy();
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

      applyPolicyPatch(policy, patch, T1);
      const stats = policy.scenarios[SCENARIO_A]["skill-ts"];
      expect(stats.lastUpdatedAt).toBe(T1);
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
