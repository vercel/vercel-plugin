/**
 * Prompt analysis report module.
 *
 * Provides a structured report of prompt-signal evaluation for debugging,
 * dry-run CLI, and agentic workflows. Reuses matching logic from
 * prompt-patterns.mts — no logic duplication.
 */

import { normalizePromptText, compilePromptSignals, matchPromptWithReason, scorePromptWithLexical } from "./prompt-patterns.mjs";
import type { CompiledPromptSignals, PromptMatchResult } from "./prompt-patterns.mjs";
import { searchSkills } from "./lexical-index.mjs";
import { parseSeenSkills } from "./patterns.mjs";
import type { SkillConfig, PromptSignals } from "./skill-map-frontmatter.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerSkillResult {
  score: number;
  reason: string;
  matched: boolean;
  suppressed: boolean;
}

export interface PromptAnalysisReport {
  normalizedPrompt: string;
  perSkillResults: Record<string, PerSkillResult>;
  selectedSkills: string[];
  droppedByCap: string[];
  droppedByBudget: string[];
  dedupState: {
    strategy: "env-var" | "memory-only" | "disabled";
    seenSkills: string[];
    filteredByDedup: string[];
  };
  budgetBytes: number;
  timingMs: number;
}

// ---------------------------------------------------------------------------
// analyzePrompt
// ---------------------------------------------------------------------------

export interface AnalyzePromptOptions {
  /** When true, use lexical index as primary recall stage. Default false. */
  lexicalEnabled?: boolean;
  /**
   * Likely skills inferred from the session profiler.
   * When omitted, falls back to VERCEL_PLUGIN_LIKELY_SKILLS.
   */
  likelySkills?: Iterable<string>;
}

function parseLikelySkillsEnv(envValue = process.env.VERCEL_PLUGIN_LIKELY_SKILLS): Set<string> {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }

  return new Set(
    envValue
      .split(",")
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0),
  );
}

/**
 * Analyze a prompt against a skill map and return a structured report.
 *
 * This is a pure analysis function — it does not perform injection, does not
 * read stdin, and does not write to stdout. It reuses normalizePromptText,
 * compilePromptSignals, and matchPromptWithReason from prompt-patterns.mts.
 *
 * When lexicalEnabled is true, uses scorePromptWithLexical() to boost weak
 * exact matches. Lexical-only recall is reserved for profiler-confirmed
 * skills, which keeps generic prompts from surfacing unrelated skills.
 * noneOf hard suppression is preserved regardless.
 */
export function analyzePrompt(
  prompt: string,
  skillMap: Record<string, SkillConfig>,
  seenSkills: string,
  budgetBytes: number,
  maxSkills: number,
  options?: AnalyzePromptOptions,
): PromptAnalysisReport {
  const t0 = performance.now();
  const lexicalEnabled = options?.lexicalEnabled ?? false;
  const likelySkills = options?.likelySkills
    ? new Set(
      [...options.likelySkills]
        .map((skill) => String(skill).trim())
        .filter((skill) => skill.length > 0),
    )
    : parseLikelySkillsEnv();

  const normalizedPrompt = normalizePromptText(prompt);

  // Determine dedup strategy
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const hasEnvVar = typeof seenSkills === "string";
  const strategy: PromptAnalysisReport["dedupState"]["strategy"] = dedupOff
    ? "disabled"
    : hasEnvVar
      ? "env-var"
      : "memory-only";
  const seenSet = dedupOff ? new Set<string>() : parseSeenSkills(seenSkills);

  // Pre-compute lexical hits once for all skills (when lexical is enabled)
  const lexicalHits = lexicalEnabled ? searchSkills(prompt) : [];
  // Build a lookup for fast per-skill lexical score access
  const lexicalScoreMap = new Map(lexicalHits.map((h) => [h.skill, h.score]));

  // Max additional points a lexical hit can contribute beyond the exact score.
  // Bounded to prevent raw MiniSearch scores (which can be 1000+) from
  // dominating the prompt-signal scoring range (0–20).
  const LEXICAL_BOOST_CAP = 4;
  // Higher cap for skills with curated retrieval metadata — trusted for
  // primary recall so lexical alone can reach the default minScore of 6.
  const RETRIEVAL_LEXICAL_BOOST_CAP = 8;
  // Only the top-K lexical hits qualify for lexical-only recall (exact=0).
  // Even then, the repo profiler must have already marked the skill as likely.
  const RETRIEVAL_TOP_K = 5;
  const topKLexicalSkills = new Set(
    lexicalHits.slice(0, RETRIEVAL_TOP_K).map((h) => h.skill),
  );

  // Evaluate skills
  const perSkillResults: Record<string, PerSkillResult> = {};
  const matched: Array<{ skill: string; score: number; priority: number }> = [];

  for (const [skill, config] of Object.entries(skillMap)) {
    const hasPromptSignals = !!config.promptSignals;
    // Prompt-time matching must remain anchored to explicit promptSignals.
    // Retrieval metadata is used only as a lexical boost, not as a primary
    // recall path for prompt suggestions.
    if (!hasPromptSignals) continue;

    const compiled = hasPromptSignals
      ? compilePromptSignals(config.promptSignals!)
      : undefined;

    if (lexicalEnabled) {
      // --- Two-stage lexical path ---
      // Stage 1: exact matching (always primary for skills with promptSignals)
      const exactResult = compiled
        ? matchPromptWithReason(normalizedPrompt, compiled)
        : { matched: false, score: 0, reason: "no promptSignals" };

      // noneOf hard suppression — always respected regardless of lexical score
      if (exactResult.score === -Infinity) {
        perSkillResults[skill] = {
          score: -Infinity,
          reason: exactResult.reason,
          matched: false,
          suppressed: true,
        };
        continue;
      }

      const minScore = compiled?.minScore ?? 6;
      const rawLexical = lexicalScoreMap.get(skill) ?? 0;

      if (exactResult.matched) {
        // Exact match succeeded — use it directly (preserves existing behavior)
        perSkillResults[skill] = {
          score: exactResult.score,
          reason: exactResult.reason,
          matched: true,
          suppressed: false,
        };
        matched.push({ skill, score: exactResult.score, priority: config.priority });
      } else {
        const allowLexicalOnlyRecall = (
          exactResult.score <= 0
          && rawLexical > 0
          && topKLexicalSkills.has(skill)
          && likelySkills.has(skill)
        );

        if (!(rawLexical > 0 && (exactResult.score > 0 || allowLexicalOnlyRecall))) {
          // No lexical hit we trust enough — record sub-threshold result
          perSkillResults[skill] = {
            score: exactResult.score,
            reason: exactResult.reason,
            matched: false,
            suppressed: false,
          };
          continue;
        }

        // Stage 2: exact didn't reach threshold but lexical index has a hit.
        // Lexical can always boost a weak exact match.
        // Lexical-only recall is much stricter: only top-ranked hits for
        // profiler-confirmed skills are allowed to cross the threshold.
        const lexResult = scorePromptWithLexical(prompt, skill, compiled, lexicalHits);
        // Cap effective score: exact score + bounded lexical boost.
        // Lexical-only recall gets a higher cap, but only after the profiler
        // has already established stack evidence for the skill.
        const isRetrievalRecall = allowLexicalOnlyRecall;
        const boostCap = isRetrievalRecall ? RETRIEVAL_LEXICAL_BOOST_CAP : LEXICAL_BOOST_CAP;
        const lexicalBoost = Math.min(
          Math.max(lexResult.score - exactResult.score, 0),
          boostCap,
        );
        const effectiveScore = exactResult.score + lexicalBoost;
        const isMatched = effectiveScore >= minScore;

        // Build reason
        const parts: string[] = [];
        if (exactResult.score > 0) parts.push(exactResult.reason);
        parts.push(
          `lexical ${isMatched ? "recall" : "boost"} (raw ${rawLexical.toFixed(1)}, capped +${lexicalBoost.toFixed(1)}, source: ${lexResult.source})`,
        );
        const reason = parts.join("; ");

        perSkillResults[skill] = {
          score: effectiveScore,
          reason,
          matched: isMatched,
          suppressed: false,
        };

        if (isMatched) {
          matched.push({ skill, score: effectiveScore, priority: config.priority });
        }
      }
    } else {
      // --- Existing exact-only path ---
      const result = matchPromptWithReason(normalizedPrompt, compiled!);

      perSkillResults[skill] = {
        score: result.score,
        reason: result.reason,
        matched: result.matched,
        suppressed: result.score === -Infinity,
      };

      if (result.matched) {
        matched.push({ skill, score: result.score, priority: config.priority });
      }
    }
  }

  // Sort by score DESC, priority DESC, skill ASC (same as matchPromptSignals)
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.skill.localeCompare(b.skill);
  });

  // Filter deduped skills
  const filteredByDedup: string[] = [];
  const afterDedup = matched.filter((m) => {
    if (!dedupOff && seenSet.has(m.skill)) {
      filteredByDedup.push(m.skill);
      return false;
    }
    return true;
  });

  // Apply max-skills cap
  const selected = afterDedup.slice(0, maxSkills);
  const droppedByCap = afterDedup.slice(maxSkills).map((m) => m.skill);

  // Simulate budget enforcement — estimate body sizes from skillMap summaries
  // Real budget enforcement happens during injection (reads SKILL.md files),
  // but for analysis we track what would be selected pre-budget.
  const selectedSkills = selected.map((m) => m.skill);
  const droppedByBudget: string[] = [];

  // Budget simulation: use summary length as proxy (real injection reads files)
  let usedBytes = 0;
  const finalSelected: string[] = [];
  for (const skill of selectedSkills) {
    const config = skillMap[skill];
    // Estimate: summary is typically a small fraction of SKILL.md body
    // Use summary length * 10 as rough proxy, minimum 500 bytes
    const estimatedSize = config?.summary ? Math.max(config.summary.length * 10, 500) : 500;
    if (usedBytes + estimatedSize > budgetBytes && finalSelected.length > 0) {
      droppedByBudget.push(skill);
    } else {
      usedBytes += estimatedSize;
      finalSelected.push(skill);
    }
  }

  const timingMs = Math.round(performance.now() - t0);

  return {
    normalizedPrompt,
    perSkillResults,
    selectedSkills: finalSelected,
    droppedByCap,
    droppedByBudget,
    dedupState: {
      strategy,
      seenSkills: [...seenSet],
      filteredByDedup,
    },
    budgetBytes,
    timingMs,
  };
}
