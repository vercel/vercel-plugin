import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vercel's `.md` docs copies can trail the rendered pages under the same date.

const ROOT = resolve(import.meta.dirname, "..");
const skill = readFileSync(resolve(ROOT, "skills/ai-gateway/SKILL.md"), "utf8");

describe("ai-gateway current sources", () => {
  test("prefers the rendered docs page over its .md copy", () => {
    expect(skill).toMatch(/trust the rendered page/);
  });
});
