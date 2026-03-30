// hooks/src/routing-policy-compiler.mts
import {
  derivePolicyBoost
} from "./routing-policy.mjs";
import {
  createRule as createRulebookRule
} from "./learned-routing-rulebook.mjs";
import { createLogger } from "./logger.mjs";
function boostForAction(rec) {
  switch (rec.action) {
    case "promote":
      return 8;
    case "demote":
      return -2;
    case "investigate":
      return 0;
  }
}
function compilePolicyPatch(policy, report) {
  const log = createLogger();
  log.summary("policy_compiler_start", {
    sessionId: report.sessionId,
    recommendationCount: report.recommendations.length
  });
  const entries = [];
  for (const rec of report.recommendations) {
    const bucket = policy.scenarios[rec.scenario] ?? {};
    const stats = bucket[rec.skill];
    const currentBoost = derivePolicyBoost(stats);
    const proposedBoost = boostForAction(rec);
    const delta = proposedBoost - currentBoost;
    if (delta !== 0 || rec.action === "investigate") {
      const action = rec.action === "investigate" ? "investigate" : delta > 0 ? "promote" : delta < 0 ? "demote" : "no-op";
      const entry = {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta,
        confidence: rec.confidence,
        reason: rec.reason
      };
      entries.push(entry);
      log.debug("policy_patch_entry", {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta
      });
    } else {
      log.debug("policy_patch_no_op", {
        scenario: rec.scenario,
        skill: rec.skill,
        currentBoost,
        proposedBoost,
        reason: "boost already aligned"
      });
    }
  }
  entries.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.skill.localeCompare(b.skill)
  );
  log.summary("policy_compiler_complete", {
    sessionId: report.sessionId,
    patchCount: entries.length,
    promotes: entries.filter((e) => e.action === "promote").length,
    demotes: entries.filter((e) => e.action === "demote").length,
    investigates: entries.filter((e) => e.action === "investigate").length,
    noOps: entries.filter((e) => e.action === "no-op").length
  });
  return {
    version: 1,
    sessionId: report.sessionId,
    patchCount: entries.length,
    entries
  };
}
function applyPolicyPatch(patch, now) {
  const log = createLogger();
  const timestamp = now ?? (/* @__PURE__ */ new Date()).toISOString();
  const rules = [];
  for (const entry of patch.entries) {
    if (entry.action === "investigate" || entry.action === "no-op") {
      log.debug("policy_apply_skip", {
        scenario: entry.scenario,
        skill: entry.skill,
        action: entry.action,
        reason: "non-actionable"
      });
      continue;
    }
    rules.push({
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      boost: Math.abs(entry.proposedBoost),
      confidence: entry.confidence,
      reason: entry.reason
    });
    log.summary("policy_apply_entry", {
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      proposedBoost: entry.proposedBoost,
      delta: entry.delta
    });
  }
  log.summary("policy_apply_complete", {
    sessionId: patch.sessionId,
    applied: rules.length,
    total: patch.entries.length
  });
  return {
    version: 1,
    sessionId: patch.sessionId,
    promotedAt: timestamp,
    applied: rules.length,
    rules
  };
}
function evaluatePromotionGate(params) {
  const { artifact, replay, now = artifact.promotedAt } = params;
  const log = createLogger();
  if (replay.regressions.length > 0) {
    const result = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: ${replay.regressions.length} regression(s) detected`,
      replay,
      rulebook: null
    };
    log.summary("promotion_gate_rejected", {
      errorCode: result.errorCode,
      regressionCount: replay.regressions.length,
      regressions: replay.regressions
    });
    return result;
  }
  if (replay.learnedWins < replay.baselineWins) {
    const result = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: learned wins (${replay.learnedWins}) < baseline wins (${replay.baselineWins})`,
      replay,
      rulebook: null
    };
    log.summary("promotion_gate_rejected", {
      errorCode: result.errorCode,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins
    });
    return result;
  }
  const rulebookRules = artifact.rules.map(
    (r) => createRulebookRule({
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
        regressionCount: replay.regressions.length
      }
    })
  );
  const rulebook = {
    version: 1,
    createdAt: now,
    sessionId: artifact.sessionId,
    rules: rulebookRules
  };
  log.summary("promotion_gate_accepted", {
    sessionId: artifact.sessionId,
    ruleCount: rulebookRules.length,
    learnedWins: replay.learnedWins,
    baselineWins: replay.baselineWins
  });
  return {
    accepted: true,
    errorCode: null,
    reason: `Promotion accepted: ${rulebookRules.length} rule(s), ${replay.learnedWins} learned wins, 0 regressions`,
    replay,
    rulebook
  };
}
export {
  applyPolicyPatch,
  compilePolicyPatch,
  evaluatePromotionGate
};
