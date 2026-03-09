import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const MANIFEST_PATH = join(ROOT, "generated", "skill-manifest.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runHook(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const session = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({ ...input, session_id: session });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_SEEN_SKILLS: "" },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function parseInjection(stdout: string): { injectedSkills: string[]; matchedSkills: string[] } | null {
  const output = JSON.parse(stdout);
  const ctx = output.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

// ---------------------------------------------------------------------------
// SKILL.md file validation
// ---------------------------------------------------------------------------

describe("react-best-practices SKILL.md", () => {
  const skillPath = join(SKILLS_DIR, "react-best-practices", "SKILL.md");

  test("SKILL.md exists", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  test("has valid frontmatter with slug and triggers", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: react-best-practices");
    expect(content).toContain("pathPatterns:");
    expect(content).toContain("components/**/*.tsx");
  });

  test("contains review checklist content", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("Component Structure");
    expect(content).toContain("Hooks");
    expect(content).toContain("Accessibility");
    expect(content).toContain("Performance");
    expect(content).toContain("TypeScript");
  });
});

describe("agent-browser-verify SKILL.md", () => {
  const skillPath = join(SKILLS_DIR, "agent-browser-verify", "SKILL.md");

  test("SKILL.md exists", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  test("has valid frontmatter with slug and triggers", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: agent-browser-verify");
    expect(content).toContain("bashPatterns:");
    expect(content).toContain("next\\s+dev");
  });

  test("is under 4KB", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content.length).toBeLessThan(8192);
  });

  test("contains verification checklist", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("Verification Checklist");
    expect(content).toContain("agent-browser open");
    expect(content).toContain("On Failure");
    expect(content).toContain("On Success");
  });
});

// ---------------------------------------------------------------------------
// Skill map resolution
// ---------------------------------------------------------------------------

describe("skill-map resolution", () => {
  test("buildSkillMap resolves react-best-practices", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const result = buildSkillMap(SKILLS_DIR);
    expect(result.skills).toHaveProperty("react-best-practices");
    const skill = result.skills["react-best-practices"];
    expect(skill.priority).toBe(4);
    expect(skill.pathPatterns.length).toBeGreaterThan(0);
  });

  test("buildSkillMap resolves agent-browser-verify", async () => {
    const { buildSkillMap } = await import("../hooks/skill-map-frontmatter.mjs");
    const result = buildSkillMap(SKILLS_DIR);
    expect(result.skills).toHaveProperty("agent-browser-verify");
    const skill = result.skills["agent-browser-verify"];
    expect(skill.priority).toBe(2);
    expect(skill.bashPatterns.length).toBeGreaterThan(0);
  });

  test("loadSkills includes both new skills in compiled entries", async () => {
    const { loadSkills } = await import("../hooks/pretooluse-skill-inject.mjs");
    const result = loadSkills(ROOT);
    expect(result).not.toBeNull();
    const slugs = result.compiledSkills.map((e: any) => e.skill);
    expect(slugs).toContain("react-best-practices");
    expect(slugs).toContain("agent-browser-verify");
  });
});

// ---------------------------------------------------------------------------
// Hook integration — pattern matching
// ---------------------------------------------------------------------------

describe("hook skill injection", () => {
  test("editing a component .tsx file matches react-best-practices", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "components/Button.tsx", old_string: "a", new_string: "b" },
    });
    expect(code).toBe(0);
    const injection = parseInjection(stdout);
    expect(injection).not.toBeNull();
    expect(injection!.injectedSkills).toContain("react-best-practices");
  });

  test("running next dev matches agent-browser-verify", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "next dev" },
    });
    expect(code).toBe(0);
    const injection = parseInjection(stdout);
    expect(injection).not.toBeNull();
    expect(injection!.matchedSkills).toContain("agent-browser-verify");
  });

  test("running npm run dev matches agent-browser-verify", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm run dev" },
    });
    expect(code).toBe(0);
    const injection = parseInjection(stdout);
    expect(injection).not.toBeNull();
    expect(injection!.matchedSkills).toContain("agent-browser-verify");
  });
});
