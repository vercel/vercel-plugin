import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSkillPatterns,
  matchBashWithReason,
  matchImportWithReason,
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
const SKILL_PATH = resolve(ROOT, "skills/vercel-schedules/SKILL.md");

let compiledPromptSignals: CompiledPromptSignals;
let compiledSkill: CompiledSkillEntry;

beforeAll(() => {
  const { skills } = loadValidatedSkillMap(resolve(ROOT, "skills"));
  const schedules = skills["vercel-schedules"];

  expect(schedules).toBeDefined();
  expect(schedules.priority).toBe(6);
  expect(schedules.promptSignals).toBeDefined();

  compiledPromptSignals = compilePromptSignals(schedules.promptSignals!);
  compiledSkill = compileSkillPatterns({ "vercel-schedules": schedules })[0];
});

function matchesPrompt(prompt: string): boolean {
  return matchPromptWithReason(
    normalizePromptText(prompt),
    compiledPromptSignals,
  ).matched;
}

describe("Vercel Schedules prompt activation", () => {
  test.each([
    "Set up Vercel Schedules to clean up expired sessions.",
    "Add a scheduled job that runs every hour on Vercel.",
    "Run this function every night at 2am on Vercel.",
    "Create a schedule for each user so they get a daily digest in their timezone.",
    "Send a reminder later with a one-time schedule.",
    "Migrate cron jobs in vercel.json to the new schedules config.",
    "How do I use handleSchedule from @vercel/schedules?",
  ])("matches Schedules intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(true);
  });

  test.each([
    "Schedule a meeting with the design team next week.",
    "What is the release schedule for Next.js 17?",
    "Fix the timezone formatting in this date picker.",
    "Add a calendar event when a user books a demo.",
  ])("does not match unrelated scheduling intent: %s", (prompt) => {
    expect(matchesPrompt(prompt)).toBe(false);
  });
});

describe("Vercel Schedules artifact activation", () => {
  test.each([
    "vercel.json",
    "app/api/schedules/cleanup/route.ts",
    "api/schedules/report.ts",
    "src/lib/schedules.ts",
  ])("matches schedule paths: %s", (path) => {
    expect(matchPathWithReason(path, compiledSkill.compiledPaths)).not.toBeNull();
  });

  test.each([
    "npm install @vercel/schedules@alpha",
    "pnpm add @vercel/schedules",
    "vercel schedules list",
    "vc schedules invoke cleanup --local",
  ])("matches SDK installs and CLI usage: %s", (command) => {
    expect(matchBashWithReason(command, compiledSkill.compiledBash)).not.toBeNull();
  });

  test("matches @vercel/schedules imports", () => {
    expect(
      matchImportWithReason(
        "import { handleSchedule } from '@vercel/schedules';",
        compiledSkill.compiledImports,
      ),
    ).not.toBeNull();
  });

  test.each(["npm install node-cron", "vercel deploy"])(
    "does not match unrelated commands: %s",
    (command) => {
      expect(matchBashWithReason(command, compiledSkill.compiledBash)).toBeNull();
    },
  );
});

describe("Vercel Schedules guidance", () => {
  test("teaches the documented config, SDK surface, and migration path", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain("npm i @vercel/schedules@alpha");
    expect(skill).toContain("import { handleSchedule } from '@vercel/schedules';");
    expect(skill).toContain('"experimentalTriggers": [{ "type": "schedule/v1beta" }]');
    expect(skill).toContain("expression: { type: 'single', at: '2026-11-01T09:00' }");
    expect(skill).toContain('"requestMethod": "GET"');
    expect(skill).toContain("executionId");
    expect(skill).toContain("CRON_SECRET");
    expect(skill).toContain("⤳ skill: queues");
  });
});
