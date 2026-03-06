import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const UNLIMITED_BUDGET = "999999";

async function runHook(input: {
  tool_name: string;
  tool_input: Record<string, string>;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      VERCEL_PLUGIN_HOOK_DEDUP: "off",
    },
  });
  proc.stdin.write(JSON.stringify({ ...input, session_id: "slack-clone-patterns" }));
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

async function matchFile(filePath: string): Promise<string[]> {
  const { code, stdout } = await runHook({
    tool_name: "Read",
    tool_input: { file_path: filePath },
  });
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as {
    hookSpecificOutput?: {
      skillInjection?: {
        injectedSkills?: string[];
      };
    };
  };
  return result.hookSpecificOutput?.skillInjection?.injectedSkills ?? [];
}

const EXPECTED_SLACK_ROUTE_SKILLS = ["chat-sdk", "vercel-functions", "nextjs"] as const;

describe("slack clone patterns", () => {
  test("slack-clone app/api/slack/route.ts injects chat-sdk, vercel-functions, nextjs", async () => {
    expect(await matchFile("/Users/me/slack-clone/app/api/slack/route.ts")).toEqual(
      EXPECTED_SLACK_ROUTE_SKILLS,
    );
  });

  test("slack-clone src/app/api/slack/route.ts injects chat-sdk, vercel-functions, nextjs", async () => {
    expect(await matchFile("/Users/me/slack-clone/src/app/api/slack/route.ts")).toEqual(
      EXPECTED_SLACK_ROUTE_SKILLS,
    );
  });

  test("slack-clone app/api/webhooks/slack/route.ts injects chat-sdk, vercel-functions, nextjs", async () => {
    expect(await matchFile("/Users/me/slack-clone/app/api/webhooks/slack/route.ts")).toEqual(
      EXPECTED_SLACK_ROUTE_SKILLS,
    );
  });

  test("slack-clone lib/bot/slack.ts injects chat-sdk", async () => {
    expect(await matchFile("/Users/me/slack-clone/lib/bot/slack.ts")).toEqual(["chat-sdk"]);
  });

  test("slack-clone components/chat/message-list.tsx injects json-render", async () => {
    expect(await matchFile("/Users/me/slack-clone/components/chat/message-list.tsx")).toEqual([
      "json-render",
    ]);
  });
});
