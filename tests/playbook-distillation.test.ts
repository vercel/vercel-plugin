import { describe, test, expect } from "bun:test";
import { distillPlaybooks } from "../hooks/src/playbook-distillation.mts";
import {
  playbookRulebookPath,
  createEmptyPlaybookRulebook,
  savePlaybookRulebook,
  loadPlaybookRulebook,
} from "../hooks/src/learned-playbook-rulebook.mts";
import type { SkillExposure } from "../hooks/src/routing-policy-ledger.mts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExposure(
  input: Partial<SkillExposure> & {
    exposureGroupId: string;
    skill: string;
    outcome: SkillExposure["outcome"];
    attributionRole: SkillExposure["attributionRole"];
  },
): SkillExposure {
  return {
    id: `${input.exposureGroupId}:${input.skill}`,
    sessionId: "s1",
    projectRoot: "/repo",
    storyId: "story-1",
    storyKind: "flow-verification",
    route: "/settings",
    hook: "PreToolUse",
    toolName: "Bash",
    skill: input.skill,
    targetBoundary: "clientRequest",
    exposureGroupId: input.exposureGroupId,
    attributionRole: input.attributionRole,
    candidateSkill: "verification",
    createdAt: "2026-03-28T16:00:00.000Z",
    resolvedAt: "2026-03-28T16:01:00.000Z",
    outcome: input.outcome,
    ...input,
  };
}

// ---------------------------------------------------------------------------
// Rulebook persistence
// ---------------------------------------------------------------------------

describe("learned-playbook-rulebook", () => {
  test("playbookRulebookPath resolves to generated/learned-playbooks.json", () => {
    expect(playbookRulebookPath("/repo")).toBe(
      "/repo/generated/learned-playbooks.json",
    );
  });

  test("save and load round-trip a versioned rulebook with deterministic sorting", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vp-pb-"));
    const rulebook = createEmptyPlaybookRulebook(
      projectRoot,
      "2026-03-28T16:00:00.000Z",
    );
    rulebook.rules.push({
      id: "test-rule",
      scenario: "PreToolUse|flow|clientRequest|Bash|*",
      hook: "PreToolUse",
      storyKind: "flow",
      targetBoundary: "clientRequest",
      toolName: "Bash",
      routeScope: "*",
      anchorSkill: "a",
      orderedSkills: ["a", "b"],
      support: 5,
      wins: 4,
      directiveWins: 1,
      staleMisses: 0,
      precision: 0.8,
      baselinePrecisionWithoutPlaybook: 0.4,
      liftVsAnchorBaseline: 2,
      staleMissDelta: -0.1,
      confidence: "promote",
      promotedAt: "2026-03-28T16:00:00.000Z",
      reason: "test",
      sourceExposureGroupIds: ["g1", "g2"],
    });

    savePlaybookRulebook(projectRoot, rulebook);
    const loaded = loadPlaybookRulebook(projectRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.rulebook.version).toBe(1);
    expect(loaded.rulebook.rules).toHaveLength(1);
    expect(loaded.rulebook.rules[0].anchorSkill).toBe("a");
    expect(loaded.rulebook.rules[0].orderedSkills).toEqual(["a", "b"]);
  });

  test("loadPlaybookRulebook returns ENOENT for missing file", () => {
    const result = loadPlaybookRulebook("/nonexistent/path");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// Distillation
// ---------------------------------------------------------------------------

describe("distillPlaybooks", () => {
  test("promotes an ordered sequence that beats the same anchor baseline", () => {
    // 3 groups with the full playbook (verification → observability → routing-middleware), all wins
    // 3 groups with anchor-only (verification), mixed outcomes (1 win, 2 stale-miss)
    const exposures: SkillExposure[] = [
      // Group 1: full playbook, win
      makeExposure({ exposureGroupId: "g1", skill: "verification", attributionRole: "candidate", outcome: "win" }),
      makeExposure({ exposureGroupId: "g1", skill: "observability", attributionRole: "context", outcome: "win" }),
      makeExposure({ exposureGroupId: "g1", skill: "routing-middleware", attributionRole: "context", outcome: "win" }),
      // Group 2: full playbook, directive-win
      makeExposure({ exposureGroupId: "g2", skill: "verification", attributionRole: "candidate", outcome: "directive-win" }),
      makeExposure({ exposureGroupId: "g2", skill: "observability", attributionRole: "context", outcome: "directive-win" }),
      makeExposure({ exposureGroupId: "g2", skill: "routing-middleware", attributionRole: "context", outcome: "directive-win" }),
      // Group 3: full playbook, win
      makeExposure({ exposureGroupId: "g3", skill: "verification", attributionRole: "candidate", outcome: "win" }),
      makeExposure({ exposureGroupId: "g3", skill: "observability", attributionRole: "context", outcome: "win" }),
      makeExposure({ exposureGroupId: "g3", skill: "routing-middleware", attributionRole: "context", outcome: "win" }),
      // Group 4: anchor-only, stale-miss
      makeExposure({ exposureGroupId: "g4", skill: "verification", attributionRole: "candidate", outcome: "stale-miss" }),
      // Group 5: anchor-only, stale-miss
      makeExposure({ exposureGroupId: "g5", skill: "verification", attributionRole: "candidate", outcome: "stale-miss" }),
      // Group 6: anchor-only, win
      makeExposure({ exposureGroupId: "g6", skill: "verification", attributionRole: "candidate", outcome: "win" }),
    ];

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      generatedAt: "2026-03-28T16:10:00.000Z",
      minSupport: 3,
      minPrecision: 0.75,
      minLift: 1.25,
      maxSkills: 3,
    });

    const promoted = rulebook.rules.find((r) => r.confidence === "promote");
    expect(promoted).toBeDefined();
    expect(promoted?.anchorSkill).toBe("verification");
    expect(promoted?.orderedSkills).toEqual([
      "verification",
      "observability",
      "routing-middleware",
    ]);
    expect(promoted?.support).toBe(3);
    expect(promoted?.wins).toBe(3);
    expect(promoted?.confidence).toBe("promote");
    // Playbook precision: 3/3 = 1.0
    expect(promoted?.precision).toBe(1);
    // Baseline: 1 win out of 3 anchor-only = 0.3333
    expect(promoted?.baselinePrecisionWithoutPlaybook).toBeCloseTo(0.3333, 3);
    // Lift: 1.0 / 0.3333 = 3.0
    expect(promoted?.liftVsAnchorBaseline).toBeCloseTo(3, 1);
  });

  test("does not promote sequences below minSupport", () => {
    const exposures: SkillExposure[] = [
      makeExposure({ exposureGroupId: "g1", skill: "a", attributionRole: "candidate", outcome: "win", candidateSkill: "a" }),
      makeExposure({ exposureGroupId: "g1", skill: "b", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
      makeExposure({ exposureGroupId: "g2", skill: "a", attributionRole: "candidate", outcome: "win", candidateSkill: "a" }),
      makeExposure({ exposureGroupId: "g2", skill: "b", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
    ];

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    expect(rulebook.rules.every((r) => r.confidence === "holdout-fail")).toBe(
      true,
    );
  });

  test("skips single-skill groups (no playbook possible)", () => {
    const exposures: SkillExposure[] = [
      makeExposure({ exposureGroupId: "g1", skill: "only-one", attributionRole: "candidate", outcome: "win", candidateSkill: "only-one" }),
      makeExposure({ exposureGroupId: "g2", skill: "only-one", attributionRole: "candidate", outcome: "win", candidateSkill: "only-one" }),
      makeExposure({ exposureGroupId: "g3", skill: "only-one", attributionRole: "candidate", outcome: "win", candidateSkill: "only-one" }),
    ];

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    expect(rulebook.rules).toHaveLength(0);
  });

  test("skips exposures without exposureGroupId", () => {
    const exposures: SkillExposure[] = [
      makeExposure({ exposureGroupId: "", skill: "a", attributionRole: "candidate", outcome: "win" }),
    ];

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
    });

    expect(rulebook.rules).toHaveLength(0);
  });

  test("caps orderedSkills at maxSkills", () => {
    const exposures: SkillExposure[] = [];
    for (let i = 0; i < 4; i++) {
      const gid = `g${i}`;
      exposures.push(
        makeExposure({ exposureGroupId: gid, skill: "a", attributionRole: "candidate", outcome: "win", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: gid, skill: "b", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: gid, skill: "c", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: gid, skill: "d", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
      );
    }

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      maxSkills: 2,
      minSupport: 3,
    });

    for (const rule of rulebook.rules) {
      expect(rule.orderedSkills.length).toBeLessThanOrEqual(2);
    }
  });

  test("deduplicates skills in orderedSkills", () => {
    const exposures: SkillExposure[] = [];
    for (let i = 0; i < 4; i++) {
      const gid = `g${i}`;
      exposures.push(
        makeExposure({ exposureGroupId: gid, skill: "a", attributionRole: "candidate", outcome: "win", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: gid, skill: "a", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: gid, skill: "b", attributionRole: "context", outcome: "win", candidateSkill: "a" }),
      );
    }

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    for (const rule of rulebook.rules) {
      const unique = [...new Set(rule.orderedSkills)];
      expect(rule.orderedSkills).toEqual(unique);
    }
  });

  test("rules are sorted deterministically", () => {
    const exposures: SkillExposure[] = [];
    // Two different scenarios
    for (let i = 0; i < 4; i++) {
      const gid = `gA${i}`;
      exposures.push(
        makeExposure({ exposureGroupId: gid, skill: "z-skill", attributionRole: "candidate", outcome: "win", candidateSkill: "z-skill", hook: "PreToolUse" }),
        makeExposure({ exposureGroupId: gid, skill: "a-skill", attributionRole: "context", outcome: "win", candidateSkill: "z-skill", hook: "PreToolUse" }),
      );
    }
    for (let i = 0; i < 4; i++) {
      const gid = `gB${i}`;
      exposures.push(
        makeExposure({ exposureGroupId: gid, skill: "a-anchor", attributionRole: "candidate", outcome: "win", candidateSkill: "a-anchor", hook: "PreToolUse" }),
        makeExposure({ exposureGroupId: gid, skill: "b-step", attributionRole: "context", outcome: "win", candidateSkill: "a-anchor", hook: "PreToolUse" }),
      );
    }

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    expect(rulebook.rules.length).toBeGreaterThanOrEqual(2);
    // Rules should be sorted by scenario, then anchorSkill, then orderedSkills
    for (let i = 1; i < rulebook.rules.length; i++) {
      const prev = rulebook.rules[i - 1];
      const curr = rulebook.rules[i];
      const cmp =
        prev.scenario.localeCompare(curr.scenario) ||
        prev.anchorSkill.localeCompare(curr.anchorSkill) ||
        prev.orderedSkills.join(">").localeCompare(curr.orderedSkills.join(">"));
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  test("pending outcomes are ignored", () => {
    const exposures: SkillExposure[] = [];
    for (let i = 0; i < 4; i++) {
      exposures.push(
        makeExposure({ exposureGroupId: `g${i}`, skill: "a", attributionRole: "candidate", outcome: "pending", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: `g${i}`, skill: "b", attributionRole: "context", outcome: "pending", candidateSkill: "a" }),
      );
    }

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    expect(rulebook.rules).toHaveLength(0);
  });

  test("stale-miss heavy playbook is not promoted", () => {
    const exposures: SkillExposure[] = [];
    // 3 playbook groups: all stale-miss
    for (let i = 0; i < 3; i++) {
      exposures.push(
        makeExposure({ exposureGroupId: `g${i}`, skill: "a", attributionRole: "candidate", outcome: "stale-miss", candidateSkill: "a" }),
        makeExposure({ exposureGroupId: `g${i}`, skill: "b", attributionRole: "context", outcome: "stale-miss", candidateSkill: "a" }),
      );
    }
    // 3 anchor-only groups: all wins (good baseline)
    for (let i = 3; i < 6; i++) {
      exposures.push(
        makeExposure({ exposureGroupId: `g${i}`, skill: "a", attributionRole: "candidate", outcome: "win", candidateSkill: "a" }),
      );
    }

    const rulebook = distillPlaybooks({
      projectRoot: "/repo",
      exposures,
      minSupport: 3,
    });

    expect(rulebook.rules.every((r) => r.confidence === "holdout-fail")).toBe(true);
  });
});
