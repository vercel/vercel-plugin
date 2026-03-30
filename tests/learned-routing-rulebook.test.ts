import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  type LearnedRuleAction,
  type LearnedRoutingRuleEvidence,
  type LearnedRoutingRule,
  type LearnedRoutingRulebook,
  type RulebookErrorCode,
  rulebookPath,
  serializeRulebook,
  loadRulebook,
  saveRulebook,
  createEmptyRulebook,
  createRule,
} from "../hooks/src/learned-routing-rulebook.mts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-03-28T08:15:00.000Z";
const SESSION_ID = "sess_test_rulebook";
const SCENARIO_A = "PreToolUse|flow-verification|uiRender|Bash";
const SCENARIO_B = "UserPromptSubmit|none|none|Prompt";

function makeEvidence(
  overrides: Partial<LearnedRoutingRuleEvidence> = {},
): LearnedRoutingRuleEvidence {
  return {
    baselineWins: 4,
    baselineDirectiveWins: 2,
    learnedWins: 4,
    learnedDirectiveWins: 2,
    regressionCount: 0,
    ...overrides,
  };
}

function makeRule(
  overrides: Partial<LearnedRoutingRule> = {},
): LearnedRoutingRule {
  return {
    id: `${SCENARIO_A}|agent-browser-verify`,
    scenario: SCENARIO_A,
    skill: "agent-browser-verify",
    action: "promote",
    boost: 8,
    confidence: 0.93,
    reason: "replay verified: no regressions, learned routing matched winning skill",
    sourceSessionId: SESSION_ID,
    promotedAt: T0,
    evidence: makeEvidence(),
    ...overrides,
  };
}

function makeRulebook(
  overrides: Partial<LearnedRoutingRulebook> = {},
): LearnedRoutingRulebook {
  return {
    version: 1,
    createdAt: T0,
    sessionId: SESSION_ID,
    rules: [makeRule()],
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
  // Clean up the rulebook file
  try { rmSync(rulebookPath(testProjectRoot)); } catch {}
  try { rmSync(testProjectRoot, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Type export tests
// ---------------------------------------------------------------------------

describe("type exports", () => {
  test("LearnedRuleAction accepts promote and demote", () => {
    const promote: LearnedRuleAction = "promote";
    const demote: LearnedRuleAction = "demote";
    expect(promote).toBe("promote");
    expect(demote).toBe("demote");
  });

  test("LearnedRoutingRuleEvidence has all required fields", () => {
    const evidence = makeEvidence();
    expect(typeof evidence.baselineWins).toBe("number");
    expect(typeof evidence.baselineDirectiveWins).toBe("number");
    expect(typeof evidence.learnedWins).toBe("number");
    expect(typeof evidence.learnedDirectiveWins).toBe("number");
    expect(typeof evidence.regressionCount).toBe("number");
  });

  test("LearnedRoutingRulebook has version 1", () => {
    const rulebook = makeRulebook();
    expect(rulebook.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

describe("serializeRulebook", () => {
  test("same input produces byte-identical output", () => {
    const rulebook = makeRulebook();
    const first = serializeRulebook(rulebook);
    const second = serializeRulebook(rulebook);
    expect(first).toBe(second);
  });

  test("rules are sorted by scenario, skill, id", () => {
    const rulebook = makeRulebook({
      rules: [
        makeRule({ id: "z|z", scenario: "Z", skill: "z" }),
        makeRule({ id: "a|a", scenario: "A", skill: "a" }),
        makeRule({ id: "a|b", scenario: "A", skill: "b" }),
      ],
    });
    const serialized = serializeRulebook(rulebook);
    const parsed = JSON.parse(serialized) as LearnedRoutingRulebook;
    expect(parsed.rules[0].id).toBe("a|a");
    expect(parsed.rules[1].id).toBe("a|b");
    expect(parsed.rules[2].id).toBe("z|z");
  });

  test("serialization does not mutate original rules order", () => {
    const rules = [
      makeRule({ id: "z|z", scenario: "Z", skill: "z" }),
      makeRule({ id: "a|a", scenario: "A", skill: "a" }),
    ];
    const rulebook = makeRulebook({ rules });
    serializeRulebook(rulebook);
    expect(rulebook.rules[0].id).toBe("z|z");
    expect(rulebook.rules[1].id).toBe("a|a");
  });
});

// ---------------------------------------------------------------------------
// Round-trip persistence
// ---------------------------------------------------------------------------

describe("save and load", () => {
  test("round-trip preserves all fields without loss", () => {
    const rulebook = makeRulebook();
    saveRulebook(testProjectRoot, rulebook);
    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook).toEqual(makeRulebook({ rules: [makeRule()] }));
  });

  test("round-trip produces byte-identical JSON", () => {
    const rulebook = makeRulebook();
    saveRulebook(testProjectRoot, rulebook);
    const raw = readFileSync(rulebookPath(testProjectRoot), "utf-8");
    expect(raw).toBe(serializeRulebook(rulebook));
  });

  test("load returns empty rulebook when file does not exist", () => {
    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.rules).toEqual([]);
    expect(result.rulebook.version).toBe(1);
  });

  test("save overwrites previous rulebook atomically", () => {
    const v1 = makeRulebook({ rules: [makeRule({ skill: "first" })] });
    saveRulebook(testProjectRoot, v1);

    const v2 = makeRulebook({ rules: [makeRule({ skill: "second" })] });
    saveRulebook(testProjectRoot, v2);

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook.rules.length).toBe(1);
    expect(result.rulebook.rules[0].skill).toBe("second");
  });

  test("idempotent save — writing same rulebook twice yields identical file", () => {
    const rulebook = makeRulebook();
    saveRulebook(testProjectRoot, rulebook);
    const first = readFileSync(rulebookPath(testProjectRoot), "utf-8");

    saveRulebook(testProjectRoot, rulebook);
    const second = readFileSync(rulebookPath(testProjectRoot), "utf-8");

    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("RULEBOOK_VERSION_UNSUPPORTED for version 2", () => {
    const bad = { version: 2, createdAt: T0, sessionId: "x", rules: [] };
    writeFileSync(rulebookPath(testProjectRoot), JSON.stringify(bad));

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RULEBOOK_VERSION_UNSUPPORTED" satisfies RulebookErrorCode);
    expect(result.error.detail.supportedVersions).toEqual([1]);
  });

  test("RULEBOOK_SCHEMA_INVALID for non-JSON content", () => {
    writeFileSync(rulebookPath(testProjectRoot), "not json {{{");

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RULEBOOK_SCHEMA_INVALID" satisfies RulebookErrorCode);
  });

  test("RULEBOOK_SCHEMA_INVALID for missing rules array", () => {
    const bad = { version: 1, createdAt: T0, sessionId: "x" };
    writeFileSync(rulebookPath(testProjectRoot), JSON.stringify(bad));

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RULEBOOK_SCHEMA_INVALID" satisfies RulebookErrorCode);
    expect(result.error.detail.field).toBe("rules");
  });

  test("RULEBOOK_SCHEMA_INVALID for rule with missing evidence", () => {
    const bad = {
      version: 1,
      createdAt: T0,
      sessionId: "x",
      rules: [{
        id: "test",
        scenario: "test",
        skill: "test",
        action: "promote",
        boost: 8,
        confidence: 0.9,
        reason: "test",
        sourceSessionId: "x",
        promotedAt: T0,
        // evidence missing
      }],
    };
    writeFileSync(rulebookPath(testProjectRoot), JSON.stringify(bad));

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RULEBOOK_SCHEMA_INVALID" satisfies RulebookErrorCode);
    expect(result.error.message).toContain("evidence");
  });

  test("RULEBOOK_SCHEMA_INVALID for rule with invalid action", () => {
    const bad = {
      version: 1,
      createdAt: T0,
      sessionId: "x",
      rules: [{
        id: "test",
        scenario: "test",
        skill: "test",
        action: "investigate",  // not a valid LearnedRuleAction
        boost: 0,
        confidence: 0.5,
        reason: "test",
        sourceSessionId: "x",
        promotedAt: T0,
        evidence: makeEvidence(),
      }],
    };
    writeFileSync(rulebookPath(testProjectRoot), JSON.stringify(bad));

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RULEBOOK_SCHEMA_INVALID" satisfies RulebookErrorCode);
    expect(result.error.message).toContain("action");
  });

  test("errors are structured with code, message, detail", () => {
    writeFileSync(rulebookPath(testProjectRoot), "[]");

    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error.code).toBe("string");
    expect(typeof result.error.message).toBe("string");
    expect(typeof result.error.detail).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

describe("createRule", () => {
  test("generates deterministic id from scenario and skill", () => {
    const rule = createRule({
      scenario: SCENARIO_A,
      skill: "agent-browser-verify",
      action: "promote",
      boost: 8,
      confidence: 0.93,
      reason: "test",
      sourceSessionId: SESSION_ID,
      promotedAt: T0,
      evidence: makeEvidence(),
    });
    expect(rule.id).toBe(`${SCENARIO_A}|agent-browser-verify`);
  });

  test("createEmptyRulebook has version 1 and empty rules", () => {
    const rb = createEmptyRulebook(SESSION_ID, T0);
    expect(rb.version).toBe(1);
    expect(rb.sessionId).toBe(SESSION_ID);
    expect(rb.createdAt).toBe(T0);
    expect(rb.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("rulebookPath", () => {
  test("sits next to routing policy path", () => {
    const path = rulebookPath("/test/project");
    expect(path).toContain("vercel-plugin-routing-policy-");
    expect(path).toEndWith("-rulebook.json");
  });

  test("different project roots produce different paths", () => {
    const a = rulebookPath("/project/a");
    const b = rulebookPath("/project/b");
    expect(a).not.toBe(b);
  });

  test("same project root produces same path", () => {
    const a = rulebookPath("/project/same");
    const b = rulebookPath("/project/same");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON contract example (from task spec)
// ---------------------------------------------------------------------------

describe("canonical JSON contract", () => {
  test("matches the specified contract shape", () => {
    const rulebook: LearnedRoutingRulebook = {
      version: 1,
      createdAt: "2026-03-28T08:15:00.000Z",
      sessionId: "sess_123",
      rules: [
        {
          id: "PreToolUse|flow-verification|uiRender|Bash|agent-browser-verify",
          scenario: "PreToolUse|flow-verification|uiRender|Bash",
          skill: "agent-browser-verify",
          action: "promote",
          boost: 8,
          confidence: 0.93,
          reason: "replay verified: no regressions, learned routing matched winning skill",
          sourceSessionId: "sess_123",
          promotedAt: "2026-03-28T08:15:00.000Z",
          evidence: {
            baselineWins: 4,
            baselineDirectiveWins: 2,
            learnedWins: 4,
            learnedDirectiveWins: 2,
            regressionCount: 0,
          },
        },
      ],
    };

    // Round-trip through serialization
    const json = serializeRulebook(rulebook);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].action).toBe("promote");
    expect(parsed.rules[0].evidence.regressionCount).toBe(0);

    // Persist and reload
    saveRulebook(testProjectRoot, rulebook);
    const result = loadRulebook(testProjectRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rulebook).toEqual(rulebook);
  });
});
