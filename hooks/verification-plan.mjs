// hooks/src/verification-plan.mts
import {
  derivePlan,
  loadObservations,
  loadStories,
  loadPlanState
} from "./verification-ledger.mjs";
import { createLogger } from "./logger.mjs";
function selectPrimaryStory(stories) {
  if (stories.length === 0) return null;
  return [...stories].sort((a, b) => {
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  })[0];
}
function computePlan(sessionId, options, logger) {
  const log = logger ?? createLogger();
  const observations = loadObservations(sessionId, log);
  const stories = loadStories(sessionId, log);
  const plan = derivePlan(observations, stories, options);
  log.summary("verification-plan.computed", {
    sessionId,
    storyCount: stories.length,
    observationCount: observations.length,
    missingBoundaries: plan.missingBoundaries,
    hasNextAction: plan.primaryNextAction !== null
  });
  return planToResult(plan);
}
function planToResult(plan) {
  return {
    hasStories: plan.stories.length > 0,
    stories: plan.stories.map((s) => ({
      id: s.id,
      kind: s.kind,
      route: s.route,
      promptExcerpt: s.promptExcerpt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    })),
    observationCount: plan.observations.length,
    satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
    missingBoundaries: [...plan.missingBoundaries].sort(),
    recentRoutes: plan.recentRoutes,
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: plan.blockedReasons
  };
}
function loadCachedPlanResult(sessionId, logger) {
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
      updatedAt: s.updatedAt
    })),
    observationCount: state.observationIds.length,
    satisfiedBoundaries: [...state.satisfiedBoundaries].sort(),
    missingBoundaries: [...state.missingBoundaries].sort(),
    recentRoutes: state.recentRoutes,
    primaryNextAction: state.primaryNextAction,
    blockedReasons: state.blockedReasons
  };
}
function planToLoopSnapshot(plan) {
  const result = planToResult(plan);
  const last = plan.observations[plan.observations.length - 1] ?? null;
  if (!last) {
    return {
      ...result,
      lastObservation: null
    };
  }
  const meta = last.meta ?? {};
  return {
    ...result,
    lastObservation: {
      id: last.id,
      boundary: last.boundary,
      route: last.route,
      matchedSuggestedAction: typeof meta.matchedSuggestedAction === "boolean" ? meta.matchedSuggestedAction : null,
      suggestedBoundary: typeof meta.suggestedBoundary === "string" ? meta.suggestedBoundary : null,
      suggestedAction: typeof meta.suggestedAction === "string" ? meta.suggestedAction : null
    }
  };
}
function formatVerificationBanner(result) {
  if (!result.hasStories) return null;
  if (!result.primaryNextAction && result.missingBoundaries.length === 0) return null;
  const lines = ["<!-- verification-plan -->"];
  lines.push("**[Verification Plan]**");
  const story = selectPrimaryStory(result.stories);
  if (story) {
    const routePart = story.route ? ` (${story.route})` : "";
    lines.push(`Story: ${story.kind}${routePart} \u2014 "${story.promptExcerpt}"`);
  }
  const satisfied = result.satisfiedBoundaries;
  const missing = result.missingBoundaries;
  if (satisfied.length > 0 || missing.length > 0) {
    lines.push(`Evidence: ${satisfied.length}/4 boundaries satisfied [${satisfied.join(", ") || "none"}]`);
    if (missing.length > 0) {
      lines.push(`Missing: ${missing.join(", ")}`);
    }
  }
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
function formatPlanHuman(result) {
  if (!result.hasStories) {
    return "No verification stories active.\nNo observations recorded.\n";
  }
  const lines = [];
  lines.push("Stories:");
  for (const story of result.stories) {
    const routePart = story.route ? ` (${story.route})` : "";
    lines.push(`  ${story.kind}${routePart}: "${story.promptExcerpt}"`);
  }
  lines.push("");
  lines.push(`Observations: ${result.observationCount}`);
  lines.push(`Satisfied boundaries: ${result.satisfiedBoundaries.join(", ") || "none"}`);
  lines.push(`Missing boundaries: ${result.missingBoundaries.join(", ") || "none"}`);
  if (result.recentRoutes.length > 0) {
    lines.push(`Recent routes: ${result.recentRoutes.join(", ")}`);
  }
  lines.push("");
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
export {
  computePlan,
  formatPlanHuman,
  formatVerificationBanner,
  loadCachedPlanResult,
  planToLoopSnapshot,
  planToResult,
  selectPrimaryStory
};
