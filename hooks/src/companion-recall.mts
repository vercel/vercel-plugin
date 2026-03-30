/**
 * companion-recall.mts — Recall verified companion skills during hook injection.
 *
 * When a promoted companion rule matches the current scenario and candidate
 * skills, the recalled companion is inserted immediately after its candidate
 * in the ranked skill list. Excluded or already-injected companions fall back
 * to the existing summary path instead of violating dedup rules.
 *
 * No-ops safely when:
 * - The companion rulebook artifact is missing, invalid, or unsupported
 * - No promoted rule matches the current scenario
 * - All matched companions are excluded or already seen
 *
 * Routing reasons for recalled companions use:
 *   trigger: "verified-companion"
 *   reasonCode: "scenario-companion-rulebook"
 */

import { loadCompanionRulebook } from "./learned-companion-rulebook.mjs";
import {
  scenarioKeyCandidates,
  type RoutingPolicyScenario,
} from "./routing-policy.mjs";
import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompanionRecallCandidate {
  candidateSkill: string;
  companionSkill: string;
  scenario: string;
  confidence: number;
  reason: string;
}

export interface CompanionRecallRejection {
  candidateSkill: string;
  companionSkill: string;
  scenario: string;
  rejectedReason: string;
}

export interface CompanionRecallResult {
  selected: CompanionRecallCandidate[];
  checkedScenarios: string[];
  rejected: CompanionRecallRejection[];
}

// ---------------------------------------------------------------------------
// Main recall function
// ---------------------------------------------------------------------------

/**
 * Look up verified companion rules for the given scenario and candidate skills.
 * Returns companions sorted by lift (desc), support (desc), name (asc).
 * Respects maxCompanions cap and excludeSkills set.
 */
export function recallVerifiedCompanions(params: {
  projectRoot: string;
  scenario: RoutingPolicyScenario;
  candidateSkills: string[];
  excludeSkills: Set<string>;
  maxCompanions: number;
}): CompanionRecallResult {
  const log = createLogger();

  const loaded = loadCompanionRulebook(params.projectRoot);
  if (!loaded.ok) {
    log.summary("companion-recall.load-error", {
      code: loaded.error.code,
      message: loaded.error.message,
    });
    return { selected: [], checkedScenarios: [], rejected: [] };
  }

  const checkedScenarios = scenarioKeyCandidates(params.scenario);
  const selected: CompanionRecallCandidate[] = [];
  const rejected: CompanionRecallRejection[] = [];
  const selectedCompanions = new Set<string>();

  log.summary("companion-recall.lookup", {
    checkedScenarios,
    candidateSkills: params.candidateSkills,
    excludeCount: params.excludeSkills.size,
    maxCompanions: params.maxCompanions,
    rulebookRuleCount: loaded.rulebook.rules.length,
  });

  for (const scenario of checkedScenarios) {
    const matching = loaded.rulebook.rules
      .filter(
        (rule) =>
          rule.scenario === scenario &&
          rule.confidence === "promote" &&
          params.candidateSkills.includes(rule.candidateSkill),
      )
      .sort(
        (a, b) =>
          b.liftVsCandidateAlone - a.liftVsCandidateAlone ||
          b.support - a.support ||
          a.companionSkill.localeCompare(b.companionSkill),
      );

    for (const rule of matching) {
      if (selected.length >= params.maxCompanions) break;

      if (selectedCompanions.has(rule.companionSkill)) continue;

      if (params.excludeSkills.has(rule.companionSkill)) {
        rejected.push({
          candidateSkill: rule.candidateSkill,
          companionSkill: rule.companionSkill,
          scenario,
          rejectedReason: "excluded",
        });
        continue;
      }

      selected.push({
        candidateSkill: rule.candidateSkill,
        companionSkill: rule.companionSkill,
        scenario,
        confidence: rule.liftVsCandidateAlone,
        reason: rule.reason,
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
      lift: s.confidence,
    })),
  });

  return { selected, checkedScenarios, rejected };
}
