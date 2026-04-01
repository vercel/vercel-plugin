import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  getManagedContextChunkForSkill,
  selectManagedContextChunk,
} from "../hooks/src/vercel-context.mts";

const ROOT = resolve(import.meta.dirname, "..");
const PRETOOL_HOOK = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const PROMPT_HOOK = join(ROOT, "hooks", "user-prompt-submit-skill-inject.mjs");

function cleanupSessionArtifacts(sessionId: string): void {
  const prefix = `vercel-plugin-${sessionId}-`;
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith(prefix)) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort cleanup for tests
  }
}

async function runPretoolHook(
  input: object,
  sessionId: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", PRETOOL_HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>) },
  });
  proc.stdin.write(JSON.stringify({ ...input, session_id: sessionId }));
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

async function runPromptHook(
  prompt: string,
  sessionId: string,
  envOverrides?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", PROMPT_HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>), ...(envOverrides || {}) },
  });
  proc.stdin.write(JSON.stringify({
    prompt,
    session_id: sessionId,
    cwd: ROOT,
    hook_event_name: "UserPromptSubmit",
  }));
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function createTestSession(): string {
  return `vercel-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("managed vercel context chunks", () => {
  test("extracts a small nextjs chunk from vercel.md", () => {
    const chunk = getManagedContextChunkForSkill("nextjs", { pluginRoot: ROOT });
    expect(chunk).not.toBeNull();
    expect(chunk?.chunkId).toBe("nextjs-platform");
    expect(chunk?.wrapped).toContain("Default to Next.js App Router");
    expect(chunk?.wrapped).toContain("vercel-context-chunk:nextjs-platform");
  });

  test("returns null for unmapped skills", () => {
    expect(getManagedContextChunkForSkill("shadcn", { pluginRoot: ROOT })).toBeNull();
  });

  test("deduplicates chunk claims per session", () => {
    const testSession = createTestSession();
    const first = selectManagedContextChunk(["nextjs"], {
      pluginRoot: ROOT,
      sessionId: testSession,
    });
    const second = selectManagedContextChunk(["nextjs"], {
      pluginRoot: ROOT,
      sessionId: testSession,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    cleanupSessionArtifacts(testSession);
  });
});

describe("on-demand context injection", () => {
  test("pretooluse appends a nextjs chunk after skill injection", async () => {
    const testSession = createTestSession();
    try {
      const { code, stdout } = await runPretoolHook({
        tool_name: "Read",
        tool_input: { file_path: "/Users/me/project/next.config.ts" },
      }, testSession);

      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain("Skill(");
      expect(ctx).toContain("<!-- vercel-context-chunk:nextjs-platform -->");
      expect(ctx).toContain("Default to Next.js App Router");
    } finally {
      cleanupSessionArtifacts(testSession);
    }
  });

  test("prompt hook appends ai chunk once and dedups it across later prompts", async () => {
    const testSession = createTestSession();
    try {
      const first = await runPromptHook(
        "I need to use the AI SDK to add streaming text generation to this endpoint",
        testSession,
      );
      expect(first.code).toBe(0);
      const firstParsed = JSON.parse(first.stdout);
      const firstCtx = firstParsed.hookSpecificOutput.additionalContext as string;
      expect(firstCtx).toContain("<!-- vercel-context-chunk:ai-stack -->");

      const second = await runPromptHook(
        "Build a conversational interface for a Discord bot that responds to mentions",
        testSession,
      );
      expect(second.code).toBe(0);
      const secondParsed = JSON.parse(second.stdout);
      const secondCtx = secondParsed.hookSpecificOutput.additionalContext as string;
      expect(secondCtx).toContain("Skill(chat-sdk)");
      expect(secondCtx).not.toContain("<!-- vercel-context-chunk:ai-stack -->");
    } finally {
      cleanupSessionArtifacts(testSession);
    }
  });

  test("prompt audit log records context chunk ids", async () => {
    const testSession = createTestSession();
    const auditLogPath = join(tmpdir(), `${testSession}-audit.jsonl`);
    try {
      const result = await runPromptHook(
        "I need to use the AI SDK to add streaming text generation to this endpoint",
        testSession,
        { VERCEL_PLUGIN_AUDIT_LOG_FILE: auditLogPath },
      );

      expect(result.code).toBe(0);
      expect(existsSync(auditLogPath)).toBe(true);

      const entries = readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const promptEntry = entries.find((entry) => entry.event === "prompt-skill-injection");

      expect(promptEntry).toBeDefined();
      expect(promptEntry.injectedSkills).toContain("ai-sdk");
      expect(promptEntry.contextChunks).toEqual(["ai-stack"]);
    } finally {
      cleanupSessionArtifacts(testSession);
      rmSync(auditLogPath, { force: true });
    }
  });
});
