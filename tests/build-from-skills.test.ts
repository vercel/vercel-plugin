import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSkillSection,
  resolveIncludes,
  loadSkillContent,
  clearSkillCache,
  compileTemplate,
  DiagnosticCode,
} from "../scripts/build-from-skills.ts";
import type { CompileResult, CompileDiagnostic, ResolvedInclude } from "../scripts/build-from-skills.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

// ---------------------------------------------------------------------------
// Fixture: temporary skill directory for isolated tests
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `build-from-skills-test-${Date.now()}`);
const TMP_SKILLS = join(TMP_ROOT, "skills");

function writeFixtureSkill(name: string, content: string): void {
  const dir = join(TMP_SKILLS, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

beforeEach(() => {
  clearSkillCache();
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// Set up fixtures once
mkdirSync(TMP_SKILLS, { recursive: true });

writeFixtureSkill(
  "test-skill",
  `---
name: test-skill
description: A test skill for unit tests
summary: Test skill summary
metadata:
  priority: 7
---

# Test Skill

Introduction paragraph.

## Installation

\`\`\`bash
npm install test-skill
\`\`\`

## Configuration

Set up your config file:

\`\`\`json
{ "key": "value" }
\`\`\`

### Advanced Configuration

For advanced users, configure these options:

- Option A
- Option B

## Usage

Use the skill like this.
`,
);

writeFixtureSkill(
  "nested-skill",
  `---
name: nested-skill
description: Skill with nested headings
summary: Nested summary
metadata:
  priority: 5
---

# Nested Skill

## Core Functions

Overview of core functions.

### Text Generation

Generate text with this API.

\`\`\`ts
const text = await generate("hello");
\`\`\`

### Image Generation

Generate images with this API.

## Other Section

Other content here.
`,
);

// ---------------------------------------------------------------------------
// extractSkillSection
// ---------------------------------------------------------------------------

describe("extractSkillSection", () => {
  test("extracts a top-level section by heading text", () => {
    const result = extractSkillSection("test-skill", "Installation", TMP_SKILLS);
    expect(result).toContain("npm install test-skill");
    expect(result).not.toContain("## Configuration");
  });

  test("extracts section with explicit ## prefix", () => {
    const result = extractSkillSection("test-skill", "## Installation", TMP_SKILLS);
    expect(result).toContain("npm install test-skill");
  });

  test("extracts section including nested headings", () => {
    const result = extractSkillSection("test-skill", "Configuration", TMP_SKILLS);
    expect(result).toContain("Set up your config file");
    expect(result).toContain("### Advanced Configuration");
    expect(result).toContain("Option A");
    // Should stop before next ## heading
    expect(result).not.toContain("## Usage");
  });

  test("extracts a sub-section directly", () => {
    const result = extractSkillSection("test-skill", "Advanced Configuration", TMP_SKILLS);
    expect(result).toContain("Option A");
    expect(result).not.toContain("Set up your config file");
  });

  test("extracts nested section via > path", () => {
    const result = extractSkillSection(
      "nested-skill",
      "Core Functions > Text Generation",
      TMP_SKILLS,
    );
    expect(result).toContain("Generate text with this API");
    expect(result).not.toContain("Image Generation");
  });

  test("heading matching is case-insensitive", () => {
    const result = extractSkillSection("test-skill", "installation", TMP_SKILLS);
    expect(result).toContain("npm install test-skill");
  });

  test("returns empty string for non-existent heading", () => {
    const result = extractSkillSection("test-skill", "Nonexistent Heading", TMP_SKILLS);
    expect(result).toBe("");
  });

  test("throws for non-existent skill", () => {
    expect(() =>
      extractSkillSection("no-such-skill", "Installation", TMP_SKILLS),
    ).toThrow(/not found/);
  });

  test("works with real skills directory", () => {
    // ai-sdk has an "Installation" section
    const result = extractSkillSection("ai-sdk", "Installation", SKILLS_DIR);
    expect(result).toContain("npm install");
  });
});

// ---------------------------------------------------------------------------
// resolveIncludes — section includes
// ---------------------------------------------------------------------------

describe("resolveIncludes", () => {
  test("resolves a section include marker", () => {
    const template = `# My Agent\n\n{{include:skill:test-skill:Installation}}\n\nDone.`;
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toContain("npm install test-skill");
    expect(result).toContain("# My Agent");
    expect(result).toContain("Done.");
    expect(result).not.toContain("{{include:");
  });

  test("resolves multiple include markers", () => {
    const template = [
      "{{include:skill:test-skill:Installation}}",
      "---",
      "{{include:skill:test-skill:Usage}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toContain("npm install test-skill");
    expect(result).toContain("Use the skill like this");
  });

  test("resolves nested heading path", () => {
    const template = "{{include:skill:nested-skill:Core Functions > Text Generation}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toContain("Generate text with this API");
    expect(result).not.toContain("Image Generation");
  });

  test("throws on unresolved section include in strict mode", () => {
    const template = "{{include:skill:test-skill:Nonexistent}}";
    expect(() =>
      resolveIncludes(template, { skillsDir: TMP_SKILLS, strict: true }),
    ).toThrow(/Unresolved include/);
  });

  test("throws on missing skill in strict mode", () => {
    const template = "{{include:skill:no-such-skill:Installation}}";
    expect(() =>
      resolveIncludes(template, { skillsDir: TMP_SKILLS, strict: true }),
    ).toThrow(/Unresolved include/);
  });

  test("inserts HTML comment for unresolved includes in non-strict mode", () => {
    const template = "Before {{include:skill:test-skill:Nonexistent}} After";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, strict: false });
    expect(result).toContain("<!-- Unresolved include");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });
});

// ---------------------------------------------------------------------------
// resolveIncludes — frontmatter includes
// ---------------------------------------------------------------------------

describe("resolveIncludes — frontmatter", () => {
  test("resolves a frontmatter string field", () => {
    const template = "Skill: {{include:skill:test-skill:frontmatter:description}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toBe("Skill: A test skill for unit tests");
  });

  test("resolves a frontmatter nested field (metadata.priority)", () => {
    const template = "Priority: {{include:skill:test-skill:frontmatter:metadata.priority}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toBe("Priority: 7");
  });

  test("resolves frontmatter name field", () => {
    const template = "{{include:skill:test-skill:frontmatter:name}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toBe("test-skill");
  });

  test("resolves frontmatter summary field", () => {
    const template = "{{include:skill:test-skill:frontmatter:summary}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS });
    expect(result).toBe("Test skill summary");
  });

  test("throws on missing frontmatter field in strict mode", () => {
    const template = "{{include:skill:test-skill:frontmatter:nonexistent}}";
    expect(() =>
      resolveIncludes(template, { skillsDir: TMP_SKILLS, strict: true }),
    ).toThrow(/Unresolved include/);
  });
});

// ---------------------------------------------------------------------------
// loadSkillContent
// ---------------------------------------------------------------------------

describe("loadSkillContent", () => {
  test("loads and caches skill content", () => {
    const first = loadSkillContent("test-skill", TMP_SKILLS);
    const second = loadSkillContent("test-skill", TMP_SKILLS);
    expect(first).toBe(second); // Same reference (cached)
    expect(first.body).toContain("# Test Skill");
  });

  test("throws for missing skill", () => {
    expect(() => loadSkillContent("nonexistent", TMP_SKILLS)).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Error message quality
// ---------------------------------------------------------------------------

describe("error messages", () => {
  test("unresolved include error includes the full marker", () => {
    const template = "{{include:skill:test-skill:Missing Section}}";
    try {
      resolveIncludes(template, { skillsDir: TMP_SKILLS });
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("include:skill:test-skill:Missing Section");
      expect(msg).toContain("Heading");
    }
  });

  test("missing skill error includes file path", () => {
    try {
      extractSkillSection("no-such-skill", "foo", TMP_SKILLS);
      expect(true).toBe(false);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("no-such-skill");
      expect(msg).toContain("does not exist");
    }
  });
});

// ---------------------------------------------------------------------------
// DiagnosticCode enum stability
// ---------------------------------------------------------------------------

describe("DiagnosticCode", () => {
  test("has exactly four stable string codes", () => {
    expect(DiagnosticCode.SKILL_NOT_FOUND).toBe("SKILL_NOT_FOUND");
    expect(DiagnosticCode.HEADING_NOT_FOUND).toBe("HEADING_NOT_FOUND");
    expect(DiagnosticCode.FRONTMATTER_NOT_FOUND).toBe("FRONTMATTER_NOT_FOUND");
    expect(DiagnosticCode.STALE_OUTPUT).toBe("STALE_OUTPUT");
    expect(Object.keys(DiagnosticCode)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// resolveIncludes — structured mode (CompileResult)
// ---------------------------------------------------------------------------

describe("resolveIncludes — structured mode", () => {
  test("returns CompileResult when structured: true", () => {
    const template = "# Agent\n\n{{include:skill:test-skill:Installation}}\n\nDone.";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    // Must be a CompileResult object, not a string
    expect(typeof result).toBe("object");
    expect(typeof result.output).toBe("string");
    expect(Array.isArray(result.resolved)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(Array.isArray(result.dependencies)).toBe(true);
  });

  test("resolved includes track provenance", () => {
    const template = "{{include:skill:test-skill:Installation}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.resolved).toHaveLength(1);
    const inc = result.resolved[0];
    expect(inc.marker).toBe("{{include:skill:test-skill:Installation}}");
    expect(inc.skillName).toBe("test-skill");
    expect(inc.target).toBe("Installation");
    expect(inc.type).toBe("section");
    expect(inc.contentLength).toBeGreaterThan(0);
  });

  test("frontmatter includes track provenance with type frontmatter", () => {
    const template = "{{include:skill:test-skill:frontmatter:description}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].type).toBe("frontmatter");
    expect(result.resolved[0].target).toBe("frontmatter:description");
  });

  test("dependencies list all referenced skills", () => {
    const template = [
      "{{include:skill:test-skill:Installation}}",
      "{{include:skill:nested-skill:Core Functions > Text Generation}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.dependencies).toContain("test-skill");
    expect(result.dependencies).toContain("nested-skill");
    expect(result.dependencies).toHaveLength(2);
  });

  test("deduplicates dependencies", () => {
    const template = [
      "{{include:skill:test-skill:Installation}}",
      "{{include:skill:test-skill:Usage}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.dependencies).toEqual(["test-skill"]);
  });

  test("unresolved includes produce diagnostics with HEADING_NOT_FOUND code", () => {
    const template = "{{include:skill:test-skill:Nonexistent}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.HEADING_NOT_FOUND);
    expect(result.diagnostics[0].marker).toBe("{{include:skill:test-skill:Nonexistent}}");
    expect(result.diagnostics[0].suggestion).toBeTruthy();
  });

  test("missing skill produces SKILL_NOT_FOUND diagnostic", () => {
    const template = "{{include:skill:no-such-skill:Installation}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.SKILL_NOT_FOUND);
    expect(result.diagnostics[0].suggestion).toContain("skills/no-such-skill/SKILL.md");
  });

  test("missing frontmatter field produces FRONTMATTER_NOT_FOUND diagnostic", () => {
    const template = "{{include:skill:test-skill:frontmatter:nonexistent}}";
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.FRONTMATTER_NOT_FOUND);
  });

  test("structured mode does NOT throw on errors (collects diagnostics)", () => {
    const template = "Before {{include:skill:no-such-skill:foo}} After";
    // Should not throw even with strict not set (structured always collects)
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.output).toContain("Before");
    expect(result.output).toContain("After");
  });

  test("mixed resolved and unresolved includes", () => {
    const template = [
      "{{include:skill:test-skill:Installation}}",
      "{{include:skill:test-skill:Nonexistent}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    expect(result.resolved).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.dependencies).toEqual(["test-skill"]);
  });
});

// ---------------------------------------------------------------------------
// CompileResult shape contract (snapshot)
// ---------------------------------------------------------------------------

describe("CompileResult shape contract", () => {
  test("successful resolution shape snapshot", () => {
    const template = [
      "# Agent",
      "",
      "{{include:skill:test-skill:Installation}}",
      "",
      "Summary: {{include:skill:test-skill:frontmatter:description}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    // Snapshot the shape with stable fields only (strip variable content lengths)
    const shape = {
      hasOutput: typeof result.output === "string" && result.output.length > 0,
      resolvedCount: result.resolved.length,
      resolved: result.resolved.map((r) => ({
        marker: r.marker,
        skillName: r.skillName,
        target: r.target,
        type: r.type,
        hasContentLength: r.contentLength > 0,
        hasLineNumber: typeof r.lineNumber === "number" && r.lineNumber > 0,
      })),
      diagnosticCount: result.diagnostics.length,
      dependencies: result.dependencies,
    };

    expect(shape).toMatchSnapshot();
  });

  test("error diagnostic shape snapshot", () => {
    const template = [
      "{{include:skill:no-such-skill:Installation}}",
      "{{include:skill:test-skill:Nonexistent}}",
      "{{include:skill:test-skill:frontmatter:nonexistent}}",
    ].join("\n");
    const result = resolveIncludes(template, { skillsDir: TMP_SKILLS, structured: true });

    const shape = {
      resolvedCount: result.resolved.length,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        marker: d.marker,
        hasSuggestion: typeof d.suggestion === "string" && d.suggestion.length > 0,
      })),
      dependencies: result.dependencies.sort(),
    };

    expect(shape).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// compileTemplate
// ---------------------------------------------------------------------------

describe("compileTemplate", () => {
  const TMP_TEMPLATES = join(TMP_ROOT, "templates");

  function writeFixtureTemplate(name: string, content: string): string {
    mkdirSync(TMP_TEMPLATES, { recursive: true });
    const p = join(TMP_TEMPLATES, name);
    writeFileSync(p, content);
    return p;
  }

  test("returns a CompileResult for a valid template", () => {
    const tmpl = writeFixtureTemplate(
      "valid.md.tmpl",
      "# Agent\n\n{{include:skill:test-skill:Installation}}\n",
    );
    const result = compileTemplate(tmpl, { skillsDir: TMP_SKILLS });

    expect(result.output).toContain("npm install test-skill");
    expect(result.resolved).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.dependencies).toEqual(["test-skill"]);
  });

  test("collects diagnostics for unresolved includes without throwing", () => {
    const tmpl = writeFixtureTemplate(
      "broken.md.tmpl",
      "{{include:skill:no-such-skill:foo}}\n",
    );
    const result = compileTemplate(tmpl, { skillsDir: TMP_SKILLS });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(DiagnosticCode.SKILL_NOT_FOUND);
    expect(result.dependencies).toEqual(["no-such-skill"]);
  });

  test("handles template with no includes", () => {
    const tmpl = writeFixtureTemplate("plain.md.tmpl", "# Just text\n\nNo includes here.\n");
    const result = compileTemplate(tmpl, { skillsDir: TMP_SKILLS });

    expect(result.output).toBe("# Just text\n\nNo includes here.\n");
    expect(result.resolved).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.dependencies).toHaveLength(0);
  });
});
