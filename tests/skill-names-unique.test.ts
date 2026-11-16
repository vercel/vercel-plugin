import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// The claude.ai marketplace validator walks every SKILL.md under skills/ and
// rejects the whole plugin when two of them declare the same `name:`.

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(path));
    else if (entry.name === "SKILL.md") out.push(path);
  }
  return out;
}

describe("skills/ layout", () => {
  test("no two SKILL.md files under skills/ share a name", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const file of findSkillFiles(SKILLS_DIR)) {
      const name = readFileSync(file, "utf8").match(/^---\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
      if (!name) continue;
      const rel = relative(ROOT, file);
      const prev = seen.get(name);
      if (prev) duplicates.push(`${name}: ${prev} and ${rel}`);
      else seen.set(name, rel);
    }
    expect(duplicates).toEqual([]);
  });

  test("synced skills keep their upstream copy in upstream/UPSTREAM.md", () => {
    const problems: string[] = [];
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      const skillDir = join(SKILLS_DIR, entry.name);
      if (!entry.isDirectory() || !existsSync(join(skillDir, "overlay.yaml"))) continue;
      if (existsSync(join(skillDir, "upstream", "SKILL.md"))) {
        problems.push(`${entry.name}: upstream/SKILL.md should be upstream/UPSTREAM.md`);
      }
      const upstreamPath = join(skillDir, "upstream", "UPSTREAM.md");
      if (!existsSync(upstreamPath)) {
        problems.push(`${entry.name}: missing upstream/UPSTREAM.md`);
        continue;
      }
      // Same merge as scripts/build-skills.ts, without writing anything.
      const lines = readFileSync(upstreamPath, "utf8").split("\n");
      const fences = lines.flatMap((line, i) => (line.trim() === "---" ? [i] : []));
      const body = fences.length >= 2 ? lines.slice(fences[1] + 1).join("\n") : lines.join("\n");
      const overlay = readFileSync(join(skillDir, "overlay.yaml"), "utf8");
      if (readFileSync(join(skillDir, "SKILL.md"), "utf8") !== `---\n${overlay}---\n${body}`) {
        problems.push(`${entry.name}: SKILL.md is stale, run bun run build:skills`);
      }
    }
    expect(problems).toEqual([]);
  });
});
