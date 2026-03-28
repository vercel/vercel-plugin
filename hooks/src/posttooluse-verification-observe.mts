#!/usr/bin/env node
/**
 * PostToolUse hook: verification observer for Bash tool calls.
 *
 * Maps bash commands to verification boundaries (uiRender, clientRequest,
 * serverHandler, environment) and emits structured log events for the
 * verification pipeline.
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
import { pluginRoot as resolvePluginRoot, generateVerificationId } from "./hook-env.mjs";
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

export { redactCommand };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoundaryType =
  | "uiRender"
  | "clientRequest"
  | "serverHandler"
  | "environment"
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
// Boundary pattern mapping
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
  return {
    id: event.verificationId,
    timestamp: event.timestamp,
    source: "bash",
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
// Input parsing
// ---------------------------------------------------------------------------

export interface ParsedBashInput {
  command: string;
  sessionId: string | null;
  cwd: string | null;
}

export function parseInput(raw: string, logger?: Logger): ParsedBashInput | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const toolName = (input.tool_name as string) || "";
  if (toolName !== "Bash") return null;

  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const command = (toolInput.command as string) || "";
  if (!command) return null;

  const sessionId = (input.session_id as string) || null;
  const cwdCandidate = input.cwd ?? input.working_directory;
  const cwd = typeof cwdCandidate === "string" && cwdCandidate.trim() !== "" ? cwdCandidate : null;

  return { command, sessionId, cwd };
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
    log.debug("verification-observe-skip", { reason: "no_bash_input" });
    return "{}";
  }

  const { command, sessionId } = parsed;
  const { boundary, matchedPattern } = classifyBoundary(command);

  if (boundary === "unknown") {
    log.trace("verification-observe-skip", {
      reason: "no_boundary_match",
      command: redactCommand(command).slice(0, 120),
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
    verificationId,
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
      matchedSuggestedAction: boundaryEvent.matchedSuggestedAction,
      satisfiedBoundaries: Array.from(plan.satisfiedBoundaries).sort(),
      missingBoundaries: [...plan.missingBoundaries],
      primaryNextAction: plan.primaryNextAction,
      blockedReasons: [...plan.blockedReasons],
    });

    // Resolve routing policy exposures for this boundary, scoped to story + route.
    // Fall back to directive env for story and route when plan inference is unavailable.
    const primaryStory = plan.stories.length > 0
      ? selectActiveStory(plan)
      : null;

    const resolvedStoryId =
      primaryStory?.id ?? envString(env, "VERCEL_PLUGIN_VERIFICATION_STORY_ID") ?? null;

    if (boundaryEvent.boundary !== "unknown") {
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
    }

    // Emit routing decision trace for this PostToolUse boundary observation
    const redactedTarget = redactCommand(command).slice(0, 200);
    const decisionId = createDecisionId({
      hook: "PostToolUse",
      sessionId,
      toolName: "Bash",
      toolTarget: redactedTarget,
      timestamp: boundaryEvent.timestamp,
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
        targetBoundary: boundaryEvent.boundary === "unknown" ? null : boundaryEvent.boundary,
      },
      observedRoute: inferredRoute,
      policyScenario: resolvedStoryId
        ? `PostToolUse|${primaryStory?.kind ?? "none"}|${boundaryEvent.boundary}|Bash`
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
