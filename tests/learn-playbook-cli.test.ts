import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLearnCommand, type LearnCommandOutput } from "../src/cli/learn.ts";
import { playbookRulebookPath } from "../hooks/src/learned-playbook-rulebook.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = "2026-03-28T06:00:00.000Z";
const TEST_SESSION = "test-learn-playbook-cli";
let tempProjectCounter = 0;

function makeTempProject(): string {
  tempProjectCounter += 1;
  const dir = join(
    tmpdir(),
    `vercel-plugin-learn-playbook-test-${Date.now()}-${tempProjectCounter}`,
  );
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
    toolName: "Bash",
    toolTarget: "npm test",
    timestamp: FIXED_TS,
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/settings",
      targetBoundary: "clientRequest",
    },
    observedRoute: "/settings",
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
    storyKind: "flow-verification",
    route: "/settings",
    hook: "PreToolUse",
    toolName: "Bash",
    targetBoundary: "clientRequest",
    exposureGroupId: null,
    attributionRole: "candidate",
    candidateSkill: "verification",
    createdAt: FIXED_TS,
    resolvedAt: FIXED_TS,
    outcome: "win",
    skill: "verification",
    ...overrides,
  };
}

/** Capture stdout from runLearnCommand. */
async function captureJsonOutput(options: Parameters<typeof runLearnCommand>[0]): Promise<LearnCommandOutput> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runLearnCommand({ ...options, json: true });
  } finally {
    console.log = origLog;
  }
  return JSON.parse(logs.join("\n"));
}

/** Capture human-readable stdout from runLearnCommand. */
async function captureTextOutput(options: Parameters<typeof runLearnCommand>[0]): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runLearnCommand(options);
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

// ---------------------------------------------------------------------------
// Cleanup
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
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  try { rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-trace`), { recursive: true, force: true }); } catch {}
  try { rmSync(join(tmpdir(), `vercel-plugin-${TEST_SESSION}-routing-exposures.jsonl`), { force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Tests: --json output includes playbooks
// ---------------------------------------------------------------------------

describe("learn --json playbook fields", () => {
  test("no-trace path includes empty playbooks and playbookPath", async () => {
    const project = trackDir(makeTempProject());
    const output = await captureJsonOutput({ project, session: TEST_SESSION });

    expect(output.playbooks).toBeDefined();
    expect(output.playbooks.version).toBe(1);
    expect(output.playbooks.rules).toEqual([]);
    expect(output.playbookPath).toBe(playbookRulebookPath(project));
  });

  test("normal distillation path includes playbooks and playbookPath", async () => {
    const project = trackDir(makeTempProject());

    // Need at least one trace so we enter the normal distillation branch
    writeTraceFixture(TEST_SESSION, [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["verification"],
        ranked: [{
          skill: "verification",
          basePriority: 6,
          effectivePriority: 6,
          pattern: { type: "bash", value: "npm test" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        }],
      }),
    ]);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ skill: "verification", outcome: "win" }),
    ]);

    const output = await captureJsonOutput({ project, session: TEST_SESSION });

    expect(output.playbooks).toBeDefined();
    expect(output.playbooks.version).toBe(1);
    expect(output.playbooks.projectRoot).toBe(project);
    expect(Array.isArray(output.playbooks.rules)).toBe(true);
    expect(output.playbookPath).toBe(playbookRulebookPath(project));
  });

  test("playbook rulebook is versioned in JSON output", async () => {
    const project = trackDir(makeTempProject());
    const output = await captureJsonOutput({ project, session: TEST_SESSION });

    expect(output.playbooks.version).toBe(1);
    expect(typeof output.playbooks.generatedAt).toBe("string");
    expect(output.playbooks.promotion).toBeDefined();
    expect(output.playbooks.replay).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: --write persists playbook artifact
// ---------------------------------------------------------------------------

describe("learn --write playbook persistence", () => {
  test("--write persists generated/learned-playbooks.json (no traces)", async () => {
    const project = trackDir(makeTempProject());
    const code = await runLearnCommand({ project, write: true, session: TEST_SESSION });
    expect(code).toBe(0);

    const path = playbookRulebookPath(project);
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.rules).toEqual([]);
  });

  test("--write persists generated/learned-playbooks.json (with traces)", async () => {
    const project = trackDir(makeTempProject());

    writeTraceFixture(TEST_SESSION, [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["verification"],
        ranked: [{
          skill: "verification",
          basePriority: 6,
          effectivePriority: 6,
          pattern: { type: "bash", value: "npm test" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        }],
      }),
    ]);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ skill: "verification", outcome: "win" }),
    ]);

    const code = await runLearnCommand({ project, write: true, session: TEST_SESSION });
    expect(code).toBe(0);

    const path = playbookRulebookPath(project);
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.projectRoot).toBe(project);
  });

  test("--write emits playbook write event to stderr", async () => {
    const project = trackDir(makeTempProject());
    const stderrLogs: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => stderrLogs.push(msg);
    try {
      await runLearnCommand({ project, write: true, session: TEST_SESSION });
    } finally {
      console.error = origError;
    }

    const playbookEvent = stderrLogs.find((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.event === "learn_playbooks_written";
      } catch {
        return false;
      }
    });
    expect(playbookEvent).toBeDefined();

    const parsed = JSON.parse(playbookEvent!);
    expect(parsed.path).toBe(playbookRulebookPath(project));
  });

  test("dry-run does NOT create playbook artifact", async () => {
    const project = trackDir(makeTempProject());
    await runLearnCommand({ project, json: true, session: TEST_SESSION });
    expect(existsSync(playbookRulebookPath(project))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: human-readable output includes playbook lines
// ---------------------------------------------------------------------------

describe("learn human-readable playbook output", () => {
  test("no-trace output includes Playbooks: 0", async () => {
    const project = trackDir(makeTempProject());
    const text = await captureTextOutput({ project, session: TEST_SESSION });
    expect(text).toContain("Playbooks: 0");
    expect(text).toContain("promoted: 0");
  });

  test("normal path output includes Playbooks line", async () => {
    const project = trackDir(makeTempProject());

    writeTraceFixture(TEST_SESSION, [
      makeTrace({
        decisionId: "d1",
        injectedSkills: ["verification"],
        ranked: [{
          skill: "verification",
          basePriority: 6,
          effectivePriority: 6,
          pattern: { type: "bash", value: "npm test" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        }],
      }),
    ]);
    writeExposureFixture(TEST_SESSION, [
      makeExposure({ skill: "verification", outcome: "win" }),
    ]);

    const text = await captureTextOutput({ project, session: TEST_SESSION });
    expect(text).toContain("Playbooks:");
  });
});

// ---------------------------------------------------------------------------
// Tests: playbookPath is deterministic
// ---------------------------------------------------------------------------

describe("playbookPath determinism", () => {
  test("playbookPath is deterministic across runs", async () => {
    const project = trackDir(makeTempProject());
    const output1 = await captureJsonOutput({ project, session: TEST_SESSION });
    const output2 = await captureJsonOutput({ project, session: TEST_SESSION });
    expect(output1.playbookPath).toBe(output2.playbookPath);
    expect(output1.playbookPath).toBe(join(project, "generated", "learned-playbooks.json"));
  });
});
