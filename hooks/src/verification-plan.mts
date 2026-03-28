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
  type VerificationStoryState,
  type SerializedPlanStateV2,
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

export interface VerificationPlanStoryStateSummary {
  storyId: string;
  storyKind: string;
  route: string | null;
  observationIds: string[];
  satisfiedBoundaries: string[];
  missingBoundaries: string[];
  recentRoutes: string[];
  primaryNextAction: VerificationNextAction | null;
  blockedReasons: string[];
  lastObservedAt: string | null;
}

export interface VerificationPlanResult {
  /** Whether any verification stories exist. */
  hasStories: boolean;
  /** Active story id. */
  activeStoryId: string | null;
  /** Active story summaries. */
  stories: VerificationPlanStorySummary[];
  /** Per-story state summaries. */
  storyStates: VerificationPlanStoryStateSummary[];
  /** Total observation count. */
  observationCount: number;
  /** Boundaries with at least one observation (active-story projection). */
  satisfiedBoundaries: string[];
  /** Boundaries still missing evidence (active-story projection). */
  missingBoundaries: string[];
  /** Recent routes observed (active-story projection). */
  recentRoutes: string[];
  /** The single best next verification action (active-story projection). */
  primaryNextAction: VerificationNextAction | null;
  /** Reasons certain actions were blocked (active-story projection). */
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

export function selectActiveStory(
  result: Pick<VerificationPlanResult, "activeStoryId" | "stories">,
): VerificationPlanStorySummary | null {
  if (result.activeStoryId) {
    const activeStory = result.stories.find((story) => story.id === result.activeStoryId);
    if (activeStory) return activeStory;
  }
  return selectPrimaryStory(result.stories);
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
  const storyStates: VerificationPlanStoryStateSummary[] = plan.stories.map((s) => {
    const ss = plan.storyStates[s.id];
    if (!ss) {
      return {
        storyId: s.id,
        storyKind: s.kind,
        route: s.route,
        observationIds: [],
        satisfiedBoundaries: [],
        missingBoundaries: [],
        recentRoutes: [],
        primaryNextAction: null,
        blockedReasons: [],
        lastObservedAt: null,
      };
    }
    return {
      storyId: ss.storyId,
      storyKind: ss.storyKind,
      route: ss.route,
      observationIds: ss.observationIds,
      satisfiedBoundaries: [...ss.satisfiedBoundaries].sort(),
      missingBoundaries: [...ss.missingBoundaries].sort(),
      recentRoutes: ss.recentRoutes,
      primaryNextAction: ss.primaryNextAction,
      blockedReasons: ss.blockedReasons,
      lastObservedAt: ss.lastObservedAt,
    };
  });

  return {
    hasStories: plan.stories.length > 0,
    activeStoryId: plan.activeStoryId,
    stories: plan.stories.map((s) => ({
      id: s.id,
      kind: s.kind,
      route: s.route,
      promptExcerpt: s.promptExcerpt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    storyStates,
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

  const storyStates: VerificationPlanStoryStateSummary[] = (state.storyStates ?? []).map((ss) => ({
    storyId: ss.storyId,
    storyKind: ss.storyKind,
    route: ss.route,
    observationIds: ss.observationIds,
    satisfiedBoundaries: [...ss.satisfiedBoundaries].sort(),
    missingBoundaries: [...ss.missingBoundaries].sort(),
    recentRoutes: ss.recentRoutes,
    primaryNextAction: ss.primaryNextAction,
    blockedReasons: ss.blockedReasons,
    lastObservedAt: ss.lastObservedAt,
  }));

  return {
    hasStories: state.stories.length > 0,
    activeStoryId: state.activeStoryId ?? null,
    stories: state.stories.map((s) => ({
      id: s.id,
      kind: s.kind,
      route: s.route,
      promptExcerpt: s.promptExcerpt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    storyStates,
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
  const story = selectActiveStory(result);
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
 *
 * When multiple stories exist, highlights the active story and appends
 * a compact summary of other stories with their progress.
 */
export function formatPlanHuman(result: VerificationPlanResult): string {
  if (!result.hasStories) {
    return "No verification stories active.\nNo observations recorded.\n";
  }

  const lines: string[] = [];

  // Active story header
  const activeStory = selectActiveStory(result);

  if (activeStory) {
    const routePart = activeStory.route ? ` (${activeStory.route})` : "";
    lines.push(`Active story: ${activeStory.kind}${routePart}: "${activeStory.promptExcerpt}"`);
  }

  // Evidence for active story
  const satisfied = result.satisfiedBoundaries;
  const missing = result.missingBoundaries;
  lines.push(`Evidence: ${satisfied.length}/4 boundaries satisfied [${satisfied.join(", ") || "none"}]`);
  if (missing.length > 0) {
    lines.push(`Missing: ${missing.join(", ")}`);
  }

  // Next action with reason
  if (result.primaryNextAction) {
    lines.push(`Next action: ${result.primaryNextAction.action}`);
    lines.push(`  Reason: ${result.primaryNextAction.reason}`);
  } else if (result.blockedReasons.length > 0) {
    lines.push("Next action: blocked");
    for (const reason of result.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
  } else if (missing.length === 0) {
    lines.push("All verification boundaries satisfied.");
  } else {
    lines.push("No next action available.");
  }

  // Compact summary of other stories
  const otherStories = result.stories.filter((s) => s.id !== (activeStory?.id ?? null));
  if (otherStories.length > 0) {
    lines.push("");
    lines.push("Other stories:");
    for (const story of otherStories) {
      const ss = result.storyStates?.find((st) => st.storyId === story.id);
      const satisfiedCount = ss ? ss.satisfiedBoundaries.length : 0;
      const routePart = story.route ? ` (${story.route})` : "";
      lines.push(`  ${story.kind}${routePart} — ${satisfiedCount}/4 boundaries satisfied`);
    }
  }

  return lines.join("\n") + "\n";
}
