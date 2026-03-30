/**
 * Routing Decision Flight Recorder: append-only JSONL trace of every routing
 * decision (skill injection, prompt scoring, verification closure).
 *
 * Persistence contract:
 * - Trace dir: `<tmpdir>/vercel-plugin-<safeSession>-trace/`
 * - Trace file: `<traceDir>/routing-decision-trace.jsonl`
 *
 * Each routing event appends one JSON object per line. Reads return all traces
 * in append order. Missing files return `[]` without throwing.
 *
 * v2 — separates storyRoute from observedRoute, marks synthetic injections,
 *       and encodes explicit drop reasons for all non-selected candidates.
 *       Backward-compatible: v1 lines are normalized to v2 on read.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type {
  RoutingDecisionCause,
  RoutingDecisionEdge,
} from "./routing-decision-causality.mjs";

// ---------------------------------------------------------------------------
// Safe session-id segment (mirrors routing-policy-ledger.mts)
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeSessionSegment(sessionId: string | null): string {
  if (!sessionId) return "no-session";
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionHook = "PreToolUse" | "UserPromptSubmit" | "PostToolUse";

export interface RankedSkillTrace {
  skill: string;
  basePriority: number;
  effectivePriority: number;
  pattern: { type: string; value: string } | null;
  profilerBoost: number;
  policyBoost: number;
  policyReason: string | null;
  /** Matched learned-rulebook rule ID, or null when no rule applies. */
  matchedRuleId: string | null;
  /** Boost applied from a learned-rulebook rule (0 when no rule matches). */
  ruleBoost: number;
  /** Human-readable reason from the matched rulebook rule. */
  ruleReason: string | null;
  /** Path to the rulebook file that provided the matched rule. */
  rulebookPath: string | null;
  summaryOnly: boolean;
  synthetic: boolean;
  droppedReason:
    | "deduped"
    | "cap_exceeded"
    | "budget_exhausted"
    | "concurrent_claim"
    | null;
}

export interface RoutingDecisionTrace {
  version: 2;
  decisionId: string;
  sessionId: string | null;
  hook: DecisionHook;
  toolName: string;
  toolTarget: string;
  timestamp: string;
  primaryStory: {
    id: string | null;
    kind: string | null;
    storyRoute: string | null;
    targetBoundary: string | null;
  };
  observedRoute: string | null;
  policyScenario: string | null;
  matchedSkills: string[];
  injectedSkills: string[];
  skippedReasons: string[];
  ranked: RankedSkillTrace[];
  verification: {
    verificationId: string | null;
    observedBoundary: string | null;
    matchedSuggestedAction: boolean | null;
  } | null;
  /** Explicit causal reasons for each routing action (pattern match, boost, recall, drop). */
  causes: RoutingDecisionCause[];
  /** Explicit relationships between skills (companion-of, recalled-after, etc.). */
  edges: RoutingDecisionEdge[];
}

// Re-export causality types for downstream consumers
export type { RoutingDecisionCause, RoutingDecisionEdge } from "./routing-decision-causality.mjs";

/**
 * V1 trace shape for backward-compatible reads. V1 stored `route` inside
 * primaryStory and had no top-level `observedRoute`.
 */
interface RoutingDecisionTraceV1 {
  version: 1;
  decisionId: string;
  sessionId: string | null;
  hook: DecisionHook;
  toolName: string;
  toolTarget: string;
  timestamp: string;
  primaryStory: {
    id: string | null;
    kind: string | null;
    route: string | null;
    targetBoundary: string | null;
  };
  policyScenario: string | null;
  matchedSkills: string[];
  injectedSkills: string[];
  skippedReasons: string[];
  ranked: RankedSkillTrace[];
  verification: {
    verificationId: string | null;
    observedBoundary: string | null;
    matchedSuggestedAction: boolean | null;
  } | null;
}

type PersistedTrace = RoutingDecisionTrace | RoutingDecisionTraceV1;

// ---------------------------------------------------------------------------
// V1 → V2 normalization
// ---------------------------------------------------------------------------

function normalizeTrace(raw: PersistedTrace): RoutingDecisionTrace {
  if (raw.version === 2) {
    // Backfill causes/edges for v2 traces written before the causality feature
    const trace = raw as RoutingDecisionTrace;
    return {
      ...trace,
      causes: trace.causes ?? [],
      edges: trace.edges ?? [],
    };
  }

  // V1 → V2: move primaryStory.route to storyRoute, add observedRoute
  const v1 = raw as RoutingDecisionTraceV1;
  return {
    ...v1,
    version: 2,
    primaryStory: {
      id: v1.primaryStory.id,
      kind: v1.primaryStory.kind,
      storyRoute: v1.primaryStory.route,
      targetBoundary: v1.primaryStory.targetBoundary,
    },
    observedRoute: v1.primaryStory.route, // best-effort: v1 conflated the two
    causes: [],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// Path helpers (exported for testing)
// ---------------------------------------------------------------------------

export function traceDir(sessionId: string | null): string {
  return join(
    tmpdir(),
    `vercel-plugin-${safeSessionSegment(sessionId)}-trace`,
  );
}

export function tracePath(sessionId: string | null): string {
  return join(traceDir(sessionId), "routing-decision-trace.jsonl");
}

// ---------------------------------------------------------------------------
// Decision ID — deterministic for identical causal inputs
// ---------------------------------------------------------------------------

export function createDecisionId(input: {
  hook: DecisionHook;
  sessionId: string | null;
  toolName: string;
  toolTarget: string;
  timestamp?: string;
}): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return createHash("sha256")
    .update(
      [
        input.hook,
        input.sessionId ?? "",
        input.toolName,
        input.toolTarget,
        timestamp,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Append (write) — one JSONL line per decision
// ---------------------------------------------------------------------------

export function appendRoutingDecisionTrace(
  trace: RoutingDecisionTrace,
): void {
  mkdirSync(traceDir(trace.sessionId), { recursive: true });
  appendFileSync(
    tracePath(trace.sessionId),
    JSON.stringify(trace) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Read — returns all traces in append order, [] on missing file
// Normalizes v1 lines to v2 for backward compatibility.
// ---------------------------------------------------------------------------

export function readRoutingDecisionTrace(
  sessionId: string | null,
): RoutingDecisionTrace[] {
  try {
    const content = readFileSync(tracePath(sessionId), "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => normalizeTrace(JSON.parse(line) as PersistedTrace));
  } catch {
    return [];
  }
}
