import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VerificationBoundary,
  type VerificationObservation,
  type VerificationStoryKind,
  derivePlan,
  recordObservation,
  recordStory,
  storyId,
} from "../hooks/src/verification-ledger.mts";
import {
  computePlan,
  planToResult,
  loadCachedPlanResult,
  formatVerificationBanner,
  formatPlanHuman,
  selectPrimaryStory,
  type VerificationPlanResult,
  type VerificationPlanStorySummary,
} from "../hooks/src/verification-plan.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = "2026-03-26T12:00:00.000Z";
const T1 = "2026-03-26T12:01:00.000Z";

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
  testSessionId = `test-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${testSessionId}-ledger`), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------

describe("computePlan", () => {
  test("returns empty result for new session", () => {
    const result = computePlan(testSessionId);
    expect(result.hasStories).toBe(false);
    expect(result.stories).toHaveLength(0);
    expect(result.observationCount).toBe(0);
    expect(result.primaryNextAction).toBeNull();
  });

  test("returns plan with story and observations", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(testSessionId, makeObs("obs-1", "clientRequest", { route: "/settings" }));
    recordObservation(testSessionId, makeObs("obs-2", "serverHandler", { route: "/settings" }));

    const result = computePlan(testSessionId);
    expect(result.hasStories).toBe(true);
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].kind).toBe("flow-verification");
    expect(result.observationCount).toBe(2);
    expect(result.satisfiedBoundaries).toContain("clientRequest");
    expect(result.satisfiedBoundaries).toContain("serverHandler");
    expect(result.missingBoundaries).toContain("uiRender");
    expect(result.missingBoundaries).toContain("environment");
  });

  test("next action is first missing boundary in priority order", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    const result = computePlan(testSessionId);
    expect(result.primaryNextAction).not.toBeNull();
    expect(result.primaryNextAction!.targetBoundary).toBe("clientRequest");
  });

  test("suppresses browser action when agent-browser unavailable", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("a", "clientRequest"));
    recordObservation(testSessionId, makeObs("b", "serverHandler"));
    recordObservation(testSessionId, makeObs("c", "environment"));

    const result = computePlan(testSessionId, { agentBrowserAvailable: false });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons.some((r) => r.includes("agent-browser"))).toBe(true);
  });

  test("suppresses browser action when loop guard hit", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("a", "clientRequest"));
    recordObservation(testSessionId, makeObs("b", "serverHandler"));
    recordObservation(testSessionId, makeObs("c", "environment"));

    const result = computePlan(testSessionId, { devServerLoopGuardHit: true });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons.some((r) => r.includes("loop guard"))).toBe(true);
  });

  test("deterministic for same fixture state", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(testSessionId, makeObs("obs-1", "clientRequest", { route: "/settings" }));

    const result1 = computePlan(testSessionId);
    const result2 = computePlan(testSessionId);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});

// ---------------------------------------------------------------------------
// planToResult
// ---------------------------------------------------------------------------

describe("planToResult", () => {
  test("converts plan to serializable result", () => {
    const plan = derivePlan(
      [makeObs("a", "clientRequest", { route: "/settings" })],
      [{ id: storyId("flow-verification", "/settings"), kind: "flow-verification", route: "/settings", promptExcerpt: "test", createdAt: T0, updatedAt: T0, requestedSkills: [] }],
    );
    const result = planToResult(plan);
    expect(result.hasStories).toBe(true);
    expect(result.observationCount).toBe(1);
    expect(result.satisfiedBoundaries).toContain("clientRequest");
    expect(Array.isArray(result.missingBoundaries)).toBe(true);
    expect(Array.isArray(result.recentRoutes)).toBe(true);
  });

  test("sorts boundaries in result", () => {
    const plan = derivePlan(
      [
        makeObs("a", "serverHandler"),
        makeObs("b", "clientRequest"),
      ],
      [{ id: storyId("flow-verification", null), kind: "flow-verification", route: null, promptExcerpt: "test", createdAt: T0, updatedAt: T0, requestedSkills: [] }],
    );
    const result = planToResult(plan);
    // satisfiedBoundaries should be sorted
    expect(result.satisfiedBoundaries).toEqual([...result.satisfiedBoundaries].sort());
    expect(result.missingBoundaries).toEqual([...result.missingBoundaries].sort());
  });
});

// ---------------------------------------------------------------------------
// loadCachedPlanResult
// ---------------------------------------------------------------------------

describe("loadCachedPlanResult", () => {
  test("returns null for nonexistent session", () => {
    expect(loadCachedPlanResult("nonexistent-session-xyz")).toBeNull();
  });

  test("returns cached result after recordObservation", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("cached-1", "clientRequest"));

    const result = loadCachedPlanResult(testSessionId);
    expect(result).not.toBeNull();
    expect(result!.hasStories).toBe(true);
    expect(result!.observationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatVerificationBanner
// ---------------------------------------------------------------------------

describe("formatVerificationBanner", () => {
  test("returns null when no stories", () => {
    const result: VerificationPlanResult = {
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: [],
    };
    expect(formatVerificationBanner(result)).toBeNull();
  });

  test("returns null when all boundaries satisfied and no next action", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      stories: [{ id: "abc", kind: "flow-verification", route: "/settings", promptExcerpt: "test", createdAt: T0, updatedAt: T0 }],
      observationCount: 4,
      satisfiedBoundaries: ["clientRequest", "environment", "serverHandler", "uiRender"],
      missingBoundaries: [],
      recentRoutes: ["/settings"],
      primaryNextAction: null,
      blockedReasons: [],
    };
    expect(formatVerificationBanner(result)).toBeNull();
  });

  test("includes story, evidence, and next action", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      stories: [{ id: "abc", kind: "flow-verification", route: "/settings", promptExcerpt: "save fails", createdAt: T0, updatedAt: T0 }],
      observationCount: 1,
      satisfiedBoundaries: ["clientRequest"],
      missingBoundaries: ["environment", "serverHandler", "uiRender"],
      recentRoutes: ["/settings"],
      primaryNextAction: {
        action: "tail server logs /settings",
        targetBoundary: "serverHandler",
        reason: "No server-side observation yet — check logs for errors",
      },
      blockedReasons: [],
    };
    const banner = formatVerificationBanner(result);
    expect(banner).not.toBeNull();
    expect(banner).toContain("<!-- verification-plan -->");
    expect(banner).toContain("flow-verification");
    expect(banner).toContain("/settings");
    expect(banner).toContain("save fails");
    expect(banner).toContain("1/4 boundaries satisfied");
    expect(banner).toContain("tail server logs");
    expect(banner).toContain("<!-- /verification-plan -->");
  });

  test("shows blocked reason when no next action possible", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      stories: [{ id: "abc", kind: "browser-only", route: null, promptExcerpt: "blank page", createdAt: T0, updatedAt: T0 }],
      observationCount: 3,
      satisfiedBoundaries: ["clientRequest", "environment", "serverHandler"],
      missingBoundaries: ["uiRender"],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: ["agent-browser unavailable — cannot emit browser-only action"],
    };
    const banner = formatVerificationBanner(result);
    expect(banner).not.toBeNull();
    expect(banner).toContain("Blocked:");
    expect(banner).toContain("agent-browser unavailable");
  });
});

// ---------------------------------------------------------------------------
// formatPlanHuman
// ---------------------------------------------------------------------------

describe("formatPlanHuman", () => {
  test("shows no stories message", () => {
    const result: VerificationPlanResult = {
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: [],
    };
    const output = formatPlanHuman(result);
    expect(output).toContain("No verification stories");
  });

  test("shows full plan details", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      activeStoryId: "abc",
      stories: [{ id: "abc", kind: "flow-verification", route: "/settings", promptExcerpt: "save fails", createdAt: T0, updatedAt: T0 }],
      storyStates: [{
        storyId: "abc",
        storyKind: "flow-verification",
        route: "/settings",
        observationIds: [],
        satisfiedBoundaries: ["clientRequest", "serverHandler"],
        missingBoundaries: ["environment", "uiRender"],
        recentRoutes: ["/settings"],
        primaryNextAction: {
          action: "open /settings in agent-browser",
          targetBoundary: "uiRender",
          reason: "No UI render observation yet",
        },
        blockedReasons: [],
        lastObservedAt: null,
      }],
      observationCount: 2,
      satisfiedBoundaries: ["clientRequest", "serverHandler"],
      missingBoundaries: ["environment", "uiRender"],
      recentRoutes: ["/settings"],
      primaryNextAction: {
        action: "open /settings in agent-browser",
        targetBoundary: "uiRender",
        reason: "No UI render observation yet",
      },
      blockedReasons: [],
    };
    const output = formatPlanHuman(result);
    expect(output).toContain("Active story:");
    expect(output).toContain("flow-verification");
    expect(output).toContain("/settings");
    expect(output).toContain("2/4 boundaries satisfied");
    expect(output).toContain("Next action:");
    expect(output).toContain("open /settings in agent-browser");
    expect(output).toContain("Reason:");
  });

  test("shows blocked reasons", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      stories: [{ id: "abc", kind: "stuck-investigation", route: null, promptExcerpt: "hangs", createdAt: T0, updatedAt: T0 }],
      observationCount: 3,
      satisfiedBoundaries: ["clientRequest", "environment", "serverHandler"],
      missingBoundaries: ["uiRender"],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: ["agent-browser unavailable", "dev-server loop guard hit"],
    };
    const output = formatPlanHuman(result);
    expect(output).toContain("Next action: blocked");
    expect(output).toContain("agent-browser unavailable");
    expect(output).toContain("dev-server loop guard hit");
  });

  test("shows all satisfied message", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      activeStoryId: "abc",
      stories: [{ id: "abc", kind: "flow-verification", route: null, promptExcerpt: "test", createdAt: T0, updatedAt: T0 }],
      storyStates: [],
      observationCount: 4,
      satisfiedBoundaries: ["clientRequest", "environment", "serverHandler", "uiRender"],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: [],
    };
    const output = formatPlanHuman(result);
    expect(output).toContain("All verification boundaries satisfied");
  });
});

// ---------------------------------------------------------------------------
// Fixture-based deterministic snapshots
// ---------------------------------------------------------------------------

describe("deterministic fixture snapshots", () => {
  test("settings page loads but save fails", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "settings page loads but save fails", ["verification"]);
    recordObservation(testSessionId, makeObs("f1-1", "clientRequest", { route: "/settings", summary: "curl http://localhost:3000/settings" }));
    recordObservation(testSessionId, makeObs("f1-2", "serverHandler", { route: "/settings", summary: "vercel logs" }));

    const result1 = computePlan(testSessionId);
    const result2 = computePlan(testSessionId);
    expect(JSON.stringify(result1, null, 2)).toBe(JSON.stringify(result2, null, 2));

    expect(result1.primaryNextAction).not.toBeNull();
    expect(result1.missingBoundaries).toContain("uiRender");
    expect(result1.missingBoundaries).toContain("environment");
  });

  test("blank page on dashboard", () => {
    recordStory(testSessionId, "browser-only", "/dashboard", "blank page on dashboard", ["agent-browser-verify"]);

    const result = computePlan(testSessionId);
    expect(result.hasStories).toBe(true);
    expect(result.missingBoundaries).toHaveLength(4);
    expect(result.primaryNextAction!.targetBoundary).toBe("clientRequest");
  });

  test("bash trace: pnpm dev -> curl -> vercel logs", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "test", []);
    recordObservation(testSessionId, makeObs("t1", "environment", { summary: "pnpm dev" }));
    recordObservation(testSessionId, makeObs("t2", "clientRequest", { route: "/settings", summary: "curl /settings" }));
    recordObservation(testSessionId, makeObs("t3", "serverHandler", { route: "/settings", summary: "vercel logs" }));

    const result = computePlan(testSessionId);
    expect(result.satisfiedBoundaries).toContain("environment");
    expect(result.satisfiedBoundaries).toContain("clientRequest");
    expect(result.satisfiedBoundaries).toContain("serverHandler");
    expect(result.missingBoundaries).toEqual(["uiRender"]);
  });

  test("env trace: vercel env pull / printenv", () => {
    recordStory(testSessionId, "stuck-investigation", null, "env vars missing", []);
    recordObservation(testSessionId, makeObs("e1", "environment", { summary: "vercel env pull" }));
    recordObservation(testSessionId, makeObs("e2", "environment", { summary: "printenv" }));

    const result = computePlan(testSessionId);
    expect(result.satisfiedBoundaries).toContain("environment");
    expect(result.missingBoundaries).not.toContain("environment");
  });

  test("unavailable browser case", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("b1", "clientRequest"));
    recordObservation(testSessionId, makeObs("b2", "serverHandler"));
    recordObservation(testSessionId, makeObs("b3", "environment"));

    const result = computePlan(testSessionId, { agentBrowserAvailable: false });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons).toHaveLength(1);
    expect(result.blockedReasons[0]).toContain("agent-browser unavailable");
  });

  test("repeated launch hitting loop guard", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("lg1", "clientRequest"));
    recordObservation(testSessionId, makeObs("lg2", "serverHandler"));
    recordObservation(testSessionId, makeObs("lg3", "environment"));

    const result = computePlan(testSessionId, { devServerLoopGuardHit: true });
    expect(result.primaryNextAction).toBeNull();
    expect(result.blockedReasons.some((r) => r.includes("loop guard"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No regressions to troubleshooting routing
// ---------------------------------------------------------------------------

describe("no regressions", () => {
  test("computePlan does not throw on missing session", () => {
    expect(() => computePlan("nonexistent-session")).not.toThrow();
  });

  test("planToResult handles empty plan", () => {
    const plan = derivePlan([], []);
    const result = planToResult(plan);
    expect(result.hasStories).toBe(false);
    expect(result.primaryNextAction).toBeNull();
  });

  test("formatVerificationBanner handles result with empty stories gracefully", () => {
    const result: VerificationPlanResult = {
      hasStories: true,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: ["clientRequest"],
      recentRoutes: [],
      primaryNextAction: { action: "curl /", targetBoundary: "clientRequest", reason: "test" },
      blockedReasons: [],
    };
    const banner = formatVerificationBanner(result);
    expect(banner).not.toBeNull();
    expect(banner).toContain("Next action:");
  });
});

// ---------------------------------------------------------------------------
// selectPrimaryStory
// ---------------------------------------------------------------------------

describe("selectPrimaryStory", () => {
  test("returns null for empty array", () => {
    expect(selectPrimaryStory([])).toBeNull();
  });

  test("returns the only story when single element", () => {
    const story: VerificationPlanStorySummary = {
      id: "only",
      kind: "flow-verification",
      route: "/settings",
      promptExcerpt: "test",
      createdAt: T0,
      updatedAt: T0,
    };
    expect(selectPrimaryStory([story])?.id).toBe("only");
  });

  test("prefers the most recently updated story", () => {
    const result = selectPrimaryStory([
      {
        id: "older",
        kind: "flow-verification",
        route: "/older",
        promptExcerpt: "older",
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
      {
        id: "newer",
        kind: "flow-verification",
        route: "/settings",
        promptExcerpt: "newer",
        createdAt: "2026-03-27T00:01:00.000Z",
        updatedAt: "2026-03-27T00:02:00.000Z",
      },
    ]);

    expect(result?.id).toBe("newer");
  });

  test("breaks updatedAt ties with createdAt", () => {
    const result = selectPrimaryStory([
      {
        id: "created-first",
        kind: "flow-verification",
        route: "/a",
        promptExcerpt: "a",
        createdAt: "2026-03-27T00:00:00.000Z",
        updatedAt: "2026-03-27T01:00:00.000Z",
      },
      {
        id: "created-later",
        kind: "flow-verification",
        route: "/b",
        promptExcerpt: "b",
        createdAt: "2026-03-27T00:30:00.000Z",
        updatedAt: "2026-03-27T01:00:00.000Z",
      },
    ]);

    expect(result?.id).toBe("created-later");
  });

  test("breaks full tie with id (lexicographic ascending)", () => {
    const result = selectPrimaryStory([
      {
        id: "beta",
        kind: "flow-verification",
        route: null,
        promptExcerpt: "beta",
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "alpha",
        kind: "flow-verification",
        route: null,
        promptExcerpt: "alpha",
        createdAt: T0,
        updatedAt: T0,
      },
    ]);

    expect(result?.id).toBe("alpha");
  });

  test("planToResult includes createdAt and updatedAt in stories", () => {
    const plan = derivePlan(
      [makeObs("a", "clientRequest")],
      [{
        id: storyId("flow-verification", "/settings"),
        kind: "flow-verification",
        route: "/settings",
        promptExcerpt: "test",
        createdAt: T0,
        updatedAt: T1,
        requestedSkills: [],
      }],
    );
    const result = planToResult(plan);
    expect(result.stories[0].createdAt).toBe(T0);
    expect(result.stories[0].updatedAt).toBe(T1);
  });
});

// ---------------------------------------------------------------------------
// Story-scoped contamination regression tests
// ---------------------------------------------------------------------------

describe("story-scoped contamination prevention", () => {
  test("primaryNextAction is scoped to the active story, not session-global evidence", () => {
    // Record a /settings story and satisfy clientRequest for it
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("obs-settings-client", "clientRequest", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
      timestamp: "2026-03-27T22:00:00.000Z",
      summary: "curl http://localhost:3000/settings",
    }));

    // Record a newer /dashboard story (no observations yet)
    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    const result = computePlan(testSessionId);

    // Active story should be /dashboard (more missing boundaries → selectActiveStoryId)
    expect(result.activeStoryId).toBe(storyId("flow-verification", "/dashboard"));

    // The /settings clientRequest observation must NOT bleed into /dashboard's projection
    expect(result.primaryNextAction).not.toBeNull();
    expect(result.primaryNextAction!.targetBoundary).toBe("clientRequest");
    expect(result.primaryNextAction!.action).toContain("/dashboard");

    // Verify per-story state isolation
    const settingsState = result.storyStates.find((s) => s.route === "/settings");
    const dashboardState = result.storyStates.find((s) => s.route === "/dashboard");

    expect(settingsState).toBeDefined();
    expect(settingsState!.satisfiedBoundaries).toContain("clientRequest");
    expect(settingsState!.observationIds).toContain("obs-settings-client");

    expect(dashboardState).toBeDefined();
    expect(dashboardState!.satisfiedBoundaries).toHaveLength(0);
    expect(dashboardState!.observationIds).toHaveLength(0);
  });

  test("route-scoped policy recall uses the active story boundary, not a stale story", () => {
    // Record a /settings story and satisfy serverHandler for it
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", ["verification"]);
    recordObservation(testSessionId, makeObs("obs-settings-server", "serverHandler", {
      route: "/settings",
      storyId: storyId("flow-verification", "/settings"),
      timestamp: "2026-03-27T22:00:00.000Z",
      summary: "vercel logs",
    }));

    // Record a newer /dashboard story (no observations yet)
    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", ["verification"]);

    const result = computePlan(testSessionId);

    // Active story is /dashboard — should have all 4 boundaries missing
    expect(result.activeStoryId).toBe(storyId("flow-verification", "/dashboard"));
    expect(result.missingBoundaries).toHaveLength(4);
    expect(result.primaryNextAction!.targetBoundary).toBe("clientRequest");

    // /settings should show serverHandler satisfied, not bleeding
    const settingsState = result.storyStates.find((s) => s.route === "/settings");
    expect(settingsState!.satisfiedBoundaries).toContain("serverHandler");
    expect(settingsState!.missingBoundaries).not.toContain("serverHandler");
  });

  test("observation with explicit storyId does not attach to route-matched story", () => {
    // Two stories with different routes
    recordStory(testSessionId, "flow-verification", "/settings", "settings broken", []);
    recordStory(testSessionId, "flow-verification", "/dashboard", "dashboard broken", []);

    // Observation explicitly tagged for /settings story even though route says /dashboard
    recordObservation(testSessionId, makeObs("obs-explicit", "clientRequest", {
      route: "/dashboard",
      storyId: storyId("flow-verification", "/settings"),
      summary: "curl http://localhost:3000/dashboard",
    }));

    const result = computePlan(testSessionId);

    // The observation should be attributed to /settings (explicit storyId wins)
    const settingsState = result.storyStates.find((s) => s.route === "/settings");
    const dashboardState = result.storyStates.find((s) => s.route === "/dashboard");

    expect(settingsState!.observationIds).toContain("obs-explicit");
    expect(settingsState!.satisfiedBoundaries).toContain("clientRequest");

    expect(dashboardState!.observationIds).toHaveLength(0);
    expect(dashboardState!.satisfiedBoundaries).toHaveLength(0);
  });

  test("buildLedgerObservation persists storyId from env", async () => {
    const { buildBoundaryEvent, buildLedgerObservation } = await import("../hooks/src/posttooluse-verification-observe.mts");

    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "v-story-env-1",
      timestamp: "2026-03-27T23:00:00.000Z",
      env: {} as NodeJS.ProcessEnv,
    });

    const observation = buildLedgerObservation(event, {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "story-settings",
    } as NodeJS.ProcessEnv);

    expect(observation.storyId).toBe("story-settings");
    expect(observation.route).toBe("/settings");
    expect(observation.boundary).toBe("clientRequest");
  });

  test("buildLedgerObservation storyId is null when env is absent", async () => {
    const { buildBoundaryEvent, buildLedgerObservation } = await import("../hooks/src/posttooluse-verification-observe.mts");

    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "v-story-env-2",
      timestamp: "2026-03-27T23:00:00.000Z",
      env: {} as NodeJS.ProcessEnv,
    });

    const observation = buildLedgerObservation(event, {} as NodeJS.ProcessEnv);
    expect(observation.storyId).toBeNull();
  });
});
