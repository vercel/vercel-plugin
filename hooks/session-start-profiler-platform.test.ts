import { describe, expect, test } from "bun:test";
import {
  buildAutoInstallResultBlock,
  buildSessionStartProfilerEnvVars,
  detectSessionStartPlatform,
  formatSessionStartProfilerCursorOutput,
} from "./src/session-start-profiler.mts";
import type { InstallSkillsResult } from "./src/registry-client.mts";

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

  test("buildSessionStartProfilerEnvVars includes MISSING_SKILLS when present", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["ai-sdk", "nextjs", "shadcn"],
      installedSkills: ["nextjs"],
      missingSkills: ["ai-sdk", "shadcn"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars.VERCEL_PLUGIN_MISSING_SKILLS).toBe("ai-sdk,shadcn");
  });

  test("buildSessionStartProfilerEnvVars omits MISSING_SKILLS when empty", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs"],
      installedSkills: ["nextjs"],
      missingSkills: [],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars).not.toHaveProperty("VERCEL_PLUGIN_MISSING_SKILLS");
  });

  test("buildSessionStartProfilerEnvVars omits MISSING_SKILLS when undefined", () => {
    const envVars = buildSessionStartProfilerEnvVars({
      agentBrowserAvailable: false,
      greenfield: false,
      likelySkills: ["nextjs"],
      setupSignals: { bootstrapHints: [], resourceHints: [], setupMode: false },
    });
    expect(envVars).not.toHaveProperty("VERCEL_PLUGIN_MISSING_SKILLS");
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

// ---------------------------------------------------------------------------
// buildAutoInstallResultBlock — refreshed vs stale result rendering
// ---------------------------------------------------------------------------

describe("buildAutoInstallResultBlock", () => {
  const stateRoot = "/home/alice/.vercel-plugin/projects/abc123";
  const skillsDir = `${stateRoot}/.skills`;
  const installPlanPath = `${skillsDir}/install-plan.json`;

  test("renders 'ready' when refreshed missing is empty even if install result had misses", () => {
    const result: InstallSkillsResult = {
      installed: [],
      reused: [],
      missing: ["nextjs"],
      command: "npx skills add nextjs --agent claude-code",
      commandCwd: stateRoot,
    };
    const block = buildAutoInstallResultBlock({
      result,
      stateRoot,
      skillsDir,
      installPlanPath,
      refreshedInstalledSkills: ["nextjs"],
      refreshedMissingSkills: [],
    });
    expect(block).toContain("(ready)");
    expect(block).toContain("Remaining missing: none");
    expect(block).toContain("Cached after refresh: nextjs");
    // No retry line when nothing is missing after refresh
    expect(block).not.toContain("Retry:");
  });

  test("renders 'partial' when install succeeded but refreshed missing remains", () => {
    const result: InstallSkillsResult = {
      installed: ["nextjs"],
      reused: [],
      missing: ["ai-sdk"],
      command: "npx skills add nextjs ai-sdk --agent claude-code",
      commandCwd: stateRoot,
    };
    const block = buildAutoInstallResultBlock({
      result,
      stateRoot,
      skillsDir,
      installPlanPath,
      refreshedInstalledSkills: ["nextjs"],
      refreshedMissingSkills: ["ai-sdk"],
    });
    expect(block).toContain("(partial)");
    expect(block).toContain("Installed now: nextjs");
    expect(block).toContain("Remaining missing: ai-sdk");
    expect(block).toContain(`Retry: cd '${stateRoot}'`);
  });

  test("renders 'needs attention' when nothing installed and refreshed missing remains", () => {
    const result: InstallSkillsResult = {
      installed: [],
      reused: [],
      missing: ["nextjs"],
      command: "npx skills add nextjs --agent claude-code",
      commandCwd: stateRoot,
    };
    const block = buildAutoInstallResultBlock({
      result,
      stateRoot,
      skillsDir,
      installPlanPath,
      refreshedInstalledSkills: [],
      refreshedMissingSkills: ["nextjs"],
    });
    expect(block).toContain("(needs attention)");
    expect(block).toContain("Remaining missing: nextjs");
    expect(block).toContain("Retry:");
  });

  test("omits retry line when command is null", () => {
    const result: InstallSkillsResult = {
      installed: [],
      reused: [],
      missing: ["nextjs"],
      command: null,
      commandCwd: null,
    };
    const block = buildAutoInstallResultBlock({
      result,
      stateRoot,
      skillsDir,
      installPlanPath,
      refreshedInstalledSkills: [],
      refreshedMissingSkills: ["nextjs"],
    });
    expect(block).not.toContain("Retry:");
  });

  test("retry uses cd '<stateRoot>' && <command> format", () => {
    const result: InstallSkillsResult = {
      installed: [],
      reused: [],
      missing: ["ai-sdk"],
      command: "npx skills add ai-sdk --agent claude-code",
      commandCwd: stateRoot,
    };
    const block = buildAutoInstallResultBlock({
      result,
      stateRoot,
      skillsDir,
      installPlanPath,
      refreshedInstalledSkills: [],
      refreshedMissingSkills: ["ai-sdk"],
    });
    expect(block).toContain(
      `Retry: cd '${stateRoot}' && npx skills add ai-sdk --agent claude-code`,
    );
  });
});
