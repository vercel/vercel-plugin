#!/usr/bin/env node
/**
 * PostToolUse hook: verification observer for tool calls.
 *
 * Maps tool calls to verification boundaries (uiRender, clientRequest,
 * serverHandler, environment) and emits structured log events for the
 * verification pipeline.
 *
 * Supports Bash, Read, Edit, Write, Glob, Grep, and WebFetch tools.
 * Non-Bash tools produce "soft" evidence that records observations but
 * does not resolve long-term routing policy outcomes. Only "strong" signals
 * (Bash HTTP/browser commands, WebFetch) resolve routing policy.
 *
 * Story inference derives the target route from recent file edits stored
 * in VERCEL_PLUGIN_RECENT_EDITS env var (set by PreToolUse), falling back
 * to extracting route hints from the command itself.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id, cwd
 * Output: JSON on stdout — {} (observer only emits log events, no additionalContext)
 */

import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateVerificationId } from "./hook-env.mjs";
import { createLogger } from "./logger.mjs";
import type { Logger } from "./logger.mjs";
import { redactCommand } from "./pretooluse-skill-inject.mjs";
import {
  recordObservation,
  type VerificationObservation,
} from "./verification-ledger.mjs";
import { resolveBoundaryOutcome } from "./routing-policy-ledger.mjs";
import { selectActiveStory } from "./verification-plan.mjs";
import {
  appendRoutingDecisionTrace,
  createDecisionId,
} from "./routing-decision-trace.mjs";
import {
  classifyVerificationSignal,
} from "./verification-signal.mjs";

export { redactCommand };
export { classifyVerificationSignal };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoundaryType =
  | "uiRender"
  | "clientRequest"
  | "serverHandler"
  | "environment"
  | "unknown";

export type VerificationSignalStrength = "strong" | "soft";

export type VerificationEvidenceSource =
  | "bash"
  | "browser"
  | "http"
  | "log-read"
  | "env-read"
  | "file-read"
  | "unknown";

export interface VerificationBoundaryEvent {
  event: "verification.boundary_observed";
  boundary: BoundaryType;
  verificationId: string;
  command: string;
  matchedPattern: string;
  inferredRoute: string | null;
  timestamp: string;
  suggestedBoundary: string | null;
  suggestedAction: string | null;
  matchedSuggestedAction: boolean;
  signalStrength: VerificationSignalStrength;
  evidenceSource: VerificationEvidenceSource;
  toolName: string;
}

export interface VerificationReport {
  type: "verification.report/v1";
  verificationId: string;
  boundaries: VerificationBoundaryEvent[];
  inferredRoute: string | null;
  storyContext: string | null;
  firstBrokenBoundary: BoundaryType | null;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isVerificationReport(value: unknown): value is VerificationReport {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "verification.report/v1" &&
    typeof obj.verificationId === "string" &&
    Array.isArray(obj.boundaries) &&
    obj.boundaries.every(
      (b: unknown) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).event === "verification.boundary_observed",
    )
  );
}

// ---------------------------------------------------------------------------
// Signal strength gating
// ---------------------------------------------------------------------------

/**
 * Determine whether a verification event should resolve long-term routing
 * policy outcomes. Only strong signals on known boundaries qualify.
 */
export function shouldResolveRoutingOutcome(
  event: Pick<VerificationBoundaryEvent, "boundary" | "signalStrength">,
): boolean {
  return event.boundary !== "unknown" && event.signalStrength === "strong";
}

// ---------------------------------------------------------------------------
// Boundary pattern mapping (Bash)
// ---------------------------------------------------------------------------

interface BoundaryPattern {
  boundary: BoundaryType;
  pattern: RegExp;
  label: string;
}

const BOUNDARY_PATTERNS: BoundaryPattern[] = [
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
  { boundary: "environment", pattern: /\bnode\s+-e\b.*process\.env\b/i, label: "node-env" },
];

/**
 * Classify a bash command into a verification boundary type.
 */
export function classifyBoundary(command: string): { boundary: BoundaryType; matchedPattern: string } {
  for (const bp of BOUNDARY_PATTERNS) {
    if (bp.pattern.test(command)) {
      return { boundary: bp.boundary, matchedPattern: bp.label };
    }
  }
  return { boundary: "unknown", matchedPattern: "none" };
}

// ---------------------------------------------------------------------------
// Non-Bash tool classification
// ---------------------------------------------------------------------------

/**
 * Classify a non-Bash tool call into a verification boundary and evidence metadata.
 */
export function classifyToolSignal(toolName: string, toolInput: Record<string, unknown>): {
  boundary: BoundaryType;
  matchedPattern: string;
  signalStrength: VerificationSignalStrength;
  evidenceSource: VerificationEvidenceSource;
  summary: string;
} | null {
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "");
    if (!filePath) return null;

    // .env files → environment + soft
    if (/\.env(\.\w+)?$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "env-file-read",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath,
      };
    }

    // vercel.json, .vercel/project.json → environment + soft
    if (/vercel\.json$/.test(filePath) || /\.vercel\/project\.json$/.test(filePath)) {
      return {
        boundary: "environment",
        matchedPattern: "vercel-config-read",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: filePath,
      };
    }

    // Log files → serverHandler + soft
    if (/\.(log|out|err)$/.test(filePath) || /vercel-logs/.test(filePath) || /\.next\/.*server.*\.log/.test(filePath)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-file-read",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: filePath,
      };
    }

    // Generic file read — not useful for verification
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
      summary: url.slice(0, 200),
    };
  }

  if (toolName === "Grep") {
    const path = String(toolInput.path || "");

    // Grep in log files → serverHandler + soft
    if (/\.(log|out|err)$/.test(path) || /logs?\//.test(path)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-grep",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200),
      };
    }

    // Grep in .env files → environment + soft
    if (/\.env/.test(path)) {
      return {
        boundary: "environment",
        matchedPattern: "env-grep",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `grep ${toolInput.pattern || ""} in ${path}`.slice(0, 200),
      };
    }

    return null;
  }

  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");

    // Glob for log files → serverHandler + soft
    if (/\*\.(log|out|err)/.test(pattern) || /logs?\//.test(pattern)) {
      return {
        boundary: "serverHandler",
        matchedPattern: "log-glob",
        signalStrength: "soft",
        evidenceSource: "log-read",
        summary: `glob ${pattern}`.slice(0, 200),
      };
    }

    // Glob for env files → environment + soft
    if (/\.env/.test(pattern)) {
      return {
        boundary: "environment",
        matchedPattern: "env-glob",
        signalStrength: "soft",
        evidenceSource: "env-read",
        summary: `glob ${pattern}`.slice(0, 200),
      };
    }

    return null;
  }

  // Edit and Write on route files could infer route but aren't verification evidence
  // They don't observe system behavior, they modify it
  if (toolName === "Edit" || toolName === "Write") {
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Boundary event builder (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Build a structured boundary event with redacted commands and directive matching.
 * Compares the observed boundary/action against the suggested directive from env vars.
 */
export function buildBoundaryEvent(input: {
  command: string;
  boundary: BoundaryType;
  matchedPattern: string;
  inferredRoute: string | null;
  verificationId: string;
  timestamp?: string;
  env?: NodeJS.ProcessEnv;
  signalStrength?: VerificationSignalStrength;
  evidenceSource?: VerificationEvidenceSource;
  toolName?: string;
}): VerificationBoundaryEvent {
  const env = input.env ?? process.env;
  const redactedCommand = redactCommand(input.command).slice(0, 200);
  const suggestedBoundary = env.VERCEL_PLUGIN_VERIFICATION_BOUNDARY || null;
  const suggestedAction = env.VERCEL_PLUGIN_VERIFICATION_ACTION
    ? redactCommand(env.VERCEL_PLUGIN_VERIFICATION_ACTION).slice(0, 200)
    : null;

  return {
    event: "verification.boundary_observed",
    boundary: input.boundary,
    verificationId: input.verificationId,
    command: redactedCommand,
    matchedPattern: input.matchedPattern,
    inferredRoute: input.inferredRoute,
    timestamp: input.timestamp ?? new Date().toISOString(),
    suggestedBoundary,
    suggestedAction,
    matchedSuggestedAction:
      (suggestedBoundary !== null && suggestedBoundary === input.boundary) ||
      (suggestedAction !== null && suggestedAction === redactedCommand),
    signalStrength: input.signalStrength ?? "strong",
    evidenceSource: input.evidenceSource ?? "bash",
    toolName: input.toolName ?? "Bash",
  };
}

// ---------------------------------------------------------------------------
// Ledger observation builder (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Convert a boundary event into a VerificationObservation for ledger persistence.
 */
export function buildLedgerObservation(
  event: VerificationBoundaryEvent,
  env: NodeJS.ProcessEnv = process.env,
): VerificationObservation {
  const storyIdValue = env.VERCEL_PLUGIN_VERIFICATION_STORY_ID;

  // Map evidenceSource to ledger source type
  const sourceMap: Record<VerificationEvidenceSource, VerificationObservation["source"]> = {
    "bash": "bash",
    "browser": "bash",
    "http": "bash",
    "log-read": "edit",
    "env-read": "edit",
    "file-read": "edit",
    "unknown": "bash",
  };

  return {
    id: event.verificationId,
    timestamp: event.timestamp,
    source: sourceMap[event.evidenceSource] ?? "bash",
    boundary: event.boundary === "unknown" ? null : event.boundary,
    route: event.inferredRoute,
    storyId: typeof storyIdValue === "string" && storyIdValue.trim() !== ""
      ? storyIdValue.trim()
      : null,
    summary: event.command,
    meta: {
      matchedPattern: event.matchedPattern,
      suggestedBoundary: event.suggestedBoundary,
      suggestedAction: event.suggestedAction,
      matchedSuggestedAction: event.matchedSuggestedAction,
      toolName: event.toolName,
      signalStrength: event.signalStrength,
      evidenceSource: event.evidenceSource,
    },
  };
}

// ---------------------------------------------------------------------------
// Directive env helpers
// ---------------------------------------------------------------------------

/**
 * Read a trimmed non-empty string from the environment, or null.
 */
export function envString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Resolve the observed route: prefer command/edit inference, fall back to
 * VERCEL_PLUGIN_VERIFICATION_ROUTE from the directive env.
 */
export function resolveObservedRoute(
  inferredRoute: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return inferredRoute ?? envString(env, "VERCEL_PLUGIN_VERIFICATION_ROUTE");
}

// ---------------------------------------------------------------------------
// Story inference
// ---------------------------------------------------------------------------

const ROUTE_REGEX = /\b(?:app|pages|src\/pages|src\/app)\/([\w[\].-]+(?:\/[\w[\].-]+)*)/;
const URL_ROUTE_REGEX = /https?:\/\/[^/\s]+(\/([\w-]+(?:\/[\w-]+)*))/;

/**
 * Infer the target route from recent file edits or the command itself.
 *
 * Sources (in priority order):
 * 1. VERCEL_PLUGIN_RECENT_EDITS — comma-delimited recent file paths
 * 2. Route patterns in the command (e.g., curl http://localhost:3000/settings)
 * 3. null if no route can be inferred
 */
export function inferRoute(command: string, recentEdits?: string): string | null {
  // Source 1: recent edits
  if (recentEdits) {
    const paths = recentEdits.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      const match = ROUTE_REGEX.exec(p);
      if (match) {
        const route = "/" + match[1]
          .replace(/\/page\.\w+$/, "")
          .replace(/\/route\.\w+$/, "")
          .replace(/\/layout\.\w+$/, "")
          .replace(/\/loading\.\w+$/, "")
          .replace(/\/error\.\w+$/, "")
          .replace(/\[([^\]]+)\]/g, ":$1");
        return route === "/" ? "/" : route.replace(/\/$/, "");
      }
    }
  }

  // Source 2: URL in command
  const urlMatch = URL_ROUTE_REGEX.exec(command);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route inference for file-path-based tools
// ---------------------------------------------------------------------------

/**
 * Infer route from a file path (used for Read, Edit, Write, Glob, Grep).
 */
function inferRouteFromFilePath(filePath: string): string | null {
  const match = ROUTE_REGEX.exec(filePath);
  if (match) {
    const route = "/" + match[1]
      .replace(/\/page\.\w+$/, "")
      .replace(/\/route\.\w+$/, "")
      .replace(/\/layout\.\w+$/, "")
      .replace(/\/loading\.\w+$/, "")
      .replace(/\/error\.\w+$/, "")
      .replace(/\[([^\]]+)\]/g, ":$1");
    return route === "/" ? "/" : route.replace(/\/$/, "");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export interface ParsedToolInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string | null;
  cwd: string | null;
}

/** @deprecated Use ParsedToolInput instead */
export type ParsedBashInput = {
  command: string;
  sessionId: string | null;
  cwd: string | null;
};

const SUPPORTED_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"]);

export function parseInput(raw: string, logger?: Logger): ParsedToolInput | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const toolName = (input.tool_name as string) || "";
  if (!SUPPORTED_TOOLS.has(toolName)) return null;

  const toolInput = (input.tool_input as Record<string, unknown>) || {};

  // Bash requires a non-empty command
  if (toolName === "Bash") {
    const command = (toolInput.command as string) || "";
    if (!command) return null;
  }

  const sessionId = (input.session_id as string) || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;

  return { toolName, toolInput, sessionId, cwd };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function run(rawInput?: string): string {
  const log: Logger = createLogger();

  let raw: string;
  if (rawInput !== undefined) {
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

  // Unified multi-tool classification via verification-signal module
  const signal = classifyVerificationSignal({ toolName, toolInput, env });
  if (!signal) {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      toolName,
    });
    return "{}";
  }

  if (signal.boundary === "unknown") {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      toolName,
      summary: signal.summary.slice(0, 120),
    });
    return "{}";
  }

  const { boundary, matchedPattern, signalStrength, evidenceSource, summary } = signal;

  const verificationId = generateVerificationId();
  const recentEdits = env.VERCEL_PLUGIN_RECENT_EDITS || "";

  // Infer route: for Bash use command + recent edits, for file tools use file path
  let inferredRoute: string | null;
  if (toolName === "Bash") {
    inferredRoute = resolveObservedRoute(inferRoute(summary, recentEdits), env);
  } else {
    const filePath = String(toolInput.file_path || toolInput.path || toolInput.url || "");
    inferredRoute = resolveObservedRoute(
      inferRouteFromFilePath(filePath) ?? inferRoute(summary, recentEdits),
      env,
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
    toolName,
  });

  log.summary("verification.boundary_observed", boundaryEvent as unknown as Record<string, unknown>);

  if (sessionId) {
    const plan = recordObservation(
      sessionId,
      buildLedgerObservation(boundaryEvent),
      {
        agentBrowserAvailable:
          process.env.VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE !== "0",
        lastAttemptedAction:
          process.env.VERCEL_PLUGIN_VERIFICATION_ACTION || null,
      },
      log,
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
      blockedReasons: [...plan.blockedReasons],
    });

    // Resolve routing policy only for strong signals on known boundaries
    const primaryStory = plan.stories.length > 0
      ? selectActiveStory(plan)
      : null;

    const resolvedStoryId =
      primaryStory?.id ?? envString(env, "VERCEL_PLUGIN_VERIFICATION_STORY_ID") ?? null;

    if (shouldResolveRoutingOutcome(boundaryEvent)) {
      const resolved = resolveBoundaryOutcome({
        sessionId,
        boundary: boundaryEvent.boundary as "uiRender" | "clientRequest" | "serverHandler" | "environment",
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
        storyId: resolvedStoryId,
        route: inferredRoute,
        now: boundaryEvent.timestamp,
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
          skills: resolved.map((e) => e.skill),
        });
      }
    } else {
      log.debug("verification.routing-policy-skipped", {
        verificationId,
        reason: "soft_signal_or_unknown_boundary",
        signalStrength,
        boundary,
        toolName,
      });
    }

    // Emit routing decision trace for this PostToolUse boundary observation
    const redactedTarget = toolName === "Bash"
      ? redactCommand(summary).slice(0, 200)
      : summary.slice(0, 200);
    const decisionId = createDecisionId({
      hook: "PostToolUse",
      sessionId,
      toolName,
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp,
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
        id: resolvedStoryId,
        kind: primaryStory?.kind ?? null,
        storyRoute: primaryStory?.route ?? inferredRoute,
        targetBoundary: boundaryEvent.boundary === "unknown" ? null : boundaryEvent.boundary,
      },
      observedRoute: inferredRoute,
      policyScenario: resolvedStoryId
        ? `PostToolUse|${primaryStory?.kind ?? "none"}|${boundaryEvent.boundary}|${toolName}`
        : null,
      matchedSkills: [],
      injectedSkills: [],
      skippedReasons: resolvedStoryId ? [] : ["no_active_verification_story"],
      ranked: [],
      verification: {
        verificationId,
        observedBoundary: boundaryEvent.boundary,
        matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
      },
    });

    log.summary("routing.decision_trace_written", {
      decisionId,
      hook: "PostToolUse",
      verificationId,
      boundary: boundaryEvent.boundary,
      toolName,
      signalStrength,
    });
  }

  log.complete("verification-observe-done", {
    matchedCount: 1,
    injectedCount: 0,
  });

  return "{}";
}

// ---------------------------------------------------------------------------
// Execute (only when run directly)
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
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
      `[${new Date().toISOString()}] CRASH in posttooluse-verification-observe.mts`,
      `  error: ${(err as Error)?.message || String(err)}`,
      `  stack: ${(err as Error)?.stack || "(no stack)"}`,
      "",
    ].join("\n");
    process.stderr.write(entry);
    process.stdout.write("{}");
  }
}
