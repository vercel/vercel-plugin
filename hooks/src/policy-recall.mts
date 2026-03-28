/**
 * Route-Scoped Verified Policy Recall Selector
 *
 * Pure selector that picks at most one historically winning skill from the
 * project routing policy. Prefers exact-route buckets before wildcard fallback.
 * No filesystem access — operates entirely on the policy data structure.
 *
 * Thresholds inherit the same conservatism as derivePolicyBoost: minimum 3
 * exposures, minimum 65% success rate, and minimum +2 policy boost.
 */

import {
  derivePolicyBoost,
  scenarioKeyCandidates,
  type RoutingPolicyFile,
  type RoutingPolicyScenario,
  type RoutingPolicyStats,
} from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyRecallCandidate {
  skill: string;
  scenario: string;
  exposures: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  successRate: number;
  policyBoost: number;
  recallScore: number;
}

export interface PolicyRecallOptions {
  maxCandidates?: number;
  minExposures?: number;
  minSuccessRate?: number;
  minBoost?: number;
  excludeSkills?: Iterable<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function successRate(stats: RoutingPolicyStats): number {
  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  return weightedWins / Math.max(stats.exposures, 1);
}

function recallScore(stats: RoutingPolicyStats): number {
  return (
    derivePolicyBoost(stats) * 1000 +
    Math.round(successRate(stats) * 100) * 10 +
    stats.directiveWins * 5 +
    stats.wins -
    stats.staleMisses
  );
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Select at most `maxCandidates` (default 1) historically winning skills
 * from the project routing policy for a given scenario.
 *
 * Lookup order follows scenarioKeyCandidates: exact route first, then
 * wildcard, then legacy 4-part key. The first bucket that produces at
 * least one qualified candidate wins — no cross-bucket merging.
 *
 * Tie-breaking is deterministic: recallScore desc, exposures desc,
 * skill name asc (lexicographic).
 */
export function selectPolicyRecallCandidates(
  policy: RoutingPolicyFile,
  scenarioInput: RoutingPolicyScenario,
  options: PolicyRecallOptions = {},
): PolicyRecallCandidate[] {
  const maxCandidates = options.maxCandidates ?? 1;
  const minExposures = options.minExposures ?? 3;
  const minSuccessRate = options.minSuccessRate ?? 0.65;
  const minBoost = options.minBoost ?? 2;
  const exclude = new Set(options.excludeSkills ?? []);

  for (const scenario of scenarioKeyCandidates(scenarioInput)) {
    const bucket = policy.scenarios[scenario] ?? {};
    const candidates = Object.entries(bucket)
      .map(([skill, stats]) => ({
        skill,
        scenario,
        exposures: stats.exposures,
        wins: stats.wins,
        directiveWins: stats.directiveWins,
        staleMisses: stats.staleMisses,
        successRate: successRate(stats),
        policyBoost: derivePolicyBoost(stats),
        recallScore: recallScore(stats),
      }))
      .filter((entry) => !exclude.has(entry.skill))
      .filter((entry) => entry.exposures >= minExposures)
      .filter((entry) => entry.successRate >= minSuccessRate)
      .filter((entry) => entry.policyBoost >= minBoost)
      .sort(
        (a, b) =>
          b.recallScore - a.recallScore ||
          b.exposures - a.exposures ||
          a.skill.localeCompare(b.skill),
      );

    if (candidates.length > 0) {
      return candidates.slice(0, maxCandidates);
    }
  }

  return [];
}
