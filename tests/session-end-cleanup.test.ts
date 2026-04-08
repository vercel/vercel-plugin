import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "session-end-cleanup.mjs");
const HOOKS_CONFIG_PATH = join(ROOT, "hooks", "hooks.json");

async function runSessionEnd(
  payload: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_LOG_LEVEL: "off",
    },
  });

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("session-end-cleanup", () => {
  test("removes hashed pending-launch directories for unsafe session ids", async () => {
    const sessionId = "unsafe/session:id";
    const hashedSessionId = createHash("sha256").update(sessionId).digest("hex");
    const pendingLaunchDir = join(resolve(tmpdir()), `vercel-plugin-${hashedSessionId}-pending-launches`);

    mkdirSync(pendingLaunchDir, { recursive: true });
    writeFileSync(join(pendingLaunchDir, "launch.json"), "{\"ok\":true}\n", "utf-8");

    try {
      expect(existsSync(pendingLaunchDir)).toBe(true);

      const { code, stdout, stderr } = await runSessionEnd({ session_id: sessionId });

      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(existsSync(pendingLaunchDir)).toBe(false);
    } finally {
      rmSync(pendingLaunchDir, { recursive: true, force: true });
    }
  });

  test("removes hashed pending-launch directories when only conversation_id is provided", async () => {
    const conversationId = "cursor/conversation:id";
    const hashedSessionId = createHash("sha256").update(conversationId).digest("hex");
    const pendingLaunchDir = join(resolve(tmpdir()), `vercel-plugin-${hashedSessionId}-pending-launches`);

    mkdirSync(pendingLaunchDir, { recursive: true });
    writeFileSync(join(pendingLaunchDir, "launch.json"), "{\"ok\":true}\n", "utf-8");

    try {
      expect(existsSync(pendingLaunchDir)).toBe(true);

      const { code, stdout, stderr } = await runSessionEnd({ conversation_id: conversationId });

      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(existsSync(pendingLaunchDir)).toBe(false);
    } finally {
      rmSync(pendingLaunchDir, { recursive: true, force: true });
    }
  });
});

describe("hooks.json wiring", () => {
  test("registers the Agent pretooluse observer hook", () => {
    const config = JSON.parse(readFileSync(HOOKS_CONFIG_PATH, "utf-8")) as {
      hooks?: {
        PreToolUse?: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
        }>;
      };
    };

    expect(config.hooks?.PreToolUse).toContainEqual({
      matcher: "Agent",
      hooks: [
        {
          type: "command",
          command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-subagent-spawn-observe.mjs\"",
          timeout: 5,
        },
      ],
    });
  });
});
