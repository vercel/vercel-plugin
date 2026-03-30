import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  deduplicateSkills,
  type DeduplicateResult,
} from "../hooks/src/pretooluse-skill-inject.mts";
import {
  readRoutingDecisionTrace,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";
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
import {
  statePath as verificationStatePath,
} from "../hooks/src/verification-ledger.mts";
import {
  saveRulebook,
  rulebookPath,
  createRule,
  createEmptyRulebook,
  type LearnedRoutingRulebook,
} from "../hooks/src/learned-routing-rulebook.mts";
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

function cleanupRulebookFile(): void {
  const path = rulebookPath(TEST_PROJECT);
  try { unlinkSync(path); } catch {}
}

/** Write a minimal mock verification plan state so loadCachedPlanResult returns a story. */
function writeMockPlanState(sessionId: string, story?: {
  id?: string;
  kind?: string;
  route?: string | null;
  updatedAt?: string;
}): void {
  const sp = verificationStatePath(sessionId);
  mkdirSync(join(sp, ".."), { recursive: true });
  const s = {
    id: story?.id ?? "test-story-1",
    kind: story?.kind ?? "deployment",
    route: story?.route ?? "/api/test",
    promptExcerpt: "test prompt",
    createdAt: T0,
    updatedAt: story?.updatedAt ?? T1,
    requestedSkills: [],
  };
  writeFileSync(sp, JSON.stringify({
    version: 1,
    stories: [s],
    observationIds: [],
    satisfiedBoundaries: [],
    missingBoundaries: ["clientRequest"],
    recentRoutes: [],
    primaryNextAction: { targetBoundary: "clientRequest", suggestedAction: "curl test" },
    blockedReasons: [],
  }));
}

function cleanupMockPlanState(sessionId: string): void {
  const sp = verificationStatePath(sessionId);
  try { rmSync(join(sp, ".."), { recursive: true, force: true }); } catch {}
}

function buildPolicyWithHistory(
  skill: string,
  exposures: number,
  wins: number,
  directiveWins: number,
  staleMisses: number,
  scenarioKey?: string,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  const scenario = scenarioKey ?? "PreToolUse|deployment|clientRequest|Bash";
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
  cleanupRulebookFile();
  writeMockPlanState(TEST_SESSION);
});

afterEach(() => {
  cleanupPolicyFile();
  cleanupExposureFile();
  cleanupRulebookFile();
  cleanupMockPlanState(TEST_SESSION);
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

  test("no policy boost when session has no active verification story", () => {
    // Remove mock plan state so no story is found
    cleanupMockPlanState(TEST_SESSION);

    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0, "PreToolUse|none|none|Bash");
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

    // No boosts — story gate prevents policy application
    expect(result.policyBoosted).toEqual([]);
  });

  test("does not create none|none scenario keys for exposures", () => {
    // Remove mock plan state so no story is found
    cleanupMockPlanState(TEST_SESSION);

    const entries = [makeEntry("next-config", 7)];
    deduplicateSkills({
      matchedEntries: entries,
      matched: new Set(["next-config"]),
      toolName: "Bash",
      toolInput: { command: "next dev" },
      injectedSkills: new Set(),
      dedupOff: false,
      cwd: TEST_PROJECT,
      sessionId: TEST_SESSION,
    });

    // No exposures should be recorded when no story exists
    const exposures = loadSessionExposures(TEST_SESSION);
    const noneNone = exposures.filter(
      (e) => e.storyId === null && e.storyKind === null,
    );
    expect(noneNone).toEqual([]);
  });

  test("uses selectPrimaryStory for deterministic story attribution", () => {
    // Write plan state with two stories, the second one more recently updated
    const sp = verificationStatePath(TEST_SESSION);
    mkdirSync(join(sp, ".."), { recursive: true });
    writeFileSync(sp, JSON.stringify({
      version: 1,
      stories: [
        {
          id: "story-older",
          kind: "deployment",
          route: "/api/old",
          promptExcerpt: "old",
          createdAt: T0,
          updatedAt: T1,
          requestedSkills: [],
        },
        {
          id: "story-newer",
          kind: "feature-investigation",
          route: "/settings",
          promptExcerpt: "new",
          createdAt: T2,
          updatedAt: T3,
          requestedSkills: [],
        },
      ],
      observationIds: [],
      satisfiedBoundaries: [],
      missingBoundaries: ["clientRequest"],
      recentRoutes: [],
      primaryNextAction: { targetBoundary: "clientRequest", suggestedAction: "curl test" },
      blockedReasons: [],
    }));

    // Build policy matching the newer story's kind
    const policy = buildPolicyWithHistory(
      "agent-browser-verify", 5, 4, 3, 0,
      "PreToolUse|feature-investigation|clientRequest|Bash",
    );
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

    // selectPrimaryStory should pick story-newer (most recently updated)
    // and match the "feature-investigation" scenario key
    expect(result.policyBoosted.length).toBe(1);
    expect(result.policyBoosted[0].skill).toBe("agent-browser-verify");
    expect(result.policyBoosted[0].boost).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Routing decision trace integration tests (PreToolUse)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");

/** Run PreToolUse hook as subprocess */
async function runPreToolUseHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  env?: Record<string, string>,
  sessionId?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const sid = sessionId ?? `trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sid,
    cwd: ROOT,
  });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_SEEN_SKILLS: "",
      VERCEL_PLUGIN_LOG_LEVEL: "summary",
      ...env,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("pretooluse routing decision trace", () => {
  let traceSession: string;

  beforeEach(() => {
    traceSession = `trace-ptu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try { rmSync(traceDir(traceSession), { recursive: true, force: true }); } catch {}
    cleanupMockPlanState(traceSession);
  });

  test("emits exactly one trace per ranking/injection attempt", async () => {
    const { code } = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].hook).toBe("PreToolUse");
    expect(traces[0].version).toBe(2);
    expect(traces[0].toolName).toBe("Bash");
    expect(traces[0].sessionId).toBe(traceSession);
    expect(traces[0].decisionId).toMatch(/^[0-9a-f]{16}$/);
    expect(Array.isArray(traces[0].matchedSkills)).toBe(true);
    expect(Array.isArray(traces[0].injectedSkills)).toBe(true);
    expect(Array.isArray(traces[0].ranked)).toBe(true);
  });

  test("records no_active_verification_story when no story exists", async () => {
    const { code } = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].skippedReasons).toContain("no_active_verification_story");
    expect(traces[0].policyScenario).toBeNull();
  });

  test("records primaryStory and policyScenario when verification story exists", async () => {
    writeMockPlanState(traceSession, {
      id: "trace-story-1",
      kind: "deployment",
      route: "/api/test",
    });

    const { code } = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].primaryStory.id).toBe("trace-story-1");
    expect(traces[0].primaryStory.kind).toBe("deployment");
    expect(traces[0].policyScenario).toMatch(/^PreToolUse\|deployment\|/);
    expect(traces[0].skippedReasons).not.toContain("no_active_verification_story");
  });

  test("does not emit synthetic none|none policyScenario without story", async () => {
    const { code } = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].policyScenario).toBeNull();
  });

  test("ranked entries include droppedReason for cap/budget drops", async () => {
    const { code } = await runPreToolUseHook(
      "Read",
      { file_path: "next.config.mjs" },
      {
        VERCEL_PLUGIN_INJECTION_BUDGET: "500",
      },
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);

    for (const reason of traces[0].skippedReasons) {
      if (reason.startsWith("cap_exceeded:")) {
        const skill = reason.replace("cap_exceeded:", "");
        const ranked = traces[0].ranked.find((r) => r.skill === skill);
        if (ranked) {
          expect(ranked.droppedReason).toBe("cap_exceeded");
        }
      }
      if (reason.startsWith("budget_exhausted:")) {
        const skill = reason.replace("budget_exhausted:", "");
        const ranked = traces[0].ranked.find((r) => r.skill === skill);
        if (ranked) {
          expect(ranked.droppedReason).toBe("budget_exhausted");
        }
      }
    }
  });

  test("emits routing.decision_trace_written summary log", async () => {
    const { code, stderr } = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      { VERCEL_PLUGIN_LOG_LEVEL: "summary" },
      traceSession,
    );
    expect(code).toBe(0);

    const logLines = stderr
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o): o is Record<string, unknown> => o !== null);

    const traceLog = logLines.find(
      (l) => l.event === "routing.decision_trace_written",
    );
    expect(traceLog).toBeDefined();
    expect(traceLog!.hook).toBe("PreToolUse");
    expect(traceLog!.decisionId).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Manifest parity: manifest vs live-scan produce identical routing decisions
// ---------------------------------------------------------------------------

const MANIFEST_PATH = join(ROOT, "generated", "skill-manifest.json");

/**
 * Parse skillInjection metadata from hook stdout JSON.
 * Returns a normalized comparison object suitable for deep equality.
 */
function parseSkillInjection(stdout: string): {
  matchedSkills: string[];
  injectedSkills: string[];
  reasons: Record<string, { pattern: string; matchType: string }>;
} | null {
  try {
    const output = JSON.parse(stdout);
    const ctx = output.hookSpecificOutput?.additionalContext || "";
    const siMatch = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
    if (!siMatch) return null;
    const si = JSON.parse(siMatch[1]);
    return {
      matchedSkills: [...(si.matchedSkills ?? [])].sort(),
      injectedSkills: [...(si.injectedSkills ?? [])].sort(),
      reasons: si.reasons ?? {},
    };
  } catch {
    return null;
  }
}

describe("manifest vs live-scan parity", () => {
  const paritySession = () =>
    `parity-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  test("identical matched/injected skills and reasons for a Bash next-dev input", async () => {
    const { renameSync } = await import("node:fs");
    const backupPath = MANIFEST_PATH + ".bak";

    // 1. Run with manifest
    const sid1 = paritySession();
    const withManifest = await runPreToolUseHook(
      "Bash",
      { command: "npx next dev" },
      { VERCEL_PLUGIN_LOG_LEVEL: "off" },
      sid1,
    );
    expect(withManifest.code).toBe(0);
    const manifestResult = parseSkillInjection(withManifest.stdout);
    expect(manifestResult).not.toBeNull();

    // 2. Run without manifest (live scan)
    renameSync(MANIFEST_PATH, backupPath);
    try {
      const sid2 = paritySession();
      const withoutManifest = await runPreToolUseHook(
        "Bash",
        { command: "npx next dev" },
        { VERCEL_PLUGIN_LOG_LEVEL: "off" },
        sid2,
      );
      expect(withoutManifest.code).toBe(0);
      const liveScanResult = parseSkillInjection(withoutManifest.stdout);
      expect(liveScanResult).not.toBeNull();

      // 3. Assert parity — matched skills, injected skills, and match reasons
      const comparison = {
        manifest: {
          matchedSkills: manifestResult!.matchedSkills,
          injectedSkills: manifestResult!.injectedSkills,
          reasons: normalizeReasons(manifestResult!.reasons),
        },
        liveScan: {
          matchedSkills: liveScanResult!.matchedSkills,
          injectedSkills: liveScanResult!.injectedSkills,
          reasons: normalizeReasons(liveScanResult!.reasons),
        },
      };

      // Emit normalized comparison JSON for agent observability
      console.error(JSON.stringify({
        event: "parity.comparison",
        tool: "Bash",
        input: "npx next dev",
        ...comparison,
      }));

      expect(comparison.manifest.matchedSkills).toEqual(comparison.liveScan.matchedSkills);
      expect(comparison.manifest.injectedSkills).toEqual(comparison.liveScan.injectedSkills);
      expect(comparison.manifest.reasons).toEqual(comparison.liveScan.reasons);
    } finally {
      renameSync(backupPath, MANIFEST_PATH);
    }

    // Cleanup trace dirs
    try { rmSync(traceDir(sid1), { recursive: true, force: true }); } catch {}
  });

  test("identical matched/injected skills for a Read next.config input", async () => {
    const { renameSync } = await import("node:fs");
    const backupPath = MANIFEST_PATH + ".bak";

    const sid1 = paritySession();
    const withManifest = await runPreToolUseHook(
      "Read",
      { file_path: "next.config.ts" },
      { VERCEL_PLUGIN_LOG_LEVEL: "off" },
      sid1,
    );
    expect(withManifest.code).toBe(0);
    const manifestResult = parseSkillInjection(withManifest.stdout);
    expect(manifestResult).not.toBeNull();

    renameSync(MANIFEST_PATH, backupPath);
    try {
      const sid2 = paritySession();
      const withoutManifest = await runPreToolUseHook(
        "Read",
        { file_path: "next.config.ts" },
        { VERCEL_PLUGIN_LOG_LEVEL: "off" },
        sid2,
      );
      expect(withoutManifest.code).toBe(0);
      const liveScanResult = parseSkillInjection(withoutManifest.stdout);
      expect(liveScanResult).not.toBeNull();

      const comparison = {
        manifest: {
          matchedSkills: manifestResult!.matchedSkills,
          injectedSkills: manifestResult!.injectedSkills,
        },
        liveScan: {
          matchedSkills: liveScanResult!.matchedSkills,
          injectedSkills: liveScanResult!.injectedSkills,
        },
      };

      console.error(JSON.stringify({
        event: "parity.comparison",
        tool: "Read",
        input: "next.config.ts",
        ...comparison,
      }));

      expect(comparison.manifest.matchedSkills).toEqual(comparison.liveScan.matchedSkills);
      expect(comparison.manifest.injectedSkills).toEqual(comparison.liveScan.injectedSkills);
    } finally {
      renameSync(backupPath, MANIFEST_PATH);
    }

    try { rmSync(traceDir(sid1), { recursive: true, force: true }); } catch {}
  });
});

// ---------------------------------------------------------------------------
// Learned-routing-rulebook precedence tests
// ---------------------------------------------------------------------------

describe("pretooluse rulebook precedence", () => {
  function makeRulebook(rules: Array<{
    scenario: string;
    skill: string;
    boost: number;
    action?: "promote" | "demote";
    reason?: string;
  }>): LearnedRoutingRulebook {
    const rb = createEmptyRulebook("test-sess", T0);
    for (const r of rules) {
      rb.rules.push(createRule({
        scenario: r.scenario,
        skill: r.skill,
        action: r.action ?? "promote",
        boost: r.boost,
        confidence: 0.9,
        reason: r.reason ?? "replay verified: no regressions",
        sourceSessionId: "test-sess",
        promotedAt: T0,
        evidence: {
          baselineWins: 4,
          baselineDirectiveWins: 2,
          learnedWins: 4,
          learnedDirectiveWins: 2,
          regressionCount: 0,
        },
      }));
    }
    return rb;
  }

  test("DeduplicateResult includes rulebookBoosted array", () => {
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

    expect(result).toHaveProperty("rulebookBoosted");
    expect(Array.isArray(result.rulebookBoosted)).toBe(true);
  });

  test("rulebookBoosted is empty when no rulebook exists", () => {
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

    expect(result.rulebookBoosted).toEqual([]);
  });

  test("rulebook boost takes precedence over stats-policy boost", () => {
    // Set up stats-policy that would give +8
    const policy = buildPolicyWithHistory("agent-browser-verify", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Set up rulebook that gives +10
    const rulebook = makeRulebook([{
      scenario: "PreToolUse|deployment|clientRequest|Bash",
      skill: "agent-browser-verify",
      boost: 10,
    }]);
    saveRulebook(TEST_PROJECT, rulebook);

    const entries = [makeEntry("agent-browser-verify", 5), makeEntry("next-config", 8)];
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

    // Rulebook match should be present
    expect(result.rulebookBoosted.length).toBe(1);
    expect(result.rulebookBoosted[0].skill).toBe("agent-browser-verify");
    expect(result.rulebookBoosted[0].ruleBoost).toBe(10);
    expect(result.rulebookBoosted[0].matchedRuleId).toBe(
      "PreToolUse|deployment|clientRequest|Bash|agent-browser-verify",
    );

    // Stats-policy should be suppressed for that skill (not double-boosted)
    expect(result.policyBoosted.find((p) => p.skill === "agent-browser-verify")).toBeUndefined();

    // Effective priority: 5 (base) + 10 (rule) = 15 > next-config's 8
    expect(result.rankedSkills[0]).toBe("agent-browser-verify");
  });

  test("stats-policy boost still applies for skills without rulebook match", () => {
    // Stats-policy for next-config: +8
    const policy = buildPolicyWithHistory("next-config", 5, 4, 3, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);

    // Rulebook only has a rule for agent-browser-verify
    const rulebook = makeRulebook([{
      scenario: "PreToolUse|deployment|clientRequest|Bash",
      skill: "agent-browser-verify",
      boost: 3,
    }]);
    saveRulebook(TEST_PROJECT, rulebook);

    const entries = [makeEntry("agent-browser-verify", 5), makeEntry("next-config", 5)];
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

    // next-config should still get stats-policy boost (+8)
    expect(result.policyBoosted.find((p) => p.skill === "next-config")?.boost).toBe(8);
    // next-config: 5 + 8 = 13 > agent-browser-verify: 5 + 3 = 8
    expect(result.rankedSkills[0]).toBe("next-config");
  });

  test("route-scoped rule only affects its intended scenario", () => {
    // Rulebook rule scoped to deployment|clientRequest
    const rulebook = makeRulebook([{
      scenario: "PreToolUse|deployment|clientRequest|Bash",
      skill: "agent-browser-verify",
      boost: 10,
    }]);
    saveRulebook(TEST_PROJECT, rulebook);

    // Test with a different story kind (uiRender boundary)
    cleanupMockPlanState(TEST_SESSION);
    writeMockPlanState(TEST_SESSION, { kind: "feature" });

    const entries = [makeEntry("agent-browser-verify", 5), makeEntry("next-config", 5)];
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

    // No rulebook match — the rule is for deployment|clientRequest, not feature|clientRequest
    expect(result.rulebookBoosted).toEqual([]);
  });

  test("empty rulebook has no effect", () => {
    const rulebook = createEmptyRulebook("test-sess", T0);
    saveRulebook(TEST_PROJECT, rulebook);

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

    expect(result.rulebookBoosted).toEqual([]);
  });
});

/** Sort reason keys for deterministic comparison */
function normalizeReasons(
  reasons: Record<string, { pattern: string; matchType: string }>,
): Record<string, { pattern: string; matchType: string }> {
  const sorted: Record<string, { pattern: string; matchType: string }> = {};
  for (const key of Object.keys(reasons).sort()) {
    sorted[key] = reasons[key];
  }
  return sorted;
}
