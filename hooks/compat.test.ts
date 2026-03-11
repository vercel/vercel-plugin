import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectPlatform,
  formatOutput,
  getEnvFilePath,
  getProjectRoot,
  normalizeInput,
  setSessionEnv,
} from "./src/compat.mts"

const originalClaudeEnvFile = process.env.CLAUDE_ENV_FILE
const originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR
const originalClaudeProjectRoot = process.env.CLAUDE_PROJECT_ROOT
const originalCursorProjectDir = process.env.CURSOR_PROJECT_DIR

const tempDirs: string[] = []

function restoreEnv(key: "CLAUDE_ENV_FILE" | "CLAUDE_PROJECT_DIR" | "CLAUDE_PROJECT_ROOT" | "CURSOR_PROJECT_DIR", value: string | undefined): void {
  if (typeof value === "string") {
    process.env[key] = value
    return
  }

  delete process.env[key]
}

afterEach(() => {
  restoreEnv("CLAUDE_ENV_FILE", originalClaudeEnvFile)
  restoreEnv("CLAUDE_PROJECT_DIR", originalClaudeProjectDir)
  restoreEnv("CLAUDE_PROJECT_ROOT", originalClaudeProjectRoot)
  restoreEnv("CURSOR_PROJECT_DIR", originalCursorProjectDir)
  normalizeInput({})
  formatOutput("cursor", {})

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe("compat", () => {
  it("test_detectPlatform_returns_cursor_when_cursor_fields_are_present", () => {
    expect(detectPlatform({ conversation_id: "cursor-conversation" })).toBe("cursor")
    expect(detectPlatform({ workspace_roots: ["/tmp/project"] })).toBe("cursor")
    expect(detectPlatform({ cursor_version: "1.0.0" })).toBe("cursor")
    expect(detectPlatform({ session_id: "claude-session" })).toBe("claude-code")
  })

  it("test_normalizeInput_maps_cursor_and_claude_payloads_with_platform_fallbacks", () => {
    process.env.CURSOR_PROJECT_DIR = "/tmp/cursor-project"
    process.env.CLAUDE_PROJECT_DIR = "/tmp/claude-project"

    const cursorInput = normalizeInput({
      conversation_id: "cursor-conversation",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "app/page.tsx" },
      tool_output: "{\"ok\":true}",
    })

    expect(cursorInput).toEqual({
      platform: "cursor",
      sessionId: "cursor-conversation",
      cwd: "/tmp/cursor-project",
      hookEvent: "PostToolUse",
      toolName: "Edit",
      toolInput: { file_path: "app/page.tsx" },
      toolOutput: "{\"ok\":true}",
      prompt: undefined,
      raw: {
        conversation_id: "cursor-conversation",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "app/page.tsx" },
        tool_output: "{\"ok\":true}",
      },
    })

    const claudeInput = normalizeInput({
      session_id: "claude-session",
      hook_event_name: "PostToolUse",
      tool_response: { status: "done" },
      prompt: "Summarize the diff",
    })

    expect(claudeInput.platform).toBe("claude-code")
    expect(claudeInput.sessionId).toBe("claude-session")
    expect(claudeInput.cwd).toBe("/tmp/cursor-project")
    expect(claudeInput.toolOutput).toBe("{\"status\":\"done\"}")
    expect(claudeInput.prompt).toBe("Summarize the diff")
  })

  it("test_formatOutput_emits_claude_shape_and_appends_env_exports_when_requested", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "compat-claude-"))
    const envFile = join(tempDir, "claude.env")
    tempDirs.push(tempDir)
    writeFileSync(envFile, "", "utf-8")

    process.env.CLAUDE_ENV_FILE = envFile
    process.env.CLAUDE_PROJECT_ROOT = "/tmp/claude-root"

    normalizeInput({
      session_id: "claude-session",
      hook_event_name: "PreToolUse",
    })

    setSessionEnv("claude-code", "VERCEL_PLUGIN_TEST", '$value"quoted`')

    expect(getEnvFilePath()).toBe(envFile)
    expect(getProjectRoot()).toBe("/tmp/claude-root")

    const content = readFileSync(envFile, "utf-8")
    expect(content).toContain('export VERCEL_PLUGIN_TEST="\\$value\\"quoted\\`"\n')
    expect(formatOutput("claude-code", {})).toEqual({})

    expect(
      formatOutput("claude-code", {
        additionalContext: "Use the repo root",
        permission: "deny",
        userMessage: "ignored by Claude",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "Use the repo root",
        permissionDecision: "deny",
      },
    })
  })

  it("test_formatOutput_emits_cursor_shape_and_drains_session_env_cache", () => {
    process.env.CURSOR_PROJECT_DIR = "/tmp/cursor-root"

    normalizeInput({
      conversation_id: "cursor-conversation",
      hook_event_name: "PostToolUse",
    })

    setSessionEnv("cursor", "CURSOR_ONLY", "1")
    expect(getProjectRoot()).toBe("/tmp/cursor-root")

    expect(
      formatOutput("cursor", {
        additionalContext: "Run targeted tests",
        permission: "allow",
        env: { INLINE_ENV: "2" },
        userMessage: "Proceed",
      }),
    ).toEqual({
      additional_context: "Run targeted tests",
      permission: "allow",
      env: {
        CURSOR_ONLY: "1",
        INLINE_ENV: "2",
      },
      user_message: "Proceed",
    })

    expect(formatOutput("cursor", {})).toEqual({})
  })
})
