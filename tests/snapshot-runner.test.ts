/**
 * Golden snapshot tests for skill injection.
 *
 * Each scenario runs the PreToolUse hook with a specific vercel.json fixture
 * and compares the `skillInjection` metadata against a stored .snap file.
 *
 * To update baselines:  bun test tests/snapshot-runner.test.ts -- --update-snapshots
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectStatePaths } from "../hooks/src/project-state-paths.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SNAP_DIR = join(ROOT, "tests", "snapshots");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");
const SKILLS_DIR = join(ROOT, "skills");

const UPDATE_SNAPSHOTS =
  process.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract skillInjection metadata from the HTML comment in additionalContext. */
function parseSkillInjection(additionalContext: string): Record<string, unknown> | null {
  const match = additionalContext.match(/<!-- skillInjection: (\{.*?\}) -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Run the hook and return the parsed skillInjection metadata. */
async function runHook(input: object): Promise<{
  code: number;
  skillInjection: Record<string, unknown> | null;
}> {
  const session = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({ ...input, session_id: session });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
    env: {
      ...process.env,
      VERCEL_PLUGIN_HOME_DIR: testHomeDir,
      VERCEL_PLUGIN_DISABLE_BASE_TELEMETRY: "1",
      VERCEL_PLUGIN_HOOK_DEDUP: "off", // disable dedup so each scenario is independent
      VERCEL_PLUGIN_INJECTION_BUDGET: "999999", // unlimited budget for snapshot tests
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  let skillInjection: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout);
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? "";
    skillInjection = parseSkillInjection(ctx);
  } catch {}

  return { code, skillInjection };
}

/**
 * Normalize the skillInjection object for deterministic comparison.
 * - Removes toolTarget (contains temp paths that change per run)
 * - Sorts array fields so ordering within sets is stable
 */
function normalize(injection: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...injection };
  // toolTarget contains absolute paths that vary per machine/run
  delete clone.toolTarget;
  // Sort arrays for deterministic comparison
  for (const key of ["matchedSkills", "injectedSkills", "droppedByCap", "droppedByBudget"] as const) {
    if (Array.isArray(clone[key])) {
      // injectedSkills order matters (priority), so only sort matchedSkills
      if (key === "matchedSkills") {
        clone[key] = [...(clone[key] as string[])].sort();
      }
    }
  }
  return clone;
}

/** Read a .snap file. Returns null if it doesn't exist. */
function readSnap(name: string): string | null {
  const p = join(SNAP_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

/** Write (or overwrite) a .snap file. */
function writeSnap(name: string, content: string): void {
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(join(SNAP_DIR, name), content, "utf-8");
}

/** Assert that current output matches the stored snapshot. */
function assertSnapshot(snapName: string, actual: Record<string, unknown>) {
  const serialized = JSON.stringify(actual, null, 2) + "\n";

  if (UPDATE_SNAPSHOTS) {
    writeSnap(snapName, serialized);
    // Still pass the test when updating
    return;
  }

  const stored = readSnap(snapName);
  if (stored === null) {
    throw new Error(
      `Snapshot "${snapName}" does not exist. Run with --update-snapshots to create it.`,
    );
  }

  expect(serialized).toBe(stored);
}

// ---------------------------------------------------------------------------
// Write temp vercel.json fixtures that the hook can actually read
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  snapFile: string;
  vercelJson: object;
  toolName: string;
}

const scenarios: Scenario[] = [
  {
    name: "redirects-only",
    snapFile: "inject-redirects.snap",
    vercelJson: {
      redirects: [
        { source: "/blog/:path*", destination: "https://blog.example.com/:path*" },
      ],
    },
    toolName: "Read",
  },
  {
    name: "headers-only",
    snapFile: "inject-headers.snap",
    vercelJson: {
      headers: [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Frame-Options", value: "DENY" },
            { key: "X-Content-Type-Options", value: "nosniff" },
          ],
        },
      ],
    },
    toolName: "Edit",
  },
  {
    name: "rewrites-only",
    snapFile: "inject-rewrites.snap",
    vercelJson: {
      rewrites: [
        { source: "/api/:path*", destination: "https://api.example.com/:path*" },
      ],
    },
    toolName: "Write",
  },
  {
    name: "mixed-all-keys",
    snapFile: "inject-mixed.snap",
    vercelJson: {
      redirects: [{ source: "/old", destination: "/new" }],
      headers: [
        {
          source: "/(.*)",
          headers: [{ key: "X-Frame-Options", value: "DENY" }],
        },
      ],
      rewrites: [
        { source: "/proxy/:path*", destination: "https://backend.example.com/:path*" },
      ],
      functions: { "api/**": { memory: 1024, maxDuration: 30 } },
      crons: [{ path: "/api/cron/daily", schedule: "0 8 * * *" }],
      buildCommand: "next build",
    },
    toolName: "Edit",
  },
  {
    name: "functions-only",
    snapFile: "inject-functions.snap",
    vercelJson: {
      functions: { "api/**": { memory: 1024 } },
      regions: ["iad1"],
    },
    toolName: "Read",
  },
  {
    name: "crons-only",
    snapFile: "inject-crons.snap",
    vercelJson: {
      crons: [
        { path: "/api/cron/hourly", schedule: "0 * * * *" },
        { path: "/api/cron/daily", schedule: "0 8 * * *" },
      ],
    },
    toolName: "Read",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;
let testHomeDir: string;

function seedProjectCache(homeDir: string): void {
  const paths = resolveProjectStatePaths(ROOT, homeDir);
  mkdirSync(paths.skillsDir, { recursive: true });

  for (const entry of readdirSync(SKILLS_DIR)) {
    const sourceDir = join(SKILLS_DIR, entry);
    if (!existsSync(join(sourceDir, "SKILL.md"))) continue;
    symlinkSync(sourceDir, join(paths.skillsDir, entry), "dir");
  }
}

beforeAll(() => {
  tempDir = join(tmpdir(), `vp-snap-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  testHomeDir = join(
    tmpdir(),
    `vercel-plugin-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  seedProjectCache(testHomeDir);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(testHomeDir, { recursive: true, force: true });
});

describe("golden snapshot tests", () => {
  for (const scenario of scenarios) {
    test(`snapshot: ${scenario.name}`, async () => {
      // Write a temp vercel.json the hook can read
      const filePath = join(tempDir, `${scenario.name}-vercel.json`);
      // The hook expects the file to be named vercel.json
      const projectDir = join(tempDir, scenario.name);
      mkdirSync(projectDir, { recursive: true });
      const vercelPath = join(projectDir, "vercel.json");
      writeFileSync(vercelPath, JSON.stringify(scenario.vercelJson, null, 2), "utf-8");

      const { code, skillInjection } = await runHook({
        tool_name: scenario.toolName,
        tool_input: { file_path: vercelPath },
      });

      expect(code).toBe(0);
      expect(skillInjection).not.toBeNull();

      const normalized = normalize(skillInjection!);
      assertSnapshot(scenario.snapFile, normalized);
    });
  }

  test("snapshot update mode is off by default", () => {
    // Ensure we aren't accidentally always updating
    if (!process.argv.includes("--update-snapshots") && process.env.UPDATE_SNAPSHOTS !== "1") {
      expect(UPDATE_SNAPSHOTS).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden fixture tests — data-driven from tests/fixtures/golden-*.json
// ---------------------------------------------------------------------------

describe("golden fixture tests", () => {
  const goldenFiles = readdirSync(FIXTURES_DIR).filter(
    (f) => f.startsWith("golden-") && f.endsWith(".json"),
  );

  for (const fixtureName of goldenFiles) {
    test(`golden: ${fixtureName}`, async () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURES_DIR, fixtureName), "utf-8"),
      );

      let input = fixture.input;

      // If the fixture includes vercelJson content, write a temp file so
      // vercel-config.mjs key-aware routing can read it.
      if (fixture.vercelJson) {
        const projectDir = join(tempDir, `golden-${fixtureName}`);
        mkdirSync(projectDir, { recursive: true });
        const vercelPath = join(projectDir, "vercel.json");
        writeFileSync(
          vercelPath,
          JSON.stringify(fixture.vercelJson, null, 2),
          "utf-8",
        );
        input = {
          ...input,
          tool_input: { ...input.tool_input, file_path: vercelPath },
        };
      }

      const { code, skillInjection } = await runHook(input);
      expect(code).toBe(0);
      expect(skillInjection).not.toBeNull();

      const actual = skillInjection!;
      const expected = fixture.expected.skillInjection;

      // Version and toolName must match exactly
      expect(actual.version).toBe(expected.version);
      expect(actual.toolName).toBe(expected.toolName);

      // toolTarget — only assert when the fixture specifies it
      // (vercelJson fixtures use temp paths so toolTarget varies)
      if (expected.toolTarget) {
        expect(actual.toolTarget).toBe(expected.toolTarget);
      }

      // matchedSkills — same set (order may vary)
      expect([...(actual.matchedSkills as string[])].sort()).toEqual(
        [...expected.matchedSkills].sort(),
      );

      // injectedSkills — exact ordered list (ranking matters)
      expect(actual.injectedSkills).toEqual(expected.injectedSkills);

      // droppedByCap — same set (order may vary)
      expect([...(actual.droppedByCap as string[])].sort()).toEqual(
        [...expected.droppedByCap].sort(),
      );

      // Cap collision: if droppedByCap is expected non-empty, verify it
      if (expected.droppedByCap.length > 0) {
        expect((actual.droppedByCap as string[]).length).toBeGreaterThan(0);
      }
    });
  }
});
