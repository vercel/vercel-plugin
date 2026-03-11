import { describe, expect, test } from "bun:test";

import {
  buildArtifactManifest,
  calculatePhaseDuration,
  evaluateBuildWaitState,
  isExpectedRunCommandTimeout,
  parseBuildExitCode,
  renderTimingMarkdownTable,
  summarizeToolCalls,
} from "../.claude/skills/benchmark-sandbox/run-eval.ts";

describe("isExpectedRunCommandTimeout", () => {
  test("matches the expected sandbox API timeout error", () => {
    expect(isExpectedRunCommandTimeout(new Error("runCommand timed out after 300000ms"))).toBe(true);
    expect(isExpectedRunCommandTimeout(new Error("deadline exceeded while waiting for response"))).toBe(true);
  });

  test("does not hide unrelated build launch failures", () => {
    expect(isExpectedRunCommandTimeout(new Error("permission denied"))).toBe(false);
  });
});

describe("parseBuildExitCode", () => {
  test("reads a raw exit code file value", () => {
    expect(parseBuildExitCode("0")).toBe(0);
  });

  test("reads the final EXIT marker from the build log", () => {
    expect(parseBuildExitCode("line 1\nEXIT:124\nline 2\nEXIT:0")).toBe(0);
  });

  test("returns null when no exit marker is available yet", () => {
    expect(parseBuildExitCode("(cmd failed)")).toBeNull();
    expect(parseBuildExitCode("build still running")).toBeNull();
  });
});

describe("evaluateBuildWaitState", () => {
  test("keeps polling while Claude is still running before the phase timeout", () => {
    expect(evaluateBuildWaitState({
      claudeProbe: "1234\n5678",
      debugLine: "Tool call finished",
      elapsedMs: 45_000,
      timeoutMs: 300_000,
    })).toEqual({
      claudeRunning: true,
      sessionEnded: false,
      timedOut: false,
      shouldKeepPolling: true,
    });
  });

  test("stops polling when the latest debug line reports SessionEnd", () => {
    expect(evaluateBuildWaitState({
      claudeProbe: "1234",
      debugLine: "2026-03-11T00:00:00Z SessionEnd cleanup complete",
      elapsedMs: 60_000,
      timeoutMs: 300_000,
    })).toEqual({
      claudeRunning: true,
      sessionEnded: true,
      timedOut: false,
      shouldKeepPolling: false,
    });
  });

  test("stops polling when the Claude process has exited", () => {
    expect(evaluateBuildWaitState({
      claudeProbe: "",
      debugLine: "",
      elapsedMs: 60_000,
      timeoutMs: 300_000,
    })).toEqual({
      claudeRunning: false,
      sessionEnded: false,
      timedOut: false,
      shouldKeepPolling: false,
    });
  });

  test("marks the build phase as timed out once the overall deadline is exceeded", () => {
    expect(evaluateBuildWaitState({
      claudeProbe: "1234",
      debugLine: "",
      elapsedMs: 301_000,
      timeoutMs: 300_000,
    })).toEqual({
      claudeRunning: true,
      sessionEnded: false,
      timedOut: true,
      shouldKeepPolling: false,
    });
  });
});

describe("calculatePhaseDuration", () => {
  test("returns the elapsed phase duration when both endpoints exist", () => {
    expect(calculatePhaseDuration(1_250, 4_000)).toBe(2_750);
  });

  test("returns null when a phase was skipped", () => {
    expect(calculatePhaseDuration(null, 4_000)).toBeNull();
    expect(calculatePhaseDuration(1_250, null)).toBeNull();
  });
});

describe("renderTimingMarkdownTable", () => {
  test("renders per-scenario phase durations and marks skipped phases", () => {
    const markdown = renderTimingMarkdownTable([
      {
        slug: "timed-scenario",
        timing: {
          sandboxCreateMs: 1_000,
          installMs: 2_000,
          pluginInstallMs: 3_000,
          buildStartMs: 10_000,
          buildEndMs: 25_000,
          verifyStartMs: 26_000,
          verifyEndMs: 31_000,
          deployStartMs: null,
          deployEndMs: null,
          extractMs: 4_000,
        },
      },
    ]);

    expect(markdown).toContain("## Timing");
    expect(markdown).toContain("| timed-scenario | 1.0s | 2.0s | 3.0s | 15.0s | 5.0s | skip | 4.0s |");
  });
});

describe("buildArtifactManifest", () => {
  test("sorts artifact entries and reports the artifact count", () => {
    const manifest = buildArtifactManifest([
      { fileName: "z-last.txt", sizeBytes: 30, description: "last" },
      { fileName: "a-first.txt", sizeBytes: 10, description: "first" },
    ]);

    expect(manifest.artifactCount).toBe(2);
    expect(manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "a-first.txt",
      "z-last.txt",
    ]);
    expect(typeof manifest.generatedAt).toBe("string");
  });
});

describe("summarizeToolCalls", () => {
  test("extracts timestamp and tool name from raw debug grep output", () => {
    const summary = summarizeToolCalls(
      '/home/vercel-sandbox/.claude/debug/session.log:12:2026-03-11T00:00:00.000Z executePreToolHooks called tool=Read',
    );

    expect(summary).toContain("2026-03-11T00:00:00.000Z | Read |");
  });

  test("returns a stable fallback when no hook calls were found", () => {
    expect(summarizeToolCalls("(cmd failed)")).toBe("No executePreToolHooks entries found.");
  });
});
