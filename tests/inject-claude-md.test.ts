import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "inject-claude-md.mjs");
// Claude Code saves a hook's stdout that is longer than 10,000 characters (JS
// string length) to a file and shows Claude only the file path and a preview
// of up to 2,000 characters (https://code.claude.com/docs/en/hooks, "Output
// size limits"). Each output must stay this far below the cap so a content
// sync fails here before it reaches the cap.
const CLAUDE_CODE_HOOK_OUTPUT_CAP = 10_000;
const HEADROOM = 1_000;
const OUTPUT_LIMIT = CLAUDE_CODE_HOOK_OUTPUT_CAP - HEADROOM;
let tempDir: string;

/** Arguments of each SessionStart command in hooks.json that runs this hook. */
function sessionStartInvocations(): string[][] {
  const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  return hooksJson.hooks.SessionStart
    .flatMap((group) => group.hooks)
    .map((hook) => hook.command.split('/hooks/inject-claude-md.mjs"'))
    .filter((split) => split.length === 2)
    .map(([, args]) => args.split(" ").filter(Boolean));
}

/** Runs every registered invocation, as Claude Code does at session start. */
async function runSessionStart(
  payload: Record<string, unknown>,
  env?: Record<string, string | undefined>,
  invocations = sessionStartInvocations(),
  script = HOOK_SCRIPT,
): Promise<{ code: number; outputs: string[]; stdout: string; stderr: string }> {
  const results = [];
  for (const args of invocations) {
    results.push(await runHook(payload, env, args, script));
  }
  const outputs = results.map((result) => result.stdout);
  return {
    code: results.find((result) => result.code !== 0)?.code ?? 0,
    outputs,
    stdout: outputs.filter(Boolean).join("\n\n"),
    stderr: results.map((result) => result.stderr).join(""),
  };
}

async function runHook(
  payload: Record<string, unknown>,
  env?: Record<string, string | undefined>,
  args: string[] = [],
  script = HOOK_SCRIPT,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }

  const proc = Bun.spawn(["node", script, ...args], {
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

/** The knowledge-update skill body without frontmatter, as the hook injects it. */
function readKnowledgeUpdateBody(path: string): string {
  return readFileSync(path, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/** Non-blank lines, without the "(continued)" headers that open a continued part or section. */
function contentLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "" && !/^#{1,2} .* \(continued\)$/.test(line));
}

/** Every expected line appears in `actual`, in order (other lines, like greenfield guidance, may sit between). */
function expectInOrder(actual: string[], expected: string[]): void {
  let next = 0;
  for (const line of actual) {
    if (line === expected[next]) next++;
  }
  expect(expected.slice(next)).toEqual([]);
}

function numberedBullets(label: string, count: number): string[] {
  // Non-ASCII (em dash, arrow, emoji) so the length check counts what Claude Code counts.
  return Array.from(
    { length: count },
    (_, i) => `- **${label} ${i + 1}** — ${"Vercel → platform detail 🚀 ".repeat(12)}end of ${label.toLowerCase()} ${i + 1}.`,
  );
}

const GROWN_FENCE = "```ts\n## not a heading\n- not a list item\n\nexport const config = {};\n```";

function grownKnowledgeUpdate(corrections: string[], products: string[]): string {
  return [
    "# Vercel Knowledge Updates (2099-01-01)",
    "> **IMPORTANT**: trust this document.",
    "## Common outdated knowledge in LLMs",
    [...corrections.slice(0, 10), "", GROWN_FENCE, "", ...corrections.slice(10)].join("\n"),
    "## New products LLMs may not know about",
    products.join("\n"),
    "## Integrations on Vercel",
    "When a build needs an external service, load the `marketplace` skill first.",
  ].join("\n\n");
}

/** A copy of the built hooks with its own knowledge-update skill, run the way hooks.json runs them. */
function fixturePlugin(knowledgeUpdate: string): string {
  // Real path: the hook only runs when argv[1] matches its resolved module path.
  const root = join(realpathSync(tempDir), "plugin");
  mkdirSync(join(root, "hooks"), { recursive: true });
  for (const file of readdirSync(join(ROOT, "hooks")).filter((name) => name.endsWith(".mjs"))) {
    cpSync(join(ROOT, "hooks", file), join(root, "hooks", file));
  }
  cpSync(join(ROOT, "vercel-session.md"), join(root, "vercel-session.md"));
  mkdirSync(join(root, "skills", "knowledge-update"), { recursive: true });
  writeFileSync(
    join(root, "skills", "knowledge-update", "SKILL.md"),
    `---\nname: knowledge-update\n---\n\n${knowledgeUpdate}\n`,
  );
  return join(root, "hooks", "inject-claude-md.mjs");
}

describe("inject-claude-md", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inject-claude-md-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("injects thin session context instead of the full vercel ecosystem graph", async () => {
    const { code, stdout } = await runSessionStart({ session_id: "inject-thin-session" });
    expect(code).toBe(0);
    expect(stdout).toContain("Vercel Plugin Session Context");
    expect(stdout).toContain("Vercel Knowledge Updates");
    expect(stdout).not.toContain("Vercel Ecosystem — Relational Knowledge Graph");
  });

  test("session-start knowledge updates state documented platform limits, not retracted ones", async () => {
    // knowledge-update is injected with "trust this over your training data",
    // so a wrong limit here overrides the agent's correct knowledge. The
    // published limit is 4.5 MB (vercel.com/docs/functions/limitations); the
    // 100 MB claim cited a changelog URL that does not exist.
    const { code, stdout } = await runSessionStart({ session_id: "inject-knowledge-limits" });
    expect(code).toBe(0);
    expect(stdout).toContain("Vercel Knowledge Updates");
    expect(stdout).toMatch(/4\.5 ?MB/);
    expect(stdout).not.toMatch(/request bodies up to 100 MB/);
    expect(stdout).not.toContain("vercel-functions-now-support-100mb-request-bodies");
    // Node.js 18 is no longer offered; the live deprecation is Node.js 20.
    expect(stdout).toMatch(/Node\.js 20/);
    expect(stdout).not.toMatch(/Node\.js 18 is deprecated\./);
  });

  test("session-start knowledge updates state documented product status", async () => {
    const { code, stdout } = await runSessionStart({ session_id: "inject-knowledge-status" });
    expect(code).toBe(0);
    // vercel.com/blog/a-new-programming-model-for-durable-execution (2026-04-16): "Today, Vercel Workflows is generally available"
    expect(stdout).toMatch(/\*\*Vercel Workflows\*\*:.*GA since April 2026\./);
    // vercel.com/docs/services: "Services are available in Beta on all plans"
    expect(stdout).toMatch(/\*\*Vercel Services\*\*:.*Beta on all plans\./);
    // vercel.com/docs/kms: "Key Management Service is available in Beta on all plans"
    expect(stdout).toMatch(/\*\*Vercel KMS\*\*:.*Beta on all plans\./);
    // vercel.com/docs/agent-resources/vercel-mcp: "Vercel MCP is available on all plans"
    expect(stdout).toMatch(/\*\*Vercel MCP server\*\*:.*Available on all plans\./);
    // vercel.com/docs navigation labels "Container Registry beta" and "eve beta"
    expect(stdout).toMatch(/\*\*Vercel Container Registry\*\*:.*Beta\./);
    expect(stdout).toMatch(/\*\*eve\*\*:[^\n]*Beta\./);
  });

  test("appends greenfield guidance when VERCEL_PLUGIN_GREENFIELD=true", async () => {
    const { code, stdout } = await runHook(
      { session_id: "inject-thin-greenfield" },
      { VERCEL_PLUGIN_GREENFIELD: "true" },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Greenfield execution mode");
  });

  test("injects the always-on capability-routing contract", async () => {
    // The load-bearing contract: every activated session gets the signal-gated
    // routing table + the anti-hardcode rule, in the always-on layer.
    const { code, stdout } = await runSessionStart({ session_id: "inject-discover-first" });
    expect(code).toBe(0);
    expect(stdout).toContain("Integrations on Vercel");
    // first-action contract: load the marketplace skill (which owns the discover-first workflow)
    expect(stdout).toMatch(/first action/i);
    expect(stdout).toMatch(/load the `?marketplace`? skill/i);
    // anti-hardcode rule (the Stripe/provider-SDK failure mode)
    expect(stdout).toMatch(/hardcode a provider SDK/i);
    // skill-routing: the marketplace skill is the single always-on entry point
    expect(stdout).toContain("`marketplace`");
    // ambiguous stays loose — not over-strict
    expect(stdout).toMatch(/ambiguous/i);
  });

  test("skips injection for non-empty non-vercel projects", async () => {
    const projectDir = join(tempDir, "plain-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "README.md"), "# Plain project");

    const { code, stdout } = await runSessionStart(
      { session_id: "inject-thin-skip" },
      { CLAUDE_PROJECT_ROOT: projectDir },
    );

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("points Next.js projects at the version-matched docs bundled with next", async () => {
    // Next.js retired its reference skills in favor of docs shipped in the
    // package (nextjs.org/docs/app/guides/ai-agents), so the session-start
    // context is where agents learn to read them.
    const projectDir = join(tempDir, "next-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");

    const { code, stdout } = await runSessionStart(
      { session_id: "inject-nextjs-bundled-docs" },
      { CLAUDE_PROJECT_ROOT: projectDir },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("node_modules/next/dist/docs/");
    expect(stdout).toContain("npx @next/codemod@canary agents-md");
    expect(stdout).toContain("npx skills add vercel/next.js");
  });

  test("hooks.json runs one invocation per part, numbered 1 to n of n", () => {
    const invocations = sessionStartInvocations();
    const count = invocations.length;
    expect(count).toBeGreaterThan(1);
    expect(invocations).toEqual(
      Array.from({ length: count }, (_, i) => ["--part", `${i + 1}/${count}`]),
    );
  });

  test("each registered session-start output has headroom under the cap and together they carry all the context", async () => {
    // If this fails after a content sync, the session context has outgrown the
    // registered parts: add `--part <n+1>/<n+1>` to hooks/hooks.json (and bump
    // every `/<n>`). Do not raise OUTPUT_LIMIT toward the cap.
    const knowledgeUpdate = readKnowledgeUpdateBody(join(ROOT, "skills", "knowledge-update", "SKILL.md"));
    const sessionContext = readFileSync(join(ROOT, "vercel-session.md"), "utf-8");
    const headings = knowledgeUpdate.split("\n").filter((line) => /^## /.test(line));
    expect(headings).toContain("## Integrations on Vercel");

    const vercelProject = join(tempDir, "vercel-project");
    mkdirSync(vercelProject);
    writeFileSync(join(vercelProject, "vercel.json"), "{}");
    const emptyProject = join(tempDir, "empty-project");
    mkdirSync(emptyProject);

    for (const projectDir of [vercelProject, emptyProject]) {
      const { code, outputs, stdout, stderr } = await runSessionStart(
        { session_id: "inject-output-cap" },
        { CLAUDE_PROJECT_ROOT: projectDir },
      );

      expect(code).toBe(0);
      expect(stderr).toBe("");
      for (const output of outputs) {
        expect(output.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
      }
      const lines = outputs.flatMap((output) => output.split("\n"));
      for (const heading of headings) {
        expect(lines.filter((line) => line === heading)).toHaveLength(1);
      }
      expectInOrder(contentLines(stdout), contentLines(`${sessionContext}\n${knowledgeUpdate}`));
      expect(lines.filter((line) => line === "## Greenfield execution mode")).toHaveLength(
        projectDir === emptyProject ? 1 : 0,
      );
    }
  });

  test("a knowledge update that grows past one part is split into parts under the limit without losing content", async () => {
    const corrections = numberedBullets("Correction", 48);
    const products = numberedBullets("Product", 12);
    const script = fixturePlugin(grownKnowledgeUpdate(corrections, products));
    const invocations = Array.from({ length: 6 }, (_, i) => ["--part", `${i + 1}/6`]);

    const { code, outputs, stdout, stderr } = await runSessionStart(
      { session_id: "inject-growth" },
      { CLAUDE_PROJECT_ROOT: ROOT },
      invocations,
      script,
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(outputs.filter(Boolean).length).toBeGreaterThan(2);
    expect(outputs.at(-1)).toBe("");
    for (const output of outputs) {
      expect(output.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    }
    for (const bullet of [...corrections, ...products]) {
      expect(stdout.split(bullet)).toHaveLength(2);
    }
    // The fenced block is never split, and its lines are not headings or list items to the splitter.
    expect(outputs.filter((output) => output.includes(GROWN_FENCE))).toHaveLength(1);
    const lines = stdout.split("\n");
    expect(lines.filter((line) => line === "## Common outdated knowledge in LLMs")).toHaveLength(1);
    expect(lines.filter((line) => line === "## Integrations on Vercel")).toHaveLength(1);
    // A part that continues the knowledge update or a section says so.
    const continuedParts = outputs.filter(Boolean).slice(1);
    for (const output of continuedParts) {
      expect(output.startsWith("# Vercel Knowledge Updates (2099-01-01) (continued)\n\n")).toBe(true);
    }
    expect(lines.filter((line) => line === "## Common outdated knowledge in LLMs (continued)").length).toBeGreaterThan(0);
  });

  test("content that needs more parts than hooks.json runs is printed in the last part, not dropped", async () => {
    const corrections = numberedBullets("Correction", 48);
    const products = numberedBullets("Product", 12);
    const script = fixturePlugin(grownKnowledgeUpdate(corrections, products));

    const { code, outputs, stdout, stderr } = await runSessionStart(
      { session_id: "inject-overflow" },
      { CLAUDE_PROJECT_ROOT: ROOT },
      [["--part", "1/2"], ["--part", "2/2"]],
      script,
    );

    expect(code).toBe(0);
    expect(outputs[0].length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    // Over the limit, so the registered-output test above fails for real content.
    expect(outputs[1].length).toBeGreaterThan(OUTPUT_LIMIT);
    for (const bullet of [...corrections, ...products]) {
      expect(stdout.split(bullet)).toHaveLength(2);
    }
    expect(stderr).toContain("hooks.json runs 2");
  });

  test("a single block longer than the limit is printed whole in its own part", async () => {
    const longBullet = `- **Long correction** — ${"word ".repeat(1_900)}end.`;
    const script = fixturePlugin(
      `# Vercel Knowledge Updates (2099-01-01)\n\n## Long\n\n${longBullet}\n\n## After\n\n- **After** — short.`,
    );

    const { code, outputs } = await runSessionStart(
      { session_id: "inject-long-block" },
      { CLAUDE_PROJECT_ROOT: ROOT },
      [["--part", "1/3"], ["--part", "2/3"], ["--part", "3/3"]],
      script,
    );

    expect(code).toBe(0);
    const withLongBullet = outputs.filter((output) => output.includes(longBullet));
    expect(withLongBullet).toHaveLength(1);
    expect(withLongBullet[0].length).toBeGreaterThan(OUTPUT_LIMIT);
    expect(outputs.join("\n")).toContain("- **After** — short.");
    expect(outputs[0]).toContain("Vercel Plugin Session Context");
  });

  test("still injects for empty directories", async () => {
    const projectDir = join(tempDir, "greenfield-project");
    mkdirSync(projectDir);

    const { code, stdout } = await runHook(
      { session_id: "inject-thin-empty" },
      { CLAUDE_PROJECT_ROOT: projectDir },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Vercel Plugin Session Context");
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

    const parts = await runSessionStart({
      conversation_id: "inject-thin-cursor",
      cursor_version: "1.0.0",
      workspace_roots: [ROOT],
    });
    expect(parts.code).toBe(0);
    const contexts = parts.outputs.map((output) => JSON.parse(output).additional_context);
    expect(contexts.join("\n\n")).toContain("Vercel Knowledge Updates");
    expect(contexts.join("\n\n")).toContain("## Integrations on Vercel");
  });
});
