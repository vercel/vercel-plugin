import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  buildBoundaryEvent,
  buildLedgerObservation,
} from "../hooks/src/posttooluse-verification-observe.mts";
import {
  recordObservation,
  recordStory,
  removeLedgerArtifacts,
} from "../hooks/src/verification-ledger.mts";
import { verifyPlanSnapshot } from "../src/commands/verify-plan.ts";
import {
  readRoutingDecisionTrace,
  createDecisionId,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";

describe("posttooluse verification closed loop", () => {
  const sessionId = `verification-loop-${Date.now()}`;

  afterEach(() => {
    removeLedgerArtifacts(sessionId);
  });

  test("buildLedgerObservation maps boundary event to observation shape", () => {
    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "verif-shape-1",
      timestamp: "2026-03-27T03:17:44.104Z",
    });

    const obs = buildLedgerObservation(event);
    expect(obs.id).toBe("verif-shape-1");
    expect(obs.source).toBe("bash");
    expect(obs.boundary).toBe("clientRequest");
    expect(obs.route).toBe("/settings");
    expect(obs.meta?.matchedPattern).toBe("http-client");
    expect(obs.meta?.matchedSuggestedAction).toBe(false);
  });

  test("buildLedgerObservation nullifies unknown boundary", () => {
    const event = buildBoundaryEvent({
      command: "ls",
      boundary: "unknown",
      matchedPattern: "none",
      inferredRoute: null,
      verificationId: "verif-unknown-1",
    });

    const obs = buildLedgerObservation(event);
    expect(obs.boundary).toBeNull();
  });

  test("records directive adherence and advances the plan", () => {
    recordStory(sessionId, "flow-verification", "/settings", "save fails", []);

    const event = buildBoundaryEvent({
      command: "curl http://localhost:3000/settings",
      boundary: "clientRequest",
      matchedPattern: "http-client",
      inferredRoute: "/settings",
      verificationId: "verif-1",
      timestamp: "2026-03-27T03:17:44.104Z",
      env: {
        ...process.env,
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "clientRequest",
        VERCEL_PLUGIN_VERIFICATION_ACTION:
          "curl http://localhost:3000/settings",
      },
    });

    expect(event.matchedSuggestedAction).toBe(true);

    const plan = recordObservation(
      sessionId,
      buildLedgerObservation(event),
      {
        lastAttemptedAction: "curl http://localhost:3000/settings",
      },
    );

    expect(Array.from(plan.satisfiedBoundaries)).toContain("clientRequest");

    const snapshot = verifyPlanSnapshot({ sessionId });
    expect(snapshot.observationCount).toBe(1);
    expect(snapshot.lastObservation?.matchedSuggestedAction).toBe(true);
    expect(snapshot.lastObservation?.route).toBe("/settings");
    expect(snapshot.primaryNextAction?.targetBoundary).toBe("serverHandler");
  });

  test("records divergence when the observed action does not match the suggestion", () => {
    recordStory(sessionId, "flow-verification", "/settings", "save fails", []);

    const event = buildBoundaryEvent({
      command: "printenv",
      boundary: "environment",
      matchedPattern: "env-read",
      inferredRoute: "/settings",
      verificationId: "verif-2",
      timestamp: "2026-03-27T03:17:45.104Z",
      env: {
        ...process.env,
        VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "clientRequest",
        VERCEL_PLUGIN_VERIFICATION_ACTION:
          "curl http://localhost:3000/settings",
      },
    });

    expect(event.matchedSuggestedAction).toBe(false);

    recordObservation(
      sessionId,
      buildLedgerObservation(event),
      {
        lastAttemptedAction: "curl http://localhost:3000/settings",
      },
    );

    const snapshot = verifyPlanSnapshot({ sessionId });
    expect(snapshot.lastObservation?.matchedSuggestedAction).toBe(false);
    expect(snapshot.lastObservation?.boundary).toBe("environment");
  });

  test("snapshot with no session returns empty with null lastObservation", () => {
    const snapshot = verifyPlanSnapshot({
      sessionId: "nonexistent-session-" + Date.now(),
    });
    expect(snapshot.hasStories).toBe(false);
    expect(snapshot.lastObservation).toBeNull();
    expect(snapshot.observationCount).toBe(0);
  });

  describe("PostToolUse trace emission via run()", () => {
    const traceSessionId = `trace-observe-${Date.now()}`;

    afterEach(() => {
      removeLedgerArtifacts(traceSessionId);
      try { rmSync(traceDir(traceSessionId), { recursive: true, force: true }); } catch {}
    });

    test("run() emits a PostToolUse trace with verification correlation", async () => {
      const { run } = await import("../hooks/src/posttooluse-verification-observe.mts");

      recordStory(traceSessionId, "flow-verification", "/settings", "test trace emit", []);

      const input = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "curl http://localhost:3000/settings" },
        session_id: traceSessionId,
      });

      run(input);

      const traces = readRoutingDecisionTrace(traceSessionId);
      expect(traces.length).toBeGreaterThanOrEqual(1);

      const trace = traces.find((t) => t.hook === "PostToolUse");
      expect(trace).toBeDefined();
      expect(trace!.toolName).toBe("Bash");
      expect(trace!.verification).not.toBeNull();
      expect(trace!.verification!.verificationId).toBeTruthy();
      expect(trace!.verification!.observedBoundary).toBe("clientRequest");
    });

    test("createDecisionId is deterministic for same inputs", () => {
      const input = {
        hook: "PostToolUse" as const,
        sessionId: "sess-1",
        toolName: "Bash",
        toolTarget: "curl http://localhost:3000",
        timestamp: "2026-03-27T04:00:00.000Z",
      };
      const id1 = createDecisionId(input);
      const id2 = createDecisionId(input);
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(16);
    });
  });
});
