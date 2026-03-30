/**
 * rule-distillation.mts — Verification-backed rule distiller.
 *
 * Reads routing decision traces, exposure ledgers, and verification outcomes,
 * mines repeated high-precision patterns that predict successful skills,
 * and distills them into a deterministic, reviewable rules artifact.
 */

import type { RoutingDecisionTrace, RankedSkillTrace } from "./routing-decision-trace.mjs";
import type { SkillExposure } from "./routing-policy-ledger.mjs";
import type {
  RoutingPolicyFile,
  RoutingBoundary,
  RoutingHookName,
  RoutingToolName,
} from "./routing-policy.mjs";
import { createLogger } from "./logger.mjs";
import { replayLearnedRules } from "./rule-replay.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LearnedRuleKind =
  | "promptPhrase"
  | "promptAllOf"
  | "promptNoneOf"
  | "pathPattern"
  | "bashPattern"
  | "importPattern"
  | "companion";

export interface LearnedRoutingRule {
  id: string;
  skill: string;
  kind: LearnedRuleKind;
  value: string | string[];
  scenario: {
    hook: RoutingHookName | "PostToolUse";
    storyKind: string | null;
    targetBoundary: RoutingBoundary | null;
    toolName: RoutingToolName;
    routeScope: string | null;
  };
  support: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  precision: number;
  lift: number;
  sourceDecisionIds: string[];
  confidence: "candidate" | "promote" | "holdout-fail";
  promotedAt: string | null;
}

export interface ReplayResult {
  baselineWins: number;
  baselineDirectiveWins: number;
  learnedWins: number;
  learnedDirectiveWins: number;
  deltaWins: number;
  deltaDirectiveWins: number;
  regressions: string[];
}

export interface PromotionStatus {
  accepted: boolean;
  errorCode: string | null;
  reason: string;
}

export interface LearnedRoutingRulesFile {
  version: 1;
  generatedAt: string;
  projectRoot: string;
  rules: LearnedRoutingRule[];
  replay: ReplayResult;
  promotion: PromotionStatus;
}

// ---------------------------------------------------------------------------
// Scoring primitives
// ---------------------------------------------------------------------------

export function computeRuleLift(input: {
  wins: number;
  support: number;
  scenarioWins: number;
  scenarioExposures: number;
}): number {
  const rulePrecision = input.wins / Math.max(input.support, 1);
  const scenarioPrecision =
    input.scenarioWins / Math.max(input.scenarioExposures, 1);
  if (scenarioPrecision === 0) return rulePrecision;
  return rulePrecision / scenarioPrecision;
}

export function classifyRuleConfidence(input: {
  support: number;
  precision: number;
  lift: number;
  regressions: number;
}): "candidate" | "promote" | "holdout-fail" {
  if (input.regressions > 0) return "holdout-fail";
  if (input.support >= 5 && input.precision >= 0.8 && input.lift >= 1.5)
    return "promote";
  if (input.support >= 3 && input.precision >= 0.65 && input.lift >= 1.1)
    return "candidate";
  return "holdout-fail";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic scenario key from trace context. */
function scenarioKeyFromTrace(
  trace: RoutingDecisionTrace,
): string {
  const story = trace.primaryStory;
  return [
    trace.hook,
    story.kind ?? "_",
    story.targetBoundary ?? "_",
    trace.toolName,
    story.storyRoute ?? "_",
  ].join("|");
}

/** Build a scenario descriptor from a trace. */
function scenarioFromTrace(trace: RoutingDecisionTrace): LearnedRoutingRule["scenario"] {
  const story = trace.primaryStory;
  return {
    hook: trace.hook as LearnedRoutingRule["scenario"]["hook"],
    storyKind: story.kind ?? null,
    targetBoundary: (story.targetBoundary as RoutingBoundary) ?? null,
    toolName: trace.toolName as RoutingToolName,
    routeScope: story.storyRoute ?? null,
  };
}

/** Infer a rule kind from a ranked skill's pattern info. */
function inferRuleKind(ranked: RankedSkillTrace, hook: string): LearnedRuleKind {
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

/** Extract the pattern value for a rule. */
function extractPatternValue(ranked: RankedSkillTrace, trace: RoutingDecisionTrace): string | string[] {
  if (ranked.pattern?.value) return ranked.pattern.value;
  // For prompt hooks without explicit pattern, use the tool target as a proxy
  if (trace.hook === "UserPromptSubmit") return trace.toolTarget || "";
  return trace.toolTarget || "";
}

/**
 * Composite key for grouping exposures into candidate rules.
 * Combines scenario + skill + kind + pattern value for uniqueness.
 */
function candidateKey(
  scenarioKey: string,
  skill: string,
  kind: LearnedRuleKind,
  value: string | string[],
): string {
  const v = Array.isArray(value) ? value.join(",") : value;
  return `${scenarioKey}|${skill}|${kind}|${v}`;
}

// ---------------------------------------------------------------------------
// Candidate accumulator
// ---------------------------------------------------------------------------

interface CandidateAccumulator {
  skill: string;
  kind: LearnedRuleKind;
  value: string | string[];
  scenario: LearnedRoutingRule["scenario"];
  scenarioKey: string;
  support: number;
  wins: number;
  directiveWins: number;
  staleMisses: number;
  sourceDecisionIds: string[];
}

// ---------------------------------------------------------------------------
// Core distillation
// ---------------------------------------------------------------------------

export interface DistillRulesParams {
  projectRoot: string;
  traces: RoutingDecisionTrace[];
  exposures: SkillExposure[];
  policy: RoutingPolicyFile;
  minSupport?: number;
  minPrecision?: number;
  minLift?: number;
  /** Override timestamp for deterministic output in tests. */
  generatedAt?: string;
}

export function distillRulesFromTrace(params: DistillRulesParams): LearnedRoutingRulesFile {
  const {
    projectRoot,
    traces,
    exposures,
    policy,
    minSupport = 5,
    minPrecision = 0.8,
    minLift = 1.5,
    generatedAt = new Date().toISOString(),
  } = params;

  const logger = createLogger("summary");

  logger.summary("distill_start", {
    traceCount: traces.length,
    exposureCount: exposures.length,
    minSupport,
    minPrecision,
    minLift,
  });

  // Index exposures by decisionId-like key (sessionId + skill + hook)
  const exposureByKey = new Map<string, SkillExposure>();
  for (const exp of exposures) {
    const key = `${exp.sessionId}|${exp.skill}|${exp.hook}|${exp.route ?? "_"}`;
    exposureByKey.set(key, exp);
  }

  // Phase 1: Extract candidates from traces
  const candidates = new Map<string, CandidateAccumulator>();

  // Scenario-level aggregate counters (for lift computation)
  const scenarioExposureCounts = new Map<string, number>();
  const scenarioWinCounts = new Map<string, number>();

  for (const trace of traces) {
    const sKey = scenarioKeyFromTrace(trace);
    const scenario = scenarioFromTrace(trace);

    for (const ranked of trace.ranked) {
      // Only consider skills that were actually injected (not dropped)
      if (ranked.droppedReason) continue;

      // Find corresponding exposure
      const expKey = `${trace.sessionId}|${ranked.skill}|${trace.hook}|${trace.primaryStory.storyRoute ?? "_"}`;
      const exposure = exposureByKey.get(expKey);

      // Only attribute from verified evidence
      if (!exposure) continue;
      // Only count candidate-role exposures for causal credit
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
          sourceDecisionIds: [],
        };
        candidates.set(cKey, acc);
      }

      acc.support++;
      acc.sourceDecisionIds.push(trace.decisionId);

      // Track scenario totals
      scenarioExposureCounts.set(
        sKey,
        (scenarioExposureCounts.get(sKey) ?? 0) + 1,
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
    scenarioCount: scenarioExposureCounts.size,
  });

  // Phase 2: Score and classify each candidate
  const rules: LearnedRoutingRule[] = [];

  for (const acc of candidates.values()) {
    const precision = acc.wins / Math.max(acc.support, 1);
    const scenarioWins = scenarioWinCounts.get(acc.scenarioKey) ?? 0;
    const scenarioExposures = scenarioExposureCounts.get(acc.scenarioKey) ?? 0;

    const lift = computeRuleLift({
      wins: acc.wins,
      support: acc.support,
      scenarioWins,
      scenarioExposures,
    });

    // No regressions at distillation time — replay gate handles that
    const confidence = classifyRuleConfidence({
      support: acc.support,
      precision,
      lift,
      regressions: 0,
    });

    const ruleId = `${acc.kind}:${acc.skill}:${Array.isArray(acc.value) ? acc.value.join("+") : acc.value}`;

    // Sort sourceDecisionIds for determinism
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
      promotedAt: confidence === "promote" ? generatedAt : null,
    });
  }

  logger.summary("distill_scoring_complete", {
    totalRules: rules.length,
    promoted: rules.filter((r) => r.confidence === "promote").length,
    candidate: rules.filter((r) => r.confidence === "candidate").length,
    holdoutFail: rules.filter((r) => r.confidence === "holdout-fail").length,
  });

  // Phase 3: Sort deterministically — by scenario key, then skill, then rule id
  rules.sort((a, b) => {
    const scenarioA = [a.scenario.hook, a.scenario.storyKind ?? "_", a.scenario.targetBoundary ?? "_", a.scenario.toolName, a.scenario.routeScope ?? "_"].join("|");
    const scenarioB = [b.scenario.hook, b.scenario.storyKind ?? "_", b.scenario.targetBoundary ?? "_", b.scenario.toolName, b.scenario.routeScope ?? "_"].join("|");
    const sc = scenarioA.localeCompare(scenarioB);
    if (sc !== 0) return sc;
    const sk = a.skill.localeCompare(b.skill);
    if (sk !== 0) return sk;
    return a.id.localeCompare(b.id);
  });

  // Phase 4: Replay gate
  const replay = replayLearnedRules({ traces, rules });

  // Determine promotion status
  let promotion: PromotionStatus;
  const rejected = replay.regressions.length > 0 || replay.learnedWins < replay.baselineWins;

  if (rejected) {
    // Downgrade promoted rules
    for (const rule of rules) {
      if (rule.confidence === "promote") {
        rule.confidence = "holdout-fail";
        rule.promotedAt = null;
      }
    }

    const reasons: string[] = [];
    if (replay.regressions.length > 0) {
      reasons.push(`${replay.regressions.length} regression(s) detected`);
    }
    if (replay.learnedWins < replay.baselineWins) {
      reasons.push(`learned wins (${replay.learnedWins}) < baseline wins (${replay.baselineWins})`);
    }

    promotion = {
      accepted: false,
      errorCode: "RULEBOOK_PROMOTION_REJECTED_REGRESSION",
      reason: `Promotion rejected: ${reasons.join("; ")}`,
    };

    logger.summary("distill_promotion_rejected", {
      errorCode: promotion.errorCode,
      reason: promotion.reason,
      regressions: replay.regressions.length,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins,
    });
  } else {
    const promotedCount = rules.filter((r) => r.confidence === "promote").length;
    promotion = {
      accepted: true,
      errorCode: null,
      reason: `Promotion accepted: ${promotedCount} rule(s) promoted, ${replay.learnedWins} learned wins, 0 regressions`,
    };

    logger.summary("distill_promotion_accepted", {
      promotedCount,
      learnedWins: replay.learnedWins,
      baselineWins: replay.baselineWins,
    });
  }

  logger.summary("distill_complete", {
    ruleCount: rules.length,
    replayDelta: replay.deltaWins,
    regressions: replay.regressions.length,
    promotionAccepted: promotion.accepted,
  });

  return {
    version: 1,
    generatedAt,
    projectRoot,
    rules,
    replay,
    promotion,
  };
}

// ---------------------------------------------------------------------------
// Re-export replayLearnedRules from rule-replay module for backward compat
// ---------------------------------------------------------------------------

export { replayLearnedRules } from "./rule-replay.mjs";
