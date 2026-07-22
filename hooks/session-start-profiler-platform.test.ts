import { describe, expect, test } from "bun:test";
import {
  buildWindowsShellCommand,
  detectSessionStartPlatform,
  getBinaryPathCandidates,
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

describe("session-start-profiler Windows CLI resolution", () => {
  test("test_windows_prefers_pathext_launchers_over_extensionless_npm_shims", () => {
    const candidates = getBinaryPathCandidates("vercel", "win32");
    const uppercaseCandidates = candidates.map((candidate: string) => candidate.toUpperCase());

    expect(uppercaseCandidates).toContain("VERCEL.CMD");
    expect(candidates).not.toContain("vercel");
    expect(candidates[0]).toMatch(/^vercel\./i);
  });

  test("test_windows_cmd_shims_are_quoted_for_the_command_shell", () => {
    expect(
      buildWindowsShellCommand(
        "C:\\Users\\Adam\\AppData\\Roaming\\npm\\vercel.cmd",
        ["--version"],
        "win32",
      ),
    ).toBe('"C:\\Users\\Adam\\AppData\\Roaming\\npm\\vercel.cmd" "--version"');
  });
});
