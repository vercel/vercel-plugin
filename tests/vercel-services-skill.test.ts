import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  matchPathWithReason,
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
const SKILL_PATH = resolve(ROOT, "skills/vercel-services/SKILL.md");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const services = skills["vercel-services"];

  expect(services).toBeDefined();
  expect(services.priority).toBe(7);
  expect(services.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(services.promptSignals!);
  compiledSkill = compileSkillPatterns({
    "vercel-services": services,
  })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("Vercel Services prompt activation", () => {
  test.each([
    "Set up Vercel Services for a Next.js frontend and FastAPI backend.",
    "Configure a Vercel service binding from orders to inventory.",
    "Deploy multiple services on Vercel in one project.",
    "Configure services in vercel.json for this polyglot app.",
  ])("matches Services intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Create a systemd service for this daemon.",
    "Deploy these microservices to Kubernetes.",
    "Add an API Route Handler to my existing Next.js app.",
    "Split these frontends into independently deployed microfrontends.",
    "Configure an AWS ECS service.",
    "Create a Cloud Foundry service binding.",
  ])("does not match unrelated service intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("Vercel Services artifact activation", () => {
  test("matches vercel.json paths", () => {
    expect(
      matchPathWithReason("vercel.json", compiledSkill.compiledPaths),
    ).not.toBeNull();
    expect(
      matchPathWithReason(
        "apps/dashboard/vercel.json",
        compiledSkill.compiledPaths,
      ),
    ).not.toBeNull();
  });

  test.each(["vercel dev -L", "vc dev --local"])(
    "matches local Services development: %s",
    (command) => {
      expect(
        matchBashWithReason(command, compiledSkill.compiledBash),
      ).not.toBeNull();
    },
  );

  test.each(["vercel dev", "npm run dev", "docker compose up"])(
    "does not match generic development commands: %s",
    (command) => {
      expect(
        matchBashWithReason(command, compiledSkill.compiledBash),
      ).toBeNull();
    },
  );
});

describe("Vercel Services guidance", () => {
  test("teaches the current configuration and routing model", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain('"services"');
    expect(skill).toContain('"bindings"');
    expect(skill).toContain('"destination": { "service": "backend" }');
    expect(skill).toContain("The service receives the original request path");
    expect(skill).toContain("Declare a binding on the caller service");
    expect(skill).toContain(
      "runtime, not during builds or in Routing Middleware",
    );
    expect(skill).toContain(
      "Native Go and Rust runtime services cannot currently consume bindings",
    );
  });
});
