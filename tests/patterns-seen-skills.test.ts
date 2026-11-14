import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSeenSkills,
  appendSeenSkill,
  mergeSeenSkillStatesWithCompactionReset,
} from "../hooks/patterns.mjs";

describe("parseSeenSkills", () => {
  test("parses comma-delimited string into a Set", () => {
    const parsed = parseSeenSkills("nextjs,ai-sdk,workflow");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk", "workflow"]);
  });

  test("handles empty string", () => {
    expect([...parseSeenSkills("")]).toEqual([]);
  });

  test("handles whitespace-only", () => {
    expect([...parseSeenSkills("   ")]).toEqual([]);
  });

  test("handles undefined/non-string", () => {
    expect([...parseSeenSkills(undefined)]).toEqual([]);
  });

  test("trims whitespace around skills", () => {
    const parsed = parseSeenSkills(" nextjs , ai-sdk , workflow ");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk", "workflow"]);
  });

  test("deduplicates skills", () => {
    const parsed = parseSeenSkills("nextjs,ai-sdk,nextjs");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk"]);
  });

  test("skips empty segments from trailing commas", () => {
    const parsed = parseSeenSkills("nextjs,,ai-sdk,");
    expect([...parsed]).toEqual(["nextjs", "ai-sdk"]);
  });
});

describe("appendSeenSkill", () => {
  test("appends to empty string", () => {
    expect(appendSeenSkill("", "nextjs")).toBe("nextjs");
  });

  test("appends with comma to existing", () => {
    expect(appendSeenSkill("nextjs", "ai-sdk")).toBe("nextjs,ai-sdk");
  });

  test("appends to multi-skill string", () => {
    expect(appendSeenSkill("nextjs,ai-sdk", "workflow")).toBe("nextjs,ai-sdk,workflow");
  });

  test("no-ops for blank skill", () => {
    expect(appendSeenSkill("nextjs", "")).toBe("nextjs");
    expect(appendSeenSkill("nextjs", "   ")).toBe("nextjs");
  });

  test("handles undefined envValue", () => {
    expect(appendSeenSkill(undefined, "nextjs")).toBe("nextjs");
  });
});

describe("mergeSeenSkillStatesWithCompactionReset env file", () => {
  const envKeys = ["CLAUDE_ENV_FILE", "VERCEL_PLUGIN_SEEN_SKILLS", "VERCEL_PLUGIN_CONTEXT_COMPACTED"] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let tempDir = "";

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("replaces earlier compaction exports instead of appending", () => {
    tempDir = mkdtempSync(join(tmpdir(), "patterns-env-"));
    const envFile = join(tempDir, "claude.env");
    writeFileSync(envFile, 'export VERCEL_PLUGIN_SETUP_MODE="1"\nexport VERCEL_PLUGIN_SEEN_SKILLS="old"\n', "utf-8");
    process.env.CLAUDE_ENV_FILE = envFile;

    for (let i = 0; i < 3; i++) {
      process.env.VERCEL_PLUGIN_CONTEXT_COMPACTED = "true";
      mergeSeenSkillStatesWithCompactionReset("nextjs", "", "");
    }

    expect(readFileSync(envFile, "utf-8")).toBe(
      'export VERCEL_PLUGIN_SETUP_MODE="1"\nexport VERCEL_PLUGIN_SEEN_SKILLS="nextjs"\nexport VERCEL_PLUGIN_CONTEXT_COMPACTED=""\n',
    );
  });
});
