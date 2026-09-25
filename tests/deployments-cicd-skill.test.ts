import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the deployments-cicd skill. SKILL.md keeps the
// common release flow and routes CLI pipeline examples and OIDC details to
// references/, which must exist. CI examples authenticate through the
// VERCEL_TOKEN environment variable, never a --token argument.

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIR = resolve(ROOT, "skills/deployments-cicd");

let skill: string;
let allContent: string;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  expect(skills["deployments-cicd"]).toBeDefined();
  skill = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
  const references = readdirSync(resolve(SKILL_DIR, "references")).map((file) =>
    readFileSync(resolve(SKILL_DIR, "references", file), "utf8"),
  );
  allContent = [skill, ...references].join("\n");
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

describe("deployments-cicd CI guidance", () => {
  test("CI examples authenticate with VERCEL_TOKEN instead of --token", () => {
    expect(allContent).not.toMatch(/--token[= ]\$/);
    expect(skill).toContain("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
  });

  test("notes what a prebuilt build lacks", () => {
    expect(skill).toContain("System Environment Variables are missing at build time");
  });
});
