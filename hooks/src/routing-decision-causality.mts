/**
 * Routing Decision Causality: first-class, machine-readable decision capsule
 * that records explicit causes[] and edges[] for every injected, boosted,
 * recalled, companion-linked, or dropped skill.
 *
 * Deterministic: detail objects are key-sorted on insertion so JSON.stringify
 * output is stable regardless of insertion order.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingDecisionCauseStage = "match" | "rank" | "inject" | "observe";

export type RoutingDecisionEdgeRelation =
  | "companion-of"
  | "recalled-after"
  | "boosted-by-policy"
  | "boosted-by-rulebook";

export interface RoutingDecisionCause {
  code: string;
  stage: RoutingDecisionCauseStage;
  skill: string;
  synthetic: boolean;
  scoreDelta: number;
  message: string;
  detail: Record<string, unknown>;
}

export interface RoutingDecisionEdge {
  fromSkill: string;
  toSkill: string;
  relation: RoutingDecisionEdgeRelation | string;
  code: string;
  detail: Record<string, unknown>;
}

export interface RoutingDecisionCausality {
  causes: RoutingDecisionCause[];
  edges: RoutingDecisionEdge[];
}

// ---------------------------------------------------------------------------
// Deterministic sorting helpers
// ---------------------------------------------------------------------------

function sortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortUnknown);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortUnknown(input[key]);
  }
  return output;
}

function causeKey(cause: RoutingDecisionCause): string {
  return [cause.skill, cause.stage, cause.code, cause.message].join("\0");
}

function edgeKey(edge: RoutingDecisionEdge): string {
  return [edge.fromSkill, edge.toSkill, String(edge.relation), edge.code].join(
    "\0",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createDecisionCausality(): RoutingDecisionCausality {
  return { causes: [], edges: [] };
}

export function addCause(
  store: RoutingDecisionCausality,
  cause: RoutingDecisionCause,
): void {
  store.causes.push({
    ...cause,
    detail: sortUnknown(cause.detail) as Record<string, unknown>,
  });
  store.causes.sort((left, right) =>
    causeKey(left).localeCompare(causeKey(right)),
  );
}

export function addEdge(
  store: RoutingDecisionCausality,
  edge: RoutingDecisionEdge,
): void {
  store.edges.push({
    ...edge,
    detail: sortUnknown(edge.detail) as Record<string, unknown>,
  });
  store.edges.sort((left, right) =>
    edgeKey(left).localeCompare(edgeKey(right)),
  );
}

export function causesForSkill(
  store: RoutingDecisionCausality,
  skill: string,
): RoutingDecisionCause[] {
  return store.causes.filter((cause) => cause.skill === skill);
}
