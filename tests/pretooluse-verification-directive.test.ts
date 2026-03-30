import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildVerificationDirective,
  buildVerificationEnv,
  resolveVerificationRuntimeState,
  type VerificationDirective,
} from "../hooks/src/verification-directive.mts";
import {
  statePath as verificationStatePath,
} from "../hooks/src/verification-ledger.mts";
import type {
  VerificationPlanResult,
  VerificationPlanStorySummary,
} from "../hooks/src/verification-plan.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-27T06:00:00.000Z";
const T1 = "2026-03-27T06:01:00.000Z";
const T2 = "2026-03-27T06:02:00.000Z";
const T3 = "2026-03-27T06:03:00.000Z";

function makeStory(overrides: Partial<VerificationPlanStorySummary> = {}): VerificationPlanStorySummary {
  return {
    id: "story-1",
    kind: "flow-verification",
    route: "/settings",
    promptExcerpt: "verify settings flow",
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function makePlan(overrides: Partial<VerificationPlanResult> = {}): VerificationPlanResult {
  return {
    hasStories: true,
    stories: [makeStory()],
    observationCount: 1,
    satisfiedBoundaries: ["serverHandler"],
    missingBoundaries: ["clientRequest", "uiRender", "environment"],
    recentRoutes: ["/settings"],
    primaryNextAction: {
      targetBoundary: "clientRequest",
      action: "curl http://localhost:3000/settings",
      reason: "No HTTP request observation yet",
    },
    blockedReasons: [],
    ...overrides,
  };
}

function sessionId(): string {
  return `directive-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeMockPlanState(sid: string, plan: VerificationPlanResult): void {
  const sp = verificationStatePath(sid);
  mkdirSync(join(sp, ".."), { recursive: true });
  writeFileSync(sp, JSON.stringify({
    version: 1,
    stories: plan.stories,
    observationIds: [],
    satisfiedBoundaries: plan.satisfiedBoundaries,
    missingBoundaries: plan.missingBoundaries,
    recentRoutes: plan.recentRoutes,
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: plan.blockedReasons,
  }));
}

function cleanupPlanState(sid: string): void {
  const sp = verificationStatePath(sid);
  try { rmSync(join(sp, ".."), { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Unit: buildVerificationDirective
// ---------------------------------------------------------------------------

describe("buildVerificationDirective", () => {
  test("returns null for null plan", () => {
    expect(buildVerificationDirective(null)).toBeNull();
  });

  test("returns null for plan with no stories", () => {
    expect(buildVerificationDirective(makePlan({ hasStories: false, stories: [] }))).toBeNull();
  });

  test("returns null for plan with hasStories true but empty array", () => {
    expect(buildVerificationDirective(makePlan({ stories: [] }))).toBeNull();
  });

  test("builds directive from plan with route and primaryNextAction", () => {
    const directive = buildVerificationDirective(makePlan());
    expect(directive).not.toBeNull();
    expect(directive!.version).toBe(1);
    expect(directive!.storyId).toBe("story-1");
    expect(directive!.storyKind).toBe("flow-verification");
    expect(directive!.route).toBe("/settings");
    expect(directive!.missingBoundaries).toEqual(["clientRequest", "uiRender", "environment"]);
    expect(directive!.satisfiedBoundaries).toEqual(["serverHandler"]);
    expect(directive!.primaryNextAction).toEqual({
      targetBoundary: "clientRequest",
      action: "curl http://localhost:3000/settings",
      reason: "No HTTP request observation yet",
    });
    expect(directive!.blockedReasons).toEqual([]);
  });

  test("selects most recently updated story when multiple exist", () => {
    const plan = makePlan({
      stories: [
        makeStory({ id: "old", updatedAt: T0 }),
        makeStory({ id: "newer", updatedAt: T3, route: "/dashboard" }),
      ],
    });
    const directive = buildVerificationDirective(plan);
    expect(directive!.storyId).toBe("newer");
    expect(directive!.route).toBe("/dashboard");
  });

  test("directive with null route preserves null", () => {
    const plan = makePlan({ stories: [makeStory({ route: null })] });
    const directive = buildVerificationDirective(plan);
    expect(directive!.route).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: buildVerificationEnv
// ---------------------------------------------------------------------------

describe("buildVerificationEnv", () => {
  const CLEARING_KEYS = [
    "VERCEL_PLUGIN_VERIFICATION_STORY_ID",
    "VERCEL_PLUGIN_VERIFICATION_ROUTE",
    "VERCEL_PLUGIN_VERIFICATION_BOUNDARY",
    "VERCEL_PLUGIN_VERIFICATION_ACTION",
  ];

  test("returns clearing values (empty strings) for null directive", () => {
    const env = buildVerificationEnv(null);
    for (const key of CLEARING_KEYS) {
      expect(env[key]).toBe("");
    }
  });

  test("returns clearing values when directive has no primaryNextAction", () => {
    const directive: VerificationDirective = {
      version: 1,
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/settings",
      missingBoundaries: [],
      satisfiedBoundaries: ["clientRequest"],
      primaryNextAction: null,
      blockedReasons: [],
    };
    const env = buildVerificationEnv(directive);
    for (const key of CLEARING_KEYS) {
      expect(env[key]).toBe("");
    }
  });

  test("exports all four directive env keys for active directive", () => {
    const directive = buildVerificationDirective(makePlan())!;
    const env = buildVerificationEnv(directive);
    expect(env.VERCEL_PLUGIN_VERIFICATION_STORY_ID).toBe("story-1");
    expect(env.VERCEL_PLUGIN_VERIFICATION_ROUTE).toBe("/settings");
    expect(env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY).toBe("clientRequest");
    expect(env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("curl http://localhost:3000/settings");
  });

  test("exports empty string for null route in active directive", () => {
    const plan = makePlan({ stories: [makeStory({ route: null })] });
    const directive = buildVerificationDirective(plan)!;
    const env = buildVerificationEnv(directive);
    expect(env.VERCEL_PLUGIN_VERIFICATION_ROUTE).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Integration: resolveVerificationRuntimeState
// ---------------------------------------------------------------------------

describe("resolveVerificationRuntimeState", () => {
  let sid: string;

  beforeEach(() => {
    sid = sessionId();
  });

  afterEach(() => {
    cleanupPlanState(sid);
  });

  test("returns clearing env and nulls for null sessionId", () => {
    const state = resolveVerificationRuntimeState(null);
    expect(state.plan).toBeNull();
    expect(state.directive).toBeNull();
    expect(state.banner).toBeNull();
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID).toBe("");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ROUTE).toBe("");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY).toBe("");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("");
  });

  test("returns clearing env when session has no stories", () => {
    const state = resolveVerificationRuntimeState(sid);
    expect(state.plan).toBeNull();
    expect(state.directive).toBeNull();
    expect(state.banner).toBeNull();
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("");
  });

  test("exports banner and directive env for routed story", () => {
    writeMockPlanState(sid, makePlan());

    const state = resolveVerificationRuntimeState(sid);
    expect(state.plan).not.toBeNull();
    expect(state.directive).not.toBeNull();
    expect(state.directive!.storyId).toBe("story-1");
    expect(state.directive!.route).toBe("/settings");

    // Banner contains verification plan marker
    expect(state.banner).not.toBeNull();
    expect(state.banner).toContain("Verification Plan");

    // Env exports all four keys
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID).toBe("story-1");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ROUTE).toBe("/settings");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY).toBe("clientRequest");
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("curl http://localhost:3000/settings");
  });

  test("is idempotent — same session returns identical state", () => {
    writeMockPlanState(sid, makePlan());

    const first = resolveVerificationRuntimeState(sid);
    const second = resolveVerificationRuntimeState(sid);

    expect(first.env).toEqual(second.env);
    expect(first.directive).toEqual(second.directive);
    expect(first.banner).toEqual(second.banner);
  });

  test("banner is null when all boundaries are satisfied", () => {
    const plan = makePlan({
      missingBoundaries: [],
      satisfiedBoundaries: ["clientRequest", "serverHandler", "uiRender", "environment"],
      primaryNextAction: null,
    });
    writeMockPlanState(sid, plan);

    const state = resolveVerificationRuntimeState(sid);
    // Directive exists but has no action, so env is clearing
    expect(state.env.VERCEL_PLUGIN_VERIFICATION_ACTION).toBe("");
  });

  test("survives errors gracefully and returns clearing state", () => {
    // Pass a session ID that has a corrupt state file
    const corruptSid = sessionId();
    const sp = verificationStatePath(corruptSid);
    mkdirSync(join(sp, ".."), { recursive: true });
    writeFileSync(sp, "{{not json}}");

    try {
      const state = resolveVerificationRuntimeState(corruptSid);
      expect(state.plan).toBeNull();
      expect(state.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID).toBe("");
    } finally {
      cleanupPlanState(corruptSid);
    }
  });
});
