import { describe, test, expect } from "bun:test";
import {
  buildLedgerObservation,
  resolveObservedRoute,
  type VerificationBoundaryEvent,
} from "../hooks/src/posttooluse-verification-observe.mts";

const EVENT: VerificationBoundaryEvent = {
  event: "verification.boundary_observed",
  boundary: "clientRequest",
  verificationId: "verify-1",
  command: "curl http://localhost:3000/settings",
  matchedPattern: "http-client",
  inferredRoute: "/settings",
  timestamp: "2026-03-28T00:00:00.000Z",
  suggestedBoundary: "clientRequest",
  suggestedAction: "curl http://localhost:3000/settings",
  matchedSuggestedAction: true,
};

describe("verification observer env fallback", () => {
  test("buildLedgerObservation copies storyId from directive env", () => {
    const obs = buildLedgerObservation(EVENT, {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "story-123",
    } as NodeJS.ProcessEnv);
    expect(obs.storyId).toBe("story-123");
    expect(obs.route).toBe("/settings");
    expect(obs.boundary).toBe("clientRequest");
  });

  test("buildLedgerObservation returns null storyId when env is empty", () => {
    const obs = buildLedgerObservation(EVENT, {} as NodeJS.ProcessEnv);
    expect(obs.storyId).toBeNull();
  });

  test("buildLedgerObservation trims whitespace-only storyId to null", () => {
    const obs = buildLedgerObservation(EVENT, {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "   ",
    } as NodeJS.ProcessEnv);
    expect(obs.storyId).toBeNull();
  });

  test("resolveObservedRoute falls back to directive route env", () => {
    const route = resolveObservedRoute(null, {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings",
    } as NodeJS.ProcessEnv);
    expect(route).toBe("/settings");
  });

  test("resolveObservedRoute prefers inferred route", () => {
    const route = resolveObservedRoute("/dashboard", {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "/settings",
    } as NodeJS.ProcessEnv);
    expect(route).toBe("/dashboard");
  });

  test("resolveObservedRoute returns null when both sources are absent", () => {
    const route = resolveObservedRoute(null, {} as NodeJS.ProcessEnv);
    expect(route).toBeNull();
  });

  test("resolveObservedRoute trims directive route", () => {
    const route = resolveObservedRoute(null, {
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "  /api/users  ",
    } as NodeJS.ProcessEnv);
    expect(route).toBe("/api/users");
  });
});
