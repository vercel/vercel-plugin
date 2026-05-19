/**
 * Workflow smoke test: verifies the end-to-end regeneration pipeline.
 *
 * 1. Modify a skill section that a template references
 * 2. Verify --check detects staleness
 * 3. Run build:from-skills and verify the dependent .md output changes
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Pick the first template that has an include marker, and identify
 * the skill + heading it references so we can mutate the skill.
 */
function findIncludeDependency(): {
  templatePath: string;
  outputPath: string;
  skillName: string;
  heading: string;
} {
  const dirs = [join(ROOT, "agents"), join(ROOT, "commands")];
  const markerRe = /\{\{include:skill:([^:}]+):([^}]+)\}\}/;

  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md.tmpl") || f.startsWith("_")) continue;
      const content = readFileSync(join(dir, f), "utf8");
      const m = content.match(markerRe);
      if (m) {
        const [, skillName, target] = m;
        // Skip frontmatter refs — we want a section include
        if (target.startsWith("frontmatter:") || target.startsWith("file:")) continue;
        return {
          templatePath: join(dir, f),
          outputPath: join(dir, f.replace(/\.tmpl$/, "")),
          skillName,
          heading: target,
        };
      }
    }
  }
  throw new Error("No template with a skill section include found");
}

/**
 * Insert a sentinel line right after the first line of the referenced heading
 * in the skill file, so it falls within the extracted section.
 */
function insertSentinelInSection(
  skillContent: string,
  heading: string,
  sentinel: string,
): string {
  // The heading path may use ">" for nested headings — use the last segment
  const leafHeading = heading.includes(">")
    ? heading.split(">").pop()!.trim()
    : heading.trim();
  const lines = skillContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/^#+\s*/, "").trim();
    if (stripped.toLowerCase() === leafHeading.toLowerCase()) {
      // Insert sentinel on the line after the heading
      lines.splice(i + 1, 0, sentinel);
      return lines.join("\n");
    }
  }
  throw new Error(`Could not find heading "${leafHeading}" in skill content`);
}

describe("build-from-skills workflow smoke test", () => {
  let dep: ReturnType<typeof findIncludeDependency>;
  let skillPath: string;
  let originalSkillContent: string;
  let originalOutputContent: string;

  beforeAll(() => {
    dep = findIncludeDependency();
    skillPath = join(ROOT, "skills", dep.skillName, "SKILL.md");
    originalSkillContent = readFileSync(skillPath, "utf8");
    originalOutputContent = readFileSync(dep.outputPath, "utf8");
  });

  afterAll(() => {
    // Restore original files
    writeFileSync(skillPath, originalSkillContent);
    writeFileSync(dep.outputPath, originalOutputContent);
  });

  test("--check reports fresh when outputs are up-to-date", () => {
    const result = execSync(
      `bun run scripts/build-from-skills.ts --check --json ${dep.templatePath}`,
      { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const json = JSON.parse(result);
    expect(json.stale).toBe(0);
  });

  test("mutating a skill makes --check detect staleness", () => {
    // Insert a sentinel inside the referenced section
    const sentinel = `<!-- WORKFLOW_SMOKE_TEST_SENTINEL_${Date.now()} -->`;
    const mutated = insertSentinelInSection(originalSkillContent, dep.heading, sentinel);
    writeFileSync(skillPath, mutated);

    try {
      execSync(
        `bun run scripts/build-from-skills.ts --check --json ${dep.templatePath}`,
        { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      // --check should exit non-zero when stale
      throw new Error("Expected --check to exit with non-zero status");
    } catch (err: any) {
      // execSync throws on non-zero exit
      expect(err.status).toBe(1);
      const json = JSON.parse(err.stdout.toString());
      expect(json.stale).toBeGreaterThan(0);
    } finally {
      // Restore skill for next test
      writeFileSync(skillPath, originalSkillContent);
    }
  });

  test("build:from-skills regenerates output after skill change", () => {
    // Insert a sentinel inside the referenced section
    const sentinel = `<!-- WORKFLOW_SMOKE_TEST_SENTINEL_${Date.now()} -->`;
    const mutated = insertSentinelInSection(originalSkillContent, dep.heading, sentinel);
    writeFileSync(skillPath, mutated);

    try {
      // Run build (not --check) to regenerate
      execSync(
        `bun run scripts/build-from-skills.ts ${dep.templatePath}`,
        { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );

      // The output file should now contain the sentinel
      const updatedOutput = readFileSync(dep.outputPath, "utf8");
      expect(updatedOutput).toContain("WORKFLOW_SMOKE_TEST_SENTINEL");
      expect(updatedOutput).not.toBe(originalOutputContent);

      // --check should now report fresh again
      const checkResult = execSync(
        `bun run scripts/build-from-skills.ts --check --json ${dep.templatePath}`,
        { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const json = JSON.parse(checkResult);
      expect(json.stale).toBe(0);
    } finally {
      // Restore both files
      writeFileSync(skillPath, originalSkillContent);
      writeFileSync(dep.outputPath, originalOutputContent);
    }
  });
});
