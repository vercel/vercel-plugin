import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  chooseAttributedSkill,
  buildAttributionDecision,
} from "../hooks/src/routing-attribution.mts";
import {
  projectPolicyPath,
  sessionExposurePath,
  appendSkillExposure,
  loadSessionExposures,
  loadProjectRoutingPolicy,
  resolveBoundaryOutcome,
  finalizeStaleExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  distillRulesFromTrace,
  type LearnedRoutingRulesFile,
} from "../hooks/src/rule-distillation.mts";
import type { RoutingDecisionTrace } from "../hooks/src/routing-decision-trace.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/tmp/test-attribution-project";
const SESSION_ID = "attribution-test-" + Date.now();

const T0 = "2026-03-27T05:00:00.000Z";
const T1 = "2026-03-27T05:01:00.000Z";
const T2 = "2026-03-27T05:02:00.000Z";
const T3 = "2026-03-27T05:03:00.000Z";
const T_END = "2026-03-27T05:30:00.000Z";

function exposure(
  id: string,
  overrides: Partial<SkillExposure> = {},
): SkillExposure {
  return {
    id,
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
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

function cleanupFiles() {
  try { unlinkSync(projectPolicyPath(PROJECT_ROOT)); } catch {}
  try { unlinkSync(sessionExposurePath(SESSION_ID)); } catch {}
}

// ---------------------------------------------------------------------------
// chooseAttributedSkill
// ---------------------------------------------------------------------------

describe("chooseAttributedSkill", () => {
  test("returns null for empty batch", () => {
    expect(chooseAttributedSkill([])).toBeNull();
  });

  test("returns first loaded skill when no preferred", () => {
    expect(chooseAttributedSkill(["a", "b", "c"])).toBe("a");
  });

  test("prefers a skill in preferredSkills set", () => {
    expect(
      chooseAttributedSkill(
        ["verification", "agent-browser-verify"],
        ["verification"],
      ),
    ).toBe("verification");
  });

  test("falls back to first when no preferred match", () => {
    expect(
      chooseAttributedSkill(["a", "b"], ["z"]),
    ).toBe("a");
  });

  test("returns first preferred match in load order", () => {
    expect(
      chooseAttributedSkill(
        ["x", "y", "z"],
        ["z", "y"],
      ),
    ).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// buildAttributionDecision
// ---------------------------------------------------------------------------

describe("buildAttributionDecision", () => {
  test("produces stable exposureGroupId segments", () => {
    const decision = buildAttributionDecision({
      sessionId: "sess-1",
      hook: "PreToolUse",
      storyId: "story-1",
      route: "/settings",
      targetBoundary: "clientRequest",
      loadedSkills: ["verification", "agent-browser-verify"],
      now: "2026-03-27T05:00:00.000Z",
    });

    expect(decision.exposureGroupId).toBe(
      "sess-1:PreToolUse:story-1:/settings:clientRequest:2026-03-27T05:00:00.000Z",
    );
    expect(decision.candidateSkill).toBe("verification");
    expect(decision.loadedSkills).toEqual(["verification", "agent-browser-verify"]);
  });

  test("null storyId/route/boundary become placeholder segments", () => {
    const decision = buildAttributionDecision({
      sessionId: "sess-1",
      hook: "UserPromptSubmit",
      storyId: null,
      route: null,
      targetBoundary: null,
      loadedSkills: ["next-config"],
      now: "2026-03-27T05:00:00.000Z",
    });

    expect(decision.exposureGroupId).toContain("none:*:none");
    expect(decision.candidateSkill).toBe("next-config");
  });

  test("preferredSkills overrides load-order selection", () => {
    const decision = buildAttributionDecision({
      sessionId: "sess-1",
      hook: "PreToolUse",
      storyId: null,
      route: null,
      targetBoundary: null,
      loadedSkills: ["a", "b", "c"],
      preferredSkills: ["c"],
      now: "2026-03-27T05:00:00.000Z",
    });

    expect(decision.candidateSkill).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// Candidate-vs-context policy gating (critical acceptance test)
// ---------------------------------------------------------------------------

describe("candidate-vs-context policy gating", () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  test("two skills in same group: only candidate updates policy on win", () => {
    const groupId = "group-1";

    // Candidate: agent-browser-verify
    appendSkillExposure(exposure("e1", {
      skill: "agent-browser-verify",
      exposureGroupId: groupId,
      attributionRole: "candidate",
      candidateSkill: "agent-browser-verify",
      createdAt: T0,
    }));

    // Context: verification
    appendSkillExposure(exposure("e2", {
      skill: "verification",
      exposureGroupId: groupId,
      attributionRole: "context",
      candidateSkill: "agent-browser-verify",
      createdAt: T1,
    }));

    // Both get resolved (outcome set on both)
    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "uiRender",
      matchedSuggestedAction: false,
      storyId: "story-1",
      route: "/dashboard",
      now: T2,
    });

    // Both exposures are resolved in the ledger
    expect(resolved).toHaveLength(2);
    expect(resolved.every((e) => e.outcome === "win")).toBe(true);

    // Full history is preserved in session JSONL
    const all = loadSessionExposures(SESSION_ID);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.outcome === "win")).toBe(true);

    // BUT only the candidate's policy stats are updated
    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";

    const candidateStats = policy.scenarios[scenario]?.["agent-browser-verify"];
    expect(candidateStats).toBeDefined();
    expect(candidateStats!.wins).toBe(1);
    expect(candidateStats!.exposures).toBe(1);

    // Context skill should have NO policy entry
    const contextStats = policy.scenarios[scenario]?.["verification"];
    expect(contextStats).toBeUndefined();
  });

  test("context exposure records to JSONL but not to policy on append", () => {
    appendSkillExposure(exposure("ctx-1", {
      skill: "helper-skill",
      attributionRole: "context",
      candidateSkill: "main-skill",
      exposureGroupId: "group-2",
      createdAt: T0,
    }));

    // JSONL has the exposure
    const all = loadSessionExposures(SESSION_ID);
    expect(all).toHaveLength(1);
    expect(all[0].skill).toBe("helper-skill");

    // Policy does NOT have an exposure count for helper-skill
    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";
    expect(policy.scenarios[scenario]?.["helper-skill"]).toBeUndefined();
  });

  test("stale-miss finalization only updates policy for candidate", () => {
    appendSkillExposure(exposure("stale-cand", {
      skill: "candidate-skill",
      attributionRole: "candidate",
      candidateSkill: "candidate-skill",
      exposureGroupId: "group-stale",
      createdAt: T0,
    }));

    appendSkillExposure(exposure("stale-ctx", {
      skill: "context-skill",
      attributionRole: "context",
      candidateSkill: "candidate-skill",
      exposureGroupId: "group-stale",
      createdAt: T1,
    }));

    const stale = finalizeStaleExposures(SESSION_ID, T_END);

    // Both exposures are marked stale in the ledger
    expect(stale).toHaveLength(2);
    expect(stale.every((e) => e.outcome === "stale-miss")).toBe(true);

    // Only candidate updates policy
    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";

    const candStats = policy.scenarios[scenario]?.["candidate-skill"];
    expect(candStats).toBeDefined();
    expect(candStats!.staleMisses).toBe(1);

    const ctxStats = policy.scenarios[scenario]?.["context-skill"];
    expect(ctxStats).toBeUndefined();
  });

  test("legacy rows without attributionRole default to candidate behavior", () => {
    // Simulate a legacy exposure (no attribution fields)
    const legacyExposure: SkillExposure = {
      id: "legacy-1",
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/dashboard",
      hook: "PreToolUse",
      toolName: "Bash",
      skill: "legacy-skill",
      targetBoundary: "uiRender",
      exposureGroupId: null,
      attributionRole: undefined as any, // Simulate missing field
      candidateSkill: null,
      createdAt: T0,
      resolvedAt: null,
      outcome: "pending",
    };

    appendSkillExposure(legacyExposure);

    // Should still update policy (backward compat)
    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";
    expect(policy.scenarios[scenario]?.["legacy-skill"]).toBeDefined();
    expect(policy.scenarios[scenario]!["legacy-skill"]!.exposures).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Distillation-level attribution: context-only skills produce no rules
  // ---------------------------------------------------------------------------

  test("distillation pipeline: candidate-only attribution produces rules, context does not", () => {
    const DISTILL_TS = "2026-03-28T06:00:00.000Z";

    // Build traces with both candidate and context skills ranked
    const traces: RoutingDecisionTrace[] = Array.from({ length: 8 }, (_, i) => ({
      version: 2 as const,
      decisionId: `distill-attr-${i}`,
      sessionId: SESSION_ID,
      hook: "PreToolUse" as const,
      toolName: "Read" as const,
      toolTarget: "/app/page.tsx",
      timestamp: DISTILL_TS,
      primaryStory: {
        id: "story-1",
        kind: "feature",
        storyRoute: "/app",
        targetBoundary: "uiRender",
      },
      observedRoute: "/app",
      policyScenario: null,
      matchedSkills: ["main-skill", "helper-skill"],
      injectedSkills: ["main-skill", "helper-skill"],
      skippedReasons: [],
      ranked: [
        {
          skill: "main-skill",
          basePriority: 6,
          effectivePriority: 6,
          pattern: { type: "path", value: "app/**" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
        {
          skill: "helper-skill",
          basePriority: 4,
          effectivePriority: 4,
          pattern: { type: "path", value: "**/*.tsx" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
      ],
      verification: {
        verificationId: `v-attr-${i}`,
        observedBoundary: "uiRender",
        matchedSuggestedAction: true,
      },
    }));

    // Candidate exposures for main-skill
    const candidateExposures: SkillExposure[] = Array.from({ length: 8 }, (_, i) => ({
      id: `cand-exp-${i}`,
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      storyId: "story-1",
      storyKind: "feature",
      route: "/app",
      hook: "PreToolUse" as const,
      toolName: "Read" as const,
      skill: "main-skill",
      targetBoundary: "uiRender",
      exposureGroupId: `group-${i}`,
      attributionRole: "candidate" as const,
      candidateSkill: "main-skill",
      createdAt: DISTILL_TS,
      resolvedAt: DISTILL_TS,
      outcome: "win" as const,
    }));

    // Context exposures for helper-skill
    const contextExposures: SkillExposure[] = Array.from({ length: 8 }, (_, i) => ({
      id: `ctx-exp-${i}`,
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      storyId: "story-1",
      storyKind: "feature",
      route: "/app",
      hook: "PreToolUse" as const,
      toolName: "Read" as const,
      skill: "helper-skill",
      targetBoundary: "uiRender",
      exposureGroupId: `group-${i}`,
      attributionRole: "context" as const,
      candidateSkill: "main-skill",
      createdAt: DISTILL_TS,
      resolvedAt: DISTILL_TS,
      outcome: "win" as const,
    }));

    const result: LearnedRoutingRulesFile = distillRulesFromTrace({
      projectRoot: PROJECT_ROOT,
      traces,
      exposures: [...candidateExposures, ...contextExposures],
      policy: { scenarios: {} },
      generatedAt: DISTILL_TS,
    });

    // candidate main-skill should have rules
    const mainRules = result.rules.filter((r) => r.skill === "main-skill");
    expect(mainRules.length).toBeGreaterThanOrEqual(1);

    // context helper-skill should have ZERO rules
    const helperRules = result.rules.filter((r) => r.skill === "helper-skill");
    expect(helperRules).toEqual([]);
  });

  test("directive-win only credits candidate in policy", () => {
    appendSkillExposure(exposure("dw-cand", {
      skill: "verification",
      attributionRole: "candidate",
      candidateSkill: "verification",
      exposureGroupId: "group-dw",
      createdAt: T0,
    }));

    appendSkillExposure(exposure("dw-ctx", {
      skill: "agent-browser-verify",
      attributionRole: "context",
      candidateSkill: "verification",
      exposureGroupId: "group-dw",
      createdAt: T1,
    }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "uiRender",
      matchedSuggestedAction: true,
      storyId: "story-1",
      route: "/dashboard",
      now: T3,
    });

    expect(resolved).toHaveLength(2);
    expect(resolved.every((e) => e.outcome === "directive-win")).toBe(true);

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const scenario = "PreToolUse|flow-verification|uiRender|Bash";

    // Candidate gets wins + directiveWins
    const candStats = policy.scenarios[scenario]?.["verification"];
    expect(candStats!.wins).toBe(1);
    expect(candStats!.directiveWins).toBe(1);

    // Context gets nothing in policy
    expect(policy.scenarios[scenario]?.["agent-browser-verify"]).toBeUndefined();
  });
});
