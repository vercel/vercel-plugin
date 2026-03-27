import { afterEach, describe, expect, test } from "bun:test";
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
});
