import { describe, expect, test } from "bun:test";
import { selectPolicyRecallCandidates } from "../hooks/policy-recall.mjs";
import type { RoutingPolicyFile } from "../hooks/routing-policy.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(
  scenarios: Record<
    string,
    Record<
      string,
      {
        exposures: number;
        wins: number;
        directiveWins: number;
        staleMisses: number;
      }
    >
  >,
): RoutingPolicyFile {
  const out: RoutingPolicyFile = { version: 1, scenarios: {} };
  for (const [key, skills] of Object.entries(scenarios)) {
    out.scenarios[key] = {};
    for (const [skill, stats] of Object.entries(skills)) {
      out.scenarios[key][skill] = {
        ...stats,
        lastUpdatedAt: "2026-03-27T19:00:00.000Z",
      };
    }
  }
  return out;
}

const BASE_SCENARIO = {
  hook: "PreToolUse" as const,
  storyKind: "flow-verification",
  targetBoundary: "clientRequest" as const,
  toolName: "Bash" as const,
  routeScope: "/settings",
};

// ---------------------------------------------------------------------------
// Core behavior
// ---------------------------------------------------------------------------

describe("selectPolicyRecallCandidates", () => {
  test("prefers exact-route policy before wildcard fallback", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        verification: {
          exposures: 4,
          wins: 4,
          directiveWins: 2,
          staleMisses: 0,
        },
      },
      "PreToolUse|flow-verification|clientRequest|Bash|*": {
        workflow: {
          exposures: 8,
          wins: 6,
          directiveWins: 1,
          staleMisses: 2,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result.map((e) => e.skill)).toEqual(["verification"]);
    expect(result[0]?.scenario).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
  });

  test("falls back to wildcard when exact route has no qualified evidence", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        // Too few exposures to qualify (< 3)
        verification: {
          exposures: 1,
          wins: 1,
          directiveWins: 0,
          staleMisses: 0,
        },
      },
      "PreToolUse|flow-verification|clientRequest|Bash|*": {
        workflow: {
          exposures: 5,
          wins: 4,
          directiveWins: 1,
          staleMisses: 1,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result.map((e) => e.skill)).toEqual(["workflow"]);
    expect(result[0]?.scenario).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash|*",
    );
  });

  test("returns empty when no bucket qualifies", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        verification: {
          exposures: 1,
          wins: 0,
          directiveWins: 0,
          staleMisses: 1,
        },
      },
      "PreToolUse|flow-verification|clientRequest|Bash|*": {
        workflow: {
          exposures: 2,
          wins: 1,
          directiveWins: 0,
          staleMisses: 1,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result).toEqual([]);
  });

  test("excludes skills in excludeSkills set", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        verification: {
          exposures: 5,
          wins: 5,
          directiveWins: 2,
          staleMisses: 0,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO, {
      excludeSkills: new Set(["verification"]),
    });
    expect(result).toEqual([]);
  });

  test("filters by minSuccessRate threshold", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        verification: {
          exposures: 10,
          wins: 4,
          directiveWins: 0,
          staleMisses: 6,
        },
      },
    });

    // 4/10 = 0.40, below default 0.65
    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result).toEqual([]);
  });

  test("filters by minBoost threshold", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        // 3 exposures, 2 wins → successRate ~0.67 → boost = 5 (qualifies)
        // But if we raise minBoost to 6, should be excluded
        skillA: {
          exposures: 3,
          wins: 2,
          directiveWins: 0,
          staleMisses: 1,
        },
      },
    });

    const withDefault = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(withDefault.length).toBe(1);

    const withHighMinBoost = selectPolicyRecallCandidates(
      policy,
      BASE_SCENARIO,
      { minBoost: 6 },
    );
    expect(withHighMinBoost).toEqual([]);
  });

  test("returns maxCandidates candidates when multiple qualify", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        skillA: {
          exposures: 5,
          wins: 5,
          directiveWins: 3,
          staleMisses: 0,
        },
        skillB: {
          exposures: 4,
          wins: 4,
          directiveWins: 1,
          staleMisses: 0,
        },
        skillC: {
          exposures: 6,
          wins: 5,
          directiveWins: 0,
          staleMisses: 1,
        },
      },
    });

    // Default maxCandidates = 1
    const single = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(single.length).toBe(1);

    // maxCandidates = 2
    const two = selectPolicyRecallCandidates(policy, BASE_SCENARIO, {
      maxCandidates: 2,
    });
    expect(two.length).toBe(2);
  });

  test("tie-breaking is deterministic: recallScore > exposures > skill name", () => {
    // Two skills with identical stats → tie-break on skill name (asc)
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        zeta: {
          exposures: 5,
          wins: 4,
          directiveWins: 1,
          staleMisses: 0,
        },
        alpha: {
          exposures: 5,
          wins: 4,
          directiveWins: 1,
          staleMisses: 0,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO, {
      maxCandidates: 2,
    });
    expect(result.map((e) => e.skill)).toEqual(["alpha", "zeta"]);
  });

  test("candidate includes all required machine-readable fields", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|/settings": {
        verification: {
          exposures: 6,
          wins: 5,
          directiveWins: 2,
          staleMisses: 1,
        },
      },
    });

    const [candidate] = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(candidate).toBeDefined();
    expect(candidate!.skill).toBe("verification");
    expect(candidate!.scenario).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    expect(candidate!.exposures).toBe(6);
    expect(candidate!.wins).toBe(5);
    expect(candidate!.directiveWins).toBe(2);
    expect(candidate!.staleMisses).toBe(1);
    expect(typeof candidate!.successRate).toBe("number");
    expect(typeof candidate!.policyBoost).toBe("number");
    expect(typeof candidate!.recallScore).toBe("number");
    expect(candidate!.successRate).toBeGreaterThan(0);
    expect(candidate!.policyBoost).toBeGreaterThan(0);
    expect(candidate!.recallScore).toBeGreaterThan(0);
  });

  test("falls back to legacy 4-part key when no route-keyed bucket exists", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash": {
        legacySkill: {
          exposures: 5,
          wins: 4,
          directiveWins: 1,
          staleMisses: 0,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result.map((e) => e.skill)).toEqual(["legacySkill"]);
    expect(result[0]?.scenario).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash",
    );
  });

  test("works with null routeScope (no route context)", () => {
    const policy = makePolicy({
      "PreToolUse|flow-verification|clientRequest|Bash|*": {
        workflow: {
          exposures: 5,
          wins: 4,
          directiveWins: 1,
          staleMisses: 0,
        },
      },
    });

    const result = selectPolicyRecallCandidates(policy, {
      ...BASE_SCENARIO,
      routeScope: null,
    });
    expect(result.map((e) => e.skill)).toEqual(["workflow"]);
  });

  test("empty policy returns empty", () => {
    const policy: RoutingPolicyFile = { version: 1, scenarios: {} };
    const result = selectPolicyRecallCandidates(policy, BASE_SCENARIO);
    expect(result).toEqual([]);
  });
});
