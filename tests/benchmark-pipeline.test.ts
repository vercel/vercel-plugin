import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BenchmarkRunManifest } from "../scripts/benchmark-runner";
import {
  cwdToProjectDirName,
  analyzeSessionJsonl,
  parseTraceLog,
} from "../scripts/benchmark-analyze";
import {
  isSuccessStatus,
  detectPortFromOutput,
  pollServer,
} from "../scripts/benchmark-verify";
import type { ReportJson } from "../scripts/benchmark-report";
import {
  buildSuggestedPatterns,
  SKILL_PATTERN_HINTS,
} from "../scripts/benchmark-report";

// ---------------------------------------------------------------------------
// cwdToProjectDirName — various path formats
// ---------------------------------------------------------------------------

describe("cwdToProjectDirName", () => {
  test("absolute path becomes dash-delimited with leading dash", () => {
    expect(cwdToProjectDirName("/Users/john/dev/app")).toBe(
      "-Users-john-dev-app",
    );
  });

  test("handles paths with hyphens in directory names", () => {
    expect(
      cwdToProjectDirName("/Users/john/dev/vercel-plugin-testing/01-recipe"),
    ).toBe("-Users-john-dev-vercel-plugin-testing-01-recipe");
  });

  test("single slash becomes single dash", () => {
    expect(cwdToProjectDirName("/")).toBe("-");
  });

  test("deeply nested path", () => {
    expect(cwdToProjectDirName("/a/b/c/d/e/f")).toBe("-a-b-c-d-e-f");
  });

  test("path with trailing slash", () => {
    expect(cwdToProjectDirName("/Users/john/dev/")).toBe("-Users-john-dev-");
  });
});

// ---------------------------------------------------------------------------
// analyzeSessionJsonl — mock JSONL fixture
// ---------------------------------------------------------------------------

describe("analyzeSessionJsonl", () => {
  let tmpDir: string;

  test("accumulates tokens and tool calls across multiple entries", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-pipeline-"));
    const jsonlPath = join(tmpDir, "session.jsonl");

    const lines = [
      // First assistant message with usage + tool calls
      JSON.stringify({
        sessionId: "pipeline-test-001",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 500,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
          content: [
            { type: "tool_use", name: "Read", id: "t1" },
            { type: "tool_use", name: "Bash", id: "t2" },
          ],
        },
      }),
      // Second assistant message
      JSON.stringify({
        message: {
          role: "assistant",
          usage: {
            input_tokens: 300,
            output_tokens: 100,
            cache_read_input_tokens: 10,
          },
          content: [
            { type: "tool_use", name: "Edit", id: "t3" },
            { type: "tool_use", name: "Read", id: "t4" },
            { type: "tool_use", name: "Glob", id: "t5" },
          ],
        },
      }),
      // Error tool result
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              is_error: true,
              content: "Permission denied",
            },
          ],
        },
      }),
    ];

    await writeFile(jsonlPath, lines.join("\n"));
    const stats = await analyzeSessionJsonl(jsonlPath);

    expect(stats.sessionId).toBe("pipeline-test-001");
    expect(stats.tokens.input).toBe(800);
    expect(stats.tokens.output).toBe(300);
    expect(stats.tokens.cacheRead).toBe(60);
    expect(stats.tokens.cacheCreation).toBe(25);
    expect(stats.toolCalls).toEqual({ Read: 2, Bash: 1, Edit: 1, Glob: 1 });
    expect(stats.totalToolCalls).toBe(5);
    expect(stats.errors).toContain("Permission denied");

    await rm(tmpDir, { recursive: true });
  });

  test("skips lines with no message property", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-pipeline-"));
    const jsonlPath = join(tmpDir, "nomsg.jsonl");

    await writeFile(
      jsonlPath,
      [
        JSON.stringify({ sessionId: "s1", type: "init" }),
        JSON.stringify({
          sessionId: "s1",
          message: {
            usage: { input_tokens: 42, output_tokens: 7 },
          },
        }),
      ].join("\n"),
    );

    const stats = await analyzeSessionJsonl(jsonlPath);
    expect(stats.sessionId).toBe("s1");
    expect(stats.tokens.input).toBe(42);
    expect(stats.tokens.output).toBe(7);
    expect(stats.totalToolCalls).toBe(0);

    await rm(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// parseTraceLog — mock trace entries with skill-injection events
// ---------------------------------------------------------------------------

describe("parseTraceLog", () => {
  test("extracts skill-injection events", () => {
    const traceText = [
      JSON.stringify({
        event: "skill-injection",
        toolName: "Read",
        matchedSkills: ["nextjs", "ai-sdk"],
        injectedSkills: ["nextjs", "ai-sdk"],
        droppedByCap: [],
        droppedByBudget: [],
      }),
      JSON.stringify({
        event: "skill-injection",
        toolName: "Bash",
        matchedSkills: ["nextjs", "turbopack", "vercel-storage"],
        injectedSkills: ["turbopack", "vercel-storage"],
        droppedByCap: ["nextjs"],
        droppedByBudget: [],
      }),
    ].join("\n");

    const injections = parseTraceLog(traceText);
    expect(injections).toHaveLength(2);

    expect(injections[0].toolName).toBe("Read");
    expect(injections[0].injectedSkills).toEqual(["nextjs", "ai-sdk"]);
    expect(injections[0].droppedByCap).toEqual([]);

    expect(injections[1].toolName).toBe("Bash");
    expect(injections[1].injectedSkills).toEqual(["turbopack", "vercel-storage"]);
    expect(injections[1].droppedByCap).toEqual(["nextjs"]);
  });

  test("ignores non-skill-injection events", () => {
    const traceText = [
      JSON.stringify({ event: "hook-start", toolName: "Read" }),
      JSON.stringify({
        event: "skill-injection",
        toolName: "Edit",
        matchedSkills: ["auth"],
        injectedSkills: ["auth"],
        droppedByCap: [],
        droppedByBudget: [],
      }),
      JSON.stringify({ event: "hook-complete", latencyMs: 12 }),
    ].join("\n");

    const injections = parseTraceLog(traceText);
    expect(injections).toHaveLength(1);
    expect(injections[0].toolName).toBe("Edit");
  });

  test("handles empty and malformed lines", () => {
    const traceText = [
      "",
      "not json at all",
      "{broken json",
      JSON.stringify({
        event: "skill-injection",
        toolName: "Write",
        matchedSkills: ["vercel-functions"],
        injectedSkills: ["vercel-functions"],
        droppedByCap: [],
        droppedByBudget: [],
      }),
    ].join("\n");

    const injections = parseTraceLog(traceText);
    expect(injections).toHaveLength(1);
    expect(injections[0].matchedSkills).toEqual(["vercel-functions"]);
  });

  test("returns empty array for empty input", () => {
    expect(parseTraceLog("")).toEqual([]);
  });

  test("handles entries with missing optional arrays", () => {
    const traceText = JSON.stringify({
      event: "skill-injection",
      toolName: "Bash",
      // matchedSkills, droppedByCap, droppedByBudget missing
      injectedSkills: ["payments"],
    });

    const injections = parseTraceLog(traceText);
    expect(injections).toHaveLength(1);
    expect(injections[0].matchedSkills).toEqual([]);
    expect(injections[0].injectedSkills).toEqual(["payments"]);
    expect(injections[0].droppedByCap).toEqual([]);
    expect(injections[0].droppedByBudget).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isSuccessStatus — verify helper
// ---------------------------------------------------------------------------

describe("isSuccessStatus", () => {
  test("accepts 200", () => expect(isSuccessStatus(200)).toBe(true));
  test("accepts 201", () => expect(isSuccessStatus(201)).toBe(true));
  test("accepts 301 redirect", () => expect(isSuccessStatus(301)).toBe(true));
  test("accepts 302 redirect", () => expect(isSuccessStatus(302)).toBe(true));
  test("rejects 404", () => expect(isSuccessStatus(404)).toBe(false));
  test("rejects 500", () => expect(isSuccessStatus(500)).toBe(false));
  test("rejects null", () => expect(isSuccessStatus(null)).toBe(false));
});

// ---------------------------------------------------------------------------
// detectPortFromOutput — verify helper
// ---------------------------------------------------------------------------

describe("detectPortFromOutput", () => {
  test("detects localhost:3000", () => {
    expect(detectPortFromOutput("ready on localhost:3000")).toBe(3000);
  });

  test("detects 127.0.0.1:4321", () => {
    expect(detectPortFromOutput("server at 127.0.0.1:4321")).toBe(4321);
  });

  test("detects 0.0.0.0:8080", () => {
    expect(detectPortFromOutput("listening on 0.0.0.0:8080")).toBe(8080);
  });

  test("returns null when no port found", () => {
    expect(detectPortFromOutput("some random output")).toBeNull();
  });

  test("picks first port from multi-line output", () => {
    const output = "compiling...\nready on localhost:3001\nalso http://localhost:3001";
    expect(detectPortFromOutput(output)).toBe(3001);
  });
});

// ---------------------------------------------------------------------------
// pollServer — smoke test with a local Bun server
// ---------------------------------------------------------------------------

describe("pollServer", () => {
  test("returns non-200 status from a server that returns 503", async () => {
    // Spin up a tiny server that always returns 503
    const server = Bun.serve({
      port: 0, // random available port
      fetch() {
        return new Response("Service Unavailable", { status: 503 });
      },
    });

    try {
      const result = await pollServer(server.port, 5000);
      expect(result.status).toBe(503);
      expect(result.body).toContain("Service Unavailable");
    } finally {
      server.stop(true);
    }
  });

  test("returns 200 from a healthy server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("OK", { status: 200 });
      },
    });

    try {
      const result = await pollServer(server.port, 5000);
      expect(result.status).toBe(200);
      expect(result.body).toBe("OK");
    } finally {
      server.stop(true);
    }
  });

  test("returns redirect status without following", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      },
    });

    try {
      const result = await pollServer(server.port, 5000);
      expect(result.status).toBe(302);
    } finally {
      server.stop(true);
    }
  });

  test("returns null status when no server is listening (short timeout)", async () => {
    // Use a port that's almost certainly not listening
    const result = await pollServer(59999, 1500);
    expect(result.status).toBeNull();
    expect(result.body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BenchmarkRunManifest — round-trip write/read
// ---------------------------------------------------------------------------

describe("BenchmarkRunManifest", () => {
  let tmpDir: string;

  test("round-trips through JSON serialization", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-manifest-"));
    const resultsDir = join(tmpDir, "results");
    await mkdir(resultsDir, { recursive: true });

    const manifest: BenchmarkRunManifest = {
      runId: "run-1234567890-abc123",
      timestamp: "2026-03-07T12:00:00.000Z",
      baseDir: tmpDir,
      projects: [
        {
          slug: "01-recipe-platform",
          cwd: join(tmpDir, "01-recipe-platform"),
          promptHash: "a1b2c3d4e5f6",
          expectedSkills: ["auth", "vercel-storage", "nextjs"],
        },
        {
          slug: "02-trivia-game",
          cwd: join(tmpDir, "02-trivia-game"),
          promptHash: "f6e5d4c3b2a1",
          expectedSkills: ["vercel-storage", "nextjs"],
        },
      ],
    };

    const manifestPath = join(resultsDir, "run-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const loaded = JSON.parse(
      await readFile(manifestPath, "utf-8"),
    ) as BenchmarkRunManifest;

    expect(loaded.runId).toBe(manifest.runId);
    expect(loaded.timestamp).toBe(manifest.timestamp);
    expect(loaded.baseDir).toBe(manifest.baseDir);
    expect(loaded.projects).toHaveLength(2);
    expect(loaded.projects[0].slug).toBe("01-recipe-platform");
    expect(loaded.projects[0].cwd).toBe(join(tmpDir, "01-recipe-platform"));
    expect(loaded.projects[0].promptHash).toBe("a1b2c3d4e5f6");
    expect(loaded.projects[0].expectedSkills).toEqual(["auth", "vercel-storage", "nextjs"]);
    expect(loaded.projects[1].slug).toBe("02-trivia-game");
    expect(loaded.projects[1].expectedSkills).toEqual(["vercel-storage", "nextjs"]);

    await rm(tmpDir, { recursive: true });
  });

  test("manifest projects contain correct cwd paths", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-manifest-"));

    const manifest: BenchmarkRunManifest = {
      runId: "run-test-cwd",
      timestamp: new Date().toISOString(),
      baseDir: tmpDir,
      projects: [
        {
          slug: "03-code-review-bot",
          cwd: join(tmpDir, "03-code-review-bot"),
          promptHash: "abcdef123456",
          expectedSkills: ["ai-sdk", "nextjs"],
        },
      ],
    };

    // Verify cwd can be used for session lookup
    const dirName = cwdToProjectDirName(manifest.projects[0].cwd);
    expect(dirName).toContain("03-code-review-bot");
    expect(dirName.startsWith("-")).toBe(true);

    await rm(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// ReportJson — structure validation and suggestedPatterns
// ---------------------------------------------------------------------------

describe("ReportJson structure", () => {
  test("buildSuggestedPatterns returns known patterns for missing skills", () => {
    const missing = new Map<string, string[]>([
      ["auth", ["01-recipe", "02-trivia"]],
      ["vercel-functions", ["03-aggregator"]],
    ]);

    const patterns = buildSuggestedPatterns(missing);
    expect(patterns.length).toBeGreaterThan(0);

    // auth should have known hints
    const authPatterns = patterns.filter((p) => p.skill === "auth");
    expect(authPatterns.length).toBeGreaterThan(0);
    for (const p of authPatterns) {
      expect(p).toHaveProperty("skill");
      expect(p).toHaveProperty("glob");
      expect(p).toHaveProperty("tool");
      expect(typeof p.glob).toBe("string");
      expect(typeof p.tool).toBe("string");
    }

    // vercel-functions should have known hints
    const cronPatterns = patterns.filter((p) => p.skill === "vercel-functions");
    expect(cronPatterns.length).toBeGreaterThan(0);
  });

  test("buildSuggestedPatterns returns generic fallback for unknown skills", () => {
    const missing = new Map<string, string[]>([
      ["some-unknown-skill", ["01-foo"]],
    ]);

    const patterns = buildSuggestedPatterns(missing);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].skill).toBe("some-unknown-skill");
    expect(patterns[0].glob).toBe("**/*");
    expect(patterns[0].tool).toBe("Read");
  });

  test("buildSuggestedPatterns returns empty array when no missing skills", () => {
    const missing = new Map<string, string[]>();
    expect(buildSuggestedPatterns(missing)).toEqual([]);
  });

  test("ReportJson satisfies expected schema shape", () => {
    const report: ReportJson = {
      runId: "run-12345",
      timestamp: new Date().toISOString(),
      verdict: "partial",
      gaps: [
        {
          slug: "01-recipe",
          expected: ["auth", "nextjs"],
          actual: ["nextjs"],
          missing: ["auth"],
        },
      ],
      recommendations: ["Fix auth trigger patterns"],
      suggestedPatterns: [
        { skill: "auth", glob: "middleware.{ts,js}", tool: "Read" },
      ],
    };

    // Verify all required top-level keys
    expect(report).toHaveProperty("runId");
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("verdict");
    expect(report).toHaveProperty("gaps");
    expect(report).toHaveProperty("recommendations");
    expect(report).toHaveProperty("suggestedPatterns");

    // Verify verdict is one of the valid values
    expect(["pass", "partial", "fail"]).toContain(report.verdict);

    // Verify gaps shape
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toHaveProperty("slug");
    expect(report.gaps[0]).toHaveProperty("expected");
    expect(report.gaps[0]).toHaveProperty("actual");
    expect(report.gaps[0]).toHaveProperty("missing");

    // Verify suggestedPatterns shape
    expect(report.suggestedPatterns).toHaveLength(1);
    expect(report.suggestedPatterns[0]).toHaveProperty("skill");
    expect(report.suggestedPatterns[0]).toHaveProperty("glob");
    expect(report.suggestedPatterns[0]).toHaveProperty("tool");

    // Verify JSON round-trip
    const json = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(json) as ReportJson;
    expect(parsed.runId).toBe(report.runId);
    expect(parsed.verdict).toBe("partial");
    expect(parsed.gaps).toEqual(report.gaps);
    expect(parsed.suggestedPatterns).toEqual(report.suggestedPatterns);
  });

  test("SKILL_PATTERN_HINTS has entries for commonly missed skills", () => {
    const expectedSkills = ["auth", "nextjs", "ai-sdk", "payments", "vercel-functions"];
    for (const skill of expectedSkills) {
      expect(SKILL_PATTERN_HINTS[skill]).toBeDefined();
      expect(SKILL_PATTERN_HINTS[skill].length).toBeGreaterThan(0);
      for (const hint of SKILL_PATTERN_HINTS[skill]) {
        expect(hint).toHaveProperty("glob");
        expect(hint).toHaveProperty("tool");
      }
    }
  });
});
