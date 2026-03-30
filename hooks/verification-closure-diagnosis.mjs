// hooks/src/verification-closure-diagnosis.mts
import { loadSessionExposures } from "./routing-policy-ledger.mjs";
var LOCAL_DEV_HOSTS = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]"
]);
function envString(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function inspectLocalVerificationUrl(rawUrl, env = process.env) {
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
        matchSource: null
      };
    }
    if (LOCAL_DEV_HOSTS.has(url.hostname.toLowerCase())) {
      return {
        applicable: true,
        parseable: true,
        isLocal: true,
        observedHost,
        configuredOrigin,
        matchSource: "loopback"
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
            matchSource: "configured-origin"
          };
        }
      } catch {
      }
    }
    return {
      applicable: true,
      parseable: true,
      isLocal: false,
      observedHost,
      configuredOrigin,
      matchSource: null
    };
  } catch {
    return {
      applicable: true,
      parseable: false,
      isLocal: null,
      observedHost: null,
      configuredOrigin,
      matchSource: null
    };
  }
}
function evaluateResolutionGate(event, env = process.env) {
  const passedChecks = [];
  const blockingReasonCodes = [];
  if (event.boundary === "unknown") {
    blockingReasonCodes.push("unknown_boundary");
  } else {
    passedChecks.push("known_boundary");
  }
  if (event.signalStrength !== "strong") {
    blockingReasonCodes.push("soft_signal");
  } else {
    passedChecks.push("strong_signal");
  }
  let locality = {
    applicable: false,
    parseable: true,
    isLocal: null,
    observedHost: null,
    configuredOrigin: envString(env, "VERCEL_PLUGIN_LOCAL_DEV_ORIGIN"),
    matchSource: null
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
    locality
  };
}
function diagnosePendingExposureMatch(params) {
  const exposures = params.exposures ?? loadSessionExposures(params.sessionId);
  const pending = exposures.filter(
    (e) => e.sessionId === params.sessionId && e.outcome === "pending"
  );
  const pendingBoundary = pending.filter(
    (e) => e.targetBoundary === params.boundary
  );
  const exact = pendingBoundary.filter(
    (e) => e.storyId === params.storyId && e.route === params.route
  );
  const sameStoryDifferentRoute = pendingBoundary.filter(
    (e) => e.storyId === params.storyId && e.route !== params.route
  );
  const sameRouteDifferentStory = pendingBoundary.filter(
    (e) => e.route === params.route && e.storyId !== params.storyId
  );
  const unresolvedReasonCodes = [];
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
    unresolvedReasonCodes
  };
}
export {
  diagnosePendingExposureMatch,
  evaluateResolutionGate,
  inspectLocalVerificationUrl
};
