/**
 * Routing Replay Analyzer: deterministic replay compiler that reads routing
 * traces and exposure ledgers, groups by policy scenario, and emits a stable
 * RoutingReplayReport with scenario summaries and bounded recommendations.
 *
 * Contract:
 * - Same trace input always yields byte-for-byte identical JSON output.
 * - Scenario ordering is stable (lexicographic).
 * - Skill ordering within scenarios is stable (wins desc, exposures desc, name asc).
 * - Recommendations are derived from observed behavior with bounded thresholds.
 */

import {
  readRoutingDecisionTrace,
  type RoutingDecisionTrace,
} from "./routing-decision-trace.mjs";
import { loadSessionExposures, type SkillExposure } from "./routing-policy-ledger.mjs";
import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingScenarioSummary {
  scenario: string;
  exposures: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  topSkills: Array<{
    skill: string;
    exposures: number;
    wins: number;
    directiveWins: number;
    staleMisses: number;
  }>;
}

export interface RoutingRecommendation {
  scenario: string;
  skill: string;
  action: "promote" | "demote" | "investigate";
  suggestedBoost: number;
  confidence: number;
  reason: string;
}

export interface RoutingReplayReport {
  version: 1;
  sessionId: string;
  traceCount: number;
  scenarioCount: number;
  scenarios: RoutingScenarioSummary[];
  recommendations: RoutingRecommendation[];
}

// ---------------------------------------------------------------------------
// Scenario key builder
// ---------------------------------------------------------------------------

function buildScenarioKey(exposure: SkillExposure): string {
  return [
    exposure.hook,
    exposure.storyKind ?? "none",
    exposure.targetBoundary ?? "none",
    exposure.toolName,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Skill stats accumulator
// ---------------------------------------------------------------------------

interface SkillStats {
  exposures: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
}

function emptyStats(): SkillStats {
  return { exposures: 0, wins: 0, directiveWins: 0, staleMisses: 0 };
}

// ---------------------------------------------------------------------------
// Recommendation thresholds (bounded — matches derivePolicyBoost semantics)
// ---------------------------------------------------------------------------

const PROMOTE_MIN_EXPOSURES = 3;
const PROMOTE_MIN_SUCCESS_RATE = 0.8;
const PROMOTE_BOOST = 8;

const DEMOTE_MIN_EXPOSURES = 5;
const DEMOTE_MAX_SUCCESS_RATE = 0.15;
const DEMOTE_BOOST = -2;

const INVESTIGATE_MIN_EXPOSURES = 3;
const INVESTIGATE_MIN_RATE = 0.4;
const INVESTIGATE_MAX_RATE = 0.65;

// ---------------------------------------------------------------------------
// Core replay
// ---------------------------------------------------------------------------

export function replayRoutingSession(sessionId: string): RoutingReplayReport {
  const log = createLogger();

  log.summary("replay_start", { sessionId });

  const traces = readRoutingDecisionTrace(sessionId);
  const exposures = loadSessionExposures(sessionId);

  log.debug("replay_loaded", {
    sessionId,
    traceCount: traces.length,
    exposureCount: exposures.length,
  });

  // Group exposures by scenario → skill
  const buckets = new Map<string, Map<string, SkillStats>>();

  // Seed scenario keys from traces so empty scenarios still appear
  for (const trace of traces) {
    const scenario = trace.policyScenario;
    if (scenario && !buckets.has(scenario)) {
      buckets.set(scenario, new Map<string, SkillStats>());
    }
  }

  // Accumulate exposure outcomes
  for (const exposure of exposures) {
    const scenario = buildScenarioKey(exposure);
    let bySkill = buckets.get(scenario);
    if (!bySkill) {
      bySkill = new Map<string, SkillStats>();
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
    // "pending" contributes only to exposure count

    bySkill.set(exposure.skill, current);
  }

  // Build deterministic scenario summaries
  const scenarios: RoutingScenarioSummary[] = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scenario, bySkill]) => {
      const topSkills = [...bySkill.entries()]
        .map(([skill, stats]) => ({ skill, ...stats }))
        .sort(
          (a, b) =>
            b.wins - a.wins ||
            b.exposures - a.exposures ||
            a.skill.localeCompare(b.skill),
        );

      return {
        scenario,
        exposures: topSkills.reduce((n, s) => n + s.exposures, 0),
        wins: topSkills.reduce((n, s) => n + s.wins, 0),
        directiveWins: topSkills.reduce((n, s) => n + s.directiveWins, 0),
        staleMisses: topSkills.reduce((n, s) => n + s.staleMisses, 0),
        topSkills,
      };
    });

  // Derive bounded recommendations
  const recommendations: RoutingRecommendation[] = [];

  for (const scenario of scenarios) {
    for (const skill of scenario.topSkills) {
      const successRate =
        skill.exposures === 0 ? 0 : skill.wins / skill.exposures;

      if (
        skill.exposures >= PROMOTE_MIN_EXPOSURES &&
        successRate >= PROMOTE_MIN_SUCCESS_RATE
      ) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "promote",
          suggestedBoost: PROMOTE_BOOST,
          confidence: Math.min(0.99, successRate),
          reason: `${skill.wins}/${skill.exposures} wins in ${scenario.scenario}`,
        });
      } else if (
        skill.exposures >= DEMOTE_MIN_EXPOSURES &&
        successRate < DEMOTE_MAX_SUCCESS_RATE
      ) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "demote",
          suggestedBoost: DEMOTE_BOOST,
          confidence: 1 - successRate,
          reason: `${skill.wins}/${skill.exposures} wins in ${scenario.scenario}`,
        });
      } else if (
        skill.exposures >= INVESTIGATE_MIN_EXPOSURES &&
        successRate >= INVESTIGATE_MIN_RATE &&
        successRate < INVESTIGATE_MAX_RATE
      ) {
        recommendations.push({
          scenario: scenario.scenario,
          skill: skill.skill,
          action: "investigate",
          suggestedBoost: 0,
          confidence: successRate,
          reason: `${skill.wins}/${skill.exposures} mixed results in ${scenario.scenario}`,
        });
      }
    }
  }

  recommendations.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.skill.localeCompare(b.skill),
  );

  log.summary("replay_complete", {
    sessionId,
    traceCount: traces.length,
    scenarioCount: scenarios.length,
    recommendationCount: recommendations.length,
  });

  return {
    version: 1,
    sessionId,
    traceCount: traces.length,
    scenarioCount: scenarios.length,
    scenarios,
    recommendations,
  };
}
