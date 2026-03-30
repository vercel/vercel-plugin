/**
 * Verified Routing Policy Engine — pure deterministic core.
 *
 * Records skill exposures, resolves them against verification-boundary
 * outcomes, and applies bounded policy boosts during skill ranking.
 *
 * Precedence rule: when a learned-routing-rulebook exists and contains a
 * matching rule for a (scenario, skill) pair, the rulebook boost is used
 * and the stats-policy boost is suppressed for that skill. This prevents
 * double-boosting from both systems.
 */

import type {
  LearnedRoutingRulebook,
  LearnedRoutingRule,
} from "./learned-routing-rulebook.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingBoundary =
  | "uiRender"
  | "clientRequest"
  | "serverHandler"
  | "environment";

export type RoutingHookName = "PreToolUse" | "UserPromptSubmit";

export type RoutingToolName =
  | "Read"
  | "Edit"
  | "Write"
  | "Bash"
  | "Prompt";

export interface RoutingPolicyScenario {
  hook: RoutingHookName;
  storyKind: string | null;
  targetBoundary: RoutingBoundary | null;
  toolName: RoutingToolName;
  routeScope?: string | null;
}

export interface RoutingPolicyStats {
  exposures: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  lastUpdatedAt: string;
}

export interface RoutingPolicyFile {
  version: 1;
  scenarios: Record<string, Record<string, RoutingPolicyStats>>;
}

export interface PolicyBoostExplanation {
  skill: string;
  scenario: string;
  boost: number;
  reason: string;
}

export interface RankableSkill {
  skill: string;
  priority: number;
  effectivePriority?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmptyRoutingPolicy(): RoutingPolicyFile {
  return {
    version: 1,
    scenarios: {},
  };
}

// ---------------------------------------------------------------------------
// Scenario key — deterministic, pipe-delimited
// ---------------------------------------------------------------------------

export function scenarioKey(input: RoutingPolicyScenario): string {
  return [
    input.hook,
    input.storyKind ?? "none",
    input.targetBoundary ?? "none",
    input.toolName,
  ].join("|");
}

export function scenarioKeyWithRoute(input: RoutingPolicyScenario): string {
  return [
    input.hook,
    input.storyKind ?? "none",
    input.targetBoundary ?? "none",
    input.toolName,
    input.routeScope ?? "*",
  ].join("|");
}

/**
 * Deterministic candidate lookup order:
 * 1. Exact route key (if routeScope is a non-wildcard string)
 * 2. Wildcard route key (hook|story|boundary|tool|*)
 * 3. Legacy 4-part key (hook|story|boundary|tool)
 */
export function scenarioKeyCandidates(input: RoutingPolicyScenario): string[] {
  const keys: string[] = [];
  if (input.routeScope && input.routeScope !== "*") {
    keys.push(scenarioKeyWithRoute(input));
  }
  keys.push(scenarioKeyWithRoute({ ...input, routeScope: "*" }));
  keys.push(scenarioKey(input)); // legacy fallback
  return [...new Set(keys)];
}

export function computePolicySuccessRate(stats: RoutingPolicyStats): number {
  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  return weightedWins / Math.max(stats.exposures, 1);
}

export function lookupPolicyStats(
  policy: RoutingPolicyFile,
  input: RoutingPolicyScenario,
  skill: string,
): { scenario: string | null; stats: RoutingPolicyStats | undefined } {
  for (const key of scenarioKeyCandidates(input)) {
    const stats = policy.scenarios[key]?.[skill];
    if (stats) return { scenario: key, stats };
  }
  return { scenario: null, stats: undefined };
}

// ---------------------------------------------------------------------------
// Ensure scenario + skill slot exists
// ---------------------------------------------------------------------------

export function ensureScenario(
  policy: RoutingPolicyFile,
  scenario: string,
  skill: string,
  now: string,
): RoutingPolicyStats {
  if (!policy.scenarios[scenario]) policy.scenarios[scenario] = {};
  if (!policy.scenarios[scenario][skill]) {
    policy.scenarios[scenario][skill] = {
      exposures: 0,
      wins: 0,
      directiveWins: 0,
      staleMisses: 0,
      lastUpdatedAt: now,
    };
  }
  return policy.scenarios[scenario][skill];
}

// ---------------------------------------------------------------------------
// Record an exposure (skill was injected)
// ---------------------------------------------------------------------------

export function recordExposure(
  policy: RoutingPolicyFile,
  input: RoutingPolicyScenario & { skill: string; now?: string },
): RoutingPolicyFile {
  const now = input.now ?? new Date().toISOString();
  for (const key of scenarioKeyCandidates(input)) {
    const stats = ensureScenario(policy, key, input.skill, now);
    stats.exposures += 1;
    stats.lastUpdatedAt = now;
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Record an outcome (verification boundary resolved)
// ---------------------------------------------------------------------------

export type RoutingOutcome = "win" | "directive-win" | "stale-miss";

export function recordOutcome(
  policy: RoutingPolicyFile,
  input: RoutingPolicyScenario & {
    skill: string;
    outcome: RoutingOutcome;
    now?: string;
  },
): RoutingPolicyFile {
  const now = input.now ?? new Date().toISOString();
  for (const key of scenarioKeyCandidates(input)) {
    const stats = ensureScenario(policy, key, input.skill, now);

    if (input.outcome === "win") {
      stats.wins += 1;
    } else if (input.outcome === "directive-win") {
      stats.wins += 1;
      stats.directiveWins += 1;
    } else {
      stats.staleMisses += 1;
    }

    stats.lastUpdatedAt = now;
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Derive a bounded policy boost from stats
// ---------------------------------------------------------------------------

export function derivePolicyBoost(stats: RoutingPolicyStats | undefined): number {
  if (!stats) return 0;
  if (stats.exposures < 3) return 0;

  const weightedWins = stats.wins + stats.directiveWins * 0.25;
  const successRate = weightedWins / Math.max(stats.exposures, 1);

  if (successRate >= 0.80) return 8;
  if (successRate >= 0.65) return 5;
  if (successRate >= 0.40) return 2;

  if (stats.exposures >= 5 && successRate < 0.15) return -2;
  return 0;
}

// ---------------------------------------------------------------------------
// Apply policy boosts to a set of rankable skills
// ---------------------------------------------------------------------------

export function applyPolicyBoosts<T extends RankableSkill>(
  entries: T[],
  policy: RoutingPolicyFile,
  scenarioInput: RoutingPolicyScenario,
): Array<T & { policyBoost: number; policyReason: string | null }> {
  return entries.map((entry) => {
    const { scenario, stats } = lookupPolicyStats(policy, scenarioInput, entry.skill);
    const boost = derivePolicyBoost(stats);
    const base = typeof entry.effectivePriority === "number"
      ? entry.effectivePriority
      : entry.priority;

    return {
      ...entry,
      effectivePriority: base + boost,
      policyBoost: boost,
      policyReason: stats && scenario
        ? `${scenario}: ${stats.wins} wins / ${stats.exposures} exposures, ${stats.directiveWins} directive wins, ${stats.staleMisses} stale misses`
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Rulebook match — find a matching learned rule for a (scenario, skill) pair
// ---------------------------------------------------------------------------

export interface RulebookMatchResult {
  rule: LearnedRoutingRule;
  matchedScenario: string;
}

/**
 * Look up a matching rulebook rule for a skill in a given scenario.
 * Checks scenario key candidates in precedence order (route-scoped first,
 * then wildcard, then legacy). Only "promote" rules contribute positive
 * boosts; "demote" rules contribute negative boosts.
 */
export function matchRulebookRule(
  rulebook: LearnedRoutingRulebook,
  scenarioInput: RoutingPolicyScenario,
  skill: string,
): RulebookMatchResult | null {
  if (rulebook.rules.length === 0) return null;

  for (const key of scenarioKeyCandidates(scenarioInput)) {
    const rule = rulebook.rules.find(
      (r) => r.scenario === key && r.skill === skill,
    );
    if (rule) return { rule, matchedScenario: key };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply rulebook boosts with precedence over stats-policy
// ---------------------------------------------------------------------------

export interface RulebookBoostExplanation {
  skill: string;
  matchedRuleId: string;
  ruleBoost: number;
  ruleReason: string;
  rulebookPath: string;
}

/**
 * Apply learned-rulebook boosts with explicit precedence over stats-policy.
 *
 * Precedence rule: when a rulebook rule matches a (scenario, skill) pair,
 * the rulebook boost replaces the stats-policy boost. The stats-policy
 * boost is zeroed out for that skill to prevent double-boosting.
 *
 * Skills without a matching rule keep their stats-policy boost unchanged.
 */
export function applyRulebookBoosts<
  T extends RankableSkill & { policyBoost: number; policyReason: string | null },
>(
  entries: T[],
  rulebook: LearnedRoutingRulebook,
  scenarioInput: RoutingPolicyScenario,
  rulebookFilePath: string,
): Array<
  T & {
    matchedRuleId: string | null;
    ruleBoost: number;
    ruleReason: string | null;
    rulebookPath: string | null;
  }
> {
  return entries.map((entry) => {
    const match = matchRulebookRule(rulebook, scenarioInput, entry.skill);
    if (!match) {
      return {
        ...entry,
        matchedRuleId: null,
        ruleBoost: 0,
        ruleReason: null,
        rulebookPath: null,
      };
    }

    const { rule } = match;
    const ruleBoost = rule.action === "promote" ? rule.boost : -rule.boost;

    // Precedence: subtract old stats-policy boost, apply rulebook boost instead
    const base = (typeof entry.effectivePriority === "number"
      ? entry.effectivePriority
      : entry.priority) - entry.policyBoost;

    return {
      ...entry,
      effectivePriority: base + ruleBoost,
      policyBoost: 0, // suppressed — rulebook takes precedence
      policyReason: null,
      matchedRuleId: rule.id,
      ruleBoost,
      ruleReason: rule.reason,
      rulebookPath: rulebookFilePath,
    };
  });
}
