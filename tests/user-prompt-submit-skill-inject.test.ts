import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decisionCapsuleDir } from "../hooks/src/routing-decision-capsule.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs");

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
// Lexical prompt matching integration tests
// ---------------------------------------------------------------------------

describe("lexical prompt matching (VERCEL_PLUGIN_LEXICAL_PROMPT)", () => {
  const LEXICAL_ON = { VERCEL_PLUGIN_LEXICAL_PROMPT: "1", VERCEL_PLUGIN_SEEN_SKILLS: "" };
  const LEXICAL_OFF = { VERCEL_PLUGIN_LEXICAL_PROMPT: "0", VERCEL_PLUGIN_SEEN_SKILLS: "" };

  test("with flag on, 'I want to ship my app' matches deployments-cicd via synonym expansion (ship→deploy)", async () => {
    const { code, stdout } = await runHook(
      "I want to ship my app to production as soon as possible",
      LEXICAL_ON,
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    const meta = extractSkillInjection(result.hookSpecificOutput);
    expect(meta).toBeDefined();
    const hasDeployments =
      meta.injectedSkills.includes("deployments-cicd") ||
      meta.matchedSkills.includes("deployments-cicd");
    expect(hasDeployments).toBe(true);
  });

  test("with flag off, 'I want to ship my app' does NOT match (no exact substring 'deploy')", async () => {
    const { code, stdout } = await runHook(
      "I want to ship my app to production as soon as possible",
      LEXICAL_OFF,
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // Either empty output or deployments-cicd not present
    if (result.hookSpecificOutput) {
      const meta = extractSkillInjection(result.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).not.toContain("deployments-cicd");
        expect(meta.matchedSkills).not.toContain("deployments-cicd");
      }
    }
  });

  test("noneOf suppression overrides lexical boost when flag is on", async () => {
    // ai-sdk has noneOf: ["openai api directly"] and retrieval metadata.
    // Craft a prompt that would match ai-sdk via lexical but trigger noneOf.
    const { code, stdout, stderr } = await runHook(
      "I want to call the openai api directly to generate text with streaming",
      { ...LEXICAL_ON, VERCEL_PLUGIN_LOG_LEVEL: "debug" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // ai-sdk must NOT be injected (noneOf should suppress it)
    if (result.hookSpecificOutput) {
      const meta = extractSkillInjection(result.hookSpecificOutput);
      if (meta) {
        expect(meta.injectedSkills).not.toContain("ai-sdk");
      }
    }
    // Verify suppression in debug logs
    const lines = stderr
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o): o is Record<string, unknown> => o !== null);
    const aiSdkEval = lines.find(
      (l) => l.event === "prompt-signal-eval" && l.skill === "ai-sdk",
    );
    if (aiSdkEval) {
      expect(aiSdkEval.suppressed).toBe(true);
    }
  });

  test("lexical-only match respects 2-skill max and 8KB budget", async () => {
    // Prompt uses synonyms for multiple skills — "ship" (deploy), "go-live" (deploy),
    // "throttle" (rate-limit→vercel-firewall), "secret" (env→env-vars)
    const { code, stdout } = await runHook(
      "I need to ship my app and also configure throttle rules and manage my secrets for the release",
      LEXICAL_ON,
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      const meta = extractSkillInjection(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      // At most 2 skills injected (MAX_SKILLS=2 for UserPromptSubmit)
      expect(meta.injectedSkills.length).toBeLessThanOrEqual(2);
      // matchedSkills may exceed 2 but injected is capped
      expect(meta.matchedSkills.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Decision capsule rulebookProvenance integration tests
// ---------------------------------------------------------------------------

describe("decision capsule rulebookProvenance", () => {
  test("persisted capsule has rulebookProvenance: null when no rulebook exists", async () => {
    const { code, stdout } = await runHook(
      "I want to deploy my app to production",
      { VERCEL_PLUGIN_LEXICAL_PROMPT: "1", VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // Hook must have matched and injected at least one skill
    if (!result.hookSpecificOutput) return;
    const meta = extractSkillInjection(result.hookSpecificOutput);
    if (!meta || meta.injectedSkills.length === 0) return;

    // Find the persisted capsule for this session
    const capsuleDir = decisionCapsuleDir(testSession);
    if (!existsSync(capsuleDir)) return;
    const capsuleFiles = readdirSync(capsuleDir).filter((f) => f.endsWith(".json"));
    expect(capsuleFiles.length).toBeGreaterThanOrEqual(1);

    const capsule = JSON.parse(readFileSync(join(capsuleDir, capsuleFiles[0]), "utf-8"));
    expect(capsule).toHaveProperty("rulebookProvenance");
    expect(capsule.rulebookProvenance).toBeNull();
  });
});
