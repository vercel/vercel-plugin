import { describe, expect, test } from "bun:test";
import {
  createEmptyRoutingPolicy,
  recordExposure,
  recordOutcome,
} from "../hooks/src/routing-policy.mts";
import { applyPromptPolicyRecall } from "../hooks/src/prompt-policy-recall.mts";

function buildWinningPolicy(skill: string) {
  const policy = createEmptyRoutingPolicy();
  const scenario = {
    hook: "UserPromptSubmit" as const,
    storyKind: "flow-verification",
    targetBoundary: "clientRequest" as const,
    toolName: "Prompt" as const,
    routeScope: "/settings",
    skill,
  };
  for (let i = 0; i < 5; i += 1) {
    recordExposure(policy, {
      ...scenario,
      now: `2026-03-28T00:00:0${i}.000Z`,
    });
    recordOutcome(policy, {
      ...scenario,
      outcome: "win",
      now: `2026-03-28T00:10:0${i}.000Z`,
    });
  }
  return policy;
}

function buildOrderedWinningPolicy(skills: string[]) {
  const policy = createEmptyRoutingPolicy();
  for (const [idx, skill] of skills.entries()) {
    const scenario = {
      hook: "UserPromptSubmit" as const,
      storyKind: "flow-verification",
      targetBoundary: "clientRequest" as const,
      toolName: "Prompt" as const,
      routeScope: "/settings",
      skill,
    };
    for (let i = 0; i < 5; i += 1) {
      recordExposure(policy, {
        ...scenario,
        now: `2026-03-28T00:${String(idx).padStart(2, "0")}:${i}0.000Z`,
      });
      recordOutcome(policy, {
        ...scenario,
        outcome: "win",
        now: `2026-03-28T00:${String(idx).padStart(2, "0")}:${i}5.000Z`,
      });
    }
  }
  return policy;
}

describe("applyPromptPolicyRecall", () => {
  test("recalls a verified winner when prompt matching found nothing", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: [],
      matchedSkills: [],
      seenSkills: [],
      maxSkills: 2,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(result.selectedSkills).toEqual(["verification"]);
    expect(result.matchedSkills).toEqual(["verification"]);
    expect(result.syntheticSkills).toEqual(["verification"]);
    expect(result.reasons["verification"]).toContain(
      "route-scoped verified policy recall",
    );
  });

  test("inserts the recalled skill into slot 2 without displacing the explicit prompt match", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: ["investigation-mode"],
      matchedSkills: ["investigation-mode"],
      seenSkills: [],
      maxSkills: 2,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(result.selectedSkills).toEqual([
      "investigation-mode",
      "verification",
    ]);
    expect(result.syntheticSkills).toEqual(["verification"]);
  });

  test("does not recall a skill that is already seen", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: [],
      matchedSkills: [],
      seenSkills: ["verification"],
      maxSkills: 2,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(result.selectedSkills).toEqual([]);
    expect(result.syntheticSkills).toEqual([]);
  });

  test("preserves diagnosis order when multiple recalled skills are inserted", () => {
    const policy = buildOrderedWinningPolicy(["verification", "investigation"]);
    const result = applyPromptPolicyRecall({
      selectedSkills: ["explicit"],
      matchedSkills: ["explicit"],
      seenSkills: [],
      maxSkills: 3,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    const recalledOrder =
      result.diagnosis?.selected.map((candidate) => candidate.skill) ?? [];
    expect(result.selectedSkills).toEqual(["explicit", ...recalledOrder]);
    expect(result.syntheticSkills).toEqual(recalledOrder);
  });

  test("returns unchanged when no storyId", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: ["existing"],
      matchedSkills: ["existing"],
      maxSkills: 2,
      binding: {
        storyId: null,
        storyKind: null,
        route: null,
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(result.selectedSkills).toEqual(["existing"]);
    expect(result.syntheticSkills).toEqual([]);
    expect(result.diagnosis).toBeNull();
  });

  test("returns unchanged when no targetBoundary", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: [],
      matchedSkills: [],
      maxSkills: 2,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: null,
      },
      policy,
    });
    expect(result.selectedSkills).toEqual([]);
    expect(result.syntheticSkills).toEqual([]);
    expect(result.diagnosis).toBeNull();
  });

  test("does not recall when all slots are full", () => {
    const policy = buildWinningPolicy("verification");
    const result = applyPromptPolicyRecall({
      selectedSkills: ["a", "b"],
      matchedSkills: ["a", "b"],
      maxSkills: 2,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(result.selectedSkills).toEqual(["a", "b"]);
    expect(result.syntheticSkills).toEqual([]);
    expect(result.diagnosis).toBeNull();
  });

  test("does not mutate caller arrays", () => {
    const policy = buildWinningPolicy("verification");
    const selected = ["existing"];
    const matched = ["existing"];
    applyPromptPolicyRecall({
      selectedSkills: selected,
      matchedSkills: matched,
      maxSkills: 3,
      binding: {
        storyId: "story-1",
        storyKind: "flow-verification",
        route: "/settings",
        targetBoundary: "clientRequest",
      },
      policy,
    });
    expect(selected).toEqual(["existing"]);
    expect(matched).toEqual(["existing"]);
  });
});
