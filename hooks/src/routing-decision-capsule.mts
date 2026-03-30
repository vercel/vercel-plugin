import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  DecisionHook,
  RankedSkillTrace,
  RoutingDecisionTrace,
} from "./routing-decision-trace.mjs";
import type { VerificationDirective } from "./verification-directive.mjs";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeSessionSegment(sessionId: string | null): string {
  if (!sessionId) return "no-session";
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}

export type DecisionCapsulePlatform = "claude-code" | "cursor" | "unknown";

export interface DecisionCapsuleReason {
  trigger: string;
  reasonCode: string;
}

export interface DecisionCapsuleAttribution {
  exposureGroupId: string | null;
  candidateSkill: string | null;
  loadedSkills: string[];
}

export interface DecisionCapsuleRulebookProvenance {
  /** The rule ID that matched, e.g. "PreToolUse|flow-verification|uiRender|Bash|agent-browser-verify" */
  matchedRuleId: string;
  /** Boost applied by the matched rule */
  ruleBoost: number;
  /** Human-readable reason from the rule */
  ruleReason: string;
  /** Absolute path to the rulebook JSON file on disk */
  rulebookPath: string;
}

export interface DecisionCapsuleIssue {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  action?: string;
}

export interface DecisionCapsuleV1 {
  type: "routing.decision-capsule/v1";
  version: 1;
  decisionId: string;
  sessionId: string | null;
  hook: DecisionHook;
  createdAt: string;
  input: {
    toolName: string;
    toolTarget: string;
    platform: DecisionCapsulePlatform;
  };
  activeStory: {
    id: string | null;
    kind: string | null;
    route: string | null;
    targetBoundary: string | null;
  };
  directive: VerificationDirective | null;
  matchedSkills: string[];
  injectedSkills: string[];
  ranked: RankedSkillTrace[];
  attribution: DecisionCapsuleAttribution | null;
  rulebookProvenance: DecisionCapsuleRulebookProvenance | null;
  verification: RoutingDecisionTrace["verification"];
  reasons: Record<string, DecisionCapsuleReason>;
  skippedReasons: string[];
  env: Record<string, string>;
  issues: DecisionCapsuleIssue[];
  sha256: string;
}

export function decisionCapsuleDir(sessionId: string | null): string {
  return join(
    tmpdir(),
    `vercel-plugin-${safeSessionSegment(sessionId)}-capsules`,
  );
}

export function decisionCapsulePath(
  sessionId: string | null,
  decisionId: string,
): string {
  return join(decisionCapsuleDir(sessionId), `${decisionId}.json`);
}

function stableSha256(value: Omit<DecisionCapsuleV1, "sha256">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deriveIssues(input: {
  hook: DecisionHook;
  directive: VerificationDirective | null;
  trace: RoutingDecisionTrace;
}): DecisionCapsuleIssue[] {
  const issues: DecisionCapsuleIssue[] = [];

  if (!input.trace.primaryStory.id) {
    issues.push({
      code: "no_active_verification_story",
      severity: "warning",
      message:
        "No active verification story was available for this decision.",
      action:
        "Create or record a verification story before expecting policy learning or directed verification.",
    });
  }

  if (!input.directive?.primaryNextAction) {
    issues.push({
      code: "env_cleared",
      severity: "info",
      message: "Verification env keys were cleared for this decision.",
      action:
        "Expected when no next action exists; unexpected if a flow is mid-debug.",
    });
  }

  if (input.directive?.blockedReasons?.length) {
    issues.push({
      code: "verification_blocked",
      severity: "warning",
      message: input.directive.blockedReasons[0]!,
      action:
        "Resolve the blocking condition before relying on automated verification.",
    });
  }

  if (
    input.trace.skippedReasons.some((reason) =>
      reason.startsWith("budget_exhausted:"),
    )
  ) {
    issues.push({
      code: "budget_exhausted",
      severity: "warning",
      message:
        "At least one ranked skill was dropped because the injection budget was exhausted.",
      action:
        "Inspect the ranked list in this capsule to see which skills were trimmed.",
    });
  }

  if (input.hook !== "PostToolUse") {
    issues.push({
      code: "machine_output_hidden_in_html_comment",
      severity: "info",
      message:
        "Some hook metadata still travels through additionalContext comments due hook schema limits.",
      action:
        "Use VERCEL_PLUGIN_DECISION_PATH instead of scraping hook output.",
    });
  }

  return issues;
}

/**
 * Extract the first rulebook-matched entry from ranked traces.
 * Returns null when no rule fired for any ranked skill.
 */
function deriveRulebookProvenance(
  trace: RoutingDecisionTrace,
): DecisionCapsuleRulebookProvenance | null {
  for (const entry of trace.ranked) {
    if (entry.matchedRuleId && entry.rulebookPath) {
      return {
        matchedRuleId: entry.matchedRuleId,
        ruleBoost: entry.ruleBoost,
        ruleReason: entry.ruleReason ?? "",
        rulebookPath: entry.rulebookPath,
      };
    }
  }
  return null;
}

export function buildDecisionCapsule(input: {
  sessionId: string | null;
  hook: DecisionHook;
  createdAt: string;
  toolName: string;
  toolTarget: string;
  platform?: string | null;
  trace: RoutingDecisionTrace;
  directive: VerificationDirective | null;
  attribution?: DecisionCapsuleAttribution | null;
  reasons?: Record<string, DecisionCapsuleReason>;
  env?: Record<string, string>;
}): DecisionCapsuleV1 {
  const platform: DecisionCapsulePlatform =
    input.platform === "cursor" || input.platform === "claude-code"
      ? input.platform
      : "unknown";

  const base: Omit<DecisionCapsuleV1, "sha256"> = {
    type: "routing.decision-capsule/v1",
    version: 1,
    decisionId: input.trace.decisionId,
    sessionId: input.sessionId,
    hook: input.hook,
    createdAt: input.createdAt,
    input: {
      toolName: input.toolName,
      toolTarget: input.toolTarget,
      platform,
    },
    activeStory: {
      id: input.trace.primaryStory.id,
      kind: input.trace.primaryStory.kind,
      route: input.trace.primaryStory.storyRoute,
      targetBoundary: input.trace.primaryStory.targetBoundary,
    },
    directive: input.directive,
    matchedSkills: [...input.trace.matchedSkills],
    injectedSkills: [...input.trace.injectedSkills],
    ranked: [...input.trace.ranked],
    attribution: input.attribution ?? null,
    rulebookProvenance: deriveRulebookProvenance(input.trace),
    verification: input.trace.verification,
    reasons: { ...(input.reasons ?? {}) },
    skippedReasons: [...input.trace.skippedReasons],
    env: { ...(input.env ?? {}) },
    issues: deriveIssues({
      hook: input.hook,
      directive: input.directive,
      trace: input.trace,
    }),
  };

  return { ...base, sha256: stableSha256(base) };
}

export function persistDecisionCapsule(
  capsule: DecisionCapsuleV1,
  logger?: Logger,
): string {
  const log = logger ?? createLogger();
  const path = decisionCapsulePath(capsule.sessionId, capsule.decisionId);

  try {
    mkdirSync(decisionCapsuleDir(capsule.sessionId), { recursive: true });
    writeFileSync(path, JSON.stringify(capsule, null, 2) + "\n", "utf-8");
    log.summary("routing.decision_capsule_written", {
      decisionId: capsule.decisionId,
      sessionId: capsule.sessionId,
      hook: capsule.hook,
      path,
      sha256: capsule.sha256,
    });
  } catch (error) {
    logCaughtError(log, "routing.decision_capsule_write_failed", error, {
      decisionId: capsule.decisionId,
      sessionId: capsule.sessionId,
      path,
    });
  }

  return path;
}

export function buildDecisionCapsuleEnv(
  capsule: DecisionCapsuleV1,
  artifactPath: string,
): Record<string, string> {
  return {
    VERCEL_PLUGIN_DECISION_ID: capsule.decisionId,
    VERCEL_PLUGIN_DECISION_PATH: artifactPath,
    VERCEL_PLUGIN_DECISION_SHA256: capsule.sha256,
  };
}

export function readDecisionCapsule(
  artifactPath: string,
  logger?: Logger,
): DecisionCapsuleV1 | null {
  const log = logger ?? createLogger();
  try {
    return JSON.parse(
      readFileSync(artifactPath, "utf-8"),
    ) as DecisionCapsuleV1;
  } catch (error) {
    logCaughtError(log, "routing.decision_capsule_read_failed", error, {
      artifactPath,
    });
    return null;
  }
}
