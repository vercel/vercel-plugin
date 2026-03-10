/**
 * Prompt signal matching engine for UserPromptSubmit hook.
 *
 * Scores user prompts against skill promptSignals frontmatter to determine
 * which skills to inject proactively before tool use.
 *
 * Scoring:
 *   - phrases:  +6 per phrase hit (exact substring, case-insensitive)
 *   - allOf:    +4 per conjunction group where ALL terms match
 *   - anyOf:    +1 per term hit, capped at +2
 *   - noneOf:   hard suppress (score → -Infinity, matched = false)
 *
 * Threshold: score >= minScore (default 6). No phrase hit required —
 * allOf/anyOf alone can reach the threshold.
 *
 * Contractions are expanded before matching (it's → it is, don't → do not)
 * so phrase/term authors don't need to account for both forms.
 */

import { searchSkills } from "./lexical-index.mjs";
import type { PromptSignals } from "./skill-map-frontmatter.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptMatchResult {
  matched: boolean;
  score: number;
  reason: string;
}

export interface CompiledPromptSignals {
  phrases: string[];
  allOf: string[][];
  anyOf: string[];
  noneOf: string[];
  minScore: number;
}

type LexicalHit = { skill: string; score: number };

export type BoostTier = "high" | "mid" | "low" | null;

// ---------------------------------------------------------------------------
// Contraction expansion
// ---------------------------------------------------------------------------

const CONTRACTIONS: Record<string, string> = {
  "it's": "it is",
  "what's": "what is",
  "where's": "where is",
  "that's": "that is",
  "there's": "there is",
  "who's": "who is",
  "how's": "how is",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "doesn't": "does not",
  "don't": "do not",
  "didn't": "did not",
  "won't": "will not",
  "can't": "cannot",
  "couldn't": "could not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "hasn't": "has not",
  "haven't": "have not",
};

const CONTRACTION_ENTRIES = Object.entries(CONTRACTIONS);

/**
 * Expand common English contractions and normalize smart quotes.
 * Applied to both prompt text and compiled signal terms so both sides match.
 */
function expandContractions(text: string): string {
  // Normalize curly/smart apostrophes to straight
  let t = text.replace(/[\u2018\u2019\u2032]/g, "'");
  for (const [contraction, expansion] of CONTRACTION_ENTRIES) {
    if (t.includes(contraction)) {
      t = t.replaceAll(contraction, expansion);
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// normalizePromptText
// ---------------------------------------------------------------------------

/**
 * Normalize user prompt text for matching:
 * - lowercase
 * - expand contractions (it's → it is)
 * - collapse whitespace to single spaces
 * - trim
 */
export function normalizePromptText(text: string): string {
  if (typeof text !== "string") return "";
  let t = text.toLowerCase();
  t = expandContractions(t);
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// compilePromptSignals
// ---------------------------------------------------------------------------

/**
 * Compile a PromptSignals object into a form ready for matching.
 * Currently this is a pass-through that ensures defaults, but provides
 * an extension point for future pre-compilation (e.g., regex caching).
 */
export function compilePromptSignals(
  signals: PromptSignals,
): CompiledPromptSignals {
  const norm = (s: string) => expandContractions(s.toLowerCase());
  return {
    phrases: (signals.phrases || []).map(norm),
    allOf: (signals.allOf || []).map((group) => group.map(norm)),
    anyOf: (signals.anyOf || []).map(norm),
    noneOf: (signals.noneOf || []).map(norm),
    minScore:
      typeof signals.minScore === "number" && !Number.isNaN(signals.minScore)
        ? signals.minScore
        : 6,
  };
}

// ---------------------------------------------------------------------------
// matchPromptWithReason
// ---------------------------------------------------------------------------

/**
 * Score a normalized prompt against compiled prompt signals.
 *
 * Returns { matched, score, reason } where:
 * - matched: true if score >= minScore (phrase hit NOT required)
 * - score: weighted sum of signal matches
 * - reason: human-readable explanation of why/why not
 */
export function matchPromptWithReason(
  normalizedPrompt: string,
  compiled: CompiledPromptSignals,
): PromptMatchResult {
  if (!normalizedPrompt) {
    return { matched: false, score: 0, reason: "empty prompt" };
  }

  // --- noneOf: hard suppress (word-boundary aware) ---
  for (const term of compiled.noneOf) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\b|\\s)${escaped}(?:\\b|\\s|$)`);
    if (re.test(normalizedPrompt)) {
      return {
        matched: false,
        score: -Infinity,
        reason: `suppressed by noneOf "${term}"`,
      };
    }
  }

  let score = 0;
  const reasons: string[] = [];

  // --- phrases: +6 each ---
  for (const phrase of compiled.phrases) {
    if (normalizedPrompt.includes(phrase)) {
      score += 6;
      reasons.push(`phrase "${phrase}" +6`);
    }
  }

  // --- allOf: +4 per fully-matching group ---
  for (const group of compiled.allOf) {
    const allMatch = group.every((term) => normalizedPrompt.includes(term));
    if (allMatch) {
      score += 4;
      reasons.push(`allOf [${group.join(", ")}] +4`);
    }
  }

  // --- anyOf: +1 each, capped at +2 ---
  let anyOfScore = 0;
  for (const term of compiled.anyOf) {
    if (normalizedPrompt.includes(term)) {
      anyOfScore += 1;
      if (anyOfScore <= 2) {
        reasons.push(`anyOf "${term}" +1`);
      }
    }
  }
  const cappedAnyOf = Math.min(anyOfScore, 2);
  score += cappedAnyOf;

  // --- threshold check ---
  const matched = score >= compiled.minScore;

  if (!matched) {
    const detail = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
    return {
      matched: false,
      score,
      reason: `below threshold: score ${score} < ${compiled.minScore}${detail}`,
    };
  }

  return {
    matched: true,
    score,
    reason: reasons.join("; "),
  };
}

// ---------------------------------------------------------------------------
// scorePromptWithLexical
// ---------------------------------------------------------------------------

function findMatchedPhrases(
  normalizedPrompt: string,
  compiled: CompiledPromptSignals | undefined,
): string[] {
  if (!compiled) return [];
  return compiled.phrases.filter((phrase) => normalizedPrompt.includes(phrase));
}

/**
 * Determine the adaptive boost multiplier based on exact score relative to minScore.
 *
 * - high (1.5x): exact === 0 — no exact signals matched at all
 * - mid  (1.35x): exact > 0 but < minScore/2 — weak exact signal
 * - low  (1.1x): exact >= minScore/2 but < minScore — near-threshold exact signal
 */
export function adaptiveBoostTier(
  exactScore: number,
  minScore: number,
): { multiplier: number; tier: BoostTier } {
  if (exactScore <= 0) return { multiplier: 1.5, tier: "high" };
  if (exactScore < minScore / 2) return { multiplier: 1.35, tier: "mid" };
  return { multiplier: 1.1, tier: "low" };
}

export function scorePromptWithLexical(
  prompt: string,
  skillSlug: string,
  compiled: CompiledPromptSignals | undefined,
  lexicalHits?: LexicalHit[],
): {
  score: number;
  matchedPhrases: string[];
  lexicalScore: number;
  source: "exact" | "lexical" | "combined";
  boostTier: BoostTier;
} {
  const normalizedPrompt = normalizePromptText(prompt);
  const matchedPhrases = findMatchedPhrases(normalizedPrompt, compiled);
  const exactResult = compiled
    ? matchPromptWithReason(normalizedPrompt, compiled)
    : { score: 0, matched: false };
  const exactScore = exactResult.score;

  if (compiled && exactScore >= compiled.minScore) {
    return {
      score: exactScore,
      matchedPhrases,
      lexicalScore: 0,
      source: "exact",
      boostTier: null,
    };
  }

  // noneOf suppression: if exact score is -Infinity, never boost via lexical
  if (exactScore === -Infinity) {
    return {
      score: -Infinity,
      matchedPhrases: [],
      lexicalScore: 0,
      source: "exact",
      boostTier: null,
    };
  }

  const lexicalHit = (lexicalHits ?? searchSkills(prompt)).find(
    (hit) => hit.skill === skillSlug,
  );
  if (!lexicalHit) {
    return {
      score: exactScore,
      matchedPhrases,
      lexicalScore: 0,
      source: "exact",
      boostTier: null,
    };
  }

  const minScore = compiled?.minScore ?? 6;
  const { multiplier, tier } = adaptiveBoostTier(exactScore, minScore);
  const lexicalBoost = lexicalHit.score * multiplier;
  return {
    score: Math.max(exactScore, lexicalBoost),
    matchedPhrases,
    lexicalScore: lexicalHit.score,
    source:
      lexicalBoost > exactScore
        ? "lexical"
        : matchedPhrases.length > 0 || exactScore > 0
          ? "combined"
          : "lexical",
    boostTier: tier,
  };
}

// ---------------------------------------------------------------------------
// Troubleshooting intent classification
// ---------------------------------------------------------------------------

export type TroubleshootingIntent =
  | "flow-verification"
  | "stuck-investigation"
  | "browser-only"
  | null;

export interface TroubleshootingIntentResult {
  intent: TroubleshootingIntent;
  skills: string[];
  reason: string;
}

const FLOW_VERIFICATION_RE =
  /\b(?:loads?\s+but|submits?\s+but|redirects?\s+but|works?\s+(?:locally\s+)?but|saves?\s+but|sends?\s+but|returns?\s+but|fetches?\s+but|connects?\s+but|renders?\s+but|deploys?\s+but|builds?\s+but)\b/;

const STUCK_INVESTIGATION_RE =
  /\b(?:stuck|hung|frozen|tim(?:ed?|ing)\s*out|timeout|hanging|not\s+responding|no\s+response|spinning\s+forever|still\s+waiting|nothing\s+happened|nothing\s+is\s+happening|just\s+sits?\s+there)\b/;

const BROWSER_ONLY_RE =
  /\b(?:blank\s+page|white\s+screen|screen\s+is\s+(?:blank|white)|console\s+errors?|browser\s+errors?|nothing\s+(?:render(?:s|ed|ing)?|show(?:s|ing|n)?)|page\s+(?:is\s+)?(?:broken|empty)|ui\s+is\s+broken)\b/;

const TEST_FRAMEWORK_RE =
  /\b(?:jest|vitest|playwright\s+test|cypress\s+test|mocha|karma|testing\s+library)\b/;

/**
 * Classify a normalized prompt into a troubleshooting intent bucket.
 *
 * Returns which verification-family skills should be routed to:
 * - flow-verification → ["verification"]
 * - stuck-investigation → ["investigation-mode"]
 * - browser-only → ["agent-browser-verify", "investigation-mode"]
 * - null → no troubleshooting intent detected
 *
 * Test framework mentions suppress all three verification-family skills.
 */
export function classifyTroubleshootingIntent(
  normalizedPrompt: string,
): TroubleshootingIntentResult {
  if (!normalizedPrompt) {
    return { intent: null, skills: [], reason: "empty prompt" };
  }

  // Test framework mentions suppress all verification-family skills
  if (TEST_FRAMEWORK_RE.test(normalizedPrompt)) {
    return {
      intent: null,
      skills: [],
      reason: "suppressed by test framework mention",
    };
  }

  // Check browser-only first (more specific than stuck)
  if (BROWSER_ONLY_RE.test(normalizedPrompt)) {
    return {
      intent: "browser-only",
      skills: ["agent-browser-verify", "investigation-mode"],
      reason: "browser-only pattern matched",
    };
  }

  // Check flow-verification ("X but Y" patterns)
  if (FLOW_VERIFICATION_RE.test(normalizedPrompt)) {
    return {
      intent: "flow-verification",
      skills: ["verification"],
      reason: "flow-verification pattern matched",
    };
  }

  // Check stuck-investigation
  if (STUCK_INVESTIGATION_RE.test(normalizedPrompt)) {
    return {
      intent: "stuck-investigation",
      skills: ["investigation-mode"],
      reason: "stuck-investigation pattern matched",
    };
  }

  return { intent: null, skills: [], reason: "no troubleshooting intent" };
}
