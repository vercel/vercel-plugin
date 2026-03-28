// hooks/src/routing-attribution.mts
import { createLogger } from "./logger.mjs";
function chooseAttributedSkill(loadedSkills, preferredSkills = []) {
  const preferred = new Set(preferredSkills);
  for (const skill of loadedSkills) {
    if (preferred.has(skill)) return skill;
  }
  return loadedSkills[0] ?? null;
}
function buildAttributionDecision(input) {
  const log = createLogger();
  const timestamp = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const candidateSkill = chooseAttributedSkill(
    input.loadedSkills,
    input.preferredSkills
  );
  const decision = {
    exposureGroupId: [
      input.sessionId,
      input.hook,
      input.storyId ?? "none",
      input.route ?? "*",
      input.targetBoundary ?? "none",
      timestamp
    ].join(":"),
    candidateSkill,
    loadedSkills: [...input.loadedSkills]
  };
  log.summary("routing-attribution.decision", {
    exposureGroupId: decision.exposureGroupId,
    candidateSkill: decision.candidateSkill,
    loadedSkills: decision.loadedSkills,
    hook: input.hook,
    storyId: input.storyId,
    route: input.route
  });
  return decision;
}
export {
  buildAttributionDecision,
  chooseAttributedSkill
};
