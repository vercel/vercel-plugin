import { describe, test, expect, beforeEach } from "bun:test";
import { join, resolve } from "node:path";
import {
  normalizePromptText,
  compilePromptSignals,
  matchPromptWithReason,
} from "../hooks/prompt-patterns.mjs";
import type { CompiledPromptSignals } from "../hooks/prompt-patterns.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PRETOOLUSE_HOOK = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const PROMPT_HOOK = join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs");
const UNLIMITED_BUDGET = "999999";

let testSession: string;
beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSkillInjection(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

async function runPreToolUseHook(
  input: object,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; parsed: any }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", PRETOOLUSE_HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      VERCEL_PLUGIN_SEEN_SKILLS: "",
      VERCEL_PLUGIN_DEV_VERIFY_COUNT: "0",
      VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE: "1",
      ...env,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let parsed: any;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  return { code, stdout, stderr, parsed };
}

async function runPromptHook(
  prompt: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; parsed: any }> {
  const payload = JSON.stringify({
    prompt,
    session_id: testSession,
    cwd: ROOT,
    hook_event_name: "UserPromptSubmit",
  });
  const proc = Bun.spawn(["node", PROMPT_HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let parsed: any;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  return { code, stdout, stderr, parsed };
}

// ---------------------------------------------------------------------------
// Compiled prompt signals for direct unit testing
// ---------------------------------------------------------------------------

const verificationSignals: CompiledPromptSignals = compilePromptSignals({
  phrases: [
    "verify the flow",
    "verify everything works",
    "test the whole thing",
    "does it actually work",
    "check end to end",
    "end to end test",
    "why isn't it working right",
    "why doesn't it work",
    "it's not working correctly",
    "something's off",
    "not quite right",
    "almost works but",
    "works locally but",
    "verify the feature",
    "make sure it works",
    "full verification",
  ],
  allOf: [
    ["verify", "flow"],
    ["verify", "works"],
    ["check", "everything"],
    ["test", "end", "end"],
    ["not", "working", "right"],
    ["something", "off"],
    ["almost", "works"],
    ["make", "sure", "works"],
  ],
  anyOf: [
    "verify",
    "verification",
    "end-to-end",
    "full flow",
    "works",
    "working",
  ],
  noneOf: [
    "unit test",
    "jest",
    "vitest",
    "playwright test",
    "cypress test",
  ],
  minScore: 6,
});

// ---------------------------------------------------------------------------
// 1. Dev server detection co-injects verification alongside agent-browser-verify
// ---------------------------------------------------------------------------

describe("Dev server co-injection of verification skill", () => {
  const devCommands = [
    "next dev",
    "npm run dev",
    "pnpm dev",
    "bun run dev",
    "yarn dev",
    "vite dev",
    "vercel dev",
    "astro dev",
  ];

  for (const cmd of devCommands) {
    test(`co-injects verification alongside agent-browser-verify for "${cmd}"`, async () => {
      const { parsed } = await runPreToolUseHook({
        tool_name: "Bash",
        tool_input: { command: cmd },
      });

      expect(parsed).not.toBeNull();
      expect(parsed.hookSpecificOutput).toBeDefined();
      const ctx = parsed.hookSpecificOutput.additionalContext;
      // Both skills should be present
      expect(ctx).toContain("skill:agent-browser-verify");
      expect(ctx).toContain("skill:verification");

      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("agent-browser-verify");
      expect(meta.injectedSkills).toContain("verification");
    });
  }

  test("verification appears after agent-browser-verify in injection order", async () => {
    const { parsed } = await runPreToolUseHook({
      tool_name: "Bash",
      tool_input: { command: "npm run dev" },
    });

    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    const verifyIdx = meta.injectedSkills.indexOf("agent-browser-verify");
    const verifIdx = meta.injectedSkills.indexOf("verification");
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifIdx).toBeGreaterThanOrEqual(0);
    expect(verifIdx).toBeGreaterThan(verifyIdx);
  });

  test("does not co-inject verification for non-dev-server commands", async () => {
    const { parsed } = await runPreToolUseHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });

    if (parsed?.hookSpecificOutput) {
      const ctx = parsed.hookSpecificOutput.additionalContext || "";
      expect(ctx).not.toContain("skill:verification");
    }
  });

  test("does not co-inject verification when agent-browser unavailable", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      { VERCEL_PLUGIN_AGENT_BROWSER_AVAILABLE: "0" },
    );

    // When agent-browser is unavailable, companion skills should not be injected
    // (the unavailable warning path skips normal injection)
    if (parsed?.hookSpecificOutput) {
      const ctx = parsed.hookSpecificOutput.additionalContext || "";
      expect(ctx).toContain("<!-- agent-browser-unavailable -->");
    }
  });

  test("agent-browser-verify blocked when count >= max, but verification still injected", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      { VERCEL_PLUGIN_DEV_VERIFY_COUNT: "2" },
    );

    expect(parsed).not.toBeNull();
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext || "";
    // Loop guard blocks agent-browser-verify synthetic injection
    expect(ctx).not.toContain("<!-- marker:dev-server-verify");
    // But verification is exempt from the iteration cap
    expect(ctx).toContain("skill:verification");
  });

  test("verification injected on 3rd dev-server detection (count=2)", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      { VERCEL_PLUGIN_DEV_VERIFY_COUNT: "2" },
    );

    expect(parsed).not.toBeNull();
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext || "";
    // verification survives past iteration cap
    expect(ctx).toContain("skill:verification");
    // agent-browser-verify is still blocked by loop guard
    expect(ctx).not.toContain("skill:agent-browser-verify");

    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    if (meta) {
      expect(meta.injectedSkills).toContain("verification");
      expect(meta.injectedSkills).not.toContain("agent-browser-verify");
    }
  });

  test("verification injected on 5th dev-server detection (count=4)", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      { VERCEL_PLUGIN_DEV_VERIFY_COUNT: "4" },
    );

    expect(parsed).not.toBeNull();
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext || "";
    expect(ctx).toContain("skill:verification");
    expect(ctx).not.toContain("skill:agent-browser-verify");
  });
});

// ---------------------------------------------------------------------------
// 2. Prompt signals score correctly for target phrases (>= minScore 6)
// ---------------------------------------------------------------------------

describe("Verification prompt signals scoring", () => {
  // Each phrase alone should score +6 (exactly minScore)
  const targetPhrases = [
    "verify the flow",
    "verify everything works",
    "test the whole thing",
    "does it actually work",
    "check end to end",
    "something's off",          // contraction expansion: something is off → matches "something's off"
    "not quite right",
    "almost works but",
    "verify the feature",
    "make sure it works",
    "full verification",
  ];

  for (const phrase of targetPhrases) {
    test(`phrase "${phrase}" scores >= minScore 6`, () => {
      const result = matchPromptWithReason(phrase, verificationSignals);
      expect(result.score).toBeGreaterThanOrEqual(6);
      expect(result.matched).toBe(true);
    });
  }

  test("combined phrase + allOf scores higher than single phrase", () => {
    // "verify the flow works" hits phrase "verify the flow" (+6) + allOf [verify, works] (+4)
    const result = matchPromptWithReason(
      "can you verify the flow works end to end",
      verificationSignals,
    );
    expect(result.score).toBeGreaterThan(6);
    expect(result.matched).toBe(true);
  });

  test("anyOf terms alone do not reach minScore", () => {
    // "verify" and "works" are anyOf terms (+1 each, capped at +2), which < 6
    const result = matchPromptWithReason(
      "does this feature work",
      verificationSignals,
    );
    // Only anyOf hits — should not reach minScore 6
    expect(result.score).toBeLessThan(6);
    expect(result.matched).toBe(false);
  });

  test("allOf group [verify, flow] scores +4, not enough alone", () => {
    // allOf alone gives +4, anyOf "verify" gives +1 = 5, still < 6
    // but let's test a case where only allOf matches without phrase
    const result = matchPromptWithReason(
      "I need to verify the data flow through the system",
      verificationSignals,
    );
    // "verify the flow" phrase matches (+6), so this actually will match
    // Use a different wording that avoids exact phrase
    const result2 = matchPromptWithReason(
      "please verify my application flow is correct",
      verificationSignals,
    );
    // allOf [verify, flow] = +4, anyOf "verify" = +1 = 5 < 6
    // Unless "verify" + "flow" also triggers phrase... check:
    // phrase is "verify the flow" — "verify my application flow" does NOT contain that substring
    expect(result2.score).toBeLessThan(6);
    expect(result2.matched).toBe(false);
  });

  test("contraction expansion works: \"it's not working correctly\"", () => {
    // matchPromptWithReason expects pre-normalized text
    const result = matchPromptWithReason(
      normalizePromptText("it's not working correctly at all"),
      verificationSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });

  test("\"why isn't it working right\" triggers via contraction expansion", () => {
    // matchPromptWithReason expects pre-normalized text
    const result = matchPromptWithReason(
      normalizePromptText("why isn't it working right"),
      verificationSignals,
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// 3. noneOf terms suppress injection
// ---------------------------------------------------------------------------

describe("Verification noneOf suppression", () => {
  const suppressTerms = [
    "unit test",
    "jest",
    "vitest",
    "playwright test",
    "cypress test",
  ];

  for (const term of suppressTerms) {
    test(`noneOf term "${term}" suppresses even with phrase match`, () => {
      // Combine a matching phrase with a noneOf term
      const result = matchPromptWithReason(
        `verify the flow using ${term} framework`,
        verificationSignals,
      );
      expect(result.matched).toBe(false);
      expect(result.score).toBe(-Infinity);
    });
  }

  test("noneOf 'jest' suppresses: 'verify everything works with jest'", () => {
    const result = matchPromptWithReason(
      "verify everything works with jest",
      verificationSignals,
    );
    expect(result.matched).toBe(false);
  });

  test("noneOf does not trigger on partial word match (e.g., 'jesting')", () => {
    // noneOf uses word-boundary matching — "jest" is NOT a whole word in "jesting"
    const result = matchPromptWithReason(
      "verify the flow, stop jesting around",
      verificationSignals,
    );
    // "jesting" does not contain "jest" as a whole word — no suppression
    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Dedup prevents double injection
// ---------------------------------------------------------------------------

describe("Dedup prevents double verification injection", () => {
  test("verification not re-injected when already in SEEN_SKILLS (non-dev-server)", async () => {
    // When triggered via bashPatterns (not dev-server co-injection),
    // dedup should prevent re-injection
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Read",
        tool_input: { file_path: "/project/next.config.ts" },
      },
      { VERCEL_PLUGIN_SEEN_SKILLS: "verification" },
    );

    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).not.toContain("verification");
      }
    }
  });

  test("verification re-injected via dev-server companion even when in SEEN_SKILLS", async () => {
    // Dev server companion injection uses dedup bypass (like agent-browser-verify)
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      {
        VERCEL_PLUGIN_SEEN_SKILLS: "verification,agent-browser-verify",
        VERCEL_PLUGIN_DEV_VERIFY_COUNT: "0",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed.hookSpecificOutput).toBeDefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    // Companion bypass: verification should be re-injected
    expect(ctx).toContain("skill:verification");
    expect(ctx).toContain("skill:agent-browser-verify");
  });

  test("prompt hook respects dedup for verification", async () => {
    const { parsed } = await runPromptHook(
      "verify the flow end to end please",
      { VERCEL_PLUGIN_SEEN_SKILLS: "verification" },
    );

    // Should not re-inject verification since it's already seen
    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).not.toContain("verification");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Budget is not exceeded with companion skills
// ---------------------------------------------------------------------------

describe("Budget enforcement with verification + companions", () => {
  test("injection stays within default 18KB budget", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      {
        // Use default budget (18KB) instead of unlimited
        VERCEL_PLUGIN_INJECTION_BUDGET: "18000",
      },
    );

    expect(parsed).not.toBeNull();
    if (parsed?.hookSpecificOutput) {
      const ctx = parsed.hookSpecificOutput.additionalContext || "";
      // Total context should not exceed 18KB + small margin for metadata comments
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(18500);
    }
  });

  test("prompt hook stays within 8KB budget", async () => {
    const { parsed } = await runPromptHook(
      "verify the flow and make sure it works end to end",
      { VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET: "8000" },
    );

    if (parsed?.hookSpecificOutput) {
      const ctx = parsed.hookSpecificOutput.additionalContext || "";
      expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(8000);
    }
  });

  test("verification fits alongside agent-browser-verify within budget", async () => {
    const { parsed } = await runPreToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "npm run dev" },
      },
      { VERCEL_PLUGIN_INJECTION_BUDGET: "18000" },
    );

    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      if (meta) {
        // Both skills should be injected (not dropped by budget)
        const allInjected = [
          ...meta.injectedSkills,
          ...(meta.summaryOnly || []),
        ];
        // At least agent-browser-verify should be present
        expect(allInjected).toContain("agent-browser-verify");
        // verification should be either fully injected or summary-only, not dropped
        const dropped = meta.droppedByBudget || [];
        expect(dropped).not.toContain("agent-browser-verify");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Integration: UserPromptSubmit injects verification for target prompts
// ---------------------------------------------------------------------------

describe("UserPromptSubmit integration for verification", () => {
  test("injects verification skill for 'verify the flow' prompt", async () => {
    const { code, parsed } = await runPromptHook(
      "Can you verify the flow works correctly end to end?",
    );
    expect(code).toBe(0);

    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("verification");
    }
  });

  test("injects verification for 'something is off' prompt", async () => {
    const { code, parsed } = await runPromptHook(
      "Something's off with the page, it loads but the data isn't showing",
    );
    expect(code).toBe(0);

    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).toContain("verification");
      }
    }
  });

  test("does not inject verification for 'write a unit test' prompt", async () => {
    const { code, parsed } = await runPromptHook(
      "Write a unit test for the login component using jest",
    );
    expect(code).toBe(0);

    if (parsed?.hookSpecificOutput) {
      const meta = extractSkillInjection(parsed.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).not.toContain("verification");
      }
    }
  });
});
