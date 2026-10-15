import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Deterministic content-contract guards for selected Marketplace workflows.
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
  test("description limits provisioning to a selected platform and requested integration", () => {
    expect(description).toContain("has selected vercel");
    expect(description).toContain("do not require marketplace provisioning");
    expect(description).not.toContain("building any app");
  });

  test("commerce vs payments is decided by the product-catalog test, not a provider", () => {
    // The distinction lives in the category→use-case map: catalog → commerce, no catalog → payments.
    expect(body.toLowerCase()).toContain("catalog");
    expect(body).toContain("`commerce`");
    expect(body).toContain("`payments`");
    // steered as CATEGORY slugs, never a named provider default
    expect(body).not.toMatch(/default to (shopify|stripe)/i);
  });

  test("research does not provision and a mock cannot satisfy a real integration", () => {
    expect(body).toMatch(/discover and compare without installing/i);
    expect(body).toMatch(/never\s+report a mock or placeholder as a provisioned, working integration/i);
    expect(body).toMatch(/does not satisfy a requested real integration/i);
    expect(body).toContain("vercel integration add");
  });

  test("no provider is hardcoded as a forced default anywhere in the skill", () => {
    // Provider names may appear as examples/anti-patterns, but never as "default to <provider>".
    expect(body).not.toMatch(/default(s)? to (shopify|stripe|neon|upstash)\b/i);
  });
});
