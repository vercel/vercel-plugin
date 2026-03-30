// hooks/src/verification-ledger.mts
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { createLogger, logCaughtError } from "./logger.mjs";
var ALL_BOUNDARIES = [
  "uiRender",
  "clientRequest",
  "serverHandler",
  "environment"
];
var SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function resolveObservationStoryId(observation, stories) {
  if (observation.storyId) return observation.storyId;
  if (observation.route) {
    const exactMatches = stories.filter((story) => story.route === observation.route);
    if (exactMatches.length === 1) {
      return exactMatches[0].id;
    }
  }
  if (stories.length === 1) {
    return stories[0].id;
  }
  return null;
}
function collectRecentRoutes(observations) {
  const sorted = [...observations].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );
  const seen = /* @__PURE__ */ new Set();
  const routes = [];
  for (const observation of sorted) {
    if (!observation.route) continue;
    if (seen.has(observation.route)) continue;
    seen.add(observation.route);
    routes.push(observation.route);
  }
  return routes;
}
function deriveStoryStates(observations, stories, options) {
  const opts = {
    agentBrowserAvailable: true,
    devServerLoopGuardHit: false,
    lastAttemptedAction: null,
    staleThresholdMs: 5 * 60 * 1e3,
    ...options
  };
  const states = {};
  for (const story of stories) {
    states[story.id] = {
      storyId: story.id,
      storyKind: story.kind,
      route: story.route,
      observationIds: [],
      satisfiedBoundaries: [],
      missingBoundaries: [...ALL_BOUNDARIES],
      recentRoutes: story.route ? [story.route] : [],
      primaryNextAction: null,
      blockedReasons: [],
      lastObservedAt: null
    };
  }
  for (const obs of observations) {
    const resolvedStoryId = resolveObservationStoryId(obs, stories);
    if (!resolvedStoryId || !states[resolvedStoryId]) continue;
    const state = states[resolvedStoryId];
    state.observationIds.push(obs.id);
    if (obs.boundary && !state.satisfiedBoundaries.includes(obs.boundary)) {
      state.satisfiedBoundaries.push(obs.boundary);
    }
    if (obs.route && !state.recentRoutes.includes(obs.route)) {
      state.recentRoutes.push(obs.route);
    }
    if (!state.lastObservedAt || Date.parse(obs.timestamp) > Date.parse(state.lastObservedAt)) {
      state.lastObservedAt = obs.timestamp;
    }
  }
  for (const story of stories) {
    const state = states[story.id];
    const satisfiedSet = new Set(state.satisfiedBoundaries);
    state.missingBoundaries = ALL_BOUNDARIES.filter((b) => !satisfiedSet.has(b));
    const { primaryNextAction, blockedReasons } = computeNextAction(
      state.missingBoundaries,
      [story],
      state.recentRoutes,
      opts
    );
    state.primaryNextAction = primaryNextAction;
    state.blockedReasons = blockedReasons;
  }
  return states;
}
function selectActiveStoryId(stories, storyStates) {
  if (stories.length === 0) return null;
  const sorted = [...stories].sort((a, b) => {
    const stateA = storyStates[a.id];
    const stateB = storyStates[b.id];
    const missingA = stateA ? stateA.missingBoundaries.length : 0;
    const missingB = stateB ? stateB.missingBoundaries.length : 0;
    if (missingA !== missingB) return missingB - missingA;
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  return sorted[0].id;
}
function derivePlan(observations, stories, options) {
  const observationIds = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const obs of observations) {
    if (!observationIds.has(obs.id)) {
      observationIds.add(obs.id);
      deduped.push(obs);
    }
  }
  const storyStates = deriveStoryStates(deduped, stories, options);
  const activeStoryId = selectActiveStoryId(stories, storyStates);
  const activeState = activeStoryId ? storyStates[activeStoryId] : null;
  const satisfiedBoundaries = new Set(
    activeState ? activeState.satisfiedBoundaries : []
  );
  const missingBoundaries = activeState ? activeState.missingBoundaries : stories.length > 0 ? [...ALL_BOUNDARIES] : [];
  const recentRoutes = activeState ? activeState.recentRoutes : [];
  const primaryNextAction = activeState ? activeState.primaryNextAction : null;
  const blockedReasons = activeState ? activeState.blockedReasons : [];
  return {
    stories: [...stories],
    observations: deduped,
    observationIds,
    storyStates,
    activeStoryId,
    satisfiedBoundaries,
    missingBoundaries,
    recentRoutes,
    primaryNextAction,
    blockedReasons
  };
}
function computeNextAction(missingBoundaries, stories, recentRoutes, opts) {
  const blockedReasons = [];
  if (stories.length === 0) {
    return { primaryNextAction: null, blockedReasons };
  }
  if (missingBoundaries.length === 0) {
    return { primaryNextAction: null, blockedReasons };
  }
  const route = recentRoutes[recentRoutes.length - 1] ?? null;
  const routeSuffix = route ? ` ${route}` : "";
  const ACTION_MAP = {
    clientRequest: () => ({
      action: `curl http://localhost:3000${route ?? "/"}`,
      targetBoundary: "clientRequest",
      reason: "No HTTP request observation yet \u2014 verify the endpoint responds"
    }),
    serverHandler: () => ({
      action: `tail server logs${routeSuffix}`,
      targetBoundary: "serverHandler",
      reason: "No server-side observation yet \u2014 check logs for errors"
    }),
    uiRender: () => {
      if (!opts.agentBrowserAvailable) {
        blockedReasons.push("agent-browser unavailable \u2014 cannot emit browser-only action");
        return null;
      }
      if (opts.devServerLoopGuardHit) {
        blockedReasons.push("dev-server loop guard hit \u2014 skipping browser verification");
        return null;
      }
      return {
        action: `open${routeSuffix || " /"} in agent-browser`,
        targetBoundary: "uiRender",
        reason: "No UI render observation yet \u2014 visually verify the page"
      };
    },
    environment: () => ({
      action: "inspect env for required vars",
      targetBoundary: "environment",
      reason: "No environment observation yet \u2014 check env vars are set"
    })
  };
  const PRIORITY_ORDER = [
    "clientRequest",
    "serverHandler",
    "uiRender",
    "environment"
  ];
  for (const boundary of PRIORITY_ORDER) {
    if (!missingBoundaries.includes(boundary)) continue;
    const action = ACTION_MAP[boundary]();
    if (action) {
      if (opts.lastAttemptedAction && action.action === opts.lastAttemptedAction) {
        blockedReasons.push(
          `Suppressed repeat of last attempted action: ${opts.lastAttemptedAction}`
        );
        continue;
      }
      return { primaryNextAction: action, blockedReasons };
    }
  }
  return { primaryNextAction: null, blockedReasons };
}
function storyId(kind, route) {
  const input = `${kind}:${route ?? "*"}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
function upsertStory(stories, kind, route, promptExcerpt, requestedSkills, now) {
  const id = storyId(kind, route);
  const timestamp = now ?? (/* @__PURE__ */ new Date()).toISOString();
  const existing = stories.find((s) => s.id === id);
  if (existing) {
    const merged = {
      ...existing,
      updatedAt: timestamp,
      promptExcerpt: promptExcerpt || existing.promptExcerpt,
      requestedSkills: Array.from(
        /* @__PURE__ */ new Set([...existing.requestedSkills, ...requestedSkills])
      )
    };
    return stories.map((s) => s.id === id ? merged : s);
  }
  const newStory = {
    id,
    kind,
    route,
    promptExcerpt,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestedSkills
  };
  return [...stories, newStory];
}
function appendObservation(observations, observation) {
  if (observations.some((o) => o.id === observation.id)) {
    return observations;
  }
  return [...observations, observation];
}
function normalizeSerializedPlanState(state) {
  if (state.version === 2) return state;
  const v1 = state;
  const sorted = [...v1.stories].sort((a, b) => {
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  const primaryStory = sorted[0] ?? null;
  const activeStoryId = primaryStory?.id ?? null;
  const storyStates = [];
  if (primaryStory) {
    storyStates.push({
      storyId: primaryStory.id,
      storyKind: primaryStory.kind,
      route: primaryStory.route,
      observationIds: [...v1.observationIds],
      satisfiedBoundaries: v1.satisfiedBoundaries,
      missingBoundaries: v1.missingBoundaries,
      recentRoutes: v1.recentRoutes,
      primaryNextAction: v1.primaryNextAction,
      blockedReasons: v1.blockedReasons,
      lastObservedAt: null
    });
  }
  for (const story of v1.stories) {
    if (story.id === activeStoryId) continue;
    storyStates.push({
      storyId: story.id,
      storyKind: story.kind,
      route: story.route,
      observationIds: [],
      satisfiedBoundaries: [],
      missingBoundaries: ALL_BOUNDARIES,
      recentRoutes: story.route ? [story.route] : [],
      primaryNextAction: null,
      blockedReasons: [],
      lastObservedAt: null
    });
  }
  return {
    version: 2,
    stories: v1.stories,
    activeStoryId,
    storyStates,
    observationIds: v1.observationIds,
    satisfiedBoundaries: v1.satisfiedBoundaries,
    missingBoundaries: v1.missingBoundaries,
    recentRoutes: v1.recentRoutes,
    primaryNextAction: v1.primaryNextAction,
    blockedReasons: v1.blockedReasons
  };
}
function serializePlanState(plan) {
  const storyStates = [];
  for (const story of plan.stories) {
    const ss = plan.storyStates[story.id];
    if (ss) {
      storyStates.push({
        storyId: ss.storyId,
        storyKind: ss.storyKind,
        route: ss.route,
        observationIds: [...ss.observationIds].sort(),
        satisfiedBoundaries: [...ss.satisfiedBoundaries].sort(),
        missingBoundaries: [...ss.missingBoundaries].sort(),
        recentRoutes: ss.recentRoutes,
        primaryNextAction: ss.primaryNextAction,
        blockedReasons: ss.blockedReasons,
        lastObservedAt: ss.lastObservedAt
      });
    }
  }
  const state = {
    version: 2,
    stories: plan.stories,
    activeStoryId: plan.activeStoryId,
    storyStates,
    observationIds: Array.from(plan.observationIds).sort(),
    satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
    missingBoundaries: [...plan.missingBoundaries].sort(),
    recentRoutes: plan.recentRoutes,
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: plan.blockedReasons
  };
  return JSON.stringify(state, null, 2);
}
function sessionIdSegment(sessionId) {
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}
function ledgerDir(sessionId) {
  return join(tmpdir(), `vercel-plugin-${sessionIdSegment(sessionId)}-ledger`);
}
function ledgerPath(sessionId) {
  return join(ledgerDir(sessionId), "observations.jsonl");
}
function storiesPath(sessionId) {
  return join(ledgerDir(sessionId), "stories.json");
}
function statePath(sessionId) {
  return join(ledgerDir(sessionId), "state.json");
}
function persistObservation(sessionId, observation, logger) {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(observation) + "\n";
    appendFileSync(ledgerPath(sessionId), line, "utf-8");
    log.summary("verification-ledger.observation_persisted", {
      observationId: observation.id,
      boundary: observation.boundary,
      source: observation.source
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_observation_failed", error, {
      sessionId,
      observationId: observation.id
    });
  }
}
function persistStories(sessionId, stories, logger) {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storiesPath(sessionId), JSON.stringify(stories, null, 2), "utf-8");
    log.summary("verification-ledger.stories_persisted", {
      storyCount: stories.length
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_stories_failed", error, {
      sessionId
    });
  }
}
function persistPlanState(sessionId, plan, logger) {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(sessionId), serializePlanState(plan), "utf-8");
    log.summary("verification-ledger.state_persisted", {
      observationCount: plan.observations.length,
      storyCount: plan.stories.length,
      missingBoundaries: plan.missingBoundaries
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_state_failed", error, {
      sessionId
    });
  }
}
function loadObservations(sessionId, logger) {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(ledgerPath(sessionId), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    logCaughtError(log, "verification-ledger.load_observations_failed", error, {
      sessionId
    });
    return [];
  }
}
function loadStories(sessionId, logger) {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(storiesPath(sessionId), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    logCaughtError(log, "verification-ledger.load_stories_failed", error, {
      sessionId
    });
    return [];
  }
}
function loadPlanState(sessionId, logger) {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(statePath(sessionId), "utf-8");
    const raw = JSON.parse(content);
    const normalized = normalizeSerializedPlanState(raw);
    if (raw.version !== normalized.version) {
      log.summary("verification-ledger.state_normalized", {
        sessionId,
        fromVersion: raw.version,
        toVersion: normalized.version
      });
    }
    return normalized;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    logCaughtError(log, "verification-ledger.load_state_failed", error, {
      sessionId
    });
    return null;
  }
}
function recordObservation(sessionId, observation, options, logger) {
  const log = logger ?? createLogger();
  const existingObservations = loadObservations(sessionId, log);
  const stories = loadStories(sessionId, log);
  const observations = appendObservation(existingObservations, observation);
  if (observations !== existingObservations) {
    persistObservation(sessionId, observation, log);
  }
  const plan = derivePlan(observations, stories, options);
  persistPlanState(sessionId, plan, log);
  return plan;
}
function recordStory(sessionId, kind, route, promptExcerpt, requestedSkills, options, logger) {
  const log = logger ?? createLogger();
  const observations = loadObservations(sessionId, log);
  let stories = loadStories(sessionId, log);
  stories = upsertStory(stories, kind, route, promptExcerpt, requestedSkills);
  persistStories(sessionId, stories, log);
  const plan = derivePlan(observations, stories, options);
  persistPlanState(sessionId, plan, log);
  return plan;
}
function removeLedgerArtifacts(sessionId, logger) {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    rmSync(dir, { recursive: true, force: true });
    log.summary("verification-ledger.artifacts_removed", { sessionId });
  } catch (error) {
    logCaughtError(log, "verification-ledger.remove_artifacts_failed", error, {
      sessionId
    });
  }
}
export {
  appendObservation,
  collectRecentRoutes,
  derivePlan,
  deriveStoryStates,
  ledgerPath,
  loadObservations,
  loadPlanState,
  loadStories,
  normalizeSerializedPlanState,
  persistObservation,
  persistPlanState,
  persistStories,
  recordObservation,
  recordStory,
  removeLedgerArtifacts,
  resolveObservationStoryId,
  selectActiveStoryId,
  serializePlanState,
  statePath,
  storiesPath,
  storyId,
  upsertStory
};
