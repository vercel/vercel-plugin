/**
 * Routing Policy Compiler: pure function that converts a replay report into
 * bounded policy patches against an existing RoutingPolicyFile.
 *
 * Contract:
 * - compilePolicyPatch is a pure function of (existing policy, replay report).
 * - No write side effects unless applyPolicyPatch is explicitly called.
 * - Patch recommendations reuse derivePolicyBoost thresholds — no second scoring system.
 * - Deterministic patch ordering: scenario asc, skill asc.
 * - Covers promote, demote, investigate, and no-op cases.
 */

import {
  type RoutingPolicyFile,
  type RoutingPolicyStats,
  derivePolicyBoost,
  ensureScenario,
} from "./routing-policy.mjs";
import type {
  RoutingReplayReport,
  RoutingRecommendation,
} from "./routing-replay.mjs";
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
// Apply — mutates policy in place (explicit opt-in path)
// ---------------------------------------------------------------------------

/**
 * Apply a compiled patch to a policy file by recording synthetic exposures
 * and outcomes that would produce the proposed boost via derivePolicyBoost.
 *
 * This is the only function that mutates state. It must be called explicitly.
 * Returns the number of entries applied.
 */
export function applyPolicyPatch(
  policy: RoutingPolicyFile,
  patch: PolicyPatchReport,
  now?: string,
): number {
  const log = createLogger();
  const timestamp = now ?? new Date().toISOString();
  let applied = 0;

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

    const stats = ensureScenario(
      policy,
      entry.scenario,
      entry.skill,
      timestamp,
    );

    // We set stats directly to values that produce the proposed boost
    // via derivePolicyBoost. This ensures we never introduce a second
    // scoring system — the existing boost ladder is the single source
    // of truth.
    if (entry.proposedBoost === 8) {
      // derivePolicyBoost returns 8 when: exposures >= 3, successRate >= 0.80
      // Set 5 exposures, 5 wins → rate 1.0 + directiveWins*0.25 → well above 0.80
      stats.exposures = Math.max(stats.exposures, 5);
      stats.wins = Math.max(stats.wins, stats.exposures);
      stats.lastUpdatedAt = timestamp;
    } else if (entry.proposedBoost === -2) {
      // derivePolicyBoost returns -2 when: exposures >= 5, successRate < 0.15
      // Set 5 exposures, 0 wins → rate 0.0
      stats.exposures = Math.max(stats.exposures, 5);
      stats.wins = 0;
      stats.directiveWins = 0;
      stats.staleMisses = Math.max(stats.staleMisses, stats.exposures);
      stats.lastUpdatedAt = timestamp;
    }

    // Verify the boost actually matches what we wanted
    const actualBoost = derivePolicyBoost(stats);

    log.summary("policy_apply_entry", {
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      proposedBoost: entry.proposedBoost,
      actualBoost,
      match: actualBoost === entry.proposedBoost,
    });

    applied += 1;
  }

  log.summary("policy_apply_complete", {
    sessionId: patch.sessionId,
    applied,
    total: patch.entries.length,
  });

  return applied;
}
