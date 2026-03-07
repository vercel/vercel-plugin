import { describe, test, expect } from "bun:test";
import {
  extractFrontmatter,
  parseSkillFrontmatter,
} from "../hooks/skill-map-frontmatter.mjs";

/**
 * Property / fuzz tests for the inline YAML parser (parseSimpleYaml via
 * parseSkillFrontmatter) and frontmatter extraction.
 * Goal: no crashes or unhandled exceptions from any input.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter string; returns result or Error. */
function safeParse(yaml: string): ReturnType<typeof parseSkillFrontmatter> | Error {
  try {
    return parseSkillFrontmatter(yaml);
  } catch (err) {
    return err as Error;
  }
}

/** Must either return a valid result or throw with a message. */
function expectNoUnhandled(yaml: string) {
  const result = safeParse(yaml);
  if (result instanceof Error) {
    expect(result.message).toBeTruthy();
    return;
  }
  expect(result).toHaveProperty("name");
  expect(result).toHaveProperty("description");
  expect(result).toHaveProperty("metadata");
}

// ---------------------------------------------------------------------------
// extractFrontmatter edge cases
// ---------------------------------------------------------------------------

describe("fuzz: extractFrontmatter", () => {
  test("empty string returns empty yaml and body", () => {
    const { yaml, body } = extractFrontmatter("");
    expect(yaml).toBe("");
    expect(body).toBe("");
  });

  test("no frontmatter delimiters returns everything as body", () => {
    const input = "Just some markdown\nwith no frontmatter";
    const { yaml, body } = extractFrontmatter(input);
    expect(yaml).toBe("");
    expect(body).toBe(input);
  });

  test("BOM is stripped", () => {
    const input = "\uFEFF---\nname: test\n---\nbody";
    const { yaml, body } = extractFrontmatter(input);
    expect(yaml).toBe("name: test");
    expect(body).toBe("body");
  });

  test("Windows line endings (CRLF)", () => {
    const input = "---\r\nname: test\r\n---\r\nbody";
    const { yaml, body } = extractFrontmatter(input);
    expect(yaml).toBe("name: test");
    expect(body).toBe("body");
  });

  test("frontmatter with only dashes (empty YAML)", () => {
    const input = "---\n\n---\nbody";
    const { yaml, body } = extractFrontmatter(input);
    expect(yaml).toBe("");
    expect(body).toBe("body");
  });

  test("multiple --- blocks returns first match", () => {
    const input = "---\nfirst: 1\n---\nmiddle\n---\nsecond: 2\n---\nend";
    const { yaml } = extractFrontmatter(input);
    expect(yaml).toBe("first: 1");
  });

  test("--- not at start is not frontmatter", () => {
    const input = "some text\n---\nname: test\n---\nbody";
    const { yaml, body } = extractFrontmatter(input);
    expect(yaml).toBe("");
    expect(body).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// parseSkillFrontmatter: empty / missing input
// ---------------------------------------------------------------------------

describe("fuzz: parseSkillFrontmatter empty inputs", () => {
  test("empty string", () => {
    const result = parseSkillFrontmatter("");
    expect(result).toEqual({ name: "", description: "", summary: "", metadata: {} });
  });

  test("whitespace only", () => {
    const result = parseSkillFrontmatter("   \n  \n  ");
    expect(result).toEqual({ name: "", description: "", summary: "", metadata: {} });
  });

  test("null/undefined don't crash", () => {
    expect(parseSkillFrontmatter(null as any)).toEqual({ name: "", description: "", summary: "", metadata: {} });
    expect(parseSkillFrontmatter(undefined as any)).toEqual({ name: "", description: "", summary: "", metadata: {} });
  });
});

// ---------------------------------------------------------------------------
// Bare values (per CLAUDE.md: bare null/true/false are strings, not JS types)
// ---------------------------------------------------------------------------

describe("fuzz: bare value handling", () => {
  test("bare null is string 'null'", () => {
    const result = safeParse("name: null");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("null");
    }
  });

  test("bare true is string 'true'", () => {
    const result = safeParse("name: true");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("true");
    }
  });

  test("bare false is string 'false'", () => {
    const result = safeParse("name: false");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("false");
    }
  });

  test("numeric values coerced to empty string for name field", () => {
    // parseSkillFrontmatter coerces non-string values to "" for name
    const result = safeParse("name: 42");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Tab indentation
// ---------------------------------------------------------------------------

describe("fuzz: tab indentation", () => {
  test("tab at start of line throws", () => {
    const yaml = "name: test\n\tdescription: bad";
    const result = safeParse(yaml);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("tab");
  });

  test("tab in value is fine (not indentation)", () => {
    const result = safeParse("name: hello\tworld");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("hello\tworld");
    }
  });
});

// ---------------------------------------------------------------------------
// Unclosed brackets (per CLAUDE.md: treated as scalar strings)
// ---------------------------------------------------------------------------

describe("fuzz: unclosed brackets", () => {
  test("unclosed [ in value is scalar string", () => {
    const result = safeParse("name: [unclosed");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("[unclosed");
    }
  });

  test("unclosed [ with content", () => {
    const result = safeParse("name: [a, b, c");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("[a, b, c");
    }
  });
});

// ---------------------------------------------------------------------------
// Quoted strings
// ---------------------------------------------------------------------------

describe("fuzz: quoted strings", () => {
  test("single-quoted string", () => {
    const result = safeParse("name: 'hello world'");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("hello world");
    }
  });

  test("double-quoted string", () => {
    const result = safeParse('name: "hello world"');
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("hello world");
    }
  });

  test("unterminated single quote throws", () => {
    const result = safeParse("name: 'hello");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("unterminated");
  });

  test("unterminated double quote throws", () => {
    const result = safeParse('name: "hello');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("unterminated");
  });

  test("empty quoted strings", () => {
    const r1 = safeParse("name: ''");
    expect(r1).not.toBeInstanceOf(Error);
    if (!(r1 instanceof Error)) expect(r1.name).toBe("");

    const r2 = safeParse('name: ""');
    expect(r2).not.toBeInstanceOf(Error);
    if (!(r2 instanceof Error)) expect(r2.name).toBe("");
  });

  test("quotes inside different quote type", () => {
    const result = safeParse(`name: "it's a test"`);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("it's a test");
    }
  });
});

// ---------------------------------------------------------------------------
// Inline arrays
// ---------------------------------------------------------------------------

describe("fuzz: inline arrays", () => {
  test("empty array", () => {
    const result = safeParse("metadata:\n  pathPatterns: []");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ pathPatterns: [] });
    }
  });

  test("array with trailing comma throws (empty entry)", () => {
    const result = safeParse("metadata:\n  pathPatterns: [a, b, ]");
    expect(result).toBeInstanceOf(Error);
  });

  test("array with leading comma throws (empty entry)", () => {
    const result = safeParse("metadata:\n  pathPatterns: [, a, b]");
    expect(result).toBeInstanceOf(Error);
  });

  test("nested inline arrays are split by top-level commas", () => {
    // The inline parser doesn't recursively parse nested brackets within
    // the top-level array — brackets inside items are treated as scalars
    const result = safeParse("metadata:\n  data: [[1, 2], [3, 4]]");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ data: ["[1", "2]", "[3", "4]"] });
    }
  });

  test("array with quoted commas", () => {
    const result = safeParse(`metadata:\n  pathPatterns: ["a,b", "c,d"]`);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ pathPatterns: ["a,b", "c,d"] });
    }
  });
});

// ---------------------------------------------------------------------------
// Block arrays (YAML list syntax)
// ---------------------------------------------------------------------------

describe("fuzz: block arrays", () => {
  test("standard block array", () => {
    const yaml = "metadata:\n  pathPatterns:\n    - '*.ts'\n    - '*.tsx'";
    const result = safeParse(yaml);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ pathPatterns: ["*.ts", "*.tsx"] });
    }
  });

  test("block array with empty dash items", () => {
    const yaml = "metadata:\n  pathPatterns:\n    -\n    -";
    const result = safeParse(yaml);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ pathPatterns: ["", ""] });
    }
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe("fuzz: comments", () => {
  test("comment-only document is empty", () => {
    const result = safeParse("# just a comment\n# another one");
    expect(result).toEqual({ name: "", description: "", summary: "", metadata: {} });
  });

  test("inline comments are NOT stripped (becomes part of value)", () => {
    // The inline YAML parser doesn't strip inline comments
    const result = safeParse("name: hello # world");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("hello # world");
    }
  });
});

// ---------------------------------------------------------------------------
// Indentation edge cases
// ---------------------------------------------------------------------------

describe("fuzz: indentation", () => {
  test("inconsistent indentation throws", () => {
    const yaml = "metadata:\n  priority: 5\n   pathPatterns: []";
    const result = safeParse(yaml);
    expect(result).toBeInstanceOf(Error);
  });

  test("deeply nested structure", () => {
    const yaml = [
      "metadata:",
      "  pathPatterns:",
      "    - '*.ts'",
      "  priority: 10",
    ].join("\n");
    const result = safeParse(yaml);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({ pathPatterns: ["*.ts"], priority: 10 });
    }
  });

  test("leading spaces on top-level key throws", () => {
    const result = safeParse("  name: test");
    expect(result).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Empty document / whitespace variations
// ---------------------------------------------------------------------------

describe("fuzz: empty and whitespace documents", () => {
  test("newline only", () => {
    expectNoUnhandled("\n");
  });

  test("multiple newlines", () => {
    expectNoUnhandled("\n\n\n\n");
  });

  test("spaces only", () => {
    expectNoUnhandled("     ");
  });

  test("mixed whitespace no content", () => {
    expectNoUnhandled("  \n  \n  ");
  });
});

// ---------------------------------------------------------------------------
// Colons in values
// ---------------------------------------------------------------------------

describe("fuzz: colons in values", () => {
  test("colon in value (URL)", () => {
    const result = safeParse("name: https://example.com");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("https://example.com");
    }
  });

  test("colon at end of key with empty value", () => {
    const result = safeParse("name:");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Unicode in YAML
// ---------------------------------------------------------------------------

describe("fuzz: unicode in YAML", () => {
  test("unicode key name", () => {
    expectNoUnhandled("名前: テスト");
  });

  test("emoji in values", () => {
    expectNoUnhandled("name: 🚀 rocket");
  });

  test("RTL characters", () => {
    expectNoUnhandled("name: مرحبا");
  });
});

// ---------------------------------------------------------------------------
// Stress: random YAML-like strings
// ---------------------------------------------------------------------------

describe("fuzz: random YAML-like strings", () => {
  const chars = "abcABC012: \n-[]'\"#,\t{}|>!&*?@`%";

  function randomYaml(len: number, seed: number): string {
    let result = "";
    let s = seed;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      result += chars[s % chars.length];
    }
    return result;
  }

  test("200 random YAML strings don't cause unhandled exceptions", () => {
    for (let i = 0; i < 200; i++) {
      const len = (i % 80) + 1;
      const yaml = randomYaml(len, i * 31337);
      try {
        parseSkillFrontmatter(yaml);
      } catch (err) {
        // Must be a descriptive error, not a raw crash
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBeTruthy();
      }
    }
  });

  test("random strings through extractFrontmatter + parse pipeline", () => {
    for (let i = 0; i < 100; i++) {
      const len = (i % 120) + 10;
      const raw = `---\n${randomYaml(len, i * 7919)}\n---\nbody`;
      try {
        const { yaml } = extractFrontmatter(raw);
        if (yaml) parseSkillFrontmatter(yaml);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Realistic full frontmatter round-trips
// ---------------------------------------------------------------------------

describe("fuzz: realistic frontmatter round-trips", () => {
  test("full skill frontmatter parses correctly", () => {
    const yaml = [
      "name: Next.js",
      "description: Framework for React",
      "metadata:",
      "  priority: 10",
      "  pathPatterns:",
      "    - 'next.config.*'",
      "    - 'app/**/*.tsx'",
      "    - 'pages/**/*.tsx'",
      "  bashPatterns:",
      "    - 'npx next'",
      "    - 'next dev'",
    ].join("\n");

    const result = safeParse(yaml);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("Next.js");
      expect(result.description).toBe("Framework for React");
      expect(result.metadata).toEqual({
        priority: 10,
        pathPatterns: ["next.config.*", "app/**/*.tsx", "pages/**/*.tsx"],
        bashPatterns: ["npx next", "next dev"],
      });
    }
  });

  test("frontmatter with only name", () => {
    const result = safeParse("name: minimal");
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.name).toBe("minimal");
      expect(result.metadata).toEqual({});
    }
  });

  test("metadata is not object (array) falls back to empty", () => {
    const yaml = "name: test\nmetadata:\n  - item1\n  - item2";
    const result = safeParse(yaml);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.metadata).toEqual({});
    }
  });
});
