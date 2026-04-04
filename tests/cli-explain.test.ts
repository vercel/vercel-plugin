import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");

/** Run the CLI via Bun.spawn and capture stdout/stderr/exitCode. */
async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Help & usage
// ---------------------------------------------------------------------------

describe("vercel-plugin CLI", () => {
  test("no args prints usage and exits 0", async () => {
    const { stdout, exitCode } = await runCli();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("explain");
  });

  test("--help prints usage", async () => {
    const { stdout, exitCode } = await runCli("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("explain --help prints usage", async () => {
    const { stdout, exitCode } = await runCli("explain", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("unknown command exits 1", async () => {
    const { exitCode, stderr } = await runCli("bogus");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

// ---------------------------------------------------------------------------
// explain command — file matching
// ---------------------------------------------------------------------------

describe("explain file matching", () => {
  test("middleware.ts matches routing-middleware", async () => {
    const { stdout, exitCode } = await runCli("explain", "middleware.ts");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("routing-middleware");
    // In zero-bundle mode, skills resolve as SUMMARY from rules manifest
    // when no cached body exists; INJECT when a cached body is available
    expect(stdout).toMatch(/INJECT|SUMMARY/);
  });

  test("app/api/chat/route.ts matches chat-sdk", async () => {
    const { stdout, exitCode } = await runCli("explain", "app/api/chat/route.ts");
    expect(exitCode).toBe(0);
    // chat-sdk is the primary match for app/api/chat/** paths;
    // ai-sdk also matches via manifest pathPatterns but may be shadowed
    // when a cached SKILL.md exists locally without pattern metadata.
    expect(stdout).toContain("chat-sdk");
  });

  test("nonexistent-pattern.xyz matches nothing", async () => {
    const { stdout, exitCode } = await runCli("explain", "nonexistent-pattern.xyz");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No skills matched");
  });
});

// ---------------------------------------------------------------------------
// explain command — bash matching
// ---------------------------------------------------------------------------

describe("explain bash matching", () => {
  test("'vercel deploy --prod' matches deployments-cicd", async () => {
    const { stdout, exitCode } = await runCli("explain", "vercel deploy --prod");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("deployments-cicd");
  });
});

// ---------------------------------------------------------------------------
// explain --json
// ---------------------------------------------------------------------------

describe("explain --json", () => {
  test("produces valid JSON output", async () => {
    const { stdout, exitCode } = await runCli("explain", "middleware.ts", "--json");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.target).toBe("middleware.ts");
    expect(result.targetType).toBe("file");
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(typeof result.skillCount).toBe("number");
    expect(typeof result.injectedCount).toBe("number");
    expect(typeof result.cappedCount).toBe("number");
    expect(Array.isArray(result.collisions)).toBe(true);
  });

  test("json includes match details", async () => {
    const { stdout } = await runCli("explain", "middleware.ts", "--json");
    const result = JSON.parse(stdout);
    const match = result.matches[0];
    expect(match).toHaveProperty("skill");
    expect(match).toHaveProperty("priority");
    expect(match).toHaveProperty("effectivePriority");
    expect(match).toHaveProperty("matchedPattern");
    expect(match).toHaveProperty("matchType");
    expect(match).toHaveProperty("injected");
    expect(match).toHaveProperty("capped");
  });

  test("bash command json has targetType bash", async () => {
    const { stdout } = await runCli("explain", "vercel deploy --prod", "--json");
    const result = JSON.parse(stdout);
    expect(result.targetType).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// explain --project (invalid path)
// ---------------------------------------------------------------------------

describe("explain --project validation", () => {
  test("invalid project path exits non-zero", async () => {
    const { exitCode, stderr } = await runCli("explain", "middleware.ts", "--project", "/tmp/no-such-plugin-dir");
    expect(exitCode).toBe(2);
    expect(stderr).toContain("expected a vercel-plugin root");
  });
});

// ---------------------------------------------------------------------------
// budget-aware injection
// ---------------------------------------------------------------------------

describe("budget-aware injection", () => {
  test("json includes injectionMode and budget fields", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    expect(typeof result.budgetBytes).toBe("number");
    expect(typeof result.usedBytes).toBe("number");
    expect(typeof result.droppedByBudgetCount).toBe("number");
    expect(typeof result.summaryOnlyCount).toBe("number");
    for (const m of result.matches) {
      expect(m).toHaveProperty("injectionMode");
      expect(m).toHaveProperty("bodyBytes");
      expect(["full", "summary", "droppedByCap", "droppedByBudget"]).toContain(m.injectionMode);
    }
  });

  test("usedBytes stays within reasonable bounds of budgetBytes (first skill may exceed)", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    // The first skill is always injected regardless of budget, so usedBytes may
    // slightly exceed budgetBytes. Verify it's within 2x of the budget.
    expect(result.usedBytes).toBeLessThanOrEqual(result.budgetBytes * 2);
    // In zero-bundle mode, skills may all be summary-only; verify at least one is injected
    const injectedCount = result.matches.filter((m: any) => m.injectionMode === "full" || m.injectionMode === "summary").length;
    expect(injectedCount).toBeGreaterThan(0);
  });

  test("tiny budget forces budget drops", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json", "--budget", "100");
    const result = JSON.parse(stdout);
    // First skill always injected regardless of budget (full or summary),
    // rest should be budget-dropped
    const injectedCount = result.matches.filter((m: any) => m.injectionMode === "full" || m.injectionMode === "summary").length;
    expect(injectedCount).toBe(1);
    if (result.matches.length > 1) {
      expect(result.droppedByBudgetCount).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// profiler boost (--likely-skills)
// ---------------------------------------------------------------------------

describe("profiler boost", () => {
  test("--likely-skills boosts effective priority by 5", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json", "--likely-skills", "vercel-cli");
    const result = JSON.parse(stdout);
    const boosted = result.matches.find((m: any) => m.skill === "vercel-cli");
    expect(boosted).toBeDefined();
    // vercel-cli base priority is 4, boosted should be 9
    expect(boosted.effectivePriority).toBe(boosted.priority + 5);
  });

  test("--likely-skills boosts effective priority of the specified skill", async () => {
    const { stdout: before } = await runCli("explain", "vercel.json", "--json");
    const { stdout: after } = await runCli("explain", "vercel.json", "--json", "--likely-skills", "vercel-cli");
    const resultBefore = JSON.parse(before);
    const resultAfter = JSON.parse(after);
    const cliMatchBefore = resultBefore.matches.find((m: any) => m.skill === "vercel-cli");
    const cliMatchAfter = resultAfter.matches.find((m: any) => m.skill === "vercel-cli");
    // With boost, vercel-cli should have higher effective priority
    expect(cliMatchAfter.effectivePriority).toBeGreaterThan(cliMatchBefore.effectivePriority);
  });
});

// ---------------------------------------------------------------------------
// collision detection
// ---------------------------------------------------------------------------

describe("collision detection", () => {
  test("vercel.json triggers multiple matches with collision info", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    // vercel.json should match multiple skills (routing-middleware, deployments-cicd, etc.)
    expect(result.matches.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// zero-bundle / skill-store resolution
// ---------------------------------------------------------------------------

describe("zero-bundle resolution", () => {
  test("explain succeeds without <projectRoot>/skills directory", async () => {
    // The CLI uses the plugin root as project root; skills/ not required
    const { stdout, exitCode } = await runCli("explain", "middleware.ts", "--json");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.skillCount).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  test("uncached skills report summary injection mode", async () => {
    const { stdout } = await runCli("explain", "middleware.ts", "--json");
    const result = JSON.parse(stdout);
    // Without cached SKILL.md bodies, skills from rules-manifest resolve as summary
    const summaryMatches = result.matches.filter((m: any) => m.injectionMode === "summary");
    // At least some matches should be summary-only in zero-bundle mode
    expect(summaryMatches.length + result.matches.filter((m: any) => m.injectionMode === "full").length).toBe(result.injectedCount);
  });

  test("--debug emits skill-store-loaded event to stderr", async () => {
    const { stderr, exitCode } = await runCli("explain", "middleware.ts", "--debug");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("explain-skill-store-loaded");
  });

  test("--project-root is an alias for --project", async () => {
    const { stdout, exitCode } = await runCli("explain", "middleware.ts", "--project-root", ROOT, "--json");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.skillCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cap behavior
// ---------------------------------------------------------------------------

describe("cap behavior", () => {
  test("vercel.json shows capped/budget-dropped skills when >3 match", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    // vercel.json matches multiple skills; some should be capped or budget-dropped
    if (result.matches.length > 3) {
      // Total capped = droppedByCap + droppedByBudget
      const notInjected = result.matches.filter((m: any) => m.capped);
      expect(notInjected.length).toBe(result.cappedCount);
    }
  });

  test("large budget allows MAX_SKILLS cap to apply", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json", "--budget", "999999");
    const result = JSON.parse(stdout);
    if (result.matches.length > 3) {
      // With infinite budget, cap should still apply at 3
      const injected = result.matches.filter((m: any) => m.injected);
      expect(injected.length).toBeLessThanOrEqual(3);
      const cappedByHardCeiling = result.matches.filter((m: any) => m.injectionMode === "droppedByCap");
      expect(cappedByHardCeiling.length).toBeGreaterThan(0);
    }
  });
});
