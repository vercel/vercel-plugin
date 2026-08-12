import { describe, expect, test } from "bun:test";
import {
  detectAgentHarness,
  detectSessionStartPlatform,
  normalizeDetectedAgentHarness,
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

  test("normalizes supported detect-agent names", () => {
    expect(normalizeDetectedAgentHarness("cursor")).toBe("cursor");
    expect(normalizeDetectedAgentHarness("cursor-cli")).toBe("cursor");
    expect(normalizeDetectedAgentHarness("github-copilot")).toBe("github-copilot");
    expect(normalizeDetectedAgentHarness("kimi")).toBe("kimi");
    expect(normalizeDetectedAgentHarness("grok")).toBe("grok");
    expect(normalizeDetectedAgentHarness("codex_cli")).toBe("codex");
    expect(normalizeDetectedAgentHarness("claude_code")).toBe("claude-code");
  });

  test("never forwards unsupported or custom agent names", () => {
    expect(normalizeDetectedAgentHarness(undefined)).toBe("unknown");
    expect(normalizeDetectedAgentHarness("custom-agent@1")).toBe("unknown");
    expect(normalizeDetectedAgentHarness("devin")).toBe("unknown");
  });

  test("uses Cursor hook fields before detect-agent", async () => {
    let detectorCalled = false;
    const harness = await detectAgentHarness(
      { cursor_version: "1.0.0" },
      async () => {
        detectorCalled = true;
        return { isAgent: true, agent: { name: "claude_code" } };
      },
    );

    expect(harness).toBe("cursor");
    expect(detectorCalled).toBe(false);
  });

  test("uses detect-agent for non-Cursor hooks", async () => {
    expect(
      await detectAgentHarness({}, async () => ({
        isAgent: true,
        agent: { name: "grok" },
      })),
    ).toBe("grok");
  });
});
