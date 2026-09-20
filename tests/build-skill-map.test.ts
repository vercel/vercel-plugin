import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, matchSkills } from "../hooks/pretooluse-skill-inject.mjs";
import { explain } from "../src/cli/explain.ts";
import { doctor, formatDoctorResult } from "../src/commands/doctor.ts";

const ROOT = resolve(import.meta.dirname, "..");

describe("skill loading from source files", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vercel-plugin-skills-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(slug: string, pattern: string, priority = 5) {
    const dir = join(root, "skills", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---
name: ${slug}
description: Test skill
summary: Current guidance for ${slug}
metadata:
  priority: ${priority}
  pathPatterns:
    - "${pattern}"
  bashPatterns:
    - "example-command"
  importPatterns:
    - "example-package"
  promptSignals:
    phrases:
      - "example skill"
    minScore: 6
retrieval:
  aliases:
    - "example alias"
---
# ${slug}
Current skill instructions.
`);
  }

  function matchedSkills(path: string): string[] {
    const loaded = loadSkills(root);
    expect(loaded).not.toBeNull();
    const result = matchSkills("Read", { file_path: path }, loaded!.compiledSkills);
    return [...result!.matched];
  }

  test("loads all shipped skills with path, command, and import patterns", () => {
    const loaded = loadSkills(ROOT);
    expect(loaded).not.toBeNull();
    const slugs = readdirSync(join(ROOT, "skills"))
      .filter((slug) => existsSync(join(ROOT, "skills", slug, "SKILL.md")))
      .sort();
    expect(Object.keys(loaded!.skillMap).sort()).toEqual(slugs);
    expect(loaded!.compiledSkills.map((entry) => entry.skill).sort()).toEqual(slugs);
    expect([...matchSkills("Read", { file_path: "next.config.ts" }, loaded!.compiledSkills)!.matched])
      .toContain("nextjs");

    for (const entry of loaded!.compiledSkills) {
      for (const pattern of [...entry.compiledPaths, ...entry.compiledBash, ...entry.compiledImports]) {
        expect(pattern.regex).toBeInstanceOf(RegExp);
      }
    }
  });

  test("loads matching and prompt metadata without writing an index", () => {
    writeSkill("example", "src/**/*.ts", 8);
    const loaded = loadSkills(root)!;
    expect(loaded.skillMap.example.priority).toBe(8);
    expect(loaded.skillMap.example.promptSignals?.phrases).toEqual(["example skill"]);
    expect(loaded.skillMap.example.retrieval?.aliases).toEqual(["example alias"]);
    expect(matchedSkills("src/index.ts")).toEqual(["example"]);
    expect([...matchSkills("Bash", { command: "example-command" }, loaded.compiledSkills)!.matched])
      .toEqual(["example"]);
    expect([...matchSkills("Write", {
      file_path: "unmatched.js",
      content: 'import value from "example-package";',
    }, loaded.compiledSkills)!.matched]).toEqual(["example"]);
    expect(existsSync(join(root, "generated"))).toBe(false);
  });

  test("skill edits immediately update hook and CLI matches", () => {
    writeSkill("example", "old/**/*.ts", 4);
    expect(matchedSkills("old/index.ts")).toEqual(["example"]);
    expect(explain("old/index.ts", root).matches.map((match) => match.skill)).toEqual(["example"]);

    writeSkill("example", "new/**/*.ts", 8);
    expect(matchedSkills("old/index.ts")).toEqual([]);
    expect(matchedSkills("new/index.ts")).toEqual(["example"]);
    expect(explain("old/index.ts", root).matches).toEqual([]);
    const result = explain("new/index.ts", root);
    expect(result.matches.map((match) => match.skill)).toEqual(["example"]);
    expect(result.matches[0].priority).toBe(8);
    expect(result.matches[0].injectionMode).toBe("full");
  });

  test("added and removed skills take effect without rebuilding", () => {
    writeSkill("first", "src/**/*.ts");
    expect(matchedSkills("src/index.ts")).toEqual(["first"]);

    writeSkill("second", "src/**/*.ts");
    expect(matchedSkills("src/index.ts")).toEqual(["first", "second"]);

    rmSync(join(root, "skills", "first"), { recursive: true });
    expect(matchedSkills("src/index.ts")).toEqual(["second"]);
    expect(explain("src/index.ts", root).skillCount).toBe(1);
  });

  test("doctor checks source skills without requiring a generated report", () => {
    writeSkill("example", "src/**/*.ts");
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    const result = doctor(root);
    expect(result.summary.liveSkillCount).toBe(1);
    expect(result.issues.filter((issue) => issue.check !== "dedup")).toEqual([]);
    expect(formatDoctorResult(result)).toContain("Skills (live scan): 1");
    expect(existsSync(join(root, "generated"))).toBe(false);
  });

  test("returns no skill map when no skills can be loaded", () => {
    expect(loadSkills(root)).toBeNull();
  });
});
