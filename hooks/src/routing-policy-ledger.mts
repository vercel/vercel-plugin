/**
 * Routing Policy Ledger: exposure tracking and project-scoped policy persistence.
 *
 * Records every skill injection as an exposure in an append-only JSONL session
 * ledger. Resolves exposures against verification-boundary outcomes and persists
 * a deterministic project-scoped policy file across sessions.
 *
 * Persistence contract:
 * - Project policy: `<tmpdir>/vercel-plugin-routing-policy-<sha256(projectRoot)>.json`
 * - Session exposures: `<tmpdir>/vercel-plugin-<sessionId>-routing-exposures.jsonl`
 *
 * v1 — Bash-only verification observer; non-Bash signals will be added in future.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  createEmptyRoutingPolicy,
  recordExposure as policyRecordExposure,
  recordOutcome as policyRecordOutcome,
  type RoutingBoundary,
  type RoutingHookName,
  type RoutingOutcome,
  type RoutingPolicyFile,
  type RoutingToolName,
} from "./routing-policy.mjs";
import { createLogger, type Logger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillExposure {
  id: string;
  sessionId: string;
  projectRoot: string;
  storyId: string | null;
  storyKind: string | null;
  route: string | null;
  hook: RoutingHookName;
  toolName: RoutingToolName;
  skill: string;
  targetBoundary: RoutingBoundary | null;
  createdAt: string;
  resolvedAt: string | null;
  outcome: "pending" | "win" | "directive-win" | "stale-miss";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function projectPolicyPath(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-routing-policy-${hash}.json`;
}

export function sessionExposurePath(sessionId: string): string {
  return `${tmpdir()}/vercel-plugin-${sessionId}-routing-exposures.jsonl`;
}

// ---------------------------------------------------------------------------
// Project policy persistence
// ---------------------------------------------------------------------------

export function loadProjectRoutingPolicy(projectRoot: string): RoutingPolicyFile {
  const path = projectPolicyPath(projectRoot);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && typeof parsed.scenarios === "object") {
      return parsed as RoutingPolicyFile;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return createEmptyRoutingPolicy();
}

export function saveProjectRoutingPolicy(
  projectRoot: string,
  policy: RoutingPolicyFile,
): void {
  const path = projectPolicyPath(projectRoot);
  const log = createLogger();
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
  log.summary("routing-policy-ledger.save", {
    path,
    scenarioCount: Object.keys(policy.scenarios).length,
  });
}

// ---------------------------------------------------------------------------
// Session exposure ledger (append-only JSONL)
// ---------------------------------------------------------------------------

export function appendSkillExposure(exposure: SkillExposure): void {
  const path = sessionExposurePath(exposure.sessionId);
  const log = createLogger();
  appendFileSync(path, JSON.stringify(exposure) + "\n");

  const policy = loadProjectRoutingPolicy(exposure.projectRoot);
  policyRecordExposure(policy, {
    hook: exposure.hook,
    storyKind: exposure.storyKind,
    targetBoundary: exposure.targetBoundary,
    toolName: exposure.toolName,
    skill: exposure.skill,
    now: exposure.createdAt,
  });
  saveProjectRoutingPolicy(exposure.projectRoot, policy);

  log.summary("routing-policy-ledger.exposure-append", {
    id: exposure.id,
    skill: exposure.skill,
    hook: exposure.hook,
    targetBoundary: exposure.targetBoundary,
    outcome: exposure.outcome,
  });
}

export function loadSessionExposures(sessionId: string): SkillExposure[] {
  const path = sessionExposurePath(sessionId);
  try {
    const raw = readFileSync(path, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SkillExposure);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------------------

/**
 * Resolve pending exposures whose targetBoundary matches the observed boundary.
 *
 * Only resolves exposures from the same session that are still `pending`.
 * If `matchedSuggestedAction` is true, the outcome is `directive-win`;
 * otherwise it is `win`.
 *
 * Also updates the project policy with the resolved outcomes.
 *
 * Returns the list of resolved exposures.
 */
export function resolveBoundaryOutcome(params: {
  sessionId: string;
  boundary: RoutingBoundary;
  matchedSuggestedAction: boolean;
  now?: string;
}): SkillExposure[] {
  const { sessionId, boundary, matchedSuggestedAction } = params;
  const now = params.now ?? new Date().toISOString();
  const log = createLogger();

  const exposures = loadSessionExposures(sessionId);
  const resolved: SkillExposure[] = [];

  const pending = exposures.filter(
    (e) =>
      e.outcome === "pending" &&
      e.sessionId === sessionId &&
      e.targetBoundary === boundary,
  );

  if (pending.length === 0) {
    log.trace("routing-policy-ledger.resolve-skip", {
      sessionId,
      boundary,
      reason: "no_matching_pending_exposures",
    });
    return [];
  }

  const outcome: "win" | "directive-win" = matchedSuggestedAction
    ? "directive-win"
    : "win";

  // Update each pending exposure in-place
  for (const exposure of pending) {
    exposure.outcome = outcome;
    exposure.resolvedAt = now;
    resolved.push(exposure);
  }

  // Rewrite the full session ledger with updated outcomes
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);

  // Update project policy for each resolved exposure
  const projectRoots = new Set(resolved.map((e) => e.projectRoot));
  for (const projectRoot of projectRoots) {
    const policy = loadProjectRoutingPolicy(projectRoot);
    for (const e of resolved.filter((r) => r.projectRoot === projectRoot)) {
      policyRecordOutcome(policy, {
        hook: e.hook,
        storyKind: e.storyKind,
        targetBoundary: e.targetBoundary,
        toolName: e.toolName,
        skill: e.skill,
        outcome: outcome as RoutingOutcome,
        now,
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }

  log.summary("routing-policy-ledger.resolve", {
    sessionId,
    boundary,
    outcome,
    resolvedCount: resolved.length,
    skills: resolved.map((e) => e.skill),
  });

  return resolved;
}

/**
 * Convert remaining pending exposures into stale-miss at session end.
 *
 * Updates both the session ledger and the project policy.
 * Returns the list of finalized exposures.
 */
export function finalizeStaleExposures(
  sessionId: string,
  now?: string,
): SkillExposure[] {
  const timestamp = now ?? new Date().toISOString();
  const log = createLogger();

  const exposures = loadSessionExposures(sessionId);
  const stale = exposures.filter(
    (e) => e.outcome === "pending" && e.sessionId === sessionId,
  );

  if (stale.length === 0) {
    log.trace("routing-policy-ledger.finalize-skip", {
      sessionId,
      reason: "no_pending_exposures",
    });
    return [];
  }

  for (const exposure of stale) {
    exposure.outcome = "stale-miss";
    exposure.resolvedAt = timestamp;
  }

  // Rewrite ledger
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);

  // Update project policies
  const projectRoots = new Set(stale.map((e) => e.projectRoot));
  for (const projectRoot of projectRoots) {
    const policy = loadProjectRoutingPolicy(projectRoot);
    for (const e of stale.filter((r) => r.projectRoot === projectRoot)) {
      policyRecordOutcome(policy, {
        hook: e.hook,
        storyKind: e.storyKind,
        targetBoundary: e.targetBoundary,
        toolName: e.toolName,
        skill: e.skill,
        outcome: "stale-miss",
        now: timestamp,
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }

  log.summary("routing-policy-ledger.finalize-stale", {
    sessionId,
    staleCount: stale.length,
    skills: stale.map((e) => e.skill),
  });

  return stale;
}
