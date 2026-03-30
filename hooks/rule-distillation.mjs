// hooks/src/rule-distillation.mts
import { createLogger } from "./logger.mjs";
import { replayLearnedRules } from "./rule-replay.mjs";
import { replayLearnedRules as replayLearnedRules2 } from "./rule-replay.mjs";
function computeRuleLift(input) {
  const rulePrecision = input.wins / Math.max(input.support, 1);
  const scenarioPrecision = input.scenarioWins / Math.max(input.scenarioExposures, 1);
  if (scenarioPrecision === 0) return rulePrecision;
  return rulePrecision / scenarioPrecision;
}
function classifyRuleConfidence(input) {
  if (input.regressions > 0) return "holdout-fail";
  if (input.support >= 5 && input.precision >= 0.8 && input.lift >= 1.5)
    return "promote";
  if (input.support >= 3 && input.precision >= 0.65 && input.lift >= 1.1)
    return "candidate";
  return "holdout-fail";
}
function scenarioKeyFromTrace(trace) {
  const story = trace.primaryStory;
  return [
    trace.hook,
    story.kind ?? "_",
    story.targetBoundary ?? "_",
    trace.toolName,
    story.storyRoute ?? "_"
  ].join("|");
}
function scenarioFromTrace(trace) {
  const story = trace.primaryStory;
  return {
    hook: trace.hook,
    storyKind: story.kind ?? null,
    targetBoundary: story.targetBoundary ?? null,
    toolName: trace.toolName,
    routeScope: story.storyRoute ?? null
  };
}
function inferRuleKind(ranked, hook) {
  if (!ranked.pattern) {
    return hook === "UserPromptSubmit" ? "promptPhrase" : "pathPattern";
  }
  switch (ranked.pattern.type) {
    case "path":
    case "pathPattern":
      return "pathPattern";
    case "bash":
    case "bashPattern":
      return "bashPattern";
    case "import":
    case "importPattern":
      return "importPattern";
    case "prompt":
    case "promptPhrase":
      return "promptPhrase";
    case "promptAllOf":
      return "promptAllOf";
    case "promptNoneOf":
      return "promptNoneOf";
    case "companion":
      return "companion";
    default:
      return hook === "UserPromptSubmit" ? "promptPhrase" : "pathPattern";
  }
}
function extractPatternValue(ranked, trace) {
  if (ranked.pattern?.value) return ranked.pattern.value;
  if (trace.hook === "UserPromptSubmit") return trace.toolTarget || "";
  return trace.toolTarget || "";
}
function candidateKey(scenarioKey, skill, kind, value) {
  const v = Array.isArray(value) ? value.join(",") : value;
  return `${scenarioKey}|${skill}|${kind}|${v}`;
}
function distillRulesFromTrace(params) {
  const {
    projectRoot,
    traces,
    exposures,
    policy,
    minSupport = 5,
    minPrecision = 0.8,
    minLift = 1.5,
    generatedAt = (/* @__PURE__ */ new Date()).toISOString()
  } = params;
  const logger = createLogger("summary");
  logger.summary("distill_start", {
    traceCount: traces.length,
    exposureCount: exposures.length,
    minSupport,
    minPrecision,
    minLift
  });
  const exposureByKey = /* @__PURE__ */ new Map();
  for (const exp of exposures) {
    const key = `${exp.sessionId}|${exp.skill}|${exp.hook}|${exp.route ?? "_"}`;
    exposureByKey.set(key, exp);
  }
  const candidates = /* @__PURE__ */ new Map();
  const scenarioExposureCounts = /* @__PURE__ */ new Map();
  const scenarioWinCounts = /* @__PURE__ */ new Map();
  for (const trace of traces) {
    const sKey = scenarioKeyFromTrace(trace);
    const scenario = scenarioFromTrace(trace);
    for (const ranked of trace.ranked) {
      if (ranked.droppedReason) continue;
      const expKey = `${trace.sessionId}|${ranked.skill}|${trace.hook}|${trace.primaryStory.storyRoute ?? "_"}`;
      const exposure = exposureByKey.get(expKey);
      if (!exposure) continue;
      if (exposure.attributionRole !== "candidate") continue;
      const kind = inferRuleKind(ranked, trace.hook);
      const value = extractPatternValue(ranked, trace);
      const cKey = candidateKey(sKey, ranked.skill, kind, value);
      let acc = candidates.get(cKey);
      if (!acc) {
        acc = {
          skill: ranked.skill,
          kind,
          value,
          scenario,
          scenarioKey: sKey,
          support: 0,
          wins: 0,
          directiveWins: 0,
          staleMisses: 0,
          sourceDecisionIds: []
        };
        candidates.set(cKey, acc);
      }
      acc.support++;
      acc.sourceDecisionIds.push(trace.decisionId);
      scenarioExposureCounts.set(
        sKey,
        (scenarioExposureCounts.get(sKey) ?? 0) + 1
      );
      if (exposure.outcome === "win" || exposure.outcome === "directive-win") {
        scenarioWinCounts.set(sKey, (scenarioWinCounts.get(sKey) ?? 0) + 1);
      }
      switch (exposure.outcome) {
        case "win":
          acc.wins++;
          break;
        case "directive-win":
          acc.wins++;
          acc.directiveWins++;
          break;
        case "stale-miss":
          acc.staleMisses++;
          break;
      }
    }
  }
  logger.summary("distill_candidates_extracted", {
    candidateCount: candidates.size,
    scenarioCount: scenarioExposureCounts.size
  });
  const rules = [];
  for (const acc of candidates.values()) {
    const precision = acc.wins / Math.max(acc.support, 1);
    const scenarioWins = scenarioWinCounts.get(acc.scenarioKey) ?? 0;
    const scenarioExposures = scenarioExposureCounts.get(acc.scenarioKey) ?? 0;
    const lift = computeRuleLift({
      wins: acc.wins,
      support: acc.support,
      scenarioWins,
      scenarioExposures
    });
    const confidence = classifyRuleConfidence({
      support: acc.support,
      precision,
      lift,
      regressions: 0
    });
    const ruleId = `${acc.kind}:${acc.skill}:${Array.isArray(acc.value) ? acc.value.join("+") : acc.value}`;
    const sortedIds = [...acc.sourceDecisionIds].sort();
    rules.push({
      id: ruleId,
      skill: acc.skill,
      kind: acc.kind,
      value: acc.value,
      scenario: acc.scenario,
      support: acc.support,
      wins: acc.wins,
      directiveWins: acc.directiveWins,
      staleMisses: acc.staleMisses,
      precision: Number(precision.toFixed(4)),
      lift: Number(lift.toFixed(4)),
      sourceDecisionIds: sortedIds,
      confidence,
      promotedAt: confidence === "promote" ? generatedAt : null
    });
  }
  logger.summary("distill_scoring_complete", {
    totalRules: rules.length,
    promoted: rules.filter((r) => r.confidence === "promote").length,
    candidate: rules.filter((r) => r.confidence === "candidate").length,
    holdoutFail: rules.filter((r) => r.confidence === "holdout-fail").length
  });
  rules.sort((a, b) => {
    const scenarioA = [a.scenario.hook, a.scenario.storyKind ?? "_", a.scenario.targetBoundary ?? "_", a.scenario.toolName, a.scenario.routeScope ?? "_"].join("|");
    const scenarioB = [b.scenario.hook, b.scenario.storyKind ?? "_", b.scenario.targetBoundary ?? "_", b.scenario.toolName, b.scenario.routeScope ?? "_"].join("|");
    const sc = scenarioA.localeCompare(scenarioB);
    if (sc !== 0) return sc;
    const sk = a.skill.localeCompare(b.skill);
    if (sk !== 0) return sk;
    return a.id.localeCompare(b.id);
  });
  const replay = replayLearnedRules({ traces, rules });
  let promotion;
  const rejected = replay.regressions.length > 0 || replay.learnedWins < replay.baselineWins;
  if (rejected) {
    for (const rule of rules) {
      if (rule.confidence === "promote") {
        rule.confidence = "holdout-fail";
        rule.promotedAt = null;
      }
    }
    const reasons = [];
    if (replay.regressions.length > 0) {
      reasons.push(`${replay.regressions.length} regression(s) detected`);
    }
    if (replay.learnedWins < replay.baselineWins) {
      reasons.push(`learned wins (${replay.learnedWins}) < baseline wins (${replay.baselineWins})`);
    }
    promotion = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: ${reasons.join("; ")}`
    };
    logger.summary("distill_promotion_rejected", {
      errorCode: promotion.errorCode,
      reason: promotion.reason,
      regressions: replay.regressions.length,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins
    });
  } else {
    const promotedCount = rules.filter((r) => r.confidence === "promote").length;
    promotion = {
      accepted: true,
      errorCode: null,
      reason: `Promotion accepted: ${promotedCount} rule(s) promoted, ${replay.learnedWins} learned wins, 0 regressions`
    };
    logger.summary("distill_promotion_accepted", {
      promotedCount,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins
    });
  }
  logger.summary("distill_complete", {
    ruleCount: rules.length,
    replayDelta: replay.deltaWins,
    regressions: replay.regressions.length,
    promotionAccepted: promotion.accepted
  });
  return {
    version: 1,
    generatedAt,
    projectRoot,
    rules,
    replay,
    promotion
  };
}
export {
  classifyRuleConfidence,
  computeRuleLift,
  distillRulesFromTrace,
  replayLearnedRules2 as replayLearnedRules
};
