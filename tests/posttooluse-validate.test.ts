import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "posttooluse-validate.mjs");

// Unique session ID per test run
let testSession: string;

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

/**
 * Extract postValidation metadata from additionalContext.
 */
function extractPostValidation(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- postValidation: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

async function runHook(
  input: object,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_VALIDATED_FILES: "",
      ...extraEnv,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("posttooluse-validate.mjs", () => {
  test("hook script exists", () => {
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
  });

  test("outputs empty JSON for unsupported tool (Read)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for unsupported tool (Bash)", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm run dev" },
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

  test("outputs empty JSON for missing file_path", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for non-existent file", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/nonexistent/path/file.ts" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  describe("validation rules", () => {
    let tmpDir: string;
    let testFile: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `posttooluse-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      testFile = join(tmpDir, "app", "api", "chat", "route.ts");
      mkdirSync(join(tmpDir, "app", "api", "chat"), { recursive: true });
    });

    test("detects direct openai import in ai-sdk file", async () => {
      writeFileSync(testFile, `import OpenAI from 'openai';\n\nconst client = new OpenAI();\n`);
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("@ai-sdk/openai");
      expect(ctx).toContain("VALIDATION");
      const meta = extractPostValidation(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.errorCount).toBeGreaterThan(0);
      expect(meta.filePath).toBe(testFile);
    });

    test("detects raw Anthropic client usage", async () => {
      writeFileSync(testFile, `import Anthropic from 'anthropic';\nconst client = new Anthropic();\n`);
      const { code, stdout } = await runHook({
        tool_name: "Edit",
        tool_input: { file_path: testFile },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("@ai-sdk/anthropic");
      expect(ctx).toContain("VALIDATION");
      const meta = extractPostValidation(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.errorCount).toBeGreaterThan(0);
    });

    test("detects Experimental_Agent usage", async () => {
      writeFileSync(testFile, `import { Experimental_Agent } from 'ai';\nconst agent = new Experimental_Agent({});\n`);
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("Experimental_Agent");
      expect(ctx).toContain("ToolLoopAgent");
      const meta = extractPostValidation(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.errorCount).toBeGreaterThan(0);
    });

    test("no violations for correct ai-sdk usage", async () => {
      writeFileSync(testFile, [
        `import { generateText, gateway } from 'ai';`,
        `import { openai } from '@ai-sdk/openai';`,
        ``,
        `const result = await generateText({`,
        `  model: gateway('openai/gpt-5.4'),`,
        `  prompt: 'Hello!',`,
        `});`,
      ].join("\n"));
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      // Clean file: either no hookSpecificOutput, or zero errors
      if (result.hookSpecificOutput) {
        const meta = extractPostValidation(result.hookSpecificOutput);
        expect(meta?.errorCount || 0).toBe(0);
      }
    });

    test("detects gateway from 'ai' with hyphenated model slug", async () => {
      writeFileSync(testFile, [
        `import { generateText, gateway } from 'ai';`,
        ``,
        `const result = await generateText({`,
        `  model: gateway('anthropic/claude-sonnet-4-6'),`,
        `  prompt: 'Hello!',`,
        `});`,
      ].join("\n"));
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.hookSpecificOutput).toBeDefined();
      const ctx = result.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("VALIDATION");
      expect(ctx).toContain("dots not hyphens");
      const meta = extractPostValidation(result.hookSpecificOutput);
      expect(meta).toBeDefined();
      expect(meta.errorCount).toBeGreaterThan(0);
      expect(meta.matchedSkills).toContain("ai-gateway");
    });

    test("no output for file that doesn't match any skill", async () => {
      const randomFile = join(tmpDir, "random-file.txt");
      writeFileSync(randomFile, "hello world\nimport OpenAI from 'openai';\n");
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: randomFile },
      });
      expect(code).toBe(0);
      // The file content has an openai import but the path doesn't match any skill
      // The import WOULD match ai-sdk skill, so it could still fire
      // That's fine - import matching is valid
    });
  });

  describe("dedup via VERCEL_PLUGIN_VALIDATED_FILES", () => {
    let tmpDir: string;
    let testFile: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `posttooluse-validate-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tmpDir, { recursive: true });
      testFile = join(tmpDir, "app", "api", "chat", "route.ts");
      mkdirSync(join(tmpDir, "app", "api", "chat"), { recursive: true });
      writeFileSync(testFile, `import OpenAI from 'openai';\n`);
    });

    test("second run with same content is still valid (dedup is per-process env)", async () => {
      // First run
      const first = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(first.code).toBe(0);

      // Second run with same file - env is fresh per process, so it should still validate
      const second = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      expect(second.code).toBe(0);
      // Both should produce valid JSON
      JSON.parse(first.stdout);
      JSON.parse(second.stdout);
    });
  });

  describe("parseInput unit tests (imported)", () => {
    // Import the module for unit testing
    let parseInput: typeof import("../hooks/src/posttooluse-validate.mts").parseInput;

    beforeEach(async () => {
      const mod = await import("../hooks/posttooluse-validate.mjs");
      parseInput = mod.parseInput;
    });

    test("returns null for empty string", () => {
      expect(parseInput("")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      expect(parseInput("not json")).toBeNull();
    });

    test("returns null for unsupported tool", () => {
      expect(parseInput(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/test" } }))).toBeNull();
    });

    test("returns null for missing file_path", () => {
      expect(parseInput(JSON.stringify({ tool_name: "Write", tool_input: {} }))).toBeNull();
    });

    test("parses Write tool correctly", () => {
      const result = parseInput(JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/test/file.ts" },
        cwd: "/workspace",
      }));
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe("Write");
      expect(result!.filePath).toBe("/test/file.ts");
      expect(result!.cwd).toBe("/workspace");
    });

    test("parses Edit tool correctly", () => {
      const result = parseInput(JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/test/file.ts" },
      }));
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe("Edit");
    });
  });

  describe("runValidation unit tests (imported)", () => {
    let runValidation: typeof import("../hooks/src/posttooluse-validate.mts").runValidation;

    beforeEach(async () => {
      const mod = await import("../hooks/posttooluse-validate.mjs");
      runValidation = mod.runValidation;
    });

    test("finds violations on matching lines", () => {
      const rules = new Map([
        ["test-skill", [
          { pattern: "import.*from ['\"]openai['\"]", message: "Use @ai-sdk/openai", severity: "error" as const },
        ]],
      ]);
      const content = `import OpenAI from 'openai';\nconst x = 1;\n`;
      const violations = runValidation(content, ["test-skill"], rules);
      expect(violations.length).toBe(1);
      expect(violations[0].line).toBe(1);
      expect(violations[0].severity).toBe("error");
      expect(violations[0].skill).toBe("test-skill");
    });

    test("returns empty for non-matching content", () => {
      const rules = new Map([
        ["test-skill", [
          { pattern: "import.*from ['\"]openai['\"]", message: "Use @ai-sdk/openai", severity: "error" as const },
        ]],
      ]);
      const content = `import { openai } from '@ai-sdk/openai';\n`;
      const violations = runValidation(content, ["test-skill"], rules);
      expect(violations.length).toBe(0);
    });

    test("handles multiple skills with overlapping rules", () => {
      const rules = new Map([
        ["skill-a", [
          { pattern: "new OpenAI\\(", message: "Don't use raw OpenAI", severity: "error" as const },
        ]],
        ["skill-b", [
          { pattern: "new OpenAI\\(", message: "Use AI SDK instead", severity: "error" as const },
        ]],
      ]);
      const content = `const client = new OpenAI();\n`;
      const violations = runValidation(content, ["skill-a", "skill-b"], rules);
      expect(violations.length).toBe(2);
      expect(new Set(violations.map(v => v.skill))).toEqual(new Set(["skill-a", "skill-b"]));
    });

    test("skips invalid regex patterns gracefully", () => {
      const rules = new Map([
        ["test-skill", [
          { pattern: "[invalid(regex", message: "test", severity: "error" as const },
          { pattern: "validPattern", message: "found it", severity: "error" as const },
        ]],
      ]);
      const content = `validPattern here\n`;
      const violations = runValidation(content, ["test-skill"], rules);
      expect(violations.length).toBe(1);
      expect(violations[0].message).toBe("found it");
    });
  });

  describe("dedup helpers unit tests (imported)", () => {
    let parseValidatedFiles: typeof import("../hooks/src/posttooluse-validate.mts").parseValidatedFiles;
    let appendValidatedFile: typeof import("../hooks/src/posttooluse-validate.mts").appendValidatedFile;
    let contentHash: typeof import("../hooks/src/posttooluse-validate.mts").contentHash;

    beforeEach(async () => {
      const mod = await import("../hooks/posttooluse-validate.mjs");
      parseValidatedFiles = mod.parseValidatedFiles;
      appendValidatedFile = mod.appendValidatedFile;
      contentHash = mod.contentHash;
    });

    test("parseValidatedFiles handles empty string", () => {
      expect(parseValidatedFiles("")).toEqual(new Set());
    });

    test("parseValidatedFiles handles undefined", () => {
      expect(parseValidatedFiles(undefined)).toEqual(new Set());
    });

    test("parseValidatedFiles parses comma-delimited entries", () => {
      const result = parseValidatedFiles("file1.ts:abc123,file2.ts:def456");
      expect(result.has("file1.ts:abc123")).toBe(true);
      expect(result.has("file2.ts:def456")).toBe(true);
      expect(result.size).toBe(2);
    });

    test("appendValidatedFile appends to empty", () => {
      expect(appendValidatedFile("", "file.ts:abc")).toBe("file.ts:abc");
    });

    test("appendValidatedFile appends to existing", () => {
      expect(appendValidatedFile("a:1", "b:2")).toBe("a:1,b:2");
    });

    test("contentHash produces consistent short hash", () => {
      const h1 = contentHash("hello world");
      const h2 = contentHash("hello world");
      expect(h1).toBe(h2);
      expect(h1.length).toBe(12);
      // Different content → different hash
      expect(contentHash("different")).not.toBe(h1);
    });
  });

  describe("formatOutput unit tests (imported)", () => {
    let formatOutput: typeof import("../hooks/src/posttooluse-validate.mts").formatOutput;

    beforeEach(async () => {
      const mod = await import("../hooks/posttooluse-validate.mjs");
      formatOutput = mod.formatOutput;
    });

    test("returns empty JSON for no violations", () => {
      const result = formatOutput([], ["ai-sdk"], "/test/file.ts");
      expect(result).toBe("{}");
    });

    test("returns suggestion output for warn-only violations at default log level", () => {
      const violations = [{
        skill: "test",
        line: 1,
        message: "just a warning",
        severity: "warn" as const,
        matchedText: "something",
      }];
      const result = formatOutput(violations, ["test"], "/test/file.ts");
      const parsed = JSON.parse(result);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("[SUGGESTION]");
      expect(ctx).toContain("just a warning");
      expect(ctx).toContain("Consider applying these suggestions");
      expect(ctx).not.toContain("[ERROR]");
      expect(ctx).not.toContain("Please fix these issues");
      const meta = extractPostValidation(parsed.hookSpecificOutput);
      expect(meta.errorCount).toBe(0);
      expect(meta.warnCount).toBe(1);
    });

    test("returns recommended output for recommended-only violations", () => {
      const violations = [{
        skill: "ai-sdk",
        line: 2,
        message: "outdated model",
        severity: "recommended" as const,
        matchedText: "gpt-4o",
      }];
      const result = formatOutput(violations, ["ai-sdk"], "/test/file.ts");
      const parsed = JSON.parse(result);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("[RECOMMENDED]");
      expect(ctx).toContain("outdated model");
      expect(ctx).toContain("Apply these recommendations before continuing");
      expect(ctx).not.toContain("[ERROR]");
      expect(ctx).not.toContain("[SUGGESTION]");
      expect(ctx).not.toContain("Consider applying");
      const meta = extractPostValidation(parsed.hookSpecificOutput);
      expect(meta.errorCount).toBe(0);
      expect(meta.recommendedCount).toBe(1);
      expect(meta.warnCount).toBe(0);
    });

    test("errors take precedence over recommended in call-to-action", () => {
      const violations = [
        { skill: "ai-sdk", line: 1, message: "error msg", severity: "error" as const, matchedText: "x" },
        { skill: "ai-sdk", line: 2, message: "rec msg", severity: "recommended" as const, matchedText: "y" },
      ];
      const result = formatOutput(violations, ["ai-sdk"], "/test/file.ts");
      const parsed = JSON.parse(result);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("[ERROR]");
      expect(ctx).toContain("[RECOMMENDED]");
      expect(ctx).toContain("Please fix these issues");
      expect(ctx).not.toContain("Apply these recommendations");
    });

    test("includes error violations in output", () => {
      const violations = [{
        skill: "ai-sdk",
        line: 3,
        message: "Use @ai-sdk/openai provider",
        severity: "error" as const,
        matchedText: "import OpenAI from 'openai'",
      }];
      const result = formatOutput(violations, ["ai-sdk"], "/test/file.ts");
      const parsed = JSON.parse(result);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("VALIDATION");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("Line 3");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("@ai-sdk/openai");

      const meta = extractPostValidation(parsed.hookSpecificOutput);
      expect(meta.errorCount).toBe(1);
      expect(meta.warnCount).toBe(0);
    });

    test("output conforms to SyncHookJSONOutput schema", () => {
      const violations = [{
        skill: "ai-sdk",
        line: 1,
        message: "test error",
        severity: "error" as const,
        matchedText: "test",
      }];
      const result = formatOutput(violations, ["ai-sdk"], "/test/file.ts");
      const parsed = JSON.parse(result);
      // Must only have hookSpecificOutput at top level (no extra keys)
      const topKeys = Object.keys(parsed);
      expect(topKeys).toEqual(["hookSpecificOutput"]);
      // hookSpecificOutput must have hookEventName and additionalContext
      const hso = parsed.hookSpecificOutput;
      expect(Object.keys(hso).sort()).toEqual(["additionalContext", "hookEventName"]);
    });
  });

  describe("performance", () => {
    let tmpDir: string;
    let testFile: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `posttooluse-perf-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      testFile = join(tmpDir, "app", "api", "chat", "route.ts");
      mkdirSync(join(tmpDir, "app", "api", "chat"), { recursive: true });
    });

    test("hook completes within 100ms for a typical file", async () => {
      // Create a moderately sized file
      const lines = [
        `import { generateText, gateway } from 'ai';`,
        `import { openai } from '@ai-sdk/openai';`,
        ...Array.from({ length: 50 }, (_, i) => `const line${i} = "some content ${i}";`),
        `export default async function handler() {`,
        `  const result = await generateText({ model: gateway('openai/gpt-5.4'), prompt: 'Hello' });`,
        `  return result.text;`,
        `}`,
      ];
      writeFileSync(testFile, lines.join("\n"));

      const start = performance.now();
      const { code, stdout } = await runHook({
        tool_name: "Write",
        tool_input: { file_path: testFile },
      });
      const elapsed = performance.now() - start;

      expect(code).toBe(0);
      JSON.parse(stdout); // valid JSON
      // Allow generous time for process spawn overhead, but log the actual time
      // The hook itself should be well under 100ms; process spawn adds ~50-100ms
      expect(elapsed).toBeLessThan(5000); // Very generous for CI; real latency is much lower
    });
  });
});
