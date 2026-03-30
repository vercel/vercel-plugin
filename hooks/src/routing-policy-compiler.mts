/**
 * Routing Policy Compiler: pure function that converts a replay report into
 * bounded policy patches against an existing RoutingPolicyFile.
 *
 * Contract:
 * - compilePolicyPatch is a pure function of (existing policy, replay report).
 * - applyPolicyPatch produces a PromotionArtifact without mutating policy stats.
 * - Patch recommendations reuse derivePolicyBoost thresholds — no second scoring system.
 * - Deterministic patch ordering: scenario asc, skill asc.
 * - Covers promote, demote, investigate, and no-op cases.
 * - Routing-policy remains the observational evidence store; promotions live in a separate artifact.
 */

import {
  type RoutingPolicyFile,
  type RoutingPolicyStats,
  derivePolicyBoost,
} from "./routing-policy.mjs";
import type {
  RoutingReplayReport,
  RoutingRecommendation,
} from "./routing-replay.mjs";
import type { ReplayResult } from "./rule-distillation.mjs";
import {
  type LearnedRoutingRulebook,
  type RulebookErrorCode,
  createRule as createRulebookRule,
} from "./learned-routing-rulebook.mjs";
import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatchAction = "promote" | "demote" | "investigate" | "no-op";

export interface PolicyPatchEntry {
  scenario: string;
  skill: string;
  action: PatchAction;
  currentBoost: number;
  proposedBoost: number;
  delta: number;
  confidence: number;
  reason: string;
}

export interface PolicyPatchReport {
  version: 1;
  sessionId: string;
  patchCount: number;
  entries: PolicyPatchEntry[];
}

// ---------------------------------------------------------------------------
// Promotion artifact — separate from the observational policy ledger
// ---------------------------------------------------------------------------

export interface PromotedRule {
  scenario: string;
  skill: string;
  action: "promote" | "demote";
  boost: number;
  confidence: number;
  reason: string;
}

export interface PromotionArtifact {
  version: 1;
  sessionId: string;
  promotedAt: string;
  applied: number;
  rules: PromotedRule[];
}

// ---------------------------------------------------------------------------
// Thresholds — reuses derivePolicyBoost ladder exactly
// ---------------------------------------------------------------------------

/**
 * Compute the boost that derivePolicyBoost *would* produce if we applied
 * the replay recommendation's implied stats. We translate the replay
 * recommendation back through the same bounded ladder.
 */
function boostForAction(rec: RoutingRecommendation): number {
  // These match the thresholds in derivePolicyBoost and routing-replay.mts:
  //   promote (>=80% success, >=3 exposures) → +8
  //   demote  (<15% success, >=5 exposures)  → -2
  //   investigate (40-65%, >=3 exposures)    → 0 (no change)
  switch (rec.action) {
    case "promote":
      return 8;
    case "demote":
      return -2;
    case "investigate":
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Core compiler — pure function, no side effects
// ---------------------------------------------------------------------------

export function compilePolicyPatch(
  policy: RoutingPolicyFile,
  report: RoutingReplayReport,
): PolicyPatchReport {
  const log = createLogger();

  log.summary("policy_compiler_start", {
    sessionId: report.sessionId,
    recommendationCount: report.recommendations.length,
  });

  const entries: PolicyPatchEntry[] = [];

  for (const rec of report.recommendations) {
    const bucket = policy.scenarios[rec.scenario] ?? {};
    const stats: RoutingPolicyStats | undefined = bucket[rec.skill];
    const currentBoost = derivePolicyBoost(stats);
    const proposedBoost = boostForAction(rec);
    const delta = proposedBoost - currentBoost;

    // Only emit a patch entry when the proposed boost differs from current,
    // or when the action is "investigate" (always surface for visibility).
    if (delta !== 0 || rec.action === "investigate") {
      // Preserve the original recommendation action. The replay analyzer
      // already classified it correctly using the same thresholds as
      // derivePolicyBoost. Re-classifying based on delta direction would
      // break investigate entries that have non-zero delta.
      const action: PatchAction =
        rec.action === "investigate"
          ? "investigate"
          : delta > 0
            ? "promote"
            : delta < 0
              ? "demote"
              : "no-op";

      const entry: PolicyPatchEntry = {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta,
        confidence: rec.confidence,
        reason: rec.reason,
      };

      entries.push(entry);

      log.debug("policy_patch_entry", {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta,
      });
    } else {
      log.debug("policy_patch_no_op", {
        scenario: rec.scenario,
        skill: rec.skill,
        currentBoost,
        proposedBoost,
        reason: "boost already aligned",
      });
    }
  }

  // Deterministic ordering: scenario asc, skill asc
  entries.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.skill.localeCompare(b.skill),
  );

  log.summary("policy_compiler_complete", {
    sessionId: report.sessionId,
    patchCount: entries.length,
    promotes: entries.filter((e) => e.action === "promote").length,
    demotes: entries.filter((e) => e.action === "demote").length,
    investigates: entries.filter((e) => e.action === "investigate").length,
    noOps: entries.filter((e) => e.action === "no-op").length,
  });

  return {
    version: 1,
    sessionId: report.sessionId,
    patchCount: entries.length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Apply — produces a PromotionArtifact without mutating the policy ledger
// ---------------------------------------------------------------------------

/**
 * Convert a compiled patch into a PromotionArtifact — a standalone record of
 * promotion decisions that does NOT touch the observational routing-policy stats.
 *
 * The routing-policy ledger remains the evidence store (exposures, wins,
 * directiveWins, staleMisses are never fabricated). Promotion boosts are
 * recorded in the returned artifact and can be inspected, replayed, or
 * applied by a downstream consumer without corrupting ground truth.
 *
 * Pure function: same inputs always produce the same artifact.
 * Idempotent: calling twice with the same patch yields identical output.
 */
export function applyPolicyPatch(
  patch: PolicyPatchReport,
  now?: string,
): PromotionArtifact {
  const log = createLogger();
  const timestamp = now ?? new Date().toISOString();
  const rules: PromotedRule[] = [];

  for (const entry of patch.entries) {
    if (entry.action === "investigate" || entry.action === "no-op") {
      log.debug("policy_apply_skip", {
        scenario: entry.scenario,
        skill: entry.skill,
        action: entry.action,
        reason: "non-actionable",
      });
      continue;
    }

    rules.push({
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action as "promote" | "demote",
      boost: Math.abs(entry.proposedBoost),
      confidence: entry.confidence,
      reason: entry.reason,
    });

    log.summary("policy_apply_entry", {
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      proposedBoost: entry.proposedBoost,
      delta: entry.delta,
    });
  }

  log.summary("policy_apply_complete", {
    sessionId: patch.sessionId,
    applied: rules.length,
    total: patch.entries.length,
  });

  return {
    version: 1,
    sessionId: patch.sessionId,
    promotedAt: timestamp,
    applied: rules.length,
    rules,
  };
}

// ---------------------------------------------------------------------------
// Promotion gate — bridges PromotionArtifact + ReplayResult → Rulebook
// ---------------------------------------------------------------------------

export interface PromotionGateResult {
  accepted: boolean;
  errorCode: RulebookErrorCode | null;
  reason: string;
  replay: ReplayResult;
  rulebook: LearnedRoutingRulebook | null;
}

/**
 * Evaluate whether a promotion artifact should be accepted or rejected based
 * on replay evidence. Produces a LearnedRoutingRulebook on acceptance.
 *
 * Rejection criteria:
 * - `regressions.length > 0`: any historical win would regress under learned rules.
 * - `learnedWins < baselineWins`: net reduction in verified wins.
 *
 * Pure function: same inputs always produce the same result.
 */
export function evaluatePromotionGate(params: {
  artifact: PromotionArtifact;
  replay: ReplayResult;
  now?: string;
}): PromotionGateResult {
  const { artifact, replay, now = artifact.promotedAt } = params;
  const log = createLogger();

  // Rejection: regressions detected
  if (replay.regressions.length > 0) {
    const result: PromotionGateResult = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: ${replay.regressions.length} regression(s) detected`,
      replay,
      rulebook: null,
    };
    log.summary("promotion_gate_rejected", {
      errorCode: result.errorCode,
      regressionCount: replay.regressions.length,
      regressions: replay.regressions,
    });
    return result;
  }

  // Rejection: learned wins worse than baseline
  if (replay.learnedWins < replay.baselineWins) {
    const result: PromotionGateResult = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: learned wins (${replay.learnedWins}) < baseline wins (${replay.baselineWins})`,
      replay,
      rulebook: null,
    };
    log.summary("promotion_gate_rejected", {
      errorCode: result.errorCode,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins,
    });
    return result;
  }

  // Accepted: build rulebook from artifact
  const rulebookRules = artifact.rules.map((r) =>
    createRulebookRule({
      scenario: r.scenario,
      skill: r.skill,
      action: r.action,
      boost: r.boost,
      confidence: r.confidence,
      reason: r.reason,
      sourceSessionId: artifact.sessionId,
      promotedAt: now,
      evidence: {
        baselineWins: replay.baselineWins,
        baselineDirectiveWins: replay.baselineDirectiveWins,
        learnedWins: replay.learnedWins,
        learnedDirectiveWins: replay.learnedDirectiveWins,
        regressionCount: replay.regressions.length,
      },
    }),
  );

  const rulebook: LearnedRoutingRulebook = {
    version: 1,
    createdAt: now,
    sessionId: artifact.sessionId,
    rules: rulebookRules,
  };

  log.summary("promotion_gate_accepted", {
    sessionId: artifact.sessionId,
    ruleCount: rulebookRules.length,
    learnedWins: replay.learnedWins,
    baselineWins: replay.baselineWins,
  });

  return {
    accepted: true,
    errorCode: null,
    reason: `Promotion accepted: ${rulebookRules.length} rule(s), ${replay.learnedWins} learned wins, 0 regressions`,
    replay,
    rulebook,
  };
}
