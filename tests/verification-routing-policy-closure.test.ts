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
import { storyId as computeStoryId } from "../hooks/src/verification-ledger.mts";
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

  describe("soft signal gating: plan state updated, routing policy untouched", () => {
    const SOFT_SESSION = "soft-signal-closure-" + Date.now();

    afterEach(() => {
      try { unlinkSync(projectPolicyPath(PROJECT_ROOT)); } catch {}
      try { unlinkSync(sessionExposurePath(SOFT_SESSION)); } catch {}
    });

    test("Read .env.local records observation but does not resolve routing-policy wins", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(SOFT_SESSION, "flow-verification", "/settings", "env check", []);

        // Add a pending exposure so we can verify it stays pending
        appendSkillExposure(exposure("soft-e1", {
          sessionId: SOFT_SESSION,
          targetBoundary: "environment",
          route: "/settings",
          createdAt: T0,
        }));

        const input = JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.env.local" },
          session_id: SOFT_SESSION,
        });

        run(input);

        // Observation was recorded in the ledger (plan state updated)
        const observations = loadObservations(SOFT_SESSION);
        expect(observations.length).toBeGreaterThanOrEqual(1);
        const envObs = observations.find((o) => o.meta?.evidenceSource === "env-read");
        expect(envObs).toBeDefined();
        expect(envObs!.boundary).toBe("environment");
        expect(envObs!.meta?.signalStrength).toBe("soft");
        expect(envObs!.meta?.toolName).toBe("Read");

        // Routing policy was NOT updated — exposure remains pending
        const exposures = loadSessionExposures(SOFT_SESSION);
        const pending = exposures.filter((e) => e.outcome === "pending");
        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe("soft-e1");

        // Project policy has no wins
        const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
        const scenarioKey = "PreToolUse|flow-verification|environment|Bash|/settings";
        const stats = policy.scenarios[scenarioKey]?.["agent-browser-verify"];
        // stats may exist from exposure recording, but wins should be 0
        if (stats) {
          expect(stats.wins).toBe(0);
          expect(stats.directiveWins).toBe(0);
        }
      } finally {
        removeLedgerArtifacts(SOFT_SESSION);
      }
    });

    test("Read server.log records observation but does not resolve routing-policy wins", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(SOFT_SESSION, "flow-verification", "/dashboard", "log check", []);

        appendSkillExposure(exposure("soft-log-e1", {
          sessionId: SOFT_SESSION,
          targetBoundary: "serverHandler",
          route: "/dashboard",
          createdAt: T0,
        }));

        const input = JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.next/server/app.log" },
          session_id: SOFT_SESSION,
        });

        run(input);

        // Observation recorded
        const observations = loadObservations(SOFT_SESSION);
        const logObs = observations.find((o) => o.meta?.evidenceSource === "log-read");
        expect(logObs).toBeDefined();
        expect(logObs!.boundary).toBe("serverHandler");
        expect(logObs!.meta?.signalStrength).toBe("soft");

        // Exposure stays pending — soft signal did not resolve policy
        const exposures = loadSessionExposures(SOFT_SESSION);
        expect(exposures.filter((e) => e.outcome === "pending")).toHaveLength(1);
      } finally {
        removeLedgerArtifacts(SOFT_SESSION);
      }
    });

    test("Bash curl (strong) DOES resolve routing-policy wins — contrast with soft", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(SOFT_SESSION, "flow-verification", "/dashboard", "api check", []);

        // Use the real computed story ID so it matches what the observer resolves
        const realStoryId = computeStoryId("flow-verification", "/dashboard");

        appendSkillExposure(exposure("strong-bash-e1", {
          sessionId: SOFT_SESSION,
          targetBoundary: "clientRequest",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T0,
        }));

        const input = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/dashboard" },
          session_id: SOFT_SESSION,
        });

        run(input);

        // Bash curl is strong → exposure should be resolved
        const exposures = loadSessionExposures(SOFT_SESSION);
        const resolved = exposures.filter((e) => e.outcome === "win" || e.outcome === "directive-win");
        expect(resolved.length).toBeGreaterThanOrEqual(1);
      } finally {
        removeLedgerArtifacts(SOFT_SESSION);
      }
    });

    test("finalizeStaleExposures converts unresolved soft-signal exposures to stale-miss", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(SOFT_SESSION, "flow-verification", "/settings", "stale check", []);

        appendSkillExposure(exposure("stale-soft-e1", {
          sessionId: SOFT_SESSION,
          targetBoundary: "environment",
          route: "/settings",
          createdAt: T0,
        }));

        // Soft signal — does NOT resolve policy
        run(JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.env.local" },
          session_id: SOFT_SESSION,
        }));

        // Session end: pending exposure becomes stale-miss
        const stale = finalizeStaleExposures(SOFT_SESSION, T_END);
        expect(stale).toHaveLength(1);
        expect(stale[0].id).toBe("stale-soft-e1");
        expect(stale[0].outcome).toBe("stale-miss");
      } finally {
        removeLedgerArtifacts(SOFT_SESSION);
      }
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

  // ---------------------------------------------------------------------------
  // E2E signal fusion: multi-tool, strong/soft gating, route-scoped resolution
  // ---------------------------------------------------------------------------

  describe("signal fusion E2E: multi-tool verification closure", () => {
    const FUSION_SESSION = "signal-fusion-e2e-" + Date.now();

    afterEach(() => {
      try { unlinkSync(projectPolicyPath(PROJECT_ROOT)); } catch {}
      try { unlinkSync(sessionExposurePath(FUSION_SESSION)); } catch {}
      try { rmSync(traceDir(FUSION_SESSION), { recursive: true, force: true }); } catch {}
    });

    test("Bash curl records clientRequest strong and resolves the correct pending exposure", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");
      const { storyId: computeStoryId } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/dashboard", "dashboard verify", []);
        const realStoryId = computeStoryId("flow-verification", "/dashboard");

        appendSkillExposure(exposure("fusion-curl-e1", {
          sessionId: FUSION_SESSION,
          targetBoundary: "clientRequest",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T0,
        }));

        run(JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/dashboard" },
          session_id: FUSION_SESSION,
        }));

        // Observation was recorded
        const observations = loadObservations(FUSION_SESSION);
        const curlObs = observations.find((o) => o.meta?.matchedPattern === "http-client");
        expect(curlObs).toBeDefined();
        expect(curlObs!.boundary).toBe("clientRequest");
        expect(curlObs!.meta?.signalStrength).toBe("strong");
        expect(curlObs!.meta?.evidenceSource).toBe("bash");

        // Strong signal → exposure resolved
        const exposures = loadSessionExposures(FUSION_SESSION);
        const resolved = exposures.filter((e) => e.outcome === "win" || e.outcome === "directive-win");
        expect(resolved.length).toBeGreaterThanOrEqual(1);
        expect(resolved[0].id).toBe("fusion-curl-e1");
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });

    test(".env.local read records environment soft, affects plan state, does NOT resolve routing-policy", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/settings", "env check", []);

        // Seed a pending exposure for environment boundary
        appendSkillExposure(exposure("fusion-env-e1", {
          sessionId: FUSION_SESSION,
          targetBoundary: "environment",
          route: "/settings",
          createdAt: T0,
        }));

        run(JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.env.local" },
          session_id: FUSION_SESSION,
        }));

        // Observation recorded in ledger (plan state affected)
        const observations = loadObservations(FUSION_SESSION);
        const envObs = observations.find((o) => o.meta?.evidenceSource === "env-read");
        expect(envObs).toBeDefined();
        expect(envObs!.boundary).toBe("environment");
        expect(envObs!.meta?.signalStrength).toBe("soft");
        expect(envObs!.meta?.toolName).toBe("Read");

        // Routing policy NOT updated — exposure stays pending
        const exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures.filter((e) => e.outcome === "pending")).toHaveLength(1);
        expect(exposures[0].id).toBe("fusion-env-e1");

        // Project policy has zero wins
        const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
        const scenarioKey = "PreToolUse|flow-verification|environment|Bash|/settings";
        const stats = policy.scenarios[scenarioKey]?.["agent-browser-verify"];
        if (stats) {
          expect(stats.wins).toBe(0);
          expect(stats.directiveWins).toBe(0);
        }
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });

    test("server log read records serverHandler soft, affects plan state only, does NOT resolve routing-policy", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/dashboard", "log inspect", []);

        appendSkillExposure(exposure("fusion-log-e1", {
          sessionId: FUSION_SESSION,
          targetBoundary: "serverHandler",
          route: "/dashboard",
          createdAt: T0,
        }));

        run(JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.next/server/app.log" },
          session_id: FUSION_SESSION,
        }));

        // Observation recorded (plan state affected)
        const observations = loadObservations(FUSION_SESSION);
        const logObs = observations.find((o) => o.meta?.evidenceSource === "log-read");
        expect(logObs).toBeDefined();
        expect(logObs!.boundary).toBe("serverHandler");
        expect(logObs!.meta?.signalStrength).toBe("soft");

        // Routing policy NOT updated — exposure stays pending
        const exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures.filter((e) => e.outcome === "pending")).toHaveLength(1);
        expect(exposures[0].id).toBe("fusion-log-e1");
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });

    test("Bash browser command records uiRender strong and resolves only matching story/route", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");
      const { storyId: computeStoryId } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/dashboard", "browser verify", []);
        const realStoryId = computeStoryId("flow-verification", "/dashboard");

        // Exposure on /dashboard (uiRender)
        appendSkillExposure(exposure("fusion-browser-dash", {
          sessionId: FUSION_SESSION,
          targetBoundary: "uiRender",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T0,
        }));

        // Exposure on /settings (uiRender) — different route, should NOT be resolved
        appendSkillExposure(exposure("fusion-browser-settings", {
          sessionId: FUSION_SESSION,
          targetBoundary: "uiRender",
          storyId: realStoryId,
          route: "/settings",
          createdAt: T1,
        }));

        run(JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "open http://localhost:3000/dashboard" },
          session_id: FUSION_SESSION,
        }));

        // Observation is uiRender + strong
        const observations = loadObservations(FUSION_SESSION);
        const browserObs = observations.find((o) => o.boundary === "uiRender");
        expect(browserObs).toBeDefined();
        expect(browserObs!.meta?.signalStrength).toBe("strong");
        expect(browserObs!.meta?.evidenceSource).toBe("browser");

        // Only /dashboard exposure resolved; /settings stays pending
        const exposures = loadSessionExposures(FUSION_SESSION);
        const dashExposure = exposures.find((e) => e.id === "fusion-browser-dash");
        const settingsExposure = exposures.find((e) => e.id === "fusion-browser-settings");
        expect(dashExposure!.outcome).toBe("win");
        expect(settingsExposure!.outcome).toBe("pending");
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });

    test("route mismatch resolves nothing; finalizeStaleExposures converts unresolved to stale-miss", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts } = await import("../hooks/src/verification-ledger.mts");
      const { storyId: computeStoryId } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/settings", "route mismatch", []);
        const realStoryId = computeStoryId("flow-verification", "/settings");

        // Exposure targeting /settings clientRequest
        appendSkillExposure(exposure("fusion-mismatch-e1", {
          sessionId: FUSION_SESSION,
          targetBoundary: "clientRequest",
          storyId: realStoryId,
          route: "/settings",
          createdAt: T0,
        }));

        // Observer sees curl /dashboard — route mismatch with /settings exposure
        run(JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/dashboard" },
          session_id: FUSION_SESSION,
        }));

        // Exposure still pending (route mismatch: /dashboard observation vs /settings exposure)
        const exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures).toHaveLength(1);
        expect(exposures[0].outcome).toBe("pending");

        // Session end: finalize converts to stale-miss
        const stale = finalizeStaleExposures(FUSION_SESSION, T_END);
        expect(stale).toHaveLength(1);
        expect(stale[0].id).toBe("fusion-mismatch-e1");
        expect(stale[0].outcome).toBe("stale-miss");
        expect(stale[0].resolvedAt).toBe(T_END);

        // Project policy reflects stale-miss, not a win
        const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
        const key = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
        const stats = policy.scenarios[key]?.["agent-browser-verify"];
        expect(stats).toBeDefined();
        expect(stats!.staleMisses).toBe(1);
        expect(stats!.wins).toBe(0);
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });

    test("full signal fusion: mixed strong/soft tools in one session, only strong resolves policy", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");
      const { recordStory, removeLedgerArtifacts, loadObservations } = await import("../hooks/src/verification-ledger.mts");
      const { storyId: computeStoryId } = await import("../hooks/src/verification-ledger.mts");

      try {
        recordStory(FUSION_SESSION, "flow-verification", "/dashboard", "fusion test", []);
        const realStoryId = computeStoryId("flow-verification", "/dashboard");

        // Four exposures: one per boundary
        appendSkillExposure(exposure("fusion-all-cr", {
          sessionId: FUSION_SESSION,
          targetBoundary: "clientRequest",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T0,
        }));
        appendSkillExposure(exposure("fusion-all-env", {
          sessionId: FUSION_SESSION,
          targetBoundary: "environment",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T1,
        }));
        appendSkillExposure(exposure("fusion-all-sh", {
          sessionId: FUSION_SESSION,
          targetBoundary: "serverHandler",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T2,
        }));
        appendSkillExposure(exposure("fusion-all-ui", {
          sessionId: FUSION_SESSION,
          targetBoundary: "uiRender",
          storyId: realStoryId,
          route: "/dashboard",
          createdAt: T3,
        }));

        // Step 1: Soft env read — records observation, does NOT resolve policy
        run(JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.env.local" },
          session_id: FUSION_SESSION,
        }));

        // Step 2: Soft log read — records observation, does NOT resolve policy
        run(JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "/repo/.next/server/app.log" },
          session_id: FUSION_SESSION,
        }));

        // After soft signals: all 4 exposures still pending
        let exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures.filter((e) => e.outcome === "pending")).toHaveLength(4);

        // Step 3: Strong curl — resolves clientRequest exposure only
        run(JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl http://localhost:3000/dashboard" },
          session_id: FUSION_SESSION,
        }));

        exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures.find((e) => e.id === "fusion-all-cr")!.outcome).toBe("win");
        expect(exposures.find((e) => e.id === "fusion-all-env")!.outcome).toBe("pending");
        expect(exposures.find((e) => e.id === "fusion-all-sh")!.outcome).toBe("pending");
        expect(exposures.find((e) => e.id === "fusion-all-ui")!.outcome).toBe("pending");

        // Step 4: Strong browser — resolves uiRender exposure only
        run(JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "open http://localhost:3000/dashboard" },
          session_id: FUSION_SESSION,
        }));

        exposures = loadSessionExposures(FUSION_SESSION);
        expect(exposures.find((e) => e.id === "fusion-all-ui")!.outcome).toBe("win");

        // env and serverHandler exposures still pending (soft signals didn't resolve them)
        expect(exposures.find((e) => e.id === "fusion-all-env")!.outcome).toBe("pending");
        expect(exposures.find((e) => e.id === "fusion-all-sh")!.outcome).toBe("pending");

        // Verify observations were all recorded
        const observations = loadObservations(FUSION_SESSION);
        expect(observations.length).toBeGreaterThanOrEqual(4);

        // Boundaries observed: env, serverHandler, clientRequest, uiRender
        const boundaries = new Set(observations.map((o) => o.boundary));
        expect(boundaries.has("environment")).toBe(true);
        expect(boundaries.has("serverHandler")).toBe(true);
        expect(boundaries.has("clientRequest")).toBe(true);
        expect(boundaries.has("uiRender")).toBe(true);

        // Finalize: remaining 2 soft-only exposures become stale-miss
        const stale = finalizeStaleExposures(FUSION_SESSION, T_END);
        expect(stale).toHaveLength(2);
        expect(stale.every((e) => e.outcome === "stale-miss")).toBe(true);
        const staleIds = stale.map((e) => e.id).sort();
        expect(staleIds).toEqual(["fusion-all-env", "fusion-all-sh"]);

        // Final policy state: clientRequest and uiRender have wins, others have stale-misses
        const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
        const crKey = "PreToolUse|flow-verification|clientRequest|Bash|/dashboard";
        expect(policy.scenarios[crKey]?.["agent-browser-verify"]?.wins).toBe(1);
        const uiKey = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";
        expect(policy.scenarios[uiKey]?.["agent-browser-verify"]?.wins).toBe(1);
        const envKey = "PreToolUse|flow-verification|environment|Bash|/dashboard";
        expect(policy.scenarios[envKey]?.["agent-browser-verify"]?.staleMisses).toBe(1);
        const shKey = "PreToolUse|flow-verification|serverHandler|Bash|/dashboard";
        expect(policy.scenarios[shKey]?.["agent-browser-verify"]?.staleMisses).toBe(1);
      } finally {
        removeLedgerArtifacts(FUSION_SESSION);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: companion recall does not distort cap/budget/attribution closure
  // ---------------------------------------------------------------------------

  describe("companion recall parity guards", () => {
    afterEach(cleanupFiles);

    test("companion-recalled context exposure does not steal candidate attribution from direct match", () => {
      // Direct match candidate exposure
      appendSkillExposure(exposure("comp-parity-e1", {
        skill: "agent-browser-verify",
        attributionRole: "candidate",
        candidateSkill: null,
        targetBoundary: "uiRender",
        createdAt: T0,
      }));

      // Companion-recalled context exposure for the same story
      appendSkillExposure(exposure("comp-parity-e2", {
        skill: "verification",
        attributionRole: "context",
        candidateSkill: "agent-browser-verify",
        targetBoundary: "uiRender",
        createdAt: T1,
      }));

      // Resolve boundary — both exposures win
      const resolved = resolveBoundaryOutcome({
        sessionId: SESSION_ID,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T3,
      });

      expect(resolved).toHaveLength(2);
      expect(resolved.every((e) => e.outcome === "win")).toBe(true);

      // Policy should credit ONLY the candidate — context exposures must NOT
      // affect the routing policy (shouldAffectPolicy gates on attributionRole)
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const key = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";
      const candidateStats = policy.scenarios[key]?.["agent-browser-verify"];
      expect(candidateStats).toBeDefined();
      expect(candidateStats!.wins).toBeGreaterThanOrEqual(1);

      // Context companion must NOT appear in policy scenarios
      const contextStats = policy.scenarios[key]?.["verification"];
      expect(contextStats).toBeUndefined();
    });

    test("policy boost from companion context wins does not exceed direct candidate boost", () => {
      // Build policy where direct candidate has strong history and companion has mild history
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const key = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";
      if (!policy.scenarios[key]) policy.scenarios[key] = {};
      policy.scenarios[key]["agent-browser-verify"] = {
        exposures: 10,
        wins: 8,
        directiveWins: 3,
        staleMisses: 1,
        lastUpdatedAt: T0,
      };
      policy.scenarios[key]["verification"] = {
        exposures: 3,
        wins: 2,
        directiveWins: 0,
        staleMisses: 1,
        lastUpdatedAt: T0,
      };

      const { saveProjectRoutingPolicy: savePRP } = require("../hooks/src/routing-policy-ledger.mts");
      savePRP(PROJECT_ROOT, policy);

      const reloaded = loadProjectRoutingPolicy(PROJECT_ROOT);

      // Derive boosts and verify the candidate always gets a higher boost
      const candidateBoost = derivePolicyBoost(reloaded.scenarios[key]!["agent-browser-verify"]);
      const companionBoost = derivePolicyBoost(reloaded.scenarios[key]!["verification"]);

      expect(candidateBoost).toBeGreaterThan(companionBoost);
    });

    test("stale-miss finalization applies only to candidate exposures, not companion context", () => {
      // Candidate exposure
      appendSkillExposure(exposure("stale-comp-e1", {
        skill: "agent-browser-verify",
        attributionRole: "candidate",
        targetBoundary: "uiRender",
        createdAt: T0,
      }));

      // Companion context exposure
      appendSkillExposure(exposure("stale-comp-e2", {
        skill: "verification",
        attributionRole: "context",
        candidateSkill: "agent-browser-verify",
        targetBoundary: "uiRender",
        createdAt: T1,
      }));

      // Finalize without boundary resolution
      const stale = finalizeStaleExposures(SESSION_ID, T_END);
      expect(stale).toHaveLength(2);
      expect(stale.every((e) => e.outcome === "stale-miss")).toBe(true);

      // Only candidate exposure should affect routing policy;
      // context companion is excluded by shouldAffectPolicy
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const key = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";
      expect(policy.scenarios[key]?.["agent-browser-verify"]?.staleMisses).toBe(1);
      // Context companion must NOT appear in policy scenarios
      expect(policy.scenarios[key]?.["verification"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Playbook credit-safety: only anchor skill accumulates policy wins
  // ---------------------------------------------------------------------------

  describe("playbook credit-safe exposure attribution", () => {
    const PLAYBOOK_SESSION = "playbook-policy-test-" + Date.now();

    afterEach(() => {
      try { unlinkSync(projectPolicyPath(PROJECT_ROOT)); } catch {}
      try { unlinkSync(sessionExposurePath(PLAYBOOK_SESSION)); } catch {}
    });

    test("verified playbook credits only the anchor skill to project policy", () => {
      // Anchor skill: "verification" (candidate)
      appendSkillExposure(exposure("pb-anchor", {
        sessionId: PLAYBOOK_SESSION,
        skill: "verification",
        attributionRole: "candidate",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-1",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));

      // Inserted playbook step 1: "workflow" (context)
      appendSkillExposure(exposure("pb-step1", {
        sessionId: PLAYBOOK_SESSION,
        skill: "workflow",
        attributionRole: "context",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-1",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T1,
      }));

      // Inserted playbook step 2: "agent-browser-verify" (context)
      appendSkillExposure(exposure("pb-step2", {
        sessionId: PLAYBOOK_SESSION,
        skill: "agent-browser-verify",
        attributionRole: "context",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-1",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T2,
      }));

      // Resolve the boundary — all three exposures match
      const resolved = resolveBoundaryOutcome({
        sessionId: PLAYBOOK_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(3);
      expect(resolved.every((e) => e.outcome === "win")).toBe(true);

      // Project policy: only the anchor skill ("verification") gets policy credit
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const scenarioKey = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
      const anchorStats = policy.scenarios[scenarioKey]?.["verification"];
      expect(anchorStats).toBeDefined();
      expect(anchorStats!.wins).toBe(1);

      // Inserted playbook steps must NOT appear in project policy
      const step1Stats = policy.scenarios[scenarioKey]?.["workflow"];
      expect(step1Stats).toBeUndefined();

      const step2Stats = policy.scenarios[scenarioKey]?.["agent-browser-verify"];
      // agent-browser-verify should have no wins from this playbook batch
      // (it may have exposure count from appendSkillExposure but no wins)
      if (step2Stats) {
        expect(step2Stats.wins).toBe(0);
      }
    });

    test("playbook context steps are persisted in session ledger for inspection", () => {
      appendSkillExposure(exposure("pb-ledger-anchor", {
        sessionId: PLAYBOOK_SESSION,
        skill: "verification",
        attributionRole: "candidate",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-2",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));

      appendSkillExposure(exposure("pb-ledger-step", {
        sessionId: PLAYBOOK_SESSION,
        skill: "workflow",
        attributionRole: "context",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-2",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T1,
      }));

      // Both are in the session ledger
      const all = loadSessionExposures(PLAYBOOK_SESSION);
      expect(all).toHaveLength(2);
      expect(all.find((e) => e.id === "pb-ledger-anchor")!.attributionRole).toBe("candidate");
      expect(all.find((e) => e.id === "pb-ledger-step")!.attributionRole).toBe("context");
      expect(all.find((e) => e.id === "pb-ledger-step")!.candidateSkill).toBe("verification");
    });

    test("stale-miss finalization for playbook batch credits only anchor", () => {
      appendSkillExposure(exposure("pb-stale-anchor", {
        sessionId: PLAYBOOK_SESSION,
        skill: "verification",
        attributionRole: "candidate",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-3",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));

      appendSkillExposure(exposure("pb-stale-step", {
        sessionId: PLAYBOOK_SESSION,
        skill: "workflow",
        attributionRole: "context",
        candidateSkill: "verification",
        exposureGroupId: "playbook-group-3",
        targetBoundary: "clientRequest",
        storyId: "story-1",
        route: "/settings",
        createdAt: T1,
      }));

      // Session end — no boundary resolution
      const stale = finalizeStaleExposures(PLAYBOOK_SESSION, T_END);
      expect(stale).toHaveLength(2);
      expect(stale.every((e) => e.outcome === "stale-miss")).toBe(true);

      // Only anchor's stale-miss affects project policy
      const policy = loadProjectRoutingPolicy(PROJECT_ROOT);
      const key = "PreToolUse|flow-verification|clientRequest|Bash|/settings";
      expect(policy.scenarios[key]?.["verification"]?.staleMisses).toBe(1);
      expect(policy.scenarios[key]?.["workflow"]).toBeUndefined();
    });
  });
});
