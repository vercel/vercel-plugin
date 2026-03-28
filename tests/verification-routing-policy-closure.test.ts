import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, rmSync } from "node:fs";
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
import {
  readRoutingDecisionTrace,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";

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

      // Simulate: observer sees a uiRender boundary match (scoped to story + route)
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
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
        storyId: "story-1",
        route: "/dashboard",
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

      // Resolve only uiRender (scoped to story + route)
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
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
        storyId: "story-1",
        route: "/dashboard",
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

      // Resolve 4 uiRender wins (scoped to story + route)
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
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

  describe("story/route-scoped resolution in closure", () => {
    test("verification for /settings does not resolve /dashboard exposures", () => {
      appendSkillExposure(exposure("settings-1", {
        storyId: "story-1",
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));
      appendSkillExposure(exposure("dashboard-1", {
        storyId: "story-1",
        route: "/dashboard",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("settings-1");
      expect(resolved[0].outcome).toBe("directive-win");

      // /dashboard exposure remains pending
      const all = loadSessionExposures(SESSION_ID);
      expect(all.find((e) => e.id === "dashboard-1")!.outcome).toBe("pending");

      // Finalize: /dashboard becomes stale-miss
      const stale = finalizeStaleExposures(SESSION_ID, T_END);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("dashboard-1");
      expect(stale[0].outcome).toBe("stale-miss");
    });

    test("cross-story observation does not over-credit unrelated exposures", () => {
      appendSkillExposure(exposure("s1-e1", {
        storyId: "story-1",
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));
      appendSkillExposure(exposure("s2-e1", {
        storyId: "story-2",
        route: "/dashboard",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      // Observation scoped to story-1 + /settings
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("s1-e1");

      // story-2's exposure is unaffected
      const all = loadSessionExposures(SESSION_ID);
      expect(all.find((e) => e.id === "s2-e1")!.outcome).toBe("pending");
    });
  });

  describe("mixed boundaries", () => {
    test("resolves only matching boundary exposures", () => {
      appendSkillExposure(exposure("ui-1", { targetBoundary: "uiRender", createdAt: T0 }));
      appendSkillExposure(exposure("cr-1", { targetBoundary: "clientRequest", createdAt: T1 }));
      appendSkillExposure(exposure("sh-1", { targetBoundary: "serverHandler", createdAt: T2 }));

      // Resolve only clientRequest (scoped to story + route)
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/dashboard",
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
        storyId: "story-1",
        route: "/dashboard",
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

  describe("null-route attribution in closure", () => {
    test("null inferred route does not over-credit route-specific exposures", () => {
      // Exposure scoped to /dashboard
      appendSkillExposure(exposure("scoped-e1", {
        storyId: "story-1",
        route: "/dashboard",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      // Resolution with null route (e.g., no route inferrable from command)
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: null,
        now: T3,
      });

      // Should NOT resolve: exposure has route="/dashboard", observed route is null
      expect(resolved).toHaveLength(0);

      const all = loadSessionExposures(SESSION_ID);
      expect(all[0].outcome).toBe("pending");
    });

    test("null-route exposures ARE resolved by null-route observations", () => {
      // Exposure with null route (e.g., from UserPromptSubmit)
      appendSkillExposure(exposure("null-route-e1", {
        storyId: null,
        route: null,
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        storyId: null,
        route: null,
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].outcome).toBe("directive-win");
    });
  });

  describe("route-scoped policy bucket persistence", () => {
    test("one exact-route exposure/outcome cycle writes exact-route, wildcard, and legacy buckets", () => {
      appendSkillExposure(exposure("route-bucket-e1", {
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T1,
      });

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);

      // Exact-route bucket
      const exactKey = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
      const exactStats = policy.scenarios[exactKey]?.["agent-browser-verify"];
      expect(exactStats).toBeDefined();
      expect(exactStats!.exposures).toBe(1);
      expect(exactStats!.wins).toBe(1);

      // Wildcard-route bucket
      const wildcardKey = "PreToolUse|flow-verification|clientRequest|Bash|*";
      const wildcardStats = policy.scenarios[wildcardKey]?.["agent-browser-verify"];
      expect(wildcardStats).toBeDefined();
      expect(wildcardStats!.exposures).toBe(1);
      expect(wildcardStats!.wins).toBe(1);

      // Legacy 4-part bucket
      const legacyKey = "PreToolUse|flow-verification|clientRequest|Bash";
      const legacyStats = policy.scenarios[legacyKey]?.["agent-browser-verify"];
      expect(legacyStats).toBeDefined();
      expect(legacyStats!.exposures).toBe(1);
      expect(legacyStats!.wins).toBe(1);
    });

    test("/settings outcomes do not over-credit /dashboard exposures in policy", () => {
      // Expose on /dashboard
      appendSkillExposure(exposure("dash-policy-e1", {
        route: "/dashboard",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      // Expose on /settings
      appendSkillExposure(exposure("settings-policy-e1", {
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      // Resolve only /settings as a win
      resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/settings",
        now: T2,
      });

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);

      // /settings exact-route bucket has the win
      const settingsKey = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
      const settingsStats = policy.scenarios[settingsKey]?.["agent-browser-verify"];
      expect(settingsStats!.wins).toBe(1);
      expect(settingsStats!.directiveWins).toBe(1);

      // /dashboard exact-route bucket has only the exposure, no win
      const dashKey = "PreToolUse|flow-verification|clientRequest|Bash|/dashboard";
      const dashStats = policy.scenarios[dashKey]?.["agent-browser-verify"];
      expect(dashStats).toBeDefined();
      expect(dashStats!.exposures).toBe(1);
      expect(dashStats!.wins).toBe(0);
      expect(dashStats!.directiveWins).toBe(0);

      // Wildcard and legacy buckets see both exposures but only the /settings win
      const wildcardKey = "PreToolUse|flow-verification|clientRequest|Bash|*";
      const wildcardStats = policy.scenarios[wildcardKey]?.["agent-browser-verify"];
      expect(wildcardStats!.exposures).toBe(2);
      expect(wildcardStats!.wins).toBe(1);

      const legacyKey = "PreToolUse|flow-verification|clientRequest|Bash";
      const legacyStats = policy.scenarios[legacyKey]?.["agent-browser-verify"];
      expect(legacyStats!.exposures).toBe(2);
      expect(legacyStats!.wins).toBe(1);
    });

    test("stale-miss finalization writes route-scoped policy for each exposure route", () => {
      appendSkillExposure(exposure("stale-dash-e1", {
        route: "/dashboard",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));
      appendSkillExposure(exposure("stale-settings-e1", {
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      finalizeStaleExposures(SESSION_ID, T_END);

      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);

      // Each route's exact bucket gets its own stale-miss
      const dashKey = "PreToolUse|flow-verification|clientRequest|Bash|/dashboard";
      expect(policy.scenarios[dashKey]?.["agent-browser-verify"]?.staleMisses).toBe(1);

      const settingsKey = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
      expect(policy.scenarios[settingsKey]?.["agent-browser-verify"]?.staleMisses).toBe(1);

      // Wildcard accumulates both
      const wildcardKey = "PreToolUse|flow-verification|clientRequest|Bash|*";
      expect(policy.scenarios[wildcardKey]?.["agent-browser-verify"]?.staleMisses).toBe(2);
    });
  });

  describe("PostToolUse closure traces", () => {
    const TRACE_SESSION = "closure-trace-test-" + Date.now();

    afterEach(() => {
      try { rmSync(traceDir(TRACE_SESSION), { recursive: true, force: true }); } catch {}
    });

    test("boundary observation with session writes PostToolUse routing decision trace", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(TRACE_SESSION, "flow-verification", "/settings", "test trace", []);

        const input = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/settings" },
          session_id: TRACE_SESSION,
        });

        run(input);

        const traces = readRoutingDecisionTrace(TRACE_SESSION);
        expect(traces.length).toBeGreaterThanOrEqual(1);

        const postTrace = traces.find((t) => t.hook === "PostToolUse");
        expect(postTrace).toBeDefined();
        expect(postTrace!.version).toBe(2);
        expect(postTrace!.hook).toBe("PostToolUse");
        expect(postTrace!.toolName).toBe("Bash");
        expect(postTrace!.verification).not.toBeNull();
        expect(postTrace!.verification!.verificationId).toBeTruthy();
        expect(postTrace!.verification!.observedBoundary).toBe("clientRequest");
        expect(typeof postTrace!.verification!.matchedSuggestedAction).toBe("boolean");

        // PostToolUse traces never fabricate ranking data
        expect(postTrace!.matchedSkills).toEqual([]);
        expect(postTrace!.injectedSkills).toEqual([]);
        expect(postTrace!.ranked).toEqual([]);
      } finally {
        removeLedgerArtifacts(TRACE_SESSION);
      }
    });

    test("closure trace and routing-policy-resolved share correlation data", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(TRACE_SESSION, "flow-verification", "/dashboard", "correlation test", []);

        // Add an exposure so routing-policy-resolved fires
        appendSkillExposure(exposure("corr-1", {
          sessionId: TRACE_SESSION,
          targetBoundary: "uiRender",
          route: "/dashboard",
          createdAt: T0,
        }));

        const input = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "open http://localhost:3000/dashboard" },
          session_id: TRACE_SESSION,
        });

        run(input);

        const traces = readRoutingDecisionTrace(TRACE_SESSION);
        const postTrace = traces.find((t) => t.hook === "PostToolUse");
        expect(postTrace).toBeDefined();

        // Trace carries the same story identity as policy resolution
        expect(postTrace!.primaryStory.kind).toBe("flow-verification");
        expect(postTrace!.primaryStory.storyRoute).not.toBeNull();
        expect(postTrace!.verification!.verificationId).toBeTruthy();
        expect(postTrace!.verification!.observedBoundary).toBe("uiRender");

        // policyScenario should be set when primary story exists
        expect(postTrace!.policyScenario).toMatch(/^PostToolUse\|flow-verification\|/);
      } finally {
        removeLedgerArtifacts(TRACE_SESSION);
      }
    });

    test("trace without active story includes no_active_verification_story skip reason", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

      // Use a session with no stories recorded
      const noStorySession = "no-story-trace-" + Date.now();
      try {
        const input = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/api/test" },
          session_id: noStorySession,
        });

        run(input);

        const traces = readRoutingDecisionTrace(noStorySession);
        const postTrace = traces.find((t) => t.hook === "PostToolUse");
        expect(postTrace).toBeDefined();
        expect(postTrace!.skippedReasons).toContain("no_active_verification_story");
        expect(postTrace!.policyScenario).toBeNull();
        expect(postTrace!.primaryStory.id).toBeNull();
      } finally {
        removeLedgerArtifacts(noStorySession);
        try { rmSync(traceDir(noStorySession), { recursive: true, force: true }); } catch {}
      }
    });
  });
});
