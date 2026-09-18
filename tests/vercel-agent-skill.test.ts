import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the vercel-agent skill: pricing and surface area
// track vercel.com/docs/agent and /docs/agent/pricing.

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(ROOT, "skills/vercel-agent/SKILL.md");

let skill: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["vercel-agent"]).toBeDefined();
  skill = readFileSync(SKILL_PATH, "utf8");
});

describe("vercel-agent guidance", () => {
  test("states the documented token-rate pricing, not retired flat fees", () => {
    expect(skill).toContain("$0.25 per million");
    expect(skill).toContain("10 investigations per billing cycle");
    expect(skill).not.toMatch(/\$0\.30 per Code Review/);
    expect(skill).not.toMatch(/\$100 promotional credit/);
  });

  test("covers chat and approved actions alongside review and investigation", () => {
    expect(skill).toContain("### Chat");
    expect(skill).toMatch(/Slack/);
    expect(skill).toContain("read-only by default");
    expect(skill).toContain("https://vercel.com/docs/agent/pricing");
  });
});
