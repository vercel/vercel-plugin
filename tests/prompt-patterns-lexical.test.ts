import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initializeLexicalIndex } from "../hooks/src/lexical-index.mts";
import {
  adaptiveBoostTier,
  compilePromptSignals,
  scorePromptWithLexical,
} from "../hooks/src/prompt-patterns.mts";

describe("scorePromptWithLexical", () => {
  let previousLexicalMinScore: string | undefined;

  beforeEach(() => {
    previousLexicalMinScore = process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    initializeLexicalIndex(new Map());
  });

  afterEach(() => {
    if (previousLexicalMinScore === undefined) {
      delete process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    } else {
      process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE =
        previousLexicalMinScore;
    }
    initializeLexicalIndex(new Map());
  });

  test("test_scorePromptWithLexical_returns_exact_fast_path_when_threshold_met", () => {
    const compiled = compilePromptSignals({
      phrases: ["ai elements"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "Add AI Elements to the chat UI",
      "ai-elements",
      compiled,
      [{ skill: "ai-elements", score: 99 }],
    );

    expect(result).toEqual({
      score: 6,
      matchedPhrases: ["ai elements"],
      lexicalScore: 0,
      source: "exact",
      boostTier: null,
    });
  });

  test("test_scorePromptWithLexical_prefers_provided_lexical_hit_when_exact_is_below_threshold", () => {
    const compiled = compilePromptSignals({
      phrases: ["deploy preview"],
      minScore: 6,
    });

    // exact=0 (no phrase match), so high tier (1.5x)
    const result = scorePromptWithLexical(
      "ship the release",
      "vercel-deploy",
      compiled,
      [{ skill: "vercel-deploy", score: 7 }],
    );

    expect(result.matchedPhrases).toEqual([]);
    expect(result.lexicalScore).toBe(7);
    expect(result.score).toBeCloseTo(10.5, 6); // 7 * 1.5
    expect(result.source).toBe("lexical");
    expect(result.boostTier).toBe("high");
  });

  test("test_scorePromptWithLexical_calls_searchSkills_when_hits_are_omitted", () => {
    process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE = "0";
    initializeLexicalIndex(
      new Map([
        [
          "vercel-deploy",
          {
            retrieval: {
              aliases: ["deploy"],
              intents: ["release"],
              entities: ["deployment"],
              examples: ["ship the release"],
            },
          },
        ],
      ]),
    );

    const compiled = compilePromptSignals({
      phrases: ["deploy preview"],
      minScore: 10,
    });

    // exact=0 (no phrase match), so high tier (1.5x)
    const result = scorePromptWithLexical(
      "ship the release",
      "vercel-deploy",
      compiled,
    );

    expect(result.lexicalScore).toBeGreaterThan(0);
    expect(result.score).toBeCloseTo(result.lexicalScore * 1.5, 6);
    expect(result.source).toBe("lexical");
    expect(result.boostTier).toBe("high");
  });

  test("test_scorePromptWithLexical_marks_combined_when_exact_score_stays_higher", () => {
    const compiled = compilePromptSignals({
      phrases: ["ai elements"],
      minScore: 10,
    });

    // exact=6 (phrase hit), minScore=10, minScore/2=5, exact >= minScore/2 → low tier (1.1x)
    // lexicalBoost = 4 * 1.1 = 4.4, exact=6 wins → combined
    const result = scorePromptWithLexical(
      "add ai elements to the chat",
      "ai-elements",
      compiled,
      [{ skill: "ai-elements", score: 4 }],
    );

    expect(result).toEqual({
      score: 6,
      matchedPhrases: ["ai elements"],
      lexicalScore: 4,
      source: "combined",
      boostTier: "low",
    });
  });
});

// ---------------------------------------------------------------------------
// adaptiveBoostTier unit tests
// ---------------------------------------------------------------------------

describe("adaptiveBoostTier", () => {
  test("high tier when exact is 0", () => {
    const { multiplier, tier } = adaptiveBoostTier(0, 6);
    expect(tier).toBe("high");
    expect(multiplier).toBe(1.5);
  });

  test("high tier when exact is negative (but not -Infinity)", () => {
    // Edge case: exact < 0 should still be high tier
    const { multiplier, tier } = adaptiveBoostTier(-1, 6);
    expect(tier).toBe("high");
    expect(multiplier).toBe(1.5);
  });

  test("mid tier when exact > 0 but < minScore/2", () => {
    // minScore=6, minScore/2=3, exact=2 → mid
    const { multiplier, tier } = adaptiveBoostTier(2, 6);
    expect(tier).toBe("mid");
    expect(multiplier).toBe(1.35);
  });

  test("mid tier at boundary: exact=1, minScore=6", () => {
    const { tier } = adaptiveBoostTier(1, 6);
    expect(tier).toBe("mid");
  });

  test("low tier when exact >= minScore/2 but < minScore", () => {
    // minScore=6, minScore/2=3, exact=3 → low
    const { multiplier, tier } = adaptiveBoostTier(3, 6);
    expect(tier).toBe("low");
    expect(multiplier).toBe(1.1);
  });

  test("low tier at boundary: exact=minScore/2 exactly", () => {
    // minScore=10, minScore/2=5, exact=5 → low
    const { tier } = adaptiveBoostTier(5, 10);
    expect(tier).toBe("low");
  });

  test("low tier just below minScore", () => {
    const { tier } = adaptiveBoostTier(5, 6);
    expect(tier).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Adaptive boost tier integration tests
// ---------------------------------------------------------------------------

describe("scorePromptWithLexical adaptive boost tiers", () => {
  let previousLexicalMinScore: string | undefined;

  beforeEach(() => {
    previousLexicalMinScore = process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    initializeLexicalIndex(new Map());
  });

  afterEach(() => {
    if (previousLexicalMinScore === undefined) {
      delete process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    } else {
      process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE =
        previousLexicalMinScore;
    }
    initializeLexicalIndex(new Map());
  });

  test("high tier (1.5x) when no exact signals match", () => {
    const compiled = compilePromptSignals({
      phrases: ["completely unrelated phrase"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "deploy my app",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 5 }],
    );

    expect(result.boostTier).toBe("high");
    expect(result.score).toBeCloseTo(7.5, 6); // 5 * 1.5
    expect(result.source).toBe("lexical");
  });

  test("mid tier (1.35x) when exact > 0 but < minScore/2", () => {
    // anyOf gives +1 each capped at +2, so exact=2 with minScore=6 → 2 < 3 → mid
    const compiled = compilePromptSignals({
      phrases: ["completely unrelated phrase"],
      anyOf: ["deploy", "app"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "deploy my app",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 5 }],
    );

    expect(result.boostTier).toBe("mid");
    expect(result.score).toBeCloseTo(6.75, 6); // 5 * 1.35
    expect(result.source).toBe("lexical");
  });

  test("low tier (1.1x) when exact >= minScore/2 but < minScore", () => {
    // allOf gives +4, so exact=4 with minScore=6 → 4 >= 3 → low
    const compiled = compilePromptSignals({
      allOf: [["deploy", "app"]],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "deploy my app",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 5 }],
    );

    expect(result.boostTier).toBe("low");
    expect(result.score).toBeCloseTo(5.5, 6); // 5 * 1.1
    expect(result.source).toBe("lexical");
  });

  // --- noneOf suppression at every tier ---

  test("noneOf suppression wins over high-tier lexical boost", () => {
    const compiled = compilePromptSignals({
      phrases: ["unrelated"],
      noneOf: ["forbidden"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "forbidden deploy action",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 100 }],
    );

    expect(result.score).toBe(-Infinity);
    expect(result.boostTier).toBe(null);
  });

  test("noneOf suppression wins over mid-tier lexical boost", () => {
    const compiled = compilePromptSignals({
      anyOf: ["deploy"],
      noneOf: ["forbidden"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "forbidden deploy action",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 100 }],
    );

    expect(result.score).toBe(-Infinity);
    expect(result.boostTier).toBe(null);
  });

  test("noneOf suppression wins over low-tier lexical boost", () => {
    const compiled = compilePromptSignals({
      allOf: [["deploy", "action"]],
      noneOf: ["forbidden"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "forbidden deploy action",
      "deploy-skill",
      compiled,
      [{ skill: "deploy-skill", score: 100 }],
    );

    expect(result.score).toBe(-Infinity);
    expect(result.boostTier).toBe(null);
  });

  test("no boostTier when no lexical hit exists", () => {
    const compiled = compilePromptSignals({
      phrases: ["unrelated"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "deploy my app",
      "deploy-skill",
      compiled,
      [], // no lexical hits
    );

    expect(result.boostTier).toBe(null);
    expect(result.source).toBe("exact");
  });
});
