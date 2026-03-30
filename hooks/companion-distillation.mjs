// hooks/src/companion-distillation.mts
import {
  createEmptyCompanionRulebook
} from "./learned-companion-rulebook.mjs";
import { createLogger } from "./logger.mjs";
function precision(wins, support) {
  return support === 0 ? 0 : wins / support;
}
function round4(value) {
  return Number(value.toFixed(4));
}
function distillCompanionRules(params) {
  const log = createLogger();
  const generatedAt = params.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const minSupport = params.minSupport ?? 4;
  const minPrecision = params.minPrecision ?? 0.75;
  const minLift = params.minLift ?? 1.25;
  const maxStaleMissDelta = params.maxStaleMissDelta ?? 0.1;
  log.summary("companion-distillation.start", {
    exposureCount: params.exposures.length,
    traceCount: params.traces.length,
    minSupport,
    minPrecision,
    minLift,
    maxStaleMissDelta
  });
  const rulebook = createEmptyCompanionRulebook(
    params.projectRoot,
    generatedAt
  );
  const byGroup = /* @__PURE__ */ new Map();
  for (const exposure of params.exposures) {
    if (!exposure.exposureGroupId) continue;
    const list = byGroup.get(exposure.exposureGroupId) ?? [];
    list.push(exposure);
    byGroup.set(exposure.exposureGroupId, list);
  }
  log.summary("companion-distillation.grouped", {
    groupCount: byGroup.size,
    skippedNoGroupId: params.exposures.filter((e) => !e.exposureGroupId).length
  });
  const pairBuckets = /* @__PURE__ */ new Map();
  const candidateBaseline = /* @__PURE__ */ new Map();
  for (const [groupId, group] of byGroup) {
    const candidate = group.find((e) => e.attributionRole === "candidate");
    if (!candidate) continue;
    const outcome = candidate.outcome;
    const scenario = [
      candidate.hook,
      candidate.storyKind ?? "none",
      candidate.targetBoundary ?? "none",
      candidate.toolName,
      candidate.route ?? "*"
    ].join("|");
    const baselineKey = `${scenario}::${candidate.skill}`;
    const baseline = candidateBaseline.get(baselineKey) ?? {
      support: 0,
      wins: 0,
      staleMisses: 0
    };
    baseline.support += 1;
    if (outcome === "win" || outcome === "directive-win") baseline.wins += 1;
    if (outcome === "stale-miss") baseline.staleMisses += 1;
    candidateBaseline.set(baselineKey, baseline);
    for (const context of group.filter(
      (e) => e.attributionRole === "context"
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
        sourceExposureGroupIds: []
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
    baselineCount: candidateBaseline.size
  });
  const rules = [];
  for (const bucket of pairBuckets.values()) {
    const baseline = candidateBaseline.get(
      `${bucket.scenario}::${bucket.candidateSkill}`
    );
    if (!baseline) continue;
    const winsWithoutCompanion = Math.max(
      baseline.wins - bucket.winsWithCompanion,
      0
    );
    const supportWithoutCompanion = Math.max(
      baseline.support - bucket.support,
      0
    );
    const precisionWithCompanion = precision(
      bucket.winsWithCompanion,
      bucket.support
    );
    const baselinePrecisionWithoutCompanion = precision(
      winsWithoutCompanion,
      supportWithoutCompanion
    );
    const liftVsCandidateAlone = baselinePrecisionWithoutCompanion === 0 ? precisionWithCompanion : precisionWithCompanion / baselinePrecisionWithoutCompanion;
    const staleRateWithCompanion = precision(
      bucket.staleMissesWithCompanion,
      bucket.support
    );
    const staleRateWithoutCompanion = precision(
      Math.max(baseline.staleMisses - bucket.staleMissesWithCompanion, 0),
      supportWithoutCompanion
    );
    const staleMissDelta = staleRateWithCompanion - staleRateWithoutCompanion;
    const promoted = bucket.support >= minSupport && precisionWithCompanion >= minPrecision && liftVsCandidateAlone >= minLift && staleMissDelta <= maxStaleMissDelta;
    const rule = {
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
        baselinePrecisionWithoutCompanion
      ),
      liftVsCandidateAlone: round4(liftVsCandidateAlone),
      staleMissDelta: round4(staleMissDelta),
      confidence: promoted ? "promote" : "holdout-fail",
      promotedAt: promoted ? generatedAt : null,
      reason: promoted ? "companion beats candidate-alone within same verified scenario" : "insufficient support or lift",
      sourceExposureGroupIds: [...bucket.sourceExposureGroupIds].sort()
    };
    rules.push(rule);
    log.summary("companion-distillation.rule-evaluated", {
      id: rule.id,
      confidence: rule.confidence,
      support: rule.support,
      precisionWithCompanion: rule.precisionWithCompanion,
      liftVsCandidateAlone: rule.liftVsCandidateAlone,
      staleMissDelta: rule.staleMissDelta
    });
  }
  rules.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.candidateSkill.localeCompare(b.candidateSkill) || a.companionSkill.localeCompare(b.companionSkill)
  );
  rulebook.rules = rules;
  const promotedCount = rules.filter(
    (r) => r.confidence === "promote"
  ).length;
  rulebook.replay = {
    baselineWins: 0,
    learnedWins: 0,
    deltaWins: 0,
    regressions: []
  };
  rulebook.promotion = {
    accepted: true,
    errorCode: null,
    reason: `${promotedCount} promoted companion rules`
  };
  log.summary("companion-distillation.complete", {
    totalRules: rules.length,
    promotedCount,
    holdoutFailCount: rules.length - promotedCount
  });
  return rulebook;
}
export {
  distillCompanionRules
};
