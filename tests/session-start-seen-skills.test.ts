import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  dedupClaimDirPath,
  dedupFilePath,
  removeAllSessionDedupArtifacts,
  removeSessionClaimDir,
  tryClaimSessionKey,
} from "../hooks/src/hook-env.mts";

const ROOT = resolve(import.meta.dirname, "..");
const HOOKS_JSON = join(ROOT, "hooks", "hooks.json");
const SCRIPT = join(ROOT, "hooks", "session-start-seen-skills.mjs");

async function runSessionStart(
  env: Record<string, string | undefined>,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }

  const proc = Bun.spawn(["node", SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  if (typeof stdin === "string") {
    proc.stdin.write(stdin);
  }
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

describe("session-start-seen-skills hook", () => {
  test("test_script_exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  test("test_hooks_json_places_session_start_script_before_inject", () => {
    const hooks = JSON.parse(readFileSync(HOOKS_JSON, "utf-8"));
    const sessionStart = hooks.hooks.SessionStart[0];

    expect(sessionStart.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStart.hooks[0].type).toBe("command");
    expect(sessionStart.hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-seen-skills.mjs"',
    );
    expect(sessionStart.hooks[1].type).toBe("command");
    expect(sessionStart.hooks[1].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-profiler.mjs"',
    );
    expect(sessionStart.hooks[2].type).toBe("command");
    expect(sessionStart.hooks[2].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/inject-claude-md.mjs"',
    );
  });

  test("test_session_start_preserves_seeded_env_file_for_claude_code", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-start-seen-skills-"));
    const envFile = join(tempDir, "claude.env");

    try {
      writeFileSync(envFile, "export SEEDED=1\n", "utf-8");

      const result = await runSessionStart({ CLAUDE_ENV_FILE: envFile });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const content = readFileSync(envFile, "utf-8");
      expect(content).toBe("export SEEDED=1\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("test_session_start_exits_cleanly_without_claude_env_file", async () => {
    const result = await runSessionStart({ CLAUDE_ENV_FILE: undefined });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("test_session_start_returns_cursor_env_json_when_cursor_payload_is_present", async () => {
    const result = await runSessionStart(
      { CLAUDE_ENV_FILE: undefined },
      JSON.stringify({ conversation_id: "cursor-conversation" }),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      env: {
        VERCEL_PLUGIN_SEEN_SKILLS: "",
      },
    });
  });

  test("test_clear_event_wipes_claim_dir_and_session_file", async () => {
    const sessionId = `test-clear-${Date.now()}`;

    try {
      // Pre-seed dedup state: claim dir + session file
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk")).toBe(true);
      expect(tryClaimSessionKey(sessionId, "seen-context-chunks", "nextjs-platform")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "nextjs,ai-sdk", "utf-8");
      writeFileSync(dedupFilePath(sessionId, "seen-context-chunks"), "nextjs-platform", "utf-8");

      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(true);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills"))).toBe(true);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks"))).toBe(true);
      expect(existsSync(dedupFilePath(sessionId, "seen-context-chunks"))).toBe(true);

      // Fire the hook with a "clear" event
      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "clear" }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");

      // Both claim dir and session file should be gone
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills"))).toBe(false);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks"))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-context-chunks"))).toBe(false);
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      rmSync(dedupClaimDirPath(sessionId, "seen-context-chunks"), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
      try { rmSync(dedupFilePath(sessionId, "seen-context-chunks")); } catch {}
    }
  });

  test("test_compact_event_wipes_claim_dir_and_session_file", async () => {
    const sessionId = `test-compact-${Date.now()}`;

    try {
      expect(tryClaimSessionKey(sessionId, "seen-skills", "swr")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "swr", "utf-8");

      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "compact" }),
      );

      expect(result.code).toBe(0);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills"))).toBe(false);
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
    }
  });

  test("test_clear_event_allows_reinjection_of_previously_claimed_skill", async () => {
    const sessionId = `test-reinject-clear-${Date.now()}`;

    try {
      // 1. Seed a claim — skill is now "seen"
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "nextjs", "utf-8");

      // 2. Verify the claim is deduped (second claim returns false)
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(false);

      // 3. Fire "clear" event via session-start hook
      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "clear" }),
      );
      expect(result.code).toBe(0);

      // 4. The same skill can now be claimed again (reinjection works)
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
    }
  });

  test("test_compact_event_allows_reinjection_of_previously_claimed_skill", async () => {
    const sessionId = `test-reinject-compact-${Date.now()}`;

    try {
      // 1. Seed a claim — skill is now "seen"
      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "ai-sdk", "utf-8");

      // 2. Verify the claim is deduped
      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk")).toBe(false);

      // 3. Fire "compact" event via session-start hook
      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "compact" }),
      );
      expect(result.code).toBe(0);

      // 4. The same skill can now be claimed again
      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk")).toBe(true);
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
    }
  });

  test("test_clear_event_removes_scoped_claim_dirs", async () => {
    const sessionId = `test-scoped-clear-${Date.now()}`;
    const scopeId = "subagent-abc";

    try {
      // Seed both unscoped and scoped dedup state
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "nextjs", "utf-8");

      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk", scopeId)).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills", scopeId), "ai-sdk", "utf-8");

      expect(tryClaimSessionKey(sessionId, "seen-context-chunks", "nextjs-platform")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-context-chunks"), "nextjs-platform", "utf-8");
      expect(tryClaimSessionKey(sessionId, "seen-context-chunks", "deploy-operations", scopeId)).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-context-chunks", scopeId), "deploy-operations", "utf-8");

      // Verify both exist
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(true);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills", scopeId))).toBe(true);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills", scopeId))).toBe(true);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks"))).toBe(true);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks", scopeId))).toBe(true);
      expect(existsSync(dedupFilePath(sessionId, "seen-context-chunks", scopeId))).toBe(true);

      // Fire "clear" event
      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "clear" }),
      );
      expect(result.code).toBe(0);

      // Both unscoped and scoped artifacts should be gone
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills"))).toBe(false);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills", scopeId))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-skills", scopeId))).toBe(false);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks"))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-context-chunks"))).toBe(false);
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-context-chunks", scopeId))).toBe(false);
      expect(existsSync(dedupFilePath(sessionId, "seen-context-chunks", scopeId))).toBe(false);

      // Scoped skill can be reclaimed after clear
      expect(tryClaimSessionKey(sessionId, "seen-skills", "ai-sdk", scopeId)).toBe(true);
      expect(tryClaimSessionKey(sessionId, "seen-context-chunks", "deploy-operations", scopeId)).toBe(true);
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      rmSync(dedupClaimDirPath(sessionId, "seen-skills", scopeId), { recursive: true, force: true });
      rmSync(dedupClaimDirPath(sessionId, "seen-context-chunks"), { recursive: true, force: true });
      rmSync(dedupClaimDirPath(sessionId, "seen-context-chunks", scopeId), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
      try { rmSync(dedupFilePath(sessionId, "seen-skills", scopeId)); } catch {}
      try { rmSync(dedupFilePath(sessionId, "seen-context-chunks")); } catch {}
      try { rmSync(dedupFilePath(sessionId, "seen-context-chunks", scopeId)); } catch {}
    }
  });

  test("test_startup_event_does_not_wipe_claim_dir", async () => {
    const sessionId = `test-startup-${Date.now()}`;

    try {
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
      writeFileSync(dedupFilePath(sessionId, "seen-skills"), "nextjs", "utf-8");

      const result = await runSessionStart(
        { CLAUDE_ENV_FILE: undefined },
        JSON.stringify({ session_id: sessionId, hook_event_name: "startup" }),
      );

      expect(result.code).toBe(0);

      // Claim dir and session file should still exist
      expect(existsSync(dedupClaimDirPath(sessionId, "seen-skills"))).toBe(true);
      expect(readFileSync(dedupFilePath(sessionId, "seen-skills"), "utf-8")).toBe("nextjs");
    } finally {
      rmSync(dedupClaimDirPath(sessionId, "seen-skills"), { recursive: true, force: true });
      try { rmSync(dedupFilePath(sessionId, "seen-skills")); } catch {}
    }
  });
});

describe("hook-env session temp path guards", () => {
  test("test_dedup_claim_dir_path_keeps_safe_session_ids_stable", () => {
    expect(dedupClaimDirPath("sess_abc-123", "seen-skills")).toBe(
      join(resolve(tmpdir()), "vercel-plugin-sess_abc-123-seen-skills.d"),
    );
  });

  test("test_dedup_paths_hash_invalid_session_ids_before_joining_tmpdir", () => {
    const sessionId = "agent/../../home/user/.ssh";
    const expectedHash = createHash("sha256").update(sessionId).digest("hex");
    const tempRoot = resolve(tmpdir());

    expect(dedupClaimDirPath(sessionId, "seen-skills")).toBe(
      join(tempRoot, `vercel-plugin-${expectedHash}-seen-skills.d`),
    );
    expect(dedupFilePath(sessionId, "validated-files")).toBe(
      join(tempRoot, `vercel-plugin-${expectedHash}-validated-files.txt`),
    );
  });

  test("test_remove_session_claim_dir_only_removes_hashed_tmpdir_for_invalid_session_ids", () => {
    const sessionId = "nested/../../../../etc";
    const claimDir = dedupClaimDirPath(sessionId, "seen-skills");

    try {
      expect(tryClaimSessionKey(sessionId, "seen-skills", "nextjs")).toBe(true);
      expect(existsSync(claimDir)).toBe(true);

      removeSessionClaimDir(sessionId, "seen-skills");

      expect(existsSync(claimDir)).toBe(false);
      expect(claimDir.startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
      expect(claimDir.includes("../../")).toBe(false);
    } finally {
      rmSync(claimDir, { recursive: true, force: true });
    }
  });
});
