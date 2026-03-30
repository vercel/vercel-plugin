import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  projectPolicyPath,
  sessionExposurePath,
  loadProjectRoutingPolicy,
  saveProjectRoutingPolicy,
  appendSkillExposure,
  loadSessionExposures,
  resolveBoundaryOutcome,
  finalizeStaleExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import { createEmptyRoutingPolicy } from "../hooks/src/routing-policy.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT = "/tmp/test-project-routing-policy-ledger";
const TEST_SESSION = "test-session-rpl-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";
const T4 = "2026-03-27T04:04:00.000Z";

function makeExposure(overrides: Partial<SkillExposure> = {}): SkillExposure {
  return {
    id: `${TEST_SESSION}:test-skill:${Date.now()}`,
    sessionId: TEST_SESSION,
    projectRoot: TEST_PROJECT,
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
  const policyPath = projectPolicyPath(TEST_PROJECT);
  const exposurePath = sessionExposurePath(TEST_SESSION);
  try { unlinkSync(policyPath); } catch {}
  try { unlinkSync(exposurePath); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing-policy-ledger", () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  describe("projectPolicyPath", () => {
    test("uses sha256 of projectRoot in tmpdir", () => {
      const path = projectPolicyPath(TEST_PROJECT);
      const hash = createHash("sha256").update(TEST_PROJECT).digest("hex");
      expect(path).toBe(`${tmpdir()}/vercel-plugin-routing-policy-${hash}.json`);
    });

    test("different projects produce different paths", () => {
      const p1 = projectPolicyPath("/project-a");
      const p2 = projectPolicyPath("/project-b");
      expect(p1).not.toBe(p2);
    });
  });

  describe("sessionExposurePath", () => {
    test("uses sessionId in tmpdir for safe IDs", () => {
      const path = sessionExposurePath(TEST_SESSION);
      expect(path).toBe(`${tmpdir()}/vercel-plugin-${TEST_SESSION}-routing-exposures.jsonl`);
    });

    test("hashes unsafe session IDs containing / or :", () => {
      const unsafeId = "abc/def:ghi";
      const path = sessionExposurePath(unsafeId);
      const hash = createHash("sha256").update(unsafeId).digest("hex");
      expect(path).toBe(`${tmpdir()}/vercel-plugin-${hash}-routing-exposures.jsonl`);
      expect(path).not.toContain("abc/def:ghi");
      // The only slashes should be from the tmpdir prefix
      const segment = path.replace(`${tmpdir()}/`, "");
      expect(segment).not.toContain("/");
      expect(segment).not.toContain(":");
    });
  });

  describe("loadProjectRoutingPolicy / saveProjectRoutingPolicy", () => {
    test("returns empty policy when no file exists", () => {
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      expect(policy.version).toBe(1);
      expect(policy.scenarios).toEqual({});
    });

    test("round-trips a policy through save/load", () => {
      const policy = createEmptyRoutingPolicy();
      policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"] = {
        "agent-browser-verify": {
          exposures: 5,
          wins: 4,
          directiveWins: 3,
          staleMisses: 1,
          lastUpdatedAt: T0,
        },
      };

      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      expect(loaded.version).toBe(1);
      expect(loaded.scenarios["PreToolUse|flow-verification|uiRender|Bash"]["agent-browser-verify"]).toEqual({
        exposures: 5,
        wins: 4,
        directiveWins: 3,
        staleMisses: 1,
        lastUpdatedAt: T0,
      });
    });

    test("returns empty policy for corrupt file", () => {
      const path = projectPolicyPath(TEST_PROJECT);
      writeFileSync(path, "not-json");
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      expect(policy.version).toBe(1);
      expect(policy.scenarios).toEqual({});
    });
  });

  describe("appendSkillExposure / loadSessionExposures", () => {
    test("appends and loads exposures from JSONL", () => {
      const e1 = makeExposure({ id: "e1", createdAt: T0 });
      const e2 = makeExposure({ id: "e2", skill: "vercel-deploy", createdAt: T1 });

      appendSkillExposure(e1);
      appendSkillExposure(e2);

      const loaded = loadSessionExposures(TEST_SESSION);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe("e1");
      expect(loaded[1].id).toBe("e2");
      expect(loaded[1].skill).toBe("vercel-deploy");

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const scenario = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"];
      expect(scenario?.["agent-browser-verify"]?.exposures).toBe(1);
      expect(scenario?.["vercel-deploy"]?.exposures).toBe(1);
    });

    test("returns empty array for nonexistent session", () => {
      const loaded = loadSessionExposures("no-such-session");
      expect(loaded).toEqual([]);
    });
  });

  describe("resolveBoundaryOutcome", () => {
    test("resolves pending exposures matching boundary, story, and route as win", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));
      appendSkillExposure(makeExposure({ id: "e2", createdAt: T1 }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      expect(resolved).toHaveLength(2);
      expect(resolved[0].outcome).toBe("win");
      expect(resolved[0].resolvedAt).toBe(T2);
      expect(resolved[1].outcome).toBe("win");

      // Verify ledger is updated
      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded.every((e) => e.outcome === "win")).toBe(true);
    });

    test("resolves as directive-win when matchedSuggestedAction is true", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].outcome).toBe("directive-win");
    });

    test("does not resolve exposures with different boundary", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      expect(resolved).toHaveLength(0);

      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded[0].outcome).toBe("pending");
    });

    test("does not re-resolve already resolved exposures", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        outcome: "win",
        resolvedAt: T1,
        createdAt: T0,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      expect(resolved).toHaveLength(0);
    });

    test("updates project policy with resolved outcomes", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.wins).toBe(1);
      expect(stats!.directiveWins).toBe(1);
    });

    test("returns empty array when no pending exposures exist", () => {
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      expect(resolved).toEqual([]);
    });
  });

  describe("finalizeStaleExposures", () => {
    test("converts remaining pending exposures to stale-miss", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));
      appendSkillExposure(makeExposure({
        id: "e2",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      const stale = finalizeStaleExposures(TEST_SESSION, T3);

      expect(stale).toHaveLength(2);
      expect(stale[0].outcome).toBe("stale-miss");
      expect(stale[0].resolvedAt).toBe(T3);
      expect(stale[1].outcome).toBe("stale-miss");

      // Verify ledger
      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded.every((e) => e.outcome === "stale-miss")).toBe(true);
    });

    test("does not finalize already resolved exposures", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        outcome: "win",
        resolvedAt: T1,
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "e2",
        createdAt: T1,
      }));

      const stale = finalizeStaleExposures(TEST_SESSION, T3);

      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("e2");

      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded[0].outcome).toBe("win");
      expect(reloaded[1].outcome).toBe("stale-miss");
    });

    test("updates project policy with stale-miss outcomes", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      finalizeStaleExposures(TEST_SESSION, T3);

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.staleMisses).toBe(1);
      expect(stats!.wins).toBe(0);
    });

    test("returns empty array when no pending exposures exist", () => {
      const stale = finalizeStaleExposures(TEST_SESSION, T3);
      expect(stale).toEqual([]);
    });
  });

  describe("story/route-scoped resolution", () => {
    test("resolves only exposures matching the observed storyId", () => {
      appendSkillExposure(makeExposure({
        id: "story1-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "story2-e1",
        storyId: "story-2",
        route: "/settings",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("story1-e1");
      expect(resolved[0].outcome).toBe("win");

      // story-2 exposure remains pending
      const all = loadSessionExposures(TEST_SESSION);
      const story2 = all.find((e) => e.id === "story2-e1");
      expect(story2!.outcome).toBe("pending");
    });

    test("resolves only exposures matching the observed route", () => {
      appendSkillExposure(makeExposure({
        id: "settings-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "dashboard-e1",
        storyId: "story-1",
        route: "/dashboard",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("settings-e1");

      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "dashboard-e1")!.outcome).toBe("pending");
    });

    test("resolves only exposures matching both storyId and route", () => {
      appendSkillExposure(makeExposure({
        id: "match-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "wrong-story",
        storyId: "story-2",
        route: "/settings",
        createdAt: T1,
      }));
      appendSkillExposure(makeExposure({
        id: "wrong-route",
        storyId: "story-1",
        route: "/dashboard",
        createdAt: T2,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("match-e1");

      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "wrong-story")!.outcome).toBe("pending");
      expect(all.find((e) => e.id === "wrong-route")!.outcome).toBe("pending");
    });

    test("null observed route/storyId only resolves exposures with null route/storyId (strict matching)", () => {
      // Exposures with specific routes should NOT be resolved by a null observed route
      appendSkillExposure(makeExposure({
        id: "specific-route-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "specific-route-e2",
        storyId: "story-2",
        route: "/dashboard",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      // Strict null matching: null route/storyId does NOT match non-null exposures
      expect(resolved).toHaveLength(0);

      // All remain pending
      const all = loadSessionExposures(TEST_SESSION);
      expect(all.every((e) => e.outcome === "pending")).toBe(true);
    });

    test("null observed route/storyId resolves exposures that also have null route/storyId", () => {
      appendSkillExposure(makeExposure({
        id: "null-route-e1",
        storyId: null,
        route: null,
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "specific-route-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      // Only the null-route exposure is resolved
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("null-route-e1");

      // The specific-route exposure remains pending
      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "specific-route-e1")!.outcome).toBe("pending");
    });
  });

  describe("unsafe session ID round-trip", () => {
    const UNSAFE_SESSION = "abc/def:ghi";

    afterEach(() => {
      try { unlinkSync(sessionExposurePath(UNSAFE_SESSION)); } catch {}
      try { unlinkSync(projectPolicyPath(TEST_PROJECT)); } catch {}
    });

    test("append, load, resolve, and finalize all work with unsafe session IDs", () => {
      const e1 = makeExposure({
        id: "unsafe-e1",
        sessionId: UNSAFE_SESSION,
        targetBoundary: "clientRequest",
        createdAt: T0,
      });
      const e2 = makeExposure({
        id: "unsafe-e2",
        sessionId: UNSAFE_SESSION,
        targetBoundary: "uiRender",
        createdAt: T1,
      });

      // Append should not throw
      appendSkillExposure(e1);
      appendSkillExposure(e2);

      // Load should return both
      const loaded = loadSessionExposures(UNSAFE_SESSION);
      expect(loaded).toHaveLength(2);

      // Resolve clientRequest (must match storyId/route from makeExposure defaults)
      const resolved = resolveBoundaryOutcome({
        sessionId: UNSAFE_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("unsafe-e1");

      // Finalize remaining
      const stale = finalizeStaleExposures(UNSAFE_SESSION, T3);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("unsafe-e2");
      expect(stale[0].outcome).toBe("stale-miss");

      // Verify the file path doesn't contain unsafe characters
      const path = sessionExposurePath(UNSAFE_SESSION);
      const segment = path.replace(`${tmpdir()}/`, "");
      expect(segment).not.toContain("/");
      expect(segment).not.toContain(":");
    });
  });

  describe("null-route attribution guardrails", () => {
    test("null observed route does not over-credit exposures with specific routes", () => {
      appendSkillExposure(makeExposure({
        id: "route-a",
        route: "/settings",
        storyId: "story-1",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "route-b",
        route: "/dashboard",
        storyId: "story-1",
        createdAt: T1,
      }));
      appendSkillExposure(makeExposure({
        id: "route-c",
        route: "/api/users",
        storyId: "story-1",
        createdAt: T2,
      }));

      // Observed route is null — should NOT resolve any of these
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: null,
        now: T3,
      });

      expect(resolved).toHaveLength(0);

      // All remain pending
      const all = loadSessionExposures(TEST_SESSION);
      expect(all.every((e) => e.outcome === "pending")).toBe(true);
    });

    test("null observed storyId does not over-credit exposures with specific storyIds", () => {
      appendSkillExposure(makeExposure({
        id: "story-a",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "story-b",
        storyId: "story-2",
        route: "/settings",
        createdAt: T1,
      }));

      // Observed storyId is null — should NOT resolve any
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: null,
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(0);
    });

    test("mixed null and non-null: only exact matches resolve", () => {
      // Exposure with null route
      appendSkillExposure(makeExposure({
        id: "null-route",
        storyId: "story-1",
        route: null,
        createdAt: T0,
      }));
      // Exposure with specific route
      appendSkillExposure(makeExposure({
        id: "specific-route",
        storyId: "story-1",
        route: "/settings",
        createdAt: T1,
      }));

      // Resolve with null route — only matches null-route exposure
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: null,
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("null-route");

      // specific-route remains pending
      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "specific-route")!.outcome).toBe("pending");
    });
  });

  describe("outcome distinguishability", () => {
    test("directive-win and plain win are persisted distinctly in exposures", () => {
      appendSkillExposure(makeExposure({
        id: "directive-e1",
        storyId: "story-1",
        route: "/a",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "plain-e1",
        storyId: "story-1",
        route: "/b",
        createdAt: T1,
      }));

      // Directive win for /a
      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/a",
        now: T2,
      });

      // Plain win for /b
      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/b",
        now: T3,
      });

      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "directive-e1")!.outcome).toBe("directive-win");
      expect(all.find((e) => e.id === "plain-e1")!.outcome).toBe("win");
    });

    test("directive-win, win, and stale-miss coexist in the same session ledger", () => {
      appendSkillExposure(makeExposure({
        id: "dw-e1",
        storyId: "story-1",
        route: "/a",
        targetBoundary: "uiRender",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "w-e1",
        storyId: "story-1",
        route: "/b",
        targetBoundary: "uiRender",
        createdAt: T1,
      }));
      appendSkillExposure(makeExposure({
        id: "sm-e1",
        storyId: "story-1",
        route: "/c",
        targetBoundary: "clientRequest",
        createdAt: T2,
      }));

      // Directive win
      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/a",
        now: T3,
      });

      // Plain win
      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/b",
        now: T3,
      });

      // Stale-miss the rest
      finalizeStaleExposures(TEST_SESSION, T4);

      const all = loadSessionExposures(TEST_SESSION);
      const outcomes = all.map((e) => ({ id: e.id, outcome: e.outcome }));
      expect(outcomes).toEqual([
        { id: "dw-e1", outcome: "directive-win" },
        { id: "w-e1", outcome: "win" },
        { id: "sm-e1", outcome: "stale-miss" },
      ]);
    });

    test("policy correctly distinguishes directive-win from plain win counts", () => {
      appendSkillExposure(makeExposure({
        id: "dw",
        storyId: "story-1",
        route: "/a",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "pw",
        storyId: "story-1",
        route: "/b",
        createdAt: T1,
      }));

      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        storyId: "story-1",
        route: "/a",
        now: T2,
      });
      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/b",
        now: T3,
      });

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats!.wins).toBe(2);
      expect(stats!.directiveWins).toBe(1);
    });
  });

  describe("stale-miss finalization determinism", () => {
    test("repeated finalization calls produce identical results", () => {
      appendSkillExposure(makeExposure({
        id: "det-e1",
        storyId: "s1",
        route: "/x",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "det-e2",
        storyId: "s1",
        route: "/y",
        createdAt: T1,
      }));

      const first = finalizeStaleExposures(TEST_SESSION, T3);
      expect(first).toHaveLength(2);
      expect(first.every((e) => e.outcome === "stale-miss")).toBe(true);

      // Second call should be a no-op
      const second = finalizeStaleExposures(TEST_SESSION, T4);
      expect(second).toHaveLength(0);

      // Ledger is identical after both calls
      const all = loadSessionExposures(TEST_SESSION);
      expect(all).toHaveLength(2);
      expect(all[0].resolvedAt).toBe(T3);
      expect(all[1].resolvedAt).toBe(T3);
    });
  });

  describe("strict null matching regression — paired unresolved/resolved", () => {
    test("pending exposure stays unresolved when observed storyId and route are both null", () => {
      appendSkillExposure(makeExposure({
        id: "fallback-e1",
        storyId: "story-fb",
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      // Attempt resolution with null storyId and null route
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: null,
        route: null,
        now: T1,
      });

      // Strict null matching: null does not match non-null — exposure stays pending
      expect(resolved).toHaveLength(0);

      const all = loadSessionExposures(TEST_SESSION);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("fallback-e1");
      expect(all[0].outcome).toBe("pending");
      expect(all[0].resolvedAt).toBeNull();

      // Policy should have exposure counted but zero wins
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.wins).toBe(0);
      expect(stats!.directiveWins).toBe(0);
    });

    test("same exposure resolves once exact storyId and route are supplied", () => {
      // Seed the same exposure as the paired test above
      appendSkillExposure(makeExposure({
        id: "fallback-e1",
        storyId: "story-fb",
        route: "/settings",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      // First: null attempt — should fail
      const attempt1 = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: null,
        route: null,
        now: T1,
      });
      expect(attempt1).toHaveLength(0);

      // Second: exact values — should succeed
      const attempt2 = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: true,
        storyId: "story-fb",
        route: "/settings",
        now: T2,
      });

      expect(attempt2).toHaveLength(1);
      expect(attempt2[0].id).toBe("fallback-e1");
      expect(attempt2[0].outcome).toBe("directive-win");
      expect(attempt2[0].resolvedAt).toBe(T2);

      // Verify ledger is updated
      const all = loadSessionExposures(TEST_SESSION);
      expect(all).toHaveLength(1);
      expect(all[0].outcome).toBe("directive-win");

      // Policy stats should reflect exactly 1 exposure, 1 win, 1 directiveWin
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.wins).toBe(1);
      expect(stats!.directiveWins).toBe(1);
      expect(stats!.staleMisses).toBe(0);
    });

    test("multiple exposures: null resolution leaves all pending, exact resolution is selective", () => {
      appendSkillExposure(makeExposure({
        id: "multi-e1",
        storyId: "story-m",
        route: "/api/data",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "multi-e2",
        storyId: "story-m",
        route: "/api/users",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));
      appendSkillExposure(makeExposure({
        id: "multi-e3",
        storyId: null,
        route: null,
        targetBoundary: "clientRequest",
        createdAt: T2,
      }));

      // Null resolution: only multi-e3 (null/null) should resolve
      const nullResolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: null,
        route: null,
        now: T3,
      });
      expect(nullResolved).toHaveLength(1);
      expect(nullResolved[0].id).toBe("multi-e3");

      // Exact resolution for multi-e1
      const exactResolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        storyId: "story-m",
        route: "/api/data",
        now: T4,
      });
      expect(exactResolved).toHaveLength(1);
      expect(exactResolved[0].id).toBe("multi-e1");

      // multi-e2 remains pending
      const all = loadSessionExposures(TEST_SESSION);
      const e2 = all.find((e) => e.id === "multi-e2");
      expect(e2!.outcome).toBe("pending");

      // Policy: 3 exposures, 2 wins, 0 directiveWins
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|clientRequest|Bash"]?.["agent-browser-verify"];
      expect(stats!.exposures).toBe(3);
      expect(stats!.wins).toBe(2);
      expect(stats!.directiveWins).toBe(0);
    });
  });

  describe("idempotency", () => {
    test("resolveBoundaryOutcome is safe to call twice", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T2,
      });

      // Second call should find no pending exposures
      const second = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/dashboard",
        now: T3,
      });

      expect(second).toHaveLength(0);

      // Policy should still have exactly 1 win
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats!.wins).toBe(1);
    });

    test("finalizeStaleExposures is safe to call twice", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      finalizeStaleExposures(TEST_SESSION, T2);
      const second = finalizeStaleExposures(TEST_SESSION, T3);

      expect(second).toHaveLength(0);
    });
  });
});
