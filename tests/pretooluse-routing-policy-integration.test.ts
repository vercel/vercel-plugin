import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  deduplicateSkills,
  type DeduplicateResult,
} from "../hooks/src/pretooluse-skill-inject.mts";
import {
  createEmptyRoutingPolicy,
  recordExposure,
  recordOutcome,
  type RoutingPolicyFile,
} from "../hooks/src/routing-policy.mts";
import {
  projectPolicyPath,
  sessionExposurePath,
  loadSessionExposures,
  saveProjectRoutingPolicy,
} from "../hooks/src/routing-policy-ledger.mts";
import type { CompiledSkillEntry } from "../hooks/src/patterns.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT = "/tmp/test-pretooluse-routing-policy-" + Date.now();
const TEST_SESSION = "test-session-ptrp-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";

function makeEntry(skill: string, priority: number): CompiledSkillEntry {
  return {
    skill,
    priority,
    compiledPaths: [],
    compiledBash: [],
    compiledImports: [],
  };
}

function cleanupPolicyFile(): void {
  const path = projectPolicyPath(TEST_PROJECT);
  try { unlinkSync(path); } catch {}
}

function cleanupExposureFile(): void {
  const path = sessionExposurePath(TEST_SESSION);
  try { unlinkSync(path); } catch {}
}

function buildPolicyWithHistory(
  skill: string,
  exposures: number,
  wins: number,
  directiveWins: number,
  staleMisses: number,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  const scenario = "PreToolUse|none|none|Bash";
  policy.scenarios[scenario] = {
    [skill]: {
      exposures,
      wins,
      directiveWins,
      staleMisses,
      lastUpdatedAt: T0,
    },
  };
  return policy;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  cleanupPolicyFile();
  cleanupExposureFile();
});

afterEach(() => {
  cleanupPolicyFile();
  cleanupExposureFile();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pretooluse routing-policy integration", () => {
  test("DeduplicateResult includes policyBoosted array", () => {
    const entries = [makeEntry("agent-browser-verify", 7), makeEntry("next-config", 6)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify", "next-config"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    expect(result).toHaveProperty("policyBoosted");
    expect(Array.isArray(result.policyBoosted)).toBe(true);
  });

  test("policyBoosted is empty when no policy file exists", () => {
    const entries = [makeEntry("agent-browser-verify", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    expect(result.policyBoosted).toEqual([]);
  });

  test("applies positive policy boost when skill has high success rate", () => {
    // 5 exposures, 4 wins, 3 directive wins => successRate = (4 + 3*0.25)/5 = 0.95 => +8 boost
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("agent-browser-verify", 7), makeEntry("next-config", 8)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify", "next-config"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    // agent-browser-verify should be boosted: 7 + 8 = 15 > next-config's 8
    expect(result.policyBoosted.length).toBe(1);
    expect(result.policyBoosted[0].skill).toBe("agent-browser-verify");
    expect(result.policyBoosted[0].boost).toBe(8);

    // Should be ranked first now despite lower base priority
    expect(result.rankedSkills[0]).toBe("agent-browser-verify");
  });

  test("applies negative policy boost for low success rate", () => {
    // 6 exposures, 0 wins => successRate = 0 < 0.15 => -2 boost
    const policy = buildPolicyWithHistory("low-success-skill", 6, 0, 0, 5);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("low-success-skill", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["low-success-skill"]),
      toolName: "Bash",
      toolInput: { command: "test" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    expect(result.policyBoosted.length).toBe(1);
    expect(result.policyBoosted[0].boost).toBe(-2);
  });

  test("no boost applied when exposures below threshold", () => {
    // 2 exposures, 2 wins => below min-sample threshold of 3
    const policy = buildPolicyWithHistory("new-skill", 2, 2, 0, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("new-skill", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["new-skill"]),
      toolName: "Bash",
      toolInput: { command: "test" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    expect(result.policyBoosted).toEqual([]);
  });

  test("policy boost does not mutate persisted policy file", () => {
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const before = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");

    deduplicateSkills({
      matchedEntries: [makeEntry("agent-browser-verify", 7)],
      matched: new Set(["agent-browser-verify"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    const after = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");
    expect(after).toBe(before);
  });

  test("deterministic ordering when policy scores tie", () => {
    // Both skills get no boost (no policy data) — ranking is by base priority then skill name
    const entries = [makeEntry("skill-b", 7), makeEntry("skill-a", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["skill-b", "skill-a"]),
      toolName: "Bash",
      toolInput: { command: "test" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    // skill-a should come first (alphabetical tiebreak)
    expect(result.rankedSkills).toEqual(["skill-a", "skill-b"]);
  });

  test("existing profiler and setup-mode boosts remain intact alongside policy boosts", () => {
    // Policy boosts agent-browser-verify, profiler boosts next-config
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("agent-browser-verify", 5), makeEntry("next-config", 5)];
    const likelySkills = new Set(["next-config"]);
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify", "next-config"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      likelySkills,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    // Both should be boosted
    expect(result.profilerBoosted).toContain("next-config");
    expect(result.policyBoosted.some((p) => p.skill === "agent-browser-verify")).toBe(true);

    // agent-browser-verify: 5 + 8 (policy) = 13
    // next-config: 5 + 5 (profiler) = 10
    expect(result.rankedSkills[0]).toBe("agent-browser-verify");
  });

  test("policyBoosted contains reason string with scenario stats", () => {
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 1);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("agent-browser-verify", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    expect(result.policyBoosted[0].reason).toContain("4 wins");
    expect(result.policyBoosted[0].reason).toContain("5 exposures");
    expect(result.policyBoosted[0].reason).toContain("3 directive wins");
    expect(result.policyBoosted[0].reason).toContain("1 stale miss");
  });

  test("no cwd means no policy boost is applied", () => {
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    const entries = [makeEntry("agent-browser-verify", 7)];
    const result = deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["agent-browser-verify"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      // no cwd
    });

    expect(result.policyBoosted).toEqual([]);
  });
});
