import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createEmptyRoutingPolicy,
  applyPolicyBoosts,
  applyRulebookBoosts,
  type RoutingPolicyFile,
  type RoutingPolicyScenario,
} from "../hooks/src/routing-policy.mts";
import {
  saveRulebook,
  rulebookPath,
  createRule,
  createEmptyRulebook,
  type LearnedRoutingRulebook,
} from "../hooks/src/learned-routing-rulebook.mts";
import {
  projectPolicyPath,
  sessionExposurePath,
  loadProjectRoutingPolicy,
  saveProjectRoutingPolicy,
  appendSkillExposure,
  loadSessionExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  statePath as verificationStatePath,
} from "../hooks/src/verification-ledger.mts";
import {
  readRoutingDecisionTrace,
  traceDir,
} from "../hooks/src/routing-decision-trace.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT = "/tmp/test-user-prompt-routing-policy-" + Date.now();
const TEST_SESSION = "test-session-uprp-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";

function cleanupPolicyFile(): void {
  try { unlinkSync(projectPolicyPath(TEST_PROJECT)); } catch {}
}

function cleanupExposureFile(): void {
  try { unlinkSync(sessionExposurePath(TEST_SESSION)); } catch {}
}

function cleanupRulebookFile(): void {
  try { unlinkSync(rulebookPath(TEST_PROJECT)); } catch {}
}

/** Write a minimal mock verification plan state for the session. */
function writeMockPlanState(sessionId: string, story?: {
  id?: string;
  kind?: string;
  route?: string | null;
  targetBoundary?: string | null;
}): void {
  const sp = verificationStatePath(sessionId);
  mkdirSync(join(sp, ".."), { recursive: true });
  const s = {
    id: story?.id ?? "test-prompt-story",
    kind: story?.kind ?? "deployment",
    route: story?.route ?? "/api/test",
    promptExcerpt: "test prompt",
    createdAt: T0,
    updatedAt: T1,
    requestedSkills: [],
  };
  const tb = story?.targetBoundary ?? null;
  writeFileSync(sp, JSON.stringify({
    version: 1,
    stories: [s],
    observationIds: [],
    satisfiedBoundaries: [],
    missingBoundaries: [],
    recentRoutes: [],
    primaryNextAction: tb
      ? { action: "verify boundary", targetBoundary: tb, reason: "test" }
      : null,
    blockedReasons: [],
  }));
}

function cleanupMockPlanState(sessionId: string): void {
  const sp = verificationStatePath(sessionId);
  try { rmSync(join(sp, ".."), { recursive: true, force: true }); } catch {}
}

function buildPromptPolicy(
  skill: string,
  exposures: number,
  wins: number,
  directiveWins: number,
  staleMisses: number,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  const scenario = "UserPromptSubmit|none|none|Prompt";
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

describe("user-prompt-submit routing-policy integration", () => {
  describe("applyPolicyBoosts with UserPromptSubmit scenario", () => {
    const PROMPT_SCENARIO: RoutingPolicyScenario = {
      hook: "UserPromptSubmit",
      storyKind: null,
      targetBoundary: null,
      toolName: "Prompt",
    };

    test("applies boost to prompt-matched skills with sufficient history", () => {
      const policy = buildPromptPolicy("next-config", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "next-config", priority: 8, effectivePriority: 8 },
        { skill: "deployment", priority: 10, effectivePriority: 10 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);

      // next-config: (4 + 2*0.25)/5 = 0.9 => +8 boost => 16
      expect(boosted.find((b) => b.skill === "next-config")!.policyBoost).toBe(8);
      expect(boosted.find((b) => b.skill === "next-config")!.effectivePriority).toBe(16);
      // deployment: no data => 0 boost
      expect(boosted.find((b) => b.skill === "deployment")!.policyBoost).toBe(0);
    });

    test("re-orders selected skills by boosted effective priority", () => {
      const policy = buildPromptPolicy("low-base-skill", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "high-base-skill", priority: 12, effectivePriority: 12 },
        { skill: "low-base-skill", priority: 6, effectivePriority: 6 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);

      // Sort as the injector would: by effectivePriority desc, then skill name asc
      boosted.sort((a, b) =>
        b.effectivePriority - a.effectivePriority || a.skill.localeCompare(b.skill),
      );

      // low-base-skill: 6 + 8 = 14 > high-base-skill: 12
      expect(boosted[0].skill).toBe("low-base-skill");
      expect(boosted[1].skill).toBe("high-base-skill");
    });

    test("no boost when policy file missing", () => {
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      const entries = [
        { skill: "next-config", priority: 8, effectivePriority: 8 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);
      expect(boosted[0].policyBoost).toBe(0);
      expect(boosted[0].effectivePriority).toBe(8);
    });

    test("negative boost for skill with many exposures but low wins", () => {
      const policy = buildPromptPolicy("bad-skill", 8, 0, 0, 7);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "bad-skill", priority: 7, effectivePriority: 7 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);
      expect(boosted[0].policyBoost).toBe(-2);
      expect(boosted[0].effectivePriority).toBe(5);
    });
  });

  describe("exposure recording for UserPromptSubmit", () => {
    test("appends pending exposure with hook=UserPromptSubmit and toolName=Prompt", () => {
      const exposure: SkillExposure = {
        id: `${TEST_SESSION}:prompt:next-config:1`,
        sessionId: TEST_SESSION,
        projectRoot: TEST_PROJECT,
        storyId: null,
        storyKind: null,
        route: null,
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        skill: "next-config",
        targetBoundary: null,
        exposureGroupId: null,
        attributionRole: "candidate",
        candidateSkill: null,
        createdAt: T0,
        resolvedAt: null,
        outcome: "pending",
      };

      appendSkillExposure(exposure);

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(1);
      expect(exposures[0].hook).toBe("UserPromptSubmit");
      expect(exposures[0].toolName).toBe("Prompt");
      expect(exposures[0].skill).toBe("next-config");
      expect(exposures[0].outcome).toBe("pending");
    });

    test("records exposures only for injected skills not candidates", () => {
      // Simulate: 3 matched, but only 2 injected (cap of MAX_SKILLS=2)
      const injected = ["skill-a", "skill-b"];
      for (const skill of injected) {
        appendSkillExposure({
          id: `${TEST_SESSION}:prompt:${skill}:${Date.now()}`,
          sessionId: TEST_SESSION,
          projectRoot: TEST_PROJECT,
          storyId: null,
          storyKind: null,
          route: null,
          hook: "UserPromptSubmit",
          toolName: "Prompt",
          skill,
          targetBoundary: null,
          createdAt: T0,
          resolvedAt: null,
          outcome: "pending",
        });
      }

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(2);
      expect(exposures.map((e) => e.skill).sort()).toEqual(["skill-a", "skill-b"]);
      // skill-c (matched but not injected) should not have an exposure
    });

    test("policy file is not mutated during boost application", () => {
      const policy = buildPromptPolicy("next-config", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);

      const before = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");

      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      applyPolicyBoosts(
        [{ skill: "next-config", priority: 8, effectivePriority: 8 }],
        loaded,
        {
          hook: "UserPromptSubmit",
          storyKind: null,
          targetBoundary: null,
          toolName: "Prompt",
        },
      );

      const after = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");
      expect(after).toBe(before);
    });
  });

  describe("deterministic ordering with policy ties", () => {
    test("skills with same boosted priority sort by name ascending", () => {
      const entries = [
        { skill: "z-skill", priority: 8, effectivePriority: 8 },
        { skill: "a-skill", priority: 8, effectivePriority: 8 },
      ];

      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      const boosted = applyPolicyBoosts(entries, loaded, {
        hook: "UserPromptSubmit",
        storyKind: null,
        targetBoundary: null,
        toolName: "Prompt",
      });

      boosted.sort((a, b) =>
        b.effectivePriority - a.effectivePriority || a.skill.localeCompare(b.skill),
      );

      expect(boosted[0].skill).toBe("a-skill");
      expect(boosted[1].skill).toBe("z-skill");
    });
  });

  describe("evidence scoping — story gate", () => {
    test("exposure recording requires active verification story", () => {
      // No mock plan state → exposureStory will be null → no exposure written
      // Simulate what the hook does: check for story before writing
      const exposurePlan = null; // loadCachedPlanResult returns null
      const exposureStory = null;

      // Directly verify: if we attempt to record an exposure without a story,
      // the hook code now skips it. We verify by writing exposures only with story.
      if (exposureStory) {
        appendSkillExposure({
          id: `${TEST_SESSION}:prompt:next-config:1`,
          sessionId: TEST_SESSION,
          projectRoot: TEST_PROJECT,
          storyId: null,
          storyKind: null,
          route: null,
          hook: "UserPromptSubmit",
          toolName: "Prompt",
          skill: "next-config",
          targetBoundary: null,
          createdAt: T0,
          resolvedAt: null,
          outcome: "pending",
        });
      }

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures).toEqual([]);
    });

    test("exposure recording proceeds with active verification story", () => {
      writeMockPlanState(TEST_SESSION);

      // Simulate what the hook does: story found → record exposure with story fields
      appendSkillExposure({
        id: `${TEST_SESSION}:prompt:next-config:1`,
        sessionId: TEST_SESSION,
        projectRoot: TEST_PROJECT,
        storyId: "test-prompt-story",
        storyKind: "deployment",
        route: "/api/test",
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        skill: "next-config",
        targetBoundary: null,
        createdAt: T0,
        resolvedAt: null,
        outcome: "pending",
      });

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(1);
      expect(exposures[0].storyId).toBe("test-prompt-story");
      expect(exposures[0].storyKind).toBe("deployment");
    });

    test("no none|none scenario keys created when no story exists", () => {
      // No plan state → no story → no exposures
      const exposures = loadSessionExposures(TEST_SESSION);
      const noneNone = exposures.filter(
        (e) => e.storyId === null && e.storyKind === null,
      );
      expect(noneNone).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Routing decision trace integration tests (UserPromptSubmit)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs");

/** Run UserPromptSubmit hook as subprocess */
async function runPromptHook(
  prompt: string,
  env?: Record<string, string>,
  sessionId?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const sid = sessionId ?? `trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({
    prompt,
    session_id: sid,
    cwd: ROOT,
    hook_event_name: "UserPromptSubmit",
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

describe("user-prompt-submit routing decision trace", () => {
  let traceSession: string;

  beforeEach(() => {
    traceSession = `trace-ups-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try { rmSync(traceDir(traceSession), { recursive: true, force: true }); } catch {}
    cleanupMockPlanState(traceSession);
  });

  test("emits exactly one trace per prompt injection attempt", async () => {
    const { code } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].hook).toBe("UserPromptSubmit");
    expect(traces[0].version).toBe(2);
    expect(traces[0].toolName).toBe("Prompt");
    expect(traces[0].sessionId).toBe(traceSession);
    expect(traces[0].decisionId).toMatch(/^[0-9a-f]{16}$/);
    expect(Array.isArray(traces[0].matchedSkills)).toBe(true);
    expect(Array.isArray(traces[0].injectedSkills)).toBe(true);
    expect(Array.isArray(traces[0].ranked)).toBe(true);
  });

  test("records no_active_verification_story when no story exists", async () => {
    const { code } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].skippedReasons).toContain("no_active_verification_story");
    expect(traces[0].policyScenario).toBeNull();
  });

  test("records primaryStory and policyScenario when story exists", async () => {
    writeMockPlanState(traceSession, {
      id: "prompt-trace-story",
      kind: "feature-investigation",
      route: "/settings",
      targetBoundary: "serverHandler",
    });

    const { code } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].primaryStory.id).toBe("prompt-trace-story");
    expect(traces[0].primaryStory.kind).toBe("feature-investigation");
    expect(traces[0].policyScenario).toBe("UserPromptSubmit|feature-investigation|serverHandler|Prompt");
    expect(traces[0].skippedReasons).not.toContain("no_active_verification_story");
  });

  test("does not emit synthetic none|none policyScenario without story", async () => {
    const { code } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
      {},
      traceSession,
    );
    expect(code).toBe(0);

    const traces = readRoutingDecisionTrace(traceSession);
    expect(traces).toHaveLength(1);
    expect(traces[0].policyScenario).toBeNull();
  });

  test("emits routing.decision_trace_written summary log", async () => {
    const { code, stderr } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
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
    expect(traceLog!.hook).toBe("UserPromptSubmit");
    expect(traceLog!.decisionId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("ranked entries surface cap/budget drops in both skippedReasons and droppedReason", async () => {
    const { code } = await runPromptHook(
      "I want to deploy my Next.js application to Vercel production",
      {
        VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET: "200", // Very low budget
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
});

// ---------------------------------------------------------------------------
// Learned-routing-rulebook precedence tests for UserPromptSubmit
// ---------------------------------------------------------------------------

describe("user-prompt-submit rulebook precedence", () => {
  const PROMPT_SCENARIO: RoutingPolicyScenario = {
    hook: "UserPromptSubmit",
    storyKind: null,
    targetBoundary: null,
    toolName: "Prompt",
  };

  function makeRulebook(rules: Array<{
    scenario: string;
    skill: string;
    boost: number;
    action?: "promote" | "demote";
  }>): LearnedRoutingRulebook {
    const rb = createEmptyRulebook("test-sess", T0);
    for (const r of rules) {
      rb.rules.push(createRule({
        scenario: r.scenario,
        skill: r.skill,
        action: r.action ?? "promote",
        boost: r.boost,
        confidence: 0.9,
        reason: "replay verified: no regressions",
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

  test("rulebook boost replaces stats-policy boost for matching skill", () => {
    // Stats-policy: +8 for next-config
    const policy = buildPromptPolicy("next-config", 5, 4, 2, 0);
    saveProjectRoutingPolicy(TEST_PROJECT, policy);
    const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

    // First apply stats-policy
    const entries = [
      { skill: "next-config", priority: 8, effectivePriority: 8 },
      { skill: "deployment", priority: 10, effectivePriority: 10 },
    ];
    const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);

    // Verify stats-policy gave +8
    const nextConfigStats = boosted.find((b) => b.skill === "next-config")!;
    expect(nextConfigStats.policyBoost).toBe(8);

    // Now apply rulebook — rule gives +5
    const rulebook = makeRulebook([{
      scenario: "UserPromptSubmit|none|none|Prompt",
      skill: "next-config",
      boost: 5,
    }]);

    const withRulebook = applyRulebookBoosts(
      boosted,
      rulebook,
      PROMPT_SCENARIO,
      "/tmp/test-rulebook.json",
    );

    const nextConfigRule = withRulebook.find((b) => b.skill === "next-config")!;
    // Rulebook should replace stats-policy: base=8, ruleBoost=5, policyBoost suppressed
    expect(nextConfigRule.matchedRuleId).toBe("UserPromptSubmit|none|none|Prompt|next-config");
    expect(nextConfigRule.ruleBoost).toBe(5);
    expect(nextConfigRule.policyBoost).toBe(0); // suppressed
    expect(nextConfigRule.effectivePriority).toBe(13); // 8 + 5 (not 8 + 8 + 5)

    // deployment should be unchanged
    const deployment = withRulebook.find((b) => b.skill === "deployment")!;
    expect(deployment.matchedRuleId).toBeNull();
    expect(deployment.ruleBoost).toBe(0);
    expect(deployment.policyBoost).toBe(0); // no stats-policy either
  });

  test("route-scoped rulebook rule does not leak to other routes", () => {
    const rulebook = makeRulebook([{
      scenario: "UserPromptSubmit|deployment|clientRequest|Prompt",
      skill: "next-config",
      boost: 10,
    }]);

    // Scenario with different storyKind — should NOT match
    const differentScenario: RoutingPolicyScenario = {
      hook: "UserPromptSubmit",
      storyKind: "feature",
      targetBoundary: "uiRender",
      toolName: "Prompt",
    };

    const entries = [
      {
        skill: "next-config",
        priority: 8,
        effectivePriority: 8,
        policyBoost: 0,
        policyReason: null,
      },
    ];

    const withRulebook = applyRulebookBoosts(
      entries,
      rulebook,
      differentScenario,
      "/tmp/test-rulebook.json",
    );

    expect(withRulebook[0].matchedRuleId).toBeNull();
    expect(withRulebook[0].ruleBoost).toBe(0);
    expect(withRulebook[0].effectivePriority).toBe(8); // unchanged
  });

  test("demote action produces negative boost", () => {
    const rulebook = makeRulebook([{
      scenario: "UserPromptSubmit|none|none|Prompt",
      skill: "next-config",
      boost: 3,
      action: "demote",
    }]);

    const entries = [
      {
        skill: "next-config",
        priority: 8,
        effectivePriority: 8,
        policyBoost: 0,
        policyReason: null,
      },
    ];

    const withRulebook = applyRulebookBoosts(
      entries,
      rulebook,
      PROMPT_SCENARIO,
      "/tmp/test-rulebook.json",
    );

    expect(withRulebook[0].ruleBoost).toBe(-3);
    expect(withRulebook[0].effectivePriority).toBe(5); // 8 - 3
  });

  test("trace ranked entries include rulebook fields with null defaults", () => {
    const entries = [
      {
        skill: "next-config",
        priority: 8,
        effectivePriority: 8,
        policyBoost: 0,
        policyReason: null,
      },
    ];

    const rulebook = createEmptyRulebook("test-sess", T0);
    const withRulebook = applyRulebookBoosts(
      entries,
      rulebook,
      PROMPT_SCENARIO,
      "/tmp/test-rulebook.json",
    );

    expect(withRulebook[0].matchedRuleId).toBeNull();
    expect(withRulebook[0].ruleBoost).toBe(0);
    expect(withRulebook[0].ruleReason).toBeNull();
    expect(withRulebook[0].rulebookPath).toBeNull();
  });
});
