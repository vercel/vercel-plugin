import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  appendRoutingDecisionTrace,
  readRoutingDecisionTrace,
  createDecisionId,
  traceDir,
  tracePath,
  type RoutingDecisionTrace,
  type DecisionHook,
} from "../hooks/src/routing-decision-trace.mts";
import {
  createDecisionCausality,
  addCause,
  addEdge,
  causesForSkill,
  type RoutingDecisionCause,
  type RoutingDecisionEdge,
} from "../hooks/src/routing-decision-causality.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SESSION = "test-session-rdt-" + Date.now();

function makeTrace(
  overrides: Partial<RoutingDecisionTrace> = {},
): RoutingDecisionTrace {
  return {
    version: 2,
    decisionId: "deadbeef01234567",
    sessionId: TEST_SESSION,
    hook: "PreToolUse",
    toolName: "Bash",
    toolTarget: "npm run dev",
    timestamp: "2026-03-27T08:00:00.000Z",
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/settings",
      targetBoundary: "uiRender",
    },
    observedRoute: null,
    policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
    matchedSkills: ["agent-browser-verify"],
    injectedSkills: ["agent-browser-verify"],
    skippedReasons: [],
    ranked: [
      {
        skill: "agent-browser-verify",
        basePriority: 7,
        effectivePriority: 15,
        pattern: { type: "bashPattern", value: "dev server" },
        profilerBoost: 0,
        policyBoost: 8,
        policyReason: "4/5 wins",
        summaryOnly: false,
        synthetic: false,
        droppedReason: null,
      },
    ],
    verification: null,
    causes: [],
    edges: [],
    ...overrides,
  };
}

function cleanup() {
  try {
    rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(traceDir(null), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(traceDir("unsafe/session:id"), { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing-decision-trace", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  describe("traceDir / tracePath", () => {
    test("uses sessionId directly for safe IDs", () => {
      const dir = traceDir("my-session-123");
      expect(dir).toBe(`${tmpdir()}/vercel-plugin-my-session-123-trace`);
    });

    test("hashes unsafe session IDs", () => {
      const dir = traceDir("unsafe/session:id");
      const hash = createHash("sha256")
        .update("unsafe/session:id")
        .digest("hex");
      expect(dir).toBe(`${tmpdir()}/vercel-plugin-${hash}-trace`);
    });

    test("uses 'no-session' for null sessionId", () => {
      const dir = traceDir(null);
      expect(dir).toBe(`${tmpdir()}/vercel-plugin-no-session-trace`);
    });

    test("tracePath ends with routing-decision-trace.jsonl", () => {
      const path = tracePath(TEST_SESSION);
      expect(path).toEndWith("/routing-decision-trace.jsonl");
      expect(path).toContain(TEST_SESSION);
    });
  });

  // -------------------------------------------------------------------------
  // createDecisionId
  // -------------------------------------------------------------------------

  describe("createDecisionId", () => {
    test("returns 16-character hex string", () => {
      const id = createDecisionId({
        hook: "PreToolUse",
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      });
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    test("deterministic for identical inputs", () => {
      const input = {
        hook: "PreToolUse" as DecisionHook,
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const id1 = createDecisionId(input);
      const id2 = createDecisionId(input);
      expect(id1).toBe(id2);
    });

    test("changes when hook changes", () => {
      const base = {
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const a = createDecisionId({ ...base, hook: "PreToolUse" });
      const b = createDecisionId({ ...base, hook: "PostToolUse" });
      expect(a).not.toBe(b);
    });

    test("changes when sessionId changes", () => {
      const base = {
        hook: "PreToolUse" as DecisionHook,
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const a = createDecisionId({ ...base, sessionId: "sess-1" });
      const b = createDecisionId({ ...base, sessionId: "sess-2" });
      expect(a).not.toBe(b);
    });

    test("changes when toolName changes", () => {
      const base = {
        hook: "PreToolUse" as DecisionHook,
        sessionId: "sess-1",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const a = createDecisionId({ ...base, toolName: "Bash" });
      const b = createDecisionId({ ...base, toolName: "Read" });
      expect(a).not.toBe(b);
    });

    test("changes when toolTarget changes", () => {
      const base = {
        hook: "PreToolUse" as DecisionHook,
        sessionId: "sess-1",
        toolName: "Bash",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const a = createDecisionId({ ...base, toolTarget: "npm run dev" });
      const b = createDecisionId({ ...base, toolTarget: "npm run build" });
      expect(a).not.toBe(b);
    });

    test("changes when timestamp changes", () => {
      const base = {
        hook: "PreToolUse" as DecisionHook,
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "npm run dev",
      };
      const a = createDecisionId({
        ...base,
        timestamp: "2026-03-27T08:00:00.000Z",
      });
      const b = createDecisionId({
        ...base,
        timestamp: "2026-03-27T08:01:00.000Z",
      });
      expect(a).not.toBe(b);
    });

    test("treats null sessionId as empty string", () => {
      const base = {
        hook: "PreToolUse" as DecisionHook,
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
      };
      const a = createDecisionId({ ...base, sessionId: null });
      const b = createDecisionId({ ...base, sessionId: null });
      expect(a).toBe(b);

      const c = createDecisionId({ ...base, sessionId: "real-session" });
      expect(a).not.toBe(c);
    });
  });

  // -------------------------------------------------------------------------
  // Append + Read round-trip
  // -------------------------------------------------------------------------

  describe("appendRoutingDecisionTrace / readRoutingDecisionTrace", () => {
    test("single trace round-trip", () => {
      const trace = makeTrace();
      appendRoutingDecisionTrace(trace);

      const traces = readRoutingDecisionTrace(TEST_SESSION);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toEqual(trace);
    });

    test("multiple traces appended in order", () => {
      const t1 = makeTrace({
        decisionId: "aaaa000000000001",
        timestamp: "2026-03-27T08:00:00.000Z",
      });
      const t2 = makeTrace({
        decisionId: "aaaa000000000002",
        timestamp: "2026-03-27T08:01:00.000Z",
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        toolTarget: "deploy my app",
      });
      const t3 = makeTrace({
        decisionId: "aaaa000000000003",
        timestamp: "2026-03-27T08:02:00.000Z",
        hook: "PostToolUse",
        observedRoute: "/dashboard",
        verification: {
          verificationId: "verif-1",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      });

      appendRoutingDecisionTrace(t1);
      appendRoutingDecisionTrace(t2);
      appendRoutingDecisionTrace(t3);

      const traces = readRoutingDecisionTrace(TEST_SESSION);
      expect(traces).toHaveLength(3);
      expect(traces[0].decisionId).toBe("aaaa000000000001");
      expect(traces[1].decisionId).toBe("aaaa000000000002");
      expect(traces[2].decisionId).toBe("aaaa000000000003");
      expect(traces[0]).toEqual(t1);
      expect(traces[1]).toEqual(t2);
      expect(traces[2]).toEqual(t3);
    });

    test("returns [] for non-existent session trace", () => {
      const traces = readRoutingDecisionTrace("nonexistent-session-xyz");
      expect(traces).toEqual([]);
    });

    test("returns [] for null sessionId with no trace file", () => {
      const traces = readRoutingDecisionTrace(null);
      expect(traces).toEqual([]);
    });

    test("handles null sessionId traces", () => {
      const trace = makeTrace({ sessionId: null });
      appendRoutingDecisionTrace(trace);

      const traces = readRoutingDecisionTrace(null);
      expect(traces).toHaveLength(1);
      expect(traces[0].sessionId).toBeNull();
    });

    test("JSONL file has one JSON object per line", () => {
      appendRoutingDecisionTrace(makeTrace({ decisionId: "line1-id-0000001" }));
      appendRoutingDecisionTrace(makeTrace({ decisionId: "line2-id-0000002" }));

      const raw = readFileSync(tracePath(TEST_SESSION), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(2);

      // Each line is valid JSON
      const parsed1 = JSON.parse(lines[0]);
      const parsed2 = JSON.parse(lines[1]);
      expect(parsed1.decisionId).toBe("line1-id-0000001");
      expect(parsed2.decisionId).toBe("line2-id-0000002");
    });

    test("creates trace directory if it does not exist", () => {
      // Cleanup ensures dir doesn't exist
      expect(existsSync(traceDir(TEST_SESSION))).toBe(false);

      appendRoutingDecisionTrace(makeTrace());
      expect(existsSync(traceDir(TEST_SESSION))).toBe(true);
    });

    test("preserves all v2 trace fields", () => {
      const trace = makeTrace({
        policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
        observedRoute: "/dashboard",
        skippedReasons: [
          "no_active_verification_story",
          "cap_exceeded:some-skill",
        ],
        ranked: [
          {
            skill: "agent-browser-verify",
            basePriority: 7,
            effectivePriority: 15,
            pattern: { type: "bashPattern", value: "dev" },
            profilerBoost: 5,
            policyBoost: 8,
            policyReason: "4/5 wins",
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
          {
            skill: "verification",
            basePriority: 6,
            effectivePriority: 6,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: true,
            synthetic: true,
            droppedReason: "budget_exhausted",
          },
        ],
        verification: {
          verificationId: "verif-abc",
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      });

      appendRoutingDecisionTrace(trace);
      const [read] = readRoutingDecisionTrace(TEST_SESSION);

      expect(read.version).toBe(2);
      expect(read.primaryStory.id).toBe("story-1");
      expect(read.primaryStory.kind).toBe("flow-verification");
      expect(read.primaryStory.storyRoute).toBe("/settings");
      expect(read.primaryStory.targetBoundary).toBe("uiRender");
      expect(read.observedRoute).toBe("/dashboard");
      expect(read.policyScenario).toBe(
        "PreToolUse|flow-verification|uiRender|Bash",
      );
      expect(read.skippedReasons).toEqual([
        "no_active_verification_story",
        "cap_exceeded:some-skill",
      ]);
      expect(read.ranked).toHaveLength(2);
      expect(read.ranked[0].policyBoost).toBe(8);
      expect(read.ranked[0].synthetic).toBe(false);
      expect(read.ranked[1].droppedReason).toBe("budget_exhausted");
      expect(read.ranked[1].synthetic).toBe(true);
      expect(read.verification?.verificationId).toBe("verif-abc");
      expect(read.verification?.matchedSuggestedAction).toBe(true);
    });

    test("v2 storyRoute and observedRoute are independent", () => {
      const trace = makeTrace({
        hook: "PostToolUse",
        primaryStory: {
          id: "story-1",
          kind: "flow-verification",
          storyRoute: "/settings",
          targetBoundary: "uiRender",
        },
        observedRoute: "/api/users",
      });

      appendRoutingDecisionTrace(trace);
      const [read] = readRoutingDecisionTrace(TEST_SESSION);

      expect(read.primaryStory.storyRoute).toBe("/settings");
      expect(read.observedRoute).toBe("/api/users");
    });

    test("idempotent: appending same trace twice yields two records", () => {
      const trace = makeTrace();
      appendRoutingDecisionTrace(trace);
      appendRoutingDecisionTrace(trace);

      const traces = readRoutingDecisionTrace(TEST_SESSION);
      expect(traces).toHaveLength(2);
      expect(traces[0]).toEqual(traces[1]);
    });
  });

  // -------------------------------------------------------------------------
  // V1 backward compatibility
  // -------------------------------------------------------------------------

  describe("v1 backward compatibility", () => {
    test("v1 traces are normalized to v2 on read", () => {
      // Write a raw v1 trace directly to the JSONL file
      const v1Trace = {
        version: 1,
        decisionId: "v1-trace-0000001",
        sessionId: TEST_SESSION,
        hook: "PreToolUse",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
        primaryStory: {
          id: "story-1",
          kind: "flow-verification",
          route: "/settings",
          targetBoundary: "uiRender",
        },
        policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
        matchedSkills: ["agent-browser-verify"],
        injectedSkills: ["agent-browser-verify"],
        skippedReasons: [],
        ranked: [],
        verification: null,
      };

      mkdirSync(traceDir(TEST_SESSION), { recursive: true });
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(v1Trace) + "\n",
        "utf8",
      );

      const traces = readRoutingDecisionTrace(TEST_SESSION);
      expect(traces).toHaveLength(1);
      const read = traces[0];

      // Normalized to v2
      expect(read.version).toBe(2);
      expect(read.primaryStory.storyRoute).toBe("/settings");
      expect(read.observedRoute).toBe("/settings"); // best-effort from v1 route
      expect((read.primaryStory as any).route).toBeUndefined();
    });

    test("mixed v1 and v2 traces are all normalized to v2", () => {
      const v1Trace = {
        version: 1,
        decisionId: "v1-trace-0000001",
        sessionId: TEST_SESSION,
        hook: "PreToolUse",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
        primaryStory: {
          id: "story-1",
          kind: "flow-verification",
          route: "/old-route",
          targetBoundary: "uiRender",
        },
        policyScenario: null,
        matchedSkills: [],
        injectedSkills: [],
        skippedReasons: [],
        ranked: [],
        verification: null,
      };

      const v2Trace = makeTrace({
        decisionId: "v2-trace-0000002",
        primaryStory: {
          id: "story-2",
          kind: "flow-verification",
          storyRoute: "/new-route",
          targetBoundary: "clientRequest",
        },
        observedRoute: "/api/data",
      });

      mkdirSync(traceDir(TEST_SESSION), { recursive: true });
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(v1Trace) + "\n",
        "utf8",
      );
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(v2Trace) + "\n",
        "utf8",
      );

      const traces = readRoutingDecisionTrace(TEST_SESSION);
      expect(traces).toHaveLength(2);
      expect(traces[0].version).toBe(2);
      expect(traces[1].version).toBe(2);
      expect(traces[0].primaryStory.storyRoute).toBe("/old-route");
      expect(traces[1].primaryStory.storyRoute).toBe("/new-route");
      expect(traces[1].observedRoute).toBe("/api/data");
    });

    test("v1 trace with null route normalizes correctly", () => {
      const v1Trace = {
        version: 1,
        decisionId: "v1-null-route",
        sessionId: TEST_SESSION,
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        toolTarget: "deploy",
        timestamp: "2026-03-27T08:00:00.000Z",
        primaryStory: {
          id: null,
          kind: null,
          route: null,
          targetBoundary: null,
        },
        policyScenario: null,
        matchedSkills: [],
        injectedSkills: [],
        skippedReasons: ["no_active_verification_story"],
        ranked: [],
        verification: null,
      };

      mkdirSync(traceDir(TEST_SESSION), { recursive: true });
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(v1Trace) + "\n",
        "utf8",
      );

      const [read] = readRoutingDecisionTrace(TEST_SESSION);
      expect(read.version).toBe(2);
      expect(read.primaryStory.storyRoute).toBeNull();
      expect(read.observedRoute).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Synthetic injection tracking
  // -------------------------------------------------------------------------

  describe("synthetic injection tracking", () => {
    test("synthetic flag distinguishes pattern-matched from synthetic injections", () => {
      const trace = makeTrace({
        ranked: [
          {
            skill: "agent-browser-verify",
            basePriority: 7,
            effectivePriority: 15,
            pattern: { type: "bashPattern", value: "dev server" },
            profilerBoost: 0,
            policyBoost: 8,
            policyReason: "4/5 wins",
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
          {
            skill: "verification",
            basePriority: 0,
            effectivePriority: 0,
            pattern: { type: "dev-server-companion", value: "dev-server-co-inject" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: true,
            droppedReason: null,
          },
          {
            skill: "react-best-practices",
            basePriority: 0,
            effectivePriority: 0,
            pattern: { type: "tsx-edit-threshold", value: "tsx-review-trigger" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: true,
            droppedReason: "cap_exceeded",
          },
        ],
      });

      appendRoutingDecisionTrace(trace);
      const [read] = readRoutingDecisionTrace(TEST_SESSION);

      const patternMatched = read.ranked.filter((r) => !r.synthetic);
      const synthetic = read.ranked.filter((r) => r.synthetic);

      expect(patternMatched).toHaveLength(1);
      expect(patternMatched[0].skill).toBe("agent-browser-verify");
      expect(synthetic).toHaveLength(2);
      expect(synthetic.map((s) => s.skill).sort()).toEqual([
        "react-best-practices",
        "verification",
      ]);
    });

    test("one trace line reconstructs final injected set plus dropped candidates", () => {
      const trace = makeTrace({
        injectedSkills: ["agent-browser-verify", "verification"],
        ranked: [
          {
            skill: "agent-browser-verify",
            basePriority: 7,
            effectivePriority: 15,
            pattern: { type: "bashPattern", value: "dev" },
            profilerBoost: 0,
            policyBoost: 8,
            policyReason: "4/5 wins",
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
          {
            skill: "verification",
            basePriority: 0,
            effectivePriority: 0,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: true,
            droppedReason: null,
          },
          {
            skill: "react-best-practices",
            basePriority: 6,
            effectivePriority: 6,
            pattern: null,
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: true,
            droppedReason: "cap_exceeded",
          },
          {
            skill: "nextjs-basics",
            basePriority: 5,
            effectivePriority: 5,
            pattern: { type: "pathPattern", value: "**/*.tsx" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: "deduped",
          },
        ],
      });

      appendRoutingDecisionTrace(trace);
      const [read] = readRoutingDecisionTrace(TEST_SESSION);

      // Reconstruct final injected set from ranked
      const injected = read.ranked.filter((r) => r.droppedReason === null);
      expect(injected.map((r) => r.skill).sort()).toEqual(
        [...read.injectedSkills].sort(),
      );

      // Reconstruct dropped candidates
      const dropped = read.ranked.filter((r) => r.droppedReason !== null);
      expect(dropped).toHaveLength(2);
      expect(dropped.find((r) => r.skill === "react-best-practices")?.droppedReason).toBe("cap_exceeded");
      expect(dropped.find((r) => r.skill === "nextjs-basics")?.droppedReason).toBe("deduped");
    });
  });

  // -------------------------------------------------------------------------
  // Unsafe session IDs
  // -------------------------------------------------------------------------

  describe("unsafe session IDs", () => {
    test("session with slashes is hashed for path safety", () => {
      const unsafeSession = "unsafe/session:id";
      const trace = makeTrace({ sessionId: unsafeSession });
      appendRoutingDecisionTrace(trace);

      const traces = readRoutingDecisionTrace(unsafeSession);
      expect(traces).toHaveLength(1);
      expect(traces[0].sessionId).toBe(unsafeSession);

      // The directory should use the hashed name
      const dir = traceDir(unsafeSession);
      const hash = createHash("sha256")
        .update(unsafeSession)
        .digest("hex");
      expect(dir).toContain(hash);
    });
  });

  // -------------------------------------------------------------------------
  // Causality: causes and edges round-trip
  // -------------------------------------------------------------------------

  describe("causality round-trip", () => {
    test("traces with causes and edges round-trip through JSONL", () => {
      const causes: RoutingDecisionCause[] = [
        {
          code: "pattern-match",
          stage: "match",
          skill: "agent-browser-verify",
          synthetic: false,
          scoreDelta: 0,
          message: "Matched bashPattern pattern",
          detail: { matchType: "bashPattern", pattern: "dev server" },
        },
        {
          code: "policy-recall",
          stage: "rank",
          skill: "agent-browser-verify",
          synthetic: true,
          scoreDelta: 0,
          message: "Recalled historically verified skill",
          detail: { scenario: "PreToolUse|bugfix|uiRender|Bash|/settings", wins: 4 },
        },
        {
          code: "verified-companion",
          stage: "rank",
          skill: "verification",
          synthetic: true,
          scoreDelta: 0,
          message: "Inserted learned companion after agent-browser-verify",
          detail: { candidateSkill: "agent-browser-verify", confidence: 0.93 },
        },
      ];
      const edges: RoutingDecisionEdge[] = [
        {
          fromSkill: "agent-browser-verify",
          toSkill: "verification",
          relation: "companion-of",
          code: "verified-companion",
          detail: { confidence: 0.93, scenario: "PreToolUse|bugfix|uiRender|Bash|/settings" },
        },
      ];
      const trace = makeTrace({ causes, edges });
      appendRoutingDecisionTrace(trace);

      const [read] = readRoutingDecisionTrace(TEST_SESSION);
      expect(read.causes).toEqual(causes);
      expect(read.edges).toEqual(edges);
    });

    test("old v2 traces without causes/edges get empty arrays on read", () => {
      // Simulate a v2 trace written before the causality feature
      const rawTrace = {
        version: 2,
        decisionId: "pre-causality-0001",
        sessionId: TEST_SESSION,
        hook: "PreToolUse",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
        primaryStory: { id: null, kind: null, storyRoute: null, targetBoundary: null },
        observedRoute: null,
        policyScenario: null,
        matchedSkills: [],
        injectedSkills: [],
        skippedReasons: [],
        ranked: [],
        verification: null,
        // no causes or edges field
      };

      mkdirSync(traceDir(TEST_SESSION), { recursive: true });
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(rawTrace) + "\n",
        "utf8",
      );

      const [read] = readRoutingDecisionTrace(TEST_SESSION);
      expect(read.causes).toEqual([]);
      expect(read.edges).toEqual([]);
    });

    test("v1 traces get empty causes and edges on normalization", () => {
      const v1Trace = {
        version: 1,
        decisionId: "v1-causality-test",
        sessionId: TEST_SESSION,
        hook: "PreToolUse",
        toolName: "Bash",
        toolTarget: "npm run dev",
        timestamp: "2026-03-27T08:00:00.000Z",
        primaryStory: { id: null, kind: null, route: null, targetBoundary: null },
        policyScenario: null,
        matchedSkills: [],
        injectedSkills: [],
        skippedReasons: [],
        ranked: [],
        verification: null,
      };

      mkdirSync(traceDir(TEST_SESSION), { recursive: true });
      appendFileSync(
        tracePath(TEST_SESSION),
        JSON.stringify(v1Trace) + "\n",
        "utf8",
      );

      const [read] = readRoutingDecisionTrace(TEST_SESSION);
      expect(read.version).toBe(2);
      expect(read.causes).toEqual([]);
      expect(read.edges).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Causality helpers: deterministic sorting
  // -------------------------------------------------------------------------

  describe("routing-decision-causality", () => {
    test("createDecisionCausality returns empty causes and edges", () => {
      const store = createDecisionCausality();
      expect(store.causes).toEqual([]);
      expect(store.edges).toEqual([]);
    });

    test("addCause sorts detail keys deterministically", () => {
      const store = createDecisionCausality();
      addCause(store, {
        code: "pattern-match",
        stage: "match",
        skill: "nextjs-basics",
        synthetic: false,
        scoreDelta: 0,
        message: "Matched pathPattern",
        detail: { zebra: 1, alpha: 2, middle: 3 },
      });

      const keys = Object.keys(store.causes[0].detail);
      expect(keys).toEqual(["alpha", "middle", "zebra"]);
    });

    test("addCause sorts nested detail objects", () => {
      const store = createDecisionCausality();
      addCause(store, {
        code: "policy-boost",
        stage: "rank",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 8,
        message: "Policy boost",
        detail: { z: { b: 1, a: 2 }, a: { d: 3, c: 4 } },
      });

      const detail = store.causes[0].detail;
      expect(Object.keys(detail)).toEqual(["a", "z"]);
      expect(Object.keys(detail.a as Record<string, unknown>)).toEqual(["c", "d"]);
      expect(Object.keys(detail.z as Record<string, unknown>)).toEqual(["a", "b"]);
    });

    test("causes are sorted by (skill, stage, code, message) regardless of insertion order", () => {
      const store = createDecisionCausality();

      // Insert in reverse alphabetical order
      addCause(store, {
        code: "verified-companion",
        stage: "rank",
        skill: "verification",
        synthetic: true,
        scoreDelta: 0,
        message: "Companion",
        detail: {},
      });
      addCause(store, {
        code: "pattern-match",
        stage: "match",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 0,
        message: "Pattern match",
        detail: {},
      });
      addCause(store, {
        code: "policy-boost",
        stage: "rank",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 8,
        message: "Policy boost",
        detail: {},
      });

      // Sorted by skill first, then stage, code, message
      expect(store.causes[0].skill).toBe("agent-browser-verify");
      expect(store.causes[0].code).toBe("pattern-match");
      expect(store.causes[1].skill).toBe("agent-browser-verify");
      expect(store.causes[1].code).toBe("policy-boost");
      expect(store.causes[2].skill).toBe("verification");
    });

    test("edges are sorted by (fromSkill, toSkill, relation, code) regardless of insertion order", () => {
      const store = createDecisionCausality();

      addEdge(store, {
        fromSkill: "nextjs-basics",
        toSkill: "verification",
        relation: "companion-of",
        code: "verified-companion",
        detail: {},
      });
      addEdge(store, {
        fromSkill: "agent-browser-verify",
        toSkill: "verification",
        relation: "companion-of",
        code: "verified-companion",
        detail: {},
      });

      expect(store.edges[0].fromSkill).toBe("agent-browser-verify");
      expect(store.edges[1].fromSkill).toBe("nextjs-basics");
    });

    test("addEdge sorts detail keys deterministically", () => {
      const store = createDecisionCausality();
      addEdge(store, {
        fromSkill: "a",
        toSkill: "b",
        relation: "companion-of",
        code: "test",
        detail: { scenario: "x", confidence: 0.9, alpha: true },
      });

      const keys = Object.keys(store.edges[0].detail);
      expect(keys).toEqual(["alpha", "confidence", "scenario"]);
    });

    test("causesForSkill filters by skill name", () => {
      const store = createDecisionCausality();
      addCause(store, {
        code: "pattern-match",
        stage: "match",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 0,
        message: "Pattern",
        detail: {},
      });
      addCause(store, {
        code: "policy-boost",
        stage: "rank",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 8,
        message: "Boost",
        detail: {},
      });
      addCause(store, {
        code: "verified-companion",
        stage: "rank",
        skill: "verification",
        synthetic: true,
        scoreDelta: 0,
        message: "Companion",
        detail: {},
      });

      const abvCauses = causesForSkill(store, "agent-browser-verify");
      expect(abvCauses).toHaveLength(2);
      expect(abvCauses.every((c) => c.skill === "agent-browser-verify")).toBe(true);

      const verifCauses = causesForSkill(store, "verification");
      expect(verifCauses).toHaveLength(1);
      expect(verifCauses[0].code).toBe("verified-companion");

      const noneCauses = causesForSkill(store, "nonexistent");
      expect(noneCauses).toEqual([]);
    });

    test("deterministic serialization: same causes in different order produce identical JSON", () => {
      const storeA = createDecisionCausality();
      const storeB = createDecisionCausality();

      const cause1: RoutingDecisionCause = {
        code: "verified-companion",
        stage: "rank",
        skill: "verification",
        synthetic: true,
        scoreDelta: 0,
        message: "Companion",
        detail: { candidateSkill: "agent-browser-verify", confidence: 0.93 },
      };
      const cause2: RoutingDecisionCause = {
        code: "pattern-match",
        stage: "match",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 0,
        message: "Pattern match",
        detail: { matchType: "bashPattern", pattern: "dev" },
      };

      // Insert in opposite orders
      addCause(storeA, cause1);
      addCause(storeA, cause2);

      addCause(storeB, cause2);
      addCause(storeB, cause1);

      expect(JSON.stringify(storeA.causes)).toBe(JSON.stringify(storeB.causes));
    });

    test("deterministic serialization: same edges in different order produce identical JSON", () => {
      const storeA = createDecisionCausality();
      const storeB = createDecisionCausality();

      const edge1: RoutingDecisionEdge = {
        fromSkill: "nextjs-basics",
        toSkill: "verification",
        relation: "companion-of",
        code: "verified-companion",
        detail: { scenario: "test" },
      };
      const edge2: RoutingDecisionEdge = {
        fromSkill: "agent-browser-verify",
        toSkill: "verification",
        relation: "companion-of",
        code: "verified-companion",
        detail: { scenario: "test" },
      };

      addEdge(storeA, edge1);
      addEdge(storeA, edge2);

      addEdge(storeB, edge2);
      addEdge(storeB, edge1);

      expect(JSON.stringify(storeA.edges)).toBe(JSON.stringify(storeB.edges));
    });

    test("causality persists through trace round-trip with deterministic ordering", () => {
      const store = createDecisionCausality();

      // Insert causes in reverse order
      addCause(store, {
        code: "dropped-cap",
        stage: "inject",
        skill: "react-best-practices",
        synthetic: false,
        scoreDelta: 0,
        message: "Dropped because max skill cap was exceeded",
        detail: { maxSkills: 3 },
      });
      addCause(store, {
        code: "pattern-match",
        stage: "match",
        skill: "agent-browser-verify",
        synthetic: false,
        scoreDelta: 0,
        message: "Matched bashPattern",
        detail: { pattern: "dev", matchType: "bashPattern" },
      });

      addEdge(store, {
        fromSkill: "agent-browser-verify",
        toSkill: "verification",
        relation: "companion-of",
        code: "verified-companion",
        detail: { confidence: 0.93 },
      });

      const trace = makeTrace({
        causes: store.causes,
        edges: store.edges,
      });
      appendRoutingDecisionTrace(trace);

      const [read] = readRoutingDecisionTrace(TEST_SESSION);

      // Verify deterministic order persists through serialization
      expect(read.causes[0].skill).toBe("agent-browser-verify");
      expect(read.causes[0].code).toBe("pattern-match");
      expect(read.causes[1].skill).toBe("react-best-practices");
      expect(read.causes[1].code).toBe("dropped-cap");

      expect(read.edges).toHaveLength(1);
      expect(read.edges[0].fromSkill).toBe("agent-browser-verify");
      expect(read.edges[0].toSkill).toBe("verification");

      // Detail keys are sorted
      expect(Object.keys(read.causes[0].detail)).toEqual(["matchType", "pattern"]);
    });
  });
});
