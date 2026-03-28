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
function isVerificationReport(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return obj.type === "verification.report/v1" && typeof obj.verificationId === "string" && Array.isArray(obj.boundaries) && obj.boundaries.every(
    (b) => typeof b === "object" && b !== null && b.event === "verification.boundary_observed"
  );
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
    matchedSuggestedAction: suggestedBoundary !== null && suggestedBoundary === input.boundary || suggestedAction !== null && suggestedAction === redactedCommand
  };
}
function buildLedgerObservation(event, env = process.env) {
  const storyIdValue = env.VERCEL_PLUGIN_VERIFICATION_STORY_ID;
  return {
    id: event.verificationId,
    timestamp: event.timestamp,
    source: "bash",
    boundary: event.boundary === "unknown" ? null : event.boundary,
    route: event.inferredRoute,
    storyId: typeof storyIdValue === "string" && storyIdValue.trim() !== "" ? storyIdValue.trim() : null,
    summary: event.command,
    meta: {
      matchedPattern: event.matchedPattern,
      suggestedBoundary: event.suggestedBoundary,
      suggestedAction: event.suggestedAction,
      matchedSuggestedAction: event.matchedSuggestedAction
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
  if (toolName !== "Bash") return null;
  const toolInput = input.tool_input || {};
  const command = toolInput.command || "";
  if (!command) return null;
  const sessionId = input.session_id || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;
  return { command, sessionId, cwd };
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
    log.debug("verification-observe-skip", { reason: "no_bash_input" });
    return "{}";
  }
  const { command, sessionId } = parsed;
  const { boundary, matchedPattern } = classifyBoundary(command);
  if (boundary === "unknown") {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      command: redactCommand(command).slice(0, 120)
    });
    return "{}";
  }
  const env = process.env;
  const verificationId = generateVerificationId();
  const recentEdits = env.VERCEL_PLUGIN_RECENT_EDITS || "";
  const inferredRoute = resolveObservedRoute(inferRoute(command, recentEdits), env);
  const boundaryEvent = buildBoundaryEvent({
    command,
    boundary,
    matchedPattern,
    inferredRoute,
    verificationId
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
      matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
      satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
      missingBoundaries: [...plan.missingBoundaries],
      primaryNextAction: plan.primaryNextAction,
      blockedReasons: [...plan.blockedReasons]
    });
    const primaryStory = plan.stories.length > 0 ? selectActiveStory(plan) : null;
    const resolvedStoryId = primaryStory?.id ?? envString(env, "VERCEL_PLUGIN_VERIFICATION_STORY_ID") ?? null;
    if (boundaryEvent.boundary !== "unknown") {
      const resolved = resolveBoundaryOutcome({
        sessionId,
        boundary: boundaryEvent.boundary,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
        storyId: resolvedStoryId,
        route: inferredRoute,
        now: boundaryEvent.timestamp
      });
      if (resolved.length > 0) {
        const outcomeKind = boundaryEvent.matchedSuggestedAction ? "directive-win" : "win";
        log.summary("verification.routing-policy-resolved", {
          verificationId,
          boundary: boundaryEvent.boundary,
          storyId: resolvedStoryId,
          route: inferredRoute,
          resolvedCount: resolved.length,
          outcomeKind,
          skills: resolved.map((e) => e.skill)
        });
      }
    }
    const redactedTarget = redactCommand(command).slice(0, 200);
    const decisionId = createDecisionId({
      hook: "PostToolUse",
      sessionId,
      toolName: "Bash",
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp
    });
    appendRoutingDecisionTrace({
      version: 2,
      decisionId,
      sessionId,
      hook: "PostToolUse",
      toolName: "Bash",
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp,
      primaryStory: {
        id: resolvedStoryId,
        kind: primaryStory?.kind ?? null,
        storyRoute: primaryStory?.route ?? inferredRoute,
        targetBoundary: boundaryEvent.boundary === "unknown" ? null : boundaryEvent.boundary
      },
      observedRoute: inferredRoute,
      policyScenario: resolvedStoryId ? `PostToolUse|${primaryStory?.kind ?? "none"}|${boundaryEvent.boundary}|Bash` : null,
      matchedSkills: [],
      injectedSkills: [],
      skippedReasons: resolvedStoryId ? [] : ["no_active_verification_story"],
      ranked: [],
      verification: {
        verificationId,
        observedBoundary: boundaryEvent.boundary,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction
      }
    });
    log.summary("routing.decision_trace_written", {
      decisionId,
      hook: "PostToolUse",
      verificationId,
      boundary: boundaryEvent.boundary
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
  envString,
  inferRoute,
  isVerificationReport,
  parseInput,
  redactCommand,
  resolveObservedRoute,
  run
};
