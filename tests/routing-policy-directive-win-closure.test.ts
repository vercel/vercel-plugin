import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  projectPolicyPath,
  sessionExposurePath,
  appendSkillExposure,
  loadSessionExposures,
  loadProjectRoutingPolicy,
  resolveBoundaryOutcome,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";

// ---------------------------------------------------------------------------
// Fixtures — deterministic timestamps, no wall-clock dependence
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/tmp/test-directive-win-closure";
const SESSION_ID = "directive-win-closure-" + Date.now();

const T0 = "2026-03-27T07:00:00.000Z";
const T1 = "2026-03-27T07:01:00.000Z";
const T2 = "2026-03-27T07:02:00.000Z";

function exposure(id: string, overrides: Partial<SkillExposure> = {}): SkillExposure {
  return {
    id,
    sessionId: SESSION_ID,
    projectRoot: PROJECT_ROOT,
    storyId: "story-settings",
    storyKind: "flow-verification",
    route: "/settings",
    hook: "PreToolUse",
    toolName: "Bash",
    skill: "agent-browser-verify",
    targetBoundary: "clientRequest",
    exposureGroupId: null,
    attributionRole: "candidate",
    candidateSkill: null,
    createdAt: T0,
    resolvedAt: null,
    outcome: "pending",
    ...overrides,
  };
}

function cleanup() {
  try { unlinkSync(projectPolicyPath(PROJECT_ROOT)); } catch {}
  try { unlinkSync(sessionExposurePath(SESSION_ID)); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("directive-win closure", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("pending route-scoped exposure closes as directive-win when matchedSuggestedAction is true", () => {
    appendSkillExposure(exposure("dw-1", { createdAt: T0 }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe("directive-win");
    expect(resolved[0].resolvedAt).toBe(T1);
    expect(resolved[0].id).toBe("dw-1");
  });

  test("directive-win increments both wins and directiveWins in persisted policy", () => {
    appendSkillExposure(exposure("dw-2", { createdAt: T0 }));

    resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
    expect(stats).toBeDefined();
    expect(stats!.directiveWins).toBe(1);
    expect(stats!.wins).toBe(1);
    expect(stats!.exposures).toBe(1);
  });

  test("multiple directive-wins accumulate deterministically", () => {
    // Append three independent pending exposures
    appendSkillExposure(exposure("dw-a", { createdAt: T0 }));
    appendSkillExposure(exposure("dw-b", { createdAt: T0 }));
    appendSkillExposure(exposure("dw-c", { createdAt: T0 }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    expect(resolved).toHaveLength(3);
    resolved.forEach((e) => expect(e.outcome).toBe("directive-win"));

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
    expect(stats!.directiveWins).toBe(3);
    expect(stats!.wins).toBe(3);
  });

  test("win (not directive-win) when matchedSuggestedAction is false", () => {
    appendSkillExposure(exposure("win-1", { createdAt: T0 }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: false,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe("win");

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
    expect(stats!.wins).toBe(1);
    expect(stats!.directiveWins).toBe(0);
  });

  test("route mismatch prevents closure — strict scoping", () => {
    appendSkillExposure(exposure("scope-1", { route: "/dashboard", createdAt: T0 }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    expect(resolved).toHaveLength(0);

    // Exposure remains pending in session ledger
    const exposures = loadSessionExposures(SESSION_ID);
    expect(exposures[0].outcome).toBe("pending");
  });

  test("storyId mismatch prevents closure", () => {
    appendSkillExposure(exposure("story-mismatch", { storyId: "other-story", createdAt: T0 }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });

    expect(resolved).toHaveLength(0);
  });

  test("already resolved exposure is not re-resolved", () => {
    appendSkillExposure(exposure("already-done", {
      createdAt: T0,
      outcome: "win",
      resolvedAt: T1,
    }));

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T2,
    });

    expect(resolved).toHaveLength(0);
  });

  test("idempotent — resolving again after all are closed yields empty", () => {
    appendSkillExposure(exposure("idem-1", { createdAt: T0 }));

    const first = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });
    expect(first).toHaveLength(1);

    const second = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T2,
    });
    expect(second).toHaveLength(0);
  });

  test("null route in exposure only matches null observed route (strict null matching)", () => {
    appendSkillExposure(exposure("null-route", { route: null, createdAt: T0 }));

    // Non-null route should NOT match the null-route exposure
    const mismatch = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: "/settings",
      now: T1,
    });
    expect(mismatch).toHaveLength(0);

    // Null route should match
    const match = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: "story-settings",
      route: null,
      now: T2,
    });
    expect(match).toHaveLength(1);
    expect(match[0].outcome).toBe("directive-win");
  });
});
