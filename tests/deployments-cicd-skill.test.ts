import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills, matchSkills } from "../hooks/pretooluse-skill-inject.mjs";
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

describe("deployments-cicd generic CI path matching", () => {
  const ciFile = "name: CI\non: [pull_request]\njobs: {test: {runs-on: ubuntu-latest}}\n";
  const vercelCiFile = "name: Deploy\non: [push]\njobs: {deploy: {steps: [{run: vercel deploy --prod}]}}\n";

  function matched(toolName: string, toolInput: Record<string, unknown>): string[] {
    const { compiledSkills } = loadSkills(ROOT)!;
    return [...matchSkills(toolName, toolInput, compiledSkills)!.matched];
  }

  test("ignores CI files that never mention Vercel", () => {
    expect(matched("Write", { file_path: ".github/workflows/ci.yml", content: ciFile })).not.toContain("deployments-cicd");
    expect(matched("Write", { file_path: ".gitlab-ci.yml", content: ciFile })).not.toContain("deployments-cicd");
    expect(matched("Write", { file_path: "bitbucket-pipelines.yml", content: ciFile })).not.toContain("deployments-cicd");
  });

  test("gates Windows-style CI paths the same way", () => {
    expect(matched("Write", { file_path: "C:\\repo\\.github\\workflows\\ci.yml", content: ciFile }))
      .not.toContain("deployments-cicd");
    expect(matched("Write", { file_path: "C:\\repo\\.gitlab-ci.yml", content: ciFile })).not.toContain("deployments-cicd");
    expect(matched("Write", { file_path: "C:\\repo\\.github\\workflows\\ci.yml", content: vercelCiFile }))
      .toContain("deployments-cicd");
  });

  test("only gates deployments-cicd, not vercel-agent's deploy/preview patterns", () => {
    const skills = matched("Write", { file_path: ".github/workflows/deploy.yml", content: ciFile });
    expect(skills).not.toContain("deployments-cicd");
    expect(skills).toContain("vercel-agent");
  });

  test("ignores 'vercel' in parent folders of the CI file", () => {
    const filePath = join(tmpdir(), "vercel-x", ".github/workflows/ci.yml");
    expect(matched("Write", { file_path: filePath, content: ciFile })).not.toContain("deployments-cicd");
    expect(matched("Edit", { file_path: filePath, old_string: "pull_request", new_string: "push" }))
      .not.toContain("deployments-cicd");
  });

  test("still matches CI files that use Vercel", () => {
    expect(matched("Write", { file_path: ".github/workflows/deploy.yml", content: vercelCiFile }))
      .toContain("deployments-cicd");
    expect(matched("Write", { file_path: ".github/workflows/vercel-preview.yml", content: ciFile }))
      .toContain("deployments-cicd");
    expect(matched("Read", { file_path: "vercel.json" })).toContain("deployments-cicd");
  });

  test("reads the file on disk for Read and Edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "vercel-plugin-ci-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      const plain = join(dir, ".github/workflows/ci.yml");
      const vercel = join(dir, ".github/workflows/release.yml");
      writeFileSync(plain, ciFile);
      writeFileSync(vercel, vercelCiFile);
      expect(matched("Read", { file_path: plain })).toEqual([]);
      expect(matched("Read", { file_path: vercel })).toContain("deployments-cicd");
      expect(matched("Edit", { file_path: vercel, old_string: "push", new_string: "release" }))
        .toContain("deployments-cicd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deployments-cicd root directory guidance", () => {
  test("places Root Directory in Project Settings, not vercel.json", () => {
    const template = readFileSync(resolve(ROOT, "agents/deployment-expert.md.tmpl"), "utf8");
    for (const text of [skill, template]) {
      expect(text).not.toMatch(/`vercel\.json` for `rootDirectory`|`rootDirectory` in vercel\.json/);
      expect(text).toContain("`vercel.json` has no `rootDirectory` key");
    }
  });
});
