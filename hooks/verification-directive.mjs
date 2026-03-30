// hooks/src/verification-directive.mts
import {
  computePlan,
  formatVerificationBanner,
  loadCachedPlanResult,
  selectActiveStory
} from "./verification-plan.mjs";
import { createLogger, logCaughtError } from "./logger.mjs";
function buildVerificationDirective(plan) {
  if (!plan?.hasStories || plan.stories.length === 0) return null;
  const story = selectActiveStory(plan);
  if (!story) return null;
  return {
    version: 1,
    storyId: story.id,
    storyKind: story.kind,
    route: story.route,
    missingBoundaries: [...plan.missingBoundaries],
    satisfiedBoundaries: [...plan.satisfiedBoundaries],
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: [...plan.blockedReasons]
  };
}
function buildVerificationEnv(directive) {
  if (!directive?.primaryNextAction) {
    return {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "",
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "",
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "",
      VERCEL_PLUGIN_VERIFICATION_ACTION: ""
    };
  }
  return {
    VERCEL_PLUGIN_VERIFICATION_STORY_ID: directive.storyId,
    VERCEL_PLUGIN_VERIFICATION_ROUTE: directive.route ?? "",
    VERCEL_PLUGIN_VERIFICATION_BOUNDARY: directive.primaryNextAction.targetBoundary,
    VERCEL_PLUGIN_VERIFICATION_ACTION: directive.primaryNextAction.action
  };
}
function resolveVerificationRuntimeState(sessionId, options, logger) {
  const log = logger ?? createLogger();
  if (!sessionId) {
    log.debug("verification-directive.resolve-start", {
      sessionId: null,
      reason: "no-session"
    });
    return {
      plan: null,
      directive: null,
      banner: null,
      env: buildVerificationEnv(null)
    };
  }
  log.debug("verification-directive.resolve-start", { sessionId });
  try {
    let plan = loadCachedPlanResult(sessionId, log);
    if (plan?.hasStories) {
      log.debug("verification-directive.cache-hit", {
        sessionId,
        storyCount: plan.stories.length
      });
    } else {
      log.debug("verification-directive.cache-miss", { sessionId });
      plan = computePlan(sessionId, options, log);
    }
    if (!plan?.hasStories) {
      log.debug("verification-directive.fresh-empty", { sessionId });
      return {
        plan: null,
        directive: null,
        banner: null,
        env: buildVerificationEnv(null)
      };
    }
    log.debug("verification-directive.fresh-computed", {
      sessionId,
      storyCount: plan.stories.length,
      missingBoundaries: plan.missingBoundaries
    });
    const directive = buildVerificationDirective(plan);
    const env = buildVerificationEnv(directive);
    const banner = formatVerificationBanner(plan);
    log.summary("verification-directive.resolve-complete", {
      sessionId,
      storyId: directive?.storyId ?? null,
      route: directive?.route ?? null,
      hasDirective: directive !== null,
      hasBanner: banner !== null,
      envCleared: !directive?.primaryNextAction
    });
    return { plan, directive, banner, env };
  } catch (error) {
    logCaughtError(log, "verification-directive.resolve-failed", error, {
      sessionId
    });
    return {
      plan: null,
      directive: null,
      banner: null,
      env: buildVerificationEnv(null)
    };
  }
}
export {
  buildVerificationDirective,
  buildVerificationEnv,
  resolveVerificationRuntimeState
};
