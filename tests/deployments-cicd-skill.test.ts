import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

// Content-contract guards for the deployments-cicd skill. SKILL.md keeps the
// common release flow and routes CLI pipeline examples and OIDC details to
// references/, which must exist. CI examples authenticate through the
// VERCEL_TOKEN environment variable, never a --token argument. Promoting a
// preview deployment creates a new production build, so releases go through
// Deployment Checks or a staged production deployment.

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
    expect(links).toContain("references/deployment-checks.md");
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

describe("deployments-cicd release guidance", () => {
  test("releases tested builds through Deployment Checks or a staged production deployment", () => {
    expect(skill).toContain("### Release Only Tested Builds");
    expect(skill).toContain("vercel deploy --prebuilt --prod --skip-domain");
    expect(skill).toContain("Promoting a preview rebuilds it with production environment variables");
    expect(skill).not.toContain("re-points the production alias without rebuilding");
  });

  test("warns that rollback turns off auto-assignment", () => {
    expect(skill).toContain("**Rollback turns off auto-assignment.**");
  });

  test("passes the Playwright base URL through the environment", () => {
    expect(allContent).not.toContain("--base-url");
    expect(allContent).toContain("baseURL: process.env.BASE_URL");
  });

  test("reports repository_dispatch test results on the deployed commit", () => {
    expect(allContent).toContain("types: [vercel.deployment.ready]");
    expect(allContent).toContain("uses: vercel/repository-dispatch/actions/status@v1");
    expect(allContent).toContain("ref: ${{ github.event.client_payload.git.sha }}");
  });
});
