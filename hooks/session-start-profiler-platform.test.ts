import { describe, expect, test } from "bun:test";
import {
  detectAgentHarness,
  detectSessionStartPlatform,
} from "./src/session-start-profiler.mts";

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

  test("detects supported agent harnesses from explicit signals", () => {
    expect(detectAgentHarness({ cursor_version: "1.0.0" }, {})).toBe("cursor");
    expect(detectAgentHarness({}, { COPILOT_PLUGIN_DATA: "/tmp/copilot-data" })).toBe(
      "github-copilot",
    );
    expect(
      detectAgentHarness({}, {
        PLUGIN_DATA: "/tmp/codex-data",
        CLAUDE_PLUGIN_DATA: "/tmp/compat-data",
      }),
    ).toBe("codex");
    expect(detectAgentHarness({}, { CLAUDE_ENV_FILE: "/tmp/claude.env" })).toBe(
      "claude-code",
    );
  });

  test("returns unknown instead of guessing from ambiguous environment state", () => {
    expect(detectAgentHarness({}, {})).toBe("unknown");
    expect(detectAgentHarness({}, { CODEX_HOME: "/tmp/codex" })).toBe("unknown");
    expect(detectAgentHarness({}, { CLAUDE_PLUGIN_ROOT: "/tmp/plugin" })).toBe("unknown");
  });
});
