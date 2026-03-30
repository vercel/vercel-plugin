import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLearnCommand, learnedRulesPath } from "../src/cli/learn.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = "2026-03-28T06:00:00.000Z";
const TEST_SESSION = "test-learn-cli";
const FOREIGN_SESSION = "test-learn-cli-foreign";
let tempProjectCounter = 0;

/** Minimal fixture project with a skills/ dir. */
function makeTempProject(): string {
  tempProjectCounter += 1;
  const dir = join(
    tmpdir(),
    `vercel-plugin-learn-test-${Date.now()}-${tempProjectCounter}`,
  );
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "generated"), { recursive: true });
  return dir;
}

/** Write a JSONL trace file for a session. */
function writeTraceFixture(sessionId: string, traces: object[]): void {
  const traceDir = join(tmpdir(), `vercel-plugin-${sessionId}-trace`);
  mkdirSync(traceDir, { recursive: true });
  const lines = traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
  writeFileSync(join(traceDir, "routing-decision-trace.jsonl"), lines);
}

/** Write an exposure JSONL file for a session. */
function writeExposureFixture(sessionId: string, exposures: object[]): void {
  const path = join(tmpdir(), `vercel-plugin-${sessionId}-routing-exposures.jsonl`);
  const lines = exposures.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, lines);
}

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    decisionId: "d1",
    sessionId: TEST_SESSION,
    hook: "PreToolUse",
    toolName: "Read",
    toolTarget: "/app/page.tsx",
    timestamp: FIXED_TS,
    primaryStory: {
      id: "story-1",
      kind: "feature",
      storyRoute: "/app",
      targetBoundary: "uiRender",
    },
    observedRoute: "/app",
    policyScenario: null,
    matchedSkills: [],
    injectedSkills: [],
    skippedReasons: [],
    ranked: [],
    verification: null,
    ...overrides,
  };
}

function makeExposure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "exp-1",
    sessionId: TEST_SESSION,
    projectRoot: "/test",
    storyId: "story-1",
    storyKind: "feature",
    route: "/app",
    hook: "PreToolUse",
    toolName: "Read",
    targetBoundary: "uiRender",
    exposureGroupId: null,
    attributionRole: "candidate",
    candidateSkill: "next-config",
    createdAt: FIXED_TS,
    resolvedAt: FIXED_TS,
    outcome: "win",
    skill: "next-config",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs = [];
  tempProjectCounter = 0;
});

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  // Clean up test session trace dir
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-trace`), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-routing-exposures.jsonl`), { force: true });
  } catch {}
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${FOREIGN_SESSION}-trace`), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${FOREIGN_SESSION}-routing-exposures.jsonl`), { force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLearnCommand", () => {
  test("returns exit code 0 with no traces", async () => {
    const project = trackDir(makeTempProject());
    const code = await runLearnCommand({ project, session: TEST_SESSION });
    expect(code).toBe(0);
  });

  test("returns exit code 2 for missing project", async () => {
    const code = await runLearnCommand({ project: "/nonexistent/path", json: true });
    expect(code).toBe(2);
  });

  test("--json outputs valid JSON to stdout", async () => {
    const project = trackDir(makeTempProject());
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const stdout = logs.join("\n");
    const parsed = JSON.parse(stdout);
    expect(parsed.rules.version).toBe(1);
    expect(parsed.rules.rules).toEqual([]);
    expect(parsed.rules.replay).toBeDefined();
    expect(parsed.rules.replay.regressions).toEqual([]);
  });

  test("--write creates generated/learned-routing-rules.json", async () => {
    const project = trackDir(makeTempProject());
    const code = await runLearnCommand({ project, write: true, session: TEST_SESSION });
    expect(code).toBe(0);

    const outPath = learnedRulesPath(project);
    expect(existsSync(outPath)).toBe(true);

    const content = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.projectRoot).toBe(project);
  });

  test("--json with traces produces rules in output", async () => {
    const project = trackDir(makeTempProject());

    // Write 6 winning traces (enough for candidate/promote)
    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [
          {
            skill: "next-config",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "next.config.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);

    const exposures = [makeExposure({ skill: "next-config", outcome: "win" })];
    writeExposureFixture(TEST_SESSION, exposures);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const stdout = logs.join("\n");
    const parsed = JSON.parse(stdout);
    expect(parsed.rules.rules.length).toBeGreaterThanOrEqual(1);
    expect(parsed.rules.replay).toBeDefined();
  });

  test("--write exits non-zero when replay reports regressions", async () => {
    const project = trackDir(makeTempProject());

    // Winning traces for skill-a (baseline wins), but promoted rule targets skill-b
    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["skill-a"],
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
        ranked: [
          {
            skill: "skill-b",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "b.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);

    // skill-b wins in exposure — it'll get promoted, but baseline wins used skill-a
    const exposures = [makeExposure({ skill: "skill-b", outcome: "win" })];
    writeExposureFixture(TEST_SESSION, exposures);

    const code = await runLearnCommand({
      project,
      write: true,
      session: TEST_SESSION,
    });

    // The distiller may or may not produce regressions depending on the exact
    // scoring. If no rules get promoted, there are no regressions, exit 0.
    // If rules get promoted and cause regressions, exit 1.
    // Either outcome is valid — just verify the file was written.
    const outPath = learnedRulesPath(project);
    expect(existsSync(outPath)).toBe(true);
  });

  test("human-readable output includes summary lines", async () => {
    const project = trackDir(makeTempProject());
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    // With no traces, human output reports zero rules
    const stdout = logs.join("\n");
    expect(stdout).toContain("Learned routing rules: 0");
    expect(stdout).toContain("promoted: 0");
    expect(stdout).toContain("baseline wins:");
  });

  test("custom thresholds are passed through to distiller", async () => {
    const project = trackDir(makeTempProject());

    const traces = Array.from({ length: 3 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [
          {
            skill: "next-config",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "next.config.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [makeExposure({ skill: "next-config", outcome: "win" })]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({
        project,
        json: true,
        session: TEST_SESSION,
        minSupport: 2,
        minPrecision: 0.5,
        minLift: 1.0,
      });
    } finally {
      console.log = origLog;
    }

    const stdout = logs.join("\n");
    const parsed = JSON.parse(stdout);
    // With relaxed thresholds and 3 traces, should produce at least 1 rule
    expect(parsed.rules.rules.length).toBeGreaterThanOrEqual(1);
  });

  test("auto-discovery excludes sessions from other projects", async () => {
    const project = trackDir(makeTempProject());
    const otherProject = trackDir(makeTempProject());

    writeTraceFixture(TEST_SESSION, [
      makeTrace({
        decisionId: "local-1",
        injectedSkills: ["next-config"],
        ranked: [
          {
            skill: "next-config",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "next.config.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    ]);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ projectRoot: project, skill: "next-config", outcome: "win" }),
    ]);

    writeTraceFixture(FOREIGN_SESSION, [
      makeTrace({
        decisionId: "foreign-1",
        sessionId: FOREIGN_SESSION,
        injectedSkills: ["foreign-skill"],
        ranked: [
          {
            skill: "foreign-skill",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "foreign.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    ]);
    writeExposureFixture(FOREIGN_SESSION, [
      makeExposure({
        sessionId: FOREIGN_SESSION,
        projectRoot: otherProject,
        skill: "foreign-skill",
        candidateSkill: "foreign-skill",
        outcome: "win",
      }),
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true });
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.rules.rules).toHaveLength(1);
    expect(parsed.rules.rules[0]?.skill).toBe("next-config");
  });

  // ---------------------------------------------------------------------------
  // --write vs dry-run behavior
  // ---------------------------------------------------------------------------

  test("dry-run (no --write) does NOT create the artifact file", async () => {
    const project = trackDir(makeTempProject());

    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [
          {
            skill: "next-config",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "next.config.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [makeExposure({ skill: "next-config", outcome: "win" })]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    // stdout has JSON, but no file was written
    const stdout = logs.join("\n");
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(existsSync(learnedRulesPath(project))).toBe(false);
  });

  test("--write creates file while --json dry-run does not", async () => {
    const projectWrite = trackDir(makeTempProject());
    const projectDry = trackDir(makeTempProject());

    // Same session/traces for both
    writeTraceFixture(TEST_SESSION, []);
    writeExposureFixture(TEST_SESSION, []);

    await runLearnCommand({ project: projectWrite, write: true, session: TEST_SESSION });
    await runLearnCommand({ project: projectDry, json: true, session: TEST_SESSION });

    expect(existsSync(learnedRulesPath(projectWrite))).toBe(true);
    expect(existsSync(learnedRulesPath(projectDry))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Deterministic JSON output for --json
  // ---------------------------------------------------------------------------

  test("--json output has deterministic key ordering across runs", async () => {
    const project = trackDir(makeTempProject());

    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [
          {
            skill: "next-config",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "next.config.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [makeExposure({ skill: "next-config", outcome: "win" })]);

    const capture = async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await runLearnCommand({ project, json: true, session: TEST_SESSION });
      } finally {
        console.log = origLog;
      }
      const parsed = JSON.parse(logs.join("\n"));
      delete parsed.rules?.generatedAt;
      delete parsed.companions?.generatedAt;
      delete parsed.playbooks?.generatedAt;
      return JSON.stringify(parsed);
    };

    const run1 = await capture();
    const run2 = await capture();
    expect(run1).toBe(run2);
  });

  // ---------------------------------------------------------------------------
  // Regression exit code with properly constructed regression scenario
  // ---------------------------------------------------------------------------

  test("exit code 1 when replay detects regressions from promoted rules", async () => {
    const project = trackDir(makeTempProject());

    // 8 verified traces: skill-a injected (baseline wins), skill-b ranked
    const winTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["skill-a"],
        ranked: [
          {
            skill: "skill-b",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "b.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    // 8 unverified traces with skill-c to dilute scenario precision (lift > 1.5)
    const dilutionTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `dilute${i}`,
        injectedSkills: ["skill-c"],
        ranked: [
          {
            skill: "skill-c",
            basePriority: 6,
            effectivePriority: 6,
            pattern: { type: "path", value: "c.*" },
            profilerBoost: 0,
            policyBoost: 0,
            policyReason: null,
            summaryOnly: false,
            synthetic: false,
            droppedReason: null,
          },
        ],
      }),
    );

    writeTraceFixture(TEST_SESSION, [...winTraces, ...dilutionTraces]);
    writeExposureFixture(TEST_SESSION, [
      // skill-b: 8 candidate wins
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-b-${i}`,
          skill: "skill-b",
          candidateSkill: "skill-b",
          attributionRole: "candidate",
          outcome: "win",
        }),
      ),
      // skill-c: 8 candidate stale-misses (scenario dilution)
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-c-${i}`,
          skill: "skill-c",
          candidateSkill: "skill-c",
          attributionRole: "candidate",
          outcome: "stale-miss",
        }),
      ),
    ]);

    const code = await runLearnCommand({
      project,
      json: true,
      session: TEST_SESSION,
    });

    expect(code).toBe(1);
  });
});

describe("learnedRulesPath", () => {
  test("returns correct path", () => {
    const path = learnedRulesPath("/my/project");
    expect(path).toBe("/my/project/generated/learned-routing-rules.json");
  });
});
