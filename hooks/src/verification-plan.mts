/**
 * Verification Plan: compute a single ranked next verification action
 * from ledger state and surface it for hooks and CLI.
 *
 * This module is the bridge between the raw verification ledger
 * (observations + stories) and the surfaces that consume the plan
 * (PreToolUse banner, CLI command, subagent bootstrap).
 *
 * All public functions are pure or read-only — they load ledger state
 * and derive a plan but never mutate it.
 */

import {
  type VerificationPlan,
  type VerificationNextAction,
  type SerializedPlanState,
  derivePlan,
  loadObservations,
  loadStories,
  loadPlanState,
  serializePlanState,
} from "./verification-ledger.mjs";
import { createLogger, type Logger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Public plan result (JSON-serializable, shared by CLI and hooks)
// ---------------------------------------------------------------------------

export interface VerificationPlanStorySummary {
  id: string;
  kind: string;
  route: string | null;
  promptExcerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationPlanResult {
  /** Whether any verification stories exist. */
  hasStories: boolean;
  /** Active story summaries. */
  stories: VerificationPlanStorySummary[];
  /** Total observation count. */
  observationCount: number;
  /** Boundaries with at least one observation. */
  satisfiedBoundaries: string[];
  /** Boundaries still missing evidence. */
  missingBoundaries: string[];
  /** Recent routes observed. */
  recentRoutes: string[];
  /** The single best next verification action (null if none). */
  primaryNextAction: VerificationNextAction | null;
  /** Reasons certain actions were blocked. */
  blockedReasons: string[];
}

// ---------------------------------------------------------------------------
// Deterministic story selection
// ---------------------------------------------------------------------------

/**
 * Select the primary story from a list of summaries.
 * Prefers the most recently updated story, breaking ties by createdAt
 * (newest first), then by id (lexicographic ascending) for full determinism.
 */
export function selectPrimaryStory(
  stories: VerificationPlanStorySummary[],
): VerificationPlanStorySummary | null {
  if (stories.length === 0) return null;

  return [...stories].sort((a, b) => {
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;

    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;

    return a.id.localeCompare(b.id);
  })[0];
}

// ---------------------------------------------------------------------------
// Derive plan result from session state
// ---------------------------------------------------------------------------

export interface ComputePlanOptions {
  agentBrowserAvailable?: boolean;
  devServerLoopGuardHit?: boolean;
  lastAttemptedAction?: string | null;
  staleThresholdMs?: number;
}

/**
 * Load ledger state for a session and derive the current plan.
 * Returns a JSON-serializable result suitable for CLI and hook consumption.
 */
export function computePlan(
  sessionId: string,
  options?: ComputePlanOptions,
  logger?: Logger,
): VerificationPlanResult {
  const log = logger ?? createLogger();

  const observations = loadObservations(sessionId, log);
  const stories = loadStories(sessionId, log);
  const plan = derivePlan(observations, stories, options);

  log.summary("verification-plan.computed", {
    sessionId,
    storyCount: stories.length,
    observationCount: observations.length,
    missingBoundaries: plan.missingBoundaries,
    hasNextAction: plan.primaryNextAction !== null,
  });

  return planToResult(plan);
}

/**
 * Convert a VerificationPlan to a JSON-serializable result.
 */
export function planToResult(plan: VerificationPlan): VerificationPlanResult {
  return {
    hasStories: plan.stories.length > 0,
    stories: plan.stories.map((s) => ({
      id: s.id,
      kind: s.kind,
      route: s.route,
      promptExcerpt: s.promptExcerpt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    observationCount: plan.observations.length,
    satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
    missingBoundaries: [...plan.missingBoundaries].sort(),
    recentRoutes: plan.recentRoutes,
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: plan.blockedReasons,
  };
}

/**
 * Load the persisted plan state snapshot without re-deriving.
 * Returns null if no state exists. Faster than computePlan when
 * the caller only needs the last-persisted snapshot.
 */
export function loadCachedPlanResult(
  sessionId: string,
  logger?: Logger,
): VerificationPlanResult | null {
  const log = logger ?? createLogger();
  const state = loadPlanState(sessionId, log);
  if (!state) return null;

  return {
    hasStories: state.stories.length > 0,
    stories: state.stories.map((s) => ({
      id: s.id,
      kind: s.kind,
      route: s.route,
      promptExcerpt: s.promptExcerpt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    observationCount: state.observationIds.length,
    satisfiedBoundaries: [...state.satisfiedBoundaries].sort(),
    missingBoundaries: [...state.missingBoundaries].sort(),
    recentRoutes: state.recentRoutes,
    primaryNextAction: state.primaryNextAction,
    blockedReasons: state.blockedReasons,
  };
}

// ---------------------------------------------------------------------------
// Loop snapshot (extends plan result with last-observation adherence)
// ---------------------------------------------------------------------------

export interface VerificationLoopSnapshot extends VerificationPlanResult {
  lastObservation: {
    id: string;
    boundary: string | null;
    route: string | null;
    matchedSuggestedAction: boolean | null;
    suggestedBoundary: string | null;
    suggestedAction: string | null;
  } | null;
}

/**
 * Extend a VerificationPlan into a VerificationLoopSnapshot by extracting
 * the most recent observation's adherence metadata.
 */
export function planToLoopSnapshot(
  plan: VerificationPlan,
): VerificationLoopSnapshot {
  const result = planToResult(plan);
  const last = plan.observations[plan.observations.length - 1] ?? null;

  if (!last) {
    return {
      ...result,
      lastObservation: null,
    };
  }

  const meta = (last.meta ?? {}) as Record<string, unknown>;

  return {
    ...result,
    lastObservation: {
      id: last.id,
      boundary: last.boundary,
      route: last.route,
      matchedSuggestedAction:
        typeof meta.matchedSuggestedAction === "boolean"
          ? meta.matchedSuggestedAction
          : null,
      suggestedBoundary:
        typeof meta.suggestedBoundary === "string"
          ? meta.suggestedBoundary
          : null,
      suggestedAction:
        typeof meta.suggestedAction === "string"
          ? meta.suggestedAction
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// PreToolUse banner generation
// ---------------------------------------------------------------------------

/**
 * Format a compact verification banner for injection into PreToolUse additionalContext.
 * Returns null if there's nothing to surface (no stories or all boundaries satisfied).
 */
export function formatVerificationBanner(
  result: VerificationPlanResult,
): string | null {
  if (!result.hasStories) return null;
  if (!result.primaryNextAction && result.missingBoundaries.length === 0) return null;

  const lines: string[] = ["<!-- verification-plan -->"];
  lines.push("**[Verification Plan]**");

  // Current story — use deterministic selection
  const story = selectPrimaryStory(result.stories);
  if (story) {
    const routePart = story.route ? ` (${story.route})` : "";
    lines.push(`Story: ${story.kind}${routePart} — "${story.promptExcerpt}"`);
  }

  // Evidence summary
  const satisfied = result.satisfiedBoundaries;
  const missing = result.missingBoundaries;
  if (satisfied.length > 0 || missing.length > 0) {
    lines.push(`Evidence: ${satisfied.length}/4 boundaries satisfied [${satisfied.join(", ") || "none"}]`);
    if (missing.length > 0) {
      lines.push(`Missing: ${missing.join(", ")}`);
    }
  }

  // Next action
  if (result.primaryNextAction) {
    lines.push(`Next action: \`${result.primaryNextAction.action}\``);
    lines.push(`Reason: ${result.primaryNextAction.reason}`);
  } else if (result.blockedReasons.length > 0) {
    lines.push(`Blocked: ${result.blockedReasons[0]}`);
  } else {
    lines.push("All verification boundaries satisfied.");
  }

  lines.push("<!-- /verification-plan -->");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Human-readable CLI output
// ---------------------------------------------------------------------------

/**
 * Format a human-readable plan summary for terminal output.
 */
export function formatPlanHuman(result: VerificationPlanResult): string {
  if (!result.hasStories) {
    return "No verification stories active.\nNo observations recorded.\n";
  }

  const lines: string[] = [];

  // Stories
  lines.push("Stories:");
  for (const story of result.stories) {
    const routePart = story.route ? ` (${story.route})` : "";
    lines.push(`  ${story.kind}${routePart}: "${story.promptExcerpt}"`);
  }
  lines.push("");

  // Evidence
  lines.push(`Observations: ${result.observationCount}`);
  lines.push(`Satisfied boundaries: ${result.satisfiedBoundaries.join(", ") || "none"}`);
  lines.push(`Missing boundaries: ${result.missingBoundaries.join(", ") || "none"}`);

  if (result.recentRoutes.length > 0) {
    lines.push(`Recent routes: ${result.recentRoutes.join(", ")}`);
  }
  lines.push("");

  // Next action
  if (result.primaryNextAction) {
    lines.push(`Next action: ${result.primaryNextAction.action}`);
    lines.push(`  Target: ${result.primaryNextAction.targetBoundary}`);
    lines.push(`  Reason: ${result.primaryNextAction.reason}`);
  } else if (result.blockedReasons.length > 0) {
    lines.push("Next action: blocked");
    for (const reason of result.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
  } else if (result.missingBoundaries.length === 0) {
    lines.push("All verification boundaries satisfied.");
  } else {
    lines.push("No next action available.");
  }

  return lines.join("\n") + "\n";
}
