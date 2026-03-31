import { describe, expect, test } from "bun:test";
import {
  buildSessionStartProfilerEnvVars,
  detectSessionStartPlatform,
  formatSessionStartProfilerCursorOutput,
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
});

describe("session-start-profiler env export contract", () => {
  test("buildSessionStartProfilerEnvVars includes LIKELY_SKILLS when present", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs", "ai-sdk"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars.VERCEL_PLUGIN_LIKELY_SKILLS).toBe("nextjs,ai-sdk");
  });

  test("buildSessionStartProfilerEnvVars omits LIKELY_SKILLS when empty", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: [],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars).not.toHaveProperty("VERCEL_PLUGIN_LIKELY_SKILLS");
  });

  test("buildSessionStartProfilerEnvVars includes INSTALLED_SKILLS when present", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs", "shadcn"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars.VERCEL_PLUGIN_INSTALLED_SKILLS).toBe("nextjs,shadcn");
  });

  test("buildSessionStartProfilerEnvVars omits INSTALLED_SKILLS when empty", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs"],
      installedSkills: [],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars).not.toHaveProperty("VERCEL_PLUGIN_INSTALLED_SKILLS");
  });

  test("buildSessionStartProfilerEnvVars omits INSTALLED_SKILLS when undefined", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars).not.toHaveProperty("VERCEL_PLUGIN_INSTALLED_SKILLS");
  });

  test("GREENFIELD is excluded from claude-code env export set", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: true,
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    // GREENFIELD is in the envVars map but skipped during setSessionEnv loop
    expect(envVars.VERCEL_PLUGIN_GREENFIELD).toBe("true");
    // Both LIKELY and INSTALLED are NOT skipped — they should be exported
    expect(envVars.VERCEL_PLUGIN_LIKELY_SKILLS).toBe("nextjs");
    expect(envVars.VERCEL_PLUGIN_INSTALLED_SKILLS).toBe("nextjs");

    // Verify that only GREENFIELD would be skipped in the export loop
    const exportedKeys = Object.keys(envVars).filter(
      (key) => key !== "VERCEL_PLUGIN_GREENFIELD",
    );
    expect(exportedKeys).toContain("VERCEL_PLUGIN_LIKELY_SKILLS");
    expect(exportedKeys).toContain("VERCEL_PLUGIN_INSTALLED_SKILLS");
    expect(exportedKeys).toContain("VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE");
  });

  test("cursor output includes LIKELY_SKILLS and INSTALLED_SKILLS in env", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: true,
      greenfield: false,
      likelySkills: ["ai-sdk", "nextjs"],
      installedSkills: ["ai-sdk"],
      setupSignals: { bootstrapHints: ["readme"], resourceHints: [], setupMode: false },
    });
    const output = formatSessionStartProfilerCursorOutput(envVars, []);
    const parsed = JSON.parse(output);
    expect(parsed.env.VERCEL_PLUGIN_LIKELY_SKILLS).toBe("ai-sdk,nextjs");
    expect(parsed.env.VERCEL_PLUGIN_INSTALLED_SKILLS).toBe("ai-sdk");
  });
});
