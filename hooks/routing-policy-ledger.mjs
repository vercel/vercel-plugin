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
function projectPolicyPath(projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex");
  return `${tmpdir()}/vercel-plugin-routing-policy-${hash}.json`;
}
function sessionExposurePath(sessionId) {
  return `${tmpdir()}/vercel-plugin-${sessionId}-routing-exposures.jsonl`;
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
function appendSkillExposure(exposure) {
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
    now: exposure.createdAt
  });
  saveProjectRoutingPolicy(exposure.projectRoot, policy);
  log.summary("routing-policy-ledger.exposure-append", {
    id: exposure.id,
    skill: exposure.skill,
    hook: exposure.hook,
    targetBoundary: exposure.targetBoundary,
    outcome: exposure.outcome
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
  const now = params.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const log = createLogger();
  const exposures = loadSessionExposures(sessionId);
  const resolved = [];
  const pending = exposures.filter(
    (e) => e.outcome === "pending" && e.sessionId === sessionId && e.targetBoundary === boundary
  );
  if (pending.length === 0) {
    log.trace("routing-policy-ledger.resolve-skip", {
      sessionId,
      boundary,
      reason: "no_matching_pending_exposures"
    });
    return [];
  }
  const outcome = matchedSuggestedAction ? "directive-win" : "win";
  for (const exposure of pending) {
    exposure.outcome = outcome;
    exposure.resolvedAt = now;
    resolved.push(exposure);
  }
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
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
        outcome,
        now
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }
  log.summary("routing-policy-ledger.resolve", {
    sessionId,
    boundary,
    outcome,
    resolvedCount: resolved.length,
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
  }
  const path = sessionExposurePath(sessionId);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
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
        now: timestamp
      });
    }
    saveProjectRoutingPolicy(projectRoot, policy);
  }
  log.summary("routing-policy-ledger.finalize-stale", {
    sessionId,
    staleCount: stale.length,
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
