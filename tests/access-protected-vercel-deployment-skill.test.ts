import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  type CompiledSkillEntry,
} from "../hooks/src/patterns.mts";
import {
  compilePromptSignals,
  matchPromptWithReason,
  normalizePromptText,
  type CompiledPromptSignals,
} from "../hooks/src/prompt-patterns.mts";
import { loadValidatedSkillMap } from "../src/shared/skill-map-loader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_PATH = resolve(
  ROOT,
  "skills/access-protected-vercel-deployment/SKILL.md",
);

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const protectedDeployment = skills["access-protected-vercel-deployment"];

  expect(protectedDeployment).toBeDefined();
  expect(protectedDeployment.priority).toBe(8);
  expect(protectedDeployment.promptSignals).toBeDefined();
  expect(protectedDeployment.promptSignals!.allOf).toContainEqual([
    "vercel",
    "403",
  ]);

  compiledPromptSignals = compilePromptSignals(
    protectedDeployment.promptSignals!,
  );
  compiledSkill = compileSkillPatterns({
    "access-protected-vercel-deployment": protectedDeployment,
  })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("protected deployment prompt activation", () => {
  test.each([
    "Access this protected Vercel deployment.",
    "Preview is behind Vercel SSO deployment protection.",
    "The Vercel authentication page appears instead of the app.",
    "curl gets a 403 from this Vercel deployment.",
    "Open the protected production deployment in the browser.",
    "My protected Vercel deployment uses a custom domain.",
    "Fix TRUSTED_SOURCES_ENVIRONMENT_MISMATCH.",
    "Use x-vercel-trusted-oidc-idp-token for this request.",
  ])("matches protected Vercel access intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Add authentication to my application.",
    "Protect this Next.js route with Clerk.",
    "Explain AWS deployment protection.",
    "Run curl against localhost.",
    "My Kubernetes deployment is protected by a pod disruption budget.",
  ])("does not match unrelated protection or authentication intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("protected deployment command activation", () => {
  test.each([
    "vc curl https://my-app.vercel.app/api/health",
    "vc curl https://app.example.com/api/health",
    "vercel curl /api/health",
    "vercel curl https://preview.example.com/api/health",
    "curl -I https://my-app-git-main.vercel.app",
    "agent-browser open https://my-app.vercel.app",
    "curl -H 'x-vercel-trusted-oidc-idp-token: token' https://app.example.com",
    "curl -H 'x-vercel-protection-bypass: token' https://app.example.com",
  ])("matches protected deployment access commands: %s", (command) => {
    expect(
      matchBashWithReason(command, compiledSkill.compiledBash),
    ).not.toBeNull();
  });

  test.each([
    "curl http://localhost:3000",
    "curl https://api.example.com",
    "agent-browser open https://example.com",
    "vercel logs",
    "kubectl get deployments",
  ])("does not match unrelated commands: %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).toBeNull();
  });
});

describe("protected deployment guidance", () => {
  test("documents both CLI and browser authentication paths", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain("vc curl");
    expect(skill).toContain("VERCEL_OIDC_TOKEN");
    expect(skill).toContain("x-vercel-trusted-oidc-idp-token");
    expect(skill).toContain("agent-browser");
    expect(skill).toContain(
      "Browser automation: attach the development OIDC token as a header",
    );
    expect(skill).toContain(
      "short-lived local token as a request header",
    );
    expect(skill).toContain("same project's Preview deployments by default");
    expect(skill).toContain(
      "does not automatically access protected Production deployments",
    );
    expect(skill).not.toContain("same project's deployments by default");
    expect(skill).toContain("development` → `production");
    expect(skill).toContain("Do not disable Deployment Protection");
  });
});
