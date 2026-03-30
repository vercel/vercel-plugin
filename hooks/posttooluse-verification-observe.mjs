#!/usr/bin/env node

// hooks/src/posttooluse-verification-observe.mts
import { readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { generateVerificationId } from "./hook-env.mjs";
import { createLogger } from "./logger.mjs";
import { redactCommand } from "./pretooluse-skill-inject.mjs";
import {
  recordObservation
} from "./verification-ledger.mjs";
import { resolveBoundaryOutcome } from "./routing-policy-ledger.mjs";
import { selectActiveStory } from "./verification-plan.mjs";
import {
  appendRoutingDecisionTrace,
  createDecisionId
} from "./routing-decision-trace.mjs";
import {
  classifyVerificationSignal
} from "./verification-signal.mjs";
import {
  evaluateResolutionGate,
  diagnosePendingExposureMatch
} from "./verification-closure-diagnosis.mjs";
import {
  buildVerificationClosureCapsule,
  persistVerificationClosureCapsule
} from "./verification-closure-capsule.mjs";
function isVerificationReport(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return obj.type === "verification.report/v1" && typeof obj.verificationId === "string" && Array.isArray(obj.boundaries) && obj.boundaries.every(
    (b) => typeof b === "object" && b !== null && b.event === "verification.boundary_observed"
  );
}
var LOCAL_DEV_HOSTS = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]"
]);
function isLocalVerificationUrl(rawUrl, env = process.env) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (LOCAL_DEV_HOSTS.has(hostname)) return true;
    const configuredOrigin = envString(env, "VERCEL_PLUGIN_LOCAL_DEV_ORIGIN");
    if (!configuredOrigin) return false;
    const configured = new URL(configuredOrigin);
    return configured.host.toLowerCase() === url.host.toLowerCase();
  } catch {
    return false;
  }
}
function resolveObservedStory(plan, observedRoute, env = process.env) {
  const explicit = envString(env, "VERCEL_PLUGIN_VERIFICATION_STORY_ID");
  if (explicit) return { storyId: explicit, method: "explicit-env" };
  if (observedRoute) {
    const exact = plan.stories.filter((story) => story.route === observedRoute);
    if (exact.length === 1) {
      return { storyId: exact[0].id, method: "exact-route" };
    }
  }
  if (plan.activeStoryId) {
    return { storyId: plan.activeStoryId, method: "active-story" };
  }
  return { storyId: null, method: "none" };
}
function resolveObservedStoryId(plan, observedRoute, env = process.env) {
  return resolveObservedStory(plan, observedRoute, env).storyId;
}
function shouldResolveRoutingOutcome(event, env = process.env) {
  if (event.boundary === "unknown") return false;
  if (event.signalStrength !== "strong") return false;
  if (event.toolName === "WebFetch") {
    return isLocalVerificationUrl(event.command, env);
  }
  return true;
}
var BOUNDARY_PATTERNS = [
  // uiRender: browser/screenshot/playwright/puppeteer commands
  { boundary: "uiRender", pattern: /\b(open|launch|browse|screenshot|puppeteer|playwright|chromium|firefox|webkit)\b/i, label: "browser-tool" },
  { boundary: "uiRender", pattern: /\bopen\s+https?:/i, label: "open-url" },
  { boundary: "uiRender", pattern: /\bnpx\s+playwright\b/i, label: "playwright-cli" },
  // clientRequest: curl, fetch, wget, httpie
  { boundary: "clientRequest", pattern: /\b(curl|wget|http|httpie)\b/i, label: "http-client" },
  { boundary: "clientRequest", pattern: /\bfetch\s*\(/i, label: "fetch-call" },
  { boundary: "clientRequest", pattern: /\bnpx\s+undici\b/i, label: "undici-cli" },
  // serverHandler: log tailing, server process inspection
  { boundary: "serverHandler", pattern: /\b(tail|less|cat)\b.*\.(log|out|err)\b/i, label: "log-tail" },
  { boundary: "serverHandler", pattern: /\b(tail\s+-f|journalctl\s+-f)\b/i, label: "log-follow" },
  { boundary: "serverHandler", pattern: /\blog(s)?\s/i, label: "log-command" },
  { boundary: "serverHandler", pattern: /\b(vercel\s+logs|vercel\s+inspect)\b/i, label: "vercel-logs" },
  { boundary: "serverHandler", pattern: /\b(lsof|netstat|ss)\s.*:(3000|3001|4000|5173|8080)\b/i, label: "port-inspect" },
  // environment: env reads, config inspection
  { boundary: "environment", pattern: /\b(printenv|env\b|echo\s+\$)/i, label: "env-read" },
  { boundary: "environment", pattern: /\bvercel\s+env\b/i, label: "vercel-env" },
  { boundary: "environment", pattern: /\bcat\b.*\.env\b/i, label: "dotenv-read" },
  { boundary: "environment", pattern: /\bnode\s+-e\b.*process\.env\b/i, label: "node-env" }
];
function classifyBoundary(command) {
  for (const bp of BOUNDARY_PATTERNS) {
    if (bp.pattern.test(command)) {
      return { boundary: bp.boundary, matchedPattern: bp.label };
    }
  }
  return { boundary: "unknown", matchedPattern: "none" };
}
function classifyToolSignal(toolName, toolInput) {
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "");
    if (!filePath) return null;
    if (/\.env(\.\w+)?$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "env-file-read",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath
      };
    }
    if (/vercel\.json$/.test(filePath) || /\.vercel\/project\.json$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "vercel-config-read",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath
      };
    }
    if (/\.(log|out|err)$/.test(filePath) || /vercel-logs/.test(filePath) || /\.next\/.*server.*\.log/.test(filePath)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-file-read",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: filePath
      };
    }
    return null;
  }
  if (toolName === "WebFetch") {
    const url = String(toolInput.url || "");
    if (!url) return null;
    return {
      boundary: "clientRequest",
      matchedPattern: "web-fetch",
      signalStrength: "strong",
      evidenceSource: "http",
      summary: url.slice(0, 200)
    };
  }
  if (toolName === "Grep") {
    const path = String(toolInput.path || "");
    if (/\.(log|out|err)$/.test(path) || /logs?\//.test(path)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-grep",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200)
      };
    }
    if (/\.env/.test(path)) {
      return {
        boundary: "environment",
        matchedPattern: "env-grep",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200)
      };
    }
    return null;
  }
  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    if (/\*\.(log|out|err)/.test(pattern) || /logs?\//.test(pattern)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-glob",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `glob ${pattern}`.slice(0, 200)
      };
    }
    if (/\.env/.test(pattern)) {
      return {
        boundary: "environment",
        matchedPattern: "env-glob",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `glob ${pattern}`.slice(0, 200)
      };
    }
    return null;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return null;
  }
  return null;
}
function buildBoundaryEvent(input) {
  const env = input.env ?? process.env;
  const redactedCommand = redactCommand(input.command).slice(0, 200);
  const suggestedBoundary = env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY || null;
  const suggestedAction = env.VERCEL_PLUGIN_VERIFICATION_ACTION ? redactCommand(env.VERCEL_PLUGIN_VERIFICATION_ACTION).slice(0, 200) : null;
  return {
    event: "verification.boundary_observed",
    boundary: input.boundary,
    verificationId: input.verificationId,
    command: redactedCommand,
    matchedPattern: input.matchedPattern,
    inferredRoute: input.inferredRoute,
    timestamp: input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
    suggestedBoundary,
    suggestedAction,
    matchedSuggestedAction: suggestedBoundary !== null && suggestedBoundary === input.boundary || suggestedAction !== null && suggestedAction === redactedCommand,
    signalStrength: input.signalStrength ?? "strong",
    evidenceSource: input.evidenceSource ?? "bash",
    toolName: input.toolName ?? "Bash"
  };
}
function buildLedgerObservation(event, env = process.env) {
  const storyIdValue = env.VERCEL_PLUGIN_VERIFICATION_STORY_ID;
  const sourceMap = {
    "bash": "bash",
    "browser": "bash",
    "http": "bash",
    "log-read": "edit",
    "env-read": "edit",
    "file-read": "edit",
    "unknown": "bash"
  };
  return {
    id: event.verificationId,
    timestamp: event.timestamp,
    source: sourceMap[event.evidenceSource] ?? "bash",
    boundary: event.boundary === "unknown" ? null : event.boundary,
    route: event.inferredRoute,
    storyId: typeof storyIdValue === "string" && storyIdValue.trim() !== "" ? storyIdValue.trim() : null,
    summary: event.command,
    meta: {
      matchedPattern: event.matchedPattern,
      suggestedBoundary: event.suggestedBoundary,
      suggestedAction: event.suggestedAction,
      matchedSuggestedAction: event.matchedSuggestedAction,
      toolName: event.toolName,
      signalStrength: event.signalStrength,
      evidenceSource: event.evidenceSource
    }
  };
}
function envString(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function resolveObservedRoute(inferredRoute, env = process.env) {
  return inferredRoute ?? envString(env, "VERCEL_PLUGIN_VERIFICATION_ROUTE");
}
var ROUTE_REGEX = /\b(?:app|pages|src\/pages|src\/app)\/([\w[\].-]+(?:\/[\w[\].-]+)*)/;
var URL_ROUTE_REGEX = /https?:\/\/[^/\s]+(\/([\w-]+(?:\/[\w-]+)*))/;
function inferRoute(command, recentEdits) {
  if (recentEdits) {
    const paths = recentEdits.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      const match = ROUTE_REGEX.exec(p);
      if (match) {
        const route = "/" + match[1].replace(/\/page\.\w+$/, "").replace(/\/route\.\w+$/, "").replace(/\/layout\.\w+$/, "").replace(/\/loading\.\w+$/, "").replace(/\/error\.\w+$/, "").replace(/\[([^\]]+)\]/g, ":$1");
        return route === "/" ? "/" : route.replace(/\/$/, "");
      }
    }
  }
  const urlMatch = URL_ROUTE_REGEX.exec(command);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  return null;
}
function inferRouteFromFilePath(filePath) {
  const match = ROUTE_REGEX.exec(filePath);
  if (match) {
    const route = "/" + match[1].replace(/\/page\.\w+$/, "").replace(/\/route\.\w+$/, "").replace(/\/layout\.\w+$/, "").replace(/\/loading\.\w+$/, "").replace(/\/error\.\w+$/, "").replace(/\[([^\]]+)\]/g, ":$1");
    return route === "/" ? "/" : route.replace(/\/$/, "");
  }
  return null;
}
var SUPPORTED_TOOLS = /* @__PURE__ */ new Set(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"]);
function parseInput(raw, logger) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let input;
  try {
    input = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const toolName = input.tool_name || "";
  if (!SUPPORTED_TOOLS.has(toolName)) return null;
  const toolInput = input.tool_input || {};
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    if (!command) return null;
  }
  const sessionId = input.session_id || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;
  return { toolName, toolInput, sessionId, cwd };
}
function run(rawInput) {
  const log = createLogger();
  let raw;
  if (rawInput !== void 0) {
    raw = rawInput;
  } else {
    try {
      raw = readFileSync(0, "utf-8");
    } catch {
      return "{}";
    }
  }
  const parsed = parseInput(raw, log);
  if (!parsed) {
    log.debug("verification-observe-skip", { reason: "no_supported_input" });
    return "{}";
  }
  const { toolName, toolInput, sessionId } = parsed;
  const env = process.env;
  const signal = classifyVerificationSignal({ toolName, toolInput, env });
  if (!signal) {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      toolName
    });
    return "{}";
  }
  if (signal.boundary === "unknown") {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      toolName,
      summary: signal.summary.slice(0, 120)
    });
    return "{}";
  }
  const { boundary, matchedPattern, signalStrength, evidenceSource, summary } = signal;
  const verificationId = generateVerificationId();
  const recentEdits = env.VERCEL_PLUGIN_RECENT_EDITS || "";
  let inferredRoute;
  if (toolName === "Bash") {
    inferredRoute = resolveObservedRoute(inferRoute(summary, recentEdits), env);
  } else {
    const filePath = String(toolInput.file_path || toolInput.path || toolInput.url || "");
    inferredRoute = resolveObservedRoute(
      inferRouteFromFilePath(filePath) ?? inferRoute(summary, recentEdits),
      env
    );
  }
  const boundaryEvent = buildBoundaryEvent({
    command: summary,
    boundary,
    matchedPattern,
    inferredRoute,
    verificationId,
    signalStrength,
    evidenceSource,
    toolName
  });
  log.summary("verification.boundary_observed", boundaryEvent);
  if (sessionId) {
    const plan = recordObservation(
      sessionId,
      buildLedgerObservation(boundaryEvent),
      {
        agentBrowserAvailable: process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE !== "0",
        lastAttemptedAction: process.env.VERCEL_PLUGIN_VERIFICATION_ACTION || null
      },
      log
    );
    log.summary("verification.plan_feedback", {
      verificationId,
      toolName,
      signalStrength,
      evidenceSource,
      matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
      satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
      missingBoundaries: [...plan.missingBoundaries],
      primaryNextAction: plan.primaryNextAction,
      blockedReasons: [...plan.blockedReasons]
    });
    const activeStory = plan.stories.length > 0 ? selectActiveStory(plan) : null;
    const storyResolution = resolveObservedStory(
      {
        stories: plan.stories.map((s) => ({ id: s.id, route: s.route })),
        activeStoryId: activeStory?.id ?? null
      },
      inferredRoute,
      env
    );
    const gate = evaluateResolutionGate(
      {
        boundary: boundaryEvent.boundary,
        signalStrength,
        toolName,
        command: boundaryEvent.command
      },
      env
    );
    const exposureDiagnosis = boundaryEvent.boundary === "unknown" ? null : diagnosePendingExposureMatch({
      sessionId,
      boundary: boundaryEvent.boundary,
      storyId: storyResolution.storyId,
      route: inferredRoute
    });
    let resolved = [];
    if (gate.eligible && boundaryEvent.boundary !== "unknown") {
      resolved = resolveBoundaryOutcome({
        sessionId,
        boundary: boundaryEvent.boundary,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
        storyId: storyResolution.storyId,
        route: inferredRoute,
        now: boundaryEvent.timestamp
      });
    } else {
      log.debug("verification.routing-policy-skipped", {
        verificationId,
        boundary: boundaryEvent.boundary,
        toolName,
        blockingReasonCodes: gate.blockingReasonCodes,
        signalStrength
      });
    }
    if (gate.eligible && resolved.length === 0) {
      log.debug("verification.routing-policy-unresolved", {
        verificationId,
        boundary: boundaryEvent.boundary,
        toolName,
        storyId: storyResolution.storyId,
        route: inferredRoute,
        unresolvedReasonCodes: exposureDiagnosis?.unresolvedReasonCodes ?? [
          "no_exact_pending_match"
        ],
        pendingBoundaryCount: exposureDiagnosis?.pendingBoundaryCount ?? 0
      });
    }
    const closureCapsule = buildVerificationClosureCapsule({
      sessionId,
      verificationId,
      toolName,
      createdAt: boundaryEvent.timestamp,
      observation: {
        boundary: boundaryEvent.boundary,
        signalStrength,
        evidenceSource,
        matchedPattern,
        command: boundaryEvent.command,
        inferredRoute,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction
      },
      storyResolution: {
        resolvedStoryId: storyResolution.storyId,
        method: storyResolution.method,
        activeStoryId: activeStory?.id ?? null,
        activeStoryKind: activeStory?.kind ?? null,
        activeStoryRoute: activeStory?.route ?? null
      },
      gate,
      exposureDiagnosis,
      resolvedExposures: resolved,
      plan: {
        activeStoryId: plan.activeStoryId ?? null,
        satisfiedBoundaries: plan.satisfiedBoundaries,
        missingBoundaries: [...plan.missingBoundaries],
        blockedReasons: [...plan.blockedReasons],
        primaryNextAction: plan.primaryNextAction ? {
          action: plan.primaryNextAction.action,
          targetBoundary: plan.primaryNextAction.targetBoundary,
          reason: plan.primaryNextAction.reason
        } : null
      }
    });
    const capsulePath = persistVerificationClosureCapsule(
      closureCapsule,
      log
    );
    log.summary("verification.routing-policy-resolution-gate", {
      verificationId,
      toolName,
      boundary: boundaryEvent.boundary,
      inferredRoute,
      resolvedStoryId: storyResolution.storyId,
      storyResolutionMethod: storyResolution.method,
      resolutionEligible: gate.eligible,
      blockingReasonCodes: gate.blockingReasonCodes,
      exactPendingMatchCount: exposureDiagnosis?.exactMatchCount ?? 0,
      capsulePath
    });
    if (resolved.length > 0) {
      const outcomeKind = boundaryEvent.matchedSuggestedAction ? "directive-win" : "win";
      log.summary("verification.routing-policy-resolved", {
        verificationId,
        boundary: boundaryEvent.boundary,
        storyId: storyResolution.storyId,
        route: inferredRoute,
        resolvedCount: resolved.length,
        outcomeKind,
        skills: resolved.map((e) => e.skill)
      });
    }
    const redactedTarget = toolName === "Bash" ? redactCommand(summary).slice(0, 200) : summary.slice(0, 200);
    const decisionId = createDecisionId({
      hook: "PostToolUse",
      sessionId,
      toolName,
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp
    });
    appendRoutingDecisionTrace({
      version: 2,
      decisionId,
      sessionId,
      hook: "PostToolUse",
      toolName,
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp,
      primaryStory: {
        id: storyResolution.storyId,
        kind: activeStory?.kind ?? null,
        storyRoute: activeStory?.route ?? inferredRoute,
        targetBoundary: boundaryEvent.boundary === "unknown" ? null : boundaryEvent.boundary
      },
      observedRoute: inferredRoute,
      policyScenario: storyResolution.storyId ? `PostToolUse|${activeStory?.kind ?? "none"}|${boundaryEvent.boundary}|${toolName}` : null,
      matchedSkills: [],
      injectedSkills: [],
      skippedReasons: [
        ...storyResolution.storyId ? [] : ["no_active_verification_story"],
        ...gate.blockingReasonCodes.map((code) => `gate:${code}`),
        ...gate.eligible && resolved.length === 0 ? (exposureDiagnosis?.unresolvedReasonCodes ?? ["no_exact_pending_match"]).map(
          (code) => `resolution:${code}`
        ) : []
      ],
      ranked: [],
      verification: {
        verificationId,
        observedBoundary: boundaryEvent.boundary,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction
      },
      causes: [],
      edges: []
    });
    log.summary("routing.decision_trace_written", {
      decisionId,
      hook: "PostToolUse",
      verificationId,
      boundary: boundaryEvent.boundary,
      toolName,
      signalStrength
    });
  }
  log.complete("verification-observe-done", {
    matchedCount: 1,
    injectedCount: 0
  });
  return "{}";
}
function isMainModule() {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try {
    const output = run();
    process.stdout.write(output);
  } catch (err) {
    const entry = [
      `[${(/* @__PURE__ */ new Date()).toISOString()}] CRASH in posttooluse-verification-observe.mts`,
      `  error: ${err?.message || String(err)}`,
      `  stack: ${err?.stack || "(no stack)"}`,
      ""
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
export {
  buildBoundaryEvent,
  buildLedgerObservation,
  classifyBoundary,
  classifyToolSignal,
  classifyVerificationSignal,
  envString,
  inferRoute,
  isLocalVerificationUrl,
  isVerificationReport,
  parseInput,
  redactCommand,
  resolveObservedRoute,
  resolveObservedStory,
  resolveObservedStoryId,
  run,
  shouldResolveRoutingOutcome
};
