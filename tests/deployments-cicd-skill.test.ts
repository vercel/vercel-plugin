import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the deployments-cicd skill. SKILL.md keeps the
// common release flow and routes CLI pipeline examples and OIDC details to
// references/, which must exist.

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIR = resolve(ROOT, "skills/deployments-cicd");

let skill: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["deployments-cicd"]).toBeDefined();
  skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
});

describe("deployments-cicd references", () => {
  test("every linked reference exists", () => {
    const links = [...skill.matchAll(/\]\((references\/[^)#]+)/g)].map((m) => m[1]);
    expect(links).toContain("references/cli-pipelines.md");
    expect(links).toContain("references/oidc-federation.md");
    for (const link of links) {
      expect(existsSync(resolve(SKILL_DIR, link))).toBe(true);
    }
  });
});
