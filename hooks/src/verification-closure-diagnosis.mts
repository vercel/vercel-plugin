/**
 * Verification Closure Diagnosis Engine
 *
 * Pure functions for diagnosing why a verification event did or did not
 * resolve routing policy. Three concerns:
 *
 * 1. **Local verification URL inspection** — enriched locality check that
 *    returns structured reasons instead of a bare boolean.
 * 2. **Resolution gate evaluation** — determines eligibility with explicit
 *    blocking reason codes for every failure path.
 * 3. **Pending exposure match diagnosis** — explains zero-match outcomes
 *    (route mismatch, story mismatch, missing scope, etc.).
 *
 * All functions are side-effect-free: they read from arguments or env vars
 * and return deterministic, JSON-serializable results. No ledger mutation.
 */

import { loadSessionExposures, type SkillExposure } from "./routing-policy-ledger.mjs";
import type { RoutingBoundary } from "./routing-policy.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_DEV_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

// ---------------------------------------------------------------------------
// Env helper
// ---------------------------------------------------------------------------

function envString(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Local Verification URL Inspection
// ---------------------------------------------------------------------------

export interface LocalVerificationInspection {
  /** Whether this inspection applies (true for any URL-bearing tool). */
  applicable: boolean;
  /** Whether the URL could be parsed. */
  parseable: boolean;
  /** Whether the URL targets a local dev server, or null if unparseable. */
  isLocal: boolean | null;
  /** The observed host (including port), or null if unparseable. */
  observedHost: string | null;
  /** The VERCEL_PLUGIN_LOCAL_DEV_ORIGIN value, if set. */
  configuredOrigin: string | null;
  /** How locality was determined: loopback, configured-origin, or null. */
  matchSource: "loopback" | "configured-origin" | null;
}

/**
 * Inspect a URL for local-dev-server locality.
 *
 * Returns a structured inspection with explicit reasons instead of a
 * bare boolean, so callers (and agents) can understand *why* a URL
 * was classified as local or remote.
 */
export function inspectLocalVerificationUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalVerificationInspection {
  const configuredOrigin = envString(env, "VERCEL_PLUGIN_LOCAL_DEV_ORIGIN");

  try {
    const url = new URL(rawUrl);
    const observedHost = url.host.toLowerCase();

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        applicable: true,
        parseable: true,
        isLocal: false,
        observedHost,
        configuredOrigin,
        matchSource: null,
      };
    }

    if (LOCAL_DEV_HOSTS.has(url.hostname.toLowerCase())) {
      return {
        applicable: true,
        parseable: true,
        isLocal: true,
        observedHost,
        configuredOrigin,
        matchSource: "loopback",
      };
    }

    if (configuredOrigin) {
      try {
        const configured = new URL(configuredOrigin);
        if (configured.host.toLowerCase() === observedHost) {
          return {
            applicable: true,
            parseable: true,
            isLocal: true,
            observedHost,
            configuredOrigin,
            matchSource: "configured-origin",
          };
        }
      } catch {
        // configured origin is itself unparseable — fall through to remote
      }
    }

    return {
      applicable: true,
      parseable: true,
      isLocal: false,
      observedHost,
      configuredOrigin,
      matchSource: null,
    };
  } catch {
    return {
      applicable: true,
      parseable: false,
      isLocal: null,
      observedHost: null,
      configuredOrigin,
      matchSource: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Resolution Gate Evaluation
// ---------------------------------------------------------------------------

export interface ResolutionGateEvaluation {
  /** Whether the event is eligible to resolve routing policy. */
  eligible: boolean;
  /** Checks that passed (for observability). */
  passedChecks: string[];
  /** Reason codes that blocked resolution (empty when eligible). */
  blockingReasonCodes: string[];
  /** Locality inspection (applicable only for WebFetch). */
  locality: LocalVerificationInspection;
}

/**
 * Evaluate whether a verification event should resolve long-term routing
 * policy outcomes. Returns structured gate results with explicit blocking
 * reason codes for every failure path.
 */
export function evaluateResolutionGate(
  event: {
    boundary: RoutingBoundary | "unknown";
    signalStrength: "strong" | "soft";
    toolName: string;
    command: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): ResolutionGateEvaluation {
  const passedChecks: string[] = [];
  const blockingReasonCodes: string[] = [];

  // Check 1: known boundary
  if (event.boundary === "unknown") {
    blockingReasonCodes.push("unknown_boundary");
  } else {
    passedChecks.push("known_boundary");
  }

  // Check 2: strong signal
  if (event.signalStrength !== "strong") {
    blockingReasonCodes.push("soft_signal");
  } else {
    passedChecks.push("strong_signal");
  }

  // Check 3: WebFetch locality
  let locality: LocalVerificationInspection = {
    applicable: false,
    parseable: true,
    isLocal: null,
    observedHost: null,
    configuredOrigin: envString(env, "VERCEL_PLUGIN_LOCAL_DEV_ORIGIN"),
    matchSource: null,
  };

  if (event.toolName === "WebFetch") {
    locality = inspectLocalVerificationUrl(event.command, env);

    if (!locality.parseable) {
      blockingReasonCodes.push("invalid_web_fetch_url");
    } else if (locality.isLocal !== true) {
      blockingReasonCodes.push("remote_web_fetch");
    } else {
      passedChecks.push("local_verification_url");
    }
  }

  return {
    eligible: blockingReasonCodes.length === 0,
    passedChecks,
    blockingReasonCodes,
    locality,
  };
}

// ---------------------------------------------------------------------------
// Pending Exposure Match Diagnosis
// ---------------------------------------------------------------------------

export interface PendingExposureMatchDiagnosis {
  /** Total pending exposures across all boundaries in this session. */
  pendingTotal: number;
  /** Pending exposures matching the target boundary. */
  pendingBoundaryCount: number;
  /** Exact matches (same boundary + story + route). */
  exactMatchCount: number;
  /** IDs of exact-match exposures. */
  exactMatchExposureIds: string[];
  /** IDs of exposures with same story but different route. */
  sameStoryDifferentRouteExposureIds: string[];
  /** IDs of exposures with same route but different story. */
  sameRouteDifferentStoryExposureIds: string[];
  /** Reason codes explaining why no exact match was found. */
  unresolvedReasonCodes: string[];
}

/**
 * Diagnose why pending exposures did or did not match the observed
 * boundary event. Returns structured match analysis so agents and
 * humans can understand zero-match outcomes.
 *
 * Pure: reads exposures from the provided array or loads them from the
 * session ledger, but never mutates ledger state.
 */
export function diagnosePendingExposureMatch(params: {
  sessionId: string;
  boundary: RoutingBoundary;
  storyId: string | null;
  route: string | null;
  exposures?: SkillExposure[];
}): PendingExposureMatchDiagnosis {
  const exposures =
    params.exposures ?? loadSessionExposures(params.sessionId);

  const pending = exposures.filter(
    (e) => e.sessionId === params.sessionId && e.outcome === "pending",
  );

  const pendingBoundary = pending.filter(
    (e) => e.targetBoundary === params.boundary,
  );

  const exact = pendingBoundary.filter(
    (e) => e.storyId === params.storyId && e.route === params.route,
  );

  const sameStoryDifferentRoute = pendingBoundary.filter(
    (e) => e.storyId === params.storyId && e.route !== params.route,
  );

  const sameRouteDifferentStory = pendingBoundary.filter(
    (e) => e.route === params.route && e.storyId !== params.storyId,
  );

  const unresolvedReasonCodes: string[] = [];

  if (pendingBoundary.length === 0) {
    unresolvedReasonCodes.push("no_pending_for_boundary");
  } else if (exact.length === 0) {
    if (params.storyId === null) unresolvedReasonCodes.push("missing_story_scope");
    if (params.route === null) unresolvedReasonCodes.push("missing_route_scope");
    if (sameStoryDifferentRoute.length > 0) unresolvedReasonCodes.push("route_mismatch");
    if (sameRouteDifferentStory.length > 0) unresolvedReasonCodes.push("story_mismatch");
    if (unresolvedReasonCodes.length === 0) unresolvedReasonCodes.push("no_exact_pending_match");
  }

  return {
    pendingTotal: pending.length,
    pendingBoundaryCount: pendingBoundary.length,
    exactMatchCount: exact.length,
    exactMatchExposureIds: exact.map((e) => e.id),
    sameStoryDifferentRouteExposureIds: sameStoryDifferentRoute.map((e) => e.id),
    sameRouteDifferentStoryExposureIds: sameRouteDifferentStory.map((e) => e.id),
    unresolvedReasonCodes,
  };
}
