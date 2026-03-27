/**
 * Verified Routing Policy Engine — pure deterministic core.
 *
 * Records skill exposures, resolves them against verification-boundary
 * outcomes, and applies bounded policy boosts during skill ranking.
 */

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
  const scenario = scenarioKey(input);
  const stats = ensureScenario(policy, scenario, input.skill, now);
  stats.exposures += 1;
  stats.lastUpdatedAt = now;
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
  const scenario = scenarioKey(input);
  const stats = ensureScenario(policy, scenario, input.skill, now);

  if (input.outcome === "win") {
    stats.wins += 1;
  } else if (input.outcome === "directive-win") {
    stats.wins += 1;
    stats.directiveWins += 1;
  } else {
    stats.staleMisses += 1;
  }

  stats.lastUpdatedAt = now;
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
  const scenario = scenarioKey(scenarioInput);
  const bucket = policy.scenarios[scenario] ?? {};

  return entries.map((entry) => {
    const stats = bucket[entry.skill];
    const boost = derivePolicyBoost(stats);
    const base = typeof entry.effectivePriority === "number"
      ? entry.effectivePriority
      : entry.priority;

    return {
      ...entry,
      effectivePriority: base + boost,
      policyBoost: boost,
      policyReason: stats
        ? `${scenario}: ${stats.wins} wins / ${stats.exposures} exposures, ${stats.directiveWins} directive wins, ${stats.staleMisses} stale misses`
        : null,
    };
  });
}
