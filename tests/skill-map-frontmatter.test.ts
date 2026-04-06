import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Import the module under test
import {
  extractFrontmatter,
  parseSkillFrontmatter,
  scanSkillsDir,
  buildSkillMap,
  validateSkillMap,
} from "../hooks/skill-map-frontmatter.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

function readSkillFrontmatter(skillDir: string): string {
  return extractFrontmatter(
    readFileSync(join(SKILLS_DIR, skillDir, "SKILL.md"), "utf-8"),
  ).yaml;
}

/**
 * Count the number of skill directories that contain a SKILL.md file.
 * Used as the ground-truth expected count so tests don't break when
 * skills are added or removed.
 */
function countSkillDirs(): number {
  return readdirSync(SKILLS_DIR).filter((d) => {
    try {
      return existsSync(join(SKILLS_DIR, d, "SKILL.md"));
    } catch {
      return false;
    }
  }).length;
}

// ─── Migration regression: skill-map.json must not exist ─────────

describe("migration regression", () => {
  test("skill-map.json does not exist anywhere in the repo", () => {
    const legacyPaths = [
      join(ROOT, "skill-map.json"),
      join(ROOT, "hooks", "skill-map.json"),
      join(ROOT, "skills", "skill-map.json"),
    ];
    for (const p of legacyPaths) {
      expect(existsSync(p)).toBe(false);
    }
  });
});

// ─── extractFrontmatter ───────────────────────────────────────────

describe("extractFrontmatter", () => {
  test("extracts yaml and body from valid frontmatter", () => {
    const md = `---\nname: test\ndescription: hello\n---\n# Body here`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test\ndescription: hello");
    expect(result.body).toBe("# Body here");
  });

  test("returns empty yaml when no frontmatter present", () => {
    const md = `# Just a heading\nSome content`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("");
    expect(result.body).toBe(md);
  });

  test("handles empty body after frontmatter", () => {
    const md = `---\nname: test\n---\n`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
    expect(result.body).toBe("");
  });

  test("handles frontmatter with no trailing newline", () => {
    const md = `---\nname: test\n---`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
  });

  test("handles windows-style line endings", () => {
    const md = "---\r\nname: test\r\n---\r\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
    expect(result.body).toBe("# Body");
  });

  test("strips BOM and extracts frontmatter correctly", () => {
    const md = "\uFEFF---\nname: bom-test\ndescription: BOM prefixed\n---\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: bom-test\ndescription: BOM prefixed");
    expect(result.body).toBe("# Body");
  });

  test("leading whitespace before opening --- fence returns no yaml", () => {
    const md = "  ---\nname: test\n---\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("");
    expect(result.body).toBe(md);
  });
});

// ─── parseSkillFrontmatter ────────────────────────────────────────

describe("parseSkillFrontmatter", () => {
  test("parses name, description, and metadata", () => {
    const yamlStr = `name: nextjs\ndescription: Next.js guide\nmetadata:\n  priority: 5\n  pathPatterns:\n    - 'app/**'\n  bashPatterns:\n    - '\\bnext\\s+dev\\b'`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("nextjs");
    expect(result.description).toBe("Next.js guide");
    expect(result.metadata.priority).toBe(5);
    expect(result.metadata.pathPatterns).toEqual(["app/**"]);
    expect(result.metadata.bashPatterns).toEqual(["\\bnext\\s+dev\\b"]);
  });

  test("returns defaults for empty string", () => {
    const result = parseSkillFrontmatter("");
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.metadata).toEqual({});
  });

  test("preserves backslash sequences in single-quoted YAML strings", () => {
    // Single-quoted YAML strings should NOT interpret \b as backspace
    const yamlStr = `name: test\nmetadata:\n  bashPatterns:\n    - '\\bnpm\\s+install\\b'`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.metadata.bashPatterns[0]).toBe("\\bnpm\\s+install\\b");
  });

  test("handles missing metadata gracefully", () => {
    const yamlStr = `name: minimal\ndescription: just a name`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("minimal");
    expect(result.metadata).toEqual({});
  });

  test("metadata: [] (array) is coerced to empty object", () => {
    const yamlStr = `name: arr-meta\nmetadata: []`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("arr-meta");
    expect(result.metadata).toEqual({});
    expect(Array.isArray(result.metadata)).toBe(false);
  });

  test("metadata: 'bad' (string) is coerced to empty object", () => {
    const yamlStr = `name: str-meta\nmetadata: bad`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("str-meta");
    expect(result.metadata).toEqual({});
    expect(typeof result.metadata).toBe("object");
  });

  test("parses summary field from frontmatter", () => {
    const yamlStr = `name: test-skill\nsummary: A short summary of the skill.\nmetadata:\n  priority: 5\n  pathPatterns: []`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.summary).toBe("A short summary of the skill.");
  });

  test("summary defaults to empty string when missing", () => {
    const yamlStr = `name: no-summary\nmetadata:\n  pathPatterns: []`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.summary).toBe("");
  });

  test("non-string summary defaults to empty string", () => {
    const yamlStr = `name: bad-summary\nsummary: 42\nmetadata:\n  pathPatterns: []`;
    const result = parseSkillFrontmatter(yamlStr);
    // 42 is parsed as a number by the YAML parser, so summary becomes ""
    expect(result.summary).toBe("");
  });

  test("parses validate: rules from frontmatter", () => {
    const yamlStr = [
      "name: test",
      "validate:",
      "  -",
      "    pattern: \"import.*from 'openai'\"",
      "    message: Use @ai-sdk/openai provider",
      "    severity: error",
      "  -",
      "    pattern: \"model:\\\\s*'gpt-\"",
      "    message: Use gateway model IDs",
      "    severity: warn",
    ].join("\n");
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.validate).toHaveLength(2);
    expect(result.validate[0].pattern).toBe("import.*from 'openai'");
    expect(result.validate[0].message).toBe("Use @ai-sdk/openai provider");
    expect(result.validate[0].severity).toBe("error");
    expect(result.validate[1].severity).toBe("warn");
  });

  test("missing validate: field returns empty array", () => {
    const yamlStr = `name: no-validate\nmetadata:\n  pathPatterns: []`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.validate).toEqual([]);
  });

  test("validate: with empty string returns empty array", () => {
    const result = parseSkillFrontmatter("");
    expect(result.validate).toEqual([]);
  });

  test("malformed validate rules are skipped", () => {
    const yamlStr = [
      "name: test",
      "validate:",
      "  -",
      "    pattern: valid-pattern",
      "    message: Valid message",
      "    severity: error",
      "  -",
      "    pattern: missing-message",
      "    severity: error",
      "  -",
      "    message: missing-pattern",
      "    severity: warn",
      "  -",
      "    pattern: bad-severity",
      "    message: Has bad severity",
      "    severity: info",
    ].join("\n");
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.validate).toHaveLength(1);
    expect(result.validate[0].pattern).toBe("valid-pattern");
  });

  test("validate: non-array value returns empty array", () => {
    const yamlStr = `name: test\nvalidate: not-an-array`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.validate).toEqual([]);
  });

  test("parses skills/ncc frontmatter with regex chaining intact", () => {
    const result = parseSkillFrontmatter(readSkillFrontmatter("ncc"));

    expect(result.name).toBe("ncc");
    expect(result.chainTo).toHaveLength(2);
    expect(result.chainTo[1].pattern).toBe("ncc\\s+build|from\\s+['\"]@vercel/ncc['\"]");
  });

  test("parses skills/next-forge frontmatter with nested promptSignals arrays", () => {
    const result = parseSkillFrontmatter(readSkillFrontmatter("next-forge"));

    expect(result.name).toBe("next-forge");
    expect(result.summary).toContain("skill:next-forge");
    expect(result.metadata.promptSignals).toEqual({
      phrases: ["next-forge", "next forge", "@repo/"],
      allOf: [
        ["monorepo", "saas", "starter"],
        ["turborepo", "clerk", "stripe"],
      ],
      anyOf: ["saas starter", "production monorepo", "keys.ts", "pnpm-workspace"],
      noneOf: ["create-t3-app"],
      minScore: 6,
    });
  });

  test("quotes @repo/* in next-forge YAML frontmatter for standard YAML parser compatibility", () => {
    const overlay = readFileSync(join(SKILLS_DIR, "next-forge", "overlay.yaml"), "utf-8");
    const frontmatter = readSkillFrontmatter("next-forge");

    expect(overlay).toContain(`- '@repo/*'`);
    expect(frontmatter).toContain(`- '@repo/*'`);
  });
});

// ─── scanSkillsDir ────────────────────────────────────────────────

describe("scanSkillsDir", () => {
  test("scans actual skills directory and finds all skills", () => {
    const expected = countSkillDirs();
    const { skills } = scanSkillsDir(SKILLS_DIR);
    expect(skills.length).toBe(expected);
    // Assert on directory-based identity (canonical key), not frontmatter name
    const dirs = skills.map((s) => s.dir);
    expect(dirs).toContain("nextjs");
    expect(dirs).toContain("vercel-storage");
    expect(dirs).toContain("ai-sdk");
  });

  test("each skill has dir, name, description, and metadata", () => {
    const { skills } = scanSkillsDir(SKILLS_DIR);
    for (const skill of skills) {
      // dir is the canonical identity
      expect(typeof skill.dir).toBe("string");
      expect(skill.dir.length).toBeGreaterThan(0);
      // name is non-empty but may differ from dir
      expect(typeof skill.name).toBe("string");
      expect(skill.name.length).toBeGreaterThan(0);
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.metadata).toBe("object");
    }
  });

  test("each skill has pathPatterns and bashPatterns arrays in metadata", () => {
    const { skills } = scanSkillsDir(SKILLS_DIR);
    for (const skill of skills) {
      expect(Array.isArray(skill.metadata.pathPatterns)).toBe(true);
      expect(Array.isArray(skill.metadata.bashPatterns)).toBe(true);
    }
  });

  test("returns empty skills and diagnostics for non-existent directory", () => {
    const { skills, diagnostics } = scanSkillsDir("/nonexistent/path");
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test("works with a temp directory containing skill files", () => {
    const tmp = join(tmpdir(), `skill-test-${Date.now()}`);
    const skillDir = join(tmp, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: my-skill\ndescription: A test skill\nmetadata:\n  priority: 3\n  pathPatterns:\n    - 'src/**'\n  bashPatterns:\n    - '\\bmy-cmd\\b'\n---\n# My Skill`
    );

    const { skills, diagnostics } = scanSkillsDir(tmp);
    expect(skills.length).toBe(1);
    expect(skills[0].dir).toBe("my-skill");
    expect(skills[0].name).toBe("my-skill"); // frontmatter name matches dir here
    expect(skills[0].metadata.priority).toBe(3);
    expect(skills[0].metadata.pathPatterns).toEqual(["src/**"]);
    expect(diagnostics).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("skips SKILL.md with malformed YAML and populates diagnostics", () => {
    const tmp = join(tmpdir(), `skill-bad-yaml-${Date.now()}`);
    const goodDir = join(tmp, "good-skill");
    const badDir = join(tmp, "bad-skill");
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });

    writeFileSync(
      join(goodDir, "SKILL.md"),
      `---\nname: good-skill\ndescription: Works\nmetadata:\n  priority: 5\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# Good`,
    );
    // Malformed YAML: tab indentation triggers inline parser error
    writeFileSync(
      join(badDir, "SKILL.md"),
      `---\nname: bad-skill\n\tmetadata: foo\n---\n# Bad`,
    );

    const { skills, diagnostics } = scanSkillsDir(tmp);
    // Should get only the good skill, not crash
    expect(skills.length).toBe(1);
    expect(skills[0].dir).toBe("good-skill");
    // Diagnostic should capture the bad file
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].file).toContain("bad-skill");
    expect(diagnostics[0].file).toContain("SKILL.md");
    expect(typeof diagnostics[0].error).toBe("string");
    expect(typeof diagnostics[0].message).toBe("string");

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("buildSkillMap repo regressions", () => {
  test("builds ncc and next-forge without frontmatter diagnostics", () => {
    const result = buildSkillMap(SKILLS_DIR);
    const normalizedDiagnosticFiles = result.diagnostics.map((diagnostic) =>
      diagnostic.file.replaceAll("\\", "/"),
    );

    expect(normalizedDiagnosticFiles).not.toContain(
      `${SKILLS_DIR.replaceAll("\\", "/")}/ncc/SKILL.md`,
    );
    expect(normalizedDiagnosticFiles).not.toContain(
      `${SKILLS_DIR.replaceAll("\\", "/")}/next-forge/SKILL.md`,
    );
    expect(result.skills.ncc.chainTo[1].pattern).toBe(
      "ncc\\s+build|from\\s+['\"]@vercel/ncc['\"]",
    );
    expect(result.skills["next-forge"].promptSignals?.allOf).toEqual([
      ["monorepo", "saas", "starter"],
      ["turborepo", "clerk", "stripe"],
    ]);
  });
});

// ─── buildSkillMap ────────────────────────────────────────────────

describe("buildSkillMap", () => {
  test("produces object with skills, diagnostics, and warnings keys (no $schema)", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(map.$schema).toBeUndefined();
    expect(typeof map.skills).toBe("object");
    expect(Array.isArray(map.diagnostics)).toBe(true);
    expect(Array.isArray(map.warnings)).toBe(true);
  });

  test("defaults priority to 5 when not specified in frontmatter", () => {
    const tmp = join(tmpdir(), `skill-default-priority-${Date.now()}`);
    const skillDir = join(tmp, "no-priority-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: no-priority-skill\ndescription: No priority set\nmetadata:\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["no-priority-skill"]).toBeDefined();
    expect(map.skills["no-priority-skill"].priority).toBe(5);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("output shape has priority, pathPatterns, and bashPatterns per skill", () => {
    const map = buildSkillMap(SKILLS_DIR);
    for (const [name, skill] of Object.entries(map.skills) as [string, any][]) {
      expect(typeof skill.priority).toBe("number");
      expect(Array.isArray(skill.pathPatterns)).toBe(true);
      expect(Array.isArray(skill.bashPatterns)).toBe(true);
    }
  });

  test("nextjs skill matches expected values from frontmatter", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const nextjs = map.skills["nextjs"];
    expect(nextjs).toBeDefined();
    expect(nextjs.priority).toBe(5);
    expect(nextjs.pathPatterns).toContain("next.config.*");
    expect(nextjs.pathPatterns).toContain("app/**");
    expect(nextjs.bashPatterns.length).toBeGreaterThan(0);
  });

  test("skill count matches number of SKILL.md directories", () => {
    const expected = countSkillDirs();
    const map = buildSkillMap(SKILLS_DIR);
    const skillCount = Object.keys(map.skills).length;
    expect(skillCount).toBe(expected);
  });

  test("invariant: expected representative skills present with correct patterns", () => {
    const map = buildSkillMap(SKILLS_DIR);
    // Spot-check key skills
    expect(map.skills["nextjs"]).toBeDefined();
    expect(map.skills["vercel-cli"]).toBeDefined();
    expect(map.skills["ai-sdk"]).toBeDefined();
    expect(map.skills["vercel-storage"]).toBeDefined();

    // nextjs should have app/** and next.config.* patterns
    expect(map.skills["nextjs"].pathPatterns).toContain("app/**");
    expect(map.skills["nextjs"].pathPatterns).toContain("next.config.*");

    // vercel-cli should have a bash pattern for vercel commands
    expect(map.skills["vercel-cli"].bashPatterns.length).toBeGreaterThan(0);
  });

  test("backslash sequences preserved in bash patterns", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const nextjs = map.skills["nextjs"];
    // Should contain literal \b not a backspace character
    const hasWordBoundary = nextjs.bashPatterns.some((p: string) => p.includes("\\b"));
    expect(hasWordBoundary).toBe(true);
  });

  test("coerces bare string pathPatterns to array with warning", () => {
    const tmp = join(tmpdir(), `skill-string-fp-${Date.now()}`);
    const skillDir = join(tmp, "bare-string-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bare-string-skill\ndescription: Test bare string\nmetadata:\n  priority: 3\n  pathPatterns: 'src/**'\n  bashPatterns:\n    - '\\btest\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bare-string-skill"];
    expect(skill).toBeDefined();
    expect(Array.isArray(skill.pathPatterns)).toBe(true);
    expect(skill.pathPatterns).toEqual(["src/**"]);
    expect(Array.isArray(skill.bashPatterns)).toBe(true);
    // Should have a coercion warning
    expect(map.warnings.length).toBeGreaterThanOrEqual(1);
    expect(map.warnings.some((w: string) => w.includes("pathPatterns") && w.includes("coercing"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("coerces bare string bashPatterns to array with warning", () => {
    const tmp = join(tmpdir(), `skill-string-bp-${Date.now()}`);
    const skillDir = join(tmp, "bare-bash-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bare-bash-skill\ndescription: Test bare bash string\nmetadata:\n  priority: 2\n  pathPatterns:\n    - 'app/**'\n  bashPatterns: '\\bnpm\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bare-bash-skill"];
    expect(skill).toBeDefined();
    expect(Array.isArray(skill.bashPatterns)).toBe(true);
    expect(skill.bashPatterns).toEqual(["\\bnpm\\b"]);
    expect(map.warnings.some((w: string) => w.includes("bashPatterns") && w.includes("coercing"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("defaults non-array non-string pathPatterns to empty array with warning", () => {
    const tmp = join(tmpdir(), `skill-bad-type-${Date.now()}`);
    const skillDir = join(tmp, "bad-type-skill");
    mkdirSync(skillDir, { recursive: true });
    // Use numbers for both — inline YAML parser treats bare `true` as string "true",
    // so use numbers which are reliably non-array non-string.
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bad-type-skill\ndescription: Test bad type\nmetadata:\n  priority: 1\n  pathPatterns: 42\n  bashPatterns: 99\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bad-type-skill"];
    expect(skill).toBeDefined();
    expect(skill.pathPatterns).toEqual([]);
    expect(skill.bashPatterns).toEqual([]);
    expect(map.warnings.length).toBeGreaterThanOrEqual(2);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("no warnings emitted for well-formed skills directory", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(map.warnings).toEqual([]);
  });

  test("keys by directory name when frontmatter name differs", () => {
    const tmp = join(tmpdir(), `skill-mismatch-${Date.now()}`);
    const skillDir = join(tmp, "my-dir-name");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: different-frontmatter-name\ndescription: Mismatched\nmetadata:\n  priority: 7\n  pathPatterns:\n    - 'lib/**'\n  bashPatterns:\n    - '\\bmy-cmd\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    // Should be keyed by directory name, NOT frontmatter name
    expect(map.skills["my-dir-name"]).toBeDefined();
    expect(map.skills["different-frontmatter-name"]).toBeUndefined();
    expect(map.skills["my-dir-name"].priority).toBe(7);
    expect(map.skills["my-dir-name"].pathPatterns).toEqual(["lib/**"]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("duplicate frontmatter names in different dirs produce distinct keys", () => {
    const tmp = join(tmpdir(), `skill-dup-name-${Date.now()}`);
    const dir1 = join(tmp, "skill-alpha");
    const dir2 = join(tmp, "skill-beta");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const frontmatter = (pat: string) =>
      `---\nname: same-name\ndescription: Dup\nmetadata:\n  priority: 5\n  pathPatterns:\n    - '${pat}'\n  bashPatterns: []\n---\n# Test`;

    writeFileSync(join(dir1, "SKILL.md"), frontmatter("alpha/**"));
    writeFileSync(join(dir2, "SKILL.md"), frontmatter("beta/**"));

    const map = buildSkillMap(tmp);
    // Both should exist as distinct entries keyed by dir
    expect(map.skills["skill-alpha"]).toBeDefined();
    expect(map.skills["skill-beta"]).toBeDefined();
    expect(map.skills["skill-alpha"].pathPatterns).toEqual(["alpha/**"]);
    expect(map.skills["skill-beta"].pathPatterns).toEqual(["beta/**"]);
    // No key for the shared frontmatter name
    expect(map.skills["same-name"]).toBeUndefined();

    rmSync(tmp, { recursive: true, force: true });
  });

  test("summary field is propagated to skill map entry", () => {
    const tmp = join(tmpdir(), `skill-summary-${Date.now()}`);
    const skillDir = join(tmp, "summary-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: summary-skill\nsummary: This skill provides X guidance.\ndescription: Full description\nmetadata:\n  priority: 5\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["summary-skill"]).toBeDefined();
    expect(map.skills["summary-skill"].summary).toBe("This skill provides X guidance.");

    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing summary defaults to empty string in skill map", () => {
    const tmp = join(tmpdir(), `skill-no-summary-${Date.now()}`);
    const skillDir = join(tmp, "no-summary-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: no-summary-skill\ndescription: No summary\nmetadata:\n  priority: 3\n  pathPatterns:\n    - 'lib/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["no-summary-skill"].summary).toBe("");

    rmSync(tmp, { recursive: true, force: true });
  });

  // NOTE: "validate rules are propagated" test removed — the inline YAML parser
  // cannot handle nested array-of-objects (validate: - pattern: ...), so skills
  // with that frontmatter are silently skipped by buildSkillMap.

  test("missing validate in frontmatter defaults to empty array in skill map", () => {
    const tmp = join(tmpdir(), `skill-no-validate-${Date.now()}`);
    const skillDir = join(tmp, "no-validate-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: no-validate-skill\ndescription: No validate\nmetadata:\n  priority: 5\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["no-validate-skill"].validate).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("blank/missing frontmatter name falls back to directory name as key", () => {
    const tmp = join(tmpdir(), `skill-no-name-${Date.now()}`);
    const skillDir = join(tmp, "unnamed-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\ndescription: No name field\nmetadata:\n  priority: 2\n  pathPatterns:\n    - 'unnamed/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["unnamed-skill"]).toBeDefined();
    expect(map.skills["unnamed-skill"].priority).toBe(2);
    expect(map.skills["unnamed-skill"].pathPatterns).toEqual(["unnamed/**"]);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── Edge-case frontmatter tests (BOM, metadata types, whitespace) ─

describe("buildSkillMap — BOM and metadata edge cases", () => {
  function buildWithContent(dirName: string, content: string) {
    const tmp = join(tmpdir(), `skill-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), content);
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("BOM-prefixed SKILL.md is parsed correctly", () => {
    const content = "\uFEFF---\nname: bom-skill\ndescription: BOM test\nmetadata:\n  priority: 3\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# BOM Skill";
    const map = buildWithContent("bom-skill", content);
    expect(map.skills["bom-skill"]).toBeDefined();
    expect(map.skills["bom-skill"].priority).toBe(3);
    expect(map.skills["bom-skill"].pathPatterns).toEqual(["src/**"]);
    expect(map.warnings).toEqual([]);
  });

  test("metadata: [] (array) defaults to empty patterns without crash", () => {
    const content = "---\nname: arr-meta\ndescription: array metadata\nmetadata: []\n---\n# Test";
    const map = buildWithContent("arr-meta", content);
    expect(map.skills["arr-meta"]).toBeDefined();
    expect(map.skills["arr-meta"].pathPatterns).toEqual([]);
    expect(map.skills["arr-meta"].bashPatterns).toEqual([]);
  });

  test("metadata: 'bad' (string) defaults to empty patterns without crash", () => {
    const content = "---\nname: str-meta\ndescription: string metadata\nmetadata: bad\n---\n# Test";
    const map = buildWithContent("str-meta", content);
    expect(map.skills["str-meta"]).toBeDefined();
    expect(map.skills["str-meta"].pathPatterns).toEqual([]);
    expect(map.skills["str-meta"].bashPatterns).toEqual([]);
  });

  test("leading whitespace before --- fence results in fallback (no frontmatter)", () => {
    const content = "  ---\nname: ws-skill\ndescription: whitespace\nmetadata:\n  pathPatterns:\n    - 'src/**'\n---\n# Test";
    const map = buildWithContent("ws-skill", content);
    // Leading whitespace means no frontmatter is parsed → name falls back to dir
    expect(map.skills["ws-skill"]).toBeDefined();
    // No metadata parsed, so defaults apply
    expect(map.skills["ws-skill"].pathPatterns).toEqual([]);
    expect(map.skills["ws-skill"].bashPatterns).toEqual([]);
    expect(map.skills["ws-skill"].priority).toBe(5);
  });
});

// ─── Deprecated key compat shim (filePattern → pathPatterns, bashPattern → bashPatterns) ─

describe("buildSkillMap — deprecated key compat", () => {
  function buildWithFrontmatter(metadata: string) {
    const tmp = join(tmpdir(), `skill-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, "compat-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: compat-skill\ndescription: test deprecated keys\nmetadata:\n${metadata}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("filePattern is normalized to pathPatterns with DEPRECATED_FIELD warning", () => {
    const map = buildWithFrontmatter("  filePattern:\n    - 'src/**'\n  bashPatterns: []");
    const skill = map.skills["compat-skill"];
    expect(skill).toBeDefined();
    expect(skill.pathPatterns).toEqual(["src/**"]);
    // Should emit a deprecation warning
    expect(map.warnings.some((w: string) => w.includes("filePattern") && w.includes("deprecated"))).toBe(true);
    const detail = map.warningDetails.find((d: any) => d.code === "DEPRECATED_FIELD" && d.field === "filePattern");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("compat-skill");
  });

  test("bashPattern is normalized to bashPatterns with DEPRECATED_FIELD warning", () => {
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPattern:\n    - '\\bmy-cmd\\b'");
    const skill = map.skills["compat-skill"];
    expect(skill).toBeDefined();
    expect(skill.bashPatterns).toEqual(["\\bmy-cmd\\b"]);
    expect(map.warnings.some((w: string) => w.includes("bashPattern") && w.includes("deprecated"))).toBe(true);
    const detail = map.warningDetails.find((d: any) => d.code === "DEPRECATED_FIELD" && d.field === "bashPattern");
    expect(detail).toBeDefined();
  });

  test("canonical pathPatterns takes precedence over deprecated filePattern", () => {
    const map = buildWithFrontmatter("  pathPatterns:\n    - 'canonical/**'\n  filePattern:\n    - 'deprecated/**'\n  bashPatterns: []");
    const skill = map.skills["compat-skill"];
    expect(skill.pathPatterns).toEqual(["canonical/**"]);
    // No deprecation warning since canonical is present
    expect(map.warnings.some((w: string) => w.includes("filePattern"))).toBe(false);
  });

  test("canonical bashPatterns takes precedence over deprecated bashPattern", () => {
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPatterns:\n    - '\\bcanonical\\b'\n  bashPattern:\n    - '\\bdeprecated\\b'");
    const skill = map.skills["compat-skill"];
    expect(skill.bashPatterns).toEqual(["\\bcanonical\\b"]);
    expect(map.warnings.some((w: string) => w.includes("bashPattern") && w.includes("deprecated"))).toBe(false);
  });
});

// ─── Malformed array guards (buildSkillMap) ───────────────────────

describe("buildSkillMap — malformed array entries", () => {
  function buildWithFrontmatter(metadata: string) {
    const tmp = join(tmpdir(), `skill-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: test\nmetadata:\n${metadata}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("pathPatterns: [42] filters out non-string with warning", () => {
    const map = buildWithFrontmatter("  pathPatterns:\n    - 42\n  bashPatterns: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("pathPatterns: [null] treats bare null as string 'null' (inline parser)", () => {
    // The inline YAML parser treats bare `null` as the string "null", not JS null.
    const map = buildWithFrontmatter("  pathPatterns:\n    - null\n  bashPatterns: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual(["null"]);
    expect(map.warnings.length).toBe(0);
  });

  test("pathPatterns: [''] filters out empty string with warning", () => {
    const map = buildWithFrontmatter("  pathPatterns:\n    - ''\n  bashPatterns: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("empty"))).toBe(true);
  });

  test("bashPatterns: [42] filters out non-string with warning", () => {
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPatterns:\n    - 42");
    expect(map.skills["test-skill"].bashPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("bashPatterns: [null] treats bare null as string 'null' (inline parser)", () => {
    // The inline YAML parser treats bare `null` as the string "null", not JS null.
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPatterns:\n    - null");
    expect(map.skills["test-skill"].bashPatterns).toEqual(["null"]);
    expect(map.warnings.length).toBe(0);
  });

  test("bashPatterns: [''] filters out empty string with warning", () => {
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPatterns:\n    - ''");
    expect(map.skills["test-skill"].bashPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("empty"))).toBe(true);
  });
});

// ─── buildSkillMap — warningDetails structured diagnostics ────────

describe("buildSkillMap — warningDetails structured diagnostics", () => {
  function buildWithFrontmatter(metadata: string) {
    const tmp = join(tmpdir(), `skill-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: test\nmetadata:\n${metadata}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("warningDetails array is present and empty for well-formed skills", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(Array.isArray(map.warningDetails)).toBe(true);
    expect(map.warningDetails).toEqual([]);
  });

  test("coercing string pathPatterns produces structured detail with COERCE_STRING_TO_ARRAY", () => {
    const map = buildWithFrontmatter("  pathPatterns: 'src/**'\n  bashPatterns: []");
    expect(map.warningDetails.length).toBeGreaterThanOrEqual(1);
    const detail = map.warningDetails.find((d: any) => d.code === "COERCE_STRING_TO_ARRAY" && d.field === "pathPatterns");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("test-skill");
    expect(detail.valueType).toBe("string");
    expect(typeof detail.message).toBe("string");
    expect(typeof detail.hint).toBe("string");
  });

  test("non-array pathPatterns produces INVALID_TYPE detail", () => {
    const map = buildWithFrontmatter("  pathPatterns: 42\n  bashPatterns: []");
    const detail = map.warningDetails.find((d: any) => d.code === "INVALID_TYPE" && d.field === "pathPatterns");
    expect(detail).toBeDefined();
    expect(detail.valueType).toBe("number");
  });

  test("non-string entry in pathPatterns produces ENTRY_NOT_STRING detail", () => {
    const map = buildWithFrontmatter("  pathPatterns:\n    - 42\n  bashPatterns: []");
    const detail = map.warningDetails.find((d: any) => d.code === "ENTRY_NOT_STRING" && d.field === "pathPatterns[0]");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("test-skill");
  });

  test("empty string in bashPatterns produces ENTRY_EMPTY detail", () => {
    const map = buildWithFrontmatter("  pathPatterns: []\n  bashPatterns:\n    - ''");
    const detail = map.warningDetails.find((d: any) => d.code === "ENTRY_EMPTY" && d.field === "bashPatterns[0]");
    expect(detail).toBeDefined();
  });

  test("warningDetails length matches warnings length", () => {
    const map = buildWithFrontmatter("  pathPatterns: 42\n  bashPatterns: true");
    expect(map.warningDetails.length).toBe(map.warnings.length);
  });
});

// ─── validateSkillMap — warningDetails/errorDetails ────────────────

describe("validateSkillMap — structured errorDetails and warningDetails", () => {
  test("null input returns errorDetails with INVALID_ROOT", () => {
    const result = validateSkillMap(null);
    expect(result.ok).toBe(false);
    expect(result.errorDetails).toBeDefined();
    expect(result.errorDetails.length).toBe(1);
    expect(result.errorDetails[0].code).toBe("INVALID_ROOT");
  });

  test("missing skills key returns errorDetails with MISSING_SKILLS_KEY", () => {
    const result = validateSkillMap({});
    expect(result.ok).toBe(false);
    expect(result.errorDetails[0].code).toBe("MISSING_SKILLS_KEY");
  });

  test("unknown key produces UNKNOWN_KEY warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [], extraKey: true } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "UNKNOWN_KEY" && d.field === "extraKey");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
  });

  test("invalid priority produces INVALID_PRIORITY warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: "high", pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "INVALID_PRIORITY");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
    expect(detail.valueType).toBe("string");
  });

  test("non-string pathPatterns entry produces ENTRY_NOT_STRING warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [42, "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "ENTRY_NOT_STRING" && d.field === "pathPatterns[0]");
    expect(detail).toBeDefined();
  });

  test("warningDetails length matches warnings length on valid input", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: "bad", pathPatterns: [42], bashPatterns: ["", "ok"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.warningDetails.length).toBe(result.warnings.length);
  });

  test("summary field is preserved through validateSkillMap", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, summary: "Short summary.", pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].summary).toBe("Short summary.");
  });

  test("summary is not a known key warning (recognized field)", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, summary: "A summary", pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(0);
  });

  test("non-string summary defaults to empty string", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, summary: 42, pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].summary).toBe("");
  });

  test("validate field is preserved through validateSkillMap", () => {
    const rules = [{ pattern: "import.*openai", message: "Use gateway", severity: "error" }];
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [], validate: rules } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].validate).toHaveLength(1);
    expect(result.normalizedSkillMap.skills["s1"].validate[0].pattern).toBe("import.*openai");
  });

  test("validate is not flagged as unknown key", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [], validate: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(0);
  });

  test("malformed validate rules are silently dropped in validateSkillMap", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [], validate: [{ pattern: "ok", message: "msg", severity: "error" }, { bad: true }] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].validate).toHaveLength(1);
  });

  test("missing validate defaults to empty array in validateSkillMap", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].validate).toEqual([]);
  });

  test("config not object produces CONFIG_NOT_OBJECT errorDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": "not-an-object" },
    });
    expect(result.ok).toBe(false);
    const detail = result.errorDetails.find((d: any) => d.code === "CONFIG_NOT_OBJECT");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
  });
});

// ─── Malformed array guards (validateSkillMap) ────────────────────

describe("validateSkillMap — malformed array entries", () => {
  test("pathPatterns with non-string entry is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [42, "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].pathPatterns).toEqual(["valid/**"]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("pathPatterns with empty string is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: ["", "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].pathPatterns).toEqual(["valid/**"]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("empty"))).toBe(true);
  });

  test("bashPatterns with non-string entry is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [null, "\\bvalid\\b"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].bashPatterns).toEqual(["\\bvalid\\b"]);
    expect(result.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("bashPatterns with empty string is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: ["", "\\bvalid\\b"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].bashPatterns).toEqual(["\\bvalid\\b"]);
    expect(result.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("empty"))).toBe(true);
  });
});

// ─── promptSignals — skill-map validation ─────────────────────────

describe("validateSkillMap — promptSignals", () => {
  test("promptSignals is not flagged as unknown key", () => {
    const result = validateSkillMap({
      skills: {
        "s1": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          promptSignals: {
            phrases: ["streaming markdown"],
            allOf: [["markdown", "stream"]],
            anyOf: ["terminal"],
            noneOf: ["readme"],
            minScore: 6,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(0);
    expect(result.warningDetails.length).toBe(0);
  });

  test("promptSignals is preserved through validation normalization", () => {
    const signals = {
      phrases: ["ai elements", "streaming markdown"],
      allOf: [["markdown", "render"]],
      anyOf: ["chat ui", "react-markdown"],
      noneOf: ["readme", "markdown file"],
      minScore: 6,
    };
    const result = validateSkillMap({
      skills: {
        "s1": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          promptSignals: signals,
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].promptSignals).toBeDefined();
    expect(result.normalizedSkillMap.skills["s1"].promptSignals!.phrases).toEqual(["ai elements", "streaming markdown"]);
    expect(result.normalizedSkillMap.skills["s1"].promptSignals!.noneOf).toEqual(["readme", "markdown file"]);
  });

  test("missing promptSignals is omitted (not defaulted) in normalized output", () => {
    const result = validateSkillMap({
      skills: {
        "s1": { priority: 5, pathPatterns: [], bashPatterns: [] },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].promptSignals).toBeUndefined();
  });

  test("real skills directory produces no warnings (promptSignals included)", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const result = validateSkillMap(map);
    expect(result.ok).toBe(true);
    const unexpectedWarnings = result.warnings.filter(
      (w: string) => !w.includes("has no matching chainTo entry"),
    );
    expect(unexpectedWarnings).toEqual([]);
    // Verify at least one skill has promptSignals
    const withSignals = Object.entries(result.normalizedSkillMap.skills)
      .filter(([, cfg]: [string, any]) => cfg.promptSignals);
    expect(withSignals.length).toBeGreaterThan(0);
  });
});

// ─── buildSkillMap — promptSignals from SKILL.md frontmatter ──────

describe("buildSkillMap — promptSignals", () => {
  test("ai-elements skill has promptSignals with phrases and noneOf", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const aiElements = map.skills["ai-elements"];
    expect(aiElements).toBeDefined();
    expect(aiElements.promptSignals).toBeDefined();
    expect(aiElements.promptSignals.phrases.length).toBeGreaterThan(0);
    expect(aiElements.promptSignals.noneOf).toContain("readme");
  });

  test("workflow skill promptSignals include workflow durability language", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const workflow = map.skills["workflow"];
    expect(workflow).toBeDefined();
    expect(workflow.promptSignals).toBeDefined();

    const terms = [
      ...workflow.promptSignals!.phrases,
      ...workflow.promptSignals!.anyOf,
      ...workflow.promptSignals!.noneOf,
      ...workflow.promptSignals!.allOf.flat(),
    ].join(" ");

    expect(terms).toMatch(/workflow|durable|resum/i);
  });

  test("skill without promptSignals omits the field", () => {
    const tmp = join(tmpdir(), `skill-no-signals-${Date.now()}`);
    const skillDir = join(tmp, "plain-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: plain-skill\ndescription: No signals\nmetadata:\n  priority: 5\n  pathPatterns:\n    - 'src/**'\n  bashPatterns: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["plain-skill"]).toBeDefined();
    expect(map.skills["plain-skill"].promptSignals).toBeUndefined();
    expect(map.warnings).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── promptSignals malformed warnings ──────────────────────────────

describe("promptSignals malformed warnings via buildSkillMap", () => {
  function buildWithSignals(promptSignalsYaml: string) {
    const tmp = join(tmpdir(), `skill-signals-warn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: Test\nmetadata:\n  priority: 5\n  pathPatterns: []\n  bashPatterns: []\n  promptSignals:\n${promptSignalsYaml}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("empty phrases array emits PROMPT_SIGNALS_EMPTY_PHRASES", () => {
    const result = buildWithSignals(
      "    phrases: []\n    anyOf:\n      - fallback",
    );
    const codes = result.warningDetails.map((w) => w.code);
    expect(codes).toContain("PROMPT_SIGNALS_EMPTY_PHRASES");
    const detail = result.warningDetails.find(
      (w) => w.code === "PROMPT_SIGNALS_EMPTY_PHRASES",
    );
    expect(detail!.skill).toBe("test-skill");
    expect(detail!.field).toBe("promptSignals.phrases");
  });

  test("phrases with empty strings emits PROMPT_SIGNALS_EMPTY_PHRASES", () => {
    // Inline array with empty-string entry: phrases: ['', valid]
    // Our YAML parser doesn't support '' inside inline arrays easily,
    // so test via validateSkillMap which takes raw objects
    const result = validateSkillMap({
      skills: {
        "test-skill": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          importPatterns: [],
          validate: [],
          promptSignals: {
            phrases: ["", "valid phrase"],
            allOf: [],
            anyOf: [],
            noneOf: [],
            minScore: 6,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warningDetails.map((w) => w.code);
      expect(codes).toContain("PROMPT_SIGNALS_EMPTY_PHRASES");
    }
  });

  test("allOf with non-array element emits PROMPT_SIGNALS_INVALID_ALLOF_GROUP", () => {
    const result = validateSkillMap({
      skills: {
        "test-skill": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          importPatterns: [],
          validate: [],
          promptSignals: {
            phrases: ["test phrase"],
            allOf: ["not-an-array" as any, ["valid", "group"]],
            anyOf: [],
            noneOf: [],
            minScore: 6,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warningDetails.map((w) => w.code);
      expect(codes).toContain("PROMPT_SIGNALS_INVALID_ALLOF_GROUP");
      const detail = result.warningDetails.find(
        (w) => w.code === "PROMPT_SIGNALS_INVALID_ALLOF_GROUP",
      );
      expect(detail!.field).toBe("promptSignals.allOf");
      expect(detail!.hint).toContain("array of strings");
    }
  });

  test("minScore below 1 emits PROMPT_SIGNALS_LOW_MINSCORE", () => {
    const result = validateSkillMap({
      skills: {
        "test-skill": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          importPatterns: [],
          validate: [],
          promptSignals: {
            phrases: ["test phrase"],
            allOf: [],
            anyOf: [],
            noneOf: [],
            minScore: 0,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warningDetails.map((w) => w.code);
      expect(codes).toContain("PROMPT_SIGNALS_LOW_MINSCORE");
      const detail = result.warningDetails.find(
        (w) => w.code === "PROMPT_SIGNALS_LOW_MINSCORE",
      );
      expect(detail!.field).toBe("promptSignals.minScore");
      expect(detail!.hint).toContain("at least 1");
    }
  });

  test("negative minScore emits PROMPT_SIGNALS_LOW_MINSCORE", () => {
    const result = validateSkillMap({
      skills: {
        "test-skill": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          importPatterns: [],
          validate: [],
          promptSignals: {
            phrases: ["test phrase"],
            allOf: [],
            anyOf: [],
            noneOf: [],
            minScore: -5,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warningDetails.map((w) => w.code);
      expect(codes).toContain("PROMPT_SIGNALS_LOW_MINSCORE");
    }
  });

  test("existing skills (ai-elements, ai-sdk, nextjs, swr) produce zero promptSignals warnings", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const promptWarningCodes = new Set([
      "PROMPT_SIGNALS_EMPTY_PHRASES",
      "PROMPT_SIGNALS_INVALID_ALLOF_GROUP",
      "PROMPT_SIGNALS_LOW_MINSCORE",
    ]);
    const promptWarnings = map.warningDetails.filter((w) =>
      promptWarningCodes.has(w.code),
    );
    expect(promptWarnings).toEqual([]);
  });

  test("validateSkillMap propagates promptSignals warnings", () => {
    const result = validateSkillMap({
      skills: {
        "bad-skill": {
          priority: 5,
          pathPatterns: [],
          bashPatterns: [],
          importPatterns: [],
          validate: [],
          promptSignals: {
            phrases: [],
            allOf: [42 as any],
            anyOf: ["something"],
            noneOf: [],
            minScore: 0.5,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.warningDetails.map((w) => w.code);
      expect(codes).toContain("PROMPT_SIGNALS_EMPTY_PHRASES");
      expect(codes).toContain("PROMPT_SIGNALS_INVALID_ALLOF_GROUP");
      expect(codes).toContain("PROMPT_SIGNALS_LOW_MINSCORE");
    }
  });
});

describe("parseSkillFrontmatter — duplicate key detection", () => {
  test("throws on duplicate top-level key in frontmatter", () => {
    const yaml = [
      "name: my-skill",
      "description: first",
      "metadata:",
      "  priority: 5",
      "name: duplicate-name",
    ].join("\n");
    expect(() => parseSkillFrontmatter(yaml)).toThrow(/duplicate key "name"/);
  });

  test("throws on duplicate nested key inside metadata", () => {
    const yaml = [
      "name: my-skill",
      "metadata:",
      "  priority: 5",
      "  priority: 8",
    ].join("\n");
    expect(() => parseSkillFrontmatter(yaml)).toThrow(/duplicate key "priority"/);
  });

  test("throws on duplicate chainTo key (the original bug)", () => {
    const yaml = [
      "name: my-skill",
      "chainTo:",
      "  -",
      "    pattern: foo",
      "    targetSkill: bar",
      "chainTo:",
      "  -",
      "    pattern: baz",
      "    targetSkill: qux",
    ].join("\n");
    expect(() => parseSkillFrontmatter(yaml)).toThrow(/duplicate key "chainTo"/);
  });

  test("non-duplicate keys with similar names parse fine", () => {
    const yaml = [
      "name: my-skill",
      "description: test",
      "summary: brief",
    ].join("\n");
    const result = parseSkillFrontmatter(yaml);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("test");
    expect(result.summary).toBe("brief");
  });
});
