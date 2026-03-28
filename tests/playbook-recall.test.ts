import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEmptyPlaybookRulebook,
  savePlaybookRulebook,
} from "../hooks/src/learned-playbook-rulebook.mts";
import { recallVerifiedPlaybook } from "../hooks/src/playbook-recall.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectWithPlaybook() {
  const projectRoot = mkdtempSync(join(tmpdir(), "vp-playbook-"));
  const rulebook = createEmptyPlaybookRulebook(
    projectRoot,
    "2026-03-28T16:00:00.000Z",
  );
  rulebook.rules.push({
    id: "PreToolUse|flow-verification|clientRequest|Bash|/settings::verification>observability>routing-middleware",
    scenario: "PreToolUse|flow-verification|clientRequest|Bash|/settings",
    hook: "PreToolUse",
    storyKind: "flow-verification",
    targetBoundary: "clientRequest",
    toolName: "Bash",
    routeScope: "/settings",
    anchorSkill: "verification",
    orderedSkills: ["verification", "observability", "routing-middleware"],
    support: 5,
    wins: 4,
    directiveWins: 1,
    staleMisses: 0,
    precision: 0.8,
    baselinePrecisionWithoutPlaybook: 0.4,
    liftVsAnchorBaseline: 2,
    staleMissDelta: -0.2,
    confidence: "promote",
    promotedAt: "2026-03-28T16:00:00.000Z",
    reason:
      "verified ordered playbook beats same anchor without this exact sequence",
    sourceExposureGroupIds: ["g1", "g2", "g3", "g4", "g5"],
  });
  savePlaybookRulebook(projectRoot, rulebook);
  return projectRoot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recallVerifiedPlaybook", () => {
  test("inserts missing ordered steps after the anchor skill", () => {
    const projectRoot = makeProjectWithPlaybook();

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      candidateSkills: ["verification", "nextjs"],
      excludeSkills: new Set(["verification"]),
      maxInsertedSkills: 2,
    });

    expect(result.selected).not.toBeNull();
    expect(result.selected?.anchorSkill).toBe("verification");
    expect(result.selected?.insertedSkills).toEqual([
      "observability",
      "routing-middleware",
    ]);
    expect(result.banner).toContain("Verified Playbook");
    expect(result.banner).toContain("verification");
    expect(result.banner).toContain("observability");
  });

  test("respects maxInsertedSkills cap", () => {
    const projectRoot = makeProjectWithPlaybook();

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(["verification"]),
      maxInsertedSkills: 1,
    });

    expect(result.selected).not.toBeNull();
    expect(result.selected?.insertedSkills).toHaveLength(1);
    expect(result.selected?.insertedSkills[0]).toBe("observability");
  });

  test("rejects when all playbook steps are excluded", () => {
    const projectRoot = makeProjectWithPlaybook();

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set([
        "verification",
        "observability",
        "routing-middleware",
      ]),
    });

    expect(result.selected).toBeNull();
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("already_present");
  });

  test("returns null when anchor skill is not in candidateSkills", () => {
    const projectRoot = makeProjectWithPlaybook();

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "/settings",
      },
      candidateSkills: ["nextjs", "react"],
    });

    expect(result.selected).toBeNull();
  });

  test("returns null when rulebook does not exist", () => {
    const result = recallVerifiedPlaybook({
      projectRoot: "/nonexistent/path",
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow",
        targetBoundary: "clientRequest",
        toolName: "Bash",
      },
      candidateSkills: ["verification"],
    });

    expect(result.selected).toBeNull();
    expect(result.banner).toBeNull();
  });

  test("scenario mismatch returns null", () => {
    const projectRoot = makeProjectWithPlaybook();

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "different-story",
        targetBoundary: "environment",
        toolName: "Prompt",
      },
      candidateSkills: ["verification"],
    });

    expect(result.selected).toBeNull();
  });

  test("holdout-fail rules are not recalled", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vp-pb-holdout-"));
    const rulebook = createEmptyPlaybookRulebook(projectRoot);
    rulebook.rules.push({
      id: "test::a>b",
      scenario: "PreToolUse|flow|clientRequest|Bash|*",
      hook: "PreToolUse",
      storyKind: "flow",
      targetBoundary: "clientRequest",
      toolName: "Bash",
      routeScope: "*",
      anchorSkill: "a",
      orderedSkills: ["a", "b"],
      support: 2,
      wins: 1,
      directiveWins: 0,
      staleMisses: 1,
      precision: 0.5,
      baselinePrecisionWithoutPlaybook: 0.5,
      liftVsAnchorBaseline: 1,
      staleMissDelta: 0,
      confidence: "holdout-fail",
      promotedAt: null,
      reason: "insufficient support",
      sourceExposureGroupIds: ["g1", "g2"],
    });
    savePlaybookRulebook(projectRoot, rulebook);

    const result = recallVerifiedPlaybook({
      projectRoot,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow",
        targetBoundary: "clientRequest",
        toolName: "Bash",
        routeScope: "*",
      },
      candidateSkills: ["a"],
    });

    expect(result.selected).toBeNull();
  });
});
