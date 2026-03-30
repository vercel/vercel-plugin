import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  companionRulebookPath,
  saveCompanionRulebook,
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
const PROJECT = `/tmp/test-companion-prompt-${randomUUID()}`;
const SCENARIO = "UserPromptSubmit|flow-verification|uiRender|Prompt|*";

function makeRule(
  overrides: Partial<LearnedCompanionRule> = {},
): LearnedCompanionRule {
  return {
    id: `${SCENARIO}::ai-sdk->ai-elements`,
    scenario: SCENARIO,
    hook: "UserPromptSubmit",
    storyKind: "flow-verification",
    targetBoundary: "uiRender",
    toolName: "Prompt",
    routeScope: "*",
    candidateSkill: "ai-sdk",
    companionSkill: "ai-elements",
    support: 6,
    winsWithCompanion: 5,
    winsWithoutCompanion: 2,
    directiveWinsWithCompanion: 2,
    staleMissesWithCompanion: 0,
    precisionWithCompanion: 0.8333,
    baselinePrecisionWithoutCompanion: 0.5,
    liftVsCandidateAlone: 1.6667,
    staleMissDelta: 0,
    confidence: "promote",
    promotedAt: T0,
    reason: "companion beats candidate-alone within same verified scenario",
    sourceExposureGroupIds: ["g-1", "g-2", "g-3", "g-4", "g-5", "g-6"],
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
  mkdirSync(PROJECT, { recursive: true });
});

afterEach(() => {
  const path = companionRulebookPath(PROJECT);
  try { rmSync(path); } catch {}
  try { rmSync(PROJECT, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserPromptSubmit companion recall", () => {
  test("recalls promoted companion for UserPromptSubmit hook", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].candidateSkill).toBe("ai-sdk");
    expect(result.selected[0].companionSkill).toBe("ai-elements");
    expect(result.selected[0].confidence).toBeCloseTo(1.6667, 3);
  });

  test("rejects when companion is in excludeSkills", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(["ai-elements"]),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectedReason).toBe("excluded");
  });

  test("no-ops when no promoted rules exist", () => {
    const rulebook = makeRulebook([
      makeRule({ confidence: "holdout-fail", promotedAt: null }),
    ]);
    saveCompanionRulebook(PROJECT, rulebook);

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
  });

  test("no-ops when rulebook is missing", () => {
    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
  });

  test("symmetric behavior: trigger and reasonCode match PreToolUse contract", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    // The caller is responsible for setting trigger/reasonCode, but the
    // recall module returns the reason from the rule for traceability
    expect(result.selected[0].reason).toBe(
      "companion beats candidate-alone within same verified scenario",
    );
    expect(result.selected[0].scenario).toBe(SCENARIO);
  });

  test("does not duplicate companion already in candidateSkills", () => {
    saveCompanionRulebook(PROJECT, makeRulebook());

    // Companion is already a candidate — should be in excludeSkills
    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: null,
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(["ai-sdk", "ai-elements"]),
      maxCompanions: 1,
    });

    expect(result.selected).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  test("checks multiple scenario candidates in fallback order", () => {
    // Rule is for wildcard scenario — should match via fallback
    saveCompanionRulebook(PROJECT, makeRulebook());

    const result = recallVerifiedCompanions({
      projectRoot: PROJECT,
      scenario: {
        hook: "UserPromptSubmit",
        storyKind: "flow-verification",
        targetBoundary: "uiRender",
        toolName: "Prompt",
        routeScope: "/specific-route",
      },
      candidateSkills: ["ai-sdk"],
      excludeSkills: new Set(),
      maxCompanions: 1,
    });

    // Wildcard rule matches via fallback
    expect(result.selected).toHaveLength(1);
    expect(result.checkedScenarios.length).toBeGreaterThanOrEqual(2);
  });
});
