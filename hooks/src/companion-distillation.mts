/**
 * companion-distillation.mts — Distill grouped exposures into promotable
 * companion rules.
 *
 * Reads grouped SkillExposure records (exposureGroupId, candidateSkill,
 * attributionRole, outcome) and compares candidate+companion performance
 * against candidate-alone within the same scenario. Promotion thresholds:
 *
 *   support           >= 4
 *   precisionWithCompanion >= 0.75
 *   liftVsCandidateAlone   >= 1.25
 *   staleMissDelta         <= 0.10
 *
 * Does NOT write files. Does NOT change candidate-only policy credit semantics.
 * All derived metrics are rounded to 4 decimal places for determinism.
 */

import type { SkillExposure } from "./routing-policy-ledger.mjs";
import type { RoutingDecisionTrace } from "./routing-decision-trace.mjs";
import {
  createEmptyCompanionRulebook,
  type LearnedCompanionRule,
  type LearnedCompanionRulebook,
} from "./learned-companion-rulebook.mjs";
import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function precision(wins: number, support: number): number {
  return support === 0 ? 0 : wins / support;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

// ---------------------------------------------------------------------------
// Distillation parameters
// ---------------------------------------------------------------------------

export interface DistillationParams {
  projectRoot: string;
  traces: RoutingDecisionTrace[];
  exposures: SkillExposure[];
  generatedAt?: string;
  minSupport?: number;
  minPrecision?: number;
  minLift?: number;
  maxStaleMissDelta?: number;
}

// ---------------------------------------------------------------------------
// Internal bucket types
// ---------------------------------------------------------------------------

interface PairBucket {
  scenario: string;
  hook: SkillExposure["hook"];
  storyKind: string | null;
  targetBoundary: SkillExposure["targetBoundary"];
  toolName: SkillExposure["toolName"];
  routeScope: string | null;
  candidateSkill: string;
  companionSkill: string;
  support: number;
  winsWithCompanion: number;
  directiveWinsWithCompanion: number;
  staleMissesWithCompanion: number;
  sourceExposureGroupIds: string[];
}

interface BaselineBucket {
  support: number;
  wins: number;
  staleMisses: number;
}

// ---------------------------------------------------------------------------
// Main distillation function
// ---------------------------------------------------------------------------

/**
 * Distill grouped exposures into a companion rulebook. Pure computation —
 * reads exposure fields only and does not write files or modify policy credit.
 */
export function distillCompanionRules(
  params: DistillationParams,
): LearnedCompanionRulebook {
  const log = createLogger();
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const minSupport = params.minSupport ?? 4;
  const minPrecision = params.minPrecision ?? 0.75;
  const minLift = params.minLift ?? 1.25;
  const maxStaleMissDelta = params.maxStaleMissDelta ?? 0.10;

  log.summary("companion-distillation.start", {
    exposureCount: params.exposures.length,
    traceCount: params.traces.length,
    minSupport,
    minPrecision,
    minLift,
    maxStaleMissDelta,
  });

  const rulebook = createEmptyCompanionRulebook(
    params.projectRoot,
    generatedAt,
  );

  // Group exposures by exposureGroupId
  const byGroup = new Map<string, SkillExposure[]>();
  for (const exposure of params.exposures) {
    if (!exposure.exposureGroupId) continue;
    const list = byGroup.get(exposure.exposureGroupId) ?? [];
    list.push(exposure);
    byGroup.set(exposure.exposureGroupId, list);
  }

  log.summary("companion-distillation.grouped", {
    groupCount: byGroup.size,
    skippedNoGroupId: params.exposures.filter((e) => !e.exposureGroupId).length,
  });

  // Accumulate pair buckets and candidate baselines
  const pairBuckets = new Map<string, PairBucket>();
  const candidateBaseline = new Map<string, BaselineBucket>();

  for (const [groupId, group] of byGroup) {
    const candidate = group.find((e) => e.attributionRole === "candidate");
    if (!candidate) continue;

    const outcome = candidate.outcome;

    const scenario = [
      candidate.hook,
      candidate.storyKind ?? "none",
      candidate.targetBoundary ?? "none",
      candidate.toolName,
      candidate.route ?? "*",
    ].join("|");

    // Update candidate baseline
    const baselineKey = `${scenario}::${candidate.skill}`;
    const baseline = candidateBaseline.get(baselineKey) ?? {
      support: 0,
      wins: 0,
      staleMisses: 0,
    };
    baseline.support += 1;
    if (outcome === "win" || outcome === "directive-win") baseline.wins += 1;
    if (outcome === "stale-miss") baseline.staleMisses += 1;
    candidateBaseline.set(baselineKey, baseline);

    // Update pair buckets for each context companion
    for (const context of group.filter(
      (e) => e.attributionRole === "context",
    )) {
      const key = `${scenario}::${candidate.skill}::${context.skill}`;
      const bucket = pairBuckets.get(key) ?? {
        scenario,
        hook: candidate.hook,
        storyKind: candidate.storyKind,
        targetBoundary: candidate.targetBoundary,
        toolName: candidate.toolName,
        routeScope: candidate.route,
        candidateSkill: candidate.skill,
        companionSkill: context.skill,
        support: 0,
        winsWithCompanion: 0,
        directiveWinsWithCompanion: 0,
        staleMissesWithCompanion: 0,
        sourceExposureGroupIds: [],
      };
      bucket.support += 1;
      if (outcome === "win" || outcome === "directive-win")
        bucket.winsWithCompanion += 1;
      if (outcome === "directive-win") bucket.directiveWinsWithCompanion += 1;
      if (outcome === "stale-miss") bucket.staleMissesWithCompanion += 1;
      bucket.sourceExposureGroupIds.push(groupId);
      pairBuckets.set(key, bucket);
    }
  }

  log.summary("companion-distillation.buckets", {
    pairBucketCount: pairBuckets.size,
    baselineCount: candidateBaseline.size,
  });

  // Evaluate each pair bucket against thresholds
  const rules: LearnedCompanionRule[] = [];

  for (const bucket of pairBuckets.values()) {
    const baseline = candidateBaseline.get(
      `${bucket.scenario}::${bucket.candidateSkill}`,
    );
    if (!baseline) continue;

    const winsWithoutCompanion = Math.max(
      baseline.wins - bucket.winsWithCompanion,
      0,
    );
    const supportWithoutCompanion = Math.max(
      baseline.support - bucket.support,
      0,
    );

    const precisionWithCompanion = precision(
      bucket.winsWithCompanion,
      bucket.support,
    );
    const baselinePrecisionWithoutCompanion = precision(
      winsWithoutCompanion,
      supportWithoutCompanion,
    );

    const liftVsCandidateAlone =
      baselinePrecisionWithoutCompanion === 0
        ? precisionWithCompanion
        : precisionWithCompanion / baselinePrecisionWithoutCompanion;

    const staleRateWithCompanion = precision(
      bucket.staleMissesWithCompanion,
      bucket.support,
    );
    const staleRateWithoutCompanion = precision(
      Math.max(baseline.staleMisses - bucket.staleMissesWithCompanion, 0),
      supportWithoutCompanion,
    );
    const staleMissDelta = staleRateWithCompanion - staleRateWithoutCompanion;

    const promoted =
      bucket.support >= minSupport &&
      precisionWithCompanion >= minPrecision &&
      liftVsCandidateAlone >= minLift &&
      staleMissDelta <= maxStaleMissDelta;

    const rule: LearnedCompanionRule = {
      id: `${bucket.scenario}::${bucket.candidateSkill}->${bucket.companionSkill}`,
      scenario: bucket.scenario,
      hook: bucket.hook,
      storyKind: bucket.storyKind,
      targetBoundary: bucket.targetBoundary,
      toolName: bucket.toolName,
      routeScope: bucket.routeScope,
      candidateSkill: bucket.candidateSkill,
      companionSkill: bucket.companionSkill,
      support: bucket.support,
      winsWithCompanion: bucket.winsWithCompanion,
      winsWithoutCompanion,
      directiveWinsWithCompanion: bucket.directiveWinsWithCompanion,
      staleMissesWithCompanion: bucket.staleMissesWithCompanion,
      precisionWithCompanion: round4(precisionWithCompanion),
      baselinePrecisionWithoutCompanion: round4(
        baselinePrecisionWithoutCompanion,
      ),
      liftVsCandidateAlone: round4(liftVsCandidateAlone),
      staleMissDelta: round4(staleMissDelta),
      confidence: promoted ? "promote" : "holdout-fail",
      promotedAt: promoted ? generatedAt : null,
      reason: promoted
        ? "companion beats candidate-alone within same verified scenario"
        : "insufficient support or lift",
      sourceExposureGroupIds: [...bucket.sourceExposureGroupIds].sort(),
    };

    rules.push(rule);

    log.summary("companion-distillation.rule-evaluated", {
      id: rule.id,
      confidence: rule.confidence,
      support: rule.support,
      precisionWithCompanion: rule.precisionWithCompanion,
      liftVsCandidateAlone: rule.liftVsCandidateAlone,
      staleMissDelta: rule.staleMissDelta,
    });
  }

  // Sort deterministically
  rules.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.candidateSkill.localeCompare(b.candidateSkill) ||
      a.companionSkill.localeCompare(b.companionSkill),
  );

  rulebook.rules = rules;

  const promotedCount = rules.filter(
    (r) => r.confidence === "promote",
  ).length;

  rulebook.replay = {
    baselineWins: 0,
    learnedWins: 0,
    deltaWins: 0,
    regressions: [],
  };

  rulebook.promotion = {
    accepted: true,
    errorCode: null,
    reason: `${promotedCount} promoted companion rules`,
  };

  log.summary("companion-distillation.complete", {
    totalRules: rules.length,
    promotedCount,
    holdoutFailCount: rules.length - promotedCount,
  });

  return rulebook;
}
