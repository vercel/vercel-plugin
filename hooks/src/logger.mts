/**
 * Structured log-level system for hook output.
 *
 * Levels (ascending verbosity):
 *   off     — no output (default, preserves existing behavior)
 *   summary — outcome + latency + issues only
 *   debug   — adds match reasons, dedup info, skill map stats
 *   trace   — adds per-pattern evaluation details
 *
 * Env vars (checked in order):
 *   VERCEL_PLUGIN_LOG_LEVEL  — explicit level name
 *   VERCEL_PLUGIN_DEBUG=1    — legacy, maps to "debug"
 *   VERCEL_PLUGIN_HOOK_DEBUG=1 — legacy, maps to "debug"
 */

import { randomBytes } from "node:crypto";

export type LogLevel = "off" | "summary" | "debug" | "trace";

const LEVELS = ["off", "summary", "debug", "trace"] as const;
const LEVEL_INDEX: Record<string, number> = {
  off: 0,
  summary: 1,
  debug: 2,
  trace: 3,
};

const VERCEL_PLUGIN_SHARED_LOGGER_CONTEXT_KEY = "__vercelPluginSharedLoggerContext__" as const;

interface CompleteCounts {
  matchedCount: number;
  injectedCount: number;
  dedupedCount: number;
  cappedCount: number;
  tsxReviewTriggered?: boolean;
  devServerVerifyTriggered?: boolean;
  matchedSkills?: string[];
  injectedSkills?: string[];
  droppedByCap?: string[];
  droppedByBudget?: string[];
  boostsApplied?: string[];
  policyBoosted?: Array<{ skill: string; boost: number; reason: string | null }>;
}

interface SharedLoggerContext {
  invocationId?: string;
}

type LoggerGlobal = typeof globalThis & {
  [VERCEL_PLUGIN_SHARED_LOGGER_CONTEXT_KEY]?: SharedLoggerContext;
};

export interface CreateLoggerOptions {
  level?: LogLevel;
  invocationId?: string;
}

export interface Logger {
  level: string;
  active: boolean;
  t0: number;
  now: () => number;
  elapsed: () => number;
  summary: (event: string, data: Record<string, unknown>) => void;
  issue: (code: string, message: string, hint: string, context: Record<string, unknown>) => void;
  complete: (reason: string, counts?: Partial<CompleteCounts>, timing?: Record<string, number> | null) => void;
  debug: (event: string, data: Record<string, unknown>) => void;
  trace: (event: string, data: Record<string, unknown>) => void;
  isEnabled: (minLevel: string) => boolean;
}

function readErrorField(error: Record<string, unknown>, field: string): unknown {
  return field in error ? error[field] : undefined;
}

export function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const maybeCode =
      "code" in error && typeof (error as Error & { code?: unknown }).code !== "undefined"
        ? { code: (error as Error & { code?: unknown }).code }
        : {};
    return {
      name: error.name,
      message: error.message,
      ...maybeCode,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      type: error.constructor?.name || "Object",
      ...(readErrorField(record, "name") !== undefined ? { name: readErrorField(record, "name") } : {}),
      ...(readErrorField(record, "message") !== undefined ? { message: readErrorField(record, "message") } : {}),
      ...(readErrorField(record, "code") !== undefined ? { code: readErrorField(record, "code") } : {}),
      ...(readErrorField(record, "stack") !== undefined ? { stack: readErrorField(record, "stack") } : {}),
    };
  }

  return { value: error };
}

export function logCaughtError(
  logger: Logger,
  event: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  logger.debug(event, { ...context, error: serializeErrorForLog(error) });
}

/**
 * Resolve the active log level from environment variables.
 */
export function resolveLogLevel(): LogLevel {
  const explicit = (process.env.VERCEL_PLUGIN_LOG_LEVEL || "").toLowerCase().trim();
  if (explicit && LEVEL_INDEX[explicit] !== undefined) {
    return explicit as LogLevel;
  }
  if (explicit) {
    console.error(
      `[vercel-plugin] Unknown VERCEL_PLUGIN_LOG_LEVEL="${explicit}". Valid levels: ${LEVELS.join(", ")}. Falling back to "off".`
    );
  }
  // Legacy boolean flags → debug
  if (
    process.env.VERCEL_PLUGIN_DEBUG === "1" ||
    process.env.VERCEL_PLUGIN_HOOK_DEBUG === "1"
  ) {
    return "debug";
  }
  return "off";
}

function getSharedLoggerContext(): SharedLoggerContext {
  const loggerGlobal = globalThis as LoggerGlobal;
  if (!loggerGlobal[VERCEL_PLUGIN_SHARED_LOGGER_CONTEXT_KEY]) {
    loggerGlobal[VERCEL_PLUGIN_SHARED_LOGGER_CONTEXT_KEY] = {};
  }
  return loggerGlobal[VERCEL_PLUGIN_SHARED_LOGGER_CONTEXT_KEY]!;
}

function resolveInvocationId(active: boolean, explicitInvocationId?: string): string {
  if (!active) return "";
  if (explicitInvocationId) return explicitInvocationId;

  const sharedContext = getSharedLoggerContext();
  if (!sharedContext.invocationId) {
    sharedContext.invocationId = randomBytes(4).toString("hex");
  }
  return sharedContext.invocationId;
}

/**
 * Create a logger instance bound to the current process invocation.
 * All hook modules in the same process reuse one invocationId by default.
 */
export function createLogger(opts?: CreateLoggerOptions | LogLevel): Logger {
  const options = typeof opts === "string" ? { level: opts } : (opts || {});
  const level = options.level || resolveLogLevel();
  const rank = LEVEL_INDEX[level] || 0;
  const active = rank > 0;
  const invocationId = resolveInvocationId(active, options.invocationId);

  const safeNow =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  const t0 = active ? safeNow() : 0;

  function emit(minLevel: string, event: string, data: Record<string, unknown>): void {
    if (rank < (LEVEL_INDEX[minLevel] || 0)) return;
    const line = JSON.stringify({
      invocationId,
      event,
      timestamp: new Date().toISOString(),
      ...data,
    });
    process.stderr.write(line + "\n");
  }

  return {
    level,
    active,
    t0,
    now: safeNow,
    elapsed() {
      return Math.round(safeNow() - t0);
    },

    summary(event, data) {
      emit("summary", event, data);
    },

    issue(code, message, hint, context) {
      emit("summary", "issue", { code, message, hint, context });
    },

    complete(reason, counts, timing) {
      const {
        matchedCount = 0,
        injectedCount = 0,
        dedupedCount = 0,
        cappedCount = 0,
        tsxReviewTriggered,
        devServerVerifyTriggered,
        matchedSkills,
        injectedSkills,
        droppedByCap,
        droppedByBudget,
        boostsApplied,
      } = counts || {};
      emit("summary", "complete", {
        reason,
        matchedCount,
        injectedCount,
        dedupedCount,
        cappedCount,
        ...(tsxReviewTriggered !== undefined ? { tsxReviewTriggered } : {}),
        ...(devServerVerifyTriggered !== undefined ? { devServerVerifyTriggered } : {}),
        ...(matchedSkills ? { matchedSkills } : {}),
        ...(injectedSkills ? { injectedSkills } : {}),
        ...(droppedByCap && droppedByCap.length > 0 ? { droppedByCap } : {}),
        ...(droppedByBudget && droppedByBudget.length > 0 ? { droppedByBudget } : {}),
        ...(boostsApplied && boostsApplied.length > 0 ? { boostsApplied } : {}),
        elapsed_ms: Math.round(safeNow() - t0),
        ...(timing ? { timing_ms: timing } : {}),
      });
    },

    debug(event, data) {
      emit("debug", event, data);
    },

    trace(event, data) {
      emit("trace", event, data);
    },

    isEnabled(minLevel) {
      return rank >= (LEVEL_INDEX[minLevel] || 0);
    },
  };
}

/**
 * Structured decision log entry for skill routing traces.
 * Emits at debug level with consistent fields across all hooks.
 */
export interface DecisionFields {
  hook: string;
  event: string;
  skill?: string;
  score?: number;
  reason?: string;
  durationMs?: number;
  [key: string]: unknown;
}

/**
 * Emit a structured decision event at debug level.
 * Provides a consistent shape for skill routing decisions across hooks.
 */
export function logDecision(logger: Logger, fields: DecisionFields): void {
  logger.debug(`decision:${fields.event}`, fields as unknown as Record<string, unknown>);
}

export { LEVELS, LEVEL_INDEX };
