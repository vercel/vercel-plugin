/**
 * Verification Ledger: append-only observation log with deterministic state derivation.
 *
 * Provides the state model for an evidence-backed verification planner.
 * Observations are appended to a JSONL ledger; a compact derived state
 * snapshot is recomputed deterministically from the ordered trace.
 *
 * All functions are pure (except persistence I/O) and idempotent:
 * - Appending the same observation twice (by id) is a no-op.
 * - Replaying the same ordered trace produces byte-for-byte identical state JSON.
 *
 * Persistence: JSONL ledger + compact JSON state under session temp storage.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger, logCaughtError, type Logger } from "./logger.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationBoundary =
  | "uiRender"
  | "clientRequest"
  | "serverHandler"
  | "environment";

export type VerificationStoryKind =
  | "flow-verification"
  | "stuck-investigation"
  | "browser-only";

export interface VerificationObservation {
  /** Unique observation id — used for dedup on append. */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Source hook or subsystem that produced this observation. */
  source: "bash" | "prompt" | "edit" | "subagent";
  /** Classified verification boundary (null if not boundary-related). */
  boundary: VerificationBoundary | null;
  /** Inferred route from recent edits or command URL. */
  route: string | null;
  /** Story this observation belongs to (null = unattached). */
  storyId: string | null;
  /** Redacted/truncated command or prompt excerpt. */
  summary: string;
  /** Arbitrary structured metadata. */
  meta?: Record<string, unknown>;
}

export interface VerificationStory {
  /** Stable story id — derived from kind + route. */
  id: string;
  /** Classification of the verification scenario. */
  kind: VerificationStoryKind;
  /** Target route (may be null for global stories). */
  route: string | null;
  /** Prompt excerpt that initiated this story. */
  promptExcerpt: string;
  /** ISO-8601 timestamp of story creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** Skills already selected for this story. */
  requestedSkills: string[];
}

export interface VerificationNextAction {
  /** Human-readable action description. */
  action: string;
  /** Which boundary this action targets. */
  targetBoundary: VerificationBoundary;
  /** Confidence explanation. */
  reason: string;
}

export interface VerificationStoryState {
  storyId: string;
  storyKind: VerificationStoryKind;
  route: string | null;
  observationIds: string[];
  satisfiedBoundaries: VerificationBoundary[];
  missingBoundaries: VerificationBoundary[];
  recentRoutes: string[];
  primaryNextAction: VerificationNextAction | null;
  blockedReasons: string[];
  lastObservedAt: string | null;
}

export interface VerificationPlan {
  /** Active stories (keyed by story id in the map, array in plan). */
  stories: VerificationStory[];
  /** All observations in append order. */
  observations: VerificationObservation[];
  /** Set of observation ids (for fast dedup). */
  observationIds: Set<string>;
  /** Per-story derived state. */
  storyStates: Record<string, VerificationStoryState>;
  /** Active story id (most recently updated). */
  activeStoryId: string | null;
  /** Boundaries that have been satisfied (active-story projection). */
  satisfiedBoundaries: Set<VerificationBoundary>;
  /** Boundaries still missing evidence (active-story projection). */
  missingBoundaries: VerificationBoundary[];
  /** Most recent routes observed (active-story projection). */
  recentRoutes: string[];
  /** Primary next action (active-story projection). */
  primaryNextAction: VerificationNextAction | null;
  /** Reasons why certain actions were blocked (active-story projection). */
  blockedReasons: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_BOUNDARIES: VerificationBoundary[] = [
  "uiRender",
  "clientRequest",
  "serverHandler",
  "environment",
];

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Pure state derivation
// ---------------------------------------------------------------------------

/**
 * Resolve which story an observation belongs to.
 * Prefers explicit storyId, then exact route match, then null.
 */
export function resolveObservationStoryId(
  observation: VerificationObservation,
  stories: VerificationStory[],
): string | null {
  if (observation.storyId) return observation.storyId;
  if (observation.route) {
    const exactMatches = stories.filter((story) => story.route === observation.route);
    if (exactMatches.length === 1) {
      return exactMatches[0]!.id;
    }
  }
  // Fallback: if exactly one story exists, attribute to it
  if (stories.length === 1) {
    return stories[0]!.id;
  }
  return null;
}

/**
 * Collect recent routes from observations, most recent first.
 */
export function collectRecentRoutes(
  observations: VerificationObservation[],
): string[] {
  const sorted = [...observations].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
  const seen = new Set<string>();
  const routes: string[] = [];
  for (const observation of sorted) {
    if (!observation.route) continue;
    if (seen.has(observation.route)) continue;
    seen.add(observation.route);
    routes.push(observation.route);
  }
  return routes;
}

/**
 * Derive per-story boundary state from observations.
 */
export function deriveStoryStates(
  observations: VerificationObservation[],
  stories: VerificationStory[],
  options?: {
    agentBrowserAvailable?: boolean;
    devServerLoopGuardHit?: boolean;
    lastAttemptedAction?: string | null;
    staleThresholdMs?: number;
  },
): Record<string, VerificationStoryState> {
  const opts = {
    agentBrowserAvailable: true,
    devServerLoopGuardHit: false,
    lastAttemptedAction: null as string | null,
    staleThresholdMs: 5 * 60 * 1000,
    ...options,
  };

  const states: Record<string, VerificationStoryState> = {};

  // Initialize empty state for every story
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
      lastObservedAt: null,
    };
  }

  // Group observations by resolved story
  for (const obs of observations) {
    const resolvedStoryId = resolveObservationStoryId(obs, stories);
    if (!resolvedStoryId || !states[resolvedStoryId]) continue;

    const state = states[resolvedStoryId]!;
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

  // Compute missing boundaries and next action per story
  for (const story of stories) {
    const state = states[story.id]!;
    const satisfiedSet = new Set(state.satisfiedBoundaries);
    state.missingBoundaries = ALL_BOUNDARIES.filter((b) => !satisfiedSet.has(b));

    const { primaryNextAction, blockedReasons } = computeNextAction(
      state.missingBoundaries,
      [story],
      state.recentRoutes,
      opts,
    );
    state.primaryNextAction = primaryNextAction;
    state.blockedReasons = blockedReasons;
  }

  return states;
}

/**
 * Select the active story id — prefers most recently updated, then created.
 */
export function selectActiveStoryId(
  stories: VerificationStory[],
  storyStates: Record<string, VerificationStoryState>,
): string | null {
  if (stories.length === 0) return null;

  // Sort: prefer stories with missing boundaries (incomplete first),
  // then most recently updated
  const sorted = [...stories].sort((a, b) => {
    const stateA = storyStates[a.id];
    const stateB = storyStates[b.id];
    const missingA = stateA ? stateA.missingBoundaries.length : 0;
    const missingB = stateB ? stateB.missingBoundaries.length : 0;

    // Incomplete stories first (more missing = higher priority)
    if (missingA !== missingB) return missingB - missingA;

    // Then most recently updated
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;

    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;

    return a.id.localeCompare(b.id);
  });

  return sorted[0]!.id;
}

/**
 * Derive a VerificationPlan from ordered observations and stories.
 * This is a pure function — same inputs always produce identical output.
 *
 * Top-level fields (satisfiedBoundaries, missingBoundaries, recentRoutes,
 * primaryNextAction, blockedReasons) are the active-story projection.
 */
export function derivePlan(
  observations: VerificationObservation[],
  stories: VerificationStory[],
  options?: {
    agentBrowserAvailable?: boolean;
    devServerLoopGuardHit?: boolean;
    lastAttemptedAction?: string | null;
    staleThresholdMs?: number;
  },
): VerificationPlan {
  // Build dedup set
  const observationIds = new Set<string>();
  const deduped: VerificationObservation[] = [];
  for (const obs of observations) {
    if (!observationIds.has(obs.id)) {
      observationIds.add(obs.id);
      deduped.push(obs);
    }
  }

  // Derive per-story state
  const storyStates = deriveStoryStates(deduped, stories, options);
  const activeStoryId = selectActiveStoryId(stories, storyStates);

  // Project active story state to top-level fields
  const activeState = activeStoryId ? storyStates[activeStoryId] : null;

  const satisfiedBoundaries = new Set<VerificationBoundary>(
    activeState ? activeState.satisfiedBoundaries : [],
  );
  const missingBoundaries = activeState ? activeState.missingBoundaries : (
    stories.length > 0 ? [...ALL_BOUNDARIES] : []
  );
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
    blockedReasons,
  };
}

/**
 * Compute the single best next verification action.
 */
function computeNextAction(
  missingBoundaries: VerificationBoundary[],
  stories: VerificationStory[],
  recentRoutes: string[],
  opts: {
    agentBrowserAvailable: boolean;
    devServerLoopGuardHit: boolean;
    lastAttemptedAction: string | null;
  },
): { primaryNextAction: VerificationNextAction | null; blockedReasons: string[] } {
  const blockedReasons: string[] = [];

  if (stories.length === 0) {
    return { primaryNextAction: null, blockedReasons };
  }

  if (missingBoundaries.length === 0) {
    return { primaryNextAction: null, blockedReasons };
  }

  const route = recentRoutes[recentRoutes.length - 1] ?? null;
  const routeSuffix = route ? ` ${route}` : "";

  // Priority order for boundary actions
  const ACTION_MAP: Record<VerificationBoundary, () => VerificationNextAction | null> = {
    clientRequest: () => ({
      action: `curl http://localhost:3000${route ?? "/"}`,
      targetBoundary: "clientRequest",
      reason: "No HTTP request observation yet — verify the endpoint responds",
    }),
    serverHandler: () => ({
      action: `tail server logs${routeSuffix}`,
      targetBoundary: "serverHandler",
      reason: "No server-side observation yet — check logs for errors",
    }),
    uiRender: () => {
      if (!opts.agentBrowserAvailable) {
        blockedReasons.push("agent-browser unavailable — cannot emit browser-only action");
        return null;
      }
      if (opts.devServerLoopGuardHit) {
        blockedReasons.push("dev-server loop guard hit — skipping browser verification");
        return null;
      }
      return {
        action: `open${routeSuffix || " /"} in agent-browser`,
        targetBoundary: "uiRender",
        reason: "No UI render observation yet — visually verify the page",
      };
    },
    environment: () => ({
      action: "inspect env for required vars",
      targetBoundary: "environment",
      reason: "No environment observation yet — check env vars are set",
    }),
  };

  // Walk boundaries in priority order
  const PRIORITY_ORDER: VerificationBoundary[] = [
    "clientRequest",
    "serverHandler",
    "uiRender",
    "environment",
  ];

  for (const boundary of PRIORITY_ORDER) {
    if (!missingBoundaries.includes(boundary)) continue;

    const action = ACTION_MAP[boundary]();
    if (action) {
      // Suppress if this is the same as the last attempted action
      if (opts.lastAttemptedAction && action.action === opts.lastAttemptedAction) {
        blockedReasons.push(
          `Suppressed repeat of last attempted action: ${opts.lastAttemptedAction}`,
        );
        continue;
      }
      return { primaryNextAction: action, blockedReasons };
    }
  }

  return { primaryNextAction: null, blockedReasons };
}

// ---------------------------------------------------------------------------
// Story helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable story id from kind + route.
 */
export function storyId(kind: VerificationStoryKind, route: string | null): string {
  const input = `${kind}:${route ?? "*"}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Create a new story or merge into an existing one.
 * Returns the updated stories array (does not mutate input).
 */
export function upsertStory(
  stories: VerificationStory[],
  kind: VerificationStoryKind,
  route: string | null,
  promptExcerpt: string,
  requestedSkills: string[],
  now?: string,
): VerificationStory[] {
  const id = storyId(kind, route);
  const timestamp = now ?? new Date().toISOString();

  const existing = stories.find((s) => s.id === id);
  if (existing) {
    // Merge: update timestamp, merge skills
    const merged: VerificationStory = {
      ...existing,
      updatedAt: timestamp,
      promptExcerpt: promptExcerpt || existing.promptExcerpt,
      requestedSkills: Array.from(
        new Set([...existing.requestedSkills, ...requestedSkills]),
      ),
    };
    return stories.map((s) => (s.id === id ? merged : s));
  }

  const newStory: VerificationStory = {
    id,
    kind,
    route,
    promptExcerpt,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestedSkills,
  };
  return [...stories, newStory];
}

// ---------------------------------------------------------------------------
// Append (with dedup)
// ---------------------------------------------------------------------------

/**
 * Append an observation to an ordered list, deduplicating by id.
 * Returns the new list (does not mutate input).
 */
export function appendObservation(
  observations: VerificationObservation[],
  observation: VerificationObservation,
): VerificationObservation[] {
  if (observations.some((o) => o.id === observation.id)) {
    return observations; // idempotent — same reference means no change
  }
  return [...observations, observation];
}

// ---------------------------------------------------------------------------
// Serialization (for persistence)
// ---------------------------------------------------------------------------

export interface SerializedPlanStateV1 {
  version: 1;
  stories: VerificationStory[];
  observationIds: string[];
  satisfiedBoundaries: string[];
  missingBoundaries: string[];
  recentRoutes: string[];
  primaryNextAction: VerificationNextAction | null;
  blockedReasons: string[];
}

export interface SerializedPlanStateV2 {
  version: 2;
  stories: VerificationStory[];
  activeStoryId: string | null;
  storyStates: Array<{
    storyId: string;
    storyKind: VerificationStoryKind;
    route: string | null;
    observationIds: string[];
    satisfiedBoundaries: VerificationBoundary[];
    missingBoundaries: VerificationBoundary[];
    recentRoutes: string[];
    primaryNextAction: VerificationNextAction | null;
    blockedReasons: string[];
    lastObservedAt: string | null;
  }>;
  observationIds: string[];
  satisfiedBoundaries: VerificationBoundary[];
  missingBoundaries: VerificationBoundary[];
  recentRoutes: string[];
  primaryNextAction: VerificationNextAction | null;
  blockedReasons: string[];
}

/** Union of all serialized state versions. */
export type SerializedPlanState = SerializedPlanStateV1 | SerializedPlanStateV2;

/**
 * Normalize any serialized plan state to version 2.
 * V1 state is upgraded by synthesizing one active-story entry from top-level fields.
 */
export function normalizeSerializedPlanState(
  state: SerializedPlanState,
): SerializedPlanStateV2 {
  if (state.version === 2) return state;

  // V1 → V2: synthesize active-story state from the flat top-level fields
  const v1 = state as SerializedPlanStateV1;

  // Import selectPrimaryStory logic inline to avoid circular deps
  const sorted = [...v1.stories].sort((a, b) => {
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  const primaryStory = sorted[0] ?? null;
  const activeStoryId = primaryStory?.id ?? null;

  const storyStates: SerializedPlanStateV2["storyStates"] = [];
  if (primaryStory) {
    storyStates.push({
      storyId: primaryStory.id,
      storyKind: primaryStory.kind,
      route: primaryStory.route,
      observationIds: [...v1.observationIds],
      satisfiedBoundaries: v1.satisfiedBoundaries as VerificationBoundary[],
      missingBoundaries: v1.missingBoundaries as VerificationBoundary[],
      recentRoutes: v1.recentRoutes,
      primaryNextAction: v1.primaryNextAction,
      blockedReasons: v1.blockedReasons,
      lastObservedAt: null,
    });
  }

  // Add empty entries for non-active stories
  for (const story of v1.stories) {
    if (story.id === activeStoryId) continue;
    storyStates.push({
      storyId: story.id,
      storyKind: story.kind,
      route: story.route,
      observationIds: [],
      satisfiedBoundaries: [],
      missingBoundaries: ALL_BOUNDARIES as VerificationBoundary[],
      recentRoutes: story.route ? [story.route] : [],
      primaryNextAction: null,
      blockedReasons: [],
      lastObservedAt: null,
    });
  }

  return {
    version: 2,
    stories: v1.stories,
    activeStoryId,
    storyStates,
    observationIds: v1.observationIds,
    satisfiedBoundaries: v1.satisfiedBoundaries as VerificationBoundary[],
    missingBoundaries: v1.missingBoundaries as VerificationBoundary[],
    recentRoutes: v1.recentRoutes,
    primaryNextAction: v1.primaryNextAction,
    blockedReasons: v1.blockedReasons,
  };
}

/**
 * Serialize a VerificationPlan to a deterministic JSON string (version 2).
 * Sets and arrays are sorted for byte-for-byte reproducibility.
 */
export function serializePlanState(plan: VerificationPlan): string {
  const storyStates: SerializedPlanStateV2["storyStates"] = [];
  for (const story of plan.stories) {
    const ss = plan.storyStates[story.id];
    if (ss) {
      storyStates.push({
        storyId: ss.storyId,
        storyKind: ss.storyKind,
        route: ss.route,
        observationIds: [...ss.observationIds].sort(),
        satisfiedBoundaries: [...ss.satisfiedBoundaries].sort() as VerificationBoundary[],
        missingBoundaries: [...ss.missingBoundaries].sort() as VerificationBoundary[],
        recentRoutes: ss.recentRoutes,
        primaryNextAction: ss.primaryNextAction,
        blockedReasons: ss.blockedReasons,
        lastObservedAt: ss.lastObservedAt,
      });
    }
  }

  const state: SerializedPlanStateV2 = {
    version: 2,
    stories: plan.stories,
    activeStoryId: plan.activeStoryId,
    storyStates,
    observationIds: Array.from(plan.observationIds).sort(),
    satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort() as VerificationBoundary[],
    missingBoundaries: [...plan.missingBoundaries].sort() as VerificationBoundary[],
    recentRoutes: plan.recentRoutes,
    primaryNextAction: plan.primaryNextAction,
    blockedReasons: plan.blockedReasons,
  };
  return JSON.stringify(state, null, 2);
}

// ---------------------------------------------------------------------------
// Persistence (JSONL ledger + compact state)
// ---------------------------------------------------------------------------

function sessionIdSegment(sessionId: string): string {
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}

function ledgerDir(sessionId: string): string {
  return join(tmpdir(), `vercel-plugin-${sessionIdSegment(sessionId)}-ledger`);
}

export function ledgerPath(sessionId: string): string {
  return join(ledgerDir(sessionId), "observations.jsonl");
}

export function storiesPath(sessionId: string): string {
  return join(ledgerDir(sessionId), "stories.json");
}

export function statePath(sessionId: string): string {
  return join(ledgerDir(sessionId), "state.json");
}

/**
 * Persist an observation to the session JSONL ledger.
 * Idempotent — duplicate ids are skipped at derive time.
 */
export function persistObservation(
  sessionId: string,
  observation: VerificationObservation,
  logger?: Logger,
): void {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(observation) + "\n";
    appendFileSync(ledgerPath(sessionId), line, "utf-8");
    log.summary("verification-ledger.observation_persisted", {
      observationId: observation.id,
      boundary: observation.boundary,
      source: observation.source,
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_observation_failed", error, {
      sessionId,
      observationId: observation.id,
    });
  }
}

/**
 * Persist stories to the session storage.
 */
export function persistStories(
  sessionId: string,
  stories: VerificationStory[],
  logger?: Logger,
): void {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storiesPath(sessionId), JSON.stringify(stories, null, 2), "utf-8");
    log.summary("verification-ledger.stories_persisted", {
      storyCount: stories.length,
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_stories_failed", error, {
      sessionId,
    });
  }
}

/**
 * Persist derived plan state to the session snapshot file.
 */
export function persistPlanState(
  sessionId: string,
  plan: VerificationPlan,
  logger?: Logger,
): void {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(sessionId), serializePlanState(plan), "utf-8");
    log.summary("verification-ledger.state_persisted", {
      observationCount: plan.observations.length,
      storyCount: plan.stories.length,
      missingBoundaries: plan.missingBoundaries,
    });
  } catch (error) {
    logCaughtError(log, "verification-ledger.persist_state_failed", error, {
      sessionId,
    });
  }
}

/**
 * Load observations from the session JSONL ledger.
 */
export function loadObservations(
  sessionId: string,
  logger?: Logger,
): VerificationObservation[] {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(ledgerPath(sessionId), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    return lines.map((line) => JSON.parse(line) as VerificationObservation);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return []; // no ledger yet
    }
    logCaughtError(log, "verification-ledger.load_observations_failed", error, {
      sessionId,
    });
    return [];
  }
}

/**
 * Load stories from the session storage.
 */
export function loadStories(
  sessionId: string,
  logger?: Logger,
): VerificationStory[] {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(storiesPath(sessionId), "utf-8");
    return JSON.parse(content) as VerificationStory[];
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    logCaughtError(log, "verification-ledger.load_stories_failed", error, {
      sessionId,
    });
    return [];
  }
}

/**
 * Load the derived plan state from the session snapshot.
 * Always normalizes to V2 format for consumers.
 */
export function loadPlanState(
  sessionId: string,
  logger?: Logger,
): SerializedPlanStateV2 | null {
  const log = logger ?? createLogger();
  try {
    const content = readFileSync(statePath(sessionId), "utf-8");
    const raw = JSON.parse(content) as SerializedPlanState;
    const normalized = normalizeSerializedPlanState(raw);
    if (raw.version !== normalized.version) {
      log.summary("verification-ledger.state_normalized", {
        sessionId,
        fromVersion: raw.version,
        toVersion: normalized.version,
      });
    }
    return normalized;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    logCaughtError(log, "verification-ledger.load_state_failed", error, {
      sessionId,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full cycle: append → derive → persist
// ---------------------------------------------------------------------------

/**
 * Append an observation, re-derive state, and persist everything.
 * Returns the updated plan. Idempotent by observation id.
 */
export function recordObservation(
  sessionId: string,
  observation: VerificationObservation,
  options?: {
    agentBrowserAvailable?: boolean;
    devServerLoopGuardHit?: boolean;
    lastAttemptedAction?: string | null;
  },
  logger?: Logger,
): VerificationPlan {
  const log = logger ?? createLogger();

  // Load current state
  const existingObservations = loadObservations(sessionId, log);
  const stories = loadStories(sessionId, log);

  // Append (dedup by id)
  const observations = appendObservation(existingObservations, observation);

  // Keep the append-only ledger idempotent by observation id.
  if (observations !== existingObservations) {
    persistObservation(sessionId, observation, log);
  }

  // Derive
  const plan = derivePlan(observations, stories, options);

  // Persist state
  persistPlanState(sessionId, plan, log);

  return plan;
}

/**
 * Create or update a story, re-derive state, and persist.
 * Returns the updated plan.
 */
export function recordStory(
  sessionId: string,
  kind: VerificationStoryKind,
  route: string | null,
  promptExcerpt: string,
  requestedSkills: string[],
  options?: {
    agentBrowserAvailable?: boolean;
    devServerLoopGuardHit?: boolean;
    lastAttemptedAction?: string | null;
  },
  logger?: Logger,
): VerificationPlan {
  const log = logger ?? createLogger();

  const observations = loadObservations(sessionId, log);
  let stories = loadStories(sessionId, log);

  // Upsert story
  stories = upsertStory(stories, kind, route, promptExcerpt, requestedSkills);

  // Persist stories
  persistStories(sessionId, stories, log);

  // Derive
  const plan = derivePlan(observations, stories, options);

  // Persist state
  persistPlanState(sessionId, plan, log);

  return plan;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all ledger artifacts for a session.
 */
export function removeLedgerArtifacts(sessionId: string, logger?: Logger): void {
  const log = logger ?? createLogger();
  const dir = ledgerDir(sessionId);
  try {
    rmSync(dir, { recursive: true, force: true });
    log.summary("verification-ledger.artifacts_removed", { sessionId });
  } catch (error) {
    logCaughtError(log, "verification-ledger.remove_artifacts_failed", error, {
      sessionId,
    });
  }
}
