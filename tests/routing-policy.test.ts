import { describe, test, expect } from "bun:test";
import {
  createEmptyRoutingPolicy,
  scenarioKey,
  ensureScenario,
  recordExposure,
  recordOutcome,
  derivePolicyBoost,
  applyPolicyBoosts,
  type RoutingPolicyFile,
  type RoutingPolicyScenario,
  type RoutingPolicyStats,
} from "../hooks/src/routing-policy.mts";

// Fixed ISO timestamps for deterministic tests
const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";

const BASE_SCENARIO: RoutingPolicyScenario = {
  hook: "PreToolUse",
  storyKind: "flow-verification",
  targetBoundary: "uiRender",
  toolName: "Bash",
};

describe("routing-policy core", () => {
  describe("createEmptyRoutingPolicy", () => {
    test("returns version 1 with empty scenarios", () => {
      const policy = createEmptyRoutingPolicy();
      expect(policy.version).toBe(1);
      expect(policy.scenarios).toEqual({});
    });
  });

  describe("scenarioKey", () => {
    test("joins fields with pipe delimiters", () => {
      expect(scenarioKey(BASE_SCENARIO)).toBe(
        "PreToolUse|flow-verification|uiRender|Bash",
      );
    });

    test("uses 'none' for null storyKind and targetBoundary", () => {
      expect(
        scenarioKey({
          hook: "UserPromptSubmit",
          storyKind: null,
          targetBoundary: null,
          toolName: "Prompt",
        }),
      ).toBe("UserPromptSubmit|none|none|Prompt");
    });
  });

  describe("ensureScenario", () => {
    test("creates scenario and skill slot when absent", () => {
      const policy = createEmptyRoutingPolicy();
      const stats = ensureScenario(policy, "s1", "skill-a", T0);
      expect(stats).toEqual({
        exposures: 0,
        wins: 0,
        directiveWins: 0,
        staleMisses: 0,
        lastUpdatedAt: T0,
      });
      expect(policy.scenarios["s1"]["skill-a"]).toBe(stats);
    });

    test("returns existing slot without overwriting", () => {
      const policy = createEmptyRoutingPolicy();
      const first = ensureScenario(policy, "s1", "skill-a", T0);
      first.exposures = 5;
      const second = ensureScenario(policy, "s1", "skill-a", T1);
      expect(second.exposures).toBe(5);
      expect(second).toBe(first);
    });
  });

  describe("recordExposure", () => {
    test("increments exposures and updates timestamp", () => {
      const policy = createEmptyRoutingPolicy();
      recordExposure(policy, { ...BASE_SCENARIO, skill: "agent-browser-verify", now: T0 });
      recordExposure(policy, { ...BASE_SCENARIO, skill: "agent-browser-verify", now: T1 });

      const key = scenarioKey(BASE_SCENARIO);
      const stats = policy.scenarios[key]["agent-browser-verify"];
      expect(stats.exposures).toBe(2);
      expect(stats.wins).toBe(0);
      expect(stats.lastUpdatedAt).toBe(T1);
    });

    test("returns the same policy object (mutation)", () => {
      const policy = createEmptyRoutingPolicy();
      const result = recordExposure(policy, { ...BASE_SCENARIO, skill: "x", now: T0 });
      expect(result).toBe(policy);
    });
  });

  describe("recordOutcome", () => {
    test("win increments wins only", () => {
      const policy = createEmptyRoutingPolicy();
      recordOutcome(policy, {
        ...BASE_SCENARIO,
        skill: "s",
        outcome: "win",
        now: T0,
      });
      const stats = policy.scenarios[scenarioKey(BASE_SCENARIO)]["s"];
      expect(stats.wins).toBe(1);
      expect(stats.directiveWins).toBe(0);
      expect(stats.staleMisses).toBe(0);
    });

    test("directive-win increments both wins and directiveWins", () => {
      const policy = createEmptyRoutingPolicy();
      recordOutcome(policy, {
        ...BASE_SCENARIO,
        skill: "s",
        outcome: "directive-win",
        now: T0,
      });
      const stats = policy.scenarios[scenarioKey(BASE_SCENARIO)]["s"];
      expect(stats.wins).toBe(1);
      expect(stats.directiveWins).toBe(1);
    });

    test("stale-miss increments staleMisses only", () => {
      const policy = createEmptyRoutingPolicy();
      recordOutcome(policy, {
        ...BASE_SCENARIO,
        skill: "s",
        outcome: "stale-miss",
        now: T0,
      });
      const stats = policy.scenarios[scenarioKey(BASE_SCENARIO)]["s"];
      expect(stats.wins).toBe(0);
      expect(stats.staleMisses).toBe(1);
    });
  });

  describe("derivePolicyBoost", () => {
    test("returns 0 for undefined stats", () => {
      expect(derivePolicyBoost(undefined)).toBe(0);
    });

    test("returns 0 when exposures < 3", () => {
      expect(
        derivePolicyBoost({
          exposures: 2,
          wins: 2,
          directiveWins: 2,
          staleMisses: 0,
          lastUpdatedAt: T0,
        }),
      ).toBe(0);
    });

    test("returns 8 for high success rate (>= 80%)", () => {
      expect(
        derivePolicyBoost({
          exposures: 5,
          wins: 4,
          directiveWins: 3,
          staleMisses: 1,
          lastUpdatedAt: T0,
        }),
      ).toBe(8);
    });

    test("returns 5 for good success rate (>= 65%)", () => {
      // 10 exposures, 7 wins, 0 directive → rate = 0.70 → boost 5
      expect(
        derivePolicyBoost({
          exposures: 10,
          wins: 7,
          directiveWins: 0,
          staleMisses: 3,
          lastUpdatedAt: T0,
        }),
      ).toBe(5);
    });

    test("returns 2 for moderate success rate (>= 40%)", () => {
      // 4 exposures, 2 wins, 0 directive → weightedWins=2, rate=0.50 → boost 2
      expect(
        derivePolicyBoost({
          exposures: 4,
          wins: 2,
          directiveWins: 0,
          staleMisses: 2,
          lastUpdatedAt: T0,
        }),
      ).toBe(2);
    });

    test("returns -2 for low success rate with enough exposures", () => {
      expect(
        derivePolicyBoost({
          exposures: 10,
          wins: 1,
          directiveWins: 0,
          staleMisses: 9,
          lastUpdatedAt: T0,
        }),
      ).toBe(-2);
    });

    test("returns 0 for middling success rate (not enough for boost, not low enough for penalty)", () => {
      // 5 exposures, 1 win, 0 directive → rate = 0.20 → not < 0.15, not >= 0.40
      expect(
        derivePolicyBoost({
          exposures: 5,
          wins: 1,
          directiveWins: 0,
          staleMisses: 4,
          lastUpdatedAt: T0,
        }),
      ).toBe(0);
    });
  });

  describe("applyPolicyBoosts", () => {
    test("adds policyBoost and policyReason to each entry", () => {
      const policy = createEmptyRoutingPolicy();
      const entries = [{ skill: "some-skill", priority: 6 }];
      const result = applyPolicyBoosts(entries, policy, BASE_SCENARIO);

      expect(result).toHaveLength(1);
      expect(result[0].policyBoost).toBe(0);
      expect(result[0].policyReason).toBeNull();
      expect(result[0].effectivePriority).toBe(6);
    });

    test("uses effectivePriority as base when present", () => {
      const policy = createEmptyRoutingPolicy();
      const entries = [{ skill: "s", priority: 5, effectivePriority: 10 }];
      const result = applyPolicyBoosts(entries, policy, BASE_SCENARIO);
      expect(result[0].effectivePriority).toBe(10);
    });

    test("does not mutate original entries", () => {
      const policy = createEmptyRoutingPolicy();
      const original = { skill: "s", priority: 5 };
      applyPolicyBoosts([original], policy, BASE_SCENARIO);
      expect(original).toEqual({ skill: "s", priority: 5 });
    });
  });

  describe("acceptance scenario: 3 exposures + 1 directive-win → boost 2, effective 9", () => {
    test("produces expected boost and effective priority", () => {
      const policy = createEmptyRoutingPolicy();

      // 3 exposures
      recordExposure(policy, {
        ...BASE_SCENARIO,
        skill: "agent-browser-verify",
        now: T0,
      });
      recordExposure(policy, {
        ...BASE_SCENARIO,
        skill: "agent-browser-verify",
        now: T1,
      });
      recordExposure(policy, {
        ...BASE_SCENARIO,
        skill: "agent-browser-verify",
        now: T2,
      });

      // 1 directive-win
      recordOutcome(policy, {
        ...BASE_SCENARIO,
        skill: "agent-browser-verify",
        outcome: "directive-win",
        now: T3,
      });

      // Verify raw stats
      const key = scenarioKey(BASE_SCENARIO);
      const stats = policy.scenarios[key]["agent-browser-verify"];
      expect(stats.exposures).toBe(3);
      expect(stats.wins).toBe(1);
      expect(stats.directiveWins).toBe(1);

      // weightedWins = 1 + 1*0.25 = 1.25, rate = 1.25/3 ≈ 0.417 → boost 2 (>= 0.40)
      const boost = derivePolicyBoost(stats);
      expect(boost).toBe(2);

      const boosted = applyPolicyBoosts(
        [{ skill: "agent-browser-verify", priority: 7 }],
        policy,
        BASE_SCENARIO,
      );

      expect(boosted[0].policyBoost).toBe(2);
      expect(boosted[0].effectivePriority).toBe(9);
      expect(boosted[0].policyReason).toContain("1 wins / 3 exposures");
      expect(boosted[0].policyReason).toContain("1 directive wins");
    });
  });
});
