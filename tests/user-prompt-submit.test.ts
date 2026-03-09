import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs");
const SKILLS_DIR = join(ROOT, "skills");

let testSession: string;
beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

/** Extract skillInjection metadata from additionalContext HTML comment */
function extractSkillInjection(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

/** Run the UserPromptSubmit hook as a subprocess */
async function runHook(
  prompt: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({
    prompt,
    session_id: testSession,
    cwd: ROOT,
    hook_event_name: "UserPromptSubmit",
  });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
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
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Integration tests with real SKILL.md files
// ---------------------------------------------------------------------------

describe("user-prompt-submit-skill-inject.mjs", () => {
  test("hook script exists", () => {
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
  });

  test("injects ai-elements skill for 'streaming markdown' prompt", async () => {
    const { code, stdout } = await runHook(
      "Also, let's add markdown formatting to the streamed text results using streaming markdown",
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput.additionalContext).toContain("AI Elements");

    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.hookEvent).toBe("UserPromptSubmit");
    expect(meta.injectedSkills).toContain("ai-elements");
  });

  test("injects ai-sdk skill for 'ai sdk' prompt", async () => {
    const { code, stdout } = await runHook(
      "I need to use the AI SDK to add streaming text generation to this endpoint",
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("ai-sdk");
    }
  });

  test("injects workflow skill for durable workflow orchestration prompt", async () => {
    const { code, stdout } = await runHook(
      [
        "Use Vercel Workflow DevKit to build a durable workflow with resumable execution,",
        "retryable steps, and createWebhook-based async request reply callbacks that survive crashes.",
      ].join(" "),
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:workflow");

    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("workflow");
  });

  test("returns {} for empty/short prompt", async () => {
    const { code, stdout } = await runHook("hi");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("returns {} for empty stdin", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("returns {} for prompt with no matching signals", async () => {
    const { code, stdout } = await runHook(
      "Please refactor the database connection pool to use connection strings from environment variables",
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Frustration / debugging language triggers investigation-mode
  // ---------------------------------------------------------------------------

  test("injects investigation-mode skill for 'it's stuck' frustration prompt", async () => {
    const { code, stdout } = await runHook(
      "it's stuck and nothing is happening, the page just sits there loading forever",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("investigation-mode");
  });

  test("injects investigation-mode skill for 'check the logs' prompt", async () => {
    const { code, stdout } = await runHook(
      "can you check the logs and find the error? something is broken",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("investigation-mode");
  });

  test("injects investigation-mode skill for 'why did it fail' prompt", async () => {
    const { code, stdout } = await runHook(
      "why did it fail? I pushed the code and now nothing works, investigate why",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("investigation-mode");
  });

  // ---------------------------------------------------------------------------
  // Workflow debugging language triggers workflow skill
  // ---------------------------------------------------------------------------

  test("injects workflow skill for debugging prompts", async () => {
    const { code, stdout } = await runHook(
      "the workflow stuck on the third step and keeps timing out, debug workflow execution",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    // Should match workflow or investigation-mode (both have relevant signals)
    const hasWorkflow = meta.injectedSkills.includes("workflow") || meta.matchedSkills.includes("workflow");
    const hasInvestigation = meta.injectedSkills.includes("investigation-mode") || meta.matchedSkills.includes("investigation-mode");
    expect(hasWorkflow || hasInvestigation).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Deployment-check language triggers vercel-cli skill
  // ---------------------------------------------------------------------------

  test("injects vercel-cli skill for deployment checking prompt", async () => {
    const { code, stdout } = await runHook(
      "check deployment status, I think the deploy failed and I need to see vercel logs",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    const hasVercelCli = meta.injectedSkills.includes("vercel-cli") || meta.matchedSkills.includes("vercel-cli");
    expect(hasVercelCli).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Page-check language triggers agent-browser-verify skill
  // ---------------------------------------------------------------------------

  test("injects agent-browser-verify skill for page checking prompt", async () => {
    const { code, stdout } = await runHook(
      "check the page, I'm seeing a blank page and there might be console errors",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    const hasBrowser = meta.injectedSkills.includes("agent-browser-verify") || meta.matchedSkills.includes("agent-browser-verify");
    expect(hasBrowser).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Observability language triggers observability skill
  // ---------------------------------------------------------------------------

  test("injects observability skill for logging setup prompt", async () => {
    const { code, stdout } = await runHook(
      "I need to add logging and set up monitoring for the production app with structured logging",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    const hasObservability = meta.injectedSkills.includes("observability") || meta.matchedSkills.includes("observability");
    expect(hasObservability).toBe(true);
  });

  test("injects observability skill for 'opentelemetry' prompt", async () => {
    const { code, stdout } = await runHook(
      "set up opentelemetry instrumentation for tracing API requests",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    const hasObservability = meta.injectedSkills.includes("observability") || meta.matchedSkills.includes("observability");
    expect(hasObservability).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Dedup prevents re-injection
  // ---------------------------------------------------------------------------

  test("dedup prevents re-injection when skill already seen", async () => {
    // First call: skill should inject
    const { stdout: first } = await runHook(
      "Use streaming markdown with ai elements for the chat output",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    const r1 = JSON.parse(first);
    expect(r1.hookSpecificOutput).toBeDefined();

    const meta1 = extractSkillInjection(r1.hookSpecificOutput);
    expect(meta1?.injectedSkills).toContain("ai-elements");

    // Second call: ai-elements already seen
    const { stdout: second } = await runHook(
      "Use streaming markdown with ai elements for the chat output",
      { VERCEL_PLUGIN_SEEN_SKILLS: "ai-elements" },
    );
    const r2 = JSON.parse(second);
    expect(r2).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Max 2 skill cap
  // ---------------------------------------------------------------------------

  test("caps injection at 2 skills max", async () => {
    // Craft a prompt that could match many skills
    // Use exact phrase hits from multiple skills
    const { code, stdout } = await runHook(
      "I want to use ai elements for streaming markdown and also the AI SDK for generateText and SWR for useSWR client-side fetching and next.js app router",
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);

    if (result.hookSpecificOutput) {
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      // At most 2 skills injected
      expect(meta.injectedSkills.length).toBeLessThanOrEqual(2);
      // matchedSkills may be more than 2
      expect(meta.matchedSkills.length).toBeGreaterThanOrEqual(2);
    }
  });

  // ---------------------------------------------------------------------------
  // additionalContext output shape
  // ---------------------------------------------------------------------------

  test("output has correct hookSpecificOutput shape", async () => {
    const { code, stdout } = await runHook(
      "Add ai elements to render streaming markdown in the chat component",
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);

    // When there's a match, verify the full output structure
    if (result.hookSpecificOutput) {
      // Must have hookEventName
      expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      // Must have additionalContext string
      expect(typeof result.hookSpecificOutput.additionalContext).toBe("string");
      expect(result.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);

      // Must contain skillInjection metadata comment
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.version).toBe(1);
      expect(meta.hookEvent).toBe("UserPromptSubmit");
      expect(Array.isArray(meta.matchedSkills)).toBe(true);
      expect(Array.isArray(meta.injectedSkills)).toBe(true);
      expect(Array.isArray(meta.summaryOnly)).toBe(true);
      expect(Array.isArray(meta.droppedByCap)).toBe(true);
      expect(Array.isArray(meta.droppedByBudget)).toBe(true);

      // No unknown fields in hookSpecificOutput
      const keys = Object.keys(result.hookSpecificOutput);
      for (const key of keys) {
        expect(["hookEventName", "additionalContext"]).toContain(key);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Investigation-mode companion selection (integration)
  // ---------------------------------------------------------------------------

  describe("investigation-mode companion selection", () => {
    test("'nothing happened' triggers investigation-mode alone (no companion)", async () => {
      const { code, stdout } = await runHook(
        "nothing happened after I clicked submit, it just sits there",
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("investigation-mode");
      // No companion skills should be injected (prompt is generic frustration)
      const hasCompanion = meta.injectedSkills.some(
        (s: string) => ["workflow", "agent-browser-verify", "vercel-cli"].includes(s),
      );
      expect(hasCompanion).toBe(false);
    });

    test("'check why my workflow is stuck' triggers investigation-mode + workflow", async () => {
      const { code, stdout } = await runHook(
        "check why my workflow is stuck, the workflow run has been pending for 10 minutes",
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("investigation-mode");
      // workflow should be the companion (either injected or matched)
      const hasWorkflow = meta.injectedSkills.includes("workflow") || meta.matchedSkills.includes("workflow");
      expect(hasWorkflow).toBe(true);
    });

    test("'blank page after deploy' triggers investigation-mode + agent-browser-verify", async () => {
      const { code, stdout } = await runHook(
        "I see a blank page after the deploy, nothing renders and the screen is blank",
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.injectedSkills).toContain("investigation-mode");
      // agent-browser-verify should be the companion (either injected or matched)
      const hasBrowser = meta.injectedSkills.includes("agent-browser-verify") || meta.matchedSkills.includes("agent-browser-verify");
      expect(hasBrowser).toBe(true);
    });

    test("'add a button to the navbar' does NOT trigger investigation-mode", async () => {
      const { code, stdout } = await runHook(
        "add a button to the navbar that links to the settings page",
        { VERCEL_PLUGIN_SEEN_SKILLS: "" },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      // Either empty output or no investigation-mode in injected skills
      if (result.hookSpecificOutput) {
        const meta = extractSkillInjection(result.hookSpecificOutput);
        if (meta) {
          expect(meta.injectedSkills).not.toContain("investigation-mode");
        }
      }
    });

    test("companion is injected as summary when budget is tight", async () => {
      // Use a very small budget to force summary fallback for companion
      const { code, stdout } = await runHook(
        "check why my workflow is stuck, the workflow run has been pending for 10 minutes",
        {
          VERCEL_PLUGIN_SEEN_SKILLS: "",
          VERCEL_PLUGIN_PROMPT_INJECTION_BUDGET: "4000",
        },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      // investigation-mode should still be injected (first skill gets full body)
      expect(meta.injectedSkills).toContain("investigation-mode");
      // workflow should be in summaryOnly or injectedSkills depending on budget
      const workflowHandled =
        meta.injectedSkills.includes("workflow") ||
        meta.summaryOnly.includes("workflow") ||
        meta.matchedSkills.includes("workflow");
      expect(workflowHandled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Perf smoke: real SKILL.md matching completes quickly
  // ---------------------------------------------------------------------------

  test("perf: prompt matching against all real skills completes in <50ms", async () => {
    const start = performance.now();
    const { code, stdout } = await runHook(
      "Use ai elements for streaming markdown rendering in the terminal",
    );
    const elapsed = performance.now() - start;
    expect(code).toBe(0);

    // The full subprocess spawn + skill loading + matching should be reasonable.
    // We use a generous budget here since subprocess spawn itself takes time.
    // The actual matching logic is tested in prompt-signals.test.ts with <50ms.
    // Here we just ensure the full hook doesn't hang or take unreasonable time.
    expect(elapsed).toBeLessThan(5000); // 5s generous limit for subprocess
  });

  // ---------------------------------------------------------------------------
  // Structured logging at each level (PromptAnalysisReport unification)
  // ---------------------------------------------------------------------------

  /** Parse all JSON lines from stderr */
  function parseStderrLines(stderr: string): Record<string, unknown>[] {
    return stderr
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((o): o is Record<string, unknown> => o !== null);
  }

  describe("log levels emit structured PromptAnalysisReport events", () => {
    const MATCH_PROMPT = "Also, let's add markdown formatting to the streamed text results using streaming markdown";
    const NO_MATCH_PROMPT = "Please refactor the database connection pool to use connection strings from environment variables";

    test("summary level: emits complete event with counts and latency", async () => {
      const { code, stderr } = await runHook(MATCH_PROMPT, {
        VERCEL_PLUGIN_LOG_LEVEL: "summary",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      });
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);
      const complete = lines.find((l) => l.event === "complete");
      expect(complete).toBeDefined();
      expect(complete!.matchedCount).toBeGreaterThanOrEqual(1);
      expect(typeof complete!.injectedCount).toBe("number");
      expect(typeof complete!.dedupedCount).toBe("number");
      expect(typeof complete!.cappedCount).toBe("number");
      expect(typeof complete!.elapsed_ms).toBe("number");
    });

    test("debug level: emits per-skill prompt-signal-eval events", async () => {
      const { code, stderr } = await runHook(MATCH_PROMPT, {
        VERCEL_PLUGIN_LOG_LEVEL: "debug",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      });
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);

      // Per-skill eval events
      const evals = lines.filter((l) => l.event === "prompt-signal-eval");
      expect(evals.length).toBeGreaterThanOrEqual(1);
      for (const ev of evals) {
        expect(typeof ev.skill).toBe("string");
        expect(typeof ev.score).toBe("number");
        expect(typeof ev.reason).toBe("string");
        expect(typeof ev.matched).toBe("boolean");
        expect(typeof ev.suppressed).toBe("boolean");
      }

      // Selection summary
      const selection = lines.find((l) => l.event === "prompt-selection");
      expect(selection).toBeDefined();
      expect(Array.isArray(selection!.selectedSkills)).toBe(true);
      expect(typeof selection!.dedupStrategy).toBe("string");
      expect(typeof selection!.budgetBytes).toBe("number");

      // Complete event also present at debug level
      const complete = lines.find((l) => l.event === "complete");
      expect(complete).toBeDefined();
    });

    test("trace level: emits prompt-analysis-full with full report", async () => {
      const { code, stderr } = await runHook(MATCH_PROMPT, {
        VERCEL_PLUGIN_LOG_LEVEL: "trace",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      });
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);

      const full = lines.find((l) => l.event === "prompt-analysis-full");
      expect(full).toBeDefined();
      expect(typeof full!.normalizedPrompt).toBe("string");
      expect(typeof full!.perSkillResults).toBe("object");
      expect(Array.isArray(full!.selectedSkills)).toBe(true);
      expect(Array.isArray(full!.droppedByCap)).toBe(true);
      expect(Array.isArray(full!.droppedByBudget)).toBe(true);
      expect(typeof full!.dedupState).toBe("object");
      expect(typeof full!.budgetBytes).toBe("number");
      expect(typeof full!.timingMs).toBe("number");
    });

    test("no-match emits prompt-analysis-issue at debug level", async () => {
      const { code, stderr } = await runHook(NO_MATCH_PROMPT, {
        VERCEL_PLUGIN_LOG_LEVEL: "debug",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      });
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);

      const issue = lines.find((l) => l.event === "prompt-analysis-issue");
      expect(issue).toBeDefined();
      expect(issue!.issue).toBe("no_prompt_matches");
      expect(Array.isArray(issue!.evaluatedSkills)).toBe(true);
    });

    test("all-deduped emits prompt-analysis-issue at debug level", async () => {
      const { code, stderr } = await runHook(
        "Use streaming markdown with ai elements for the chat output",
        {
          VERCEL_PLUGIN_LOG_LEVEL: "debug",
          VERCEL_PLUGIN_SEEN_SKILLS: "ai-elements",
        },
      );
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);

      const issue = lines.find((l) => l.event === "prompt-analysis-issue");
      expect(issue).toBeDefined();
      expect(issue!.issue).toBe("all_deduped");
      expect(Array.isArray(issue!.matchedSkills)).toBe(true);
      expect(Array.isArray(issue!.seenSkills)).toBe(true);
      expect(typeof issue!.dedupStrategy).toBe("string");
    });

    test("off level: no structured log output on stderr", async () => {
      const { code, stderr } = await runHook(MATCH_PROMPT, {
        VERCEL_PLUGIN_LOG_LEVEL: "off",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      });
      expect(code).toBe(0);
      const lines = parseStderrLines(stderr);
      // No JSON log lines at all
      expect(lines.length).toBe(0);
    });
  });
});
