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
    expect(normalizeDetectedAgentHarness("cowork")).toBe("claude-code");
  });

  test("distinguishes no detection from detected but unapproved agents", () => {
    expect(normalizeDetectedAgentHarness(undefined)).toBe("unknown");
    for (const name of [
      "gemini_cli",
      "cline",
      "antigravity",
      "augment-cli",
      "open_code",
      "goose",
      "junie",
      "pi",
      "replit",
      "kiro",
      "openclaw",
      "devin",
      "custom-agent@1",
    ]) {
      expect(normalizeDetectedAgentHarness(name)).toBe("other");
    }
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

  test("returns unknown only when detect-agent finds no agent", async () => {
    expect(
      await detectAgentHarness({}, async () => ({ isAgent: false })),
    ).toBe("unknown");
    expect(
      await detectAgentHarness({}, async () => ({
        isAgent: true,
        agent: { name: "devin" },
      })),
    ).toBe("other");
  });

  test("falls back to unknown when detect-agent rejects", async () => {
    expect(
      await detectAgentHarness({}, async () => {
        throw new Error("detector failed");
      }),
    ).toBe("unknown");
  });
});
