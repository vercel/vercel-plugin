// hooks/src/verification-closure-capsule.mts
import {
  appendFileSync,
  mkdirSync,
  readFileSync
} from "fs";
import { join } from "path";
import {
  createLogger,
  logCaughtError
} from "./logger.mjs";
import { traceDir } from "./routing-decision-trace.mjs";
function verificationClosureCapsulePath(sessionId) {
  return join(traceDir(sessionId), "verification-closure-capsules.jsonl");
}
function buildVerificationClosureCapsule(input) {
  const outcomeKind = input.resolvedExposures.length === 0 ? null : input.observation.matchedSuggestedAction ? "directive-win" : "win";
  return {
    version: 1,
    hook: "PostToolUse",
    createdAt: input.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: input.sessionId,
    verificationId: input.verificationId,
    toolName: input.toolName,
    observation: input.observation,
    storyResolution: input.storyResolution,
    gate: input.gate,
    exposureDiagnosis: input.exposureDiagnosis,
    resolution: {
      attempted: input.gate.eligible,
      outcomeKind,
      resolvedCount: input.resolvedExposures.length,
      resolvedExposureIds: input.resolvedExposures.map((e) => e.id),
      candidateResolvedCount: input.resolvedExposures.filter(
        (e) => e.attributionRole !== "context"
      ).length,
      contextResolvedCount: input.resolvedExposures.filter(
        (e) => e.attributionRole === "context"
      ).length
    },
    plan: {
      activeStoryId: input.plan.activeStoryId,
      satisfiedBoundaries: Array.from(input.plan.satisfiedBoundaries).sort(),
      missingBoundaries: [...input.plan.missingBoundaries],
      blockedReasons: [...input.plan.blockedReasons],
      primaryNextAction: input.plan.primaryNextAction ?? null
    }
  };
}
function persistVerificationClosureCapsule(capsule, logger) {
  const log = logger ?? createLogger();
  const path = verificationClosureCapsulePath(capsule.sessionId);
  try {
    mkdirSync(traceDir(capsule.sessionId), { recursive: true });
    appendFileSync(path, JSON.stringify(capsule) + "\n", "utf8");
    log.summary("verification.closure_capsule_written", {
      verificationId: capsule.verificationId,
      sessionId: capsule.sessionId,
      toolName: capsule.toolName,
      boundary: capsule.observation.boundary,
      path
    });
  } catch (error) {
    logCaughtError(
      log,
      "verification.closure_capsule_write_failed",
      error,
      {
        verificationId: capsule.verificationId,
        sessionId: capsule.sessionId,
        path
      }
    );
  }
  return path;
}
function readVerificationClosureCapsules(sessionId) {
  try {
    const raw = readFileSync(
      verificationClosureCapsulePath(sessionId),
      "utf8"
    );
    return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function readLatestVerificationClosureCapsule(sessionId) {
  const all = readVerificationClosureCapsules(sessionId);
  return all.length > 0 ? all[all.length - 1] : null;
}
export {
  buildVerificationClosureCapsule,
  persistVerificationClosureCapsule,
  readLatestVerificationClosureCapsule,
  readVerificationClosureCapsules,
  verificationClosureCapsulePath
};
