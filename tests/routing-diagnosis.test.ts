import { describe, expect, test } from "bun:test";
import {
  createEmptyRoutingPolicy,
  type RoutingPolicyFile,
} from "../hooks/src/routing-policy.mts";
import {
  explainPolicyRecall,
  parsePolicyScenario,
} from "../hooks/src/routing-diagnosis.mts";

const T0 = "2026-03-27T22:53:34.623Z";

function put(
  policy: RoutingPolicyFile,
  scenario: string,
  skill: string,
  exposures: number,
  wins: number,
  directiveWins: number,
  staleMisses: number,
): void {
  policy.scenarios[scenario] ??= {};
  policy.scenarios[scenario][skill] = {
    exposures,
    wins,
    directiveWins,
    staleMisses,
    lastUpdatedAt: T0,
  };
}

describe("routing-diagnosis", () => {
  test("parsePolicyScenario parses legacy and route-aware keys", () => {
    expect(
      parsePolicyScenario(
        "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      ),
    ).toEqual({
      hook: "PreToolUse",
      storyKind: "flow-verification",
      targetBoundary: "clientRequest",
      toolName: "Bash",
      routeScope: "/settings",
    });

    expect(
      parsePolicyScenario("UserPromptSubmit|deployment|none|Prompt"),
    ).toEqual({
      hook: "UserPromptSubmit",
      storyKind: "deployment",
      targetBoundary: null,
      toolName: "Prompt",
      routeScope: null,
    });
  });

  test("parsePolicyScenario returns null for invalid inputs", () => {
    expect(parsePolicyScenario(null)).toBeNull();
    expect(parsePolicyScenario("")).toBeNull();
    expect(parsePolicyScenario("too|few")).toBeNull();
    expect(parsePolicyScenario("Invalid|x|y|z")).toBeNull();
  });

  test("exact route bucket wins over wildcard and legacy buckets", () => {
    const policy = createEmptyRoutingPolicy();

    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      "verification",
      4,
      3,
      1,
      0,
    );
    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|*",
      "observability",
      8,
      8,
      0,
      0,
    );
    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash",
      "workflow",
      8,
      8,
      0,
      0,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(diagnosis.selectedBucket).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    );
    expect(diagnosis.selected.map((c) => c.skill)).toEqual([
      "verification",
    ]);
    expect(
      diagnosis.rejected.some((c) =>
        c.rejectedReason?.startsWith("shadowed_by_selected_bucket:"),
      ),
    ).toBe(true);
  });

  test("diagnosis emits exposure remediation when sample size is too small", () => {
    const policy = createEmptyRoutingPolicy();

    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      "verification",
      2,
      2,
      0,
      0,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(diagnosis.selected).toEqual([]);
    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_NEEDS_EXPOSURES",
      ),
    ).toMatchObject({
      action: {
        type: "collect_more_exposures",
        skill: "verification",
        scenario:
          "PreToolUse|flow-verification|clientRequest|Bash|/settings",
        remainingExposures: 1,
      },
    });
  });

  test("diagnosis emits already-present hint when a qualifying candidate is excluded", () => {
    const policy = createEmptyRoutingPolicy();

    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      "verification",
      5,
      5,
      0,
      0,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(["verification"]), maxCandidates: 1 },
    );

    expect(diagnosis.selected).toEqual([]);
    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_ALREADY_PRESENT",
      ),
    ).toMatchObject({
      action: {
        type: "candidate_already_present",
        skill: "verification",
      },
    });
  });

  test("no target boundary returns ineligible diagnosis", () => {
    const policy = createEmptyRoutingPolicy();

    const diagnosis = explainPolicyRecall(policy, {
      hook: "PreToolUse",
      storyKind: "flow-verification",
      targetBoundary: null,
      toolName: "Bash",
      routeScope: "/settings",
    });

    expect(diagnosis.eligible).toBe(false);
    expect(diagnosis.skipReason).toBe("no_target_boundary");
    expect(diagnosis.checkedScenarios).toEqual([]);
    expect(diagnosis.selected).toEqual([]);
    expect(diagnosis.rejected).toEqual([]);
  });

  test("empty policy emits no-history hint", () => {
    const policy = createEmptyRoutingPolicy();

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(diagnosis.eligible).toBe(true);
    expect(diagnosis.selected).toEqual([]);
    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_NO_HISTORY",
      ),
    ).toBeDefined();
  });

  test("wildcard bucket selection emits seed-exact-route hint", () => {
    const policy = createEmptyRoutingPolicy();

    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|*",
      "observability",
      5,
      5,
      0,
      0,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(diagnosis.selectedBucket).toBe(
      "PreToolUse|flow-verification|clientRequest|Bash|*",
    );
    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_USING_WILDCARD_ROUTE",
      ),
    ).toBeDefined();
  });

  test("low success rate emits appropriate hint", () => {
    const policy = createEmptyRoutingPolicy();

    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      "verification",
      10,
      3,
      0,
      4,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(diagnosis.selected).toEqual([]);
    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_LOW_SUCCESS_RATE",
      ),
    ).toMatchObject({
      action: {
        type: "improve_success_rate",
        skill: "verification",
      },
    });
  });

  test("precedence hint emitted when lower-priority bucket is shadowed", () => {
    const policy = createEmptyRoutingPolicy();

    // Exact route bucket with a qualifying skill
    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      "verification",
      4,
      3,
      1,
      0,
    );
    // Legacy bucket with a qualifying skill — should be shadowed
    put(
      policy,
      "PreToolUse|flow-verification|clientRequest|Bash",
      "workflow",
      8,
      8,
      0,
      0,
    );

    const diagnosis = explainPolicyRecall(
      policy,
      {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      { excludeSkills: new Set(), maxCandidates: 1 },
    );

    expect(
      diagnosis.hints.find(
        (h) => h.code === "POLICY_RECALL_PRECEDENCE_APPLIED",
      ),
    ).toBeDefined();
  });
});
