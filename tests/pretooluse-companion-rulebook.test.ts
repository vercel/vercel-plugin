import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  companionRulebookPath,
  saveCompanionRulebook,
  createEmptyCompanionRulebook,
  type LearnedCompanionRule,
  type LearnedCompanionRulebook,
} from "../hooks/src/learned-companion-rulebook.mts";
import {
  recallVerifiedCompanions,
  type CompanionRecallResult,
} from "../hooks/src/companion-recall.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-28T08:00:00.000Z";
const PROJECT = `/tmp/test-companion-pretool-${randomUUID()}`;
const SCENARIO = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";

function makeRule(
  overrides: Partial<LearnedCompanionRule> = {},
): LearnedCompanionRule {
  return {
    id: `${SCENARIO}::verification->agent-browser-verify`,
    scenario: SCENARIO,
    hook: "PreToolUse",
    storyKind: "flow-verification",
    targetBoundary: "uiRender",
    toolName: "Bash",
    routeScope: "/dashboard",
    candidateSkill: "verification",
    companionSkill: "agent-browser-verify",
    support: 5,
    winsWithCompanion: 4,
    winsWithoutCompanion: 2,
    directiveWinsWithCompanion: 1,
    staleMissesWithCompanion: 0,
    precisionWithCompanion: 0.8,
    baselinePrecisionWithoutCompanion: 0.5,
    liftVsCandidateAlone: 1.6,
    staleMissDelta: 0,
    confidence: "promote",
    promotedAt: T0,
    reason: "companion beats candidate-alone within same verified scenario",
    sourceExposureGroupIds: ["g-1", "g-2", "g-3", "g-4", "g-5"],
    ...overrides,
  };
}

function makeRulebook(
  rules: LearnedCompanionRule[] = [makeRule()],
): LearnedCompanionRulebook {
  return {
    version: 1,
    generatedAt: T0,
    projectRoot: PROJECT,
    rules,
    replay: { baselineWins: 0, learnedWins: 0, deltaWins: 0, regressions: [] },
    promotion: {
      accepted: true,
      errorCode: null,
      reason: `${rules.filter((r) => r.confidence === "promote").length} promoted companion rules`,
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Ensure the project directory exists for path hashing
  mkdirSync(PROJECT, { recursive: true });
});

afterEach(() => {
  // Clean up rulebook file
  const path = companionRulebookPath(PROJECT);
  try { rmSync(path); } catch {}
  try { rmSync(PROJECT, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PreToolUse companion recall", () => {
  test("recalls promoted companion after its candidate", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].candidateSkill).toBe("verification");
    expect(result.selected[0].companionSkill).toBe("agent-browser-verify");
    expect(result.selected[0].confidence).toBe(1.6);
    expect(result.rejected).toHaveLength(0);
  });

  test("rejects companion when it is in excludeSkills", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(["agent-browser-verify"]),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectedReason).toBe("excluded");
  });

  test("no-ops when rulebook artifact is missing", () => {
    // Don't write any rulebook — file does not exist
    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    // Empty rulebook returns no candidates
    expect(result.selected).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  test("no-ops when rulebook is invalid JSON", () => {
    const path = companionRulebookPath(PROJECT);
    writeFileSync(path, "not-json{{{");

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
  });

  test("skips holdout-fail rules", () => {
    const rulebook = makeRulebook([
      makeRule({ confidence: "holdout-fail", promotedAt: null }),
    ]);
    saveCompanionRulebook(PROJECT, rulebook);

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
  });

  test("respects maxCompanions cap", () => {
    const rules = [
      makeRule({ companionSkill: "companion-a", id: `${SCENARIO}::verification->companion-a` }),
      makeRule({ companionSkill: "companion-b", id: `${SCENARIO}::verification->companion-b` }),
    ];
    saveCompanionRulebook(PROJECT, makeRulebook(rules));

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(1);
  });

  test("selects companion with highest lift first", () => {
    const rules = [
      makeRule({
        companionSkill: "low-lift",
        liftVsCandidateAlone: 1.3,
        id: `${SCENARIO}::verification->low-lift`,
      }),
      makeRule({
        companionSkill: "high-lift",
        liftVsCandidateAlone: 2.0,
        id: `${SCENARIO}::verification->high-lift`,
      }),
    ];
    saveCompanionRulebook(PROJECT, makeRulebook(rules));

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 2,
    });

    expect(result.selected).toHaveLength(2);
    expect(result.selected[0].companionSkill).toBe("high-lift");
    expect(result.selected[1].companionSkill).toBe("low-lift");
  });

  test("records trigger and reasonCode for recalled companions", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected[0].reason).toBe(
      "companion beats candidate-alone within same verified scenario",
    );
  });

  test("does not match when candidate skill is not in candidateSkills list", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/dashboard",
      },
      candidateSkills: ["some-other-skill"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
  });

  test("falls back to wildcard scenario when exact route does not match", () => {
    const wildcardScenario = "PreToolUse|flow-verification|uiRender|Bash|*";
    const rulebook = makeRulebook([
      makeRule({
        scenario: wildcardScenario,
        routeScope: "*",
        id: `${wildcardScenario}::verification->agent-browser-verify`,
      }),
    ]);
    saveCompanionRulebook(PROJECT, rulebook);

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "PreToolUse",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Bash",
        routeScope: "/some-other-route",
      },
      candidateSkills: ["verification"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].companionSkill).toBe("agent-browser-verify");
  });
});
