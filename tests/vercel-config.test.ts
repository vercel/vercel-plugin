import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");

let testSession: string;
let tempDir: string;

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempDir = join(tmpdir(), `vp-vercel-config-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a vercel.json with the given content and return its path */
function writeVercelJson(content: object): string {
  const filePath = join(tempDir, "vercel.json");
  writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
  return filePath;
}

async function runHook(input: object): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  parsed: any;
  injectedSkills: string[];
}> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_INJECTION_BUDGET: "999999" },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(stdout);
  } catch {}
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const siMatch = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = siMatch ? JSON.parse(siMatch[1]) : {};
  const injectedSkills = si.injectedSkills ?? [];
  return { code, stdout, stderr, parsed, injectedSkills };
}

// ---------------------------------------------------------------------------
// Unit tests for vercel-config.mjs exports
// ---------------------------------------------------------------------------

describe("vercel-config.mjs", () => {
  let resolveVercelJsonSkills: any;
  let isVercelJsonPath: any;

  beforeEach(async () => {
    const mod = await import("../hooks/vercel-config.mjs");
    resolveVercelJsonSkills = mod.resolveVercelJsonSkills;
    isVercelJsonPath = mod.isVercelJsonPath;
  });

  test("isVercelJsonPath detects vercel.json paths", () => {
    expect(isVercelJsonPath("/Users/me/project/vercel.json")).toBe(true);
    expect(isVercelJsonPath("/Users/me/project/apps/web/vercel.json")).toBe(true);
    expect(isVercelJsonPath("vercel.json")).toBe(true);
    expect(isVercelJsonPath("/Users/me/project/package.json")).toBe(false);
    expect(isVercelJsonPath("/Users/me/vercel.json.bak")).toBe(false);
    expect(isVercelJsonPath("")).toBe(false);
  });

  test("resolveVercelJsonSkills returns null for missing file", () => {
    expect(resolveVercelJsonSkills("/nonexistent/vercel.json")).toBeNull();
  });

  test("resolveVercelJsonSkills returns null for malformed JSON", () => {
    const p = join(tempDir, "vercel.json");
    writeFileSync(p, "not json", "utf-8");
    expect(resolveVercelJsonSkills(p)).toBeNull();
  });

  test("resolveVercelJsonSkills maps crons to cron-jobs", () => {
    const p = writeVercelJson({ crons: [{ path: "/api/cron", schedule: "0 * * * *" }] });
    const result = resolveVercelJsonSkills(p);
    expect(result).not.toBeNull();
    expect(result!.relevantSkills.has("cron-jobs")).toBe(true);
    expect(result!.relevantSkills.has("vercel-functions")).toBe(false);
  });

  test("resolveVercelJsonSkills maps redirects to routing-middleware", () => {
    const p = writeVercelJson({ redirects: [{ source: "/old", destination: "/new" }] });
    const result = resolveVercelJsonSkills(p);
    expect(result!.relevantSkills.has("routing-middleware")).toBe(true);
  });

  test("resolveVercelJsonSkills maps functions to vercel-functions", () => {
    const p = writeVercelJson({ functions: { "api/*.ts": { memory: 1024 } } });
    const result = resolveVercelJsonSkills(p);
    expect(result!.relevantSkills.has("vercel-functions")).toBe(true);
  });

  test("resolveVercelJsonSkills maps mixed keys correctly", () => {
    const p = writeVercelJson({
      crons: [],
      redirects: [],
      functions: {},
    });
    const result = resolveVercelJsonSkills(p);
    expect(result!.relevantSkills.has("cron-jobs")).toBe(true);
    expect(result!.relevantSkills.has("routing-middleware")).toBe(true);
    expect(result!.relevantSkills.has("vercel-functions")).toBe(true);
    // deployments-cicd has no mapped keys in this config
    expect(result!.relevantSkills.has("deployments-cicd")).toBe(false);
  });

  test("resolveVercelJsonSkills recognises all expected vercel.json keys", () => {
    // Verify that every key we expect to be mapped produces at least one relevant skill
    const expectedKeys = [
      "redirects", "rewrites", "headers", "cleanUrls", "trailingSlash",
      "crons", "functions", "regions",
      "builds", "buildCommand", "installCommand", "outputDirectory", "framework",
    ];
    for (const key of expectedKeys) {
      const content: Record<string, unknown> = { [key]: {} };
      const p = join(tempDir, `vercel-${key}.json`);
      writeFileSync(p, JSON.stringify(content), "utf-8");
      const result = resolveVercelJsonSkills(p);
      expect(result).not.toBeNull();
      expect(result!.relevantSkills.size).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: collision scenarios via the full hook
// ---------------------------------------------------------------------------

describe("vercel.json key-aware routing (collision scenarios)", () => {
  test("Scenario 1: vercel.json with only redirects → routing-middleware boosted over vercel-functions", async () => {
    const filePath = writeVercelJson({
      redirects: [{ source: "/blog/:path*", destination: "https://blog.example.com/:path*" }],
    });
    const { injectedSkills } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    });
    // routing-middleware should be injected (boosted by key match)
    expect(injectedSkills).toContain("routing-middleware");
    // vercel-functions should be deprioritized (no functions/regions keys)
    // It may still appear if under the cap, but routing-middleware must come first
    const rmIdx = injectedSkills.indexOf("routing-middleware");
    const vfIdx = injectedSkills.indexOf("vercel-functions");
    if (vfIdx >= 0) {
      expect(rmIdx).toBeLessThan(vfIdx);
    }
  });

  test("Scenario 2: vercel.json with only crons → cron-jobs boosted, others deprioritized", async () => {
    const filePath = writeVercelJson({
      crons: [{ path: "/api/cron/daily", schedule: "0 8 * * *" }],
    });
    const { injectedSkills } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });
    // cron-jobs must be injected
    expect(injectedSkills).toContain("cron-jobs");
    // cron-jobs should appear before vercel-functions (despite lower base priority)
    const cjIdx = injectedSkills.indexOf("cron-jobs");
    const vfIdx = injectedSkills.indexOf("vercel-functions");
    if (vfIdx >= 0) {
      expect(cjIdx).toBeLessThan(vfIdx);
    }
  });

  test("Scenario 3: vercel.json with headers + buildCommand → routing-middleware and deployments-cicd boosted", async () => {
    const filePath = writeVercelJson({
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      buildCommand: "next build",
    });
    const { injectedSkills } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: filePath },
    });
    expect(injectedSkills).toContain("routing-middleware");
    expect(injectedSkills).toContain("deployments-cicd");
    // Both key-relevant skills should appear before non-relevant ones
  });

  test("Scenario 4: vercel.json with functions key → vercel-functions stays at top", async () => {
    const filePath = writeVercelJson({
      functions: { "api/**": { memory: 1024, maxDuration: 30 } },
    });
    const { injectedSkills } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    });
    // vercel-functions is both highest base priority AND key-matched → should be first
    expect(injectedSkills[0]).toBe("vercel-functions");
  });

  test("Scenario 5: vercel.json with all key types → no duplicates, cap respected", async () => {
    const filePath = writeVercelJson({
      crons: [],
      redirects: [],
      functions: {},
      buildCommand: "npm run build",
    });
    const { injectedSkills } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    });
    // Max 3 skills injected
    expect(injectedSkills.length).toBeLessThanOrEqual(3);
    // No duplicates
    expect(new Set(injectedSkills).size).toBe(injectedSkills.length);
    // All 4 vercel.json skills are relevant, but cap limits to 3
    // The ones that ARE injected should all be vercel.json skills
    for (const skill of injectedSkills) {
      expect(["cron-jobs", "deployments-cicd", "routing-middleware", "vercel-functions"]).toContain(skill);
    }
  });

  test("Scenario 6: nonexistent vercel.json falls back to default priority matching", async () => {
    const filePath = "/tmp/nonexistent-project/vercel.json";
    const { injectedSkills } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });
    // Without key-aware routing, default priority wins: vercel-functions (p8) first
    expect(injectedSkills[0]).toBe("vercel-functions");
  });
});
