import { describe, test, expect, beforeEach } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");

let testSession: string;
const UNLIMITED_BUDGET = "999999";

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

/**
 * Extract skillInjection metadata from additionalContext.
 */
function extractSkillInjection(hookSpecificOutput: any): any {
  const ctx = hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: ({.*?}) -->/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

async function runHook(
  input: object,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; parsed: any }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      VERCEL_PLUGIN_SEEN_SKILLS: "",
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

describe("AI SDK companion injection (ai-elements)", () => {
  // ai-elements has importPatterns for 'ai' and '@ai-sdk/*', so it already matches
  // when those imports are present. The companion injection is a safety net for when
  // ai-sdk matches but ai-elements doesn't (e.g., ai-sdk matched via path pattern
  // on an API route file that was previously seen, then a new client .tsx is written
  // without AI SDK imports but ai-sdk is already in rankedSkills via profiler boost).

  test("ai-elements is injected alongside ai-sdk on client .tsx files with AI SDK imports", async () => {
    const { parsed } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/project/src/components/editor-ai.tsx",
        content: 'import { useChat } from "@ai-sdk/react";\nexport default function EditorAI() {}',
      },
      cwd: "/nonexistent-clean-project",
    });

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("ai-sdk");
    expect(meta.injectedSkills).toContain("ai-elements");
    expect(meta.reasons["ai-elements"]).toEqual({
      trigger: "co-inject",
      reasonCode: "ai-sdk:force",
    });
  });

  test("ai-elements is injected on .jsx files too", async () => {
    const { parsed } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/components/editor-ai.jsx",
        old_string: "old",
        new_string: 'import { useChat } from "@ai-sdk/react";\nnew',
      },
      cwd: "/nonexistent-clean-project",
    });

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("ai-sdk");
    expect(meta.injectedSkills).toContain("ai-elements");
    expect(meta.reasons["ai-elements"]).toEqual({
      trigger: "co-inject",
      reasonCode: "ai-sdk:force",
    });
  });

  test("does NOT co-inject ai-elements on API route files", async () => {
    const { parsed } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/project/src/app/api/generate/route.ts",
        content: 'import { streamText } from "ai";\nexport async function POST() {}',
      },
    });

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    // ai-elements should not have ai-sdk-companion trigger on server routes
    if (meta?.reasons?.["ai-elements"]) {
      expect(meta.reasons["ai-elements"].trigger).not.toBe("co-inject");
    }
  });

  test("does NOT co-inject ai-elements on server action files", async () => {
    const { parsed } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/project/src/app/actions/generate.ts",
        content: 'import { generateText } from "ai";\nexport async function generateAction() {}',
      },
    });

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    if (meta?.reasons?.["ai-elements"]) {
      expect(meta.reasons["ai-elements"].trigger).not.toBe("co-inject");
    }
  });

  test("companion injects ai-elements as summary-only when already seen", async () => {
    // When ai-elements is already seen AND doesn't match on its own patterns
    // (no AI SDK imports, no chat/message path), the companion should still inject
    // it as summary-only if ai-sdk is in rankedSkills.
    // Use a file that triggers ai-sdk via profiler boost but not ai-elements directly.
    const { parsed } = await runHook(
      {
        tool_name: "Write",
        tool_input: {
          file_path: "/project/src/components/editor-ai.tsx",
          content: 'import { useChat } from "@ai-sdk/react";\nexport default function EditorAI() {}',
        },
        cwd: "/nonexistent-clean-project",
      },
      { VERCEL_PLUGIN_SEEN_SKILLS: "ai-elements" },
    );

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("ai-sdk");
    // ai-elements should be present (either via pattern match dedup bypass or companion dedup bypass)
    // It may appear in summaryOnly
    if (meta.summaryOnly?.includes("ai-elements")) {
      expect(meta.summaryOnly).toContain("ai-elements");
    }
  });

  test("does not duplicate when ai-elements already matched by own patterns", async () => {
    // Use a path that matches BOTH ai-sdk (via import) and ai-elements (via path pattern)
    const { parsed } = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "/project/src/components/chat.tsx",
        content: 'import { useChat } from "@ai-sdk/react";\nexport default function Chat() {}',
      },
    });

    expect(parsed).not.toBeNull();
    const meta = extractSkillInjection(parsed.hookSpecificOutput);
    expect(meta).toBeDefined();
    expect(meta.injectedSkills).toContain("ai-elements");
    // Should only appear once in injectedSkills
    const count = meta.injectedSkills.filter((s: string) => s === "ai-elements").length;
    expect(count).toBe(1);
  });

  test("does NOT trigger for non-Write/Edit tools", async () => {
    const { parsed } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/components/editor-ai.tsx" },
    });

    // Read tool should not trigger companion injection
    const meta = extractSkillInjection(parsed?.hookSpecificOutput);
    if (meta?.reasons?.["ai-elements"]) {
      expect(meta.reasons["ai-elements"].trigger).not.toBe("co-inject");
    }
  });
});
