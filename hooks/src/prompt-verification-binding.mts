/**
 * Prompt Verification Binding
 *
 * Deterministically binds prompt-time routing decisions to the active
 * verification plan's primaryNextAction.targetBoundary. This closes the
 * loop so prompt exposures become resolvable training data — without it,
 * prompt exposures record targetBoundary: null and fall through to
 * stale-miss at session end.
 *
 * Rule: no prompt exposure append and no prompt policy boost unless
 * targetBoundary is non-null.
 */

import type { RoutingBoundary } from "./routing-policy.mjs";
import {
  selectActiveStory,
  type VerificationPlanResult,
} from "./verification-plan.mjs";

export interface PromptVerificationBinding {
  targetBoundary: RoutingBoundary | null;
  storyId: string | null;
  storyKind: string | null;
  route: string | null;
  source: "active-plan" | "none";
  confidence: number;
  reason: string;
}

export function resolvePromptVerificationBinding(input: {
  plan: VerificationPlanResult | null;
}): PromptVerificationBinding {
  const story = input.plan ? selectActiveStory(input.plan) : null;
  const targetBoundary =
    (input.plan?.primaryNextAction?.targetBoundary as RoutingBoundary | null) ??
    null;

  if (story && targetBoundary) {
    return {
      targetBoundary,
      storyId: story.id ?? null,
      storyKind: story.kind ?? null,
      route: story.route ?? null,
      source: "active-plan",
      confidence: 1,
      reason: `active verification plan predicted ${targetBoundary}`,
    };
  }

  return {
    targetBoundary: null,
    storyId: story?.id ?? null,
    storyKind: story?.kind ?? null,
    route: story?.route ?? null,
    source: "none",
    confidence: 0,
    reason: story
      ? "active verification story exists but no primary next boundary is available"
      : "no active verification story",
  };
}
