/**
 * Pure verified prompt-policy recall helper.
 *
 * When an active verification story exists, recalls the highest-confidence
 * historically winning skill for that exact storyKind + targetBoundary +
 * routeScope — even when prompt signals miss it entirely.
 *
 * Pure: does not mutate caller-provided arrays or iterables.
 */

import {
  explainPolicyRecall,
  type PolicyRecallDiagnosis,
} from "./routing-diagnosis.mjs";
import type {
  RoutingBoundary,
  RoutingPolicyFile,
} from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptPolicyRecallBinding {
  storyId: string | null;
  storyKind: string | null;
  route: string | null;
  targetBoundary: RoutingBoundary | null;
}

export interface PromptPolicyRecallResult {
  selectedSkills: string[];
  matchedSkills: string[];
  syntheticSkills: string[];
  reasons: Record<string, string>;
  diagnosis: PolicyRecallDiagnosis | null;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function applyPromptPolicyRecall(params: {
  selectedSkills: string[];
  matchedSkills: string[];
  seenSkills?: Iterable<string>;
  maxSkills: number;
  binding: PromptPolicyRecallBinding;
  policy: RoutingPolicyFile;
}): PromptPolicyRecallResult {
  const seenSkills = new Set(params.seenSkills ?? []);
  const selectedSkills = [...params.selectedSkills];
  const matchedSkills = [...params.matchedSkills];
  const syntheticSkills: string[] = [];
  const reasons: Record<string, string> = {};

  if (!params.binding.storyId || !params.binding.targetBoundary) {
    return {
      selectedSkills,
      matchedSkills,
      syntheticSkills,
      reasons,
      diagnosis: null,
    };
  }

  const availableSlots = Math.max(0, params.maxSkills - selectedSkills.length);
  if (availableSlots === 0) {
    return {
      selectedSkills,
      matchedSkills,
      syntheticSkills,
      reasons,
      diagnosis: null,
    };
  }

  const excludeSkills = new Set<string>([
    ...selectedSkills,
    ...seenSkills,
  ]);

  const diagnosis = explainPolicyRecall(
    params.policy,
    {
      hook: "UserPromptSubmit",
      storyKind: params.binding.storyKind,
      targetBoundary: params.binding.targetBoundary,
      toolName: "Prompt",
      routeScope: params.binding.route ?? null,
    },
    {
      maxCandidates: availableSlots,
      excludeSkills,
    },
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
    reasons[candidate.skill] =
      `route-scoped verified policy recall (${candidate.wins}/${candidate.exposures} wins, success=${candidate.successRate})`;
  }

  return {
    selectedSkills,
    matchedSkills,
    syntheticSkills,
    reasons,
    diagnosis,
  };
}
