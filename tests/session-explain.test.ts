import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendRoutingDecisionTrace,
  traceDir,
  type RoutingDecisionTrace,
} from "../hooks/src/routing-decision-trace.mts";
import {
  runSessionExplain,
  type SessionExplainResult,
} from "../src/commands/session-explain.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..");
const TEST_SESSION = "test-session-explain-" + Date.now();

function makeTrace(
  overrides: Partial<RoutingDecisionTrace> = {},
): RoutingDecisionTrace {
  return {
    version: 2,
    decisionId: "deadbeef01234567",
    sessionId: TEST_SESSION,
    hook: "PreToolUse",
    toolName: "Bash",
    toolTarget: "npm run dev",
    timestamp: "2026-03-27T08:00:00.000Z",
    primaryStory: {
      id: "story-1",
      kind: "flow-verification",
      storyRoute: "/settings",
      targetBoundary: "uiRender",
    },
    observedRoute: null,
    policyScenario: "PreToolUse|flow-verification|uiRender|Bash",
    matchedSkills: ["agent-browser-verify"],
    injectedSkills: ["agent-browser-verify"],
    skippedReasons: [],
    ranked: [
      {
        skill: "agent-browser-verify",
        basePriority: 7,
        effectivePriority: 15,
        pattern: { type: "bashPattern", value: "dev server" },
        profilerBoost: 0,
        policyBoost: 8,
        policyReason: "4/5 wins",
        summaryOnly: false,
        synthetic: false,
        droppedReason: null,
      },
    ],
    verification: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Core JSON contract tests
// ---------------------------------------------------------------------------

describe("session-explain JSON mode", () => {
  test("reports excluded test-only skills instead of treating them as parity failures", () => {
    // The project root has skills/ including fake-banned-test-skill.
    // session-explain should report it as excluded, not as a parity failure.
    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.manifest.excludedSkills).toEqual(
      expect.arrayContaining([
        { slug: "fake-banned-test-skill", reason: "test-only-pattern" },
      ]),
    );
    // Excluded skills should NOT appear as parity drift
    expect(result.manifest.parity.ok).toBe(true);
    expect(result.manifest.parity.missingFromManifest).not.toContain("fake-banned-test-skill");
  });

  test("includes latest routing decision id and hook when traces exist", () => {
    const trace = makeTrace();
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.routing.decisionCount).toBe(1);
    expect(result.routing.latestDecisionId).toBe("deadbeef01234567");
    expect(result.routing.latestHook).toBe("PreToolUse");
    expect(result.routing.latestPolicyScenario).toBe(
      "PreToolUse|flow-verification|uiRender|Bash",
    );
  });

  test("includes verification directive env when a plan has a primaryNextAction", () => {
    // Without an active session with stories, env should contain clearing values
    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    // Verification env always present with the four canonical keys
    expect(result.verification.env).toHaveProperty("VERCEL_PLUGIN_VERIFICATION_STORY_ID");
    expect(result.verification.env).toHaveProperty("VERCEL_PLUGIN_VERIFICATION_ROUTE");
    expect(result.verification.env).toHaveProperty("VERCEL_PLUGIN_VERIFICATION_BOUNDARY");
    expect(result.verification.env).toHaveProperty("VERCEL_PLUGIN_VERIFICATION_ACTION");
  });

  test("returns actionable warning when manifest is missing", () => {
    // Use a temp dir with skills/ but no generated/skill-manifest.json
    const tempRoot = join(tmpdir(), `session-explain-test-${Date.now()}`);
    const tempSkills = join(tempRoot, "skills", "dummy-skill");
    mkdirSync(tempSkills, { recursive: true });
    writeFileSync(
      join(tempSkills, "SKILL.md"),
      `---
name: dummy-skill
description: test
metadata:
  priority: 5
---
# Dummy
`,
    );

    try {
      const output = runSessionExplain(null, tempRoot, true);
      const result: SessionExplainResult = JSON.parse(output);

      expect(result.diagnosis.some((d) => d.code === "MANIFEST_MISSING")).toBe(true);
      const diag = result.diagnosis.find((d) => d.code === "MANIFEST_MISSING")!;
      expect(diag.severity).toBe("warning");
      expect(diag.hint).toContain("build:manifest");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("returns actionable error when manifest is malformed", () => {
    const tempRoot = join(tmpdir(), `session-explain-bad-manifest-${Date.now()}`);
    const generatedDir = join(tempRoot, "generated");
    const tempSkills = join(tempRoot, "skills", "dummy-skill");
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(tempSkills, { recursive: true });
    writeFileSync(join(generatedDir, "skill-manifest.json"), "{ not-json");
    writeFileSync(
      join(tempSkills, "SKILL.md"),
      `---
name: dummy-skill
description: test
metadata:
  priority: 5
---
# Dummy
`,
    );

    try {
      const output = runSessionExplain(null, tempRoot, true);
      const result: SessionExplainResult = JSON.parse(output);

      expect(result.diagnosis.some((d) => d.code === "MANIFEST_PARSE_FAILED")).toBe(true);
      const diag = result.diagnosis.find((d) => d.code === "MANIFEST_PARSE_FAILED")!;
      expect(diag.severity).toBe("error");
      expect(diag.hint).toContain("build:manifest");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not surface fake-banned-test-skill as a live runtime candidate", () => {
    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    // The skill count should not include excluded skills
    const manifestSkillNames = Object.keys(
      JSON.parse(
        require("node:fs").readFileSync(
          join(ROOT, "generated", "skill-manifest.json"),
          "utf-8",
        ),
      ).skills,
    );
    expect(manifestSkillNames).not.toContain("fake-banned-test-skill");

    // Parity should be ok (excluded skill doesn't cause drift)
    expect(result.manifest.parity.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

describe("session-explain text mode", () => {
  test("prints session id, manifest count, routing traces, and verification status", () => {
    const output = runSessionExplain(TEST_SESSION, ROOT, false);

    expect(output).toContain(`Session: ${TEST_SESSION}`);
    expect(output).toContain("Manifest:");
    expect(output).toContain("skills");
    expect(output).toContain("Routing traces:");
    expect(output).toContain("Verification stories:");
  });

  test("includes excluded skills in text output", () => {
    const output = runSessionExplain(TEST_SESSION, ROOT, false);

    expect(output).toContain("Excluded:");
    expect(output).toContain("fake-banned-test-skill");
  });
});

// ---------------------------------------------------------------------------
// Exposure aggregation
// ---------------------------------------------------------------------------

describe("session-explain exposure aggregation", () => {
  test("reports zero exposures for unknown session", () => {
    const output = runSessionExplain("nonexistent-session-" + Date.now(), ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.exposures.pending).toBe(0);
    expect(result.exposures.wins).toBe(0);
    expect(result.exposures.directiveWins).toBe(0);
    expect(result.exposures.staleMisses).toBe(0);
    expect(result.exposures.candidateWins).toBe(0);
    expect(result.exposures.contextWins).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manifest exclusion drift diagnosis
// ---------------------------------------------------------------------------

describe("session-explain manifest exclusion drift", () => {
  test("emits MANIFEST_EXCLUSION_DRIFT when live exclusions exist but manifest has none", () => {
    // Create a temp root with an excluded skill but a manifest with excludedSkills: []
    const tempRoot = join(tmpdir(), `session-explain-drift-${Date.now()}`);
    const generatedDir = join(tempRoot, "generated");
    const tempSkills = join(tempRoot, "skills", "fake-drift-skill");
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(tempSkills, { recursive: true });
    writeFileSync(
      join(generatedDir, "skill-manifest.json"),
      JSON.stringify({
        generatedAt: "2026-03-28T00:00:00.000Z",
        version: 2,
        excludedSkills: [],
        skills: {},
      }),
    );
    writeFileSync(
      join(tempSkills, "SKILL.md"),
      `---
name: fake-drift-skill
description: "Fixture that triggers exclusion drift"
metadata:
  priority: 1
---
# Fake Drift Skill
`,
    );

    try {
      const output = runSessionExplain(null, tempRoot, true);
      const result: SessionExplainResult = JSON.parse(output);

      const drift = result.diagnosis.find(
        (d) => d.code === "MANIFEST_EXCLUSION_DRIFT",
      );
      expect(drift).toBeDefined();
      expect(drift!.severity).toBe("error");
      expect(drift!.hint).toContain("build:manifest");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does NOT emit MANIFEST_EXCLUSION_DRIFT when manifest exclusions are in sync", () => {
    // Use the real project root — manifest should be in sync after rebuild
    const output = runSessionExplain(null, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    const drift = result.diagnosis.find(
      (d) => d.code === "MANIFEST_EXCLUSION_DRIFT",
    );
    expect(drift).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Null session
// ---------------------------------------------------------------------------

describe("session-explain null session", () => {
  test("returns valid result with null sessionId", () => {
    const output = runSessionExplain(null, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(result.verification.hasStories).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing doctor contract
// ---------------------------------------------------------------------------

describe("session-explain doctor contract", () => {
  afterEach(() => {
    try {
      rmSync(traceDir(TEST_SESSION), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test(".doctor exists and contains expected structure when a trace is present", () => {
    const trace = makeTrace();
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    expect(result.doctor!.latestDecisionId).toBe("deadbeef01234567");
    expect(result.doctor!.latestScenario).toBe("PreToolUse|flow-verification|uiRender|Bash");
    expect(result.doctor!.latestRanked).toBeArray();
    expect(result.doctor!.latestRanked.length).toBeGreaterThan(0);
    expect(result.doctor!.latestRanked[0].skill).toBe("agent-browser-verify");
    expect(result.doctor!.hints).toBeArray();
  });

  test(".doctor.policyRecall.checkedScenarios is an array when scenario has targetBoundary", () => {
    // Construct a trace with a 5-part policy scenario (includes route scope)
    const trace = makeTrace({
      policyScenario: "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      primaryStory: {
        id: "story-1",
        kind: "flow-verification",
        storyRoute: "/settings",
        targetBoundary: "clientRequest",
      },
    });
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    expect(result.doctor!.policyRecall).not.toBeNull();
    expect(result.doctor!.policyRecall!.checkedScenarios).toBeArray();
    // checkedScenarios should contain at least the exact route key
    expect(result.doctor!.policyRecall!.checkedScenarios.length).toBeGreaterThan(0);
    for (const bucket of result.doctor!.policyRecall!.checkedScenarios) {
      expect(bucket).toHaveProperty("scenario");
      expect(bucket).toHaveProperty("skillCount");
      expect(bucket).toHaveProperty("qualifiedCount");
      expect(bucket).toHaveProperty("selected");
    }
  });

  test(".doctor.hints[].action is machine-readable when present", () => {
    // With no routing policy history and a valid scenario, we should get a NO_HISTORY hint
    const trace = makeTrace({
      policyScenario: "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      primaryStory: {
        id: "story-1",
        kind: "flow-verification",
        storyRoute: "/settings",
        targetBoundary: "clientRequest",
      },
    });
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    // Every hint with an action must have a machine-readable action.type
    for (const hint of result.doctor!.hints) {
      expect(hint).toHaveProperty("severity");
      expect(hint).toHaveProperty("code");
      expect(hint).toHaveProperty("message");
      if (hint.action) {
        expect(typeof hint.action.type).toBe("string");
        expect(hint.action.type.length).toBeGreaterThan(0);
      }
    }
  });

  test(".doctor.companionRecall detects verified-companion synthetic entries", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: { type: "bashPattern", value: "dev server" },
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: { type: "verified-companion", value: "scenario-companion-rulebook" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
    });
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    expect(result.doctor!.companionRecall.detected).toBe(true);
    expect(result.doctor!.companionRecall.entries).toHaveLength(1);

    const entry = result.doctor!.companionRecall.entries[0];
    expect(entry.companionSkill).toBe("verification");
    expect(entry.candidateSkill).toBe("agent-browser-verify");
    expect(entry.patternType).toBe("verified-companion");
    expect(entry.patternValue).toBe("scenario-companion-rulebook");
    expect(entry.synthetic).toBe(true);
    expect(entry.droppedReason).toBeNull();
  });

  test(".doctor.companionRecall.detected is false when no companion entries exist", () => {
    const trace = makeTrace(); // default trace has no companion entries
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    expect(result.doctor!.companionRecall.detected).toBe(false);
    expect(result.doctor!.companionRecall.entries).toHaveLength(0);
  });

  test(".doctor emits COMPANION_RECALL_NOT_SYNTHETIC hint for non-synthetic companion", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: { type: "bashPattern", value: "dev server" },
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: { type: "verified-companion", value: "scenario-companion-rulebook" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false, // BUG: should be true
          droppedReason: null,
        },
      ],
    });
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    const hint = result.doctor!.hints.find(
      (h) => h.code === "COMPANION_RECALL_NOT_SYNTHETIC",
    );
    expect(hint).toBeDefined();
    expect(hint!.severity).toBe("warning");
    expect(hint!.message).toContain("verification");
  });

  test(".doctor.companionRecall coexists with policyRecall without interference", () => {
    const trace = makeTrace({
      policyScenario: "PreToolUse|flow-verification|clientRequest|Bash|/settings",
      primaryStory: {
        id: "story-1",
        kind: "flow-verification",
        storyRoute: "/settings",
        targetBoundary: "clientRequest",
      },
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: { type: "policy-recall", value: "route-scoped-verified-policy-recall" },
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: { type: "verified-companion", value: "scenario-companion-rulebook" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
    });
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    // Policy recall should still have its own diagnosis
    expect(result.doctor!.policyRecall).not.toBeNull();
    // Companion recall should be independently tracked
    expect(result.doctor!.companionRecall.detected).toBe(true);
    expect(result.doctor!.companionRecall.entries[0].companionSkill).toBe("verification");
    // Both should appear in latestRanked
    expect(result.doctor!.latestRanked).toHaveLength(2);
  });

  test("explicit causality: two companions after one candidate resolve correctly", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
        {
          skill: "observability",
          basePriority: 0,
          effectivePriority: 0,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
      causes: [
        {
          code: "verified-companion",
          stage: "rank",
          skill: "verification",
          synthetic: true,
          scoreDelta: 0,
          message: "Inserted learned companion after agent-browser-verify",
          detail: {
            candidateSkill: "agent-browser-verify",
            scenario: "PreToolUse|bugfix|uiRender|Bash|/settings",
          },
        },
        {
          code: "verified-companion",
          stage: "rank",
          skill: "observability",
          synthetic: true,
          scoreDelta: 0,
          message: "Inserted learned companion after agent-browser-verify",
          detail: {
            candidateSkill: "agent-browser-verify",
            scenario: "PreToolUse|bugfix|uiRender|Bash|/settings",
          },
        },
      ],
      edges: [
        {
          fromSkill: "agent-browser-verify",
          toSkill: "verification",
          relation: "companion-of",
          code: "verified-companion",
          detail: { scenario: "PreToolUse|bugfix|uiRender|Bash|/settings" },
        },
        {
          fromSkill: "agent-browser-verify",
          toSkill: "observability",
          relation: "companion-of",
          code: "verified-companion",
          detail: { scenario: "PreToolUse|bugfix|uiRender|Bash|/settings" },
        },
      ],
    } as any);
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).not.toBeNull();
    expect(result.doctor!.companionRecall.detected).toBe(true);
    expect(result.doctor!.companionRecall.entries).toHaveLength(2);

    const verification = result.doctor!.companionRecall.entries.find(
      (e) => e.companionSkill === "verification",
    )!;
    expect(verification.candidateSkill).toBe("agent-browser-verify");
    expect(verification.synthetic).toBe(true);

    const observability = result.doctor!.companionRecall.entries.find(
      (e) => e.companionSkill === "observability",
    )!;
    expect(observability.candidateSkill).toBe("agent-browser-verify");
    expect(observability.synthetic).toBe(true);

    // No COMPANION_EDGE_MISSING hints since all edges are present
    const edgeMissing = result.doctor!.hints.filter(
      (h) => h.code === "COMPANION_EDGE_MISSING",
    );
    expect(edgeMissing).toHaveLength(0);
  });

  test("explicit causality: companion moved away from candidate resolves via edge", () => {
    // ranked order: candidate, unrelated, companion — edge still resolves correctly
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
        {
          skill: "next-app-router",
          basePriority: 6,
          effectivePriority: 6,
          pattern: { type: "pathPattern", value: "app/**" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
      causes: [
        {
          code: "verified-companion",
          stage: "rank",
          skill: "verification",
          synthetic: true,
          scoreDelta: 0,
          message: "Inserted learned companion after agent-browser-verify",
          detail: {
            candidateSkill: "agent-browser-verify",
            scenario: "PreToolUse|bugfix|uiRender|Bash|/settings",
          },
        },
      ],
      edges: [
        {
          fromSkill: "agent-browser-verify",
          toSkill: "verification",
          relation: "companion-of",
          code: "verified-companion",
          detail: { scenario: "PreToolUse|bugfix|uiRender|Bash|/settings" },
        },
      ],
    } as any);
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor!.companionRecall.detected).toBe(true);
    const entry = result.doctor!.companionRecall.entries[0];
    // Edge-based resolution should find the correct candidate even though
    // next-app-router sits between them in ranked order
    expect(entry.candidateSkill).toBe("agent-browser-verify");
    expect(entry.companionSkill).toBe("verification");
  });

  test("fallback: old traces without causes/edges resolve via ranked order", () => {
    // Old-style trace: no causes or edges, only ranked[] with pattern metadata
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: { type: "bashPattern", value: "dev server" },
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: false,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: { type: "verified-companion", value: "scenario-companion-rulebook" },
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
      // Explicitly no causes/edges — simulates pre-causality trace
    });
    // Remove causes/edges from the trace before appending
    const rawTrace = { ...trace } as any;
    delete rawTrace.causes;
    delete rawTrace.edges;
    appendRoutingDecisionTrace(rawTrace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor!.companionRecall.detected).toBe(true);
    expect(result.doctor!.companionRecall.entries).toHaveLength(1);

    const entry = result.doctor!.companionRecall.entries[0];
    expect(entry.companionSkill).toBe("verification");
    // Fallback: candidate inferred from preceding ranked entry
    expect(entry.candidateSkill).toBe("agent-browser-verify");
    expect(entry.patternType).toBe("verified-companion");
  });

  test("COMPANION_EDGE_MISSING when companion has cause but no edge", () => {
    const trace = makeTrace({
      ranked: [
        {
          skill: "agent-browser-verify",
          basePriority: 7,
          effectivePriority: 15,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 8,
          policyReason: "4/5 wins",
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
        {
          skill: "verification",
          basePriority: 0,
          effectivePriority: 0,
          pattern: null,
          profilerBoost: 0,
          policyBoost: 0,
          policyReason: null,
          summaryOnly: false,
          synthetic: true,
          droppedReason: null,
        },
      ],
      causes: [
        {
          code: "verified-companion",
          stage: "rank",
          skill: "verification",
          synthetic: true,
          scoreDelta: 0,
          message: "Inserted learned companion after agent-browser-verify",
          detail: {
            // No candidateSkill in detail either
            scenario: "PreToolUse|bugfix|uiRender|Bash|/settings",
          },
        },
      ],
      edges: [], // No edges — should trigger COMPANION_EDGE_MISSING
    } as any);
    appendRoutingDecisionTrace(trace);

    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor!.companionRecall.detected).toBe(true);
    const entry = result.doctor!.companionRecall.entries[0];
    // No edge and no detail.candidateSkill → null
    expect(entry.candidateSkill).toBeNull();

    const hint = result.doctor!.hints.find(
      (h) => h.code === "COMPANION_EDGE_MISSING",
    );
    expect(hint).toBeDefined();
    expect(hint!.severity).toBe("warning");
    expect(hint!.message).toContain("verification");
  });

  test(".doctor is null when no traces exist", () => {
    const output = runSessionExplain(TEST_SESSION, ROOT, true);
    const result: SessionExplainResult = JSON.parse(output);

    expect(result.doctor).toBeNull();
  });
});
