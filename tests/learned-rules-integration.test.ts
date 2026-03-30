import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLearnCommand, learnedRulesPath } from "../src/cli/learn.ts";
import type { LearnedRoutingRulesFile } from "../hooks/src/rule-distillation.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = "2026-03-28T06:00:00.000Z";
const TEST_SESSION = "test-integration-learn";

function makeTempProject(): string {
  const dir = join(tmpdir(), `vercel-plugin-integ-learn-${Date.now()}`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "generated"), { recursive: true });
  return dir;
}

function writeTraceFixture(sessionId: string, traces: object[]): void {
  const traceDir = join(tmpdir(), `vercel-plugin-${sessionId}-trace`);
  mkdirSync(traceDir, { recursive: true });
  const lines = traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
  writeFileSync(join(traceDir, "routing-decision-trace.jsonl"), lines);
}

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

function makeRanked(skill: string, pattern?: { type: string; value: string }) {
  return {
    skill,
    basePriority: 6,
    effectivePriority: 6,
    pattern: pattern ?? null,
    profilerBoost: 0,
    policyBoost: 0,
    policyReason: null,
    summaryOnly: false,
    synthetic: false,
    droppedReason: null,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-trace`), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-routing-exposures.jsonl`), { force: true });
  } catch {}
});

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Integration: end-to-end learn pipeline
// ---------------------------------------------------------------------------

describe("learned-rules integration", () => {
  test("end-to-end: distill → write → read produces valid artifact", async () => {
    const project = trackDir(makeTempProject());

    // 8 winning traces + 8 losing traces to create lift
    const winTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `win${i}`,
        injectedSkills: ["next-config"],
        ranked: [makeRanked("next-config", { type: "path", value: "next.config.*" })],
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );
    const loseTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `lose${i}`,
        injectedSkills: ["tailwind"],
        ranked: [makeRanked("tailwind", { type: "path", value: "tailwind.*" })],
      }),
    );

    writeTraceFixture(TEST_SESSION, [...winTraces, ...loseTraces]);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ skill: "next-config", outcome: "win" }),
      makeExposure({ skill: "tailwind", outcome: "stale-miss" }),
    ]);

    const code = await runLearnCommand({
      project,
      write: true,
      session: TEST_SESSION,
    });

    expect(code).toBe(0);

    const outPath = learnedRulesPath(project);
    expect(existsSync(outPath)).toBe(true);

    const content: LearnedRoutingRulesFile = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.projectRoot).toBe(project);
    expect(content.rules.length).toBeGreaterThanOrEqual(1);
    expect(content.replay).toBeDefined();
    expect(content.replay.regressions).toEqual([]);
  });

  test("idempotent: running learn twice with same data produces identical artifacts", async () => {
    const project = trackDir(makeTempProject());

    const traces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [makeRanked("next-config", { type: "path", value: "next.config.*" })],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [makeExposure({ skill: "next-config", outcome: "win" })]);

    // Run 1
    const logs1: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs1.push(msg);
    await runLearnCommand({ project, json: true, session: TEST_SESSION });
    console.log = origLog;

    // Run 2
    const logs2: string[] = [];
    console.log = (msg: string) => logs2.push(msg);
    await runLearnCommand({ project, json: true, session: TEST_SESSION });
    console.log = origLog;

    const json1 = JSON.parse(logs1.join("\n"));
    const json2 = JSON.parse(logs2.join("\n"));

    // Strip generatedAt for comparison (timestamp changes between runs)
    delete json1.generatedAt;
    delete json2.generatedAt;
    expect(JSON.stringify(json1)).toBe(JSON.stringify(json2));
  });

  test("--json stdout contains only the JSON payload", async () => {
    const project = trackDir(makeTempProject());

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    // stdout must be valid JSON (no extra lines)
    const stdout = logs.join("\n");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  test("--write is atomic: file exists or doesn't, no partial writes", async () => {
    const project = trackDir(makeTempProject());

    await runLearnCommand({ project, write: true, session: TEST_SESSION });

    const outPath = learnedRulesPath(project);
    if (existsSync(outPath)) {
      // If file exists, it must be valid JSON
      const raw = readFileSync(outPath, "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  test("empty traces still produce valid artifact with --write", async () => {
    const project = trackDir(makeTempProject());

    await runLearnCommand({ project, write: true, session: TEST_SESSION });

    const outPath = learnedRulesPath(project);
    expect(existsSync(outPath)).toBe(true);

    const content: LearnedRoutingRulesFile = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(content.rules).toEqual([]);
    expect(content.replay.regressions).toEqual([]);
    expect(content.replay.baselineWins).toBe(0);
    expect(content.replay.baselineDirectiveWins).toBe(0);
    expect(content.replay.learnedWins).toBe(0);
    expect(content.replay.learnedDirectiveWins).toBe(0);
    expect(content.replay.deltaWins).toBe(0);
    expect(content.replay.deltaDirectiveWins).toBe(0);
  });

  test("exit code reflects regression state", async () => {
    const project = trackDir(makeTempProject());

    // No traces = no regressions = exit 0
    const code = await runLearnCommand({ project, session: TEST_SESSION });
    expect(code).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Exact-route promotion beating wildcard fallback
  // ---------------------------------------------------------------------------

  test("exact-route rule beats wildcard fallback in distillation", async () => {
    const project = trackDir(makeTempProject());

    // 6 traces on exact route /dashboard with skill-a winning
    const exactTraces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `exact${i}`,
        injectedSkills: ["skill-a"],
        ranked: [makeRanked("skill-a", { type: "path", value: "app/dashboard/**" })],
        primaryStory: {
          id: "story-1",
          kind: "feature",
          storyRoute: "/dashboard",
          targetBoundary: "uiRender",
        },
        observedRoute: "/dashboard",
        verification: {
          verificationId: `ve${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    // 6 traces on wildcard route * with skill-b winning
    const wildcardTraces = Array.from({ length: 6 }, (_, i) =>
      makeTrace({
        decisionId: `wild${i}`,
        injectedSkills: ["skill-b"],
        ranked: [makeRanked("skill-b", { type: "path", value: "**/*.tsx" })],
        primaryStory: {
          id: "story-2",
          kind: "feature",
          storyRoute: "*",
          targetBoundary: "uiRender",
        },
        observedRoute: "*",
        verification: {
          verificationId: `vw${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    writeTraceFixture(TEST_SESSION, [...exactTraces, ...wildcardTraces]);
    writeExposureFixture(TEST_SESSION, [
      ...Array.from({ length: 6 }, (_, i) =>
        makeExposure({
          id: `exp-exact-${i}`,
          skill: "skill-a",
          candidateSkill: "skill-a",
          route: "/dashboard",
          outcome: "win",
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeExposure({
          id: `exp-wild-${i}`,
          skill: "skill-b",
          candidateSkill: "skill-b",
          route: "*",
          outcome: "win",
        }),
      ),
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));
    // Both exact-route and wildcard should produce rules
    expect(parsed.rules.length).toBeGreaterThanOrEqual(2);

    // Exact-route rule for skill-a exists with routeScope=/dashboard
    const exactRule = parsed.rules.find(
      (r) => r.skill === "skill-a" && r.scenario.routeScope === "/dashboard",
    );
    expect(exactRule).toBeDefined();
    expect(exactRule!.support).toBe(6);

    // Wildcard rule for skill-b exists with routeScope=*
    const wildRule = parsed.rules.find(
      (r) => r.skill === "skill-b" && r.scenario.routeScope === "*",
    );
    expect(wildRule).toBeDefined();
    expect(wildRule!.support).toBe(6);

    // Both rules are scoped to their own scenario — they don't interfere
    expect(exactRule!.scenario.routeScope).not.toBe(wildRule!.scenario.routeScope);
  });

  // ---------------------------------------------------------------------------
  // Candidate-only attribution: context skills don't get policy credit
  // ---------------------------------------------------------------------------

  test("context-only attribution does not produce distilled rules", async () => {
    const project = trackDir(makeTempProject());

    // 8 traces where skill-candidate is the candidate and skill-context is context
    const traces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["skill-candidate", "skill-context"],
        ranked: [
          makeRanked("skill-candidate", { type: "path", value: "next.config.*" }),
          makeRanked("skill-context", { type: "path", value: "*.json" }),
        ],
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [
      // Candidate exposure — gets policy credit
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-cand-${i}`,
          skill: "skill-candidate",
          candidateSkill: "skill-candidate",
          attributionRole: "candidate",
          outcome: "win",
        }),
      ),
      // Context exposure — does NOT get policy credit
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-ctx-${i}`,
          skill: "skill-context",
          candidateSkill: "skill-candidate",
          attributionRole: "context",
          outcome: "win",
        }),
      ),
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));

    // Candidate skill should produce a rule
    const candidateRules = parsed.rules.filter((r) => r.skill === "skill-candidate");
    expect(candidateRules.length).toBeGreaterThanOrEqual(1);

    // Context skill must NOT produce any rules
    const contextRules = parsed.rules.filter((r) => r.skill === "skill-context");
    expect(contextRules).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Replay rejection on regression: promoted rules downgraded
  // ---------------------------------------------------------------------------

  test("replay rejection downgrades all promoted rules to holdout-fail", async () => {
    const project = trackDir(makeTempProject());

    // 8 verified traces: skill-a injected (baseline wins), skill-b ranked
    // → skill-b gets candidate exposure with wins
    const winTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `win${i}`,
        injectedSkills: ["skill-a"],
        ranked: [makeRanked("skill-b", { type: "path", value: "b-pattern.*" })],
        verification: {
          verificationId: `v${i}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );

    // 8 unverified traces with skill-c: dilute scenario precision so
    // skill-b's lift > 1.5 (lift = 1.0 / 0.5 = 2.0)
    const loseTraces = Array.from({ length: 8 }, (_, i) =>
      makeTrace({
        decisionId: `lose${i}`,
        injectedSkills: ["skill-c"],
        ranked: [makeRanked("skill-c", { type: "path", value: "c-pattern.*" })],
      }),
    );

    writeTraceFixture(TEST_SESSION, [...winTraces, ...loseTraces]);
    writeExposureFixture(TEST_SESSION, [
      // skill-b: 8 candidate wins (from the verified traces)
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-b-${i}`,
          skill: "skill-b",
          candidateSkill: "skill-b",
          attributionRole: "candidate",
          outcome: "win",
        }),
      ),
      // skill-c: 8 candidate stale-misses (from unverified traces)
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

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = await runLearnCommand({
        project,
        json: true,
        session: TEST_SESSION,
      });
      // Exit code 1 for regressions
      expect(code).toBe(1);
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));

    // All rules should be downgraded to holdout-fail
    for (const rule of parsed.rules) {
      expect(rule.confidence).toBe("holdout-fail");
      expect(rule.promotedAt).toBeNull();
    }

    // Regressions array should be populated and sorted
    expect(parsed.replay.regressions.length).toBeGreaterThan(0);
    const sorted = [...parsed.replay.regressions].sort();
    expect(parsed.replay.regressions).toEqual(sorted);
  });

  // ---------------------------------------------------------------------------
  // Deterministic JSON ordering
  // ---------------------------------------------------------------------------

  test("promoted rules have deterministic JSON ordering: confidence → skill → id", async () => {
    const project = trackDir(makeTempProject());

    // Create traces for three different skills that all get promoted
    const skills = ["zebra-skill", "alpha-skill", "middle-skill"];
    const allTraces: Record<string, unknown>[] = [];
    const allExposures: Record<string, unknown>[] = [];

    for (const skill of skills) {
      for (let i = 0; i < 6; i++) {
        allTraces.push(
          makeTrace({
            decisionId: `${skill}-d${i}`,
            injectedSkills: [skill],
            ranked: [makeRanked(skill, { type: "path", value: `${skill}.*` })],
            verification: {
              verificationId: `v-${skill}-${i}`,
              observedBoundary: "uiRender",
              matchedSuggestedAction: true,
            },
          }),
        );
        allExposures.push(
          makeExposure({
            id: `exp-${skill}-${i}`,
            skill,
            candidateSkill: skill,
            attributionRole: "candidate",
            outcome: "win",
          }),
        );
      }
    }

    writeTraceFixture(TEST_SESSION, allTraces);
    writeExposureFixture(TEST_SESSION, allExposures);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));

    // Verify rules are sorted by confidence, then skill, then id
    for (let i = 1; i < parsed.rules.length; i++) {
      const prev = parsed.rules[i - 1]!;
      const curr = parsed.rules[i]!;
      const confidenceOrder: Record<string, number> = {
        promote: 0,
        candidate: 1,
        "holdout-fail": 2,
      };
      const co =
        (confidenceOrder[prev.confidence] ?? 9) -
        (confidenceOrder[curr.confidence] ?? 9);
      if (co === 0) {
        const sk = prev.skill.localeCompare(curr.skill);
        if (sk === 0) {
          expect(prev.id.localeCompare(curr.id)).toBeLessThanOrEqual(0);
        } else {
          expect(sk).toBeLessThanOrEqual(0);
        }
      } else {
        expect(co).toBeLessThanOrEqual(0);
      }
    }

    // Verify sourceDecisionIds within each rule are sorted
    for (const rule of parsed.rules) {
      const sorted = [...rule.sourceDecisionIds].sort();
      expect(rule.sourceDecisionIds).toEqual(sorted);
    }
  });

  test("replay regression IDs are deterministically sorted", async () => {
    const project = trackDir(makeTempProject());

    // Multiple baseline wins with skill-a, but promoted rule for skill-b → regressions
    // Use deliberately unsorted decision IDs
    const decisionIds = ["z-dec", "a-dec", "m-dec", "b-dec"];
    const traces: Record<string, unknown>[] = decisionIds.map((id) =>
      makeTrace({
        decisionId: id,
        injectedSkills: ["skill-a"],
        ranked: [makeRanked("skill-b", { type: "path", value: "b.*" })],
        verification: {
          verificationId: `v-${id}`,
          observedBoundary: "uiRender",
          matchedSuggestedAction: true,
        },
      }),
    );
    // Add extra non-regressing traces to reach support threshold (4 win + 4 lose = lift > 1)
    for (let i = 0; i < 4; i++) {
      traces.push(
        makeTrace({
          decisionId: `extra-b-${i}`,
          injectedSkills: ["skill-b"],
          ranked: [makeRanked("skill-b", { type: "path", value: "b.*" })],
        }),
      );
    }
    // Add losing traces for a different skill to dilute scenario precision
    for (let i = 0; i < 8; i++) {
      traces.push(
        makeTrace({
          decisionId: `dilute-${i}`,
          injectedSkills: ["skill-c"],
          ranked: [makeRanked("skill-c", { type: "path", value: "c.*" })],
        }),
      );
    }

    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [
      // skill-b: 8 candidate wins (4 verified + 4 unverified from ranked matching)
      ...Array.from({ length: 8 }, (_, i) =>
        makeExposure({
          id: `exp-b-${i}`,
          skill: "skill-b",
          candidateSkill: "skill-b",
          attributionRole: "candidate",
          outcome: "win",
        }),
      ),
      // skill-c: 8 candidate stale-misses (to dilute scenario precision)
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

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runLearnCommand({ project, json: true, session: TEST_SESSION });
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));

    // Regressions must be sorted alphabetically
    const regressions = parsed.replay.regressions;
    expect(regressions.length).toBeGreaterThan(0);
    const sorted = [...regressions].sort();
    expect(regressions).toEqual(sorted);
  });

  // ---------------------------------------------------------------------------
  // No eligible rules: traces exist but none meet thresholds
  // ---------------------------------------------------------------------------

  test("traces with no eligible rules produce empty rules array", async () => {
    const project = trackDir(makeTempProject());

    // Only 2 traces — below default minSupport=5
    const traces = Array.from({ length: 2 }, (_, i) =>
      makeTrace({
        decisionId: `d${i}`,
        injectedSkills: ["next-config"],
        ranked: [makeRanked("next-config", { type: "path", value: "next.config.*" })],
      }),
    );
    writeTraceFixture(TEST_SESSION, traces);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ skill: "next-config", outcome: "win" }),
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const code = await runLearnCommand({ project, json: true, session: TEST_SESSION });
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }

    const parsed: LearnedRoutingRulesFile = JSON.parse(logs.join("\n"));

    // Rules may exist but none should be promoted (support < 5)
    const promoted = parsed.rules.filter((r) => r.confidence === "promote");
    expect(promoted).toEqual([]);
    expect(parsed.replay.regressions).toEqual([]);
  });
});
