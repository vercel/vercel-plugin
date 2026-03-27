/**
 * `vercel-plugin verify-plan` — inspect the current verification plan state.
 *
 * Reads the session ledger and derives (or loads cached) plan state.
 * Exits 0 on success, non-zero only on actual command failure.
 *
 * Usage:
 *   vercel-plugin verify-plan [--json] [--session <id>]
 */

import { tmpdir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import {
  computePlan,
  formatPlanHuman,
  planToLoopSnapshot,
  type VerificationPlanResult,
  type VerificationLoopSnapshot,
  type ComputePlanOptions,
} from "../../hooks/src/verification-plan.mts";
import {
  derivePlan,
  loadObservations,
  loadStories,
} from "../../hooks/src/verification-ledger.mts";

export interface VerifyPlanOptions {
  sessionId?: string;
  agentBrowserAvailable?: boolean;
  devServerLoopGuardHit?: boolean;
  lastAttemptedAction?: string | null;
}

/**
 * Auto-detect the most recent session ledger directory.
 * Returns null if none found.
 */
function detectSessionId(): string | null {
  const tmp = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return null;
  }

  const latestLedger = entries
    .filter((e) => e.startsWith("vercel-plugin-") && e.endsWith("-ledger"))
    .map((entry) => {
      try {
        return {
          entry,
          mtimeMs: statSync(`${tmp}/${entry}`).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { entry: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  if (!latestLedger) return null;

  // Extract session id from directory name: vercel-plugin-<sessionId>-ledger
  const match = latestLedger.entry.match(/^vercel-plugin-(.+)-ledger$/);
  return match ? match[1] : null;
}

/**
 * Run the verify-plan command.
 */
export function verifyPlan(options: VerifyPlanOptions = {}): VerificationPlanResult {
  const sessionId =
    options.sessionId ||
    process.env.CLAUDE_SESSION_ID ||
    detectSessionId();

  if (!sessionId) {
    return {
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: ["No active session found"],
    };
  }

  const planOptions: ComputePlanOptions = {};
  if (options.agentBrowserAvailable !== undefined) {
    planOptions.agentBrowserAvailable = options.agentBrowserAvailable;
  }
  if (options.devServerLoopGuardHit !== undefined) {
    planOptions.devServerLoopGuardHit = options.devServerLoopGuardHit;
  }
  if (options.lastAttemptedAction !== undefined) {
    planOptions.lastAttemptedAction = options.lastAttemptedAction;
  }

  return computePlan(sessionId, planOptions);
}

/**
 * Return a VerificationLoopSnapshot including last-observation adherence metadata.
 * Machine-readable API for downstream tooling and subagents.
 */
export function verifyPlanSnapshot(
  options: VerifyPlanOptions = {},
): VerificationLoopSnapshot {
  const sessionId =
    options.sessionId ||
    process.env.CLAUDE_SESSION_ID ||
    detectSessionId();

  if (!sessionId) {
    return {
      hasStories: false,
      stories: [],
      observationCount: 0,
      satisfiedBoundaries: [],
      missingBoundaries: [],
      recentRoutes: [],
      primaryNextAction: null,
      blockedReasons: ["No active session found"],
      lastObservation: null,
    };
  }

  const planOptions: ComputePlanOptions = {};
  if (options.agentBrowserAvailable !== undefined) {
    planOptions.agentBrowserAvailable = options.agentBrowserAvailable;
  }
  if (options.devServerLoopGuardHit !== undefined) {
    planOptions.devServerLoopGuardHit = options.devServerLoopGuardHit;
  }
  if (options.lastAttemptedAction !== undefined) {
    planOptions.lastAttemptedAction = options.lastAttemptedAction;
  }

  const observations = loadObservations(sessionId);
  const stories = loadStories(sessionId);
  const plan = derivePlan(observations, stories, planOptions);

  return planToLoopSnapshot(plan);
}

export { formatPlanHuman };
