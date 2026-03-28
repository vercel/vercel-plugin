// hooks/src/prompt-verification-binding.mts
import {
  selectActiveStory
} from "./verification-plan.mjs";
function resolvePromptVerificationBinding(input) {
  const story = input.plan ? selectActiveStory(input.plan) : null;
  const targetBoundary = input.plan?.primaryNextAction?.targetBoundary ?? null;
  if (story && targetBoundary) {
    return {
      targetBoundary,
      storyId: story.id ?? null,
      storyKind: story.kind ?? null,
      route: story.route ?? null,
      source: "active-plan",
      confidence: 1,
      reason: `active verification plan predicted ${targetBoundary}`
    };
  }
  return {
    targetBoundary: null,
    storyId: story?.id ?? null,
    storyKind: story?.kind ?? null,
    route: story?.route ?? null,
    source: "none",
    confidence: 0,
    reason: story ? "active verification story exists but no primary next boundary is available" : "no active verification story"
  };
}
export {
  resolvePromptVerificationBinding
};
