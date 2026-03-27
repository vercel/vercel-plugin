/**
 * Shared Verification Directive Contract
 *
 * Extracts the verification directive, env builder, and runtime state resolver
 * from subagent-start-bootstrap so that top-level hooks and subagents consume
 * the same contract. The directive includes `route` alongside story/boundary/action.
 *
 * Key guarantees:
 * - buildVerificationEnv(null) deterministically returns clearing values for all
 *   four env keys (STORY_ID, ROUTE, BOUNDARY, ACTION).
 * - resolveVerificationRuntimeState is idempotent and safe to retry.
 * - All state transitions emit structured log lines with sessionId context.
 */

import {
  computePlan,
  formatVerificationBanner,
  loadCachedPlanResult,
  selectPrimaryStory,
  type ComputePlanOptions,
  type VerificationPlanResult,
} from "./verification-plan.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Directive contract
// ---------------------------------------------------------------------------

export interface VerificationDirective {
  version: 1;
  storyId: string;
  storyKind: string;
  route: string | null;
  missingBoundaries: string[];
  satisfiedBoundaries: string[];
  primaryNextAction: VerificationPlanResult["primaryNextAction"];
  blockedReasons: string[];
}

export interface VerificationRuntimeState {
  plan: VerificationPlanResult | null;
  directive: VerificationDirective | null;
  banner: string | null;
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Directive builder
// ---------------------------------------------------------------------------

export function buildVerificationDirective(
  plan: VerificationPlanResult | null,
): VerificationDirective | null {
  if (!plan?.hasStories || plan.stories.length === 0) return null;

  const story = selectPrimaryStory(plan.stories);
  if (!story) return null;

  return {
    version: 1,
    storyId: story.id,
    storyKind: story.kind,
    route: story.route,
    missingBoundaries: [...plan.missingBoundaries],
    satisfiedBoundaries: [...plan.satisfiedBoundaries],
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: [...plan.blockedReasons],
  };
}

// ---------------------------------------------------------------------------
// Env builder — deterministic clearing when directive is null
// ---------------------------------------------------------------------------

/**
 * Build environment variables from a verification directive.
 * When directive is null or has no primary action, returns empty-string
 * clearing values for all four keys so stale env cannot bleed across
 * tool calls.
 */
export function buildVerificationEnv(
  directive: VerificationDirective | null,
): Record<string, string> {
  if (!directive?.primaryNextAction) {
    return {
      VERCEL_PLUGIN_VERIFICATION_STORY_ID: "",
      VERCEL_PLUGIN_VERIFICATION_ROUTE: "",
      VERCEL_PLUGIN_VERIFICATION_BOUNDARY: "",
      VERCEL_PLUGIN_VERIFICATION_ACTION: "",
    };
  }

  return {
    VERCEL_PLUGIN_VERIFICATION_STORY_ID: directive.storyId,
    VERCEL_PLUGIN_VERIFICATION_ROUTE: directive.route ?? "",
    VERCEL_PLUGIN_VERIFICATION_BOUNDARY: directive.primaryNextAction.targetBoundary,
    VERCEL_PLUGIN_VERIFICATION_ACTION: directive.primaryNextAction.action,
  };
}

// ---------------------------------------------------------------------------
// Runtime state resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the full verification runtime state for a session.
 * Tries cached plan first, falls back to fresh computation.
 * Idempotent and safe to retry — no mutations.
 *
 * Emits structured log lines at each resolution checkpoint:
 * - verification-directive.resolve-start
 * - verification-directive.cache-hit / cache-miss
 * - verification-directive.fresh-computed / fresh-empty
 * - verification-directive.resolve-complete
 * - verification-directive.resolve-failed (on error)
 */
export function resolveVerificationRuntimeState(
  sessionId: string | null | undefined,
  options?: ComputePlanOptions,
  logger?: Logger,
): VerificationRuntimeState {
  const log = logger ?? createLogger();

  if (!sessionId) {
    log.debug("verification-directive.resolve-start", {
      sessionId: null,
      reason: "no-session",
    });
    return {
      plan: null,
      directive: null,
      banner: null,
      env: buildVerificationEnv(null),
    };
  }

  log.debug("verification-directive.resolve-start", { sessionId });

  try {
    let plan = loadCachedPlanResult(sessionId, log);
    if (plan?.hasStories) {
      log.debug("verification-directive.cache-hit", {
        sessionId,
        storyCount: plan.stories.length,
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
        env: buildVerificationEnv(null),
      };
    }

    log.debug("verification-directive.fresh-computed", {
      sessionId,
      storyCount: plan.stories.length,
      missingBoundaries: plan.missingBoundaries,
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
      envCleared: !directive?.primaryNextAction,
    });

    return { plan, directive, banner, env };
  } catch (error) {
    logCaughtError(log, "verification-directive.resolve-failed", error, {
      sessionId,
    });
    return {
      plan: null,
      directive: null,
      banner: null,
      env: buildVerificationEnv(null),
    };
  }
}
