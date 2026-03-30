import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  type CompanionConfidence,
  type LearnedCompanionRule,
  type LearnedCompanionRulebook,
  type CompanionRulebookErrorCode,
  companionRulebookPath,
  serializeCompanionRulebook,
  loadCompanionRulebook,
  saveCompanionRulebook,
  createEmptyCompanionRulebook,
} from "../hooks/src/learned-companion-rulebook.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-28T08:15:00.000Z";
const PROJECT_ROOT = "/test/project";
const SCENARIO_A = "PreToolUse|flow-verification|uiRender|Bash|/dashboard";
const SCENARIO_B = "UserPromptSubmit|none|none|Prompt|*";

function makeRule(
  overrides: Partial<LearnedCompanionRule> = {},
): LearnedCompanionRule {
  return {
    id: `${SCENARIO_A}::verification->agent-browser-verify`,
    scenario: SCENARIO_A,
    hook: "PreToolUse",
    storyKind: "flow-verification",
    targetBoundary: "uiRender",
    toolName: "Bash",
    routeScope: "/dashboard",
    candidateSkill: "verification",
    companionSkill: "agent-browser-verify",
    support: 5,
    winsWithCompanion: 4,
    winsWithoutCompanion: 2,
    directiveWinsWithCompanion: 1,
    staleMissesWithCompanion: 0,
    precisionWithCompanion: 0.8,
    baselinePrecisionWithoutCompanion: 0.5,
    liftVsCandidateAlone: 1.6,
    staleMissDelta: 0,
    confidence: "promote",
    promotedAt: T0,
    reason: "companion beats candidate-alone within same verified scenario",
    sourceExposureGroupIds: ["g-1", "g-2", "g-3", "g-4", "g-5"],
    ...overrides,
  };
}

function makeRulebook(
  overrides: Partial<LearnedCompanionRulebook> = {},
): LearnedCompanionRulebook {
  return {
    version: 1,
    generatedAt: T0,
    projectRoot: PROJECT_ROOT,
    rules: [makeRule()],
    replay: {
      baselineWins: 0,
      learnedWins: 0,
      deltaWins: 0,
      regressions: [],
    },
    promotion: {
      accepted: true,
      errorCode: null,
      reason: "1 promoted companion rules",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unique temp project root per test to avoid collisions
// ---------------------------------------------------------------------------

let testProjectRoot: string;

beforeEach(() => {
  testProjectRoot = join(tmpdir(), `vercel-plugin-test-${randomUUID()}`);
  mkdirSync(testProjectRoot, { recursive: true });
});

afterEach(() => {
  try { rmSync(companionRulebookPath(testProjectRoot)); } catch {}
  try { rmSync(testProjectRoot, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// AC1: Loading when absent returns empty rulebook
// ---------------------------------------------------------------------------

describe("load absent companion rulebook", () => {
  test("returns ok: true with version 1 empty rulebook", () => {
    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.version).toBe(1);
    expect(result.rulebook.rules).toEqual([]);
  });

  test("empty rulebook has accepted promotion with empty reason", () => {
    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.promotion.accepted).toBe(true);
    expect(result.rulebook.promotion.reason).toBe("empty rulebook");
  });

  test("empty rulebook has zeroed replay stats", () => {
    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.replay).toEqual({
      baselineWins: 0,
      learnedWins: 0,
      deltaWins: 0,
      regressions: [],
    });
  });
});

// ---------------------------------------------------------------------------
// AC2: Atomic save and byte-for-byte round-trip
// ---------------------------------------------------------------------------

describe("save and load round-trip", () => {
  test("round-trip preserves all fields without loss", () => {
    const rulebook = makeRulebook();
    saveCompanionRulebook(testProjectRoot, rulebook);
    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook).toEqual(rulebook);
  });

  test("round-trip produces byte-identical JSON", () => {
    const rulebook = makeRulebook();
    saveCompanionRulebook(testProjectRoot, rulebook);
    const raw = readFileSync(
      companionRulebookPath(testProjectRoot),
      "utf-8",
    );
    expect(raw).toBe(serializeCompanionRulebook(rulebook));
  });

  test("save overwrites previous rulebook atomically", () => {
    const v1 = makeRulebook({
      rules: [makeRule({ companionSkill: "first" })],
    });
    saveCompanionRulebook(testProjectRoot, v1);

    const v2 = makeRulebook({
      rules: [makeRule({ companionSkill: "second" })],
    });
    saveCompanionRulebook(testProjectRoot, v2);

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.rules.length).toBe(1);
    expect(result.rulebook.rules[0].companionSkill).toBe("second");
  });

  test("idempotent save — writing same rulebook twice yields identical file", () => {
    const rulebook = makeRulebook();
    saveCompanionRulebook(testProjectRoot, rulebook);
    const first = readFileSync(
      companionRulebookPath(testProjectRoot),
      "utf-8",
    );

    saveCompanionRulebook(testProjectRoot, rulebook);
    const second = readFileSync(
      companionRulebookPath(testProjectRoot),
      "utf-8",
    );

    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// AC3: Invalid content returns structured error
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("COMPANION_RULEBOOK_READ_FAILED for non-JSON content", () => {
    writeFileSync(
      companionRulebookPath(testProjectRoot),
      "not json {{{",
    );

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      "COMPANION_RULEBOOK_READ_FAILED" satisfies CompanionRulebookErrorCode,
    );
  });

  test("COMPANION_RULEBOOK_VERSION_UNSUPPORTED for version 2", () => {
    const bad = {
      version: 2,
      generatedAt: T0,
      projectRoot: "/x",
      rules: [],
      replay: { baselineWins: 0, learnedWins: 0, deltaWins: 0, regressions: [] },
      promotion: { accepted: true, errorCode: null, reason: "test" },
    };
    writeFileSync(
      companionRulebookPath(testProjectRoot),
      JSON.stringify(bad),
    );

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      "COMPANION_RULEBOOK_VERSION_UNSUPPORTED" satisfies CompanionRulebookErrorCode,
    );
    expect(result.error.detail.supportedVersions).toEqual([1]);
  });

  test("COMPANION_RULEBOOK_SCHEMA_INVALID for missing rules array", () => {
    const bad = {
      version: 1,
      generatedAt: T0,
      projectRoot: "/x",
      replay: {},
      promotion: {},
    };
    writeFileSync(
      companionRulebookPath(testProjectRoot),
      JSON.stringify(bad),
    );

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      "COMPANION_RULEBOOK_SCHEMA_INVALID" satisfies CompanionRulebookErrorCode,
    );
    expect(result.error.detail.field).toBe("rules");
  });

  test("COMPANION_RULEBOOK_SCHEMA_INVALID for rule with invalid confidence", () => {
    const bad = {
      version: 1,
      generatedAt: T0,
      projectRoot: "/x",
      rules: [{
        id: "test",
        scenario: "test",
        candidateSkill: "test",
        companionSkill: "test",
        reason: "test",
        support: 1,
        winsWithCompanion: 1,
        winsWithoutCompanion: 0,
        precisionWithCompanion: 1,
        baselinePrecisionWithoutCompanion: 0,
        liftVsCandidateAlone: 1,
        staleMissDelta: 0,
        confidence: "unknown-value",
      }],
      replay: { baselineWins: 0, learnedWins: 0, deltaWins: 0, regressions: [] },
      promotion: { accepted: true, errorCode: null, reason: "test" },
    };
    writeFileSync(
      companionRulebookPath(testProjectRoot),
      JSON.stringify(bad),
    );

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      "COMPANION_RULEBOOK_SCHEMA_INVALID" satisfies CompanionRulebookErrorCode,
    );
    expect(result.error.message).toContain("confidence");
  });

  test("COMPANION_RULEBOOK_SCHEMA_INVALID for JSON array", () => {
    writeFileSync(companionRulebookPath(testProjectRoot), "[]");

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      "COMPANION_RULEBOOK_SCHEMA_INVALID" satisfies CompanionRulebookErrorCode,
    );
  });

  test("errors have stable code, message, detail structure", () => {
    writeFileSync(companionRulebookPath(testProjectRoot), "[]");

    const result = loadCompanionRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error.code).toBe("string");
    expect(typeof result.error.message).toBe("string");
    expect(typeof result.error.detail).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

describe("serializeCompanionRulebook", () => {
  test("same input produces byte-identical output", () => {
    const rulebook = makeRulebook();
    const first = serializeCompanionRulebook(rulebook);
    const second = serializeCompanionRulebook(rulebook);
    expect(first).toBe(second);
  });

  test("rules are sorted by scenario, candidateSkill, companionSkill", () => {
    const rulebook = makeRulebook({
      rules: [
        makeRule({ scenario: "Z", candidateSkill: "z", companionSkill: "z" }),
        makeRule({ scenario: "A", candidateSkill: "a", companionSkill: "b" }),
        makeRule({ scenario: "A", candidateSkill: "a", companionSkill: "a" }),
      ],
    });
    const serialized = serializeCompanionRulebook(rulebook);
    const parsed = JSON.parse(serialized) as LearnedCompanionRulebook;
    expect(parsed.rules[0].companionSkill).toBe("a");
    expect(parsed.rules[1].companionSkill).toBe("b");
    expect(parsed.rules[2].scenario).toBe("Z");
  });

  test("serialization does not mutate original rules order", () => {
    const rules = [
      makeRule({ scenario: "Z", candidateSkill: "z", companionSkill: "z" }),
      makeRule({ scenario: "A", candidateSkill: "a", companionSkill: "a" }),
    ];
    const rulebook = makeRulebook({ rules });
    serializeCompanionRulebook(rulebook);
    expect(rulebook.rules[0].scenario).toBe("Z");
    expect(rulebook.rules[1].scenario).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("companionRulebookPath", () => {
  test("uses learned-companions prefix (not routing-policy)", () => {
    const path = companionRulebookPath("/test/project");
    expect(path).toContain("vercel-plugin-learned-companions-");
    expect(path).toEndWith(".json");
    expect(path).not.toContain("routing-policy");
  });

  test("different project roots produce different paths", () => {
    const a = companionRulebookPath("/project/a");
    const b = companionRulebookPath("/project/b");
    expect(a).not.toBe(b);
  });

  test("same project root produces same path", () => {
    const a = companionRulebookPath("/project/same");
    const b = companionRulebookPath("/project/same");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

describe("createEmptyCompanionRulebook", () => {
  test("has version 1, empty rules, accepted promotion", () => {
    const rb = createEmptyCompanionRulebook(PROJECT_ROOT, T0);
    expect(rb.version).toBe(1);
    expect(rb.projectRoot).toBe(PROJECT_ROOT);
    expect(rb.generatedAt).toBe(T0);
    expect(rb.rules).toEqual([]);
    expect(rb.promotion.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type export tests
// ---------------------------------------------------------------------------

describe("type exports", () => {
  test("CompanionConfidence accepts all valid values", () => {
    const a: CompanionConfidence = "candidate";
    const b: CompanionConfidence = "promote";
    const c: CompanionConfidence = "holdout-fail";
    expect(a).toBe("candidate");
    expect(b).toBe("promote");
    expect(c).toBe("holdout-fail");
  });

  test("LearnedCompanionRulebook has version 1", () => {
    const rulebook = makeRulebook();
    expect(rulebook.version).toBe(1);
  });
});
