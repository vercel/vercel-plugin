/**
 * Compatibility helpers for normalizing Claude Code and Cursor hook payloads.
 *
 * The hook implementations can consume one normalized input shape and emit
 * platform-specific output without duplicating translation logic.
 */

import { appendFileSync } from "node:fs"

/**
 * Supported hook payload/output platforms.
 */
export type HookPlatform = "claude-code" | "cursor"

/**
 * Shared hook input shape used by the compatibility layer.
 */
export interface NormalizedInput {
  platform: HookPlatform
  sessionId: string
  cwd: string
  hookEvent: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  prompt?: string
  raw: Record<string, unknown>
}

/**
 * Internal hook result before platform-specific formatting.
 */
export interface InternalOutput {
  additionalContext?: string
  permission?: "allow" | "deny"
  env?: Record<string, string>
  userMessage?: string
}

const cursorSessionEnv = new Map<string, string>()

let currentHookEventName: string | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readWorkspaceRoot(raw: Record<string, unknown>): string | undefined {
  if (!Array.isArray(raw.workspace_roots)) return undefined
  const firstRoot = raw.workspace_roots[0]
  return typeof firstRoot === "string" ? firstRoot : undefined
}

function normalizeToolOutputValue(value: unknown): string | undefined {
  if (typeof value === "undefined") return undefined
  if (typeof value === "string") return value

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function escapeShellEnvValue(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1")
}

function drainCursorSessionEnv(): Record<string, string> | undefined {
  if (cursorSessionEnv.size === 0) return undefined

  const env = Object.fromEntries(cursorSessionEnv)
  cursorSessionEnv.clear()
  return env
}

/**
 * Detect the source platform from the parsed stdin payload.
 */
export function detectPlatform(raw: Record<string, unknown>): HookPlatform {
  if (
    "conversation_id" in raw ||
    "workspace_roots" in raw ||
    "cursor_version" in raw
  ) {
    return "cursor"
  }

  return "claude-code"
}

/**
 * Normalize a raw hook payload into one shared internal shape.
 */
export function normalizeInput(raw: Record<string, unknown>): NormalizedInput {
  const platform = detectPlatform(raw)
  const sessionId = readString(raw.session_id ?? raw.conversation_id) ?? ""
  const cwd =
    readString(raw.cwd) ??
    readWorkspaceRoot(raw) ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd()
  const hookEvent = readString(raw.hook_event_name) ?? ""
  const toolOutput = normalizeToolOutputValue(raw.tool_output ?? raw.tool_response)

  currentHookEventName = hookEvent || undefined

  return {
    platform,
    sessionId,
    cwd,
    hookEvent,
    toolName: readString(raw.tool_name),
    toolInput: readRecord(raw.tool_input),
    toolOutput,
    prompt: readString(raw.prompt),
    raw,
  }
}

/**
 * Format an internal hook result for the requested platform.
 */
export function formatOutput(platform: string, internal: InternalOutput): Record<string, unknown> {
  if (platform === "cursor") {
    const env = {
      ...(drainCursorSessionEnv() ?? {}),
      ...(internal.env ?? {}),
    }
    const output: Record<string, unknown> = {}

    if (typeof internal.additionalContext !== "undefined") {
      output.additional_context = internal.additionalContext
    }
    if (typeof internal.permission !== "undefined") {
      output.permission = internal.permission
    }
    if (Object.keys(env).length > 0) {
      output.env = env
    }
    if (typeof internal.userMessage !== "undefined") {
      output.user_message = internal.userMessage
    }

    return output
  }

  const hookSpecificOutput: Record<string, unknown> = {}

  if (typeof internal.additionalContext !== "undefined") {
    if (currentHookEventName) {
      hookSpecificOutput.hookEventName = currentHookEventName
    }
    hookSpecificOutput.additionalContext = internal.additionalContext
  }

  if (typeof internal.permission !== "undefined") {
    if (currentHookEventName) {
      hookSpecificOutput.hookEventName = currentHookEventName
    }
    hookSpecificOutput.permissionDecision = internal.permission
  }

  if (Object.keys(hookSpecificOutput).length === 0) {
    return {}
  }

  return { hookSpecificOutput }
}

/**
 * Return the active Claude env-file path when available.
 */
export function getEnvFilePath(): string | null {
  return process.env.CLAUDE_ENV_FILE || null
}

/**
 * Persist a session env var for the active platform.
 */
export function setSessionEnv(platform: string, key: string, value: string): void {
  if (platform === "cursor") {
    cursorSessionEnv.set(key, value)
    return
  }

  const envFile = getEnvFilePath()
  if (!envFile) return

  appendFileSync(envFile, `export ${key}="${escapeShellEnvValue(value)}"\n`)
}

/**
 * Resolve the best available project root across both platforms.
 */
export function getProjectRoot(): string {
  return process.env.CLAUDE_PROJECT_ROOT ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd()
}
