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
