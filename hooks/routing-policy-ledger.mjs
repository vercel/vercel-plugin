// hooks/src/routing-policy-ledger.mts
import {
  appendFileSync,
  readFileSync,
  writeFileSync
} from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import {
  createEmptyRoutingPolicy,
  recordExposure as policyRecordExposure,
  recordOutcome as policyRecordOutcome
} from "./routing-policy.mjs";
import { createLogger } from "./logger.mjs";
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function safeSessionSegment(sessionId) {
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}
function projectPolicyPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-routing-policy-${hash}.json`;
}
function sessionExposurePath(sessionId) {
  return `${tmpdir()}/vercel-plugin-${safeSessionSegment(sessionId)}-routing-exposures.jsonl`;
}
function loadProjectRoutingPolicy(projectRoot) {
  const path = projectPolicyPath(projectRoot);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && typeof parsed.scenarios === "object") {
      return parsed;
    }
  } catch {
  }
  return createEmptyRoutingPolicy();
}
function saveProjectRoutingPolicy(projectRoot, policy) {
  const path = projectPolicyPath(projectRoot);
  const log = createLogger();
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
  log.summary("routing-policy-ledger.save", {
    path,
    scenarioCount: Object.keys(policy.scenarios).length
  });
}
function shouldAffectPolicy(exposure) {
  if (!exposure.attributionRole) return true;
  return exposure.attributionRole === "candidate";
}
function appendSkillExposure(exposure) {
  const path = sessionExposurePath(exposure.sessionId);
  const log = createLogger();
  appendFileSync(path, JSON.stringify(exposure) + "\n");
  if (shouldAffectPolicy(exposure)) {
    const policy = loadProjectRoutingPolicy(exposure.projectRoot);
    policyRecordExposure(policy, {
      hook: exposure.hook,
      storyKind: exposure.storyKind,
      targetBoundary: exposure.targetBoundary,
      toolName: exposure.toolName,
      routeScope: exposure.route,
      skill: exposure.skill,
      now: exposure.createdAt
    });
    saveProjectRoutingPolicy(exposure.projectRoot, policy);
  }
  log.summary("routing-policy-ledger.exposure-append", {
    id: exposure.id,
    skill: exposure.skill,
    hook: exposure.hook,
    targetBoundary: exposure.targetBoundary,
    route: exposure.route,
    outcome: exposure.outcome,
    attributionRole: exposure.attributionRole ?? "legacy",
    exposureGroupId: exposure.exposureGroupId ?? null,
    policyAffected: shouldAffectPolicy(exposure)
  });
}
function loadSessionExposures(sessionId) {
  const path = sessionExposurePath(sessionId);
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function resolveBoundaryOutcome(params) {
  const { sessionId, boundary, matchedSuggestedAction } = params;
  const storyId = params.storyId ?? null;
  const route = params.route ?? null;
  const now = params.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const log = createLogger();
  const exposures = loadSessionExposures(sessionId);
  const resolved = [];
  const pending = exposures.filter(
    (e) => e.outcome === "pending" && e.sessionId === sessionId && e.targetBoundary === boundary && e.storyId === storyId && e.route === route
  );
  log.summary("routing-policy-ledger.resolve-filter", {
    sessionId,
    boundary,
    storyId,
    route,
    totalExposures: exposures.length,
    pendingCount: exposures.filter((e) => e.outcome === "pending").length,
    matchedCount: pending.length
  });
  if (pending.length === 0) {
    log.trace("routing-policy-ledger.resolve-skip", {
      sessionId,
      boundary,
      storyId,
      route,
      reason: "no_matching_pending_exposures"
    });
    return [];
  }
  const outcome = matchedSuggestedAction ? "directive-win" : "win";
  for (const exposure of pending) {
    exposure.outcome = outcome;
    exposure.resolvedAt = now;
    resolved.push(exposure);
    log.summary("routing-policy-ledger.exposure-resolved", {
      id: exposure.id,
      skill: exposure.skill,
      outcome,
      storyId: exposure.storyId,
      route: exposure.route,
      boundary
    });
  }
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
  const candidateResolved = resolved.filter(shouldAffectPolicy);
  const projectRoots = new Set(resolved.map((e) => e.projectRoot));
  for (const projectRoot of projectRoots) {
    const candidates = candidateResolved.filter((r) => r.projectRoot === projectRoot);
    if (candidates.length === 0) continue;
    const policy = loadProjectRoutingPolicy(projectRoot);
    for (const e of candidates) {
      policyRecordOutcome(policy, {
        hook: e.hook,
        storyKind: e.storyKind,
        targetBoundary: e.targetBoundary,
        toolName: e.toolName,
        routeScope: e.route,
        skill: e.skill,
        outcome,
        now
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }
  log.summary("routing-policy-ledger.resolve", {
    sessionId,
    boundary,
    storyId,
    route,
    outcome,
    resolvedCount: resolved.length,
    candidateCount: candidateResolved.length,
    contextCount: resolved.length - candidateResolved.length,
    skills: resolved.map((e) => e.skill)
  });
  return resolved;
}
function finalizeStaleExposures(sessionId, now) {
  const timestamp = now ?? (/* @__PURE__ */ new Date()).toISOString();
  const log = createLogger();
  const exposures = loadSessionExposures(sessionId);
  const stale = exposures.filter(
    (e) => e.outcome === "pending" && e.sessionId === sessionId
  );
  if (stale.length === 0) {
    log.trace("routing-policy-ledger.finalize-skip", {
      sessionId,
      reason: "no_pending_exposures"
    });
    return [];
  }
  for (const exposure of stale) {
    exposure.outcome = "stale-miss";
    exposure.resolvedAt = timestamp;
    log.summary("routing-policy-ledger.exposure-stale", {
      id: exposure.id,
      skill: exposure.skill,
      outcome: "stale-miss",
      storyId: exposure.storyId,
      route: exposure.route,
      targetBoundary: exposure.targetBoundary
    });
  }
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
  const candidateStale = stale.filter(shouldAffectPolicy);
  const projectRoots = new Set(stale.map((e) => e.projectRoot));
  for (const projectRoot of projectRoots) {
    const candidates = candidateStale.filter((r) => r.projectRoot === projectRoot);
    if (candidates.length === 0) continue;
    const policy = loadProjectRoutingPolicy(projectRoot);
    for (const e of candidates) {
      policyRecordOutcome(policy, {
        hook: e.hook,
        storyKind: e.storyKind,
        targetBoundary: e.targetBoundary,
        toolName: e.toolName,
        routeScope: e.route,
        skill: e.skill,
        outcome: "stale-miss",
        now: timestamp
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }
  log.summary("routing-policy-ledger.finalize-stale", {
    sessionId,
    staleCount: stale.length,
    candidateCount: candidateStale.length,
    contextCount: stale.length - candidateStale.length,
    skills: stale.map((e) => e.skill)
  });
  return stale;
}
export {
  appendSkillExposure,
  finalizeStaleExposures,
  loadProjectRoutingPolicy,
  loadSessionExposures,
  projectPolicyPath,
  resolveBoundaryOutcome,
  saveProjectRoutingPolicy,
  sessionExposurePath
};
