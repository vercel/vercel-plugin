import { describe, expect, test } from "bun:test";
import { resolvePromptVerificationBinding } from "../hooks/src/prompt-verification-binding.mjs";

describe("resolvePromptVerificationBinding", () => {
  test("binds to active plan next action boundary", () => {
    const binding = resolvePromptVerificationBinding({
      plan: {
        hasStories: true,
        activeStoryId: "story-1",
        stories: [
          {
            id: "story-1",
            kind: "flow-verification",
            route: "/settings",
            promptExcerpt: "save fails",
            createdAt: "2026-03-28T00:00:00.000Z",
            updatedAt: "2026-03-28T00:00:00.000Z",
          },
        ],
        storyStates: [],
        observationCount: 1,
        satisfiedBoundaries: ["clientRequest"],
        missingBoundaries: ["environment", "serverHandler", "uiRender"],
        recentRoutes: ["/settings"],
        primaryNextAction: {
          action: "tail server logs /settings",
          targetBoundary: "serverHandler",
          reason: "No server-side observation yet",
        },
        blockedReasons: [],
      },
    });

    expect(binding).toEqual({
      targetBoundary: "serverHandler",
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/settings",
      source: "active-plan",
      confidence: 1,
      reason: "active verification plan predicted serverHandler",
    });
  });

  test("returns no binding when there is no next boundary", () => {
    const binding = resolvePromptVerificationBinding({
      plan: {
        hasStories: true,
        activeStoryId: "story-1",
        stories: [
          {
            id: "story-1",
            kind: "flow-verification",
            route: "/settings",
            promptExcerpt: "save fails",
            createdAt: "2026-03-28T00:00:00.000Z",
            updatedAt: "2026-03-28T00:00:00.000Z",
          },
        ],
        storyStates: [],
        observationCount: 4,
        satisfiedBoundaries: [
          "clientRequest",
          "environment",
          "serverHandler",
          "uiRender",
        ],
        missingBoundaries: [],
        recentRoutes: ["/settings"],
        primaryNextAction: null,
        blockedReasons: [],
      },
    });

    expect(binding.targetBoundary).toBeNull();
    expect(binding.source).toBe("none");
    expect(binding.storyId).toBe("story-1");
    expect(binding.reason).toBe(
      "active verification story exists but no primary next boundary is available",
    );
  });

  test("returns no binding when plan is null", () => {
    const binding = resolvePromptVerificationBinding({ plan: null });

    expect(binding.targetBoundary).toBeNull();
    expect(binding.source).toBe("none");
    expect(binding.storyId).toBeNull();
    expect(binding.confidence).toBe(0);
    expect(binding.reason).toBe("no active verification story");
  });

  test("returns no binding when plan has no stories", () => {
    const binding = resolvePromptVerificationBinding({
      plan: {
        hasStories: false,
        activeStoryId: null,
        stories: [],
        storyStates: [],
        observationCount: 0,
        satisfiedBoundaries: [],
        missingBoundaries: [],
        recentRoutes: [],
        primaryNextAction: null,
        blockedReasons: [],
      },
    });

    expect(binding.targetBoundary).toBeNull();
    expect(binding.source).toBe("none");
    expect(binding.storyId).toBeNull();
    expect(binding.reason).toBe("no active verification story");
  });
});
