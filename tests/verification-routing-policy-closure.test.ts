import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
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
  applyPolicyBoosts,
  derivePolicyBoost,
} from "../hooks/src/routing-policy.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/tmp/test-project-closure";
const SESSION_ID = "closure-test-session-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";
const T4 = "2026-03-27T04:04:00.000Z";
const T5 = "2026-03-27T04:05:00.000Z";
const T_END = "2026-03-27T04:30:00.000Z";

function exposure(id: string, overrides: Partial<SkillExposure> = {}): SkillExposure {
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
// Tests
// ---------------------------------------------------------------------------

describe("verification → routing-policy closure", () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  describe("acceptance: skill injection → boundary observation → policy update", () => {
    test("uiRender boundary win increments project policy wins", () => {
      // Simulate: agent-browser-verify injected while target boundary = uiRender
      appendSkillExposure(exposure("e1", { createdAt: T0 }));
      appendSkillExposure(exposure("e2", { createdAt: T1 }));
      appendSkillExposure(exposure("e3", { createdAt: T2 }));

      // Simulate: observer sees a uiRender boundary match
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T3,
      });

      expect(resolved).toHaveLength(3);
      resolved.forEach((e) => expect(e.outcome).toBe("win"));

      // Verify project policy
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.wins).toBe(3);
      expect(stats!.directiveWins).toBe(0);
    });

    test("directive-win increments both wins and directiveWins", () => {
      appendSkillExposure(exposure("e1", { createdAt: T0 }));

      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].outcome).toBe("directive-win");

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats!.wins).toBe(1);
      expect(stats!.directiveWins).toBe(1);
    });

    test("stale-miss on session end for unresolved exposures", () => {
      appendSkillExposure(exposure("e1", { createdAt: T0 }));
      appendSkillExposure(exposure("e2", { targetBoundary: "clientRequest", createdAt: T1 }));

      // Resolve only uiRender
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T3,
      });

      // Session end: finalize remaining
      const stale = finalizeStaleExposures(SESSION_ID, T_END);

      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("e2");
      expect(stale[0].outcome).toBe("stale-miss");

      // Policy should have 1 stale-miss for the clientRequest scenario
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const crStats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
      expect(crStats).toBeDefined();
      expect(crStats!.staleMisses).toBe(1);
      expect(crStats!.wins).toBe(0);
    });
  });

  describe("end-to-end: exposures → outcomes → policy boosts", () => {
    test("5 exposures with 4 wins produces policy boost of 8", () => {
      // Record 5 exposures
      for (let i = 0; i < 5; i++) {
        appendSkillExposure(exposure(`e${i}`, { createdAt: `2026-03-27T04:0${i}:00.000Z` }));
      }

      // Resolve 4 as wins
      // First batch: 4 exposures at once (simulate resolving 4)
      // We need to resolve in batches since they all match the same boundary
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T5,
      });

      // All 5 get resolved as wins (they all had targetBoundary=uiRender)
      // Let's adjust: make one exposure have a different boundary
      // to get exactly 4 wins out of 5 exposures
      cleanupFiles();

      for (let i = 0; i < 4; i++) {
        appendSkillExposure(exposure(`e${i}`, { createdAt: `2026-03-27T04:0${i}:00.000Z` }));
      }
      appendSkillExposure(exposure("e4", {
        targetBoundary: "clientRequest",
        createdAt: "2026-03-27T04:04:00.000Z",
      }));

      // Resolve 4 uiRender wins
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T5,
      });

      // Finalize the remaining 1 as stale
      finalizeStaleExposures(SESSION_ID, T_END);

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const uiStats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(uiStats!.wins).toBe(4);
      expect(uiStats!.exposures).toBe(4);

      const simulatedStats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]!["agent-browser-verify"];

      // rate = 4/5 = 0.80 → boost 8
      expect(derivePolicyBoost(simulatedStats)).toBe(8);

      const boosted = applyPolicyBoosts(
        [{ skill: "agent-browser-verify", priority: 7 }],
        {
          version: 1,
          scenarios: {
            "PreToolUse|flow-verification|uiRender|Bash": {
              "agent-browser-verify": simulatedStats,
            },
          },
        },
        {
          hook: "PreToolUse",
          storyKind: "flow-verification",
          targetBoundary: "uiRender",
          toolName: "Bash",
        },
      );

      expect(boosted[0].policyBoost).toBe(8);
      expect(boosted[0].effectivePriority).toBe(15);
    });
  });

  describe("mixed boundaries", () => {
    test("resolves only matching boundary exposures", () => {
      appendSkillExposure(exposure("ui-1", { targetBoundary: "uiRender", createdAt: T0 }));
      appendSkillExposure(exposure("cr-1", { targetBoundary: "clientRequest", createdAt: T1 }));
      appendSkillExposure(exposure("sh-1", { targetBoundary: "serverHandler", createdAt: T2 }));

      // Resolve only clientRequest
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("cr-1");
      expect(resolved[0].outcome).toBe("directive-win");

      // Others still pending
      const all = loadSessionExposures(SESSION_ID);
      expect(all.find((e) => e.id === "ui-1")!.outcome).toBe("pending");
      expect(all.find((e) => e.id === "sh-1")!.outcome).toBe("pending");

      // Finalize stale
      const stale = finalizeStaleExposures(SESSION_ID, T_END);
      expect(stale).toHaveLength(2);
      expect(stale.every((e) => e.outcome === "stale-miss")).toBe(true);
    });
  });

  describe("multi-skill exposure tracking", () => {
    test("resolves different skills for the same boundary independently", () => {
      appendSkillExposure(exposure("e1", {
        skill: "agent-browser-verify",
        createdAt: T0,
      }));
      appendSkillExposure(exposure("e2", {
        skill: "vercel-deploy",
        targetBoundary: "uiRender",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T3,
      });

      expect(resolved).toHaveLength(2);
      const skills = resolved.map((e) => e.skill).sort();
      expect(skills).toEqual(["agent-browser-verify", "vercel-deploy"]);
    });
  });

  describe("UserPromptSubmit exposures", () => {
    test("tracks prompt-based exposures with null targetBoundary", () => {
      appendSkillExposure(exposure("p1", {
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        targetBoundary: null,
        createdAt: T0,
      }));

      // These can only be finalized as stale (no boundary to match)
      const stale = finalizeStaleExposures(SESSION_ID, T_END);
      expect(stale).toHaveLength(1);
      expect(stale[0].outcome).toBe("stale-miss");

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const stats = policy.scenarios["UserPromptSubmit|flow-verification|none|Prompt"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.staleMisses).toBe(1);
    });
  });
});
