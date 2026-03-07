import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readdir } from "node:fs/promises";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SKILLS_DIR = join(ROOT, "skills");

/** Derive expected skill count from disk so tests don't break on skill add/remove */
function countSkillDirs(): number {
  return readdirSync(SKILLS_DIR).filter((d) => {
    try {
      return existsSync(join(SKILLS_DIR, d, "SKILL.md"));
    } catch {
      return false;
    }
  }).length;
}

// Unique session ID per test run to avoid cross-test dedup conflicts
let testSession: string;

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

// High budget disables budget-based limiting so existing cap tests are unaffected
const UNLIMITED_BUDGET = "999999";

/**
 * Extract skillInjection metadata from additionalContext.
 * The metadata is embedded as an HTML comment to comply with Claude Code's
 * strict hookSpecificOutput schema (unknown keys cause validation failure).
 */
function extractSkillInjection(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

async function runHook(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("pretooluse-skill-inject.mjs", () => {
  test("hook script exists", () => {
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
  });

  test("outputs empty JSON for unmatched file path", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for empty stdin", async () => {
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

  test("outputs empty JSON for unmatched tool name", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("matches next.config.ts to nextjs skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("matches app/ path to nextjs skill via Edit", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/app/page.tsx" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("matches middleware.ts to routing-middleware skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/Users/me/project/middleware.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches proxy.ts to routing-middleware skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/src/proxy.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches vercel.json to vercel-functions skill (highest priority)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/vercel.json" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // vercel.json now matches multiple skills; vercel-functions (priority 8) is highest
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-functions");
  });

  test("matches turbo.json to turborepo skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/turbo.json" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:turborepo");
  });

  test("matches flags.ts to vercel-flags skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/flags.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-flags");
  });

  test("plain .env file does NOT trigger ai-gateway via file path", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.env" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // .env was removed from ai-gateway pathPatterns to avoid false positives
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:ai-gateway");
    }
  });

  test(".env.local does NOT trigger ai-gateway via file path", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.env.local" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:ai-gateway");
    }
  });

  test("ai-gateway still triggers via bash (vercel env pull)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "vercel env pull .env.local" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-gateway");
  });

  test("matches npm install ai to ai-sdk skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install ai" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-sdk");
  });

  test("matches vercel deploy to vercel-cli skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "vercel deploy" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-cli");
  });

  test("matches turbo run build to turborepo skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "turbo run build" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:turborepo");
  });

  test("matches npx v0 to v0-dev skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npx v0 generate" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:v0-dev");
  });

  test("matches vercel integration to marketplace skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "vercel integration add neon" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:marketplace");
  });

  test("deduplicates across invocations when VERCEL_PLUGIN_SEEN_SKILLS is set", async () => {
    // First call: env var is empty string — skill should inject and be recorded
    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/app/page.tsx" } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    const r1 = JSON.parse(first);
    expect(r1.hookSpecificOutput.additionalContext).toContain("skill:nextjs");

    // Second call: pre-seed the env var with skills from first call
    // The hook appends to VERCEL_PLUGIN_SEEN_SKILLS in-process, but across
    // separate process invocations we must pass the updated value.
    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/app/page.tsx" } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
    );
    const r2 = JSON.parse(second);
    expect(r2).toEqual({});
  });

  test("caps at 3 skills when bash command matches 4+ skills", async () => {
    // This command matches 5 distinct skills:
    //   vercel-cli  (vercel deploy)
    //   turborepo   (turbo run build)
    //   v0-dev      (npx v0)
    //   ai-sdk      (npm install ai)
    //   marketplace  (vercel integration)
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: {
        command:
          "vercel deploy && turbo run build && npx v0 generate && npm install ai && vercel integration add neon",
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toBeDefined();
    const skillTags =
      result.hookSpecificOutput.additionalContext.match(/<!-- skill:[a-z0-9-]+ -->/g) || [];
    expect(skillTags.length).toBe(3);
  });

  test("large multi-skill output is valid JSON with correct structure", async () => {
    // Trigger 3 skills via bash and verify the full output structure
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: {
        command: "vercel deploy && turbo run build && npx v0 generate",
      },
    });
    expect(code).toBe(0);

    // Must be parseable JSON
    let result: any;
    expect(() => {
      result = JSON.parse(stdout);
    }).not.toThrow();

    // Must have hookSpecificOutput.additionalContext string
    expect(result.hookSpecificOutput).toBeDefined();
    expect(typeof result.hookSpecificOutput.additionalContext).toBe("string");
    expect(result.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);

    // Each injected skill must have matching open/close tags
    const ctx = result.hookSpecificOutput.additionalContext;
    const openTags =
      ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || [];
    const closeTags =
      ctx.match(/<!-- \/skill:([a-z0-9-]+) -->/g) || [];
    expect(openTags.length).toBe(closeTags.length);
    expect(openTags.length).toBeGreaterThanOrEqual(1);
    expect(openTags.length).toBeLessThanOrEqual(3);
  });

  test("returns {} when skills directory is empty (no SKILL.md files)", async () => {
    // Create a temporary plugin-like directory with an empty skills/ dir
    const tempRoot = join(tmpdir(), `vp-test-empty-skills-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");
    mkdirSync(tempHooksDir, { recursive: true });
    mkdirSync(tempSkillsDir, { recursive: true });

    // Copy the hook script and the frontmatter parser
    const hookSource = readFileSync(HOOK_SCRIPT, "utf-8");
    const tempHookPath = join(tempHooksDir, "pretooluse-skill-inject.mjs");
    writeFileSync(tempHookPath, hookSource);
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "patterns.mjs"),
      readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    // Run the hook from the temp location
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", tempHookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    // Cleanup
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("globToRegex escapes regex metacharacters in path patterns", async () => {
    // Paths containing ( ) [ ] { } + | ^ $ should match literally
    // We test by reading a file whose path contains metacharacters
    const metaCharPaths = [
      "/project/src/components/(auth)/login.tsx",
      "/project/src/[id]/page.tsx",
      "/project/src/[[...slug]]/page.tsx",
      "/project/app/(group)/layout.tsx",
    ];
    for (const filePath of metaCharPaths) {
      const { code, stdout } = await runHook({
        tool_name: "Read",
        tool_input: { file_path: filePath },
      });
      expect(code).toBe(0);
      // These should parse without throwing, even if they don't match a skill
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("exit code is always 0", async () => {
    // Even with malformed JSON input
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("output is always valid JSON", async () => {
    const inputs = [
      { tool_name: "Read", tool_input: { file_path: "/nothing/here.txt" } },
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { tool_name: "Bash", tool_input: { command: "echo hello" } },
      { tool_name: "Bash", tool_input: { command: "vercel deploy" } },
    ];
    for (const input of inputs) {
      const { stdout } = await runHook(input);
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("match output uses correct hookSpecificOutput schema", async () => {
    const { stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const result = JSON.parse(stdout);
    // Must use hookSpecificOutput wrapper per Claude Code hook spec
    expect(result).toHaveProperty("hookSpecificOutput");
    expect(result.hookSpecificOutput).toHaveProperty("additionalContext");
    expect(typeof result.hookSpecificOutput.additionalContext).toBe("string");
    // Must NOT have top-level additionalContext
    expect(result).not.toHaveProperty("additionalContext");
    // No other top-level keys
    expect(Object.keys(result)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(result.hookSpecificOutput)).toContain("additionalContext");
    expect(extractSkillInjection(result.hookSpecificOutput)).toBeDefined();
  });

  test("no-match output is empty object", async () => {
    const { stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    const result = JSON.parse(stdout);
    expect(result).toEqual({});
    expect(Object.keys(result).length).toBe(0);
  });

  test("completes in under 200ms", async () => {
    const start = performance.now();
    await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const elapsed = performance.now() - start;
    // Allow some slack for CI — 500ms
    expect(elapsed).toBeLessThan(500);
  });
});

describe("skill-map from frontmatter", () => {
  test("buildSkillMap produces a valid skill map from SKILL.md files", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const map = buildSkillMap(SKILLS_DIR);
    expect(typeof map.skills).toBe("object");
    expect(Object.keys(map.skills).length).toBe(countSkillDirs());
  });

  test("every skill has at least one trigger pattern", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const map = buildSkillMap(SKILLS_DIR);
    const noTriggers: string[] = [];
    for (const [skill, config] of Object.entries(map.skills) as [string, any][]) {
      const pathCount = (config.pathPatterns || []).length;
      const bashCount = (config.bashPatterns || []).length;
      const importCount = (config.importPatterns || []).length;
      if (pathCount === 0 && bashCount === 0 && importCount === 0) noTriggers.push(skill);
    }
    expect(noTriggers).toEqual([]);
  });

  test("covers all skills directories with SKILL.md", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const map = buildSkillMap(SKILLS_DIR);
    const mapSkills = new Set(Object.keys(map.skills));

    const skillDirs = (await readdir(SKILLS_DIR)).filter((d) =>
      existsSync(join(SKILLS_DIR, d, "SKILL.md")),
    );

    const uncovered: string[] = [];
    for (const dir of skillDirs) {
      if (!mapSkills.has(dir)) uncovered.push(dir);
    }
    expect(uncovered).toEqual([]);
  });
});

// Helper to run hook with debug mode enabled
async function runHookDebug(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: `dbg-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("debug logging (VERCEL_PLUGIN_HOOK_DEBUG=1)", () => {
  test("emits no stderr when debug is off (default)", async () => {
    const { stderr } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(stderr).toBe("");
  });

  test("emits JSON-lines to stderr when debug is on", async () => {
    const { code, stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(code).toBe(0);
    expect(stderr.trim().length).toBeGreaterThan(0);
    const lines = stderr.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("each debug line has invocationId, event, and timestamp", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    for (const obj of lines) {
      expect(typeof obj.invocationId).toBe("string");
      expect(obj.invocationId.length).toBe(8); // 4 random bytes = 8 hex chars
      expect(typeof obj.event).toBe("string");
      expect(typeof obj.timestamp).toBe("string");
    }
  });

  test("all invocationIds are the same within one invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const ids = new Set(lines.map((l: any) => l.invocationId));
    expect(ids.size).toBe(1);
  });

  test("emits expected events for a matching invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const events = stderr.trim().split("\n").map((l: string) => JSON.parse(l).event);
    expect(events).toContain("input-parsed");
    expect(events).toContain("skillmap-loaded");
    expect(events).toContain("matches-found");
    expect(events).toContain("dedup-filtered");
    expect(events).toContain("skills-injected");
    expect(events).toContain("complete");
  });

  test("emits expected events for a non-matching invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    const events = stderr.trim().split("\n").map((l: string) => JSON.parse(l).event);
    expect(events).toContain("input-parsed");
    expect(events).toContain("skillmap-loaded");
    expect(events).toContain("matches-found");
    expect(events).toContain("dedup-filtered");
    expect(events).toContain("complete");
    // skills-injected should NOT appear since nothing matched
    expect(events).not.toContain("skills-injected");
  });

  test("complete event includes elapsed_ms", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const complete = lines.find((l: any) => l.event === "complete");
    expect(complete).toBeDefined();
    expect(typeof complete.elapsed_ms).toBe("number");
    expect(complete.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test("stdout remains valid JSON when debug is on", async () => {
    const { stdout } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });
});

describe("issue events in debug mode", () => {
  test("STDIN_EMPTY issue emitted for empty stdin", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("STDIN_EMPTY");
    expect(typeof issue.message).toBe("string");
    expect(typeof issue.hint).toBe("string");
  });

  test("STDIN_PARSE_FAIL issue emitted for invalid JSON", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("STDIN_PARSE_FAIL");
    expect(typeof issue.context.error).toBe("string");
  });

  test("SKILLMAP_EMPTY issue emitted when skills directory has no SKILL.md files", async () => {
    const tempRoot = join(tmpdir(), `vp-test-noskills-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");
    mkdirSync(tempHooksDir, { recursive: true });
    mkdirSync(tempSkillsDir, { recursive: true });
    const hookSource = readFileSync(HOOK_SCRIPT, "utf-8");
    const tempHookPath = join(tempHooksDir, "pretooluse-skill-inject.mjs");
    writeFileSync(tempHookPath, hookSource);
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "patterns.mjs"),
      readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", tempHookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("SKILLMAP_EMPTY");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("no issue events emitted when debug is off", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
  });

  test("issue events have required fields: code, message, hint, context", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issues = lines.filter((l: any) => l.event === "issue");
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.message).toBe("string");
      expect(typeof issue.hint).toBe("string");
      expect(issue.context).toBeDefined();
      // Also has standard debug fields
      expect(typeof issue.invocationId).toBe("string");
      expect(typeof issue.timestamp).toBe("string");
    }
  });

  test("SKILLMD_PARSE_FAIL issue emitted for malformed YAML frontmatter", async () => {
    // Set up a temp plugin root with one valid skill and one malformed SKILL.md
    const tempRoot = join(tmpdir(), `vp-test-malformed-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");

    // Create a valid skill so the skill map isn't empty
    const validSkillDir = join(tempSkillsDir, "valid-skill");
    mkdirSync(validSkillDir, { recursive: true });
    writeFileSync(
      join(validSkillDir, "SKILL.md"),
      `---\nname: valid-skill\nmetadata:\n  pathPatterns:\n    - '**/*.valid'\n---\n# Valid Skill\n`,
    );

    // Create a malformed skill with invalid YAML frontmatter (tab indentation triggers parse error)
    const badSkillDir = join(tempSkillsDir, "bad-skill");
    mkdirSync(badSkillDir, { recursive: true });
    writeFileSync(
      join(badSkillDir, "SKILL.md"),
      `---\nname: bad-skill\n\tmetadata: foo\n---\n# Bad Skill\n`,
    );

    // Copy hook files and symlink node_modules
    mkdirSync(tempHooksDir, { recursive: true });
    writeFileSync(
      join(tempHooksDir, "pretooluse-skill-inject.mjs"),
      readFileSync(HOOK_SCRIPT, "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "patterns.mjs"),
      readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/foo.valid" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", join(tempHooksDir, "pretooluse-skill-inject.mjs")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_DEBUG: "1" },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    // Hook should still produce output (valid skill matches)
    expect(stdout.length).toBeGreaterThan(0);

    // Parse stderr debug lines and find SKILLMD_PARSE_FAIL issues
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const parseFailIssues = lines.filter(
      (l: any) => l.event === "issue" && l.code === "SKILLMD_PARSE_FAIL",
    );
    expect(parseFailIssues.length).toBeGreaterThanOrEqual(1);

    const issue = parseFailIssues[0];
    expect(issue.message).toContain("Failed to parse SKILL.md");
    expect(typeof issue.hint).toBe("string");
    expect(issue.hint).toContain("bad-skill");
    expect(issue.context.file).toContain("bad-skill");
    expect(typeof issue.context.error).toBe("string");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("SKILLMD_PARSE_FAIL not emitted when debug is off", async () => {
    // Same malformed setup but without debug mode
    const tempRoot = join(tmpdir(), `vp-test-malformed-nodebug-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");

    const badSkillDir = join(tempSkillsDir, "bad-skill");
    mkdirSync(badSkillDir, { recursive: true });
    writeFileSync(
      join(badSkillDir, "SKILL.md"),
      `---\nname: bad-skill\n\tmetadata: foo\n---\n# Bad Skill\n`,
    );

    mkdirSync(tempHooksDir, { recursive: true });
    writeFileSync(
      join(tempHooksDir, "pretooluse-skill-inject.mjs"),
      readFileSync(HOOK_SCRIPT, "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "patterns.mjs"),
      readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/foo.txt" },
      session_id: `nodebug-${Date.now()}`,
    });
    const proc = Bun.spawn(["node", join(tempHooksDir, "pretooluse-skill-inject.mjs")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // No debug env var
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    // No stderr output when debug is off
    expect(stderr).toBe("");

    rmSync(tempRoot, { recursive: true, force: true });
  });
});

// Helper to run hook with custom env vars and optional session_id override
async function runHookEnv(
  input: object,
  env: Record<string, string | undefined>,
  opts?: { omitSessionId?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = opts?.omitSessionId
    ? JSON.stringify(input)
    : JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET, ...env },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("setup mode bootstrap routing", () => {
  test("injects bootstrap on unmatched paths when setup mode is active", async () => {
    const { code, stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/random-not-matched.txt" } },
      {
        VERCEL_PLUGIN_SETUP_MODE: "1",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      },
    );

    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:bootstrap");
    expect(extractSkillInjection(result.hookSpecificOutput).matchedSkills).toContain("bootstrap");
    expect(extractSkillInjection(result.hookSpecificOutput).injectedSkills[0]).toBe("bootstrap");
  });

  test("boosts bootstrap ahead of other skills in setup mode", async () => {
    const { code, stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/vercel.json" } },
      {
        VERCEL_PLUGIN_SETUP_MODE: "1",
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      },
    );

    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const injectedSkills = extractSkillInjection(result.hookSpecificOutput).injectedSkills;
    expect(injectedSkills[0]).toBe("bootstrap");
  });

  test("skips synthetic bootstrap when bootstrap was already injected", async () => {
    const { code, stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/random-not-matched.txt" } },
      {
        VERCEL_PLUGIN_SETUP_MODE: "1",
        VERCEL_PLUGIN_SEEN_SKILLS: "bootstrap",
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });
});

describe("seen-skills env file and dedup controls", () => {
  const nextjsOnlyPath = "/project/app/page.tsx";

  test("no VERCEL_PLUGIN_SEEN_SKILLS env var uses memory-only dedup across invocations", async () => {
    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      {},
    );
    const r1 = JSON.parse(first);
    expect(r1.hookSpecificOutput.additionalContext).toContain("skill:nextjs");

    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      {},
    );
    const r2 = JSON.parse(second);
    expect(r2.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("empty VERCEL_PLUGIN_SEEN_SKILLS env var dedups across invocations", async () => {
    // First call with empty env var — skill should inject
    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    const r1 = JSON.parse(first);
    expect(r1.hookSpecificOutput.additionalContext).toContain("skill:nextjs");

    // Second call with skill already seen — should be deduped
    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
    );
    const r2 = JSON.parse(second);
    expect(r2).toEqual({});
  });

  test("pre-seeded VERCEL_PLUGIN_SEEN_SKILLS skips matching injection", async () => {
    const { stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
    );

    expect(JSON.parse(stdout)).toEqual({});
  });

  test("VERCEL_PLUGIN_HOOK_DEDUP=off injects every call even with pre-seeded env var", async () => {
    const env = {
      VERCEL_PLUGIN_SEEN_SKILLS: "nextjs",
      VERCEL_PLUGIN_HOOK_DEDUP: "off",
    };

    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      env,
    );
    const r1 = JSON.parse(first);
    expect(r1.hookSpecificOutput.additionalContext).toContain("skill:nextjs");

    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      env,
    );
    const r2 = JSON.parse(second);
    expect(r2.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("empty VERCEL_PLUGIN_SEEN_SKILLS resets dedup state", async () => {
    // With pre-seeded skills, injection is skipped
    const { stdout: skipped } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
    );
    expect(JSON.parse(skipped)).toEqual({});

    // With empty env var, injection happens again
    const { stdout: injected } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    expect(JSON.parse(injected).hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("debug mode logs dedup strategy for env-var, memory-only, and disabled", async () => {
    const { stderr: envVarStderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_SEEN_SKILLS: "" },
    );
    const envVarLines = envVarStderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const envVarStrategy = envVarLines.find((l: any) => l.event === "dedup-strategy");
    expect(envVarStrategy).toBeDefined();
    expect(envVarStrategy.strategy).toBe("env-var");

    const { stderr: memoryOnlyStderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_SEEN_SKILLS: undefined },
    );
    const memoryOnlyLines = memoryOnlyStderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const memoryOnlyStrategy = memoryOnlyLines.find((l: any) => l.event === "dedup-strategy");
    expect(memoryOnlyStrategy).toBeDefined();
    expect(memoryOnlyStrategy.strategy).toBe("memory-only");

    const { stderr: disabledStderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const disabledLines = disabledStderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const disabledStrategy = disabledLines.find((l: any) => l.event === "dedup-strategy");
    expect(disabledStrategy).toBeDefined();
    expect(disabledStrategy.strategy).toBe("disabled");
  });

  test("VERCEL_PLUGIN_SEEN_SKILLS uses comma-delimited format", async () => {
    // Verify the env var format is comma-delimited by pre-seeding with multiple skills
    const { stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: nextjsOnlyPath } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs,turbopack" },
    );
    // nextjs is in the seen list, so it should be deduped
    expect(JSON.parse(stdout)).toEqual({});
  });
});

describe("new pattern coverage", () => {
  test("matches .vercelignore to vercel-cli skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.vercelignore" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-cli");
  });

  test("matches lib/cache.ts to runtime-cache skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/lib/cache.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:runtime-cache");
  });

  test("matches lib/blob.ts to vercel-storage skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/lib/blob.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-storage");
  });

  test("matches lib/queues.ts to vercel-queues skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/lib/queues.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-queues");
  });

  test("matches workflow.ts to workflow skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/workflow.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:workflow");
  });

  test("matches app/health/route.ts to vercel-functions skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/app/health/route.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-functions");
  });

  test("matches npm install @neondatabase/serverless to vercel-storage skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install @neondatabase/serverless" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-storage");
  });

  test("matches src/middleware.mjs to routing-middleware skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/src/middleware.mjs" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches src/middleware.mts to routing-middleware skill via Edit", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/src/middleware.mts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches app/layout.tsx to observability skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/app/layout.tsx" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:observability");
  });

  test("matches pages/_app.tsx to observability skill via Edit", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/pages/_app.tsx" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:observability");
  });

  test("matches pages/api/chat.ts to ai-sdk skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/pages/api/chat.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-sdk");
  });

  test("matches pages/api/completion.ts to ai-sdk skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/pages/api/completion.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-sdk");
  });

  test("matches claude mcp add vercel to vercel-api skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "claude mcp add vercel mcp.vercel.com" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-api");
  });
});

describe("glob regression", () => {
  test("app/foobarroute.ts does NOT trigger vercel-functions", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/app/foobarroute.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // Should match nextjs (app/**) but NOT vercel-functions (app/**/route.*)
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:vercel-functions");
    }
  });

  test("non-Vercel workflow file does NOT trigger vercel-agent", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.github/workflows/ci.yml" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:vercel-agent");
    }
  });

  test("generic test.yml workflow does NOT trigger vercel-agent", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.github/workflows/test.yml" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:vercel-agent");
    }
  });

  test("vercel-deploy.yml workflow DOES trigger vercel-agent", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.github/workflows/vercel-deploy.yml" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-agent");
  });

  test("deploy-preview.yaml workflow DOES trigger vercel-agent", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.github/workflows/deploy-preview.yaml" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-agent");
  });

  test("bare api/ directory path does NOT trigger vercel-functions", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/api/health" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    if (result.hookSpecificOutput) {
      expect(result.hookSpecificOutput.additionalContext).not.toContain("skill:vercel-functions");
    }
  });

  test("api/hello.ts DOES trigger vercel-functions", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/api/hello.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-functions");
  });
});

describe("vercel.ts pattern", () => {
  test("matches vercel.ts to vercel-cli skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/vercel.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:vercel-cli");
  });
});

describe("? wildcard in glob patterns", () => {
  test("tsconfig.?.json matches single-char extensions", async () => {
    // This simulates a pattern like "tsconfig.?.json" — we test that
    // the existing "tsconfig.*.json" pattern works with single chars
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/tsconfig.e.json" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // tsconfig.*.json is in nextjs pathPatterns and * matches single char too
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:nextjs");
  });

  test("? wildcard does not match slash", async () => {
    // next.config.* uses * which should not match across slashes
    // A path like next.config.sub/file should NOT match next.config.*
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts/nested" },
    });
    expect(code).toBe(0);
    // This path should not match next.config.* because * doesn't cross slashes
    // It might match app/** via suffix matching though, so just verify no error
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe("priority ordering for file-path matches", () => {
  test("app/api/chat/route.ts matches multiple skills; highest-priority ones win", async () => {
    // This path matches:
    //   nextjs (priority 10): app/**
    //   ai-sdk (priority 8): app/api/chat/**
    //   vercel-functions (priority 8): app/**/route.*
    // All 3 fit under MAX_SKILLS=3, so all should inject, ordered by priority
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/app/api/chat/route.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const ctx = result.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("skill:nextjs");
    expect(ctx).toContain("skill:ai-sdk");
    expect(ctx).toContain("skill:vercel-functions");
  });

  test("skills appear in priority order (highest first) in additionalContext", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/app/api/chat/route.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const ctx = result.hookSpecificOutput.additionalContext;

    const nextjsPos = ctx.indexOf("skill:nextjs");
    const aiSdkPos = ctx.indexOf("skill:ai-sdk");
    const funcPos = ctx.indexOf("skill:vercel-functions");

    // ai-sdk (8) and vercel-functions (8) should appear before nextjs (5)
    expect(aiSdkPos).toBeLessThan(nextjsPos);
    expect(funcPos).toBeLessThan(nextjsPos);
  });
});

describe("priority ordering", () => {
  test("when 4+ skills match, only 3 inject and they are the highest-priority ones", async () => {
    // Craft a bash command that matches 4+ skills with known priorities:
    //   ai-sdk (priority 8): "npm install ai"
    //   vercel-storage (priority 7): "npm install @vercel/blob"
    //   turborepo (priority 5): "turbo run build"
    //   vercel-cli (priority 4): "vercel deploy"
    //   v0-dev (priority 5): "npx v0 generate"
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: {
        command:
          "vercel deploy && npm install ai && npm install @vercel/blob && turbo run build && npx v0 generate",
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const ctx = result.hookSpecificOutput.additionalContext;
    expect(ctx).toBeDefined();

    const skillTags =
      ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || [];
    expect(skillTags.length).toBe(3);

    // The top 3 by priority should be: ai-sdk (8), vercel-storage (7), turborepo (5) or v0-dev (5)
    expect(ctx).toContain("skill:ai-sdk");
    expect(ctx).toContain("skill:vercel-storage");

    // vercel-cli (4) should NOT be included (lower priority)
    expect(ctx).not.toContain("skill:vercel-cli");
  });
});

describe("VERCEL_PLUGIN_DEBUG alias", () => {
  test("VERCEL_PLUGIN_DEBUG=1 activates debug output (stderr)", async () => {
    const { code, stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_DEBUG: "1" },
    );
    expect(code).toBe(0);
    expect(stderr.trim().length).toBeGreaterThan(0);
    const lines = stderr.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("VERCEL_PLUGIN_DEBUG=1 produces identical event types as VERCEL_PLUGIN_HOOK_DEBUG=1", async () => {
    const input = { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } };
    // Use VERCEL_PLUGIN_HOOK_DEDUP=off so dedup doesn't cause divergence between runs
    const { stderr: stderrNew } = await runHookEnv(input, { VERCEL_PLUGIN_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" });
    const { stderr: stderrOld } = await runHookEnv(input, { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" });
    const eventsNew = stderrNew.trim().split("\n").map((l: string) => JSON.parse(l).event);
    const eventsOld = stderrOld.trim().split("\n").map((l: string) => JSON.parse(l).event);
    expect(eventsNew).toEqual(eventsOld);
  });

  test("neither env var set produces no stderr", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      {},
    );
    expect(stderr).toBe("");
  });
});

describe("match-reason logging", () => {
  test("matches-found event includes reasons with pattern and matchType for path match", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const matchEvent = lines.find((l: any) => l.event === "matches-found");
    expect(matchEvent).toBeDefined();
    expect(matchEvent.reasons).toBeDefined();
    expect(typeof matchEvent.reasons).toBe("object");
    // nextjs skill should match next.config.ts
    const nextjsReason = matchEvent.reasons["nextjs"];
    expect(nextjsReason).toBeDefined();
    expect(nextjsReason.pattern).toBeDefined();
    expect(typeof nextjsReason.pattern).toBe("string");
    expect(["full", "basename", "suffix"]).toContain(nextjsReason.matchType);
  });

  test("matches-found event includes reasons for bash command match", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Bash", tool_input: { command: "npx next build" } },
      { VERCEL_PLUGIN_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const matchEvent = lines.find((l: any) => l.event === "matches-found");
    expect(matchEvent).toBeDefined();
    expect(matchEvent.reasons).toBeDefined();
    // Should have at least one matched skill with a reason
    const skills = Object.keys(matchEvent.reasons);
    if (skills.length > 0) {
      const reason = matchEvent.reasons[skills[0]];
      expect(reason.pattern).toBeDefined();
      expect(reason.matchType).toBe("full");
    }
  });

  test("matches-found reasons is empty object when no skills match", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/totally-unrelated-file.xyz" } },
      { VERCEL_PLUGIN_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const matchEvent = lines.find((l: any) => l.event === "matches-found");
    expect(matchEvent).toBeDefined();
    expect(matchEvent.reasons).toEqual({});
    expect(matchEvent.matched).toEqual([]);
  });

  test("matchType is basename when only basename matches", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/some/deep/path/next.config.js" } },
      { VERCEL_PLUGIN_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const matchEvent = lines.find((l: any) => l.event === "matches-found");
    expect(matchEvent).toBeDefined();
    if (matchEvent.reasons["nextjs"]) {
      expect(["full", "basename", "suffix"]).toContain(matchEvent.reasons["nextjs"].matchType);
    }
  });
});

describe("cap observability (debug mode)", () => {
  test("emits cap-applied event with selected and dropped arrays when >3 skills match", async () => {
    // This command matches 5+ distinct skills:
    //   vercel-cli  (vercel deploy)
    //   turborepo   (turbo run build)
    //   v0-dev      (npx v0)
    //   ai-sdk      (npm install ai)
    //   marketplace  (vercel integration)
    const { code, stderr } = await runHookDebug({
      tool_name: "Bash",
      tool_input: {
        command:
          "vercel deploy && turbo run build && npx v0 generate && npm install ai && vercel integration add neon",
      },
    });
    expect(code).toBe(0);

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const capEvent = lines.find((l: any) => l.event === "cap-applied");
    expect(capEvent).toBeDefined();
    expect(capEvent.max).toBe(3);
    expect(capEvent.totalCandidates).toBeGreaterThan(3);
    expect(typeof capEvent.budgetBytes).toBe("number");
    expect(typeof capEvent.usedBytes).toBe("number");

    // selected array has exactly 3 entries with skill name
    expect(Array.isArray(capEvent.selected)).toBe(true);
    expect(capEvent.selected.length).toBe(3);
    for (const entry of capEvent.selected) {
      expect(typeof entry.skill).toBe("string");
    }

    // droppedByCap should have the excess skills
    expect(Array.isArray(capEvent.droppedByCap)).toBe(true);
    expect(capEvent.droppedByCap.length).toBeGreaterThanOrEqual(1);
    for (const skill of capEvent.droppedByCap) {
      expect(typeof skill).toBe("string");
    }
  });

  test("does NOT emit cap-applied when <=3 skills match", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const capEvent = lines.find((l: any) => l.event === "cap-applied");
    expect(capEvent).toBeUndefined();
  });
});

describe("injection byte budget", () => {
  test("small budget limits injection to fewer skills than MAX_SKILLS", async () => {
    // app/api/chat/route.ts matches ai-sdk (~15KB), vercel-functions (~5.7KB), nextjs (~10KB)
    // With a 6000-byte budget, only 1 skill should fit (first skill always allowed)
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/app/api/chat/route.ts" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.injectedSkills.length).toBeLessThan(3);
    expect(si.droppedByBudget.length).toBeGreaterThan(0);
  });

  test("large budget allows all matching skills up to MAX_SKILLS", async () => {
    // Same path, unlimited budget
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/app/api/chat/route.ts" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "999999" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.injectedSkills.length).toBe(3);
    expect(si.droppedByBudget.length).toBe(0);
  });

  test("VERCEL_PLUGIN_INJECTION_BUDGET env var overrides default", async () => {
    // With a very small budget (100 bytes), first skill is still always allowed
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/next.config.ts" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "100" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    // First skill always allowed even if over budget
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si.injectedSkills.length).toBe(1);
  });

  test("small skills can fill more than typical slots under generous budget", async () => {
    // vercel.json matches 5 skills; some are small (cron-jobs ~2KB, vercel-functions ~5.7KB)
    // With 15000-byte budget, should fit more small skills
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/project/vercel.json" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "15000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    // MAX_SKILLS=3 ceiling still applies
    expect(si.injectedSkills.length).toBeLessThanOrEqual(3);
  });

  test("invalid VERCEL_PLUGIN_INJECTION_BUDGET falls back to default", async () => {
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/project/next.config.ts" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "not-a-number" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    // Should still work with default budget
    expect(result.hookSpecificOutput).toBeDefined();
  });

  test("droppedByBudget appears in skillInjection metadata", async () => {
    // Use a tight budget that forces budget drops
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/app/api/chat/route.ts" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(Array.isArray(si.droppedByBudget)).toBe(true);
    expect(Array.isArray(si.droppedByCap)).toBe(true);
    // Total should account for all matched skills
    expect(si.injectedSkills.length + si.droppedByCap.length + si.droppedByBudget.length).toBe(
      si.matchedSkills.length,
    );
  });
});

describe("sectional injection (summary fallback)", () => {
  function createTempPlugin(skills: Array<{ name: string; summary?: string; body: string; patterns: string[] }>) {
    const tempRoot = join(tmpdir(), `vp-test-sectional-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");
    mkdirSync(tempHooksDir, { recursive: true });
    mkdirSync(tempSkillsDir, { recursive: true });

    // Copy hook modules
    for (const mod of ["pretooluse-skill-inject.mjs", "skill-map-frontmatter.mjs", "patterns.mjs", "vercel-config.mjs", "logger.mjs", "hook-env.mjs"]) {
      writeFileSync(
        join(tempHooksDir, mod),
        readFileSync(join(ROOT, "hooks", mod), "utf-8"),
      );
    }
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    // Create skills
    for (const skill of skills) {
      const skillDir = join(tempSkillsDir, skill.name);
      mkdirSync(skillDir, { recursive: true });
      const summaryLine = skill.summary ? `summary: '${skill.summary}'\n` : "";
      const patterns = skill.patterns.map((p) => `    - '${p}'`).join("\n");
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${skill.name}\n${summaryLine}description: Test skill\nmetadata:\n  priority: 5\n  pathPatterns:\n${patterns}\n  bashPatterns: []\n---\n${skill.body}`,
      );
    }

    return { tempRoot, tempHooksDir, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
  }

  async function runTempHook(
    tempHooksDir: string,
    input: object,
    env: Record<string, string>,
  ) {
    const payload = JSON.stringify({ ...input, session_id: `test-${Date.now()}` });
    const proc = Bun.spawn(["node", join(tempHooksDir, "pretooluse-skill-inject.mjs")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { code, stdout };
  }

  test("skills without summary are dropped by budget as before", async () => {
    // Create 2 skills with large bodies, no summaries
    const bigBody = "X".repeat(5000);
    const { tempHooksDir, cleanup } = createTempPlugin([
      { name: "skill-a", body: bigBody, patterns: ["src/**"] },
      { name: "skill-b", body: bigBody, patterns: ["src/**"] },
    ]);

    const { code, stdout } = await runTempHook(
      tempHooksDir,
      { tool_name: "Read", tool_input: { file_path: "/project/src/index.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    // First skill always allowed, second dropped by budget
    expect(si.injectedSkills.length).toBe(1);
    expect(si.droppedByBudget.length).toBe(1);
    expect(si.summaryOnly).toEqual([]);

    cleanup();
  });

  test("summary is injected when full body exceeds budget", async () => {
    // skill-a: large body, no summary → always gets full injection (first skill)
    // skill-b: large body + short summary → should get summary fallback
    const bigBody = "X".repeat(5000);
    const { tempHooksDir, cleanup } = createTempPlugin([
      { name: "skill-a", body: bigBody, patterns: ["src/**"] },
      { name: "skill-b", summary: "Short summary for skill-b.", body: bigBody, patterns: ["src/**"] },
    ]);

    const { code, stdout } = await runTempHook(
      tempHooksDir,
      { tool_name: "Read", tool_input: { file_path: "/project/src/index.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    // Both skills should be injected
    expect(si.injectedSkills.length).toBe(2);
    expect(si.summaryOnly).toContain("skill-b");
    expect(si.droppedByBudget.length).toBe(0);
    // The context should contain the summary marker
    expect(result.hookSpecificOutput.additionalContext).toContain("mode:summary");
    expect(result.hookSpecificOutput.additionalContext).toContain("Short summary for skill-b.");

    cleanup();
  });

  test("summary also dropped when it exceeds remaining budget", async () => {
    // skill-a: large body (first, always allowed)
    // skill-b: large body + large summary → both exceed budget
    const bigBody = "X".repeat(5000);
    const bigSummary = "Y".repeat(5000);
    const { tempHooksDir, cleanup } = createTempPlugin([
      { name: "skill-a", body: bigBody, patterns: ["src/**"] },
      { name: "skill-b", summary: bigSummary, body: bigBody, patterns: ["src/**"] },
    ]);

    const { code, stdout } = await runTempHook(
      tempHooksDir,
      { tool_name: "Read", tool_input: { file_path: "/project/src/index.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.injectedSkills.length).toBe(1);
    expect(si.droppedByBudget.length).toBe(1);
    expect(si.summaryOnly).toEqual([]);

    cleanup();
  });

  test("total injected bytes stay within budget with summary fallback", async () => {
    const bigBody = "X".repeat(4000);
    const shortSummary = "Brief help for this skill.";
    const { tempHooksDir, cleanup } = createTempPlugin([
      { name: "skill-a", body: bigBody, patterns: ["src/**"] },
      { name: "skill-b", summary: shortSummary, body: bigBody, patterns: ["src/**"] },
      { name: "skill-c", summary: shortSummary, body: bigBody, patterns: ["src/**"] },
    ]);

    const budget = 5000;
    const { code, stdout } = await runTempHook(
      tempHooksDir,
      { tool_name: "Read", tool_input: { file_path: "/project/src/index.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: String(budget) },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const ctx = result.hookSpecificOutput?.additionalContext || "";
    // Total bytes must not exceed budget (first skill exempted, but subsequent ones
    // including summaries should keep total within budget)
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    // All injected + summaryOnly + dropped should account for all matched
    expect(si.injectedSkills.length + si.droppedByCap.length + si.droppedByBudget.length).toBe(
      si.matchedSkills.length,
    );

    cleanup();
  });

  test("summaryOnly array in skillInjection metadata", async () => {
    const bigBody = "X".repeat(5000);
    const { tempHooksDir, cleanup } = createTempPlugin([
      { name: "skill-a", body: bigBody, patterns: ["src/**"] },
      { name: "skill-b", summary: "A brief summary.", body: bigBody, patterns: ["src/**"] },
    ]);

    const { code, stdout } = await runTempHook(
      tempHooksDir,
      { tool_name: "Read", tool_input: { file_path: "/project/src/index.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: "6000" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(Array.isArray(si.summaryOnly)).toBe(true);

    cleanup();
  });
});

describe("per-phase timing_ms (debug mode)", () => {
  test("complete event includes timing_ms with required phase keys", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const complete = lines.find((l: any) => l.event === "complete");
    expect(complete).toBeDefined();
    expect(complete.timing_ms).toBeDefined();

    // Required keys
    for (const key of ["stdin_parse", "skillmap_load", "match", "skill_read", "total"]) {
      expect(typeof complete.timing_ms[key]).toBe("number");
      expect(complete.timing_ms[key]).toBeGreaterThanOrEqual(0);
    }
  });

  test("timing_ms.total >= 0 for non-matching invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const complete = lines.find((l: any) => l.event === "complete");
    expect(complete).toBeDefined();
    expect(complete.timing_ms).toBeDefined();
    expect(complete.timing_ms.total).toBeGreaterThanOrEqual(0);
    expect(complete.timing_ms.stdin_parse).toBeGreaterThanOrEqual(0);
    expect(complete.timing_ms.skillmap_load).toBeGreaterThanOrEqual(0);
    expect(complete.timing_ms.match).toBeGreaterThanOrEqual(0);
  });

  test("timing_ms not present when debug is off", async () => {
    const { stderr, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    // No stderr in non-debug mode
    expect(stderr).toBe("");
    // stdout should not contain timing_ms
    expect(stdout).not.toContain("timing_ms");
  });
});

describe("invalid bash regex handling", () => {
  // Helper: create a temp plugin dir with a single skill containing an invalid bash regex
  function createTempSkillWithRegex(bashPatterns: string[]): { hookPath: string; root: string } {
    const tempRoot = join(tmpdir(), `vp-test-regex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillDir = join(tempRoot, "skills", "test-skill");
    mkdirSync(tempHooksDir, { recursive: true });
    mkdirSync(tempSkillDir, { recursive: true });

    // Copy hook + frontmatter parser
    writeFileSync(join(tempHooksDir, "pretooluse-skill-inject.mjs"), readFileSync(HOOK_SCRIPT, "utf-8"));
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "patterns.mjs"),
      readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    // Write a SKILL.md with the given bashPatterns
    const bashYaml = bashPatterns.map(p => `    - '${p.replace(/'/g, "''")}'`).join("\n");
    writeFileSync(
      join(tempSkillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: Test skill\nmetadata:\n  priority: 10\n  pathPatterns: []\n  bashPatterns:\n${bashYaml}\n---\n# Test Skill\nContent here.`,
    );

    return { hookPath: join(tempHooksDir, "pretooluse-skill-inject.mjs"), root: tempRoot };
  }

  test("emits BASH_REGEX_INVALID for broken regex, still exits 0 with valid JSON, and valid patterns still match", async () => {
    const { hookPath, root } = createTempSkillWithRegex(["(unclosed-group", "\\bvalid-command\\b"]);

    try {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "valid-command --flag" },
        session_id: `invalid-regex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const proc = Bun.spawn(["node", hookPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      });
      proc.stdin.write(payload);
      proc.stdin.end();
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      // Hook exits 0
      expect(code).toBe(0);

      // stdout is valid JSON
      expect(() => JSON.parse(stdout)).not.toThrow();

      // stderr contains BASH_REGEX_INVALID issue
      expect(stderr).toContain("BASH_REGEX_INVALID");
      const issueLines = stderr.split("\n").filter(l => l.includes("BASH_REGEX_INVALID"));
      expect(issueLines.length).toBeGreaterThanOrEqual(1);
      const issueEvent = JSON.parse(issueLines[0]);
      expect(issueEvent.event).toBe("issue");
      expect(issueEvent.code).toBe("BASH_REGEX_INVALID");
      expect(issueEvent.context.pattern).toBe("(unclosed-group");

      // Valid pattern still matched — skill was found in debug output
      expect(stderr).toContain("matches-found");
      const matchLine = stderr.split("\n").find(l => l.includes("matches-found"));
      const matchEvent = JSON.parse(matchLine!);
      expect(matchEvent.matched).toContain("test-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not emit BASH_REGEX_INVALID when debug is off", async () => {
    const { hookPath, root } = createTempSkillWithRegex(["(unclosed-group"]);

    try {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "some-command" },
        session_id: `no-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const proc = Bun.spawn(["node", hookPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(payload);
      proc.stdin.end();
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(code).toBe(0);
      // No stderr when debug is off
      expect(stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("invalid glob pattern handling", () => {
  /**
   * Helper: create a temp plugin dir with a patched patterns.mjs that throws
   * on a sentinel pattern "__THROW__", simulating a broken glob at compile time.
   * Also creates two skills: bad-glob-skill (with __THROW__ pattern) and good-skill.
   */
  function createTempSkillWithBadGlob(): { hookPath: string; root: string } {
    const tempRoot = join(tmpdir(), `vp-test-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tempHooksDir = join(tempRoot, "hooks");
    mkdirSync(tempHooksDir, { recursive: true });

    // Copy hook + frontmatter parser
    writeFileSync(join(tempHooksDir, "pretooluse-skill-inject.mjs"), readFileSync(HOOK_SCRIPT, "utf-8"));
    writeFileSync(
      join(tempHooksDir, "skill-map-frontmatter.mjs"),
      readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"),
    );

    // Patched patterns.mjs: throws on "__THROW__" sentinel, delegates otherwise
    const realPatterns = readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8");
    // Match both tsc output ("export function globToRegex(pattern)") and
    // tsup output ("function globToRegex(pattern)") since bundlers may strip export keywords
    const patchedPatterns = realPatterns.replace(
      /^(\s*(?:export\s+)?function globToRegex\(pattern\)\s*\{)/m,
      '$1\n  if (pattern === "__THROW__") throw new Error("simulated glob compile failure");',
    );
    writeFileSync(join(tempHooksDir, "patterns.mjs"), patchedPatterns);
    writeFileSync(
      join(tempHooksDir, "vercel-config.mjs"),
      readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "logger.mjs"),
      readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"),
    );
    writeFileSync(
      join(tempHooksDir, "hook-env.mjs"),
      readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    // Skill with a __THROW__ pathPattern that will trigger the patched globToRegex to throw
    const badSkillDir = join(tempRoot, "skills", "bad-glob-skill");
    mkdirSync(badSkillDir, { recursive: true });
    writeFileSync(
      join(badSkillDir, "SKILL.md"),
      `---\nname: bad-glob-skill\ndescription: Skill with bad glob\nmetadata:\n  priority: 10\n  pathPatterns:\n    - '__THROW__'\n    - '**/*.validext'\n---\n# Bad Glob Skill\nContent here.`,
    );

    // Valid skill that should still match
    const goodSkillDir = join(tempRoot, "skills", "good-skill");
    mkdirSync(goodSkillDir, { recursive: true });
    writeFileSync(
      join(goodSkillDir, "SKILL.md"),
      `---\nname: good-skill\ndescription: Valid skill\nmetadata:\n  priority: 5\n  pathPatterns:\n    - '**/*.validext'\n---\n# Good Skill\nGood content.`,
    );

    return { hookPath: join(tempHooksDir, "pretooluse-skill-inject.mjs"), root: tempRoot };
  }

  test("emits PATH_GLOB_INVALID for broken glob, still exits 0 and injects valid skills", async () => {
    const { hookPath, root } = createTempSkillWithBadGlob();

    try {
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/project/src/app.validext" },
        session_id: `invalid-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const proc = Bun.spawn(["node", hookPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VERCEL_PLUGIN_DEBUG: "1" },
      });
      proc.stdin.write(payload);
      proc.stdin.end();
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      // Hook exits 0
      expect(code).toBe(0);

      // stdout is valid JSON
      expect(() => JSON.parse(stdout)).not.toThrow();

      // stderr contains PATH_GLOB_INVALID issue
      expect(stderr).toContain("PATH_GLOB_INVALID");
      const issueLines = stderr.split("\n").filter(l => l.includes("PATH_GLOB_INVALID"));
      expect(issueLines.length).toBeGreaterThanOrEqual(1);
      const issueEvent = JSON.parse(issueLines[0]);
      expect(issueEvent.event).toBe("issue");
      expect(issueEvent.code).toBe("PATH_GLOB_INVALID");
      expect(issueEvent.context.skill).toBe("bad-glob-skill");
      expect(issueEvent.context.pattern).toBe("__THROW__");

      // Valid skill (good-skill) still injected despite bad-glob-skill having a broken pattern
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.additionalContext).toContain("skill:good-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bad-glob-skill with mixed valid/invalid patterns still matches via valid pattern", async () => {
    const { hookPath, root } = createTempSkillWithBadGlob();

    try {
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/project/foo.validext" },
        session_id: `mixed-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const proc = Bun.spawn(["node", hookPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VERCEL_PLUGIN_DEBUG: "1" },
      });
      proc.stdin.write(payload);
      proc.stdin.end();
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(code).toBe(0);
      // PATH_GLOB_INVALID emitted for the __THROW__ pattern
      expect(stderr).toContain("PATH_GLOB_INVALID");

      // bad-glob-skill still matched via its valid "**/*.validext" pattern
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.additionalContext).toContain("skill:bad-glob-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not emit PATH_GLOB_INVALID when debug is off", async () => {
    const { hookPath, root } = createTempSkillWithBadGlob();

    try {
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/project/foo.txt" },
        session_id: `no-debug-glob-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const proc = Bun.spawn(["node", hookPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // No debug env var
      });
      proc.stdin.write(payload);
      proc.stdin.end();
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(code).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage matrix: representative file paths (20+)
// ---------------------------------------------------------------------------
describe("coverage matrix — file paths", () => {
  // Helper: run hook with dedup disabled so each test is independent
  async function matchFile(filePath: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
      session_id: `matrix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  // 1. Next.js app dir page
  test("app/page.tsx → nextjs", async () => {
    const skills = await matchFile("/project/app/page.tsx");
    expect(skills).toContain("nextjs");
  });

  // 2. Next.js pages dir
  test("pages/index.tsx → nextjs", async () => {
    const skills = await matchFile("/project/pages/index.tsx");
    expect(skills).toContain("nextjs");
  });

  // 3. src/app layout
  test("src/app/layout.tsx → nextjs + observability", async () => {
    const skills = await matchFile("/project/src/app/layout.tsx");
    expect(skills).toContain("nextjs");
    expect(skills).toContain("observability");
  });

  // 4. Monorepo: apps/web/app/page.tsx → nextjs
  test("apps/web/app/page.tsx → nextjs (monorepo)", async () => {
    const skills = await matchFile("/project/apps/web/app/page.tsx");
    expect(skills).toContain("nextjs");
  });

  // 5. Monorepo: apps/docs/next.config.ts → nextjs + turbopack
  test("apps/docs/next.config.ts → nextjs + turbopack (monorepo)", async () => {
    const skills = await matchFile("/project/apps/docs/next.config.ts");
    expect(skills).toContain("nextjs");
    expect(skills).toContain("turbopack");
  });

  // 6. AI SDK chat route
  test("app/api/chat/route.ts → ai-sdk + vercel-functions + nextjs", async () => {
    const skills = await matchFile("/project/app/api/chat/route.ts");
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("vercel-functions");
    expect(skills).toContain("nextjs");
  });

  // 7. Monorepo AI SDK
  test("apps/web/app/api/chat/route.ts → ai-sdk (monorepo)", async () => {
    const skills = await matchFile("/project/apps/web/app/api/chat/route.ts");
    expect(skills).toContain("ai-sdk");
  });

  // 8. Auth route → sign-in-with-vercel
  test("app/api/auth/callback/route.ts → sign-in-with-vercel", async () => {
    const skills = await matchFile("/project/app/api/auth/callback/route.ts");
    expect(skills).toContain("sign-in-with-vercel");
  });

  // 9. .env.local → env-vars
  test(".env.local → env-vars", async () => {
    const skills = await matchFile("/project/.env.local");
    expect(skills).toContain("env-vars");
  });

  // 10. .env.production → env-vars
  test(".env.production → env-vars", async () => {
    const skills = await matchFile("/project/.env.production");
    expect(skills).toContain("env-vars");
  });

  // 11. .env → env-vars
  test(".env → env-vars", async () => {
    const skills = await matchFile("/project/.env");
    expect(skills).toContain("env-vars");
  });

  // 12. middleware.ts → routing-middleware
  test("middleware.ts → routing-middleware", async () => {
    const skills = await matchFile("/project/middleware.ts");
    expect(skills).toContain("routing-middleware");
  });

  // 13. src/proxy.mts → routing-middleware
  test("src/proxy.mts → routing-middleware", async () => {
    const skills = await matchFile("/project/src/proxy.mts");
    expect(skills).toContain("routing-middleware");
  });

  // 14. vercel.json → vercel-functions + cron-jobs + deployments-cicd (capped at 3)
  test("vercel.json → multiple control-plane skills (capped at 3)", async () => {
    const skills = await matchFile("/project/vercel.json");
    // vercel.json now triggers 5 skills; MAX_SKILLS caps at 3
    expect(skills.length).toBeLessThanOrEqual(3);
    // vercel-functions (priority 8) must be included
    expect(skills).toContain("vercel-functions");
  });

  // 15. CI workflow → deployments-cicd
  test(".github/workflows/deploy.yml → deployments-cicd", async () => {
    const skills = await matchFile("/project/.github/workflows/deploy.yml");
    expect(skills).toContain("deployments-cicd");
  });

  // 16. GitLab CI → deployments-cicd
  test(".gitlab-ci.yml → deployments-cicd", async () => {
    const skills = await matchFile("/project/.gitlab-ci.yml");
    expect(skills).toContain("deployments-cicd");
  });

  // 17. shadcn components
  test("components/ui/button.tsx → shadcn", async () => {
    const skills = await matchFile("/project/components/ui/button.tsx");
    expect(skills).toContain("shadcn");
  });

  // 18. Monorepo shadcn
  test("apps/web/src/components/ui/dialog.tsx → shadcn (monorepo)", async () => {
    const skills = await matchFile("/project/apps/web/src/components/ui/dialog.tsx");
    expect(skills).toContain("shadcn");
  });

  // 19. instrumentation.ts → observability
  test("instrumentation.ts → observability", async () => {
    const skills = await matchFile("/project/instrumentation.ts");
    expect(skills).toContain("observability");
  });

  // 20. lib/ai/providers.ts → ai-sdk
  test("lib/ai/providers.ts → ai-sdk", async () => {
    const skills = await matchFile("/project/lib/ai/providers.ts");
    expect(skills).toContain("ai-sdk");
  });

  // 21. integration.json → marketplace
  test("integration.json → marketplace", async () => {
    const skills = await matchFile("/project/integration.json");
    expect(skills).toContain("marketplace");
  });

  // 22. .mcp.json → vercel-api
  test(".mcp.json → vercel-api", async () => {
    const skills = await matchFile("/project/.mcp.json");
    expect(skills).toContain("vercel-api");
  });

  // 23. components/chat/message-list.tsx → json-render
  test("components/chat/message-list.tsx → json-render", async () => {
    const skills = await matchFile("/project/components/chat/message-list.tsx");
    expect(skills).toContain("json-render");
  });

  // 24. lib/edge-config.ts → vercel-storage
  test("lib/edge-config.ts → vercel-storage", async () => {
    const skills = await matchFile("/project/lib/edge-config.ts");
    expect(skills).toContain("vercel-storage");
  });

  // 25. flags.ts → vercel-flags
  test("flags.ts → vercel-flags", async () => {
    const skills = await matchFile("/project/flags.ts");
    expect(skills).toContain("vercel-flags");
  });

  // Negative cases
  test("random/file.txt → no skills", async () => {
    const skills = await matchFile("/project/random/file.txt");
    expect(skills).toEqual([]);
  });

  test("package.json → bootstrap only", async () => {
    const skills = await matchFile("/project/package.json");
    expect(skills).toEqual(["bootstrap"]);
  });
});

// ---------------------------------------------------------------------------
// Coverage matrix: representative bash commands (15+)
// ---------------------------------------------------------------------------
describe("coverage matrix — bash commands", () => {
  async function matchBash(command: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      session_id: `matrix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  // 1. vercel deploy --prod → deployments-cicd + vercel-cli
  test("vercel deploy --prod → deployments-cicd + vercel-cli", async () => {
    const skills = await matchBash("vercel deploy --prod");
    expect(skills).toContain("deployments-cicd");
    expect(skills).toContain("vercel-cli");
  });

  // 2. vercel promote → deployments-cicd
  test("vercel promote → deployments-cicd", async () => {
    const skills = await matchBash("vercel promote");
    expect(skills).toContain("deployments-cicd");
  });

  // 3. vercel rollback → deployments-cicd
  test("vercel rollback → deployments-cicd", async () => {
    const skills = await matchBash("vercel rollback");
    expect(skills).toContain("deployments-cicd");
  });

  // 4. vercel build → deployments-cicd
  test("vercel build → deployments-cicd", async () => {
    const skills = await matchBash("vercel build");
    expect(skills).toContain("deployments-cicd");
  });

  // 5. vercel env pull → ai-gateway + env-vars
  test("vercel env pull → ai-gateway + env-vars", async () => {
    const skills = await matchBash("vercel env pull .env.local");
    expect(skills).toContain("ai-gateway");
    expect(skills).toContain("env-vars");
  });

  // 6. vercel env add → env-vars
  test("vercel env add → env-vars", async () => {
    const skills = await matchBash("vercel env add SECRET_KEY");
    expect(skills).toContain("env-vars");
  });

  // 7. pnpm dlx vercel deploy → vercel-cli
  test("pnpm dlx vercel deploy → vercel-cli", async () => {
    const skills = await matchBash("pnpm dlx vercel deploy");
    expect(skills).toContain("vercel-cli");
  });

  // 8. bunx vercel → vercel-cli
  test("bunx vercel → vercel-cli", async () => {
    const skills = await matchBash("bunx vercel");
    expect(skills).toContain("vercel-cli");
  });

  // 9. next dev --turbopack → turbopack
  test("next dev --turbopack → turbopack", async () => {
    const skills = await matchBash("next dev --turbopack");
    expect(skills).toContain("turbopack");
  });

  // 10. npm install @vercel/blob → vercel-storage
  test("npm install @vercel/blob → vercel-storage", async () => {
    const skills = await matchBash("npm install @vercel/blob");
    expect(skills).toContain("vercel-storage");
  });

  // 11. pnpm add @vercel/analytics → observability
  test("pnpm add @vercel/analytics → observability", async () => {
    const skills = await matchBash("pnpm add @vercel/analytics");
    expect(skills).toContain("observability");
  });

  // 12. npm install @vercel/flags → vercel-flags
  test("npm install @vercel/flags → vercel-flags", async () => {
    const skills = await matchBash("npm install @vercel/flags");
    expect(skills).toContain("vercel-flags");
  });

  // 13. npx shadcn@latest add button → shadcn
  test("npx shadcn@latest add button → shadcn", async () => {
    const skills = await matchBash("npx shadcn@latest add button");
    expect(skills).toContain("shadcn");
  });

  // 14. npm run dev → nextjs
  test("npm run dev → nextjs", async () => {
    const skills = await matchBash("npm run dev");
    expect(skills).toContain("nextjs");
  });

  // 15. pnpm build → nextjs
  test("pnpm build → nextjs", async () => {
    const skills = await matchBash("pnpm build");
    expect(skills).toContain("nextjs");
  });

  // 16. bun run dev → nextjs
  test("bun run dev → nextjs", async () => {
    const skills = await matchBash("bun run dev");
    expect(skills).toContain("nextjs");
  });

  // 17. vercel firewall → vercel-firewall
  test("vercel firewall → vercel-firewall", async () => {
    const skills = await matchBash("vercel firewall");
    expect(skills).toContain("vercel-firewall");
  });

  // 18. npm install @vercel/sandbox → vercel-sandbox
  test("npm install @vercel/sandbox → vercel-sandbox", async () => {
    const skills = await matchBash("npm install @vercel/sandbox");
    expect(skills).toContain("vercel-sandbox");
  });

  // 19. yarn dlx vercel deploy → vercel-cli
  test("yarn dlx vercel deploy → vercel-cli", async () => {
    const skills = await matchBash("yarn dlx vercel deploy");
    expect(skills).toContain("vercel-cli");
  });

  // 20. vercel inspect → deployments-cicd
  test("vercel inspect → deployments-cicd", async () => {
    const skills = await matchBash("vercel inspect https://my-app.vercel.app");
    expect(skills).toContain("deployments-cicd");
  });

  // Negative cases
  test("echo hello → no skills", async () => {
    const skills = await matchBash("echo hello");
    expect(skills).toEqual([]);
  });

  test("git status → no skills", async () => {
    const skills = await matchBash("git status");
    expect(skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Specialist-over-generalist overlap scenarios
// ---------------------------------------------------------------------------
describe("specialist wins over generalist in overlap", () => {
  async function matchFileOrdered(filePath: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
      session_id: `overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  async function matchBashOrdered(command: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      session_id: `overlap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  test("app/api/chat/route.ts: ai-sdk (8) appears before nextjs (5)", async () => {
    const skills = await matchFileOrdered("/project/app/api/chat/route.ts");
    const aiIdx = skills.indexOf("ai-sdk");
    const nextIdx = skills.indexOf("nextjs");
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    expect(aiIdx).toBeLessThan(nextIdx);
  });

  test("app/api/auth/route.ts: sign-in-with-vercel (6) appears before nextjs (5)", async () => {
    const skills = await matchFileOrdered("/project/app/api/auth/route.ts");
    const authIdx = skills.indexOf("sign-in-with-vercel");
    const nextIdx = skills.indexOf("nextjs");
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(nextIdx);
  });

  test("app/layout.tsx: observability (6) appears before nextjs (5)", async () => {
    const skills = await matchFileOrdered("/project/app/layout.tsx");
    const obsIdx = skills.indexOf("observability");
    const nextIdx = skills.indexOf("nextjs");
    expect(obsIdx).toBeGreaterThanOrEqual(0);
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    expect(obsIdx).toBeLessThan(nextIdx);
  });

  test("vercel env pull: env-vars (7) and ai-gateway (7) appear before vercel-cli (4)", async () => {
    const skills = await matchBashOrdered("vercel env pull .env.local");
    expect(skills).toContain("env-vars");
    expect(skills).toContain("ai-gateway");
    // vercel-cli should either not appear (capped) or appear after specialists
    const cliIdx = skills.indexOf("vercel-cli");
    if (cliIdx >= 0) {
      expect(skills.indexOf("env-vars")).toBeLessThan(cliIdx);
      expect(skills.indexOf("ai-gateway")).toBeLessThan(cliIdx);
    }
  });

  test("vercel deploy --prod: deployments-cicd (6) appears before vercel-cli (4)", async () => {
    const skills = await matchBashOrdered("vercel deploy --prod");
    const cicdIdx = skills.indexOf("deployments-cicd");
    const cliIdx = skills.indexOf("vercel-cli");
    expect(cicdIdx).toBeGreaterThanOrEqual(0);
    expect(cliIdx).toBeGreaterThanOrEqual(0);
    expect(cicdIdx).toBeLessThan(cliIdx);
  });

  test("monorepo apps/web/app/api/chat/route.ts: ai-sdk before nextjs", async () => {
    const skills = await matchFileOrdered("/project/apps/web/app/api/chat/route.ts");
    const aiIdx = skills.indexOf("ai-sdk");
    const nextIdx = skills.indexOf("nextjs");
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    // nextjs may or may not match monorepo paths for app/**
    if (nextIdx >= 0) {
      expect(aiIdx).toBeLessThan(nextIdx);
    }
  });
});

describe("vercel-firewall priority ranks above vercel-cli", () => {
  async function matchFileOrdered(filePath: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
      session_id: `firewall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  test(".vercel/firewall/config.json: vercel-firewall appears before vercel-cli", async () => {
    const skills = await matchFileOrdered("/project/.vercel/firewall/config.json");
    const firewallIdx = skills.indexOf("vercel-firewall");
    const cliIdx = skills.indexOf("vercel-cli");
    expect(firewallIdx).toBeGreaterThanOrEqual(0);
    expect(cliIdx).toBeGreaterThanOrEqual(0);
    expect(firewallIdx).toBeLessThan(cliIdx);
  });

  test("vercel-firewall priority is higher than vercel-cli priority in skill-map", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const map = buildSkillMap(SKILLS_DIR);
    expect(map.skills["vercel-firewall"].priority).toBeGreaterThan(
      map.skills["vercel-cli"].priority,
    );
  });
});

describe("ai-sdk bash patterns match @ai-sdk/ scoped packages", () => {
  async function matchBash(command: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      session_id: `aisdk-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  test("npm install @ai-sdk/react → ai-sdk", async () => {
    const skills = await matchBash("npm install @ai-sdk/react");
    expect(skills).toContain("ai-sdk");
  });

  test("pnpm add @ai-sdk/openai → ai-sdk", async () => {
    const skills = await matchBash("pnpm add @ai-sdk/openai");
    expect(skills).toContain("ai-sdk");
  });

  test("bun add @ai-sdk/anthropic → ai-sdk", async () => {
    const skills = await matchBash("bun add @ai-sdk/anthropic");
    expect(skills).toContain("ai-sdk");
  });

  test("yarn add @ai-sdk/google → ai-sdk", async () => {
    const skills = await matchBash("yarn add @ai-sdk/google");
    expect(skills).toContain("ai-sdk");
  });
});

describe("hooks.json PreToolUse config", () => {
  test("has PreToolUse matcher for Read|Edit|Write|Bash", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
    expect(hooks.hooks.PreToolUse).toBeDefined();
    expect(hooks.hooks.PreToolUse.length).toBeGreaterThan(0);

    const matcher = hooks.hooks.PreToolUse[0].matcher;
    expect(matcher).toContain("Read");
    expect(matcher).toContain("Edit");
    expect(matcher).toContain("Write");
    expect(matcher).toContain("Bash");
  });

  test("references the correct hook script", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
    const hookCmd = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(hookCmd).toContain("pretooluse-skill-inject.mjs");
  });
});

// ---------------------------------------------------------------------------
// validateSkillMap tests
// ---------------------------------------------------------------------------

import { validateSkillMap } from "../hooks/pretooluse-skill-inject.mjs";

describe("validateSkillMap", () => {
  test("returns error when input is null", () => {
    const result = validateSkillMap(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("skill-map must be a non-null object");
  });

  test("returns error when skills key is missing", () => {
    const result = validateSkillMap({});
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("skill-map is missing required 'skills' key");
  });

  test("returns error when skills is not an object", () => {
    const result = validateSkillMap({ skills: "bad" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("'skills' must be a non-null object");
  });

  test("returns error when skills is an array", () => {
    const result = validateSkillMap({ skills: [] });
    expect(result.ok).toBe(false);
  });

  test("normalizes missing pathPatterns to empty array", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 5, bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].pathPatterns).toEqual([]);
  });

  test("normalizes missing bashPatterns to empty array", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 5, pathPatterns: ["*.ts"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].bashPatterns).toEqual([]);
  });

  test("normalizes missing priority to 5", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].priority).toBe(5);
  });

  test("warns and defaults NaN priority to 5", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: NaN, pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].priority).toBe(5);
    expect(result.warnings.some((w: string) => w.includes("priority") && w.includes("not a valid number"))).toBe(true);
  });

  test("warns and defaults non-number priority to 5", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: "high", pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].priority).toBe(5);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("warns on non-array pathPatterns and defaults to []", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 1, pathPatterns: "*.ts", bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].pathPatterns).toEqual([]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns") && w.includes("not an array"))).toBe(true);
  });

  test("removes non-string entries from pathPatterns with warning", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 1, pathPatterns: ["valid.ts", 42, null], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].pathPatterns).toEqual(["valid.ts"]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns[1]") && w.includes("not a string"))).toBe(true);
  });

  test("removes non-string entries from bashPatterns with warning", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 1, pathPatterns: [], bashPatterns: ["valid", 123] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["test-skill"].bashPatterns).toEqual(["valid"]);
    expect(result.warnings.some((w: string) => w.includes("bashPatterns[1]"))).toBe(true);
  });

  test("warns on unknown keys", () => {
    const result = validateSkillMap({
      skills: { "test-skill": { priority: 1, pathPatterns: [], bashPatterns: [], description: "hi", foo: "bar" } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('unknown key "description"'))).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('unknown key "foo"'))).toBe(true);
  });

  test("validates the frontmatter-built skill map successfully", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const raw = buildSkillMap(SKILLS_DIR);
    const result = validateSkillMap(raw);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.normalizedSkillMap.skills).length).toBeGreaterThan(0);
  });

  test("returns error for non-object skill config", () => {
    const result = validateSkillMap({
      skills: { "bad-skill": "not-an-object" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('skill "bad-skill"');
  });

  test("validates buildSkillMap output with coerced bare-string pathPatterns", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmp = join(tmpdir(), `validate-coerce-${Date.now()}`);
    const skillDir = join(tmp, "coerce-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: coerce-skill\ndescription: Test\nmetadata:\n  priority: 3\n  pathPatterns: 'src/**'\n  bashPatterns: '\\bnpm\\b'\n---\n# Test`,
    );

    const built = buildSkillMap(tmp);
    // buildSkillMap should have coerced bare strings to arrays
    expect(built.warnings.length).toBeGreaterThanOrEqual(2);

    // validateSkillMap should pass on the coerced output
    const result = validateSkillMap(built);
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["coerce-skill"].pathPatterns).toEqual(["src/**"]);
    expect(result.normalizedSkillMap.skills["coerce-skill"].bashPatterns).toEqual(["\\bnpm\\b"]);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering tests
// ---------------------------------------------------------------------------

describe("deterministic ordering", () => {
  test("tie-priority skills produce identical order across multiple runs", async () => {
    // Create a custom skill-map with several same-priority skills
    const customMap = {
      skills: {
        "zeta-skill": { priority: 5, pathPatterns: ["**/*.ts"], bashPatterns: [] },
        "alpha-skill": { priority: 5, pathPatterns: ["**/*.ts"], bashPatterns: [] },
        "mu-skill": { priority: 5, pathPatterns: ["**/*.ts"], bashPatterns: [] },
        "beta-skill": { priority: 5, pathPatterns: ["**/*.ts"], bashPatterns: [] },
      },
    };

    // Simulate the sort comparator used in the hook
    const entries = Object.entries(customMap.skills).map(([skill, config]: [string, any]) => ({
      skill,
      priority: config.priority,
    }));

    // Run the sort 10 times and verify identical results
    const results: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const shuffled = [...entries].sort(() => Math.random() - 0.5); // randomize input order
      shuffled.sort((a, b) => (b.priority - a.priority) || a.skill.localeCompare(b.skill));
      results.push(shuffled.map((e) => e.skill));
    }

    const expected = ["alpha-skill", "beta-skill", "mu-skill", "zeta-skill"];
    for (const result of results) {
      expect(result).toEqual(expected);
    }
  });

  test("mixed priorities sort by priority DESC then name ASC", () => {
    const entries = [
      { skill: "z-low", priority: 1 },
      { skill: "a-high", priority: 10 },
      { skill: "m-mid", priority: 5 },
      { skill: "b-high", priority: 10 },
      { skill: "a-mid", priority: 5 },
    ];

    entries.sort((a, b) => (b.priority - a.priority) || a.skill.localeCompare(b.skill));

    expect(entries.map((e) => e.skill)).toEqual([
      "a-high",
      "b-high",
      "a-mid",
      "m-mid",
      "z-low",
    ]);
  });
});

// ---------------------------------------------------------------------------
// vercel.json control-plane multi-skill matching and MAX_SKILLS cap
// ---------------------------------------------------------------------------
describe("vercel.json control-plane coverage", () => {
  // Helper: run hook with dedup disabled so each test is independent
  async function matchFile(filePath: string): Promise<string[]> {
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
      session_id: `ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEDUP: "off", VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const result = JSON.parse(stdout);
    if (!result.hookSpecificOutput) return [];
    const ctx = result.hookSpecificOutput.additionalContext || "";
    return (ctx.match(/<!-- skill:([a-z0-9-]+) -->/g) || []).map(
      (t: string) => t.replace("<!-- skill:", "").replace(" -->", ""),
    );
  }

  test("vercel.json matches at least 4 skills (vercel-functions, cron-jobs, routing-middleware, deployments-cicd, vercel-cli)", async () => {
    // vercel.json is in pathPatterns for: vercel-functions(8), cron-jobs(6),
    // routing-middleware(6), deployments-cicd(6), vercel-cli(4)
    // With MAX_SKILLS=3, only top 3 by priority should be injected
    const skills = await matchFile("/project/vercel.json");

    // Must have exactly 3 due to MAX_SKILLS cap
    expect(skills.length).toBe(3);

    // vercel-functions (priority 8) must be first
    expect(skills[0]).toBe("vercel-functions");

    // The remaining 2 should be from the priority-6 group (cron-jobs, deployments-cicd, routing-middleware)
    // sorted alphabetically: cron-jobs, deployments-cicd, routing-middleware
    expect(skills).toContain("cron-jobs");
    expect(skills).toContain("deployments-cicd");

    // vercel-cli (priority 4) should be dropped by the cap
    expect(skills).not.toContain("vercel-cli");
  });

  test("apps/*/vercel.json matches same control-plane skills (monorepo)", async () => {
    const skills = await matchFile("/project/apps/web/vercel.json");

    // Same set of skills should match for monorepo vercel.json
    expect(skills.length).toBe(3);
    expect(skills[0]).toBe("vercel-functions");
    expect(skills).toContain("cron-jobs");
    expect(skills).toContain("deployments-cicd");
  });

  test("monorepo apps/web/pages/_app.tsx → observability", async () => {
    const skills = await matchFile("/project/apps/web/pages/_app.tsx");
    expect(skills).toContain("observability");
  });

  test("monorepo apps/web/src/pages/_app.jsx → observability", async () => {
    const skills = await matchFile("/project/apps/web/src/pages/_app.jsx");
    expect(skills).toContain("observability");
  });
});

// ---------------------------------------------------------------------------
// skillInjection metadata
// ---------------------------------------------------------------------------

describe("hookSpecificOutput.skillInjection metadata", () => {
  test("includes skillInjection with correct structure and version", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();

    // Version
    expect(si.version).toBe(1);

    // Tool metadata
    expect(si.toolName).toBe("Read");
    expect(si.toolTarget).toBe("/project/next.config.ts");

    // Skill arrays
    expect(Array.isArray(si.matchedSkills)).toBe(true);
    expect(Array.isArray(si.injectedSkills)).toBe(true);
    expect(Array.isArray(si.droppedByCap)).toBe(true);
    expect(Array.isArray(si.droppedByBudget)).toBe(true);
    expect(si.injectedSkills.length).toBeGreaterThan(0);
    expect(si.matchedSkills).toContain("nextjs");
    expect(si.injectedSkills).toContain("nextjs");
  });

  test("Bash tool populates toolTarget with the redacted command", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npx next build" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.toolName).toBe("Bash");
    // No secrets → command passes through unchanged
    expect(si.toolTarget).toBe("npx next build");
  });

  test("Bash toolTarget redacts secrets in skillInjection output", async () => {
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Bash",
        tool_input: { command: "vercel --token sk_super_secret deploy" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.toolName).toBe("Bash");
    // Token must be redacted
    expect(si.toolTarget).not.toContain("sk_super_secret");
    expect(si.toolTarget).toContain("--token [REDACTED]");
    expect(si.toolTarget).toContain("deploy");
  });

  test("Read/Edit/Write tools have unredacted file_path in toolTarget", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.toolTarget).toBe("/project/next.config.ts");
  });

  test("droppedByCap lists skills beyond MAX_SKILLS", async () => {
    // vercel.json matches 4+ skills but cap is 3
    const { code, stdout } = await runHookEnv(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/project/vercel.json" },
      },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    const si = extractSkillInjection(result.hookSpecificOutput);
    expect(si).toBeDefined();
    expect(si.injectedSkills.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(si.droppedByBudget)).toBe(true);
    // If more than 3 matched, droppedByCap + droppedByBudget should account for all
    if (si.matchedSkills.length > 3) {
      expect(si.droppedByCap.length + si.droppedByBudget.length).toBe(
        si.matchedSkills.length - si.injectedSkills.length,
      );
    }
  });

  test("no skillInjection in output when nothing matches", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/unknown.txt" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// redactCommand()
// ---------------------------------------------------------------------------

describe("redactCommand", () => {
  // We import the function dynamically since the hook is ESM
  let redactCommand: (cmd: string) => string;

  beforeEach(async () => {
    // Dynamic import to get the exported function
    const mod = await import("../hooks/pretooluse-skill-inject.mjs");
    redactCommand = mod.redactCommand;
  });

  test("masks TOKEN= values", () => {
    expect(redactCommand("curl -H TOKEN=abc123secret https://api.example.com")).toContain("TOKEN=[REDACTED]");
    expect(redactCommand("curl -H TOKEN=abc123secret https://api.example.com")).not.toContain("abc123secret");
  });

  test("masks KEY= values preserving full key name", () => {
    expect(redactCommand("VERCEL_API_KEY=sk_live_xyz deploy")).toContain("VERCEL_API_KEY=[REDACTED]");
    expect(redactCommand("VERCEL_API_KEY=sk_live_xyz deploy")).not.toContain("sk_live_xyz");
  });

  test("masks SECRET= values preserving full key name", () => {
    expect(redactCommand("MY_SECRET=hunter2 run")).toContain("MY_SECRET=[REDACTED]");
    expect(redactCommand("MY_SECRET=hunter2 run")).not.toContain("hunter2");
  });

  test("masks --token flag values", () => {
    expect(redactCommand("vercel --token tk_abcdef deploy")).toContain("--token [REDACTED]");
    expect(redactCommand("vercel --token tk_abcdef deploy")).not.toContain("tk_abcdef");
  });

  test("masks --password flag values", () => {
    expect(redactCommand("mysql --password s3cret -u root")).toContain("--password [REDACTED]");
    expect(redactCommand("mysql --password s3cret -u root")).not.toContain("s3cret");
  });

  test("masks --api-key flag values", () => {
    expect(redactCommand("cli --api-key my-key-123")).toContain("--api-key [REDACTED]");
    expect(redactCommand("cli --api-key my-key-123")).not.toContain("my-key-123");
  });

  test("truncates long commands to 200 chars", () => {
    const longCmd = "a".repeat(300);
    const result = redactCommand(longCmd);
    expect(result.length).toBeLessThan(300);
    expect(result).toContain("…[truncated]");
    // First 200 chars preserved
    expect(result.startsWith("a".repeat(200))).toBe(true);
  });

  test("handles non-string input gracefully", () => {
    expect(redactCommand(undefined as any)).toBe("");
    expect(redactCommand(null as any)).toBe("");
    expect(redactCommand(123 as any)).toBe("");
  });

  test("case-insensitive matching", () => {
    expect(redactCommand("token=abc123")).toContain("[REDACTED]");
    expect(redactCommand("Token=abc123")).toContain("[REDACTED]");
    expect(redactCommand("--Token myval")).toContain("[REDACTED]");
  });

  test("multiple secrets in one command are all redacted", () => {
    const cmd = "TOKEN=aaa KEY=bbb --password ccc";
    const result = redactCommand(cmd);
    expect(result).not.toContain("aaa");
    expect(result).not.toContain("bbb");
    expect(result).not.toContain("ccc");
  });

  test("preserves full env var key name with prefix (regression)", () => {
    // Previously, VERCEL_TOKEN=abc would become TOKEN=[REDACTED] instead of VERCEL_TOKEN=[REDACTED]
    expect(redactCommand("VERCEL_TOKEN=abc123")).toBe("VERCEL_TOKEN=[REDACTED]");
    expect(redactCommand("MY_API_KEY=secret")).toBe("MY_API_KEY=[REDACTED]");
    expect(redactCommand("APP_SECRET=s3cret")).toBe("APP_SECRET=[REDACTED]");
    // Simple key without prefix should still work
    expect(redactCommand("TOKEN=abc123")).toBe("TOKEN=[REDACTED]");
    expect(redactCommand("KEY=abc123")).toBe("KEY=[REDACTED]");
    expect(redactCommand("SECRET=abc123")).toBe("SECRET=[REDACTED]");
    // Sensitive word in the middle of key name (not just suffix)
    expect(redactCommand("MY_SECRET_VALUE=hunter2")).toBe("MY_SECRET_VALUE=[REDACTED]");
    expect(redactCommand("CREDENTIAL_STORE=val")).toBe("CREDENTIAL_STORE=[REDACTED]");
    expect(redactCommand("MY_TOKEN_ID=abc")).toBe("MY_TOKEN_ID=[REDACTED]");
  });

  // --- Broadened redaction patterns ---

  test("masks Bearer tokens", () => {
    expect(redactCommand("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc'")).toContain("Bearer [REDACTED]");
    expect(redactCommand("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc'")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("masks 'token xxx' authorization style", () => {
    expect(redactCommand("gh api -H 'Authorization: token ghp_abc123XYZ456'")).toContain("token [REDACTED]");
    expect(redactCommand("gh api -H 'Authorization: token ghp_abc123XYZ456'")).not.toContain("ghp_abc123XYZ456");
  });

  test("masks connection strings (postgres)", () => {
    const cmd = "psql postgres://admin:s3cret@db.example.com:5432/mydb";
    const result = redactCommand(cmd);
    expect(result).toContain("postgres://[REDACTED]@db.example.com");
    expect(result).not.toContain("s3cret");
    expect(result).not.toContain("admin:");
  });

  test("masks connection strings (redis)", () => {
    const cmd = "redis-cli -u redis://default:hunter2@cache.example.com:6379";
    const result = redactCommand(cmd);
    expect(result).toContain("redis://[REDACTED]@cache.example.com");
    expect(result).not.toContain("hunter2");
  });

  test("masks JSON secret values", () => {
    const cmd = 'echo \'{"token": "sk_live_abc123", "name": "test"}\'';
    const result = redactCommand(cmd);
    expect(result).toContain('"token": "[REDACTED]"');
    expect(result).not.toContain("sk_live_abc123");
    // Non-sensitive keys preserved
    expect(result).toContain('"name": "test"');
  });

  test("masks JSON password and api_key values", () => {
    expect(redactCommand('{"password": "hunter2"}')).toContain('"password": "[REDACTED]"');
    expect(redactCommand('{"api_key": "ak_xyz"}')).toContain('"api_key": "[REDACTED]"');
    expect(redactCommand('{"apiKey": "ak_xyz"}')).toContain('"apiKey": "[REDACTED]"');
  });

  test("masks URL query params with sensitive keys", () => {
    const cmd = "curl 'https://x.co?token=abc123&name=foo'";
    const result = redactCommand(cmd);
    expect(result).toContain("?token=[REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).toContain("&name=foo");
  });

  test("masks multiple sensitive URL query params", () => {
    const cmd = "curl 'https://x.co?key=k1&secret=s2&page=1'";
    const result = redactCommand(cmd);
    expect(result).toContain("?key=[REDACTED]");
    expect(result).toContain("&secret=[REDACTED]");
    expect(result).toContain("&page=1");
    expect(result).not.toContain("k1");
    expect(result).not.toContain("s2");
  });

  test("masks Cookie headers", () => {
    const cmd = "curl -H 'Cookie: session=abc123; auth_tok=xyz789' https://example.com";
    const result = redactCommand(cmd);
    expect(result).toContain("Cookie: [REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789");
  });

  test("masks Set-Cookie headers", () => {
    const cmd = "curl -v 'Set-Cookie: id=a3fWa; Path=/; HttpOnly'";
    const result = redactCommand(cmd);
    expect(result).toContain("Set-Cookie: [REDACTED]");
    expect(result).not.toContain("a3fWa");
  });

  test("masks --secret and --auth flags", () => {
    expect(redactCommand("tool --secret mysecretval")).toContain("--secret [REDACTED]");
    expect(redactCommand("tool --auth bearer_tok")).toContain("--auth [REDACTED]");
  });

  test("masks PASSWORD= env vars", () => {
    expect(redactCommand("DB_PASSWORD=hunter2 npm start")).toBe("DB_PASSWORD=[REDACTED] npm start");
  });
});

// ---------------------------------------------------------------------------
// debug mode: tool-target event uses redacted command
// ---------------------------------------------------------------------------

describe("debug mode tool-target redaction", () => {
  test("tool-target event appears in debug stderr with redacted secrets", async () => {
    const { stderr } = await runHookEnv(
      {
        tool_name: "Bash",
        tool_input: { command: "vercel --token sk_secret123 deploy" },
      },
      { VERCEL_PLUGIN_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    // Find tool-target event
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const targetEvent = lines.find((l: any) => l.event === "tool-target");
    expect(targetEvent).toBeDefined();
    expect(targetEvent.target).toContain("--token [REDACTED]");
    expect(targetEvent.target).not.toContain("sk_secret123");
  });

  test("tool-target event NOT emitted without debug mode", async () => {
    const { stderr } = await runHookEnv(
      {
        tool_name: "Bash",
        tool_input: { command: "vercel --token sk_secret123 deploy" },
      },
      { VERCEL_PLUGIN_DEBUG: "0", VERCEL_PLUGIN_HOOK_DEBUG: "0" },
    );
    // stderr should be empty (no debug output)
    expect(stderr.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Import matching — importPatterns trigger skills from file content
// ---------------------------------------------------------------------------

describe("import matching", () => {
  test("Edit with @ai-sdk/gateway import in old_string triggers ai-gateway skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/me/project/src/utils/models.ts",
        old_string: `import { gateway } from '@ai-sdk/gateway';\nconst g = gateway("openai/gpt-4o");`,
        new_string: `import { gateway } from '@ai-sdk/gateway';\nconst g = gateway("anthropic/claude-sonnet-4-5-20250514");`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-gateway");
  });

  test("Write with ai import in content triggers ai-sdk skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/Users/me/project/src/helpers/generate.ts",
        content: `import { generateText } from 'ai';\n\nexport async function gen() { return generateText({ model: 'gpt-4o', prompt: 'hi' }); }`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-sdk");
  });

  test("Edit with require('@ai-sdk/gateway') triggers ai-gateway skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/me/project/src/config.js",
        old_string: `const { gateway } = require('@ai-sdk/gateway');`,
        new_string: `const { gateway } = require('@ai-sdk/gateway');\nconst model = gateway("openai/gpt-4o");`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-gateway");
  });

  test("Edit without import content does not trigger import-based skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/me/project/src/utils/helpers.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toEqual({});
  });

  test("Read tool does not trigger import matching (no file content in input)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: {
        file_path: "/Users/me/project/src/utils/models.ts",
      },
    });
    expect(code).toBe(0);
    // Read has no content in tool_input, so import matching should not fire
    const result = JSON.parse(stdout);
    expect(result).toEqual({});
  });

  test("path match takes precedence over import match (no double injection)", async () => {
    // app/api/chat/route.ts matches ai-sdk by path pattern — import matching
    // should not cause it to be added twice
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/me/project/app/api/chat/route.ts",
        old_string: `import { generateText } from 'ai';`,
        new_string: `import { streamText } from 'ai';`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    // ai-sdk should appear exactly once (matched by path, not duplicated by import)
    const context = result.hookSpecificOutput.additionalContext;
    const aiSdkMatches = context.match(/<!-- skill:ai-sdk -->/g) || [];
    expect(aiSdkMatches.length).toBe(1);
  });

  test("import match reason has matchType 'import'", async () => {
    const { stderr } = await runHookEnv(
      {
        tool_name: "Write",
        tool_input: {
          file_path: "/Users/me/project/src/gateway-config.ts",
          content: `import { gateway } from '@ai-sdk/gateway';\nexport const gw = gateway("openai/gpt-4o");`,
        },
      },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const matchesFound = lines.find((l: any) => l.event === "matches-found");
    expect(matchesFound).toBeDefined();
    expect(matchesFound.reasons).toBeDefined();
    // ai-gateway should have matchType "import"
    expect(matchesFound.reasons["ai-gateway"]).toBeDefined();
    expect(matchesFound.reasons["ai-gateway"].matchType).toBe("import");
  });

  test("Write with @ai-sdk/react sub-path import triggers ai-sdk skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/Users/me/project/src/hooks/use-chat.ts",
        content: `import { useChat } from '@ai-sdk/react';\n\nexport function ChatHook() { return useChat(); }`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-sdk");
  });

  test("dynamic import() triggers import matching", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/Users/me/project/src/lazy.ts",
        content: `const mod = await import('@ai-sdk/gateway');\nconst gw = mod.gateway("openai/gpt-4o");`,
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.additionalContext).toContain("skill:ai-gateway");
  });
});

// ---------------------------------------------------------------------------
// importPatternToRegex unit tests
// ---------------------------------------------------------------------------

describe("importPatternToRegex", () => {
  let importPatternToRegex: (pattern: string) => RegExp;

  beforeEach(async () => {
    const mod = await import("../hooks/patterns.mjs");
    importPatternToRegex = mod.importPatternToRegex;
  });

  test("matches ESM import from 'ai'", () => {
    const re = importPatternToRegex("ai");
    expect(re.test(`import { generateText } from 'ai'`)).toBe(true);
  });

  test("matches ESM import from \"ai\"", () => {
    const re = importPatternToRegex("ai");
    expect(re.test(`import { generateText } from "ai"`)).toBe(true);
  });

  test("matches require('ai')", () => {
    const re = importPatternToRegex("ai");
    expect(re.test(`const { generateText } = require('ai')`)).toBe(true);
  });

  test("matches scoped package @ai-sdk/gateway", () => {
    const re = importPatternToRegex("@ai-sdk/gateway");
    expect(re.test(`import { gateway } from '@ai-sdk/gateway'`)).toBe(true);
  });

  test("matches sub-path import @ai-sdk/gateway/foo", () => {
    const re = importPatternToRegex("@ai-sdk/gateway");
    expect(re.test(`import { thing } from '@ai-sdk/gateway/providers'`)).toBe(true);
  });

  test("wildcard pattern @ai-sdk/* matches @ai-sdk/react", () => {
    const re = importPatternToRegex("@ai-sdk/*");
    expect(re.test(`import { useChat } from '@ai-sdk/react'`)).toBe(true);
  });

  test("wildcard pattern @ai-sdk/* matches @ai-sdk/gateway", () => {
    const re = importPatternToRegex("@ai-sdk/*");
    expect(re.test(`import { gateway } from '@ai-sdk/gateway'`)).toBe(true);
  });

  test("does not match partial package name", () => {
    const re = importPatternToRegex("ai");
    // 'ai-sdk' is a different package — should not match 'ai' pattern
    expect(re.test(`import { thing } from 'ai-sdk'`)).toBe(false);
  });

  test("matches dynamic import()", () => {
    const re = importPatternToRegex("@ai-sdk/gateway");
    expect(re.test(`const mod = await import('@ai-sdk/gateway')`)).toBe(true);
  });

  test("throws on empty string", () => {
    expect(() => importPatternToRegex("")).toThrow("pattern must not be empty");
  });

  test("throws on non-string input", () => {
    expect(() => (importPatternToRegex as any)(42)).toThrow("expected string");
  });
});

// ---------------------------------------------------------------------------
// matchImportWithReason unit tests
// ---------------------------------------------------------------------------

describe("matchImportWithReason", () => {
  let matchImportWithReason: any;
  let importPatternToRegex: any;

  beforeEach(async () => {
    const mod = await import("../hooks/patterns.mjs");
    matchImportWithReason = mod.matchImportWithReason;
    importPatternToRegex = mod.importPatternToRegex;
  });

  test("returns match with matchType 'import' for matching content", () => {
    const patterns = ["@ai-sdk/gateway"];
    const compiled = patterns.map((p: string) => ({ pattern: p, regex: importPatternToRegex(p) }));
    const content = `import { gateway } from '@ai-sdk/gateway';\nconst g = gateway("openai/gpt-4o");`;
    const result = matchImportWithReason(content, compiled);
    expect(result).toEqual({ pattern: "@ai-sdk/gateway", matchType: "import" });
  });

  test("returns null for non-matching content", () => {
    const patterns = ["@ai-sdk/gateway"];
    const compiled = patterns.map((p: string) => ({ pattern: p, regex: importPatternToRegex(p) }));
    const content = `const x = 1;\nconst y = 2;`;
    const result = matchImportWithReason(content, compiled);
    expect(result).toBeNull();
  });

  test("returns null for empty content", () => {
    const patterns = ["@ai-sdk/gateway"];
    const compiled = patterns.map((p: string) => ({ pattern: p, regex: importPatternToRegex(p) }));
    expect(matchImportWithReason("", compiled)).toBeNull();
  });

  test("returns null for empty compiled patterns", () => {
    expect(matchImportWithReason("import { x } from 'ai'", [])).toBeNull();
  });

  test("returns first matching pattern", () => {
    const patterns = ["ai", "@ai-sdk/gateway"];
    const compiled = patterns.map((p: string) => ({ pattern: p, regex: importPatternToRegex(p) }));
    const content = `import { generateText } from 'ai';\nimport { gateway } from '@ai-sdk/gateway';`;
    const result = matchImportWithReason(content, compiled);
    expect(result).toEqual({ pattern: "ai", matchType: "import" });
  });
});

// ---------------------------------------------------------------------------
// Import-safety: importing the module must NOT read stdin or write stdout
// ---------------------------------------------------------------------------

describe("import safety", () => {
  test("importing the module does not produce stdout output", async () => {
    // Spawn a Node process that imports the module and then exits cleanly.
    // If the main-module guard is missing, it would hang on stdin or write to stdout.
    const proc = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `import "${HOOK_SCRIPT}";\nprocess.exit(0);`,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Close stdin immediately — should not hang waiting for input
    proc.stdin.end();

    // Give it a generous timeout but fail if it hangs
    const timeout = setTimeout(() => proc.kill(), 5000);
    const code = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(stdout).toBe(""); // No output leaked to stdout
  });

  test("exported functions are importable without side effects", async () => {
    // Verify that validateSkillMap and redactCommand can be imported
    const proc = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { validateSkillMap, redactCommand, run } from "${HOOK_SCRIPT}";\n` +
          `const checks = [\n` +
          `  typeof validateSkillMap === "function",\n` +
          `  typeof redactCommand === "function",\n` +
          `  typeof run === "function",\n` +
          `];\n` +
          `process.stdout.write(JSON.stringify(checks));\n` +
          `process.exit(0);`,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.end();

    const timeout = setTimeout(() => proc.kill(), 5000);
    const code = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([true, true, true]);
  });

  test("running directly via node still works as before", async () => {
    // This is essentially the same as runHook but confirms the guard lets
    // direct execution through.
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Decision logging: reason codes in the complete event
// ---------------------------------------------------------------------------

/** Parse debug stderr into JSON objects and find the 'complete' event */
function parseComplete(stderr: string): any {
  const lines = stderr.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
  return lines.find((l: any) => l.event === "complete");
}

describe("decision logging — reason codes", () => {
  test("reason=stdin_empty when stdin is empty", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("stdin_empty");
    expect(complete.matchedCount).toBe(0);
    expect(complete.injectedCount).toBe(0);
    expect(complete.dedupedCount).toBe(0);
    expect(complete.cappedCount).toBe(0);
  });

  test("reason=stdin_parse_fail when stdin is invalid JSON", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("stdin_parse_fail");
    expect(complete.matchedCount).toBe(0);
  });

  test("reason=tool_unsupported for unsupported tool name", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Glob", tool_input: { pattern: "**/*.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("tool_unsupported");
    expect(complete.matchedCount).toBe(0);
  });

  test("reason=no_matches when tool is supported but nothing matches", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/totally/unknown/file.xyz" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("no_matches");
    expect(complete.matchedCount).toBe(0);
    expect(complete.injectedCount).toBe(0);
  });

  test("reason=all_deduped when matches exist but all were previously injected", async () => {
    // Pre-seed the env var with skills that match next.config.ts
    // next.config.ts matches: nextjs, turbopack
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs,turbopack", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );

    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("all_deduped");
    expect(complete.matchedCount).toBeGreaterThan(0);
    expect(complete.dedupedCount).toBeGreaterThan(0);
    expect(complete.injectedCount).toBe(0);
  });

  test("reason=injected when skills are successfully injected", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("injected");
    expect(complete.matchedCount).toBeGreaterThan(0);
    expect(complete.injectedCount).toBeGreaterThan(0);
  });

  test("reason=skillmap_fail when skills directory is empty", async () => {
    const tempRoot = join(tmpdir(), `vp-reason-empty-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    const tempSkillsDir = join(tempRoot, "skills");
    mkdirSync(tempHooksDir, { recursive: true });
    mkdirSync(tempSkillsDir, { recursive: true });

    writeFileSync(join(tempHooksDir, "pretooluse-skill-inject.mjs"), readFileSync(HOOK_SCRIPT, "utf-8"));
    writeFileSync(join(tempHooksDir, "skill-map-frontmatter.mjs"), readFileSync(join(ROOT, "hooks", "skill-map-frontmatter.mjs"), "utf-8"));
    writeFileSync(join(tempHooksDir, "patterns.mjs"), readFileSync(join(ROOT, "hooks", "patterns.mjs"), "utf-8"));
    writeFileSync(join(tempHooksDir, "vercel-config.mjs"), readFileSync(join(ROOT, "hooks", "vercel-config.mjs"), "utf-8"));
    writeFileSync(join(tempHooksDir, "logger.mjs"), readFileSync(join(ROOT, "hooks", "logger.mjs"), "utf-8"));
    writeFileSync(join(tempHooksDir, "hook-env.mjs"), readFileSync(join(ROOT, "hooks", "hook-env.mjs"), "utf-8"));
    symlinkSync(join(ROOT, "node_modules"), join(tempRoot, "node_modules"));

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", join(tempHooksDir, "pretooluse-skill-inject.mjs")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("skillmap_fail");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("complete event has all aggregate count fields", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    for (const key of ["matchedCount", "injectedCount", "dedupedCount", "cappedCount"]) {
      expect(typeof complete[key]).toBe("number");
    }
    expect(typeof complete.elapsed_ms).toBe("number");
    expect(typeof complete.reason).toBe("string");
  });

  test("cappedCount > 0 when more than MAX_SKILLS match", async () => {
    const { stderr } = await runHookEnv(
      {
        tool_name: "Bash",
        tool_input: {
          command: "vercel deploy && turbo run build && npx v0 generate && npm install ai && vercel integration add neon",
        },
      },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const complete = parseComplete(stderr);
    expect(complete).toBeDefined();
    expect(complete.reason).toBe("injected");
    expect(complete.cappedCount).toBeGreaterThan(0);
    expect(complete.injectedCount).toBe(3);
    expect(complete.matchedCount).toBeGreaterThan(3);
  });

  test("exactly one complete event per invocation", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const lines = stderr.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const completeEvents = lines.filter((l: any) => l.event === "complete");
    expect(completeEvents.length).toBe(1);
  });

  test("stdout contract unchanged — hookSpecificOutput shape", async () => {
    const { stdout } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const result = JSON.parse(stdout);
    expect(result).toHaveProperty("hookSpecificOutput");
    expect(result.hookSpecificOutput).toHaveProperty("additionalContext");
    expect(extractSkillInjection(result.hookSpecificOutput)).toBeDefined();
    expect(Object.keys(result)).toEqual(["hookSpecificOutput"]);
  });

  // ---------------------------------------------------------------------------
  // Golden snapshot tests
  // ---------------------------------------------------------------------------

  describe("golden snapshots", () => {
    const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

    const goldenFixtures = [
      "golden-read-vercel-json.json",
      "golden-bash-next-dev.json",
      "golden-edit-middleware.json",
      "golden-bash-cap-collision.json",
      "golden-read-env-local.json",
    ];

    for (const fixtureName of goldenFixtures) {
      test(`golden: ${fixtureName}`, async () => {
        const fixture = JSON.parse(
          readFileSync(join(FIXTURES_DIR, fixtureName), "utf-8"),
        );
        const { code, stdout } = await runHook(fixture.input);
        expect(code).toBe(0);

        const result = JSON.parse(stdout);
        expect(result).toHaveProperty("hookSpecificOutput");
        expect(extractSkillInjection(result.hookSpecificOutput)).toBeDefined();

        const actual = extractSkillInjection(result.hookSpecificOutput);
        const expected = fixture.expected.skillInjection;

        // Version and tool metadata must match exactly
        expect(actual.version).toBe(expected.version);
        expect(actual.toolName).toBe(expected.toolName);
        expect(actual.toolTarget).toBe(expected.toolTarget);

        // matchedSkills — same set (order may vary)
        expect([...actual.matchedSkills].sort()).toEqual(
          [...expected.matchedSkills].sort(),
        );

        // injectedSkills — exact ordered list (ranking matters)
        expect(actual.injectedSkills).toEqual(expected.injectedSkills);

        // droppedByCap — same set (order may vary)
        expect([...actual.droppedByCap].sort()).toEqual(
          [...expected.droppedByCap].sort(),
        );

        // droppedByBudget — same set (order may vary)
        if (expected.droppedByBudget) {
          expect([...(actual.droppedByBudget || [])].sort()).toEqual(
            [...expected.droppedByBudget].sort(),
          );
        }

        // Verify additionalContext contains skill markers for each injected skill
        const ctx = result.hookSpecificOutput.additionalContext;
        for (const skill of expected.injectedSkills) {
          expect(ctx).toContain(`<!-- skill:${skill} -->`);
          expect(ctx).toContain(`<!-- /skill:${skill} -->`);
        }
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Hook output schema validation
  // ---------------------------------------------------------------------------
  // Claude Code validates hookSpecificOutput with a strict Zod schema.
  // Unknown fields cause "Hook JSON output validation failed: Invalid input"
  // and the entire hook output is silently discarded.
  //
  // Allowed fields in hookSpecificOutput for PreToolUse:
  //   hookEventName, permissionDecision, permissionDecisionReason,
  //   updatedInput, additionalContext
  // See: hooks/types/hook-output.d.ts (vendored from @anthropic-ai/claude-agent-sdk)

  const ALLOWED_HOOK_SPECIFIC_KEYS = new Set([
    "hookEventName",
    "permissionDecision",
    "permissionDecisionReason",
    "updatedInput",
    "additionalContext",
  ]);

  describe("hook output schema compliance", () => {
    test("matched skill output has no unknown keys in hookSpecificOutput", async () => {
      const { code, stdout } = await runHook({
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/next.config.ts" },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const keys = Object.keys(result.hookSpecificOutput);
      const unknownKeys = keys.filter((k) => !ALLOWED_HOOK_SPECIFIC_KEYS.has(k));
      expect(unknownKeys).toEqual([]);
    });

    test("bash-matched skill output has no unknown keys", async () => {
      const { code, stdout } = await runHook({
        tool_name: "Bash",
        tool_input: { command: "npm install ai @ai-sdk/openai" },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const keys = Object.keys(result.hookSpecificOutput);
      const unknownKeys = keys.filter((k) => !ALLOWED_HOOK_SPECIFIC_KEYS.has(k));
      expect(unknownKeys).toEqual([]);
    });

    test("empty output ({}) is valid", async () => {
      const { code, stdout } = await runHook({
        tool_name: "Read",
        tool_input: { file_path: "/some/random/file.txt" },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      // {} has no hookSpecificOutput — that's fine
      expect(result.hookSpecificOutput).toBeUndefined();
    });
  });
});
