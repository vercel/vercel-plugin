import { describe, expect, test } from "bun:test";
import {
  detectSessionStartSeenSkillsPlatform,
  formatSessionStartSeenSkillsCursorOutput,
} from "./src/session-start-seen-skills.mts";
import {
  buildInjectClaudeMdParts,
  detectInjectClaudeMdPlatform,
  formatInjectClaudeMdOutput,
} from "./src/inject-claude-md.mts";
import {
  buildSessionStartProfilerEnvVars,
  detectSessionStartPlatform,
  formatSessionStartProfilerCursorOutput,
  resolveSessionStartProjectRoot,
} from "./src/session-start-profiler.mts";
import { normalizeSessionEndSessionId } from "./src/session-end-cleanup.mts";

describe("session hook platform compatibility", () => {
  test("test_session_start_seen_skills_returns_cursor_json_when_env_file_is_missing", () => {
    const platform = detectSessionStartSeenSkillsPlatform(
      { conversation_id: "conv-123" },
      {},
    );

    expect(platform).toBe("cursor");
    expect(JSON.parse(formatSessionStartSeenSkillsCursorOutput())).toEqual({
      env: {
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      },
    });
  });

  test("test_session_start_seen_skills_keeps_claude_path_when_env_file_exists", () => {
    const platform = detectSessionStartSeenSkillsPlatform(
      { session_id: "sess-123" },
      { CLAUDE_ENV_FILE: "/tmp/claude-env" },
    );

    expect(platform).toBe("claude-code");
  });

  test("test_session_start_seen_skills_defaults_to_claude_without_cursor_markers", () => {
    const platform = detectSessionStartSeenSkillsPlatform({}, {});

    expect(platform).toBe("claude-code");
  });

  test("test_session_start_profiler_detects_cursor_and_formats_env_and_context_json", () => {
    const platform = detectSessionStartPlatform(
      { conversation_id: "conv-123" },
      {},
    );
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: true,
      greenfield: true,
      likelySkills: ["ai-sdk", "nextjs"],
      setupSignals: {
        bootstrapHints: ["greenfield"],
        resourceHints: ["postgres"],
        setupMode: true,
      },
    });

    expect(platform).toBe("cursor");
    expect(resolveSessionStartProjectRoot({ CURSOR_PROJECT_DIR: "/tmp/cursor-root" })).toBe(
      "/tmp/cursor-root",
    );
    expect(JSON.parse(formatSessionStartProfilerCursorOutput(envVars, ["profile ready"]))).toEqual({
      env: {
        VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE: "1",
        VERCEL_PLUGIN_GREENFIELD: "true",
        VERCEL_PLUGIN_LIKELY_SKILLS: "ai-sdk,nextjs",
        VERCEL_PLUGIN_BOOTSTRAP_HINTS: "greenfield",
        VERCEL_PLUGIN_RESOURCE_HINTS: "postgres",
        VERCEL_PLUGIN_SETUP_MODE: "1",
      },
      additional_context: "profile ready",
    });
  });

  test("test_inject_claude_md_wraps_additional_context_for_cursor", () => {
    const platform = detectInjectClaudeMdPlatform(
      { cursor_version: "1.0.0" },
      {},
    );
    const parts = buildInjectClaudeMdParts("base context", {
      VERCEL_PLUGIN_GREENFIELD: "true",
    });

    expect(platform).toBe("cursor");
    expect(parts).toHaveLength(2);
    expect(JSON.parse(formatInjectClaudeMdOutput(platform, parts.join("\n\n")))).toEqual({
      additional_context: parts.join("\n\n"),
    });
  });

  test("test_inject_claude_md_keeps_plain_text_for_claude", () => {
    const output = formatInjectClaudeMdOutput("claude-code", "plain context");

    expect(output).toBe("plain context");
  });

  test("test_session_end_cleanup_uses_conversation_id_when_session_id_is_missing", () => {
    expect(
      normalizeSessionEndSessionId({
        conversation_id: "conv-456",
      }),
    ).toBe("conv-456");
  });
});
