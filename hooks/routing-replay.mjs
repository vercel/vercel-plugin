// hooks/src/routing-replay.mts
import {
  readRoutingDecisionTrace
} from "./routing-decision-trace.mjs";
import { loadSessionExposures } from "./routing-policy-ledger.mjs";
import { createLogger } from "./logger.mjs";
function buildScenarioKey(exposure) {
  return [
    exposure.hook,
    exposure.storyKind ?? "none",
    exposure.targetBoundary ?? "none",
    exposure.toolName
  ].join("|");
}
function emptyStats() {
  return { exposures: 0, wins: 0, directiveWins: 0, staleMisses: 0 };
}
var PROMOTE_MIN_EXPOSURES = 3;
var PROMOTE_MIN_SUCCESS_RATE = 0.8;
var PROMOTE_BOOST = 8;
var DEMOTE_MIN_EXPOSURES = 5;
var DEMOTE_MAX_SUCCESS_RATE = 0.15;
var DEMOTE_BOOST = -2;
var INVESTIGATE_MIN_EXPOSURES = 3;
var INVESTIGATE_MIN_RATE = 0.4;
var INVESTIGATE_MAX_RATE = 0.65;
function replayRoutingSession(sessionId) {
  const log = createLogger();
  log.summary("replay_start", { sessionId });
  const traces = readRoutingDecisionTrace(sessionId);
  const exposures = loadSessionExposures(sessionId);
  log.debug("replay_loaded", {
    sessionId,
    traceCount: traces.length,
    exposureCount: exposures.length
  });
  const buckets = /* @__PURE__ */ new Map();
  for (const trace of traces) {
    const scenario = trace.policyScenario;
    if (scenario && !buckets.has(scenario)) {
      buckets.set(scenario, /* @__PURE__ */ new Map());
    }
  }
  for (const exposure of exposures) {
    const scenario = buildScenarioKey(exposure);
    let bySkill = buckets.get(scenario);
    if (!bySkill) {
      bySkill = /* @__PURE__ */ new Map();
      buckets.set(scenario, bySkill);
    }
    const current = bySkill.get(exposure.skill) ?? emptyStats();
    current.exposures += 1;
    if (exposure.outcome === "win") {
      current.wins += 1;
    } else if (exposure.outcome === "directive-win") {
      current.wins += 1;
      current.directiveWins += 1;
    } else if (exposure.outcome === "stale-miss") {
      current.staleMisses += 1;
    }
    bySkill.set(exposure.skill, current);
  }
  const scenarios = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([scenario, bySkill]) => {
    const topSkills = [...bySkill.entries()].map(([skill, stats]) => ({ skill, ...stats })).sort(
      (a, b) => b.wins - a.wins || b.exposures - a.exposures || a.skill.localeCompare(b.skill)
    );
    return {
      scenario,
      exposures: topSkills.reduce((n, s) => n + s.exposures, 0),
      wins: topSkills.reduce((n, s) => n + s.wins, 0),
      directiveWins: topSkills.reduce((n, s) => n + s.directiveWins, 0),
      staleMisses: topSkills.reduce((n, s) => n + s.staleMisses, 0),
      topSkills
    };
  });
  const recommendations = [];
  for (const scenario of scenarios) {
    for (const skill of scenario.topSkills) {
      const successRate = skill.exposures === 0 ? 0 : skill.wins / skill.exposures;
      if (skill.exposures >= PROMOTE_MIN_EXPOSURES && successRate >= PROMOTE_MIN_SUCCESS_RATE) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "promote",
          suggestedBoost: PROMOTE_BOOST,
          confidence: Math.min(0.99, successRate),
          reason: `${skill.wins}/${skill.exposures} wins in ${scenario.scenario}`
        });
      } else if (skill.exposures >= DEMOTE_MIN_EXPOSURES && successRate < DEMOTE_MAX_SUCCESS_RATE) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "demote",
          suggestedBoost: DEMOTE_BOOST,
          confidence: 1 - successRate,
          reason: `${skill.wins}/${skill.exposures} wins in ${scenario.scenario}`
        });
      } else if (skill.exposures >= INVESTIGATE_MIN_EXPOSURES && successRate >= INVESTIGATE_MIN_RATE && successRate < INVESTIGATE_MAX_RATE) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "investigate",
          suggestedBoost: 0,
          confidence: successRate,
          reason: `${skill.wins}/${skill.exposures} mixed results in ${scenario.scenario}`
        });
      }
    }
  }
  recommendations.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.skill.localeCompare(b.skill)
  );
  log.summary("replay_complete", {
    sessionId,
    traceCount: traces.length,
    scenarioCount: scenarios.length,
    recommendationCount: recommendations.length
  });
  return {
    version: 1,
    sessionId,
    traceCount: traces.length,
    scenarioCount: scenarios.length,
    scenarios,
    recommendations
  };
}
export {
  replayRoutingSession
};
