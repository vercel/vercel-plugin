import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  recordObservation,
  recordStory,
  storyId,
  type VerificationObservation,
  type VerificationBoundary,
} from "../hooks/src/verification-ledger.mts";
import { verifyPlan, formatPlanHuman } from "../src/commands/verify-plan.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = "2026-03-26T12:00:00.000Z";

function makeObs(
  id: string,
  boundary: VerificationBoundary | null,
  opts?: Partial<VerificationObservation>,
): VerificationObservation {
  return {
    id,
    timestamp: T0,
    source: "bash",
    boundary,
    route: null,
    storyId: null,
    summary: `obs-${id}`,
    ...opts,
  };
}

let testSessionId: string;

beforeEach(() => {
  testSessionId = `test-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${testSessionId}-ledger`), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// verifyPlan command
// ---------------------------------------------------------------------------

describe("verifyPlan command", () => {
  test("returns empty result for nonexistent session", () => {
    const result = verifyPlan({ sessionId: "nonexistent-session-xyz" });
    expect(result.hasStories).toBe(false);
    expect(result.observationCount).toBe(0);
  });

  test("returns plan for session with data", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings fails", ["verification"]);
    recordObservation(testSessionId, makeObs("c1", "clientRequest", { route: "/settings" }));

    const result = verifyPlan({ sessionId: testSessionId });
    expect(result.hasStories).toBe(true);
    expect(result.stories).toHaveLength(1);
    expect(result.observationCount).toBe(1);
    expect(result.satisfiedBoundaries).toContain("clientRequest");
    expect(result.primaryNextAction).not.toBeNull();
  });

  test("respects agentBrowserAvailable option", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("a", "clientRequest"));
    recordObservation(testSessionId, makeObs("b", "serverHandler"));
    recordObservation(testSessionId, makeObs("c", "environment"));

    const result = verifyPlan({
      sessionId: testSessionId,
      agentBrowserAvailable: false,
    });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons.some((r) => r.includes("agent-browser"))).toBe(true);
  });

  test("respects devServerLoopGuardHit option", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("a", "clientRequest"));
    recordObservation(testSessionId, makeObs("b", "serverHandler"));
    recordObservation(testSessionId, makeObs("c", "environment"));

    const result = verifyPlan({
      sessionId: testSessionId,
      devServerLoopGuardHit: true,
    });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons.some((r) => r.includes("loop guard"))).toBe(true);
  });

  test("returns stable JSON for same fixture state", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "test", []);
    recordObservation(testSessionId, makeObs("s1", "clientRequest", { route: "/settings" }));
    recordObservation(testSessionId, makeObs("s2", "serverHandler", { route: "/settings" }));

    const r1 = verifyPlan({ sessionId: testSessionId });
    const r2 = verifyPlan({ sessionId: testSessionId });
    expect(JSON.stringify(r1, null, 2)).toBe(JSON.stringify(r2, null, 2));
  });

  test("exits zero — does not throw on valid execution", () => {
    expect(() => verifyPlan({ sessionId: testSessionId })).not.toThrow();
  });

  test("auto-detects the most recently updated session ledger", () => {
    const olderSessionId = `${testSessionId}-zzz-older`;
    const newerSessionId = `${testSessionId}-aaa-newer`;
    const previousSessionId = process.env.CLAUDE_SESSION_ID;

    try {
      recordStory(olderSessionId, "flow-verification", "/older", "older session", []);
      recordObservation(olderSessionId, makeObs("older-1", "clientRequest", { route: "/older" }));

      recordStory(newerSessionId, "flow-verification", "/newer", "newer session", []);
      recordObservation(newerSessionId, makeObs("newer-1", "serverHandler", { route: "/newer" }));

      delete process.env.CLAUDE_SESSION_ID;

      const result = verifyPlan();
      expect(result.hasStories).toBe(true);
      expect(result.stories[0]?.route).toBe("/newer");
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.CLAUDE_SESSION_ID;
      } else {
        process.env.CLAUDE_SESSION_ID = previousSessionId;
      }
      rmSync(join(tmpdir(), `vercel-plugin-${olderSessionId}-ledger`), { recursive: true, force: true });
      rmSync(join(tmpdir(), `vercel-plugin-${newerSessionId}-ledger`), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// JSON output stability
// ---------------------------------------------------------------------------

describe("JSON output stability", () => {
  test("result has expected shape", () => {
    recordStory(testSessionId, "stuck-investigation", null, "hangs on load", []);
    recordObservation(testSessionId, makeObs("j1", "environment", { summary: "printenv" }));

    const result = verifyPlan({ sessionId: testSessionId });

    expect(typeof result.hasStories).toBe("boolean");
    expect(Array.isArray(result.stories)).toBe(true);
    expect(typeof result.observationCount).toBe("number");
    expect(Array.isArray(result.satisfiedBoundaries)).toBe(true);
    expect(Array.isArray(result.missingBoundaries)).toBe(true);
    expect(Array.isArray(result.recentRoutes)).toBe(true);
    expect(Array.isArray(result.blockedReasons)).toBe(true);
    // primaryNextAction is either object or null
    expect(result.primaryNextAction === null || typeof result.primaryNextAction === "object").toBe(true);
  });

  test("result is JSON-serializable", () => {
    recordStory(testSessionId, "flow-verification", "/", "test", ["skill-a"]);
    const result = verifyPlan({ sessionId: testSessionId });

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.hasStories).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Human output format
// ---------------------------------------------------------------------------

describe("human output format", () => {
  test("human output matches JSON data", () => {
    recordStory(testSessionId, "flow-verification", "/api/save", "save endpoint fails", ["verification"]);
    recordObservation(testSessionId, makeObs("h1", "clientRequest", { route: "/api/save" }));

    const result = verifyPlan({ sessionId: testSessionId });
    const human = formatPlanHuman(result);

    // Human output should reflect the same data
    expect(human).toContain("flow-verification");
    expect(human).toContain("/api/save");
    if (result.primaryNextAction) {
      expect(human).toContain(result.primaryNextAction.action);
    }
  });

  test("human output includes active story details, reason, and other stories summary", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("h-s1", "clientRequest", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
    }));
    recordObservation(testSessionId, makeObs("h-s2", "serverHandler", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
    }));

    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    const result = verifyPlan({ sessionId: testSessionId });
    const human = formatPlanHuman(result);

    // Active story header
    expect(human).toContain("Active story:");
    expect(human).toContain("/dashboard");
    expect(human).toContain("dashboard broken");

    // Evidence for active story (dashboard has 0 boundaries)
    expect(human).toContain("Evidence: 0/4 boundaries satisfied");

    // Next action with reason
    expect(human).toContain("Next action:");
    expect(human).toContain("Reason:");

    // Other stories compact summary
    expect(human).toContain("Other stories:");
    expect(human).toContain("/settings");
    expect(human).toContain("2/4 boundaries satisfied");
  });
});

// ---------------------------------------------------------------------------
// CLI JSON: activeStoryId and storyStates equivalence
// ---------------------------------------------------------------------------

describe("CLI JSON active-story equivalence", () => {
  test("JSON output includes activeStoryId and storyStates array", () => {
    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard save fails", ["verification"]);

    const result = verifyPlan({ sessionId: testSessionId });

    expect(result.activeStoryId).toBe(storyId("flow-verification", "/dashboard"));
    expect(Array.isArray(result.storyStates)).toBe(true);
    expect(result.storyStates.length).toBe(1);
    expect(result.storyStates[0].storyId).toBe(result.activeStoryId);
  });

  test("active storyStates entry matches top-level fields exactly", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("eq-1", "clientRequest", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
    }));

    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    const result = verifyPlan({ sessionId: testSessionId });

    // Active story is /dashboard (more missing boundaries)
    expect(result.activeStoryId).toBe(storyId("flow-verification", "/dashboard"));

    const activeState = result.storyStates.find((s) => s.storyId === result.activeStoryId);
    expect(activeState).toBeDefined();

    // The active entry's fields must match the top-level projection exactly
    expect([...activeState!.satisfiedBoundaries].sort()).toEqual([...result.satisfiedBoundaries].sort());
    expect([...activeState!.missingBoundaries].sort()).toEqual([...result.missingBoundaries].sort());
    expect(activeState!.recentRoutes).toEqual(result.recentRoutes);
    expect(JSON.stringify(activeState!.primaryNextAction)).toBe(JSON.stringify(result.primaryNextAction));
    expect(activeState!.blockedReasons).toEqual(result.blockedReasons);
  });

  test("multi-story JSON preserves isolation between active and non-active stories", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("ms-1", "clientRequest", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
    }));
    recordObservation(testSessionId, makeObs("ms-2", "serverHandler", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
    }));

    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    const result = verifyPlan({ sessionId: testSessionId });

    // Active story (/dashboard) has 0 satisfied, 4 missing
    expect(result.satisfiedBoundaries).toHaveLength(0);
    expect(result.missingBoundaries).toHaveLength(4);

    // Non-active story (/settings) has 2 satisfied
    const settingsState = result.storyStates.find((s) => s.route === "/settings");
    expect(settingsState!.satisfiedBoundaries).toContain("clientRequest");
    expect(settingsState!.satisfiedBoundaries).toContain("serverHandler");
    expect(settingsState!.satisfiedBoundaries).toHaveLength(2);
  });
});
