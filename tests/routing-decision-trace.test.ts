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
});
