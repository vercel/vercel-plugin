import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Deterministic content-contract guards for the marketplace catch-all skill.
// These don't test model behavior (that's the agent-eval layer) — they lock in
// the *routing surface* and anti-mock/anti-hardcode contract so a future edit
// can't silently regress the discover-first design.

const ROOT = resolve(import.meta.dirname, "..");
const SKILL = readFileSync(join(ROOT, "skills", "marketplace", "SKILL.md"), "utf8");

const fmMatch = SKILL.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const frontmatter = fmMatch ? fmMatch[1] : "";
const body = fmMatch ? fmMatch[2] : SKILL;
const description = (frontmatter.match(/description:\s*(.*)/)?.[1] ?? "").toLowerCase();

/** Slice a markdown section from `### heading` up to the next `## ` heading. */
function section(heading: string): string {
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start);
  const end = rest.indexOf("\n## ");
  return end >= 0 ? rest.slice(0, end) : rest;
}

describe("marketplace skill content contract", () => {
  test("description routes the full catch-all capability set", () => {
    for (const kw of ["commerce", "payments", "search", "cms"]) {
      expect(description).toContain(kw);
    }
    expect(/monitoring|observability/.test(description)).toBe(true);
    expect(/email|messaging/.test(description)).toBe(true);
  });

  test("commerce vs payments is decided by the product-catalog test, not a provider", () => {
    // The distinction lives in the category→use-case map: catalog → commerce, no catalog → payments.
    expect(body.toLowerCase()).toContain("catalog");
    expect(body).toContain("`commerce`");
    expect(body).toContain("`payments`");
    // steered as CATEGORY slugs, never a named provider default
    expect(body).not.toMatch(/default to (shopify|stripe)/i);
  });

  test("install is mandatory and mocking is explicitly forbidden", () => {
    expect(body).toMatch(/required, not optional/i);
    expect(body).toMatch(/substitute a mock/i);
    expect(body).toContain("vercel integration add");
  });

  test("no provider is hardcoded as a forced default anywhere in the skill", () => {
    // Provider names may appear as examples/anti-patterns, but never as "default to <provider>".
    expect(body).not.toMatch(/default(s)? to (shopify|stripe|neon|upstash)\b/i);
  });
});
