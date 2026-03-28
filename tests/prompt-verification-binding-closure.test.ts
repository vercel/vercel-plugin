import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSkillExposure,
  resolveBoundaryOutcome,
  sessionExposurePath,
} from "../hooks/src/routing-policy-ledger.mjs";

describe("prompt verification binding closure", () => {
  test("bound prompt exposure resolves on matching posttool boundary", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vercel-plugin-binding-"));
    const sessionId = `sess-${Date.now()}`;

    appendSkillExposure({
      id: `${sessionId}:prompt:verification:1`,
      sessionId,
      projectRoot,
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/settings",
      hook: "UserPromptSubmit",
      toolName: "Prompt",
      skill: "verification",
      targetBoundary: "serverHandler",
      exposureGroupId: "group-1",
      attributionRole: "candidate",
      candidateSkill: "verification",
      createdAt: "2026-03-28T00:00:00.000Z",
      resolvedAt: null,
      outcome: "pending",
    });

    const resolved = resolveBoundaryOutcome({
      sessionId,
      boundary: "serverHandler",
      matchedSuggestedAction: true,
      storyId: "story-1",
      route: "/settings",
      now: "2026-03-28T00:01:00.000Z",
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.outcome).toBe("directive-win");

    // Cleanup
    try {
      unlinkSync(sessionExposurePath(sessionId));
    } catch {}
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("unbound prompt exposure (null boundary) does not resolve", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vercel-plugin-binding-"));
    const sessionId = `sess-unbound-${Date.now()}`;

    appendSkillExposure({
      id: `${sessionId}:prompt:verification:1`,
      sessionId,
      projectRoot,
      storyId: "story-1",
      storyKind: "flow-verification",
      route: "/settings",
      hook: "UserPromptSubmit",
      toolName: "Prompt",
      skill: "verification",
      targetBoundary: null,
      exposureGroupId: "group-1",
      attributionRole: "candidate",
      candidateSkill: "verification",
      createdAt: "2026-03-28T00:00:00.000Z",
      resolvedAt: null,
      outcome: "pending",
    });

    const resolved = resolveBoundaryOutcome({
      sessionId,
      boundary: "serverHandler",
      matchedSuggestedAction: true,
      storyId: "story-1",
      route: "/settings",
      now: "2026-03-28T00:01:00.000Z",
    });

    // null targetBoundary can never match "serverHandler" — this proves
    // the binding is required for resolution
    expect(resolved).toHaveLength(0);

    // Cleanup
    try {
      unlinkSync(sessionExposurePath(sessionId));
    } catch {}
    rmSync(projectRoot, { recursive: true, force: true });
  });
});
