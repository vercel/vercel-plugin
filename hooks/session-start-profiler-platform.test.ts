import { describe, expect, test } from "bun:test";
import { detectSessionStartPlatform } from "./src/session-start-profiler.mts";

describe("session-start-profiler platform detection", () => {
  test("test_session_start_profiler_does_not_infer_cursor_from_cursor_project_dir_alone", () => {
    expect(
      detectSessionStartPlatform(
        { session_id: "sess-123" },
        { CURSOR_PROJECT_DIR: "/tmp/cursor-root" },
      ),
    ).toBe("claude-code");
  });

  test("test_session_start_profiler_prefers_claude_env_file_when_present", () => {
    expect(
      detectSessionStartPlatform(
        {
          conversation_id: "conv-123",
          cursor_version: "1.0.0",
        },
        {
          CLAUDE_ENV_FILE: "/tmp/claude.env",
          CURSOR_PROJECT_DIR: "/tmp/cursor-root",
        },
      ),
    ).toBe("claude-code");
  });

  test("test_session_start_profiler_infers_antigravity_from_agent_env", () => {
    expect(
      detectSessionStartPlatform(
        { session_id: "sess-123" },
        { ANTIGRAVITY_AGENT: "1" },
      ),
    ).toBe("antigravity");
  });
});
