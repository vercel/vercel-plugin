/**
 * Verification Closure Capsule: append-only JSONL receipt for every
 * PostToolUse boundary observation.
 *
 * Each capsule captures the gate verdict, story-resolution method,
 * exposure diagnosis, policy-resolution outcome, and current plan
 * next action in one machine-readable object.
 *
 * Persistence contract:
 * - Capsule file: `<traceDir>/verification-closure-capsules.jsonl`
 * - One JSON object per line, appended atomically.
 * - Safe to read incrementally (tail -f compatible).
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  logCaughtError,
  type Logger,
} from "./logger.mjs";
import { traceDir } from "./routing-decision-trace.mjs";
import type { SkillExposure } from "./routing-policy-ledger.mjs";
import type {
  PendingExposureMatchDiagnosis,
  ResolutionGateEvaluation,
} from "./verification-closure-diagnosis.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationClosureCapsule {
  version: 1;
  hook: "PostToolUse";
  createdAt: string;
  sessionId: string | null;
  verificationId: string;
  toolName: string;

  observation: {
    boundary: string;
    signalStrength: string;
    evidenceSource: string;
    matchedPattern: string;
    command: string;
    inferredRoute: string | null;
    matchedSuggestedAction: boolean;
  };

  storyResolution: {
    resolvedStoryId: string | null;
    method: "explicit-env" | "exact-route" | "active-story" | "none";
    activeStoryId: string | null;
    activeStoryKind: string | null;
    activeStoryRoute: string | null;
  };

  gate: ResolutionGateEvaluation;

  exposureDiagnosis: PendingExposureMatchDiagnosis | null;

  resolution: {
    attempted: boolean;
    outcomeKind: "win" | "directive-win" | null;
    resolvedCount: number;
    resolvedExposureIds: string[];
    candidateResolvedCount: number;
    contextResolvedCount: number;
  };

  plan: {
    activeStoryId: string | null;
    satisfiedBoundaries: string[];
    missingBoundaries: string[];
    blockedReasons: string[];
    primaryNextAction: {
      action: string;
      targetBoundary: string;
      reason: string;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function verificationClosureCapsulePath(
  sessionId: string | null,
): string {
  return join(traceDir(sessionId), "verification-closure-capsules.jsonl");
}

// ---------------------------------------------------------------------------
// Builder (pure)
// ---------------------------------------------------------------------------

export function buildVerificationClosureCapsule(input: {
  sessionId: string | null;
  verificationId: string;
  toolName: string;
  createdAt?: string;
  observation: VerificationClosureCapsule["observation"];
  storyResolution: VerificationClosureCapsule["storyResolution"];
  gate: ResolutionGateEvaluation;
  exposureDiagnosis: PendingExposureMatchDiagnosis | null;
  resolvedExposures: SkillExposure[];
  plan: {
    activeStoryId: string | null;
    satisfiedBoundaries: Iterable<string>;
    missingBoundaries: string[];
    blockedReasons: string[];
    primaryNextAction: {
      action: string;
      targetBoundary: string;
      reason: string;
    } | null;
  };
}): VerificationClosureCapsule {
  const outcomeKind: "win" | "directive-win" | null =
    input.resolvedExposures.length === 0
      ? null
      : input.observation.matchedSuggestedAction
        ? "directive-win"
        : "win";

  return {
    version: 1,
    hook: "PostToolUse",
    createdAt: input.createdAt ?? new Date().toISOString(),
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
        (e) => e.attributionRole !== "context",
      ).length,
      contextResolvedCount: input.resolvedExposures.filter(
        (e) => e.attributionRole === "context",
      ).length,
    },
    plan: {
      activeStoryId: input.plan.activeStoryId,
      satisfiedBoundaries: Array.from(input.plan.satisfiedBoundaries).sort(),
      missingBoundaries: [...input.plan.missingBoundaries],
      blockedReasons: [...input.plan.blockedReasons],
      primaryNextAction: input.plan.primaryNextAction ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence (append-only JSONL)
// ---------------------------------------------------------------------------

export function persistVerificationClosureCapsule(
  capsule: VerificationClosureCapsule,
  logger?: Logger,
): string {
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
      path,
    });
  } catch (error) {
    logCaughtError(
      log,
      "verification.closure_capsule_write_failed",
      error,
      {
        verificationId: capsule.verificationId,
        sessionId: capsule.sessionId,
        path,
      },
    );
  }

  return path;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export function readVerificationClosureCapsules(
  sessionId: string | null,
): VerificationClosureCapsule[] {
  try {
    const raw = readFileSync(
      verificationClosureCapsulePath(sessionId),
      "utf8",
    );
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as VerificationClosureCapsule);
  } catch {
    return [];
  }
}

export function readLatestVerificationClosureCapsule(
  sessionId: string | null,
): VerificationClosureCapsule | null {
  const all = readVerificationClosureCapsules(sessionId);
  return all.length > 0 ? all[all.length - 1]! : null;
}
