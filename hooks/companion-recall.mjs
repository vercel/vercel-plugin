// hooks/src/companion-recall.mts
import { loadCompanionRulebook } from "./learned-companion-rulebook.mjs";
import {
  scenarioKeyCandidates
} from "./routing-policy.mjs";
import { createLogger } from "./logger.mjs";
function recallVerifiedCompanions(params) {
  const log = createLogger();
  const loaded = loadCompanionRulebook(params.projectRoot);
  if (!loaded.ok) {
    log.summary("companion-recall.load-error", {
      code: loaded.error.code,
      message: loaded.error.message
    });
    return { selected: [], checkedScenarios: [], rejected: [] };
  }
  const checkedScenarios = scenarioKeyCandidates(params.scenario);
  const selected = [];
  const rejected = [];
  const selectedCompanions = /* @__PURE__ */ new Set();
  log.summary("companion-recall.lookup", {
    checkedScenarios,
    candidateSkills: params.candidateSkills,
    excludeCount: params.excludeSkills.size,
    maxCompanions: params.maxCompanions,
    rulebookRuleCount: loaded.rulebook.rules.length
  });
  for (const scenario of checkedScenarios) {
    const matching = loaded.rulebook.rules.filter(
      (rule) => rule.scenario === scenario && rule.confidence === "promote" && params.candidateSkills.includes(rule.candidateSkill)
    ).sort(
      (a, b) => b.liftVsCandidateAlone - a.liftVsCandidateAlone || b.support - a.support || a.companionSkill.localeCompare(b.companionSkill)
    );
    for (const rule of matching) {
      if (selected.length >= params.maxCompanions) break;
      if (selectedCompanions.has(rule.companionSkill)) continue;
      if (params.excludeSkills.has(rule.companionSkill)) {
        rejected.push({
          candidateSkill: rule.candidateSkill,
          companionSkill: rule.companionSkill,
          scenario,
          rejectedReason: "excluded"
        });
        continue;
      }
      selected.push({
        candidateSkill: rule.candidateSkill,
        companionSkill: rule.companionSkill,
        scenario,
        confidence: rule.liftVsCandidateAlone,
        reason: rule.reason
      });
      selectedCompanions.add(rule.companionSkill);
    }
  }
  log.summary("companion-recall.result", {
    selectedCount: selected.length,
    rejectedCount: rejected.length,
    checkedScenarioCount: checkedScenarios.length,
    selected: selected.map((s) => ({
      candidate: s.candidateSkill,
      companion: s.companionSkill,
      scenario: s.scenario,
      lift: s.confidence
    }))
  });
  return { selected, checkedScenarios, rejected };
}
export {
  recallVerifiedCompanions
};
