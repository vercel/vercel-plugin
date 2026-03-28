// hooks/src/prompt-policy-recall.mts
import {
  explainPolicyRecall
} from "./routing-diagnosis.mjs";
function applyPromptPolicyRecall(params) {
  const seenSkills = new Set(params.seenSkills ?? []);
  const selectedSkills = [...params.selectedSkills];
  const matchedSkills = [...params.matchedSkills];
  const syntheticSkills = [];
  const reasons = {};
  if (!params.binding.storyId || !params.binding.targetBoundary) {
    return {
      selectedSkills,
      matchedSkills,
      syntheticSkills,
      reasons,
      diagnosis: null
    };
  }
  const availableSlots = Math.max(0, params.maxSkills - selectedSkills.length);
  if (availableSlots === 0) {
    return {
      selectedSkills,
      matchedSkills,
      syntheticSkills,
      reasons,
      diagnosis: null
    };
  }
  const excludeSkills = /* @__PURE__ */ new Set([
    ...selectedSkills,
    ...seenSkills
  ]);
  const diagnosis = explainPolicyRecall(
    params.policy,
    {
      hook: "UserPromptSubmit",
      storyKind: params.binding.storyKind,
      targetBoundary: params.binding.targetBoundary,
      toolName: "Prompt",
      routeScope: params.binding.route ?? null
    },
    {
      maxCandidates: availableSlots,
      excludeSkills
    }
  );
  const baseInsertIdx = selectedSkills.length > 0 ? 1 : 0;
  let insertedCount = 0;
  for (const candidate of diagnosis.selected) {
    if (selectedSkills.includes(candidate.skill)) continue;
    const insertIdx = baseInsertIdx + insertedCount;
    selectedSkills.splice(insertIdx, 0, candidate.skill);
    insertedCount += 1;
    if (!matchedSkills.includes(candidate.skill)) {
      matchedSkills.push(candidate.skill);
    }
    syntheticSkills.push(candidate.skill);
    reasons[candidate.skill] = `route-scoped verified policy recall (${candidate.wins}/${candidate.exposures} wins, success=${candidate.successRate})`;
  }
  return {
    selectedSkills,
    matchedSkills,
    syntheticSkills,
    reasons,
    diagnosis
  };
}
export {
  applyPromptPolicyRecall
};
