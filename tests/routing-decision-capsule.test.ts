import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  buildDecisionCapsule,
  buildDecisionCapsuleEnv,
  decisionCapsuleDir,
  decisionCapsulePath,
  persistDecisionCapsule,
  readDecisionCapsule,
} from "../hooks/src/routing-decision-capsule.mts";
import type { RoutingDecisionTrace } from "../hooks/src/routing-decision-trace.mts";
import type { VerificationDirective } from "../hooks/src/verification-directive.mts";

const SESSION_ID = "decision-capsule-test";

afterEach(() => {
  rmSync(decisionCapsuleDir(SESSION_ID), { recursive: true, force: true });
});

function makeTrace(
  overrides?: Partial<RoutingDecisionTrace>,
): RoutingDecisionTrace {
  return {
    version: 2,
    decisionId: "abc123def4567890",
    sessionId: SESSION_ID,
    hook: "PreToolUse",
    toolName: "Read",
    toolTarget: "app/page.tsx",
    timestamp: "2026-03-28T02:30:00.000Z",
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/settings",
      targetBoundary: "uiRender",
    },
    observedRoute: null,
    policyScenario: "PreToolUse|flow-verification|uiRender|Read",
    matchedSkills: ["nextjs", "react-best-practices"],
    injectedSkills: ["nextjs"],
    skippedReasons: [],
    ranked: [
      {
        skill: "nextjs",
        basePriority: 7,
        effectivePriority: 12,
        pattern: { type: "suffix", value: "app/**/*.tsx" },
        profilerBoost: 5,
        policyBoost: 0,
        policyReason: null,
        matchedRuleId: null,
        ruleBoost: 0,
        ruleReason: null,
        rulebookPath: null,
        summaryOnly: false,
        synthetic: false,
        droppedReason: null,
      },
    ],
    verification: {
      verificationId: "verify-1",
      observedBoundary: null,
      matchedSuggestedAction: null,
    },
    ...overrides,
  };
}

function makeDirective(
  overrides?: Partial<VerificationDirective>,
): VerificationDirective {
  return {
    version: 1,
    storyId: "story-1",
    storyKind: "flow-verification",
    route: "/settings",
    missingBoundaries: ["uiRender"],
    satisfiedBoundaries: ["clientRequest", "serverHandler"],
    primaryNextAction: {
      action: "open /settings in agent-browser",
      targetBoundary: "uiRender",
      reason: "No UI render observation yet",
    },
    blockedReasons: [],
    ...overrides,
  };
}

describe("routing decision capsule", () => {
  test("buildDecisionCapsule returns v1 payload with stable sha256", () => {
    const trace = makeTrace();
    const directive = makeDirective();

    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: trace.toolName,
      toolTarget: trace.toolTarget,
      platform: "claude-code",
      trace,
      directive,
      attribution: {
        exposureGroupId: "group-1",
        candidateSkill: "nextjs",
        loadedSkills: ["nextjs"],
      },
      reasons: {
        nextjs: { trigger: "suffix", reasonCode: "pattern-match" },
      },
      env: { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings" },
    });

    expect(capsule.type).toBe("routing.decision-capsule/v1");
    expect(capsule.version).toBe(1);
    expect(capsule.decisionId).toBe("abc123def4567890");
    expect(capsule.hook).toBe("PreToolUse");
    expect(capsule.input.platform).toBe("claude-code");
    expect(capsule.activeStory.id).toBe("story-1");
    expect(capsule.injectedSkills).toEqual(["nextjs"]);
    expect(capsule.sha256).toBeString();
    expect(capsule.sha256).toHaveLength(64);
  });

  test("identical inputs produce identical sha256", () => {
    const trace = makeTrace();
    const directive = makeDirective();
    const args = {
      sessionId: SESSION_ID,
      hook: "PreToolUse" as const,
      createdAt: trace.timestamp,
      toolName: trace.toolName,
      toolTarget: trace.toolTarget,
      platform: "claude-code",
      trace,
      directive,
    };

    const a = buildDecisionCapsule(args);
    const b = buildDecisionCapsule(args);
    expect(a.sha256).toBe(b.sha256);
  });

  test("different inputs produce different sha256", () => {
    const trace1 = makeTrace({ decisionId: "id-1" });
    const trace2 = makeTrace({ decisionId: "id-2" });

    const a = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace1.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      trace: trace1,
      directive: null,
    });
    const b = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace2.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      trace: trace2,
      directive: null,
    });
    expect(a.sha256).not.toBe(b.sha256);
  });

  test("persist and read round-trip", () => {
    const trace = makeTrace();
    const directive = makeDirective();

    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: trace.toolName,
      toolTarget: trace.toolTarget,
      platform: "claude-code",
      trace,
      directive,
      attribution: {
        exposureGroupId: "group-1",
        candidateSkill: "nextjs",
        loadedSkills: ["nextjs"],
      },
      reasons: {
        nextjs: { trigger: "suffix", reasonCode: "pattern-match" },
      },
      env: { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings" },
    });

    const artifactPath = persistDecisionCapsule(capsule);
    const loaded = readDecisionCapsule(artifactPath);

    expect(loaded).not.toBeNull();
    expect(loaded!.decisionId).toBe(capsule.decisionId);
    expect(loaded!.sha256).toBe(capsule.sha256);
    expect(loaded!.type).toBe("routing.decision-capsule/v1");
    expect(loaded!.activeStory).toEqual(capsule.activeStory);
    expect(loaded!.attribution).toEqual(capsule.attribution);
  });

  test("buildDecisionCapsuleEnv returns correct env vars", () => {
    const trace = makeTrace();
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "app/page.tsx",
      trace,
      directive: null,
    });

    const artifactPath = persistDecisionCapsule(capsule);
    const env = buildDecisionCapsuleEnv(capsule, artifactPath);

    expect(env.VERCEL_PLUGIN_DECISION_ID).toBe(capsule.decisionId);
    expect(env.VERCEL_PLUGIN_DECISION_PATH).toBe(artifactPath);
    expect(env.VERCEL_PLUGIN_DECISION_SHA256).toBe(capsule.sha256);
  });

  test("readDecisionCapsule returns null for missing file", () => {
    const result = readDecisionCapsule("/nonexistent/path.json");
    expect(result).toBeNull();
  });

  test("decisionCapsulePath is session-scoped", () => {
    const pathA = decisionCapsulePath("session-a", "dec-1");
    const pathB = decisionCapsulePath("session-b", "dec-1");
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain("session-a");
    expect(pathB).toContain("session-b");
  });

  test("unsafe session IDs are hashed", () => {
    const path = decisionCapsulePath("../../etc/passwd", "dec-1");
    expect(path).not.toContain("../../");
    expect(path).toContain("-capsules/dec-1.json");
  });

  test("null session uses no-session segment", () => {
    const path = decisionCapsulePath(null, "dec-1");
    expect(path).toContain("no-session");
  });

  test("unknown platform defaults correctly", () => {
    const trace = makeTrace();
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      platform: "vscode",
      trace,
      directive: null,
    });
    expect(capsule.input.platform).toBe("unknown");
  });

  test("issues include no_active_verification_story when story id is null", () => {
    const trace = makeTrace({
      primaryStory: {
        id: null,
        kind: null,
        storyRoute: null,
        targetBoundary: null,
      },
    });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      trace,
      directive: null,
    });
    const codes = capsule.issues.map((i) => i.code);
    expect(codes).toContain("no_active_verification_story");
  });

  test("issues include budget_exhausted when skippedReasons has budget entry", () => {
    const trace = makeTrace({
      skippedReasons: ["budget_exhausted:tailwindcss"],
    });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      trace,
      directive: makeDirective(),
    });
    const codes = capsule.issues.map((i) => i.code);
    expect(codes).toContain("budget_exhausted");
  });

  test("issues include verification_blocked when directive has blocked reasons", () => {
    const trace = makeTrace();
    const directive = makeDirective({
      blockedReasons: ["missing browser agent"],
    });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "a.tsx",
      trace,
      directive,
    });
    const codes = capsule.issues.map((i) => i.code);
    expect(codes).toContain("verification_blocked");
  });

  test("rulebookProvenance is null when no rule fires", () => {
    const trace = makeTrace();
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Read",
      toolTarget: "app/page.tsx",
      trace,
      directive: null,
    });
    expect(capsule.rulebookProvenance).toBeNull();
  });

  test("rulebookProvenance is populated when a ranked entry has a matched rule", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 6,
          effectivePriority: 14,
          pattern: { type: "bash", value: "vercel dev" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          matchedRuleId: "PreToolUse|flow-verification|uiRender|Bash|agent-browser-verify",
          ruleBoost: 8,
          ruleReason: "replay verified: no regressions, learned routing matched winning skill",
          rulebookPath: "/tmp/vercel-plugin-routing-policy-abc-rulebook.json",
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
      ],
    });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Bash",
      toolTarget: "vercel dev",
      trace,
      directive: makeDirective(),
    });
    expect(capsule.rulebookProvenance).not.toBeNull();
    expect(capsule.rulebookProvenance!.matchedRuleId).toBe(
      "PreToolUse|flow-verification|uiRender|Bash|agent-browser-verify",
    );
    expect(capsule.rulebookProvenance!.ruleBoost).toBe(8);
    expect(capsule.rulebookProvenance!.ruleReason).toBe(
      "replay verified: no regressions, learned routing matched winning skill",
    );
    expect(capsule.rulebookProvenance!.rulebookPath).toBe(
      "/tmp/vercel-plugin-routing-policy-abc-rulebook.json",
    );
  });

  test("rulebookProvenance round-trips through persist and read", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 6,
          effectivePriority: 14,
          pattern: { type: "bash", value: "vercel dev" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          matchedRuleId: "PreToolUse|flow-verification|uiRender|Bash|agent-browser-verify",
          ruleBoost: 8,
          ruleReason: "replay verified",
          rulebookPath: "/tmp/rulebook.json",
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
      ],
    });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PreToolUse",
      createdAt: trace.timestamp,
      toolName: "Bash",
      toolTarget: "vercel dev",
      trace,
      directive: null,
    });
    const artifactPath = persistDecisionCapsule(capsule);
    const loaded = readDecisionCapsule(artifactPath);
    expect(loaded!.rulebookProvenance).toEqual(capsule.rulebookProvenance);
  });

  test("PostToolUse hook omits machine_output_hidden_in_html_comment issue", () => {
    const trace = makeTrace({ hook: "PostToolUse" });
    const capsule = buildDecisionCapsule({
      sessionId: SESSION_ID,
      hook: "PostToolUse",
      createdAt: trace.timestamp,
      toolName: "Write",
      toolTarget: "a.tsx",
      trace,
      directive: makeDirective(),
    });
    const codes = capsule.issues.map((i) => i.code);
    expect(codes).not.toContain("machine_output_hidden_in_html_comment");
  });
});
