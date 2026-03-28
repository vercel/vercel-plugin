import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, rmSync } from "node:fs";
import {
  resolveObservedRoute,
  envString,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  projectPolicyPath,
  sessionExposurePath,
  appendSkillExposure,
  loadSessionExposures,
  loadProjectRoutingPolicy,
  resolveBoundaryOutcome,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  readRoutingDecisionTrace,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/tmp/test-project-route-fallback";
const SESSION_ID = "route-fallback-test-" + Date.now();
const T0 = "2026-03-27T05:00:00.000Z";
const T1 = "2026-03-27T05:01:00.000Z";

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
// Unit: resolveObservedRoute
// ---------------------------------------------------------------------------

describe("resolveObservedRoute", () => {
  test("returns inferred route when present", () => {
    expect(resolveObservedRoute("/api/data", {})).toBe("/api/data");
  });

  test("falls back to VERCEL_PLUGIN_VERIFICATION_ROUTE when inferred is null", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings" } as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBe("/settings");
  });

  test("trims whitespace from directive env value", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "  /settings  " } as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBe("/settings");
  });

  test("returns null when both inferred and env are absent", () => {
    expect(resolveObservedRoute(null, {})).toBeNull();
  });

  test("returns null when env value is empty string", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "" } as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBeNull();
  });

  test("returns null when env value is whitespace-only", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "   " } as NodeJS.ProcessEnv;
    expect(resolveObservedRoute(null, env)).toBeNull();
  });

  test("prefers inferred route over directive env", () => {
    const env = { VERCEL_PLUGIN_VERIFICATION_ROUTE: "/dashboard" } as NodeJS.ProcessEnv;
    expect(resolveObservedRoute("/api/data", env)).toBe("/api/data");
  });
});

// ---------------------------------------------------------------------------
// Unit: envString
// ---------------------------------------------------------------------------

describe("envString", () => {
  test("returns trimmed value for non-empty env var", () => {
    expect(envString({ FOO: "  bar  " } as NodeJS.ProcessEnv, "FOO")).toBe("bar");
  });

  test("returns null for missing key", () => {
    expect(envString({} as NodeJS.ProcessEnv, "MISSING")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(envString({ X: "" } as NodeJS.ProcessEnv, "X")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(envString({ X: "   " } as NodeJS.ProcessEnv, "X")).toBeNull();
  });

  test("returns null for tab-only string", () => {
    expect(envString({ X: "\t\t" } as NodeJS.ProcessEnv, "X")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: directive env enables route-scoped closure
// ---------------------------------------------------------------------------

describe("directive route fallback closes route-scoped exposures", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("pending exposure resolves when command inference is null but directive env matches", () => {
    appendSkillExposure(exposure("e1", {
      storyId: "story-settings",
      route: "/settings",
      targetBoundary: "clientRequest",
      createdAt: T0,
    }));

    // Simulate what run() does: inferRoute returns null, but directive env has the route
    const directiveRoute = resolveObservedRoute(null, {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings",
    } as NodeJS.ProcessEnv);

    const directiveStoryId = envString(
      { VERCEL_PLUGIN_VERIFICATION_STORY_ID: "story-settings" } as NodeJS.ProcessEnv,
      "VERCEL_PLUGIN_VERIFICATION_STORY_ID",
    );

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: true,
      storyId: directiveStoryId,
      route: directiveRoute,
      now: T1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe("directive-win");
    expect(resolved[0].id).toBe("e1");

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
    expect(stats).toBeDefined();
    expect(stats!.directiveWins).toBe(1);
    expect(stats!.wins).toBe(1);
  });

  test("win (not directive-win) when action does not match suggestion", () => {
    appendSkillExposure(exposure("e2", {
      storyId: "story-settings",
      route: "/settings",
      targetBoundary: "clientRequest",
      createdAt: T0,
    }));

    const directiveRoute = resolveObservedRoute(null, {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings",
    } as NodeJS.ProcessEnv);

    const resolved = resolveBoundaryOutcome({
      sessionId: SESSION_ID,
      boundary: "clientRequest",
      matchedSuggestedAction: false,
      storyId: "story-settings",
      route: directiveRoute,
      now: T1,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe("win");

    const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
    const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
    expect(stats!.directiveWins).toBe(0);
    expect(stats!.wins).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: run() with directive env (end-to-end through observer)
// ---------------------------------------------------------------------------

describe("run() with directive env fallback", () => {
  const RUN_SESSION = "run-directive-" + Date.now();

  afterEach(() => {
    try { unlinkSync(sessionExposurePath(RUN_SESSION)); } catch {}
    try { rmSync(traceDir(RUN_SESSION), { recursive: true, force: true }); } catch {}
  });

  test("run() uses directive route when command has no route hint", async () => {
    const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
    const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

    const saved = {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE,
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID,
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY,
      VERCEL_PLUGIN_VERIFICATION_ACTION: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION,
    };

    try {
      recordStory(RUN_SESSION, "flow-verification", "/settings", "directive fallback", []);

      // Set directive env
      process.env.VERCEL_PLUGIN_VERIFICATION_ROUTE = "/settings";
      process.env.VERCEL_PLUGIN_VERIFICATION_STORY_ID = "";
      process.env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY = "clientRequest";
      process.env.VERCEL_PLUGIN_VERIFICATION_ACTION = "curl $LOCAL_URL";

      // Add exposure to close
      appendSkillExposure({
        id: "run-e1",
        sessionId: RUN_SESSION,
        projectRoot: PROJECT_ROOT,
        storyId: "flow-verification",
        storyKind: "flow-verification",
        route: "/settings",
        hook: "PreToolUse",
        toolName: "Bash",
        skill: "agent-browser-verify",
        targetBoundary: "clientRequest",
        createdAt: T0,
        resolvedAt: null,
        outcome: "pending",
      });

      // Command that does NOT contain a route URL — forces directive fallback
      const input = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl $LOCAL_URL" },
        session_id: RUN_SESSION,
      });

      run(input);

      // Verify trace has the directive-derived route
      const traces = readRoutingDecisionTrace(RUN_SESSION);
      const postTrace = traces.find((t) => t.hook === "PostToolUse");
      expect(postTrace).toBeDefined();
      expect(postTrace!.observedRoute).toBe("/settings");
    } finally {
      // Restore env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      removeLedgerArtifacts(RUN_SESSION);
    }
  });
});
