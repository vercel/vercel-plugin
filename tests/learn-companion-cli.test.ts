import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLearnCommand, learnedRulesPath, type LearnCommandOutput } from "../src/cli/learn.ts";
import { companionRulebookPath } from "../hooks/src/learned-companion-rulebook.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vercel-plugin-learn-companion-test-${Date.now()}`);

function setupTestProject(): string {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  mkdirSync(join(TEST_DIR, "generated"), { recursive: true });
  // Minimal skill for the learn command to find
  const skillDir = join(TEST_DIR, "skills", "test-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: test-skill",
      'description: "test"',
      "metadata:",
      "  priority: 6",
      "---",
      "# Test skill body",
    ].join("\n"),
  );
  return TEST_DIR;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupTestProject();
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  // Clean companion rulebook artifact
  try {
    rmSync(companionRulebookPath(TEST_DIR), { force: true });
  } catch {
    // ignore
  }
  // Clean learned rules artifact
  try {
    rmSync(learnedRulesPath(TEST_DIR), { force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// JSON output structure
// ---------------------------------------------------------------------------

describe("learn command companion JSON output", () => {
  test("returns JSON with rules, companions, and companionPath fields", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => logs.push(msg);
    console.error = () => {};

    try {
      const exitCode = await runLearnCommand({
        project: TEST_DIR,
        json: true,
      });

      expect(exitCode).toBe(0);
      expect(logs.length).toBeGreaterThan(0);

      const output: LearnCommandOutput = JSON.parse(logs.join(""));

      // Must have all three top-level fields
      expect(output).toHaveProperty("rules");
      expect(output).toHaveProperty("companions");
      expect(output).toHaveProperty("companionPath");

      // rules is the existing single-skill rulebook
      expect(output.rules).toHaveProperty("version");
      expect(output.rules).toHaveProperty("rules");
      expect(output.rules).toHaveProperty("replay");
      expect(output.rules).toHaveProperty("promotion");

      // companions is a companion rulebook
      expect(output.companions.version).toBe(1);
      expect(Array.isArray(output.companions.rules)).toBe(true);
      expect(output.companions).toHaveProperty("replay");
      expect(output.companions).toHaveProperty("promotion");

      // companionPath is deterministic
      expect(output.companionPath).toBe(companionRulebookPath(TEST_DIR));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("companions rulebook is empty when no traces exist", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => logs.push(msg);
    console.error = () => {};

    try {
      await runLearnCommand({ project: TEST_DIR, json: true });

      const output: LearnCommandOutput = JSON.parse(logs.join(""));
      expect(output.companions.rules).toEqual([]);
      expect(output.companions.promotion.accepted).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("companionPath is deterministic for same project root", async () => {
    const logs1: string[] = [];
    const logs2: string[] = [];
    const origLog = console.log;
    const origErr = console.error;

    try {
      console.log = (msg: string) => logs1.push(msg);
      console.error = () => {};
      await runLearnCommand({ project: TEST_DIR, json: true });

      console.log = (msg: string) => logs2.push(msg);
      await runLearnCommand({ project: TEST_DIR, json: true });

      const output1: LearnCommandOutput = JSON.parse(logs1.join(""));
      const output2: LearnCommandOutput = JSON.parse(logs2.join(""));

      expect(output1.companionPath).toBe(output2.companionPath);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

// ---------------------------------------------------------------------------
// Write mode
// ---------------------------------------------------------------------------

describe("learn command companion write mode", () => {
  test("persists companion rulebook to dedicated artifact path", async () => {
    const origLog = console.log;
    const origErr = console.error;
    const stderrLogs: string[] = [];
    console.log = () => {};
    console.error = (msg: string) => stderrLogs.push(msg);

    try {
      const exitCode = await runLearnCommand({
        project: TEST_DIR,
        write: true,
      });

      expect(exitCode).toBe(0);

      // Companion artifact should exist at its own path
      const cPath = companionRulebookPath(TEST_DIR);
      expect(existsSync(cPath)).toBe(true);

      // Single-skill artifact should also exist
      expect(existsSync(learnedRulesPath(TEST_DIR))).toBe(true);

      // Companion path should differ from single-skill path
      expect(cPath).not.toBe(learnedRulesPath(TEST_DIR));

      // Stderr should log companion write event
      const companionWriteLog = stderrLogs.find((l) => l.includes("learn_companion_written"));
      expect(companionWriteLog).toBeDefined();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("does not write companion artifact when write mode is disabled", async () => {
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      await runLearnCommand({ project: TEST_DIR, json: true });

      const cPath = companionRulebookPath(TEST_DIR);
      expect(existsSync(cPath)).toBe(false);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

describe("learn command companion text output", () => {
  test("includes companion rules summary in text mode", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => logs.push(msg);
    console.error = () => {};

    try {
      await runLearnCommand({ project: TEST_DIR });

      const text = logs.join("\n");
      expect(text).toContain("Companion rules: 0");
      expect(text).toContain("promoted: 0");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("text output is stable when no companion rules are promoted", async () => {
    const logs1: string[] = [];
    const logs2: string[] = [];
    const origLog = console.log;
    const origErr = console.error;

    try {
      console.log = (msg: string) => logs1.push(msg);
      console.error = () => {};
      await runLearnCommand({ project: TEST_DIR });

      console.log = (msg: string) => logs2.push(msg);
      await runLearnCommand({ project: TEST_DIR });

      // Exact match — output is deterministic
      expect(logs1.join("\n")).toBe(logs2.join("\n"));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});
