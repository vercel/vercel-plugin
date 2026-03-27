/**
 * `vercel-plugin routing-explain` — surfaces the latest routing decision
 * from the flight recorder for humans and agents.
 *
 * Reads JSONL traces written by PreToolUse, UserPromptSubmit, and PostToolUse
 * hooks, then formats the most recent decision as either structured JSON
 * (for agent consumption) or human-readable text.
 *
 * JSON mode: { ok, decisionCount, latest }
 * Text mode: decision id, hook, tool target, story context, injected skills,
 *            ranked candidates with effective priority and policy boost details.
 */

import { readRoutingDecisionTrace } from "../../hooks/src/routing-decision-trace.mts";
import type { RoutingDecisionTrace } from "../../hooks/src/routing-decision-trace.mts";

// ---------------------------------------------------------------------------
// Result types (stable contract for agent consumers)
// ---------------------------------------------------------------------------

export interface RoutingExplainResult {
  ok: boolean;
  decisionCount: number;
  latest: RoutingDecisionTrace | null;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export function runRoutingExplain(
  sessionId: string | null,
  json = false,
): string {
  const traces = readRoutingDecisionTrace(sessionId);
  const latest = traces[traces.length - 1] ?? null;

  if (json) {
    const result: RoutingExplainResult = {
      ok: true,
      decisionCount: traces.length,
      latest,
    };
    return JSON.stringify(result, null, 2);
  }

  return formatRoutingExplainText(traces, latest);
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

function formatRoutingExplainText(
  traces: RoutingDecisionTrace[],
  latest: RoutingDecisionTrace | null,
): string {
  if (!latest) {
    return "No routing decision traces found. Use `vercel-plugin session-explain --json` for cross-surface state.\n";
  }

  const lines: string[] = [
    `Decision: ${latest.decisionId}`,
    `Hook: ${latest.hook}`,
    `Tool: ${latest.toolName}`,
    `Target: ${latest.toolTarget}`,
    `Story: ${latest.primaryStory.kind ?? "none"}${latest.primaryStory.storyRoute ? ` (${latest.primaryStory.storyRoute})` : ""}`,
    `Injected: ${latest.injectedSkills.join(", ") || "none"}`,
    `Total traces: ${traces.length}`,
  ];

  // Skipped reasons (undertrained, story-less, budget, cap)
  if (latest.skippedReasons.length > 0) {
    lines.push(`Skipped: ${latest.skippedReasons.join(", ")}`);
  }

  // Verification closure info
  if (latest.verification) {
    const v = latest.verification;
    lines.push("");
    lines.push("Verification:");
    lines.push(`  id: ${v.verificationId ?? "none"}`);
    lines.push(`  boundary: ${v.observedBoundary ?? "none"}`);
    lines.push(`  matched action: ${v.matchedSuggestedAction ?? "n/a"}`);
  }

  // Ranked candidates
  if (latest.ranked.length > 0) {
    lines.push("");
    lines.push("Ranked:");
    for (const r of latest.ranked) {
      const parts = [
        `effective=${r.effectivePriority}`,
        `base=${r.basePriority}`,
      ];
      if (r.profilerBoost !== 0) parts.push(`profiler=+${r.profilerBoost}`);
      if (r.policyBoost !== 0)
        parts.push(
          `policy=${r.policyBoost > 0 ? "+" : ""}${r.policyBoost}`,
        );
      if (r.droppedReason) parts.push(`dropped=${r.droppedReason}`);
      if (r.summaryOnly) parts.push("summary-only");

      lines.push(`  - ${r.skill}: ${parts.join(", ")}`);
      if (r.policyReason) {
        lines.push(`    reason: ${r.policyReason}`);
      }
    }
  }

  // Policy scenario for diagnostic context
  if (latest.policyScenario) {
    lines.push("");
    lines.push(`Policy scenario: ${latest.policyScenario}`);
  }

  return lines.join("\n") + "\n";
}
