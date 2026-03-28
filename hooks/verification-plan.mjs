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
function selectActiveStory(result) {
  if (result.activeStoryId) {
    const activeStory = result.stories.find((story) => story.id === result.activeStoryId);
    if (activeStory) return activeStory;
  }
  return selectPrimaryStory(result.stories);
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
  const storyStates = plan.stories.map((s) => {
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
        lastObservedAt: null
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
      lastObservedAt: ss.lastObservedAt
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
      updatedAt: s.updatedAt
    })),
    storyStates,
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
  const storyStates = (state.storyStates ?? []).map((ss) => ({
    storyId: ss.storyId,
    storyKind: ss.storyKind,
    route: ss.route,
    observationIds: ss.observationIds,
    satisfiedBoundaries: [...ss.satisfiedBoundaries].sort(),
    missingBoundaries: [...ss.missingBoundaries].sort(),
    recentRoutes: ss.recentRoutes,
    primaryNextAction: ss.primaryNextAction,
    blockedReasons: ss.blockedReasons,
    lastObservedAt: ss.lastObservedAt
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
      updatedAt: s.updatedAt
    })),
    storyStates,
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
  const story = selectActiveStory(result);
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
  const activeStory = selectActiveStory(result);
  if (activeStory) {
    const routePart = activeStory.route ? ` (${activeStory.route})` : "";
    lines.push(`Active story: ${activeStory.kind}${routePart}: "${activeStory.promptExcerpt}"`);
  }
  const satisfied = result.satisfiedBoundaries;
  const missing = result.missingBoundaries;
  lines.push(`Evidence: ${satisfied.length}/4 boundaries satisfied [${satisfied.join(", ") || "none"}]`);
  if (missing.length > 0) {
    lines.push(`Missing: ${missing.join(", ")}`);
  }
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
  const otherStories = result.stories.filter((s) => s.id !== (activeStory?.id ?? null));
  if (otherStories.length > 0) {
    lines.push("");
    lines.push("Other stories:");
    for (const story of otherStories) {
      const ss = result.storyStates?.find((st) => st.storyId === story.id);
      const satisfiedCount = ss ? ss.satisfiedBoundaries.length : 0;
      const routePart = story.route ? ` (${story.route})` : "";
      lines.push(`  ${story.kind}${routePart} \u2014 ${satisfiedCount}/4 boundaries satisfied`);
    }
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
  selectActiveStory,
  selectPrimaryStory
};
