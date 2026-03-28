// hooks/src/playbook-distillation.mts
import {
  createEmptyPlaybookRulebook
} from "./learned-playbook-rulebook.mjs";
import { createLogger } from "./logger.mjs";
function round4(value) {
  return Number(value.toFixed(4));
}
function precision(wins, support) {
  return support === 0 ? 0 : wins / support;
}
function orderedUnique(skills) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const skill of skills) {
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    out.push(skill);
  }
  return out;
}
function distillPlaybooks(params) {
  const log = createLogger();
  const generatedAt = params.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const minSupport = params.minSupport ?? 3;
  const minPrecision = params.minPrecision ?? 0.75;
  const minLift = params.minLift ?? 1.25;
  const maxStaleMissDelta = params.maxStaleMissDelta ?? 0.1;
  const maxSkills = Math.max(2, params.maxSkills ?? 3);
  const rulebook = createEmptyPlaybookRulebook(
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
  const playbookBuckets = /* @__PURE__ */ new Map();
  const anchorBaselines = /* @__PURE__ */ new Map();
  for (const [groupId, group] of byGroup) {
    const candidate = group.find(
      (e) => (e.attributionRole ?? "candidate") === "candidate"
    );
    if (!candidate) continue;
    if (candidate.outcome === "pending") continue;
    const scenario = [
      candidate.hook,
      candidate.storyKind ?? "none",
      candidate.targetBoundary ?? "none",
      candidate.toolName,
      candidate.route ?? "*"
    ].join("|");
    const orderedSkills = orderedUnique(group.map((e) => e.skill)).slice(
      0,
      maxSkills
    );
    const anchorSkill = candidate.candidateSkill ?? candidate.skill;
    const baselineKey = `${scenario}::${anchorSkill}`;
    const baseline = anchorBaselines.get(baselineKey) ?? {
      support: 0,
      wins: 0,
      staleMisses: 0
    };
    baseline.support += 1;
    if (candidate.outcome === "win" || candidate.outcome === "directive-win") {
      baseline.wins += 1;
    }
    if (candidate.outcome === "stale-miss") {
      baseline.staleMisses += 1;
    }
    anchorBaselines.set(baselineKey, baseline);
    if (orderedSkills.length < 2) continue;
    const bucketKey = `${scenario}::${orderedSkills.join(">")}`;
    const bucket = playbookBuckets.get(bucketKey) ?? {
      scenario,
      hook: candidate.hook,
      storyKind: candidate.storyKind,
      targetBoundary: candidate.targetBoundary,
      toolName: candidate.toolName,
      routeScope: candidate.route,
      anchorSkill,
      orderedSkills,
      support: 0,
      wins: 0,
      directiveWins: 0,
      staleMisses: 0,
      sourceExposureGroupIds: []
    };
    bucket.support += 1;
    if (candidate.outcome === "win" || candidate.outcome === "directive-win") {
      bucket.wins += 1;
    }
    if (candidate.outcome === "directive-win") {
      bucket.directiveWins += 1;
    }
    if (candidate.outcome === "stale-miss") {
      bucket.staleMisses += 1;
    }
    bucket.sourceExposureGroupIds.push(groupId);
    playbookBuckets.set(bucketKey, bucket);
  }
  const rules = [];
  for (const bucket of playbookBuckets.values()) {
    const baseline = anchorBaselines.get(
      `${bucket.scenario}::${bucket.anchorSkill}`
    );
    if (!baseline) continue;
    const supportWithoutPlaybook = Math.max(
      baseline.support - bucket.support,
      0
    );
    const winsWithoutPlaybook = Math.max(baseline.wins - bucket.wins, 0);
    const staleWithoutPlaybook = Math.max(
      baseline.staleMisses - bucket.staleMisses,
      0
    );
    const precisionWithPlaybook = precision(bucket.wins, bucket.support);
    const baselinePrecisionWithoutPlaybook = precision(
      winsWithoutPlaybook,
      supportWithoutPlaybook
    );
    const liftVsAnchorBaseline = baselinePrecisionWithoutPlaybook === 0 ? precisionWithPlaybook : precisionWithPlaybook / baselinePrecisionWithoutPlaybook;
    const staleRateWithPlaybook = precision(
      bucket.staleMisses,
      bucket.support
    );
    const staleRateWithoutPlaybook = precision(
      staleWithoutPlaybook,
      supportWithoutPlaybook
    );
    const staleMissDelta = staleRateWithPlaybook - staleRateWithoutPlaybook;
    const promoted = bucket.support >= minSupport && precisionWithPlaybook >= minPrecision && liftVsAnchorBaseline >= minLift && staleMissDelta <= maxStaleMissDelta;
    rules.push({
      id: `${bucket.scenario}::${bucket.orderedSkills.join(">")}`,
      scenario: bucket.scenario,
      hook: bucket.hook,
      storyKind: bucket.storyKind,
      targetBoundary: bucket.targetBoundary,
      toolName: bucket.toolName,
      routeScope: bucket.routeScope,
      anchorSkill: bucket.anchorSkill,
      orderedSkills: bucket.orderedSkills,
      support: bucket.support,
      wins: bucket.wins,
      directiveWins: bucket.directiveWins,
      staleMisses: bucket.staleMisses,
      precision: round4(precisionWithPlaybook),
      baselinePrecisionWithoutPlaybook: round4(
        baselinePrecisionWithoutPlaybook
      ),
      liftVsAnchorBaseline: round4(liftVsAnchorBaseline),
      staleMissDelta: round4(staleMissDelta),
      confidence: promoted ? "promote" : "holdout-fail",
      promotedAt: promoted ? generatedAt : null,
      reason: promoted ? "verified ordered playbook beats same anchor without this exact sequence" : "insufficient support, precision, lift, or stale-miss performance",
      sourceExposureGroupIds: [...bucket.sourceExposureGroupIds].sort()
    });
  }
  rules.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.anchorSkill.localeCompare(b.anchorSkill) || a.orderedSkills.join(">").localeCompare(b.orderedSkills.join(">"))
  );
  const promotedCount = rules.filter(
    (r) => r.confidence === "promote"
  ).length;
  rulebook.rules = rules;
  rulebook.promotion = {
    accepted: true,
    errorCode: null,
    reason: `${promotedCount} promoted playbooks`
  };
  log.summary("playbook-distillation.complete", {
    exposureCount: params.exposures.length,
    groupCount: byGroup.size,
    ruleCount: rules.length,
    promotedCount
  });
  return rulebook;
}
export {
  distillPlaybooks
};
