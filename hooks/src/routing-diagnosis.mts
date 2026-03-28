/**
 * Pure route-recall diagnosis engine with deterministic why-not output.
 *
 * All functions are pure — no filesystem access, no side effects.
 * Designed for hooks, CLI, tests, and downstream agent consumers.
 */

import {
  computePolicySuccessRate,
  derivePolicyBoost,
  scenarioKeyCandidates,
  type RoutingBoundary,
  type RoutingHookName,
  type RoutingPolicyFile,
  type RoutingPolicyScenario,
  type RoutingPolicyStats,
  type RoutingToolName,
} from "./routing-policy.mjs";
import { selectPolicyRecallCandidates } from "./policy-recall.mjs";

const POLICY_RECALL_MIN_EXPOSURES = 3;
const POLICY_RECALL_MIN_SUCCESS_RATE = 0.65;
const POLICY_RECALL_MIN_BOOST = 2;

const HOOK_NAMES: RoutingHookName[] = ["PreToolUse", "UserPromptSubmit"];
const TOOL_NAMES: RoutingToolName[] = ["Read", "Edit", "Write", "Bash", "Prompt"];
const BOUNDARIES: RoutingBoundary[] = [
  "uiRender",
  "clientRequest",
  "serverHandler",
  "environment",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingDiagnosisAction {
  type:
    | "collect_more_exposures"
    | "improve_success_rate"
    | "seed_exact_route_history"
    | "candidate_already_present"
    | "selected_bucket_precedence"
    | "no_history";
  skill?: string;
  scenario?: string;
  remainingExposures?: number;
}

export interface RoutingDiagnosisHint {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  hint?: string;
  action?: RoutingDiagnosisAction;
}

export interface PolicyRecallSelectedCandidate {
  skill: string;
  scenario: string;
  exposures: number;
  wins: number;
  directiveWins: number;
  successRate: number;
  policyBoost: number;
  recallScore: number;
  staleMisses?: number;
}

export interface PolicyRecallCandidateDiagnosis {
  skill: string;
  scenario: string;
  exposures: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  successRate: number;
  policyBoost: number;
  recallScore: number;
  qualified: boolean;
  excluded: boolean;
  rejectedReason: string | null;
}

export interface PolicyRecallBucketDiagnosis {
  scenario: string;
  skillCount: number;
  qualifiedCount: number;
  selected: boolean;
}

export interface PolicyRecallDiagnosis {
  eligible: boolean;
  skipReason: string | null;
  checkedScenarios: PolicyRecallBucketDiagnosis[];
  selectedBucket: string | null;
  selected: PolicyRecallCandidateDiagnosis[];
  rejected: PolicyRecallCandidateDiagnosis[];
  hints: RoutingDiagnosisHint[];
}

export interface ExplainPolicyRecallOptions {
  excludeSkills?: Set<string>;
  maxCandidates?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number): number {
  return Number(value.toFixed(4));
}

function diagnosticRecallScore(stats: RoutingPolicyStats): number {
  return round(
    derivePolicyBoost(stats) * 1000 +
      computePolicySuccessRate(stats) * 100 +
      stats.exposures,
  );
}

function qualifies(stats: RoutingPolicyStats): {
  successRate: number;
  policyBoost: number;
  qualified: boolean;
} {
  const successRate = round(computePolicySuccessRate(stats));
  const policyBoost = derivePolicyBoost(stats);
  const qualified =
    stats.exposures >= POLICY_RECALL_MIN_EXPOSURES &&
    successRate >= POLICY_RECALL_MIN_SUCCESS_RATE &&
    policyBoost >= POLICY_RECALL_MIN_BOOST;
  return { successRate, policyBoost, qualified };
}

function pushHint(
  target: RoutingDiagnosisHint[],
  hint: RoutingDiagnosisHint,
): void {
  const key = JSON.stringify([
    hint.code,
    hint.action?.type ?? null,
    hint.action?.skill ?? null,
    hint.action?.scenario ?? null,
  ]);
  const exists = target.some((existing) => {
    const existingKey = JSON.stringify([
      existing.code,
      existing.action?.type ?? null,
      existing.action?.skill ?? null,
      existing.action?.scenario ?? null,
    ]);
    return existingKey === key;
  });
  if (!exists) {
    target.push(hint);
  }
}

function isHookName(value: string): value is RoutingHookName {
  return HOOK_NAMES.includes(value as RoutingHookName);
}

function isToolName(value: string): value is RoutingToolName {
  return TOOL_NAMES.includes(value as RoutingToolName);
}

function isBoundary(value: string): value is RoutingBoundary {
  return BOUNDARIES.includes(value as RoutingBoundary);
}

// ---------------------------------------------------------------------------
// parsePolicyScenario
// ---------------------------------------------------------------------------

export function parsePolicyScenario(
  value: string | null,
): RoutingPolicyScenario | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length < 4) return null;

  const [hook, storyKind, targetBoundary, toolName, routeScope] = parts;
  if (!isHookName(hook) || !isToolName(toolName)) {
    return null;
  }

  return {
    hook,
    storyKind: storyKind === "none" ? null : storyKind,
    targetBoundary:
      targetBoundary === "none"
        ? null
        : isBoundary(targetBoundary)
          ? targetBoundary
          : null,
    toolName,
    routeScope:
      typeof routeScope === "string" && routeScope.length > 0
        ? routeScope
        : null,
  };
}

// ---------------------------------------------------------------------------
// candidateFromStats (rejected candidates only)
// ---------------------------------------------------------------------------

function candidateFromStats(
  skill: string,
  scenario: string,
  stats: RoutingPolicyStats,
  selectedBucket: string | null,
  selectedSkills: Set<string>,
  excludeSkills: Set<string>,
): PolicyRecallCandidateDiagnosis | null {
  // Skip candidates that are already in the selected set
  if (selectedBucket === scenario && selectedSkills.has(skill)) {
    return null;
  }

  const { successRate, policyBoost, qualified } = qualifies(stats);
  const excluded = excludeSkills.has(skill);
  let rejectedReason: string | null = null;

  if (selectedBucket && scenario !== selectedBucket) {
    rejectedReason = `shadowed_by_selected_bucket:${selectedBucket}`;
  } else if (excluded) {
    rejectedReason = "already_ranked_or_injected";
  } else if (stats.exposures < POLICY_RECALL_MIN_EXPOSURES) {
    rejectedReason = `needs_${POLICY_RECALL_MIN_EXPOSURES - stats.exposures}_more_exposures`;
  } else if (qualified) {
    rejectedReason = "lost_tiebreak_in_selected_bucket";
  } else if (successRate < POLICY_RECALL_MIN_SUCCESS_RATE) {
    rejectedReason = `success_rate_${successRate.toFixed(3)}_below_${POLICY_RECALL_MIN_SUCCESS_RATE.toFixed(3)}`;
  } else if (policyBoost < POLICY_RECALL_MIN_BOOST) {
    rejectedReason = `policy_boost_${policyBoost}_below_${POLICY_RECALL_MIN_BOOST}`;
  }

  return {
    skill,
    scenario,
    exposures: stats.exposures,
    wins: stats.wins,
    directiveWins: stats.directiveWins,
    staleMisses: stats.staleMisses,
    successRate,
    policyBoost,
    recallScore: diagnosticRecallScore(stats),
    qualified,
    excluded,
    rejectedReason,
  };
}

// ---------------------------------------------------------------------------
// buildHints
// ---------------------------------------------------------------------------

function buildHints(
  input: RoutingPolicyScenario,
  diagnosis: PolicyRecallDiagnosis,
): RoutingDiagnosisHint[] {
  const hints: RoutingDiagnosisHint[] = [];
  const preferredExactScenario = scenarioKeyCandidates(input)[0] ?? null;

  if (
    diagnosis.selectedBucket &&
    diagnosis.selectedBucket.endsWith("|*")
  ) {
    pushHint(hints, {
      severity: "info",
      code: "POLICY_RECALL_USING_WILDCARD_ROUTE",
      message: `Policy recall is selecting the wildcard bucket for ${input.toolName}`,
      hint: "Collect exact-route wins for the active route so recall can promote from * to the concrete route key",
      action: {
        type: "seed_exact_route_history",
        scenario: preferredExactScenario ?? undefined,
      },
    });
  }

  if (
    diagnosis.checkedScenarios.every((bucket) => bucket.skillCount === 0)
  ) {
    pushHint(hints, {
      severity: "info",
      code: "POLICY_RECALL_NO_HISTORY",
      message: "No routing-policy history exists for this scenario",
      hint: "Let the current verification loop complete once to seed exposures and outcomes",
      action: {
        type: "no_history",
        scenario: preferredExactScenario ?? undefined,
      },
    });
  }

  const needsExposure = diagnosis.rejected.find(
    (candidate) =>
      typeof candidate.rejectedReason === "string" &&
      candidate.rejectedReason.startsWith("needs_"),
  );
  if (needsExposure) {
    pushHint(hints, {
      severity: "warning",
      code: "POLICY_RECALL_NEEDS_EXPOSURES",
      message: `${needsExposure.skill} is close to qualifying but needs more exposures`,
      hint: `Record ${POLICY_RECALL_MIN_EXPOSURES - needsExposure.exposures} more exposure(s) for ${needsExposure.scenario}`,
      action: {
        type: "collect_more_exposures",
        skill: needsExposure.skill,
        scenario: needsExposure.scenario,
        remainingExposures:
          POLICY_RECALL_MIN_EXPOSURES - needsExposure.exposures,
      },
    });
  }

  const lowSuccess = diagnosis.rejected.find(
    (candidate) =>
      typeof candidate.rejectedReason === "string" &&
      candidate.rejectedReason.startsWith("success_rate_"),
  );
  if (lowSuccess) {
    pushHint(hints, {
      severity: "warning",
      code: "POLICY_RECALL_LOW_SUCCESS_RATE",
      message: `${lowSuccess.skill} has history, but its success rate is below the recall threshold`,
      hint: "Inspect stale misses and directive adherence before trusting policy recall here",
      action: {
        type: "improve_success_rate",
        skill: lowSuccess.skill,
        scenario: lowSuccess.scenario,
      },
    });
  }

  const alreadyPresent = diagnosis.rejected.find(
    (candidate) =>
      candidate.rejectedReason === "already_ranked_or_injected",
  );
  if (alreadyPresent) {
    pushHint(hints, {
      severity: "info",
      code: "POLICY_RECALL_ALREADY_PRESENT",
      message: `${alreadyPresent.skill} already exists in the ranked or injected set`,
      hint: "No recall action is needed; the candidate is already present via direct routing or prior injection",
      action: {
        type: "candidate_already_present",
        skill: alreadyPresent.skill,
        scenario: alreadyPresent.scenario,
      },
    });
  }

  const precedence = diagnosis.rejected.find(
    (candidate) =>
      typeof candidate.rejectedReason === "string" &&
      candidate.rejectedReason.startsWith("shadowed_by_selected_bucket:"),
  );
  if (precedence) {
    pushHint(hints, {
      severity: "info",
      code: "POLICY_RECALL_PRECEDENCE_APPLIED",
      message:
        "A higher-precedence bucket won, so lower-precedence buckets were intentionally ignored",
      hint: "This is expected: exact route > wildcard route > legacy 4-part key",
      action: {
        type: "selected_bucket_precedence",
        skill: precedence.skill,
        scenario: diagnosis.selectedBucket ?? precedence.scenario,
      },
    });
  }

  return hints;
}

// ---------------------------------------------------------------------------
// explainPolicyRecall
// ---------------------------------------------------------------------------

export function explainPolicyRecall(
  policy: RoutingPolicyFile,
  input: RoutingPolicyScenario,
  options: ExplainPolicyRecallOptions = {},
): PolicyRecallDiagnosis {
  const excludeSkills = options.excludeSkills ?? new Set<string>();
  const maxCandidates = options.maxCandidates ?? 1;

  if (!input.targetBoundary) {
    return {
      eligible: false,
      skipReason: "no_target_boundary",
      checkedScenarios: [],
      selectedBucket: null,
      selected: [],
      rejected: [],
      hints: [],
    };
  }

  const selectedRaw = selectPolicyRecallCandidates(policy, input, {
    maxCandidates,
    excludeSkills,
  }) as PolicyRecallSelectedCandidate[];

  const selectedBucket = selectedRaw[0]?.scenario ?? null;
  const selectedSkills = new Set(
    selectedRaw.map((candidate) => candidate.skill),
  );

  const checkedScenarios = scenarioKeyCandidates(input).map((scenario) => {
    const bucket = policy.scenarios[scenario] ?? {};
    const qualifiedCount = Object.entries(bucket).filter(([, stats]) => {
      const { qualified } = qualifies(stats);
      return qualified;
    }).length;
    return {
      scenario,
      skillCount: Object.keys(bucket).length,
      qualifiedCount,
      selected: scenario === selectedBucket,
    };
  });

  const selected = selectedRaw.map((candidate) => ({
    skill: candidate.skill,
    scenario: candidate.scenario,
    exposures: candidate.exposures,
    wins: candidate.wins,
    directiveWins: candidate.directiveWins,
    staleMisses: candidate.staleMisses ?? 0,
    successRate: round(candidate.successRate),
    policyBoost: candidate.policyBoost,
    recallScore: candidate.recallScore,
    qualified: true,
    excluded: false,
    rejectedReason: null,
  }));

  const rejected: PolicyRecallCandidateDiagnosis[] = [];
  for (const scenario of scenarioKeyCandidates(input)) {
    const bucket = policy.scenarios[scenario] ?? {};
    for (const [skill, stats] of Object.entries(bucket)) {
      const candidate = candidateFromStats(
        skill,
        scenario,
        stats,
        selectedBucket,
        selectedSkills,
        excludeSkills,
      );
      if (candidate) {
        rejected.push(candidate);
      }
    }
  }

  const diagnosis: PolicyRecallDiagnosis = {
    eligible: true,
    skipReason: null,
    checkedScenarios,
    selectedBucket,
    selected,
    rejected,
    hints: [],
  };

  diagnosis.hints = buildHints(input, diagnosis);
  return diagnosis;
}
