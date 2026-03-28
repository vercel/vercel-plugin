// hooks/src/policy-recall.mts
import {
  derivePolicyBoost,
  scenarioKeyCandidates
} from "./routing-policy.mjs";
function successRate(stats) {
  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  return weightedWins / Math.max(stats.exposures, 1);
}
function recallScore(stats) {
  return derivePolicyBoost(stats) * 1e3 + Math.round(successRate(stats) * 100) * 10 + stats.directiveWins * 5 + stats.wins - stats.staleMisses;
}
function selectPolicyRecallCandidates(policy, scenarioInput, options = {}) {
  const maxCandidates = options.maxCandidates ?? 1;
  const minExposures = options.minExposures ?? 3;
  const minSuccessRate = options.minSuccessRate ?? 0.65;
  const minBoost = options.minBoost ?? 2;
  const exclude = new Set(options.excludeSkills ?? []);
  for (const scenario of scenarioKeyCandidates(scenarioInput)) {
    const bucket = policy.scenarios[scenario] ?? {};
    const candidates = Object.entries(bucket).map(([skill, stats]) => ({
      skill,
      scenario,
      exposures: stats.exposures,
      wins: stats.wins,
      directiveWins: stats.directiveWins,
      staleMisses: stats.staleMisses,
      successRate: successRate(stats),
      policyBoost: derivePolicyBoost(stats),
      recallScore: recallScore(stats)
    })).filter((entry) => !exclude.has(entry.skill)).filter((entry) => entry.exposures >= minExposures).filter((entry) => entry.successRate >= minSuccessRate).filter((entry) => entry.policyBoost >= minBoost).sort(
      (a, b) => b.recallScore - a.recallScore || b.exposures - a.exposures || a.skill.localeCompare(b.skill)
    );
    if (candidates.length > 0) {
      return candidates.slice(0, maxCandidates);
    }
  }
  return [];
}
export {
  selectPolicyRecallCandidates
};
