/**
 * Routing Attribution: causal credit assignment for co-injected skills.
 *
 * When multiple skills are injected in a single batch, one is designated the
 * "candidate" (the skill that causally drove the injection) and the rest are
 * "context" (helpers along for the ride). Only the candidate's outcomes update
 * long-term project routing policy — context exposures are still fully logged
 * for replay and operator inspection, but they do not move policy stats.
 *
 * Selection heuristic (v1): prefer skills that appear in policyRecallSynthetic
 * (i.e. skills the policy system explicitly chose to re-inject). If none match,
 * fall back to the first skill in the ranked load order (highest priority).
 */

import { createLogger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExposureAttributionRole = "candidate" | "context";

export interface AttributionDecision {
  exposureGroupId: string;
  candidateSkill: string | null;
  loadedSkills: string[];
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Choose which skill in a batch owns the policy credit.
 *
 * Prefers skills in `preferredSkills` (policy-recall synthetic injections).
 * Falls back to the first loaded skill (highest-ranked by priority).
 * Returns null only when the batch is empty.
 */
export function chooseAttributedSkill(
  loadedSkills: string[],
  preferredSkills: Iterable<string> = [],
): string | null {
  const preferred = new Set(preferredSkills);
  for (const skill of loadedSkills) {
    if (preferred.has(skill)) return skill;
  }
  return loadedSkills[0] ?? null;
}

// ---------------------------------------------------------------------------
// Attribution decision builder
// ---------------------------------------------------------------------------

export function buildAttributionDecision(input: {
  sessionId: string;
  hook: "PreToolUse" | "UserPromptSubmit";
  storyId: string | null;
  route: string | null;
  targetBoundary:
    | "uiRender"
    | "clientRequest"
    | "serverHandler"
    | "environment"
    | null;
  loadedSkills: string[];
  preferredSkills?: Iterable<string>;
  now?: string;
}): AttributionDecision {
  const log = createLogger();
  const timestamp = input.now ?? new Date().toISOString();

  const candidateSkill = chooseAttributedSkill(
    input.loadedSkills,
    input.preferredSkills,
  );

  const decision: AttributionDecision = {
    exposureGroupId: [
      input.sessionId,
      input.hook,
      input.storyId ?? "none",
      input.route ?? "*",
      input.targetBoundary ?? "none",
      timestamp,
    ].join(":"),
    candidateSkill,
    loadedSkills: [...input.loadedSkills],
  };

  log.summary("routing-attribution.decision", {
    exposureGroupId: decision.exposureGroupId,
    candidateSkill: decision.candidateSkill,
    loadedSkills: decision.loadedSkills,
    hook: input.hook,
    storyId: input.storyId,
    route: input.route,
  });

  return decision;
}
