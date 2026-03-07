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

  proc.stdin.write(
    JSON.stringify({
      ...input,
      session_id: "notion-clone-patterns",
    }),
  );
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
  const result = JSON.parse(stdout);
  const ctx = result?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  return si.injectedSkills ?? [];
}

describe("notion clone patterns", () => {
  test("notion-clone app/layout.tsx injects observability before nextjs", async () => {
    const injectedSkills = await matchFile("/Users/me/notion-clone/app/layout.tsx");
    expect(injectedSkills).toEqual(["observability", "nextjs"]);
  });

  test("notion-clone middleware.ts injects routing-middleware", async () => {
    const injectedSkills = await matchFile("/Users/me/notion-clone/middleware.ts");
    expect(injectedSkills).toEqual(["auth", "routing-middleware"]);
  });

  test("notion-clone components/ui/dialog.tsx injects shadcn", async () => {
    const injectedSkills = await matchFile(
      "/Users/me/notion-clone/components/ui/dialog.tsx",
    );
    expect(injectedSkills).toEqual(["shadcn"]);
  });

  test("notion-clone app/(marketing)/(routes)/page.tsx injects nextjs", async () => {
    const injectedSkills = await matchFile(
      "/Users/me/notion-clone/app/(marketing)/(routes)/page.tsx",
    );
    expect(injectedSkills).toEqual(["nextjs"]);
  });

  test("notion-clone next.config.ts injects nextjs then turbopack", async () => {
    const injectedSkills = await matchFile("/Users/me/notion-clone/next.config.ts");
    expect(injectedSkills).toEqual(["nextjs", "turbopack"]);
  });
});
