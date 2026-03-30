// hooks/src/routing-decision-capsule.mts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { createLogger, logCaughtError } from "./logger.mjs";
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function safeSessionSegment(sessionId) {
  if (!sessionId) return "no-session";
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}
function decisionCapsuleDir(sessionId) {
  return join(
    tmpdir(),
    `vercel-plugin-${safeSessionSegment(sessionId)}-capsules`
  );
}
function decisionCapsulePath(sessionId, decisionId) {
  return join(decisionCapsuleDir(sessionId), `${decisionId}.json`);
}
function stableSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function deriveIssues(input) {
  const issues = [];
  if (!input.trace.primaryStory.id) {
    issues.push({
      code: "no_active_verification_story",
      severity: "warning",
      message: "No active verification story was available for this decision.",
      action: "Create or record a verification story before expecting policy learning or directed verification."
    });
  }
  if (!input.directive?.primaryNextAction) {
    issues.push({
      code: "env_cleared",
      severity: "info",
      message: "Verification env keys were cleared for this decision.",
      action: "Expected when no next action exists; unexpected if a flow is mid-debug."
    });
  }
  if (input.directive?.blockedReasons?.length) {
    issues.push({
      code: "verification_blocked",
      severity: "warning",
      message: input.directive.blockedReasons[0],
      action: "Resolve the blocking condition before relying on automated verification."
    });
  }
  if (input.trace.skippedReasons.some(
    (reason) => reason.startsWith("budget_exhausted:")
  )) {
    issues.push({
      code: "budget_exhausted",
      severity: "warning",
      message: "At least one ranked skill was dropped because the injection budget was exhausted.",
      action: "Inspect the ranked list in this capsule to see which skills were trimmed."
    });
  }
  if (input.hook !== "PostToolUse") {
    issues.push({
      code: "machine_output_hidden_in_html_comment",
      severity: "info",
      message: "Some hook metadata still travels through additionalContext comments due hook schema limits.",
      action: "Use VERCEL_PLUGIN_DECISION_PATH instead of scraping hook output."
    });
  }
  return issues;
}
function deriveRulebookProvenance(trace) {
  for (const entry of trace.ranked) {
    if (entry.matchedRuleId && entry.rulebookPath) {
      return {
        matchedRuleId: entry.matchedRuleId,
        ruleBoost: entry.ruleBoost,
        ruleReason: entry.ruleReason ?? "",
        rulebookPath: entry.rulebookPath
      };
    }
  }
  return null;
}
function buildDecisionCapsule(input) {
  const platform = input.platform === "cursor" || input.platform === "claude-code" ? input.platform : "unknown";
  const base = {
    type: "routing.decision-capsule/v1",
    version: 1,
    decisionId: input.trace.decisionId,
    sessionId: input.sessionId,
    hook: input.hook,
    createdAt: input.createdAt,
    input: {
      toolName: input.toolName,
      toolTarget: input.toolTarget,
      platform
    },
    activeStory: {
      id: input.trace.primaryStory.id,
      kind: input.trace.primaryStory.kind,
      route: input.trace.primaryStory.storyRoute,
      targetBoundary: input.trace.primaryStory.targetBoundary
    },
    directive: input.directive,
    matchedSkills: [...input.trace.matchedSkills],
    injectedSkills: [...input.trace.injectedSkills],
    ranked: [...input.trace.ranked],
    attribution: input.attribution ?? null,
    rulebookProvenance: deriveRulebookProvenance(input.trace),
    verification: input.trace.verification,
    reasons: { ...input.reasons ?? {} },
    skippedReasons: [...input.trace.skippedReasons],
    env: { ...input.env ?? {} },
    issues: deriveIssues({
      hook: input.hook,
      directive: input.directive,
      trace: input.trace
    })
  };
  return { ...base, sha256: stableSha256(base) };
}
function persistDecisionCapsule(capsule, logger) {
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
      sha256: capsule.sha256
    });
  } catch (error) {
    logCaughtError(log, "routing.decision_capsule_write_failed", error, {
      decisionId: capsule.decisionId,
      sessionId: capsule.sessionId,
      path
    });
  }
  return path;
}
function buildDecisionCapsuleEnv(capsule, artifactPath) {
  return {
    VERCEL_PLUGIN_DECISION_ID: capsule.decisionId,
    VERCEL_PLUGIN_DECISION_PATH: artifactPath,
    VERCEL_PLUGIN_DECISION_SHA256: capsule.sha256
  };
}
function readDecisionCapsule(artifactPath, logger) {
  const log = logger ?? createLogger();
  try {
    return JSON.parse(
      readFileSync(artifactPath, "utf-8")
    );
  } catch (error) {
    logCaughtError(log, "routing.decision_capsule_read_failed", error, {
      artifactPath
    });
    return null;
  }
}
export {
  buildDecisionCapsule,
  buildDecisionCapsuleEnv,
  decisionCapsuleDir,
  decisionCapsulePath,
  persistDecisionCapsule,
  readDecisionCapsule
};
