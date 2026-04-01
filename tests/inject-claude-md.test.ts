import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "inject-claude-md.mjs");

async function runHook(
  payload: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }

  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("inject-claude-md", () => {
  test("injects thin session context instead of the full vercel ecosystem graph", async () => {
    const { code, stdout } = await runHook({ session_id: "inject-thin-session" });
    expect(code).toBe(0);
    expect(stdout).toContain("Vercel Plugin Session Context");
    expect(stdout).toContain("Vercel Knowledge Updates");
    expect(stdout).not.toContain("Vercel Ecosystem — Relational Knowledge Graph");
  });

  test("appends greenfield guidance when VERCEL_PLUGIN_GREENFIELD=true", async () => {
    const { code, stdout } = await runHook(
      { session_id: "inject-thin-greenfield" },
      { VERCEL_PLUGIN_GREENFIELD: "true" },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Greenfield execution mode");
  });

  test("cursor payload returns flat JSON with thin additional context", async () => {
    const { code, stdout } = await runHook({
      conversation_id: "inject-thin-cursor",
      cursor_version: "1.0.0",
      workspace_roots: [ROOT],
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additional_context).toContain("Vercel Plugin Session Context");
    expect(result.additional_context).not.toContain("Vercel Ecosystem — Relational Knowledge Graph");
  });
});
